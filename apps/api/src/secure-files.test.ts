import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  contentDisposition,
  openSecureProjectFile,
  parseSingleByteRange,
  writeNewOrIdenticalProjectFile,
} from "./secure-files.js";

describe("secure project files", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pf-secure-files-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("attests an in-project regular file and rejects traversal or symlinks", async () => {
    const contents = Buffer.from("0123456789", "utf8");
    const filename = path.join(root, "sources", "模型.txt");
    await writeFile(filename, contents);
    const expectedSha256 = createHash("sha256")
      .update(contents)
      .digest("hex");

    const opened = await openSecureProjectFile(
      root,
      "sources/模型.txt",
      {
        filename: "模型.txt",
        expectedSize: contents.byteLength,
        expectedSha256,
      },
    );
    expect(opened).toMatchObject({
      filename: "模型.txt",
      size: contents.byteLength,
      sha256: expectedSha256,
      mimeType: "text/plain; charset=utf-8",
    });
    await opened.handle.close();

    await expect(
      openSecureProjectFile(root, "../outside.txt"),
    ).rejects.toMatchObject({ code: "forbidden" });
    const outside = path.join(path.dirname(root), "outside-secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(root, "sources", "link.txt"));
    await expect(
      openSecureProjectFile(root, "sources/link.txt"),
    ).rejects.toMatchObject({ code: "file_not_found" });
    await rm(outside, { force: true });
  });

  it("supports only one satisfiable HTTP byte range", () => {
    expect(parseSingleByteRange(undefined, 10)).toBeNull();
    expect(parseSingleByteRange("bytes=2-5", 10)).toEqual({
      start: 2,
      end: 5,
    });
    expect(parseSingleByteRange("bytes=7-", 10)).toEqual({
      start: 7,
      end: 9,
    });
    expect(parseSingleByteRange("bytes=-3", 10)).toEqual({
      start: 7,
      end: 9,
    });
    expect(() => parseSingleByteRange("bytes=10-11", 10)).toThrowError(
      expect.objectContaining({ code: "range_not_satisfiable" }),
    );
    expect(() => parseSingleByteRange("bytes=0-1,4-5", 10)).toThrowError(
      expect.objectContaining({ code: "range_not_satisfiable" }),
    );
  });

  it("publishes generated inputs without overwriting different content", async () => {
    const relative = "artifacts/requests/market/request.json";
    const first = await writeNewOrIdenticalProjectFile(
      root,
      relative,
      Buffer.from('{"ticker":"600000"}\n'),
    );
    const second = await writeNewOrIdenticalProjectFile(
      root,
      relative,
      Buffer.from('{"ticker":"600000"}\n'),
    );
    expect(second).toBe(first);
    await expect(readFile(first, "utf8")).resolves.toBe(
      '{"ticker":"600000"}\n',
    );
    await expect(
      writeNewOrIdenticalProjectFile(
        root,
        relative,
        Buffer.from('{"ticker":"000001"}\n'),
      ),
    ).rejects.toMatchObject({ code: "generated_file_conflict" });
  });

  it("builds injection-safe RFC 5987 content disposition", () => {
    const header = contentDisposition(
      "attachment",
      '投资模型"\r\nx-evil: 1.xlsx',
    );
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(header).toContain("filename*=UTF-8''");
  });
});
