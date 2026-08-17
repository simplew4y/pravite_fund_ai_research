import { createHash } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
  SESSION_ATTACHMENT_MAX_COUNT,
  SESSION_ATTACHMENT_MAX_IMAGE_BYTES,
  SESSION_ATTACHMENT_MAX_PDF_BYTES,
  SESSION_ATTACHMENT_MAX_TEXT_BYTES,
  createSessionDocumentReferenceResourceRequestSchema,
  createSessionResearchAssetResourceRequestSchema,
  deleteSessionResourceResponseSchema,
  deleteSessionResourcesResponseSchema,
  listSessionAttachmentsQuerySchema,
  listSessionResourcesQuerySchema,
  sessionAttachmentPageSchema,
  sessionAttachmentResourceSchema,
  sessionResourcePageSchema,
  sessionResourceSchema,
  uploadSessionAttachmentMetadataSchema,
  type CreateSessionDocumentReferenceResourceRequest,
  type CreateSessionResearchAssetResourceRequest,
  type DeleteSessionResourceResponse,
  type DeleteSessionResourcesResponse,
  type ListSessionAttachmentsQuery,
  type ListSessionResourcesQuery,
  type SessionAttachmentPage,
  type SessionAttachmentResource,
  type SessionResource,
  type SessionResourcePage,
} from "@private-fund/contracts";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  assertPathWithin,
  newId,
  type TenantContext,
} from "@private-fund/core";
import type {
  ControlRepositories,
  SessionAttachmentRecord,
  SessionResourcePageRecord,
  SessionResourceRecord,
} from "@private-fund/db";

import { ProjectResearchStoreManager } from "./research-stores.js";
import type {
  SessionResourcesService,
  UploadSessionAttachmentInput,
} from "./dependencies.js";
import {
  openSecureProjectFile,
  type OpenedFileResource,
} from "./secure-files.js";

export type {
  SessionResourcesService,
  UploadSessionAttachmentInput,
} from "./dependencies.js";

type SessionResourceRepositories = Pick<
  ControlRepositories,
  "sessions" | "sessionResources"
>;

interface AttachmentPolicy {
  readonly category: "image" | "pdf" | "text";
  readonly extension: string;
  readonly mimeType: string;
  readonly maxBytes: number;
}

interface WrittenAttachment {
  readonly sha256: string;
  readonly sizeBytes: number;
}

interface AttachmentDirectories {
  readonly objects: string;
  readonly incoming: string;
  readonly realTenantRoot: string;
}

const IMAGE_TYPES = new Map<string, {
  readonly canonical: string;
  readonly accepted: ReadonlySet<string>;
}>([
  [
    ".png",
    {
      canonical: "image/png",
      accepted: new Set(["image/png"]),
    },
  ],
  [
    ".jpg",
    {
      canonical: "image/jpeg",
      accepted: new Set(["image/jpeg", "image/jpg", "image/pjpeg"]),
    },
  ],
  [
    ".jpeg",
    {
      canonical: "image/jpeg",
      accepted: new Set(["image/jpeg", "image/jpg", "image/pjpeg"]),
    },
  ],
  [
    ".gif",
    {
      canonical: "image/gif",
      accepted: new Set(["image/gif"]),
    },
  ],
  [
    ".webp",
    {
      canonical: "image/webp",
      accepted: new Set(["image/webp"]),
    },
  ],
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".env",
  ".lock",
  ".proto",
  ".graphql",
  ".gql",
  ".html",
  ".htm",
  ".xml",
  ".css",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".pl",
  ".r",
  ".jl",
  ".lua",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".clj",
  ".dart",
  ".vue",
  ".svelte",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".sql",
  ".tf",
  ".hcl",
  ".gradle",
  ".dockerfile",
  ".ipynb",
]);

const TEXT_LIKE_APPLICATION_MIMES = new Set([
  "application/json",
  "application/javascript",
  "application/jsonl",
  "application/x-ndjson",
  "application/x-ipynb+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/graphql",
]);

