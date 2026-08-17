import { createHash } from "node:crypto";

import { canonicalJsonSha256, canonicalizeJson } from "./canonical-json.js";

export const ROLLOUT_CONFIG_SCHEMA_VERSION = 1 as const;
export const ROLLOUT_BUCKET_COUNT = 10_000 as const;

export type RolloutMode = "legacy" | "new" | "shadow";
export type RolloutStickiness = "tenant" | "session";
export type RolloutWriter = "legacy" | "new";

export interface RolloutConfigV1 {
  readonly schemaVersion: typeof ROLLOUT_CONFIG_SCHEMA_VERSION;
  readonly capability: string;
  readonly mode: RolloutMode;
  /** Integer percentage in the inclusive range 0..100. */
  readonly percentage: number;
  readonly stickiness: RolloutStickiness;
  readonly owner: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly killSwitch: boolean;
}

export type RolloutDiagnosticSeverity = "info" | "warning" | "error";

export type RolloutDiagnosticCode =
  | "config_missing"
  | "config_not_object"
  | "config_unknown_field"
  | "config_missing_field"
  | "config_unknown_schema"
  | "config_capability_invalid"
  | "config_owner_invalid"
  | "config_unknown_mode"
  | "config_invalid_percentage"
  | "config_unknown_stickiness"
  | "config_timestamp_invalid"
  | "config_invalid_lifetime"
  | "config_kill_switch_invalid"
  | "config_capability_mismatch"
  | "config_not_active"
  | "config_expired"
  | "evaluation_context_invalid"
  | "session_id_required"
  | "candidate_unavailable"
  | "kill_switch_active"
  | "cohort_not_selected"
  | "active_turn_pin_applied"
  | "active_turn_pin_invalid";

export interface RolloutDiagnostic {
  readonly code: RolloutDiagnosticCode;
  readonly severity: RolloutDiagnosticSeverity;
  readonly message: string;
}

export type RolloutConfigParseResult =
  | {
      readonly ok: true;
      readonly config: RolloutConfigV1;
      readonly fingerprint: string;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly RolloutDiagnostic[];
    };

export interface RolloutEvaluationContext {
  readonly capability: string;
  readonly tenantId: string;
  readonly sessionId?: string;
  readonly activeTurnId?: string;
}

export interface RolloutCohortContext {
  readonly capability: string;
  readonly tenantId: string;
  readonly sessionId?: string;
  readonly stickiness: RolloutStickiness;
}

export interface ShadowExecutionPolicy {
  readonly readOnly: true;
  readonly noSideEffects: true;
  readonly primary: "legacy";
  readonly candidate: "new";
}

export const SHADOW_EXECUTION_POLICY: ShadowExecutionPolicy = Object.freeze({
  readOnly: true,
  noSideEffects: true,
  primary: "legacy",
  candidate: "new",
});

export interface ActiveTurnRolloutPin {
  readonly schemaVersion: typeof ROLLOUT_CONFIG_SCHEMA_VERSION;
  readonly capability: string;
  readonly tenantId: string;
  readonly sessionId: string | null;
  readonly turnId: string;
  readonly mode: RolloutMode;
  readonly writer: RolloutWriter;
  readonly shadow: ShadowExecutionPolicy | null;
  readonly percentage: number;
  readonly cohortBucket: number | null;
  readonly configFingerprint: string | null;
}

export type RolloutDecisionSource =
  | "config"
  | "safe_default"
  | "active_turn_pin"
  | "kill_switch";

interface RolloutDecisionBase {
  readonly capability: string;
  readonly source: RolloutDecisionSource;
  readonly percentage: number;
  /** Stable integer bucket in the range 0..9999, or null if not evaluated. */
  readonly cohortBucket: number | null;
  readonly configFingerprint: string | null;
  readonly diagnostics: readonly RolloutDiagnostic[];
  readonly activeTurnPin: ActiveTurnRolloutPin | null;
}

