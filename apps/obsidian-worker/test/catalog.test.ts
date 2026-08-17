import { openControlDatabase, createControlRepositories } from "@private-fund/db";
import { describe, expect, it } from "vitest";

import { SqliteObsidianProjectCatalog } from "../src/catalog.js";

describe("SqliteObsidianProjectCatalog", () => {
  it("enumerates every project with its owning tenant namespace", () => {
    const database = openControlDatabase(":memory:");
    try {
      const repositories = createControlRepositories(database);
      repositories.users.create({
        id: "tenant-a",
        dataNamespace: "00000000-0000-4000-8000-000000000001",
      });
      repositories.users.create({
        id: "tenant-b",
        dataNamespace: "00000000-0000-4000-8000-000000000002",
      });
      repositories.projects.createForTenant(
        "00000000-0000-4000-8000-000000000001",
        { id: "project-a", name: "Alpha" },
      );
      repositories.projects.createForTenant(
        "00000000-0000-4000-8000-000000000002",
        { id: "project-b", name: "Beta" },
      );

      expect(
        new SqliteObsidianProjectCatalog(database).listProjects(),
      ).toEqual([
        {
          tenantId: "tenant-a",
          tenantNamespace: "00000000-0000-4000-8000-000000000001",
          projectId: "project-a",
          datasetId: "project-a",
        },
        {
          tenantId: "tenant-b",
          tenantNamespace: "00000000-0000-4000-8000-000000000002",
          projectId: "project-b",
          datasetId: "project-b",
        },
      ]);
    } finally {
      database.close();
    }
  });
});
