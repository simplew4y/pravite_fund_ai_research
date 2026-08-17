import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  openProjectDatabase,
} from "@private-fund/research-store";
import { createWorkflowStore } from "@private-fund/workflow-store";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);
const OWNER_NAMESPACE = "00000000-0000-4000-8000-000000000091";
const OTHER_NAMESPACE = "00000000-0000-4000-8000-000000000092";
const timestamp = "2026-07-31T00:00:00.000Z";

function configFor(
  dataRoot: string,
  userId: string,
  dataNamespace: string,
): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 6768,
    dataRoot,
    controlDatabase: path.join(dataRoot, "control.sqlite3"),
    auth: {
      mode: "development",
      userId,
      dataNamespace,
    },
    agentWorkerEntry: WORKER_ENTRY,
  };
}

describe("migrated valuation model overview", () => {
  let owner: ApiRuntime | undefined;
  let other: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await other?.close();
    await owner?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("returns every stored overview field and HTML only to the owning tenant", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-overview-migration-"));
    owner = await createApiRuntime(
      configFor(dataRoot, "overview-owner", OWNER_NAMESPACE),
    );
    other = await createApiRuntime(
      configFor(dataRoot, "overview-other", OTHER_NAMESPACE),
    );

    const projectResponse = await owner.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Migrated overview project" },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();
    const projectRoot = path.join(
      dataRoot,
      "users",
      OWNER_NAMESPACE,
      "projects",
      project.id,
    );
    const database = openProjectDatabase({
      projectRoot,
      databasePath: path.join("data", "research.sqlite3"),
    });
    const workflow = createWorkflowStore(database.connection);
    const series = workflow.valuation.upsertSeries({
      datasetId: project.id,
      seriesKey: "migrated-dcf",
      name: "Migrated DCF",
      companyName: "Migrated Holdings",
      companyTicker: "MIG",
      modelType: "dcf",
    });
    const version = workflow.valuation.saveModelVersion({
      datasetId: project.id,
      seriesId: series.seriesId,
      docId: "document-overview",
      documentVersionNo: 2,
      checksum: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      originalFilename: "migrated-dcf.xlsx",
      documentDate: "2026-06-30",
      modelType: "dcf",
      nodeCount: 2,
      formulaNodeCount: 1,
      analyzerVersion: "valuation-tracking-v1",
    }).value;
    const storedOverview = {
      schema_version: 1,
      model_name: "Migrated DCF",
      summary: {
        detected_statements: ["income_statement"],
        missing_statements: ["cash_flow"],
        statement_count: 1,
        quality_flags: ["legacy_migrated"],
      },
      statements: [
        {
          statement_type: "income_statement",
          title: "Income statement",
          periods: ["2025FY", "2026FY"],
          rows: [
            {
              metric_key: "revenue",
              metric_name: "Revenue",
              values: [100, 120],
            },
          ],
        },
      ],
    };
    const html =
      "<!DOCTYPE html><html><body><h1>Migrated DCF</h1></body></html>";
    database.connection
      .prepare(
        `INSERT INTO valuation_model_overviews(
           overview_id, dataset_id, series_id, model_version_id, doc_id,
           status, overview_json, html, overview_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "overview-migrated-v1",
        project.id,
        series.seriesId,
        version.modelVersionId,
        version.docId,
        "completed",
        JSON.stringify(storedOverview),
        html,
        "legacy-overview-v1",
        timestamp,
      );
    database.close();

    const url =
      `/v1/projects/${project.id}/valuation/series/${series.seriesId}` +
      `/versions/${version.modelVersionId}`;
    const response = await owner.app.inject({ method: "GET", url });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      series: {
        seriesId: series.seriesId,
        datasetId: project.id,
      },
      version: {
        modelVersionId: version.modelVersionId,
        docId: version.docId,
      },
      materializedOverview: {
        overviewId: "overview-migrated-v1",
        datasetId: project.id,
        seriesId: series.seriesId,
        modelVersionId: version.modelVersionId,
        docId: version.docId,
        status: "completed",
        overview: storedOverview,
        html,
        overviewVersion: "legacy-overview-v1",
        createdAt: timestamp,
      },
    });

    const crossTenant = await other.app.inject({ method: "GET", url });
    expect(crossTenant.statusCode, crossTenant.body).toBe(404);
    expect(crossTenant.json()).toMatchObject({ error: "not_found" });
  });
});