export type RolloutDecision =
  | (RolloutDecisionBase & {
      readonly mode: "legacy";
      readonly writer: "legacy";
      readonly shadow: null;
    })
  | (RolloutDecisionBase & {
      readonly mode: "new";
      readonly writer: "new";
      readonly shadow: null;
    })
  | (RolloutDecisionBase & {
      readonly mode: "shadow";
      readonly writer: "legacy";
      readonly shadow: ShadowExecutionPolicy;
    });

export interface DecideRolloutInput {
  readonly context: RolloutEvaluationContext;
  /** Untrusted configuration value, normally decoded from the server config source. */
  readonly config?: unknown;
  /**
   * Candidate readiness must be explicitly true before new or shadow is selected.
   * Omission therefore fails safely to Legacy.
   */
  readonly candidateAvailable?: boolean;
  /** Emergency monotonic override. It always wins, including over an active-turn pin. */
  readonly globalKillSwitch?: boolean;
  /** A pin previously returned by this module and kept in trusted server runtime state. */
  readonly activeTurnPin?: unknown;
  readonly now?: Date;
}

export interface SingleWriterAssertion {
  readonly mode: RolloutMode;
  readonly legacyWrites: boolean;
  readonly newWrites: boolean;
  readonly shadow: {
    readonly readOnly: boolean;
    readonly noSideEffects: boolean;
  } | null;
}

export class RolloutInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RolloutInvariantError";
  }
}

const CONFIG_FIELDS = Object.freeze([
  "schemaVersion",
  "capability",
  "mode",
  "percentage",
  "stickiness",
  "owner",
  "createdAt",
  "expiresAt",
  "killSwitch",
] as const);

const CONFIG_FIELD_SET = new Set<string>(CONFIG_FIELDS);
const PIN_FIELDS = Object.freeze([
  "schemaVersion",
  "capability",
  "tenantId",
  "sessionId",
  "turnId",
  "mode",
  "writer",
  "shadow",
  "percentage",
  "cohortBucket",
  "configFingerprint",
] as const);
const PIN_FIELD_SET = new Set<string>(PIN_FIELDS);
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function diagnostic(
  code: RolloutDiagnosticCode,
  severity: RolloutDiagnosticSeverity,
  message: string,
): RolloutDiagnostic {
  return Object.freeze({ code, severity, message });
}

