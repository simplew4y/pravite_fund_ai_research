import { createHash } from "node:crypto";

import {
  encodeJson,
  type JsonValue,
  type ObsidianOutboxEvent,
} from "@private-fund/workflow-store";

import type {
  ObsidianEvidenceReference,
  ObsidianProjectBinding,
  ObsidianProjectionNote,
  ProjectionNoteIdentity,
} from "./types.js";
import { ObsidianProjectionError } from "./types.js";

export const MANAGED_BEGIN = "<!-- PRIVATE-FUND:MANAGED:BEGIN -->";
export const MANAGED_END = "<!-- PRIVATE-FUND:MANAGED:END -->";
export const USER_BEGIN = "<!-- PRIVATE-FUND:USER:BEGIN -->";
export const USER_END = "<!-- PRIVATE-FUND:USER:END -->";
export const MANAGED_BY = "private-fund-obsidian-projector";

const RESERVED_FRONTMATTER_KEYS = new Set([
  "archived_path",
  "dataset_id",
  "disposition",
  "entity_id",
  "entity_type",
  "evidence_refs",
  "managed_by",
  "project_id",
  "projection_event_type",
  "projection_event_id",
  "projection_fingerprint",
  "projector_version",
  "registry_path",
  "source_system",
  "source_version",
  "tenant_id",
  "title",
]);

export interface RenderManagedMarkdownInput {
  readonly binding: ObsidianProjectBinding;
  readonly event: ObsidianOutboxEvent;
  readonly note: ObsidianProjectionNote;
  readonly identity: ProjectionNoteIdentity;
  readonly registryPath: string;
  readonly archivePath?: string;
  readonly userBlock?: string;
}

export interface RenderedManagedMarkdown {
  readonly content: string;
  readonly contentHash: string;
  readonly managedHash: string;
  readonly fingerprint: string;
  readonly evidence: readonly Required<ObsidianEvidenceReference>[];
  readonly userBlock: string;
}

export interface InspectedManagedMarkdown {
  readonly contentHash: string;
  readonly managedHash: string;
  readonly fingerprint: string | null;
  readonly userBlock: string;
}

function projectionError(message: string): ObsidianProjectionError {
  return new ObsidianProjectionError(
    message,
    "invalid_projection",
    false,
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function oneLine(
  value: string,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw projectionError(
      `${field} must be a non-empty single-line string of at most ${String(maxLength)} characters`,
    );
  }
  return value;
}

function normalizeBody(value: string): string {
  if (typeof value !== "string") {
    throw projectionError("Projection note body must be text");
  }
  const body = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (
    body.includes(MANAGED_BEGIN) ||
    body.includes(MANAGED_END) ||
    body.includes(USER_BEGIN) ||
    body.includes(USER_END)
  ) {
    throw projectionError(
      "Projection note body may not contain projector boundary markers",
    );
  }
  return body;
}

function normalizeEvidence(
  evidence: readonly ObsidianEvidenceReference[] | undefined,
): readonly Required<ObsidianEvidenceReference>[] {
  if ((evidence?.length ?? 0) > 10_000) {
    throw projectionError(
      "Projection note may reference at most 10000 evidence records",
    );
  }
  const unique = new Map<string, Required<ObsidianEvidenceReference>>();
  for (const item of evidence ?? []) {
    const evidenceId = oneLine(item.evidenceId, "evidenceId", 500);
    const relation =
      item.relation === undefined
        ? "supports"
        : oneLine(item.relation, "evidence relation", 120);
    const label =
      item.label === undefined
        ? evidenceId
        : oneLine(item.label, "evidence label", 500);
    const key = encodeJson([evidenceId, relation, label]);
    unique.set(key, { evidenceId, relation, label });
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, item]) => item);
}

function yamlValue(value: JsonValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // JSON flow syntax is valid YAML and avoids adding a YAML dependency.
  return encodeJson(value);
}

function frontmatter(
  values: Readonly<Record<string, JsonValue>>,
): string {
  return [
    "---",
    ...Object.keys(values)
      .sort()
      .map((key) => `${key}: ${yamlValue(values[key] ?? null)}`),
    "---",
  ].join("\n");
}

function defaultUserBlock(): string {
  return [
    USER_BEGIN,
    "",
    "## Analyst notes",
    "",
    "> This section is owned by analysts and is preserved by projection.",
    "",
    USER_END,
  ].join("\n");
}

function markdownInline(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}

function managedBody(
  note: ObsidianProjectionNote,
  evidence: readonly Required<ObsidianEvidenceReference>[],
  archivePath: string | undefined,
): string {
  const original = normalizeBody(note.body);
  const body =
    (note.disposition ?? "upsert") === "tombstone"
      ? [
          "> [!warning] Archived projection",
          `> This managed note was tombstoned. The previous materialization is preserved at \`${markdownInline(archivePath ?? "not-materialized")}\`.`,
          ...(original.length === 0 ? [] : ["", original]),
        ].join("\n")
      : original;
  const evidenceSection =
    evidence.length === 0
      ? []
      : [
          "",
          "## Evidence references",
          "",
          ...evidence.map(
            (item) =>
              `- \`${markdownInline(item.evidenceId)}\` — ${markdownInline(item.relation)} — ${markdownInline(item.label)}`,
          ),
        ];
  return [body, ...evidenceSection].filter((line, index) => {
    return !(index === 0 && line.length === 0);
  }).join("\n");
}

