import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { LegacyMigrationError } from "./errors.js";

function normalized(value: string): string {
  return path.resolve(value);
}

/**
 * Canonicalize the existing prefix without creating the missing suffix. This
 * handles platform aliases such as macOS /var -> /private/var while preserving
 * dry-run's zero-write guarantee.
 */
export function resolveThroughExistingAncestor(value: string): string {
  let cursor = normalized(value);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.push(path.basename(cursor));
    cursor = parent;
  }
  const canonical = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return path.resolve(canonical, ...suffix.reverse());
}

export function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(normalized(root), normalized(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function requireExistingRoot(value: string, label: string): string {
  if (!value.trim()) {
    throw new LegacyMigrationError(`${label} is required`, "invalid_config");
  }
  const lexical = normalized(value);
  if (!existsSync(lexical)) {
    throw new LegacyMigrationError(`${label} does not exist: ${lexical}`, "invalid_config");
  }
  const real = realpathSync(lexical);
  if (!lstatSync(real).isDirectory()) {
    throw new LegacyMigrationError(`${label} is not a directory: ${real}`, "invalid_config");
  }
  return real;
}

export function requireExistingPathWithin(
  value: string,
  root: string,
  label: string,
): string {
  const lexical = normalized(value);
  if (!isPathWithin(lexical, root)) {
    throw new LegacyMigrationError(
      `${label} escapes the configured legacy root: ${lexical}`,
      "path_boundary",
    );
  }
  if (!existsSync(lexical)) {
    throw new LegacyMigrationError(`${label} does not exist: ${lexical}`, "invalid_config");
  }
  const real = realpathSync(lexical);
  if (!isPathWithin(real, root)) {
    throw new LegacyMigrationError(
      `${label} resolves outside the configured legacy root: ${real}`,
      "path_boundary",
    );
  }
  return real;
}

export function requireDestinationPathWithin(
  value: string,
  destinationRoot: string,
  label: string,
): string {
  const resolved = resolveThroughExistingAncestor(value);
  const canonicalRoot = resolveThroughExistingAncestor(destinationRoot);
  if (!isPathWithin(resolved, canonicalRoot)) {
    throw new LegacyMigrationError(
      `${label} escapes the destination data root: ${resolved}`,
      "path_boundary",
    );
  }
  return resolved;
}

export function prepareDestinationDirectory(
  value: string,
  destinationRoot: string,
): string {
  const resolved = requireDestinationPathWithin(
    value,
    destinationRoot,
    "destination directory",
  );
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const real = realpathSync(resolved);
  if (!isPathWithin(real, destinationRoot)) {
    throw new LegacyMigrationError(
      `Destination directory resolves outside data root: ${real}`,
      "path_boundary",
    );
  }
  return real;
}

export function safeComponent(value: string): string {
  const normalizedValue = value.normalize("NFKC").replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  const compact = normalizedValue.replaceAll(/_+/gu, "_").replaceAll(/^\.+|\.+$/gu, "");
  return (compact || "legacy").slice(0, 120);
}