function freezeDiagnostics(
  diagnostics: readonly RolloutDiagnostic[],
): readonly RolloutDiagnostic[] {
  return Object.freeze([...diagnostics]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedText(value: unknown, maximumLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !CONTROL_CHARACTER.test(value)
  );
}

function timestampMilliseconds(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function hasOnlyDataProperties(record: Record<string, unknown>): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(record);
  return Object.values(descriptors).every(
    (descriptor) => descriptor.get === undefined && descriptor.set === undefined,
  );
}

/**
 * Strictly parses one capability's rollout configuration. Unknown schema
 * versions, unknown fields and malformed values are rejected so callers can
 * deterministically fall back to Legacy instead of guessing intent.
 */
export function parseRolloutConfig(value: unknown): RolloutConfigParseResult {
  if (value === undefined || value === null) {
    return {
      ok: false,
      diagnostics: freezeDiagnostics([
        diagnostic(
          "config_missing",
          "warning",
          "Rollout configuration is missing; Legacy is required.",
        ),
      ]),
    };
  }

  try {
    if (!isPlainRecord(value) || !hasOnlyDataProperties(value)) {
      return {
        ok: false,
        diagnostics: freezeDiagnostics([
          diagnostic(
            "config_not_object",
            "error",
            "Rollout configuration must be a plain data object.",
          ),
        ]),
      };
    }

    const diagnostics: RolloutDiagnostic[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !CONFIG_FIELD_SET.has(key)) {
        diagnostics.push(
          diagnostic(
            "config_unknown_field",
            "error",
            "Rollout configuration contains an unknown field.",
          ),
        );
      }
    }
    for (const field of CONFIG_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        diagnostics.push(
          diagnostic(
            "config_missing_field",
            "error",
            `Rollout configuration is missing required field ${field}.`,
          ),
        );
      }
    }

    if (value.schemaVersion !== ROLLOUT_CONFIG_SCHEMA_VERSION) {
      diagnostics.push(
        diagnostic(
          "config_unknown_schema",
          "error",
          "Rollout configuration schema version is not supported.",
        ),
      );
    }
    if (!isBoundedText(value.capability)) {
      diagnostics.push(
        diagnostic(
          "config_capability_invalid",
          "error",
          "Rollout capability must be a non-empty bounded identifier.",
        ),
      );
    }
    if (!isBoundedText(value.owner)) {
      diagnostics.push(
        diagnostic(
          "config_owner_invalid",
          "error",
          "Rollout owner must be a non-empty bounded identifier.",
        ),
      );
    }
    if (
      value.mode !== "legacy" &&
      value.mode !== "new" &&
      value.mode !== "shadow"
    ) {
      diagnostics.push(
        diagnostic(
          "config_unknown_mode",
          "error",
          "Rollout mode is not supported.",
        ),
      );
    }
    if (
      typeof value.percentage !== "number" ||
      !Number.isInteger(value.percentage) ||
      value.percentage < 0 ||
      value.percentage > 100
    ) {
      diagnostics.push(
        diagnostic(
          "config_invalid_percentage",
          "error",
          "Rollout percentage must be an integer from 0 through 100.",
        ),
      );
    }
    if (value.stickiness !== "tenant" && value.stickiness !== "session") {
      diagnostics.push(
        diagnostic(
          "config_unknown_stickiness",
          "error",
          "Rollout stickiness must be tenant or session.",
        ),
      );
    }
    if (typeof value.killSwitch !== "boolean") {
      diagnostics.push(
        diagnostic(
          "config_kill_switch_invalid",
          "error",
          "Rollout killSwitch must be a boolean.",
        ),
      );
    }

    const createdAtMilliseconds = timestampMilliseconds(value.createdAt);
    const expiresAtMilliseconds = timestampMilliseconds(value.expiresAt);
    if (createdAtMilliseconds === null || expiresAtMilliseconds === null) {
      diagnostics.push(
        diagnostic(
          "config_timestamp_invalid",
          "error",
          "Rollout createdAt and expiresAt must be timezone-qualified ISO timestamps.",
        ),
      );
    } else if (expiresAtMilliseconds <= createdAtMilliseconds) {
      diagnostics.push(
        diagnostic(
          "config_invalid_lifetime",
          "error",
          "Rollout expiresAt must be later than createdAt.",
        ),
      );
    }

    if (diagnostics.length > 0) {
      return { ok: false, diagnostics: freezeDiagnostics(diagnostics) };
    }

    const config: RolloutConfigV1 = Object.freeze({
      schemaVersion: ROLLOUT_CONFIG_SCHEMA_VERSION,
      capability: value.capability as string,
      mode: value.mode as RolloutMode,
      percentage: value.percentage as number,
      stickiness: value.stickiness as RolloutStickiness,
      owner: value.owner as string,
      createdAt: value.createdAt as string,
      expiresAt: value.expiresAt as string,
      killSwitch: value.killSwitch as boolean,
    });
    return {
      ok: true,
      config,
      fingerprint: canonicalJsonSha256(config),
    };
  } catch {
    return {
      ok: false,
      diagnostics: freezeDiagnostics([
        diagnostic(
          "config_not_object",
          "error",
          "Rollout configuration could not be read as a plain data object.",
        ),
      ]),
    };
  }
}

/**
 * Returns a stable SHA-256 cohort bucket. Tenant identity is always included;
 * session stickiness additionally includes the session identity. The algorithm
 * and namespace are versioned so an intentional future change can be explicit.
 */
