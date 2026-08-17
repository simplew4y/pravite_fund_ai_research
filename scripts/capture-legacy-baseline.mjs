import {
  createHash,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const outputFile = path.join(
  workspaceRoot,
  "docs",
  "legacy_migration_baseline.json",
);

const routeSources = [
  {
    file: "omnigent/omnigent/server/routes/cloud_accounts.py",
    mountPrefix: "",
  },
  {
    file: "omnigent/omnigent/server/routes/private_fund_pdf.py",
    mountPrefix: "/v1",
  },
  {
    file: "omnigent/omnigent/server/routes/private_fund_llm_config.py",
    mountPrefix: "/v1",
  },
  {
    file: "omnigent/omnigent/server/routes/sessions.py",
    mountPrefix: "/v1",
  },
  {
    file: "omnigent/omnigent/runner/app.py",
    mountPrefix: "",
  },
];

const schemaSources = [
  "omnigent/omnigent/db/utils.py",
  "omnigent/omnigent/server/private_fund_obsidian.py",
  "omnigent/omnigent/server/private_fund_source_folders.py",
  "omnigent/omnigent/server/private_fund_tracking.py",
  "omnigent/omnigent/server/private_fund_valuation_impact_agent.py",
  "omnigent/omnigent/server/private_fund_valuation_metric_agent.py",
  "omnigent/omnigent/server/private_fund_valuation_metrics.py",
  "omnigent/omnigent/server/private_fund_valuation_tracking.py",
  "omnigent/omnigent/server/private_fund_workflow.py",
];

function source(relativePath) {
  return readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

function normalizeRoute(prefix, declaredPath) {
  const left = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const right = declaredPath.startsWith("/")
    ? declaredPath
    : `/${declaredPath}`;
  return `${left}${right}` || "/";
}

function extractRoutes(entry) {
  const contents = source(entry.file);
  const pattern =
    /@(app|router)\.(get|post|put|patch|delete)\(\s*(["'])(.*?)\3/gms;
  const routes = [];
  for (const match of contents.matchAll(pattern)) {
    const declaredPath = match[4];
    if (declaredPath === undefined) continue;
    routes.push({
      method: match[2].toUpperCase(),
      path: normalizeRoute(entry.mountPrefix, declaredPath),
      declaredPath,
      source: entry.file,
    });
  }
  return routes;
}

function extractTables(relativePath) {
  const contents = source(relativePath);
  const pattern =
    /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  return [...contents.matchAll(pattern)].map((match) => ({
    name: match[1],
    source: relativePath,
  }));
}

function fileHash(relativePath) {
  return createHash("sha256")
    .update(source(relativePath))
    .digest("hex");
}

const routes = routeSources
  .flatMap(extractRoutes)
  .sort((left, right) =>
    `${left.path}:${left.method}`.localeCompare(
      `${right.path}:${right.method}`,
    ),
  );
const tables = schemaSources
  .flatMap(extractTables)
  .filter(
    (entry, index, rows) =>
      rows.findIndex((row) => row.name === entry.name) === index,
  )
  .sort((left, right) => left.name.localeCompare(right.name));
const hashes = Object.fromEntries(
  [...new Set([
    ...routeSources.map((entry) => entry.file),
    ...schemaSources,
  ])]
    .sort()
    .map((relativePath) => [relativePath, fileHash(relativePath)]),
);

const manifest = {
  schemaVersion: 1,
  scope:
    "Cloud account, private-fund product, session control and project database migration baseline",
  routes,
  tables,
  sourceSha256: hashes,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes("--write")) {
  writeFileSync(outputFile, serialized, "utf8");
} else if (process.argv.includes("--check")) {
  const existing = readFileSync(outputFile, "utf8");
  if (existing !== serialized) {
    throw new Error(
      "Legacy baseline changed; review the source diff and rerun with --write",
    );
  }
} else {
  process.stdout.write(serialized);
}
