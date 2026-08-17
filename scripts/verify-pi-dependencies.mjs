import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const workspaceRoot = process.cwd();
const piRoot = path.join(
  workspaceRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const nestedBraceRoot = path.join(
  piRoot,
  "node_modules",
  "brace-expansion",
);
const minimumSafeVersion = [5, 0, 8];

function readVersion(packageRoot) {
  return JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ).version;
}

function isSafe(version) {
  const parts = version.split(".").map((part) => Number(part));
  for (let index = 0; index < minimumSafeVersion.length; index += 1) {
    const actual = parts[index] ?? 0;
    const minimum = minimumSafeVersion[index];
    if (actual > minimum) return true;
    if (actual < minimum) return false;
  }
  return true;
}

if (existsSync(nestedBraceRoot)) {
  const nestedVersion = readVersion(nestedBraceRoot);
  if (!isSafe(nestedVersion)) {
    // pi-coding-agent 0.83.0 ships an npm shrinkwrap that pins 5.0.7 even
    // though minimatch accepts ^5.0.5. Remove only that generated nested copy
    // so Node resolves the root's exact, audited 5.0.9 dependency.
    rmSync(nestedBraceRoot, { recursive: true, force: true });
  }
}

const minimatchRequire = createRequire(
  path.join(piRoot, "node_modules", "minimatch", "package.json"),
);
const resolvedManifest = minimatchRequire.resolve(
  "brace-expansion/package.json",
);
const resolvedVersion = JSON.parse(
  readFileSync(resolvedManifest, "utf8"),
).version;

if (!isSafe(resolvedVersion)) {
  throw new Error(
    `Pi resolved vulnerable brace-expansion ${resolvedVersion}; expected >=5.0.8`,
  );
}