export function stableRolloutBucket(context: RolloutCohortContext): number {
  if (!isBoundedText(context.capability) || !isBoundedText(context.tenantId)) {
    throw new TypeError("A valid capability and tenantId are required");
  }
  if (context.stickiness !== "tenant" && context.stickiness !== "session") {
    throw new TypeError("Rollout stickiness must be tenant or session");
  }
  if (context.stickiness === "session" && !isBoundedText(context.sessionId)) {
    throw new TypeError("sessionId is required for session stickiness");
  }

  const payload =
    context.stickiness === "tenant"
      ? {
          namespace: "private-fund-rollout-cohort-v1",
          capability: context.capability,
          stickiness: context.stickiness,
          tenantId: context.tenantId,
        }
      : {
          namespace: "private-fund-rollout-cohort-v1",
          capability: context.capability,
          stickiness: context.stickiness,
          tenantId: context.tenantId,
          sessionId: context.sessionId as string,
        };
  const digest = createHash("sha256")
    .update(canonicalizeJson(payload), "utf8")
    .digest();
  return digest.readUInt32BE(0) % ROLLOUT_BUCKET_COUNT;
}

/**
 * Runtime guard that must be called immediately before selecting a write path.
 * Shadow is not a second writer: Legacy remains primary and the candidate must
 * be both read-only and free of external side effects.
 */
export function assertSingleWriter(assertion: SingleWriterAssertion): void {
  if (assertion.legacyWrites === assertion.newWrites) {
    throw new RolloutInvariantError(
      "Exactly one primary writer must be selected for a rollout decision",
    );
  }

  switch (assertion.mode) {
    case "legacy":
      if (!assertion.legacyWrites || assertion.newWrites || assertion.shadow !== null) {
        throw new RolloutInvariantError(
          "Legacy mode must select only the Legacy writer and no shadow execution",
        );
      }
      return;
    case "new":
      if (assertion.legacyWrites || !assertion.newWrites || assertion.shadow !== null) {
        throw new RolloutInvariantError(
          "New mode must select only the new writer and no shadow execution",
        );
      }
      return;
    case "shadow":
      if (
        !assertion.legacyWrites ||
        assertion.newWrites ||
        assertion.shadow?.readOnly !== true ||
        assertion.shadow.noSideEffects !== true
      ) {
        throw new RolloutInvariantError(
          "Shadow mode requires the Legacy writer and a read-only, no-side-effects candidate",
        );
      }
      return;
    default: {
      const exhaustiveMode: never = assertion.mode;
      throw new RolloutInvariantError(`Unsupported rollout mode: ${String(exhaustiveMode)}`);
    }
  }
}

interface DecisionOptions {
  readonly context: RolloutEvaluationContext;
  readonly mode: RolloutMode;
  readonly source: RolloutDecisionSource;
  readonly percentage: number;
  readonly cohortBucket: number | null;
  readonly configFingerprint: string | null;
  readonly diagnostics: readonly RolloutDiagnostic[];
  readonly allowPin: boolean;
}

function createActiveTurnPin(
  options: DecisionOptions,
  writer: RolloutWriter,
  shadow: ShadowExecutionPolicy | null,
): ActiveTurnRolloutPin | null {
  if (!options.allowPin || options.context.activeTurnId === undefined) {
    return null;
  }
  return Object.freeze({
    schemaVersion: ROLLOUT_CONFIG_SCHEMA_VERSION,
    capability: options.context.capability,
    tenantId: options.context.tenantId,
    sessionId: options.context.sessionId ?? null,
    turnId: options.context.activeTurnId,
    mode: options.mode,
    writer,
    shadow,
    percentage: options.percentage,
    cohortBucket: options.cohortBucket,
    configFingerprint: options.configFingerprint,
  });
}

