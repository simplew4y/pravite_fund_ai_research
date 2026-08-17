import {
  modelRequestDraftSchema,
  modelRequestSnapshotSchema,
  modelSourceManifestEntrySchema,
  type ModelRequestDraft,
  type ModelRequestSnapshot,
  type ModelSourceManifestEntry,
} from "@private-fund/contracts";
import {
  canonicalJsonSha256,
  canonicalizeJson,
  sha256Hex,
} from "@private-fund/core";

export class ModelRequestProvenanceError extends Error {
  public readonly code = "model_request_provenance_invalid";

  public constructor(message: string) {
    super(message);
    this.name = "ModelRequestProvenanceError";
  }
}

export interface NewModelSourceManifestEntry
  extends Omit<ModelSourceManifestEntry, "contentHash" | "sizeBytes"> {}

interface ResolvedPointer {
  readonly pointer: string;
  readonly value: unknown;
}

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointer(body: unknown, pointer: string): unknown {
  if (pointer === "") {
    return body;
  }
  let current = body;
  const tokens = pointer.slice(1).split("/").map(decodePointerToken);
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
        throw new ModelRequestProvenanceError(
          `JSON Pointer ${pointer} contains an invalid array index`,
        );
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        throw new ModelRequestProvenanceError(
          `JSON Pointer ${pointer} does not resolve in the request body`,
        );
      }
      current = current[index];
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, token)
    ) {
      throw new ModelRequestProvenanceError(
        `JSON Pointer ${pointer} does not resolve in the request body`,
      );
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function resolvedPointers(
  body: Record<string, unknown>,
  pointers: readonly string[],
): readonly ResolvedPointer[] {
  const unique = [...new Set(pointers)].sort();
  if (unique.length !== pointers.length) {
    throw new ModelRequestProvenanceError(
      "A source manifest entry contains duplicate body pointers",
    );
  }
  return unique.map((pointer) => ({
    pointer,
    value: resolveJsonPointer(body, pointer),
  }));
}

function digestResolvedPointers(
  pointers: readonly ResolvedPointer[],
): { readonly contentHash: string; readonly sizeBytes: number } {
  const canonical = canonicalizeJson(pointers);
  return {
    contentHash: sha256Hex(canonical),
    sizeBytes: Buffer.byteLength(canonical, "utf8"),
  };
}

export function createModelSourceManifestEntry(
  body: Record<string, unknown>,
  input: NewModelSourceManifestEntry,
): ModelSourceManifestEntry {
  const parsed = modelSourceManifestEntrySchema
    .omit({ contentHash: true, sizeBytes: true })
    .parse(input);
  const digest = digestResolvedPointers(
    resolvedPointers(body, parsed.bodyPointers),
  );
  return modelSourceManifestEntrySchema.parse({ ...parsed, ...digest });
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectLeafPointers(value: unknown, pointer: string): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [pointer];
    }
    return value.flatMap((entry, index) =>
      collectLeafPointers(entry, `${pointer}/${String(index)}`),
    );
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) {
      return [pointer];
    }
    return keys.flatMap((key) =>
      collectLeafPointers(
        (value as Record<string, unknown>)[key],
        `${pointer}/${escapePointerToken(key)}`,
      ),
    );
  }
  return [pointer];
}

function pointerCoversLeaf(pointer: string, leaf: string): boolean {
  return pointer === "" || pointer === leaf || leaf.startsWith(`${pointer}/`);
}

function validateManifest(
  body: Record<string, unknown>,
  manifest: readonly ModelSourceManifestEntry[],
): void {
  const sourceIds = new Set<string>();
  const allPointers: string[] = [];
  for (const entry of manifest) {
    if (sourceIds.has(entry.sourceId)) {
      throw new ModelRequestProvenanceError(
        `Duplicate model source ID ${entry.sourceId}`,
      );
    }
    sourceIds.add(entry.sourceId);
    const pointers = resolvedPointers(body, entry.bodyPointers);
    const digest = digestResolvedPointers(pointers);
    if (
      digest.contentHash !== entry.contentHash ||
      digest.sizeBytes !== entry.sizeBytes
    ) {
      throw new ModelRequestProvenanceError(
        `Source manifest digest mismatch for ${entry.sourceId}`,
      );
    }
    allPointers.push(...entry.bodyPointers);
  }

  const uncovered = collectLeafPointers(body, "").filter(
    (leaf) => !allPointers.some((pointer) => pointerCoversLeaf(pointer, leaf)),
  );
  if (uncovered.length > 0) {
    throw new ModelRequestProvenanceError(
      `Model request body has content without provenance at ${uncovered[0]}`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function prepareModelRequestSnapshot(
  rawDraft: ModelRequestDraft,
): ModelRequestSnapshot {
  const parsed = modelRequestDraftSchema.parse(rawDraft);
  const canonicalBody = canonicalizeJson(parsed.body);
  const body = JSON.parse(canonicalBody) as Record<string, unknown>;
  const sourceManifest = [...parsed.sourceManifest].sort((left, right) =>
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
  );
  validateManifest(body, sourceManifest);
  const bodyHash = sha256Hex(canonicalBody);
  const withoutRequestHash = {
    ...parsed,
    body,
    sourceManifest,
    bodyHash,
  };
  const snapshot = modelRequestSnapshotSchema.parse({
    ...withoutRequestHash,
    requestHash: canonicalJsonSha256(withoutRequestHash),
  });
  return deepFreeze(snapshot);
}
