import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_OBSIDIAN_PROJECTOR_VERSION,
  WorkflowStoreError,
  type ObsidianOutboxEvent,
  type ObsidianRegistryEntry,
  type UpsertRegistryInput,
} from "@private-fund/workflow-store";

import {
  inspectManagedMarkdown,
  renderManagedMarkdown,
  type InspectedManagedMarkdown,
  type RenderedManagedMarkdown,
} from "./markdown.js";
import {
  ObsidianProjectionError,
  ProjectionCrashSimulationError,
  type ObsidianProjectionDelivery,
  type ObsidianProjectionDrainResult,
  type ObsidianProjectionNote,
  type ObsidianProjectorOptions,
  type ObsidianProjectorPort,
  type ProjectionLifecycleContext,
  type ProjectionNoteIdentity,
} from "./types.js";

const DEFAULT_MANAGED_ROOT = "obsidian/managed";
const DEFAULT_MAX_NOTE_BYTES = 8 * 1024 * 1024;
const MAX_NOTES_PER_EVENT = 1_000;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

interface ProjectPaths {
  readonly realProjectRoot: string;
  readonly managedRootRelative: string;
}

interface ExistingFile {
  readonly content: string;
  readonly hash: string;
  readonly inspected: InspectedManagedMarkdown;
}

interface PreparedNote {
  readonly note: ObsidianProjectionNote;
  readonly identity: ProjectionNoteIdentity;
  readonly relativePath: string;
  readonly registryPath: string;
  readonly targetPath: string;
  readonly archiveRegistryPath?: string;
  readonly archiveTargetPath?: string;
}

interface MaterializedNote {
  readonly registryEntry: UpsertRegistryInput;
  readonly path: string;
  readonly written: boolean;
  readonly archived: boolean;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requireSingleLine(
  value: string,
  field: string,
  maxLength = 240,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new ObsidianProjectionError(
      `${field} must be non-empty single-line text`,
      "invalid_projection",
      false,
    );
  }
  return value;
}

function normalizeSafeRelative(
  value: string,
  field: string,
  options: { readonly markdown?: boolean; readonly allowInternal?: boolean } = {},
): string {
  requireSingleLine(value, field, 1_000);
  if (
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value !== path.posix.normalize(value)
  ) {
    throw new ObsidianProjectionError(
      `${field} must be a normalized relative POSIX path`,
      "path_violation",
      false,
    );
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.length > 255 ||
        /[\u0000-\u001f<>:"|?*]/u.test(part),
    ) ||
    (!options.allowInternal && parts[0] === "_archive")
  ) {
    throw new ObsidianProjectionError(
      `${field} contains an unsafe path segment`,
      "path_violation",
      false,
    );
  }
  if (options.markdown === true && !value.endsWith(".md")) {
    throw new ObsidianProjectionError(
      `${field} must end in .md`,
      "path_violation",
      false,
    );
  }
  return value;
}

function joinRegistryPath(root: string, relative: string): string {
  return path.posix.join(root, relative);
}

function archiveRelativePath(
  relativePath: string,
  eventId: string,
): string {
  if (!SAFE_EVENT_ID.test(eventId)) {
    throw new ObsidianProjectionError(
      "Outbox event ID cannot be used for an archive name",
      "invalid_projection",
      false,
    );
  }
  const withoutExtension = relativePath.slice(0, -3);
  return `_archive/${withoutExtension}/${eventId}.md`;
}

function absoluteFromRegistryPath(
  realProjectRoot: string,
  registryPath: string,
): string {
  const target = path.resolve(
    realProjectRoot,
    ...registryPath.split("/"),
  );
  if (!pathIsWithin(target, realProjectRoot)) {
    throw new ObsidianProjectionError(
      "Managed note path escapes the tenant project root",
      "path_violation",
      false,
    );
  }
  return target;
}

