import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { ForbiddenError } from "./errors.js";

export function assertPathWithin(candidate: string, root: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ForbiddenError("Path escapes the tenant boundary");
  }
  return resolvedCandidate;
}

export async function ensureDirectoryWithin(candidate: string, root: string): Promise<string> {
  const safe = assertPathWithin(candidate, root);
  await mkdir(safe, { recursive: true, mode: 0o700 });
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(safe)]);
  assertPathWithin(realCandidate, realRoot);
  // Return the normalized logical path. Returning the real path makes a later
  // comparison against the logical root fail on platforms where /var (or a
  // workspace mount) is itself a symlink, even though the escape check above
  // already succeeded.
  return safe;
}