const GENERIC_BINARY_MIME = "application/octet-stream";

export class RepositorySessionResourcesService
  implements SessionResourcesService {
  public constructor(
    private readonly repositories: SessionResourceRepositories,
    private readonly stores: ProjectResearchStoreManager,
  ) {}

  public async listResources(
    tenant: TenantContext,
    sessionId: string,
    options: Partial<ListSessionResourcesQuery> = {},
  ): Promise<SessionResourcePage> {
    const query = listSessionResourcesQuerySchema.parse(options);
    const page = this.repositories.sessionResources.listForTenant(
      tenant.dataNamespace,
      sessionId,
      {
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        lifecycle: query.lifecycle,
        limit: query.limit,
        offset: query.offset,
      },
    );
    return sessionResourcePageSchema.parse(mapPage(page));
  }

  public async getResource(
    tenant: TenantContext,
    sessionId: string,
    resourceId: string,
  ): Promise<SessionResource> {
    return toPublicResource(
      this.repositories.sessionResources.getForTenant(
        tenant.dataNamespace,
        sessionId,
        resourceId,
      ),
    );
  }

  public async deleteResources(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<DeleteSessionResourcesResponse> {
    const deleted =
      this.repositories.sessionResources.markAllDeletedForTenant(
        tenant.dataNamespace,
        sessionId,
      );
    return deleteSessionResourcesResponseSchema.parse({
      sessionId,
      object: "session.resources.cleaned",
      cleaned: true,
      deletedCount: deleted.deletedCount,
      deletedAt: deleted.deletedAt,
    });
  }

  public async listAttachments(
    tenant: TenantContext,
    sessionId: string,
    options: Partial<ListSessionAttachmentsQuery> = {},
  ): Promise<SessionAttachmentPage> {
    const query = listSessionAttachmentsQuerySchema.parse(options);
    const page =
      this.repositories.sessionResources.listAttachmentsForTenant(
        tenant.dataNamespace,
        sessionId,
        query,
      );
    return sessionAttachmentPageSchema.parse({
      ...page,
      items: page.items.map(toPublicAttachment),
    });
  }

  public async getAttachment(
    tenant: TenantContext,
    sessionId: string,
    attachmentId: string,
  ): Promise<SessionAttachmentResource> {
    return toPublicAttachment(
      this.repositories.sessionResources.getAttachmentForTenant(
        tenant.dataNamespace,
        sessionId,
        attachmentId,
      ),
    );
  }

  public async uploadAttachment(
    tenant: TenantContext,
    sessionId: string,
    input: UploadSessionAttachmentInput,
  ): Promise<SessionAttachmentResource> {
    const metadata = uploadSessionAttachmentMetadataSchema.parse({
      filename: input.filename.normalize("NFKC").trim(),
      mimeType: input.mimeType,
    });
    const session = this.repositories.sessions.getForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    assertSafeSessionStorageSegment(session.id);
    const policy = attachmentPolicy(metadata.filename, metadata.mimeType);
    const usage =
      this.repositories.sessionResources.attachmentUsageForTenant(
        tenant.dataNamespace,
        sessionId,
      );
    if (usage.count >= SESSION_ATTACHMENT_MAX_COUNT) {
      throw new ConflictError(
        `A session may have at most ${String(
          SESSION_ATTACHMENT_MAX_COUNT,
        )} active attachments`,
        "session_attachment_count_limit",
      );
    }

    const id = newId("resource");
    const relativePath = path.posix.join(
      "session-attachments",
      session.id,
      "objects",
      `${id}${policy.extension}`,
    );
    const directories = await ensureAttachmentDirectories(
      tenant,
      session.id,
    );
    const temporary = path.join(directories.incoming, `${id}.part`);
    const destination = path.join(
      directories.objects,
      `${id}${policy.extension}`,
    );
    const written = await writeTemporaryAttachment(
      temporary,
      input.contents,
      policy,
      input.signal,
    );

    let published = false;
    let registered = false;
    try {
      await link(temporary, destination);
      published = true;
      await assertPublishedAttachment(
        destination,
        directories.realTenantRoot,
      );
      await unlink(temporary);
      await fsyncDirectory(directories.objects);

      const record =
        this.repositories.sessionResources.createAttachmentForTenant(
          tenant.dataNamespace,
          session.id,
          {
            id,
            filename: metadata.filename,
            relativePath,
            mimeType: policy.mimeType,
            sizeBytes: written.sizeBytes,
            sha256: written.sha256,
          },
        );
      registered = true;
      if (record.projectId !== session.projectId) {
        throw new ConflictError(
          "Attachment project scope changed during registration",
          "session_attachment_scope_conflict",
        );
      }
      return toPublicAttachment(record);
    } catch (error) {
      if (published && !registered) {
        await unlink(destination).catch((cleanupError: unknown) => {
          if (!isMissing(cleanupError)) {
            throw cleanupError;
          }
        });
        await fsyncDirectory(directories.objects).catch(() => undefined);
      }
      throw normalizePublishError(error);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) {
          throw error;
        }
      });
    }
  }

  public async deleteAttachment(
    tenant: TenantContext,
    sessionId: string,
    attachmentId: string,
  ): Promise<DeleteSessionResourceResponse> {
    const deleted =
      this.repositories.sessionResources.markAttachmentDeletedForTenant(
        tenant.dataNamespace,
        sessionId,
        attachmentId,
      );
    if (deleted.deletedAt === null) {
      throw new ConflictError(
        "Deleted attachment has no deletion timestamp",
        "session_attachment_lifecycle_conflict",
      );
    }
    return deleteSessionResourceResponseSchema.parse({
      id: deleted.id,
      object: "session.resource.deleted",
      kind: deleted.kind,
      deleted: true,
      deletedAt: deleted.deletedAt,
    });
  }

  public async openAttachmentContent(
    tenant: TenantContext,
    sessionId: string,
    attachmentId: string,
  ): Promise<OpenedFileResource> {
    const session = this.repositories.sessions.getForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    const attachment =
      this.repositories.sessionResources.getAttachmentForTenant(
        tenant.dataNamespace,
        sessionId,
        attachmentId,
      );
    if (attachment.projectId !== session.projectId) {
      throw new NotFoundError("Session attachment");
    }
    return openSecureProjectFile(tenant.root, attachment.relativePath, {
      filename: attachment.name,
      mimeType: attachment.mimeType,
      expectedSize: attachment.sizeBytes,
      expectedSha256: attachment.sha256,
    });
  }

  public async addResearchAssetResource(
    tenant: TenantContext,
    sessionId: string,
    input: CreateSessionResearchAssetResourceRequest,
  ): Promise<SessionResource> {
    const request =
      createSessionResearchAssetResourceRequestSchema.parse(input);
    const session = this.repositories.sessions.getForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    const store = this.stores.get(
      projectRootForSession(tenant, session.projectId),
    );
    const asset = store.assets.get(request.assetId);
    if (asset.deletedAt !== null) {
      throw new NotFoundError("Research asset");
    }
    const version =
      request.versionId === undefined
        ? store.assets.getCurrentVersion(asset.id)
        : store.assets.getVersion(request.versionId);
    if (version === null || version.assetId !== asset.id) {
      throw new NotFoundError("Research asset version");
    }
    return toPublicResource(
      this.repositories.sessionResources.createResearchAssetForTenant(
        tenant.dataNamespace,
        session.id,
        {
          name: asset.title,
          referenceId: asset.id,
          referenceVersionId: version.id,
        },
      ).resource,
    );
  }

  public async addDocumentReferenceResource(
    tenant: TenantContext,
    sessionId: string,
    input: CreateSessionDocumentReferenceResourceRequest,
  ): Promise<SessionResource> {
    const request =
      createSessionDocumentReferenceResourceRequestSchema.parse(input);
    const session = this.repositories.sessions.getForTenant(
      tenant.dataNamespace,
      sessionId,
    );
    const store = this.stores.get(
      projectRootForSession(tenant, session.projectId),
    );
    const document = store.documents.getById(request.documentId);
    if (document.status === "removed" || document.deletedAt !== null) {
      throw new NotFoundError("Document");
    }
    const version =
      request.versionId === undefined
        ? store.documents.getCurrentVersion(document.id)
        : store.documents.getVersion(request.versionId);
    if (
      version === null ||
      version.documentId !== document.id ||
      version.lifecycle === "removed" ||
      version.lifecycle === "failed_attempt"
    ) {
      throw new NotFoundError("Document version");
    }
    return toPublicResource(
      this.repositories.sessionResources.createDocumentReferenceForTenant(
        tenant.dataNamespace,
        session.id,
        {
          name: document.title,
          referenceId: document.id,
          referenceVersionId: version.id,
        },
      ).resource,
    );
  }
}