function createDecision(options: DecisionOptions): RolloutDecision {
  const diagnostics = freezeDiagnostics(options.diagnostics);
  switch (options.mode) {
    case "legacy": {
      assertSingleWriter({
        mode: "legacy",
        legacyWrites: true,
        newWrites: false,
        shadow: null,
      });
      return Object.freeze({
        capability: options.context.capability,
        mode: "legacy",
        writer: "legacy",
        shadow: null,
        source: options.source,
        percentage: options.percentage,
        cohortBucket: options.cohortBucket,
        configFingerprint: options.configFingerprint,
        diagnostics,
        activeTurnPin: createActiveTurnPin(options, "legacy", null),
      });
    }
    case "new": {
      assertSingleWriter({
        mode: "new",
        legacyWrites: false,
        newWrites: true,
        shadow: null,
      });
      return Object.freeze({
        capability: options.context.capability,
        mode: "new",
        writer: "new",
        shadow: null,
        source: options.source,
        percentage: options.percentage,
        cohortBucket: options.cohortBucket,
        configFingerprint: options.configFingerprint,
        diagnostics,
        activeTurnPin: createActiveTurnPin(options, "new", null),
      });
    }
    case "shadow": {
      assertSingleWriter({
        mode: "shadow",
        legacyWrites: true,
        newWrites: false,
        shadow: SHADOW_EXECUTION_POLICY,
      });
      return Object.freeze({
        capability: options.context.capability,
        mode: "shadow",
        writer: "legacy",
        shadow: SHADOW_EXECUTION_POLICY,
        source: options.source,
        percentage: options.percentage,
        cohortBucket: options.cohortBucket,
        configFingerprint: options.configFingerprint,
        diagnostics,
        activeTurnPin: createActiveTurnPin(
          options,
          "legacy",
          SHADOW_EXECUTION_POLICY,
        ),
      });
    }
  }
}

function contextDiagnostics(
  context: RolloutEvaluationContext,
): readonly RolloutDiagnostic[] {
  if (
    !isBoundedText(context.capability) ||
    !isBoundedText(context.tenantId) ||
    (context.sessionId !== undefined && !isBoundedText(context.sessionId)) ||
    (context.activeTurnId !== undefined && !isBoundedText(context.activeTurnId))
  ) {
    return freezeDiagnostics([
      diagnostic(
        "evaluation_context_invalid",
        "error",
        "Rollout evaluation context contains an invalid identifier.",
      ),
    ]);
  }
  return freezeDiagnostics([]);
}

type PinValidationResult =
  | { readonly ok: true; readonly pin: ActiveTurnRolloutPin }
  | { readonly ok: false };

function validateActiveTurnPin(
  value: unknown,
  context: RolloutEvaluationContext,
): PinValidationResult {
  try {
    if (
      context.activeTurnId === undefined ||
      !isPlainRecord(value) ||
      !hasOnlyDataProperties(value) ||
      Reflect.ownKeys(value).some(
        (key) => typeof key !== "string" || !PIN_FIELD_SET.has(key),
      ) ||
      PIN_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field))
    ) {
      return { ok: false };
    }

    if (
      value.schemaVersion !== ROLLOUT_CONFIG_SCHEMA_VERSION ||
      value.capability !== context.capability ||
      value.tenantId !== context.tenantId ||
      value.sessionId !== (context.sessionId ?? null) ||
      value.turnId !== context.activeTurnId ||
      (value.mode !== "legacy" && value.mode !== "new" && value.mode !== "shadow") ||
      (value.writer !== "legacy" && value.writer !== "new") ||
      typeof value.percentage !== "number" ||
      !Number.isInteger(value.percentage) ||
      value.percentage < 0 ||
      value.percentage > 100 ||
      (value.cohortBucket !== null &&
        (typeof value.cohortBucket !== "number" ||
          !Number.isInteger(value.cohortBucket) ||
          value.cohortBucket < 0 ||
          value.cohortBucket >= ROLLOUT_BUCKET_COUNT)) ||
      (value.configFingerprint !== null &&
        (typeof value.configFingerprint !== "string" ||
          !SHA256_HEX.test(value.configFingerprint)))
    ) {
      return { ok: false };
    }

    let shadow: ShadowExecutionPolicy | null = null;
    if (value.mode === "shadow") {
      if (
        !isPlainRecord(value.shadow) ||
        value.shadow.readOnly !== true ||
        value.shadow.noSideEffects !== true ||
        value.shadow.primary !== "legacy" ||
        value.shadow.candidate !== "new" ||
        Reflect.ownKeys(value.shadow).length !== 4
      ) {
        return { ok: false };
      }
      shadow = SHADOW_EXECUTION_POLICY;
    } else if (value.shadow !== null) {
      return { ok: false };
    }

    assertSingleWriter({
      mode: value.mode,
      legacyWrites: value.writer === "legacy",
      newWrites: value.writer === "new",
      shadow,
    });

    return {
      ok: true,
      pin: Object.freeze({
        schemaVersion: ROLLOUT_CONFIG_SCHEMA_VERSION,
        capability: value.capability,
        tenantId: value.tenantId,
        sessionId: context.sessionId ?? null,
        turnId: value.turnId,
        mode: value.mode,
        writer: value.writer,
        shadow,
        percentage: value.percentage,
        cohortBucket: value.cohortBucket,
        configFingerprint: value.configFingerprint,
      }),
    };
  } catch {
    return { ok: false };
  }
}