export function renderManagedMarkdown(
  input: RenderManagedMarkdownInput,
): RenderedManagedMarkdown {
  const title = oneLine(input.note.title, "note title", 500);
  const evidence = normalizeEvidence(input.note.evidence);
  const disposition = input.note.disposition ?? "upsert";
  const metadata = input.note.metadata ?? {};
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw projectionError("Projection metadata must be a JSON object");
  }
  for (const key of Object.keys(metadata)) {
    if (RESERVED_FRONTMATTER_KEYS.has(key)) {
      throw projectionError(
        `Projection metadata may not replace reserved field ${key}`,
      );
    }
    oneLine(key, "metadata key", 160);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key)) {
      throw projectionError(
        `Projection metadata key ${key} is not a safe frontmatter identifier`,
      );
    }
  }
  const fingerprint = hash(
    encodeJson({
      archivePath: input.archivePath ?? null,
      binding: {
        datasetId: input.binding.datasetId,
        projectId: input.binding.projectId,
        tenantId: input.binding.tenantId,
      },
      body: normalizeBody(input.note.body),
      disposition,
      entityId: input.identity.entityId,
      entityType: input.identity.entityType,
      eventId: input.event.eventId,
      evidence,
      metadata,
      registryPath: input.registryPath,
      sourceVersion: input.identity.sourceVersion,
      title,
    }),
  );
  const properties: Record<string, JsonValue> = {
    ...metadata,
    dataset_id: input.binding.datasetId,
    disposition,
    entity_id: input.identity.entityId,
    entity_type: input.identity.entityType,
    evidence_refs: evidence.map((item) => ({
      evidence_id: item.evidenceId,
      label: item.label,
      relation: item.relation,
    })),
    managed_by: MANAGED_BY,
    project_id: input.binding.projectId,
    projection_event_id: input.event.eventId,
    projection_event_type: input.event.eventType,
    projection_fingerprint: fingerprint,
    projector_version: input.event.projectorVersion,
    registry_path: input.registryPath,
    source_system: "private-fund-control-plane",
    source_version: input.identity.sourceVersion,
    tenant_id: input.binding.tenantId,
    title,
    ...(input.archivePath === undefined
      ? {}
      : { archived_path: input.archivePath }),
  };
  const autoRegion = [
    MANAGED_BEGIN,
    "",
    managedBody(input.note, evidence, input.archivePath),
    "",
    MANAGED_END,
  ].join("\n");
  const managed = `${frontmatter(properties)}\n\n${autoRegion}`;
  const userBlock = input.userBlock ?? defaultUserBlock();
  if (
    !userBlock.startsWith(USER_BEGIN) ||
    !userBlock.trimEnd().endsWith(USER_END)
  ) {
    throw projectionError("Preserved user block has invalid boundary markers");
  }
  const content = `${managed}\n\n${userBlock.trim()}\n`;
  return {
    content,
    contentHash: hash(content),
    managedHash: hash(managed),
    fingerprint,
    evidence,
    userBlock: userBlock.trim(),
  };
}

export function inspectManagedMarkdown(
  content: string,
): InspectedManagedMarkdown {
  if (!content.startsWith("---\n")) {
    throw new ObsidianProjectionError(
      "Existing note has no managed frontmatter",
      "managed_content_conflict",
      false,
    );
  }
  const frontmatterEnd = content.indexOf("\n---\n", 4);
  const managedBegin = content.indexOf(MANAGED_BEGIN);
  const managedEnd = content.indexOf(MANAGED_END);
  const userBegin = content.indexOf(USER_BEGIN);
  const userEnd = content.indexOf(USER_END);
  if (
    frontmatterEnd < 0 ||
    managedBegin < frontmatterEnd ||
    managedEnd < managedBegin ||
    userBegin < managedEnd ||
    userEnd < userBegin
  ) {
    throw new ObsidianProjectionError(
      "Existing note has malformed projector boundaries",
      "managed_content_conflict",
      false,
    );
  }
  const managedFinish = managedEnd + MANAGED_END.length;
  const userFinish = userEnd + USER_END.length;
  if (content.slice(userFinish).trim().length !== 0) {
    throw new ObsidianProjectionError(
      "Existing note contains unregistered content outside the analyst block",
      "managed_content_conflict",
      false,
    );
  }
  const managed = content.slice(0, managedFinish);
  const userBlock = content.slice(userBegin, userFinish);
  const fingerprintMatch =
    /^projection_fingerprint: ("(?:[^"\\]|\\.)*")$/m.exec(
      content.slice(0, frontmatterEnd + 1),
    );
  let fingerprint: string | null = null;
  if (fingerprintMatch?.[1] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(fingerprintMatch[1]);
      fingerprint = typeof parsed === "string" ? parsed : null;
    } catch {
      fingerprint = null;
    }
  }
  return {
    contentHash: hash(content),
    managedHash: hash(managed),
    fingerprint,
    userBlock,
  };
}