function mapPage(page: SessionResourcePageRecord): {
  readonly items: SessionResource[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
} {
  return {
    ...page,
    items: page.items.map(toPublicResource),
  };
}

function toPublicResource(
  resource: SessionResourceRecord,
): SessionResource {
  const base = {
    id: resource.id,
    object: "session.resource" as const,
    sessionId: resource.sessionId,
    projectId: resource.projectId,
    lifecycle: resource.lifecycle,
    name: resource.name,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    deletedAt: resource.deletedAt,
  };
  switch (resource.kind) {
    case "attachment":
      return sessionResourceSchema.parse({
        ...base,
        kind: resource.kind,
        attachment: {
          filename: resource.name,
          mimeType: resource.mimeType,
          bytes: resource.sizeBytes,
          sha256: resource.sha256,
        },
      });
    case "research_asset":
      return sessionResourceSchema.parse({
        ...base,
        kind: resource.kind,
        researchAsset: {
          assetId: resource.referenceId,
          versionId: resource.referenceVersionId,
        },
      });
    case "document_reference":
      return sessionResourceSchema.parse({
        ...base,
        kind: resource.kind,
        documentReference: {
          documentId: resource.referenceId,
          versionId: resource.referenceVersionId,
        },
      });
  }
}

function toPublicAttachment(
  attachment: SessionAttachmentRecord,
): SessionAttachmentResource {
  return sessionAttachmentResourceSchema.parse(
    toPublicResource(attachment),
  );
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

function baseMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function attachmentPolicy(
  filename: string,
  declaredMimeType: string,
): AttachmentPolicy {
  const extension = extensionOf(filename);
  const declared = baseMimeType(declaredMimeType);
  const image = IMAGE_TYPES.get(extension);
  if (image !== undefined) {
    if (
      declared !== GENERIC_BINARY_MIME &&
      !image.accepted.has(declared)
    ) {
      throw mimeMismatch(extension, declared);
    }
    return {
      category: "image",
      extension,
      mimeType: image.canonical,
      maxBytes: SESSION_ATTACHMENT_MAX_IMAGE_BYTES,
    };
  }
  if (extension === ".pdf") {
    if (
      declared !== GENERIC_BINARY_MIME &&
      declared !== "application/pdf"
    ) {
      throw mimeMismatch(extension, declared);
    }
    return {
      category: "pdf",
      extension,
      mimeType: "application/pdf",
      maxBytes: SESSION_ATTACHMENT_MAX_PDF_BYTES,
    };
  }
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw new DomainError(
      "Only supported images, PDF, and text/code files can be attached",
      "unsupported_attachment_type",
      415,
    );
  }
  const compatible =
    declared === GENERIC_BINARY_MIME ||
    declared.startsWith("text/") ||
    TEXT_LIKE_APPLICATION_MIMES.has(declared) ||
    (extension === ".csv" &&
      (declared === "application/csv" ||
        declared === "application/vnd.ms-excel")) ||
    ((extension === ".ts" || extension === ".tsx") &&
      declared === "video/mp2t");
  if (!compatible) {
    throw mimeMismatch(extension, declared);
  }
  return {
    category: "text",
    extension,
    mimeType: canonicalTextMimeType(extension),
    maxBytes: SESSION_ATTACHMENT_MAX_TEXT_BYTES,
  };
}

function canonicalTextMimeType(extension: string): string {
  switch (extension) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".tsv":
      return "text/tab-separated-values";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/jsonl";
    case ".ndjson":
      return "application/x-ndjson";
    case ".html":
    case ".htm":
      return "text/html";
    case ".xml":
      return "application/xml";
    case ".css":
      return "text/css";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".py":
      return "text/x-python";
    case ".yaml":
    case ".yml":
      return "text/yaml";
    case ".ipynb":
      return "application/x-ipynb+json";
    default:
      return "text/plain";
  }
}

