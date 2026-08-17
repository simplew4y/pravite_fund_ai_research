import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
  ConflictError,
  DomainError,
  assertPathWithin,
} from "@private-fund/core";

export interface OpenedFileResource {
  readonly handle: FileHandle;
  readonly absolutePath: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly etag: string;
  readonly lastModified: string;
}

export interface OpenSecureProjectFileOptions {
  readonly filename?: string;
  readonly mimeType?: string | null;
  readonly expectedSize?: number;
  readonly expectedSha256?: string;
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export async function writeNewOrIdenticalProjectFile(
  projectRoot: string,
  relativePath: string,
  contents: Uint8Array,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new DomainError(
      "Generated file path must be project-relative",
      "invalid_generated_path",
      400,
    );
  }
  const destination = assertPathWithin(
    path.resolve(projectRoot, relativePath),
    projectRoot,
  );
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [realRoot, realDirectory] = await Promise.all([
    realpath(projectRoot),
    realpath(directory),
  ]);
  assertPathWithin(realDirectory, realRoot);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < contents.byteLength) {
      const result = await handle.write(
        contents,
        offset,
        contents.byteLength - offset,
        null,
      );
      if (result.bytesWritten === 0) {
        throw new Error("Generated file writer made no progress");
      }
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const details = await lstat(destination).catch(() => null);
    if (
      details === null ||
      !details.isFile() ||
      details.isSymbolicLink()
    ) {
      throw new ConflictError(
        "Generated file destination is not a regular file",
        "generated_file_conflict",
      );
    }
    const existing = await readFile(destination);
    if (!existing.equals(Buffer.from(contents))) {
      throw new ConflictError(
        "Generated file already exists with different content",
        "generated_file_conflict",
      );
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return destination;
}

export async function openSecureProjectFile(
  projectRoot: string,
  storedPath: string,
  options: OpenSecureProjectFileOptions = {},
): Promise<OpenedFileResource> {
  if (!storedPath.trim()) {
    throw new DomainError(
      "Stored file path is empty",
      "file_not_found",
      404,
    );
  }
  const unresolvedCandidate = path.isAbsolute(storedPath)
    ? path.resolve(storedPath)
    : path.resolve(projectRoot, storedPath);
  const realRoot = await realpath(projectRoot);
  let lexicalCandidate: string;
  try {
    lexicalCandidate = assertPathWithin(unresolvedCandidate, projectRoot);
  } catch (logicalRootError) {
    // On macOS, a caller may retain the logical /tmp path while SQLite has
    // persisted the equivalent /private/tmp path. Accept that alias only when
    // the candidate is still lexically contained by the canonical project
    // root; a genuine traversal continues to surface the original denial.
    try {
      lexicalCandidate = assertPathWithin(unresolvedCandidate, realRoot);
    } catch {
      throw logicalRootError;
    }
  }
  const lexicalDetails = await lstat(lexicalCandidate).catch(() => null);
  if (
    lexicalDetails === null ||
    !lexicalDetails.isFile() ||
    lexicalDetails.isSymbolicLink()
  ) {
    throw new DomainError(
      "Stored file is not a regular file",
      "file_not_found",
      404,
    );
  }

  const realCandidate = await realpath(lexicalCandidate);
  assertPathWithin(realCandidate, realRoot);
  const handle = await open(realCandidate, "r");
  try {
    const before = await handle.stat();
    assertRegularStableFile(before, lexicalDetails);
    if (
      options.expectedSize !== undefined &&
      before.size !== options.expectedSize
    ) {
      throw new DomainError(
        "Stored file size no longer matches its registered version",
        "file_integrity_mismatch",
        409,
      );
    }
    const sha256 = await hashHandle(handle, before.size);
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new DomainError(
        "Stored file changed while it was being verified",
        "file_integrity_mismatch",
        409,
      );
    }
    if (
      options.expectedSha256 !== undefined &&
      sha256 !== options.expectedSha256.toLowerCase()
    ) {
      throw new DomainError(
        "Stored file checksum no longer matches its registered version",
        "file_integrity_mismatch",
        409,
      );
    }
    const filename = safeDownloadFilename(
      options.filename ?? path.basename(realCandidate),
    );
    return {
      handle,
      absolutePath: realCandidate,
      filename,
      mimeType:
        options.mimeType?.trim() ||
        mimeTypeForFilename(filename),
      size: before.size,
      sha256,
      etag: `"sha256-${sha256}"`,
      lastModified: before.mtime.toUTCString(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function parseSingleByteRange(
  header: string | undefined,
  size: number,
): ByteRange | null {
  if (header === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("size must be a non-negative safe integer");
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null || header.includes(",")) {
    throw unsatisfiableRange();
  }
  if (size === 0) {
    throw unsatisfiableRange();
  }
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart.length === 0 && rawEnd.length === 0) {
    throw unsatisfiableRange();
  }

  if (rawStart.length === 0) {
    const suffixLength = parseRangeInteger(rawEnd);
    if (suffixLength <= 0) {
      throw unsatisfiableRange();
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = parseRangeInteger(rawStart);
  if (start >= size) {
    throw unsatisfiableRange();
  }
  const end =
    rawEnd.length === 0
      ? size - 1
      : Math.min(parseRangeInteger(rawEnd), size - 1);
  if (end < start) {
    throw unsatisfiableRange();
  }
  return { start, end };
}

export function contentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
): string {
  const normalized = safeDownloadFilename(filename);
  const fallback = normalized
    .replace(/[^\x20-\x7e]/gu, "_")
    .replaceAll("\\", "_")
    .replaceAll('"', "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(
    normalized,
  )}`;
}

export function mimeTypeForFilename(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xlsm":
      return "application/vnd.ms-excel.sheet.macroEnabled.12";
    case ".xltx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.template";
    case ".xltm":
      return "application/vnd.ms-excel.template.macroEnabled.12";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

function assertRegularStableFile(
  opened: Stats,
  lexical: Stats,
): void {
  if (
    !opened.isFile() ||
    opened.dev !== lexical.dev ||
    opened.ino !== lexical.ino
  ) {
    throw new DomainError(
      "Stored file changed during secure open",
      "file_integrity_mismatch",
      409,
    );
  }
}

async function hashHandle(
  handle: FileHandle,
  size: number,
): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(128 * 1024);
  let position = 0;
  while (position < size) {
    const requested = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      requested,
      position,
    );
    if (bytesRead === 0) {
      throw new DomainError(
        "Stored file ended while it was being verified",
        "file_integrity_mismatch",
        409,
      );
    }
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

function parseRangeInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw unsatisfiableRange();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw unsatisfiableRange();
  }
  return parsed;
}

function unsatisfiableRange(): DomainError {
  return new DomainError(
    "Requested byte range is not satisfiable",
    "range_not_satisfiable",
    416,
  );
}

function safeDownloadFilename(value: string): string {
  const basename = path.basename(value.normalize("NFKC").trim());
  const normalized = basename
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .slice(0, 1_000);
  return normalized && normalized !== "." && normalized !== ".."
    ? normalized
    : "download";
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
