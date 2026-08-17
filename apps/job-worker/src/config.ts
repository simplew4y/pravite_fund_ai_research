import path from "node:path";

export interface JobWorkerConfig {
  readonly dataRoot: string;
  readonly controlDatabase: string;
  readonly pythonExecutable: string;
  readonly computeWorkerEntry: string;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly computeTimeoutMs: number;
  readonly projectionMaxRecordsBytes: number;
  readonly projectionMaxLineBytes: number;
  readonly projectionMaxRecords: number;
  readonly businessMaxEvidenceRecords: number;
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadJobWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): JobWorkerConfig {
  const dataRoot = path.resolve(
    workingDirectory,
    environment.PRIVATE_FUND_DATA_ROOT ?? "output/ts-platform",
  );
  return {
    dataRoot,
    controlDatabase: path.resolve(
      workingDirectory,
      environment.PRIVATE_FUND_CONTROL_DB ??
        path.join(dataRoot, "control.sqlite3"),
    ),
    pythonExecutable:
      environment.PRIVATE_FUND_PYTHON_EXECUTABLE ?? "python3",
    computeWorkerEntry: path.resolve(
      workingDirectory,
      environment.PRIVATE_FUND_COMPUTE_WORKER_ENTRY ??
        "python/compute-worker/worker.py",
    ),
    pollIntervalMs: positiveInteger(
      environment,
      "PRIVATE_FUND_JOB_POLL_INTERVAL_MS",
      1_000,
    ),
    leaseDurationMs: positiveInteger(
      environment,
      "PRIVATE_FUND_JOB_LEASE_DURATION_MS",
      60_000,
    ),
    computeTimeoutMs: positiveInteger(
      environment,
      "PRIVATE_FUND_COMPUTE_TIMEOUT_MS",
      5 * 60_000,
    ),
    projectionMaxRecordsBytes: positiveInteger(
      environment,
      "PRIVATE_FUND_PROJECTION_MAX_RECORDS_BYTES",
      256 * 1024 * 1024,
    ),
    projectionMaxLineBytes: positiveInteger(
      environment,
      "PRIVATE_FUND_PROJECTION_MAX_LINE_BYTES",
      8 * 1024 * 1024,
    ),
    projectionMaxRecords: positiveInteger(
      environment,
      "PRIVATE_FUND_PROJECTION_MAX_RECORDS",
      2_000_000,
    ),
    businessMaxEvidenceRecords: positiveInteger(
      environment,
      "PRIVATE_FUND_BUSINESS_MAX_EVIDENCE_RECORDS",
      50_000,
    ),
  };
}