function mimeMismatch(extension: string, mimeType: string): DomainError {
  return new DomainError(
    `Attachment MIME type ${mimeType || "(empty)"} does not match ${
      extension || "the filename"
    }`,
    "attachment_mime_mismatch",
    415,
  );
}

async function ensureAttachmentDirectories(
  tenant: TenantContext,
  sessionId: string,
): Promise<AttachmentDirectories> {
  await mkdir(tenant.root, { recursive: true, mode: 0o700 });
  const tenantDetails = await lstat(tenant.root);
  if (!tenantDetails.isDirectory() || tenantDetails.isSymbolicLink()) {
    throw new DomainError(
      "Tenant storage root is not a directory",
      "unsafe_attachment_storage",
      409,
    );
  }
  const realTenantRoot = await realpath(tenant.root);
  const attachments = await ensurePlainDirectory(
    tenant.root,
    "session-attachments",
    realTenantRoot,
  );
  const session = await ensurePlainDirectory(
    attachments,
    sessionId,
    realTenantRoot,
  );
  const objects = await ensurePlainDirectory(
    session,
    "objects",
    realTenantRoot,
  );
  const incoming = await ensurePlainDirectory(
    session,
    ".incoming",
    realTenantRoot,
  );
  return {
    objects: await realpath(objects),
    incoming: await realpath(incoming),
    realTenantRoot,
  };
}