function decisionFromPin(
  context: RolloutEvaluationContext,
  pin: ActiveTurnRolloutPin,
): RolloutDecision {
  return createDecision({
    context,
    mode: pin.mode,
    source: "active_turn_pin",
    percentage: pin.percentage,
    cohortBucket: pin.cohortBucket,
    configFingerprint: pin.configFingerprint,
    diagnostics: [
      diagnostic(
        "active_turn_pin_applied",
        "info",
        "The active turn keeps its original rollout decision until the turn boundary.",
      ),
    ],
    allowPin: true,
  });
}

function safeLegacyDecision(
  context: RolloutEvaluationContext,
  diagnostics: readonly RolloutDiagnostic[],
  options: {
    readonly source?: RolloutDecisionSource;
    readonly percentage?: number;
    readonly cohortBucket?: number | null;
    readonly configFingerprint?: string | null;
    readonly allowPin?: boolean;
  } = {},
): RolloutDecision {
  return createDecision({
    context,
    mode: "legacy",
    source: options.source ?? "safe_default",
    percentage: options.percentage ?? 0,
    cohortBucket: options.cohortBucket ?? null,
    configFingerprint: options.configFingerprint ?? null,
    diagnostics,
    allowPin: options.allowPin ?? true,
  });
}

/**
 * Makes a fail-safe, per-capability rollout decision. The decision is pure with
 * respect to external systems: it never loads providers or performs writes.
 * Callers must still invoke assertSingleWriter immediately before dispatching a
 * write, because process-local scope is not a security or concurrency boundary.
 */
