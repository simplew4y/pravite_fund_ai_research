import {
  copyFileSync,
  existsSync,
  linkSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { LegacyMigrationError } from "./errors.js";
import {
  isPathWithin,
  prepareDestinationDirectory,
} from "./path-policy.js";
import { sha256File, type LegacyFilePlan } from "./source.js";
import type { FileReconciliation } from "./types.js";

export function preflightFiles(
  plans: readonly LegacyFilePlan[],
): readonly FileReconciliation[] {
  return plans.map((plan) => {
    if (
      plan.sourcePath === null ||
      plan.destinationPath === null ||
      plan.sha256 === null
    ) {
      return { ...plan, status: "metadata-only" };
    }
    if (!existsSync(plan.destinationPath)) {
      return { ...plan, status: "planned" };
    }
    if (sha256File(plan.destinationPath) !== plan.sha256) {
      throw new LegacyMigrationError(
        `Existing destination file conflicts with ${plan.legacyDocumentVersionId}`,
        "destination_conflict",
      );
    }
    return { ...plan, status: "already-present" };
  });
}

export function migrateFiles(
  plans: readonly LegacyFilePlan[],
  destinationProjectRoot: string,
  destinationDataRoot: string,
): readonly FileReconciliation[] {
  prepareDestinationDirectory(destinationProjectRoot, destinationDataRoot);
  const reports: FileReconciliation[] = [];
  for (const plan of plans) {
    if (
      plan.sourcePath === null ||
      plan.destinationPath === null ||
      plan.sha256 === null
    ) {
      reports.push({ ...plan, status: "metadata-only" });
      continue;
    }
    if (!isPathWithin(plan.destinationPath, destinationProjectRoot)) {
      throw new LegacyMigrationError(
        `Destination file escapes project root: ${plan.destinationPath}`,
        "path_boundary",
      );
    }
    const parent = prepareDestinationDirectory(
      path.dirname(plan.destinationPath),
      destinationDataRoot,
    );
    const target = path.join(parent, path.basename(plan.destinationPath));
    if (existsSync(target)) {
      const actual = sha256File(target);
      if (actual !== plan.sha256) {
        throw new LegacyMigrationError(
          `Existing destination file conflicts with ${plan.legacyDocumentVersionId}`,
          "destination_conflict",
        );
      }
      reports.push({ ...plan, destinationPath: target, status: "already-present" });
      continue;
    }
    const temporary = path.join(
      parent,
      `.${path.basename(target)}.migration-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      copyFileSync(plan.sourcePath, temporary, 0);
      if (sha256File(temporary) !== plan.sha256) {
        throw new LegacyMigrationError(
          `Copied file checksum mismatch for ${plan.legacyDocumentVersionId}`,
          "reconciliation_failed",
        );
      }
      try {
        linkSync(temporary, target);
      } catch (error) {
        if (
          !existsSync(target) ||
          sha256File(target) !== plan.sha256
        ) {
          throw new LegacyMigrationError(
            `Cannot publish migrated file ${target}`,
            "destination_conflict",
            { cause: error },
          );
        }
      }
    } finally {
      rmSync(temporary, { force: true });
    }
    reports.push({ ...plan, destinationPath: target, status: "copied" });
  }
  return reports;
}

export function reconcileFiles(
  plans: readonly LegacyFilePlan[],
): readonly FileReconciliation[] {
  return plans.map((plan) => {
    if (
      plan.sourcePath === null ||
      plan.destinationPath === null ||
      plan.sha256 === null
    ) {
      return { ...plan, status: "metadata-only" };
    }
    if (!existsSync(plan.destinationPath)) {
      throw new LegacyMigrationError(
        `Migrated file is missing: ${plan.destinationPath}`,
        "reconciliation_failed",
      );
    }
    const actual = sha256File(plan.destinationPath);
    if (actual !== plan.sha256) {
      throw new LegacyMigrationError(
        `Migrated file checksum changed: ${plan.destinationPath}`,
        "reconciliation_failed",
      );
    }
    return { ...plan, status: "already-present" };
  });
}
