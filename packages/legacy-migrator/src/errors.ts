export type LegacyMigrationErrorCode =
  | "invalid_config"
  | "mapping_required"
  | "path_boundary"
  | "legacy_schema"
  | "source_conflict"
  | "destination_conflict"
  | "reconciliation_failed";

export class LegacyMigrationError extends Error {
  public constructor(
    message: string,
    public readonly code: LegacyMigrationErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LegacyMigrationError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