async function ensurePlainDirectory(
  parent: string,
  segment: string,
  realTenantRoot: string,
): Promise<string> {
  const candidate = assertPathWithin(path.join(parent, segment), parent);
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
  const details = await lstat(candidate);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new DomainError(
      "Attachment storage contains a non-directory or symbolic link",
      "unsafe_attachment_storage",
      409,
    );
  }
  assertPathWithin(await realpath(candidate), realTenantRoot);
  return candidate;
}

function assertSafeSessionStorageSegment(sessionId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(sessionId) ||
    sessionId === "." ||
    sessionId === ".."
  ) {
    throw new DomainError(
      "Session identifier cannot be represented in attachment storage",
      "unsafe_session_identifier",
      409,
    );
  }
}

async function writeTemporaryAttachment(
  filename: string,
  contents: AsyncIterable<Uint8Array>,
  policy: AttachmentPolicy,
  signal: AbortSignal | undefined,
): Promise<WrittenAttachment> {
  const handle = await open(filename, "wx", 0o600);
  const digest = createHash("sha256");
  const decoder =
    policy.category === "text"
      ? new TextDecoder("utf-8", { fatal: true })
      : null;
  let prefix = Buffer.alloc(0);
  let sizeBytes = 0;
  try {
    for await (const value of contents) {
      signal?.throwIfAborted();
      if (!(value instanceof Uint8Array)) {
        throw new DomainError(
          "Attachment stream produced a non-byte chunk",
          "invalid_attachment_stream",
          400,
        );
      }
      if (value.byteLength === 0) {
        continue;
      }
      if (sizeBytes + value.byteLength > policy.maxBytes) {
        throw new DomainError(
          `Attachment exceeds the ${String(
            Math.floor(policy.maxBytes / (1024 * 1024)),
          )} MiB ${policy.category} limit`,
          "attachment_too_large",
          413,
        );
      }
      const chunk = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      if (decoder !== null) {
        if (chunk.includes(0)) {
          throw invalidAttachmentContent("Text attachment contains NUL bytes");
        }
        try {
          decoder.decode(chunk, { stream: true });
        } catch {
          throw invalidAttachmentContent(
            "Text attachment is not valid UTF-8",
          );
        }
      }
      if (prefix.byteLength < 16) {
        prefix = Buffer.concat([
          prefix,
          chunk.subarray(0, 16 - prefix.byteLength),
        ]);
      }
      digest.update(chunk);
      await writeAll(handle, chunk);
      sizeBytes += chunk.byteLength;
    }
    signal?.throwIfAborted();
    if (sizeBytes === 0) {
      throw new DomainError(
        "Attachment must not be empty",
        "empty_attachment",
        400,
      );
    }
    if (decoder !== null) {
      try {
        decoder.decode();
      } catch {
        throw invalidAttachmentContent(
          "Text attachment is not valid UTF-8",
        );
      }
    }
    validateAttachmentMagic(policy, prefix);
    await handle.sync();
    return {
      sha256: digest.digest("hex"),
      sizeBytes,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(filename).catch((cleanupError: unknown) => {
      if (!isMissing(cleanupError)) {
        throw cleanupError;
      }
    });
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeAll(
  handle: FileHandle,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (result.bytesWritten === 0) {
      throw new Error("Attachment writer made no progress");
    }
    offset += result.bytesWritten;
  }
}

function validateAttachmentMagic(
  policy: AttachmentPolicy,
  prefix: Buffer,
): void {
  if (policy.category === "text") {
    return;
  }
  if (policy.category === "pdf") {
    if (!prefix.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
      throw invalidAttachmentContent(
        "PDF attachment does not have a PDF signature",
      );
    }
    return;
  }
  let valid = false;
  switch (policy.extension) {
    case ".png":
      valid = prefix
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      break;
    case ".jpg":
    case ".jpeg":
      valid =
        prefix[0] === 0xff &&
        prefix[1] === 0xd8 &&
        prefix[2] === 0xff;
      break;
    case ".gif":
      valid =
        prefix.subarray(0, 6).toString("ascii") === "GIF87a" ||
        prefix.subarray(0, 6).toString("ascii") === "GIF89a";
      break;
    case ".webp":
      valid =
        prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
        prefix.subarray(8, 12).toString("ascii") === "WEBP";
      break;
  }
  if (!valid) {
    throw invalidAttachmentContent(
      "Image attachment signature does not match its extension",
    );
  }
}

function invalidAttachmentContent(message: string): DomainError {
  return new DomainError(
    message,
    "attachment_content_mismatch",
    415,
  );
}

async function assertPublishedAttachment(
  filename: string,
  realTenantRoot: string,
): Promise<void> {
  const details = await lstat(filename);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new ConflictError(
      "Attachment destination is not an immutable regular file",
      "attachment_publish_conflict",
    );
  }
  assertPathWithin(await realpath(filename), realTenantRoot);
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizePublishError(error: unknown): unknown {
  if (isAlreadyExists(error)) {
    return new ConflictError(
      "Opaque attachment destination already exists",
      "attachment_publish_conflict",
    );
  }
  return error;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function projectRootForSession(
  tenant: TenantContext,
  projectId: string,
): string {
  return assertPathWithin(
    path.join(tenant.projectsRoot, projectId),
    tenant.root,
  );
}