async function ensureProjectPaths(
  projectRoot: string,
  managedRootRelative: string,
): Promise<ProjectPaths> {
  if (!path.isAbsolute(projectRoot)) {
    throw new ObsidianProjectionError(
      "projectRoot must be absolute",
      "path_violation",
      false,
    );
  }
  const rootStat = await lstat(projectRoot).catch((error: unknown) => {
    throw new ObsidianProjectionError(
      `Tenant project root is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "path_violation",
      false,
      { cause: error },
    );
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ObsidianProjectionError(
      "projectRoot must be a non-symbolic-link directory",
      "path_violation",
      false,
    );
  }
  const realProjectRoot = await realpath(projectRoot);
  await ensureSecureDirectory(realProjectRoot, managedRootRelative);
  return { realProjectRoot, managedRootRelative };
}

async function ensureSecureDirectory(
  realProjectRoot: string,
  relativeDirectory: string,
): Promise<string> {
  const normalized =
    relativeDirectory.length === 0
      ? ""
      : normalizeSafeRelative(relativeDirectory, "managed directory", {
          allowInternal: true,
        });
  let current = realProjectRoot;
  for (const segment of normalized.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ObsidianProjectionError(
          "Managed path traverses a symlink or non-directory",
          "path_violation",
          false,
        );
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") {
          throw mkdirError;
        }
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new ObsidianProjectionError(
          "Managed directory could not be created safely",
          "path_violation",
          false,
        );
      }
    }
  }
  const resolved = await realpath(current);
  if (!pathIsWithin(resolved, realProjectRoot)) {
    throw new ObsidianProjectionError(
      "Managed directory resolves outside the tenant project root",
      "path_violation",
      false,
    );
  }
  return current;
}

async function readTextNoFollow(
  target: string,
  maxBytes: number,
): Promise<{ readonly content: string; readonly hash: string } | null> {
  let handle;
  try {
    handle = await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    if (errorCode(error) === "ELOOP") {
      throw new ObsidianProjectionError(
        "Managed note target may not be a symbolic link",
        "path_violation",
        false,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ObsidianProjectionError(
        "Managed note target must be a regular non-symbolic-link file",
        "path_violation",
        false,
      );
    }
    if (stat.size > maxBytes) {
      throw new ObsidianProjectionError(
        "Managed note target exceeds the configured byte limit",
        "managed_content_conflict",
        false,
      );
    }
    const content = await handle.readFile({ encoding: "utf8" });
    return { content, hash: sha256(content) };
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    // Some filesystems do not support directory fsync. The file itself has
    // already been fsynced; only explicitly unsupported cases are tolerated.
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(errorCode(error) ?? "")) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function projectionConflict(message: string): ObsidianProjectionError {
  return new ObsidianProjectionError(
    message,
    "managed_content_conflict",
    false,
  );
}

function normalizeFailure(error: unknown): ObsidianProjectionError {
  if (error instanceof ObsidianProjectionError) {
    return error;
  }
  if (error instanceof WorkflowStoreError) {
    return new ObsidianProjectionError(
      error.message,
      error.code === "conflict"
        ? "managed_content_conflict"
        : "invalid_projection",
      false,
      { cause: error },
    );
  }
  return new ObsidianProjectionError(
    error instanceof Error ? error.message : String(error),
    "io_failure",
    true,
    { cause: error },
  );
}

export class ObsidianProjector implements ObsidianProjectorPort {
  readonly #options: ObsidianProjectorOptions;
  readonly #managedRootRelative: string;
  readonly #projectorVersion: string;
  readonly #maxNoteBytes: number;

  public constructor(options: ObsidianProjectorOptions) {
    this.#options = options;
    requireSingleLine(options.binding.tenantId, "tenantId");
    requireSingleLine(options.binding.projectId, "projectId");
    requireSingleLine(options.binding.datasetId, "datasetId");
    this.#managedRootRelative = normalizeSafeRelative(
      options.managedRootRelative ?? DEFAULT_MANAGED_ROOT,
      "managedRootRelative",
      { allowInternal: true },
    );
    this.#projectorVersion = requireSingleLine(
      options.projectorVersion ?? DEFAULT_OBSIDIAN_PROJECTOR_VERSION,
      "projectorVersion",
    );
    this.#maxNoteBytes = options.maxNoteBytes ?? DEFAULT_MAX_NOTE_BYTES;
    if (
      !Number.isSafeInteger(this.#maxNoteBytes) ||
      this.#maxNoteBytes < 1_024 ||
      this.#maxNoteBytes > 256 * 1024 * 1024
    ) {
      throw new ObsidianProjectionError(
        "maxNoteBytes must be an integer between 1 KiB and 256 MiB",
        "invalid_projection",
        false,
      );
    }
  }

  public recoverStale(staleBefore: string, availableAt?: string): number {
    return this.#options.repository.recoverStaleEvents({
      datasetId: this.#options.binding.datasetId,
      staleBefore,
      ...(availableAt === undefined ? {} : { availableAt }),
    });
  }

  public async processNext(): Promise<ObsidianProjectionDelivery | null> {
    const event = this.#options.repository.claimNext({
      datasetId: this.#options.binding.datasetId,
      projectorVersion: this.#projectorVersion,
    });
    if (event === null) {
      return null;
    }
    const leaseToken = event.leaseToken;
    if (leaseToken === null) {
      throw new ObsidianProjectionError(
        "Claimed outbox event has no lease token",
        "invalid_projection",
        false,
      );
    }
    try {
      if (event.datasetId !== this.#options.binding.datasetId) {
        throw new ObsidianProjectionError(
          "Outbox event does not belong to the bound project dataset",
          "invalid_projection",
          false,
        );
      }
      const paths = await ensureProjectPaths(
        this.#options.binding.projectRoot,
        this.#managedRootRelative,
      );
      let plan;
      try {
        plan = await this.#options.renderer({
          binding: this.#options.binding,
          event,
        });
      } catch (error) {
        if (
          error instanceof ProjectionCrashSimulationError ||
          error instanceof ObsidianProjectionError
        ) {
          throw error;
        }
        throw new ObsidianProjectionError(
          `Projection renderer failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "io_failure",
          true,
          { cause: error },
        );
      }
      if (
        typeof plan !== "object" ||
        plan === null ||
        !Array.isArray(plan.notes) ||
        plan.notes.length === 0 ||
        plan.notes.length > MAX_NOTES_PER_EVENT
      ) {
        throw new ObsidianProjectionError(
          `Projection plan must contain 1-${String(MAX_NOTES_PER_EVENT)} notes`,
          "invalid_projection",
          false,
        );
      }
      const prepared = plan.notes.map((note) =>
        this.#prepareNote(paths, event, note),
      );
      this.#assertUniquePlan(prepared);
      const materialized: MaterializedNote[] = [];
      for (const note of prepared) {
        materialized.push(
          await this.#materializeNote(paths, event, leaseToken, note),
        );
      }
      const registryPaths = materialized.map((item) => item.path);
      await this.#options.lifecycle?.beforeDatabaseCommit?.({
        event,
        leaseToken,
        registryPaths,
      });
      this.#assertLease(event.eventId, leaseToken);
      const result = {
        archived: materialized.filter((item) => item.archived).length,
        paths: registryPaths,
        unchanged: materialized.filter((item) => !item.written).length,
        written: materialized.filter((item) => item.written).length,
      };
      this.#options.repository.completeProjection(event.eventId, leaseToken, {
        registryEntries: materialized.map((item) => item.registryEntry),
        result,
      });
      return {
        eventId: event.eventId,
        status: "completed",
        ...result,
      };
    } catch (error) {
      if (error instanceof ProjectionCrashSimulationError) {
        throw error;
      }
      if (this.#leaseWasLost(event.eventId, leaseToken)) {
        return {
          eventId: event.eventId,
          status: "stale",
          written: 0,
          unchanged: 0,
          archived: 0,
          paths: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const failure = normalizeFailure(error);
      try {
        const failed = this.#options.repository.failEvent(
          event.eventId,
          leaseToken,
          failure.message,
          { terminal: !failure.retryable },
        );
        return {
          eventId: event.eventId,
          status: failed.status === "failed" ? "failed" : "queued",
          written: 0,
          unchanged: 0,
          archived: 0,
          paths: [],
          error: failure.message,
        };
      } catch (failError) {
        if (this.#leaseWasLost(event.eventId, leaseToken)) {
          return {
            eventId: event.eventId,
            status: "stale",
            written: 0,
            unchanged: 0,
            archived: 0,
            paths: [],
            error:
              failError instanceof Error
                ? failError.message
                : String(failError),
          };
        }
        throw failError;
      }
    }
  }

  public async drain(maxEvents = 100): Promise<ObsidianProjectionDrainResult> {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) {
      throw new ObsidianProjectionError(
        "maxEvents must be an integer from 1 to 10000",
        "invalid_projection",
        false,
      );
    }
    const deliveries: ObsidianProjectionDelivery[] = [];
    for (let index = 0; index < maxEvents; index += 1) {
      const delivery = await this.processNext();
      if (delivery === null) {
        break;
      }
      deliveries.push(delivery);
    }
    return {
      datasetId: this.#options.binding.datasetId,
      processed: deliveries.length,
      completed: deliveries.filter((item) => item.status === "completed").length,
      queued: deliveries.filter((item) => item.status === "queued").length,
      failed: deliveries.filter((item) => item.status === "failed").length,
      stale: deliveries.filter((item) => item.status === "stale").length,
      written: deliveries.reduce((total, item) => total + item.written, 0),
      unchanged: deliveries.reduce((total, item) => total + item.unchanged, 0),
      archived: deliveries.reduce((total, item) => total + item.archived, 0),
    };
  }

  #prepareNote(
    paths: ProjectPaths,
    event: ObsidianOutboxEvent,
    note: ObsidianProjectionNote,
  ): PreparedNote {
    if (typeof note !== "object" || note === null) {
      throw new ObsidianProjectionError(
        "Projection plan notes must be objects",
        "invalid_projection",
        false,
      );
    }
    const eventRequiresTombstone = [
      "archive",
      "delete",
      "deleted",
      "tombstone",
    ].includes(event.eventType);
    const disposition =
      note.disposition ?? (eventRequiresTombstone ? "tombstone" : "upsert");
    if (
      (disposition !== "upsert" && disposition !== "tombstone") ||
      (eventRequiresTombstone && disposition !== "tombstone")
    ) {
      throw new ObsidianProjectionError(
        "Deletion events must use tombstone disposition",
        "invalid_projection",
        false,
      );
    }
    const effectiveNote: ObsidianProjectionNote =
      note.disposition === disposition
        ? note
        : { ...note, disposition };
    if (
      typeof effectiveNote.body !== "string" ||
      Buffer.byteLength(effectiveNote.body, "utf8") > this.#maxNoteBytes
    ) {
      throw new ObsidianProjectionError(
        "Projection note body exceeds the configured byte limit",
        "invalid_projection",
        false,
      );
    }
    const identity = effectiveNote.identity ?? {
      entityType: event.entityType,
      entityId: event.entityId,
      sourceVersion: event.sourceVersion,
    };
    requireSingleLine(identity.entityType, "note identity entityType", 120);
    requireSingleLine(identity.entityId, "note identity entityId");
    requireSingleLine(identity.sourceVersion, "note identity sourceVersion");
    const relativePath = normalizeSafeRelative(
      effectiveNote.relativePath,
      "note.relativePath",
      { markdown: true },
    );
    const registryPath = joinRegistryPath(
      paths.managedRootRelative,
      relativePath,
    );
    const targetPath = absoluteFromRegistryPath(
      paths.realProjectRoot,
      registryPath,
    );
    if (disposition !== "tombstone") {
      return {
        note: effectiveNote,
        identity,
        relativePath,
        registryPath,
        targetPath,
      };
    }
    const archiveRelative = archiveRelativePath(
      relativePath,
      event.eventId,
    );
    const archiveRegistryPath = joinRegistryPath(
      paths.managedRootRelative,
      archiveRelative,
    );
    return {
      note: effectiveNote,
      identity,
      relativePath,
      registryPath,
      targetPath,
      archiveRegistryPath,
      archiveTargetPath: absoluteFromRegistryPath(
        paths.realProjectRoot,
        archiveRegistryPath,
      ),
    };
  }

  #assertUniquePlan(notes: readonly PreparedNote[]): void {
    const paths = new Set<string>();
    const identities = new Set<string>();
    for (const note of notes) {
      if (paths.has(note.registryPath)) {
        throw new ObsidianProjectionError(
          `Projection plan repeats managed path ${note.registryPath}`,
          "invalid_projection",
          false,
        );
      }
      paths.add(note.registryPath);
      const identity = [
        note.identity.entityType,
        note.identity.entityId,
        note.identity.sourceVersion,
      ].join("\0");
      if (identities.has(identity)) {
        throw new ObsidianProjectionError(
          "Projection plan repeats a registry identity",
          "invalid_projection",
          false,
        );
      }
      identities.add(identity);
    }
  }

  async #materializeNote(
    paths: ProjectPaths,
    event: ObsidianOutboxEvent,
    leaseToken: string,
    prepared: PreparedNote,
  ): Promise<MaterializedNote> {
    await ensureSecureDirectory(
      paths.realProjectRoot,
      path.posix.dirname(prepared.registryPath),
    );
    this.#assertPriorRegistryPathsManaged(prepared);
    const owner = this.#options.repository.findRegistryByPath(
      prepared.registryPath,
    );
    this.#assertRegistryOwner(owner, prepared);
    const rawExisting = await readTextNoFollow(
      prepared.targetPath,
      this.#maxNoteBytes,
    );
    const existing =
      rawExisting === null
        ? null
        : {
            ...rawExisting,
            inspected: inspectManagedMarkdown(rawExisting.content),
          };
    const rendered = renderManagedMarkdown({
      binding: this.#options.binding,
      event,
      note: prepared.note,
      identity: prepared.identity,
      registryPath: prepared.registryPath,
      ...(prepared.archiveRegistryPath === undefined
        ? {}
        : { archivePath: prepared.archiveRegistryPath }),
      ...(existing === null
        ? {}
        : { userBlock: existing.inspected.userBlock }),
    });
    this.#assertExistingIsOwned(existing, owner, rendered, prepared);

    let archived = false;
    const alreadyDesired =
      existing !== null &&
      existing.inspected.managedHash === rendered.managedHash &&
      existing.inspected.fingerprint === rendered.fingerprint;
    if (
      (prepared.note.disposition ?? "upsert") === "tombstone" &&
      existing !== null &&
      !alreadyDesired
    ) {
      const archiveTarget = prepared.archiveTargetPath;
      const archiveRegistryPath = prepared.archiveRegistryPath;
      if (archiveTarget === undefined || archiveRegistryPath === undefined) {
        throw new ObsidianProjectionError(
          "Tombstone projection omitted its archive target",
          "invalid_projection",
          false,
        );
      }
      await ensureSecureDirectory(
        paths.realProjectRoot,
        path.posix.dirname(archiveRegistryPath),
      );
      const archivedExisting = await readTextNoFollow(
        archiveTarget,
        this.#maxNoteBytes,
      );
      if (
        archivedExisting !== null &&
        archivedExisting.hash !== existing.hash
      ) {
        throw projectionConflict(
          `Archive target ${archiveRegistryPath} already contains different content`,
        );
      }
      if (archivedExisting === null) {
        await this.#atomicWrite({
          event,
          leaseToken,
          registryPath: archiveRegistryPath,
          targetPath: archiveTarget,
          content: existing.content,
          expectedExistingHash: null,
        });
      }
      archived = true;
    }

    let contentHash = existing?.hash ?? rendered.contentHash;
    const written =
      existing === null ||
      existing.inspected.managedHash !== rendered.managedHash ||
      existing.inspected.fingerprint !== rendered.fingerprint;
    if (written) {
      if (Buffer.byteLength(rendered.content, "utf8") > this.#maxNoteBytes) {
        throw new ObsidianProjectionError(
          "Rendered managed note exceeds the configured byte limit",
          "invalid_projection",
          false,
        );
      }
      await this.#atomicWrite({
        event,
        leaseToken,
        registryPath: prepared.registryPath,
        targetPath: prepared.targetPath,
        content: rendered.content,
        expectedExistingHash: existing?.hash ?? null,
      });
      contentHash = rendered.contentHash;
    }
    return {
      path: prepared.registryPath,
      written,
      archived,
      registryEntry: {
        datasetId: event.datasetId,
        entityType: prepared.identity.entityType,
        entityId: prepared.identity.entityId,
        sourceVersion: prepared.identity.sourceVersion,
        notePath: prepared.registryPath,
        contentHash,
        managedHash: rendered.managedHash,
        syncStatus: "synced",
      },
    };
  }

  #assertPriorRegistryPathsManaged(prepared: PreparedNote): void {
    const entries = this.#options.repository.listRegistry({
      datasetId: this.#options.binding.datasetId,
      entityType: prepared.identity.entityType,
      entityId: prepared.identity.entityId,
      limit: 500,
    }).items;
    for (const entry of entries) {
      this.#assertManagedRegistryPath(entry.notePath);
    }
  }

  #assertManagedRegistryPath(notePath: string): void {
    const normalized = normalizeSafeRelative(notePath, "registry notePath", {
      markdown: true,
      allowInternal: true,
    });
    if (
      normalized !== this.#managedRootRelative &&
      !normalized.startsWith(`${this.#managedRootRelative}/`)
    ) {
      throw projectionConflict(
        `Registry path ${notePath} is outside the configured managed root`,
      );
    }
  }

  #assertRegistryOwner(
    owner: ObsidianRegistryEntry | null,
    prepared: PreparedNote,
  ): void {
    if (owner === null) {
      return;
    }
    this.#assertManagedRegistryPath(owner.notePath);
    if (
      owner.datasetId !== this.#options.binding.datasetId ||
      owner.entityType !== prepared.identity.entityType ||
      owner.entityId !== prepared.identity.entityId
    ) {
      throw projectionConflict(
        `Managed path ${prepared.registryPath} belongs to another registry identity`,
      );
    }
  }

  #assertExistingIsOwned(
    existing: ExistingFile | null,
    owner: ObsidianRegistryEntry | null,
    rendered: RenderedManagedMarkdown,
    prepared: PreparedNote,
  ): void {
    if (existing === null) {
      return;
    }
    const isDesiredCrashArtifact =
      existing.inspected.managedHash === rendered.managedHash &&
      existing.inspected.fingerprint === rendered.fingerprint;
    if (owner === null) {
      if (!isDesiredCrashArtifact) {
        throw projectionConflict(
          `Refusing to overwrite unregistered file ${prepared.registryPath}`,
        );
      }
      return;
    }
    if (
      existing.inspected.managedHash !== owner.managedHash &&
      !isDesiredCrashArtifact
    ) {
      throw projectionConflict(
        `Managed content in ${prepared.registryPath} was externally modified`,
      );
    }
  }

  async #atomicWrite(input: {
    readonly event: ObsidianOutboxEvent;
    readonly leaseToken: string;
    readonly registryPath: string;
    readonly targetPath: string;
    readonly content: string;
    readonly expectedExistingHash: string | null;
  }): Promise<void> {
    const parent = path.dirname(input.targetPath);
    const temporaryPath = path.join(
      parent,
      `.${path.basename(input.targetPath)}.${randomUUID()}.tmp`,
    );
    const lifecycle: ProjectionLifecycleContext = {
      event: input.event,
      leaseToken: input.leaseToken,
      registryPath: input.registryPath,
      targetPath: input.targetPath,
      temporaryPath,
    };
    let handle;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(input.content, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#options.lifecycle?.beforeAtomicRename?.(lifecycle);
      this.#assertLease(input.event.eventId, input.leaseToken);
      const current = await readTextNoFollow(
        input.targetPath,
        this.#maxNoteBytes,
      );
      if (
        (current === null && input.expectedExistingHash !== null) ||
        (current !== null &&
          current.hash !== input.expectedExistingHash)
      ) {
        throw projectionConflict(
          `Managed note ${input.registryPath} changed during atomic publication`,
        );
      }
      await rename(temporaryPath, input.targetPath);
      await fsyncDirectory(parent);
      await this.#options.lifecycle?.afterAtomicRename?.(lifecycle);
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isMissing(error)) {
          throw error;
        }
      });
    }
  }

  #assertLease(eventId: string, leaseToken: string): void {
    try {
      this.#options.repository.assertEventLease(eventId, leaseToken);
    } catch (error) {
      if (error instanceof WorkflowStoreError && error.code === "conflict") {
        throw new ObsidianProjectionError(
          "Projection lease was lost before filesystem publication",
          "stale_lease",
          false,
          { cause: error },
        );
      }
      throw error;
    }
  }

  #leaseWasLost(eventId: string, leaseToken: string): boolean {
    try {
      const current = this.#options.repository.getEvent(eventId);
      return (
        current.status !== "running" ||
        current.leaseToken !== leaseToken
      );
    } catch {
      return true;
    }
  }
}
