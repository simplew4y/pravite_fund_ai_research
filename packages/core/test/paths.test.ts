import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertPathWithin,
  ensureDirectoryWithin,
} from "../src/index.js";

describe("tenant path boundaries", () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "pf-core-paths-"));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("returns a logical path after validating the real directory", async () => {
    const tenantRoot = path.join(temporaryRoot, "tenant");
    const candidate = path.join(tenantRoot, "projects", "project-1");
    const result = await ensureDirectoryWithin(candidate, tenantRoot);
    expect(result).toBe(path.resolve(candidate));
  });

  it("rejects lexical and symlink escapes", async () => {
    const tenantRoot = path.join(temporaryRoot, "tenant");
    const outside = path.join(temporaryRoot, "outside");
    await Promise.all([
      mkdir(tenantRoot, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    expect(() =>
      assertPathWithin(path.join(tenantRoot, "..", "outside"), tenantRoot),
    ).toThrowError(/escapes/);

    const link = path.join(tenantRoot, "linked");
    await symlink(outside, link, "dir");
    await expect(
      ensureDirectoryWithin(path.join(link, "artifact"), tenantRoot),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
