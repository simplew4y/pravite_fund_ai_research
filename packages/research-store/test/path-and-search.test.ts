import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ForbiddenError } from "@private-fund/core";

import {
  createResearchStore,
  openInMemoryProjectDatabase,
  openProjectDatabase,
  resolveProjectDatabasePath,
  type ProjectDatabase,
} from "../src/index.js";

describe("project path isolation and evidence search", () => {
  const temporaryDirectories: string[] = [];
  const openDatabases: ProjectDatabase[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) {
      database.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects cross-project and symlink database paths", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "research-store-path-"));
    temporaryDirectories.push(parent);
    const projectA = path.join(parent, "project-a");
    const projectB = path.join(parent, "project-b");
    mkdirSync(projectA);
    mkdirSync(projectB);

    expect(() =>
      resolveProjectDatabasePath(
        projectA,
        path.join(projectB, "project.sqlite"),
      ),
    ).toThrow(ForbiddenError);
    expect(
      resolveProjectDatabasePath(projectA, "data/project.sqlite"),
    ).toBe(
      path.join(realpathSync(projectA), "data", "project.sqlite"),
    );

    const link = path.join(projectA, "outside");
    symlinkSync(projectB, link, "dir");
    expect(() =>
      resolveProjectDatabasePath(projectA, "outside/project.sqlite"),
    ).toThrow(ForbiddenError);
  });

  it("also prevents document artifacts from escaping their project", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "research-store-artifact-"));
    temporaryDirectories.push(parent);
    const projectA = path.join(parent, "project-a");
    const projectB = path.join(parent, "project-b");
    mkdirSync(projectA);
    mkdirSync(projectB);
    const database = openProjectDatabase({
      projectRoot: projectA,
      databasePath: "data/project.sqlite",
    });
    openDatabases.push(database);
    const store = createResearchStore(database);

    expect(() =>
      store.documents.registerVersion({
        sourceRelpath: "source.pdf",
        title: "Source",
        originalFilename: "source.pdf",
        storedPath: path.join(projectB, "raw", "source.pdf"),
        fileType: "pdf",
        sha256: "7".repeat(64),
        fileSize: 1,
      }),
    ).toThrow(ForbiddenError);
  });

  it("uses FTS5 when available and has a deterministic searchable fallback", () => {
    for (const preferredSearchBackend of ["auto", "deterministic"] as const) {
      const database = openInMemoryProjectDatabase({
        preferredSearchBackend,
      });
      openDatabases.push(database);
      const store = createResearchStore(database);
      const first = store.documents.registerVersion({
        sourceRelpath: `${preferredSearchBackend}/report.pdf`,
        title: "Report",
        originalFilename: "report.pdf",
        storedPath: "/tmp/report-v1.pdf",
        fileType: "pdf",
        sha256:
          preferredSearchBackend === "auto"
            ? "8".repeat(64)
            : "9".repeat(64),
        fileSize: 1,
      });
      store.evidence.put({
        evidenceId: `chunk:${preferredSearchBackend}-old`,
        kind: "chunk",
        documentVersionId: first.version.id,
        title: "Historical margin",
        originalText: "历史毛利率为 18%，historical margin was eighteen percent.",
        locator: { pageStart: 1 },
      });
      const second = store.documents.registerVersion({
        sourceRelpath: `${preferredSearchBackend}/report.pdf`,
        title: "Report",
        originalFilename: "report.pdf",
        storedPath: "/tmp/report-v2.pdf",
        fileType: "pdf",
        sha256:
          preferredSearchBackend === "auto"
            ? "a".repeat(64)
            : "b".repeat(64),
        fileSize: 1,
      });
      store.evidence.put({
        evidenceId: `chunk:${preferredSearchBackend}-current`,
        kind: "chunk",
        documentVersionId: second.version.id,
        title: "Current margin",
        originalText: "当前毛利率提升至 22%，current gross margin reached twenty two percent.",
        locator: { pageStart: 2 },
      });

      const current = store.evidence.search({
        query: "当前毛利率",
        limit: 1,
      });
      expect(current.total).toBe(1);
      expect(current.items[0]?.evidence.evidenceId).toBe(
        `chunk:${preferredSearchBackend}-current`,
      );
      const historical = store.evidence.search({
        query: "historical margin",
        includeHistorical: true,
      });
      expect(historical.items[0]?.evidence.evidenceId).toBe(
        `chunk:${preferredSearchBackend}-old`,
      );
      if (preferredSearchBackend === "deterministic") {
        expect(database.searchBackend).toBe("deterministic");
      } else {
        expect([
          "fts5-trigram",
          "fts5-unicode61",
          "deterministic",
        ]).toContain(database.searchBackend);
      }
    }
  });
});