export function decideRollout(input: DecideRolloutInput): RolloutDecision {
  const invalidContext = contextDiagnostics(input.context);
  if (invalidContext.length > 0) {
    return safeLegacyDecision(input.context, invalidContext, { allowPin: false });
  }

  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "evaluation_context_invalid",
          "error",
          "Rollout evaluation time is invalid.",
        ),
      ],
    );
  }
  if (
    input.globalKillSwitch !== undefined &&
    typeof input.globalKillSwitch !== "boolean"
  ) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "evaluation_context_invalid",
          "error",
          "Global rollout kill switch must be a boolean.",
        ),
      ],
    );
  }

  const parsedConfig = parseRolloutConfig(input.config);

  if (input.globalKillSwitch === true) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "kill_switch_active",
          "warning",
          "The global rollout kill switch requires Legacy.",
        ),
      ],
      { source: "kill_switch" },
    );
  }

  const matchingParsedConfig =
    parsedConfig.ok && parsedConfig.config.capability === input.context.capability
      ? parsedConfig
      : null;
  if (matchingParsedConfig?.config.killSwitch === true) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "kill_switch_active",
          "warning",
          "The capability rollout kill switch requires Legacy.",
        ),
      ],
      {
        source: "kill_switch",
        percentage: matchingParsedConfig.config.percentage,
        configFingerprint: matchingParsedConfig.fingerprint,
      },
    );
  }

  if (input.activeTurnPin !== undefined) {
    const pinResult = validateActiveTurnPin(input.activeTurnPin, input.context);
    if (!pinResult.ok) {
      return safeLegacyDecision(
        input.context,
        [
          diagnostic(
            "active_turn_pin_invalid",
            "error",
            "The active-turn rollout pin is invalid or belongs to another scope.",
          ),
        ],
      );
    }
    if (pinResult.pin.mode !== "legacy" && input.candidateAvailable !== true) {
      return safeLegacyDecision(
        input.context,
        [
          diagnostic(
            "candidate_unavailable",
            "warning",
            "The candidate Provider is unavailable; Legacy is required.",
          ),
        ],
        {
          percentage: pinResult.pin.percentage,
          cohortBucket: pinResult.pin.cohortBucket,
          configFingerprint: pinResult.pin.configFingerprint,
        },
      );
    }
    return decisionFromPin(input.context, pinResult.pin);
  }

  if (!parsedConfig.ok) {
    return safeLegacyDecision(input.context, parsedConfig.diagnostics);
  }

  const { config, fingerprint } = parsedConfig;
  if (config.capability !== input.context.capability) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "config_capability_mismatch",
          "error",
          "Rollout configuration belongs to a different capability.",
        ),
      ],
      { percentage: config.percentage, configFingerprint: fingerprint },
    );
  }

  const nowMilliseconds = now.getTime();
  const createdAtMilliseconds = Date.parse(config.createdAt);
  const expiresAtMilliseconds = Date.parse(config.expiresAt);
  if (createdAtMilliseconds > nowMilliseconds) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "config_not_active",
          "warning",
          "Rollout configuration is not active yet; Legacy is required.",
        ),
      ],
      { percentage: config.percentage, configFingerprint: fingerprint },
    );
  }
  if (expiresAtMilliseconds <= nowMilliseconds) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "config_expired",
          "warning",
          "Rollout configuration has expired; Legacy is required.",
        ),
      ],
      { percentage: config.percentage, configFingerprint: fingerprint },
    );
  }

  if (config.stickiness === "session" && !isBoundedText(input.context.sessionId)) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "session_id_required",
          "error",
          "Session stickiness requires a valid sessionId; Legacy is required.",
        ),
      ],
      { percentage: config.percentage, configFingerprint: fingerprint },
    );
  }

  const cohortBucket = stableRolloutBucket({
    capability: input.context.capability,
    tenantId: input.context.tenantId,
    ...(input.context.sessionId === undefined
      ? {}
      : { sessionId: input.context.sessionId }),
    stickiness: config.stickiness,
  });
  const selected = cohortBucket < config.percentage * 100;
  const mode = selected ? config.mode : "legacy";

  if (mode !== "legacy" && input.candidateAvailable !== true) {
    return safeLegacyDecision(
      input.context,
      [
        diagnostic(
          "candidate_unavailable",
          "warning",
          "The candidate Provider is unavailable; Legacy is required.",
        ),
      ],
      {
        percentage: config.percentage,
        cohortBucket,
        configFingerprint: fingerprint,
      },
    );
  }

  return createDecision({
    context: input.context,
    mode,
    source: "config",
    percentage: config.percentage,
    cohortBucket,
    configFingerprint: fingerprint,
    diagnostics:
      selected || config.mode === "legacy"
        ? []
        : [
            diagnostic(
              "cohort_not_selected",
              "info",
              "The stable cohort is outside the configured percentage; Legacy is selected.",
            ),
          ],
    allowPin: true,
  });
}
