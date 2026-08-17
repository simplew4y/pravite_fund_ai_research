import { readFileSync } from "node:fs";

import type { BaselineCoverage } from "./types.js";
import { LegacyMigrationError } from "./errors.js";
import { sha256 } from "./stable.js";

interface LegacyBaseline {
  readonly schemaVersion?: unknown;
  readonly tables?: unknown;
}

export function loadBaseline(
  filename: string,
  nativeWorkflowTables: ReadonlySet<string>,
): BaselineCoverage {
  const source = readFileSync(filename);
  let value: LegacyBaseline;
  try {
    value = JSON.parse(source.toString("utf8")) as LegacyBaseline;
  } catch (error) {
    throw new LegacyMigrationError(
      `Legacy baseline is not valid JSON: ${filename}`,
      "legacy_schema",
      { cause: error },
    );
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.tables)) {
    throw new LegacyMigrationError(
      "Legacy baseline must have schemaVersion 1 and a tables array",
      "legacy_schema",
    );
  }
  const declaredTables = value.tables
    .map((item) =>
      item !== null && typeof item === "object" && "name" in item
        ? String((item as { name: unknown }).name)
        : "",
    )
    .filter(Boolean)
    .sort();
  for (const required of [
    "research_items",
    "valuation_model_series",
    "research_workflows",
    "obsidian_sync_outbox",
  ]) {
    if (!declaredTables.includes(required)) {
      throw new LegacyMigrationError(
        `Legacy baseline is missing required table ${required}`,
        "legacy_schema",
      );
    }
  }
  return {
    schemaVersion: 1,
    sha256: sha256(source),
    declaredTables,
    nativeWorkflowTables: declaredTables.filter((table) =>
      nativeWorkflowTables.has(table),
    ),
    preservedWorkflowTables: declaredTables.filter(
      (table) => table !== "IF" && !nativeWorkflowTables.has(table),
    ),
  };
}
