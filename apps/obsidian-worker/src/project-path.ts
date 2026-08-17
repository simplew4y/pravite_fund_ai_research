import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { CatalogProject } from "./catalog.js";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function safeSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 240 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f<>:"|?*]/u.test(value)
  ) {
    throw new Error(`${label} is not a safe filesystem segment`);
  }
  return value;
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function requireDirectory(target: string, label: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symbolic-link directory`);
  }
}

async function ensureChildDirectory(
  parent: string,
  segment: string,
  label: string,
): Promise<string> {
  const target = path.join(parent, safeSegment(segment, label));
  try {
    await requireDirectory(target, label);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (mkdirError) {
      if (
        typeof mkdirError !== "object" ||
        mkdirError === null ||
        !("code" in mkdirError) ||
        mkdirError.code !== "EEXIST"
      ) {
        throw mkdirError;
      }
    }
    await requireDirectory(target, label);
  }
  return target;
}

/**
 * Builds only fixed, validated path segments and rejects symlinks at every
 * tenant/project boundary before any SQLite database is opened.
 */
export async function ensureSecureProjectRoot(
  dataRoot: string,
  project: CatalogProject,
): Promise<string> {
  if (!path.isAbsolute(dataRoot)) {
    throw new Error("dataRoot must be absolute");
  }
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await requireDirectory(dataRoot, "dataRoot");
  const realDataRoot = await realpath(dataRoot);
  let current = await ensureChildDirectory(dataRoot, "users", "users root");
  current = await ensureChildDirectory(
    current,
    project.tenantNamespace,
    "tenant namespace",
  );
  current = await ensureChildDirectory(current, "projects", "projects root");
  current = await ensureChildDirectory(
    current,
    project.projectId,
    "project ID",
  );
  const realProjectRoot = await realpath(current);
  if (!pathIsWithin(realProjectRoot, realDataRoot)) {
    throw new Error("Project root resolves outside dataRoot");
  }
  return realProjectRoot;
}
