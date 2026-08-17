import { describe, expect, it } from "vitest";

import {
  ROLLOUT_BUCKET_COUNT,
  RolloutInvariantError,
  assertSingleWriter,
  decideRollout,
  parseRolloutConfig,
  stableRolloutBucket,
  type RolloutConfigV1,
  type RolloutDecision,
  type RolloutEvaluationContext,
} from "../src/rollout.js";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const CONTEXT: RolloutEvaluationContext = {
  capability: "market-data",
  tenantId: "tenant-17",
  sessionId: "session-41",
  activeTurnId: "turn-9",
};

function config(
  overrides: Record<string, unknown> = {},
): RolloutConfigV1 & Record<string, unknown> {
  return {
    schemaVersion: 1,
    capability: "market-data",
    mode: "new",
    percentage: 100,
    stickiness: "session",
    owner: "runtime-team",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    killSwitch: false,
    ...overrides,
  } as RolloutConfigV1 & Record<string, unknown>;
}

function diagnosticCodes(decision: RolloutDecision): string[] {
  return decision.diagnostics.map(({ code }) => code);
}

describe("rollout configuration", () => {
  it("parses the versioned schema and creates an order-independent fingerprint", () => {
    const first = parseRolloutConfig(config());
    const second = parseRolloutConfig({
      owner: "runtime-team",
      expiresAt: "2026-09-01T00:00:00.000Z",
      percentage: 100,
      mode: "new",
      killSwitch: false,
      schemaVersion: 1,
      stickiness: "session",
      capability: "market-data",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("Expected valid rollout configurations");
    }
    expect(first.config.owner).toBe("runtime-team");
    expect(first.config.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(first.config.expiresAt).toBe("2026-09-01T00:00:00.000Z");
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(Object.isFrozen(first.config)).toBe(true);
  });

  it.each([-1, 101, 10.5, Number.NaN, Number.POSITIVE_INFINITY, "10"])(
    "rejects invalid percentage %s and fails safely",
    (percentage) => {
      const decision = decideRollout({
        context: CONTEXT,
        config: config({ percentage }),
        candidateAvailable: true,
        now: NOW,
      });

      expect(decision.mode).toBe("legacy");
      expect(decision.writer).toBe("legacy");
      expect(diagnosticCodes(decision)).toContain("config_invalid_percentage");
    },
  );

  it.each([
    [config({ schemaVersion: 2 }), "config_unknown_schema"],
    [config({ mode: "experimental" }), "config_unknown_mode"],
    [config({ unexpected: true }), "config_unknown_field"],
    [config({ owner: "" }), "config_owner_invalid"],
    [config({ killSwitch: "false" }), "config_kill_switch_invalid"],
  ])("rejects unknown or malformed configuration", (value, expectedCode) => {
    const decision = decideRollout({
      context: CONTEXT,
      config: value,
      candidateAvailable: true,
      now: NOW,
    });

    expect(decision.mode).toBe("legacy");
    expect(diagnosticCodes(decision)).toContain(expectedCode);
  });

  it("rejects an invalid lifetime before rollout evaluation", () => {
    const parsed = parseRolloutConfig(
      config({
        createdAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error("Expected an invalid rollout lifetime");
    }
    expect(parsed.diagnostics.map(({ code }) => code)).toContain(
      "config_invalid_lifetime",
    );
  });
});

describe("stable cohort evaluation", () => {
  it("is deterministic and tenant-sticky across sessions", () => {
    const first = stableRolloutBucket({
      capability: "market-data",
      tenantId: "tenant-17",
      sessionId: "session-a",
      stickiness: "tenant",
    });
    const second = stableRolloutBucket({
      capability: "market-data",
      tenantId: "tenant-17",
      sessionId: "session-b",
      stickiness: "tenant",
    });

    expect(first).toBe(second);
    expect(first).toBe(9354);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(ROLLOUT_BUCKET_COUNT);
  });

  it("is deterministic for session stickiness and requires a session", () => {
    const cohort = {
      capability: "market-data",
      tenantId: "tenant-17",
      sessionId: "session-a",
      stickiness: "session" as const,
    };

    expect(stableRolloutBucket(cohort)).toBe(3657);
    expect(stableRolloutBucket(cohort)).toBe(stableRolloutBucket(cohort));
    expect(() =>
      stableRolloutBucket({
        capability: "market-data",
        tenantId: "tenant-17",
        stickiness: "session",
      }),
    ).toThrowError(/sessionId/u);
  });

  it("honors the closed interval percentage boundaries", () => {
    const never = decideRollout({
      context: CONTEXT,
      config: config({ percentage: 0 }),
      candidateAvailable: true,
      now: NOW,
    });
    const always = decideRollout({
      context: CONTEXT,
      config: config({ percentage: 100 }),
      candidateAvailable: true,
      now: NOW,
    });

    expect(never.mode).toBe("legacy");
    expect(diagnosticCodes(never)).toContain("cohort_not_selected");
    expect(always.mode).toBe("new");
    expect(always.writer).toBe("new");
  });
});

describe("fail-safe rollout decisions", () => {
  it("defaults to the only Legacy writer when configuration is missing", () => {
    const decision = decideRollout({
      context: CONTEXT,
      candidateAvailable: true,
      now: NOW,
    });

    expect(decision).toMatchObject({
      mode: "legacy",
      writer: "legacy",
      shadow: null,
      source: "safe_default",
      percentage: 0,
      cohortBucket: null,
      configFingerprint: null,
    });
    expect(diagnosticCodes(decision)).toEqual(["config_missing"]);
    expect(decision.activeTurnPin).not.toBeNull();
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("falls back with diagnostics for future, expired and mismatched config", () => {
    const future = decideRollout({
      context: CONTEXT,
      config: config({
        createdAt: "2026-08-17T00:00:00.000Z",
        expiresAt: "2026-09-17T00:00:00.000Z",
      }),
      candidateAvailable: true,
      now: NOW,
    });
    const expired = decideRollout({
      context: CONTEXT,
      config: config({ expiresAt: "2026-08-16T12:00:00.000Z" }),
      candidateAvailable: true,
      now: NOW,
    });
    const mismatched = decideRollout({
      context: CONTEXT,
      config: config({ capability: "model-provider" }),
      candidateAvailable: true,
      now: NOW,
    });

    expect(future.mode).toBe("legacy");
    expect(diagnosticCodes(future)).toContain("config_not_active");
    expect(expired.mode).toBe("legacy");
    expect(diagnosticCodes(expired)).toContain("config_expired");
    expect(mismatched.mode).toBe("legacy");
    expect(diagnosticCodes(mismatched)).toContain(
      "config_capability_mismatch",
    );
  });

  it("requires an explicit available candidate before selecting new", () => {
    const unavailable = decideRollout({
      context: CONTEXT,
      config: config(),
      now: NOW,
    });

    expect(unavailable.mode).toBe("legacy");
    expect(unavailable.writer).toBe("legacy");
    expect(diagnosticCodes(unavailable)).toContain("candidate_unavailable");
  });

  it("requires a session identity for session stickiness", () => {
    const { sessionId: _ignored, ...withoutSession } = CONTEXT;
    const decision = decideRollout({
      context: withoutSession,
      config: config(),
      candidateAvailable: true,
      now: NOW,
    });

    expect(decision.mode).toBe("legacy");
    expect(diagnosticCodes(decision)).toContain("session_id_required");
  });

  it("marks shadow as read-only and side-effect-free while Legacy remains writer", () => {
    const decision = decideRollout({
      context: CONTEXT,
      config: config({ mode: "shadow" }),
      candidateAvailable: true,
      now: NOW,
    });

    expect(decision).toMatchObject({
      mode: "shadow",
      writer: "legacy",
      shadow: {
        readOnly: true,
        noSideEffects: true,
        primary: "legacy",
        candidate: "new",
      },
    });
    expect(decision.activeTurnPin?.shadow).toEqual(decision.shadow);
  });

  it("pins a Provider decision for the active turn across config refresh", () => {
    const first = decideRollout({
      context: CONTEXT,
      config: config({ mode: "new", percentage: 100 }),
      candidateAvailable: true,
      now: NOW,
    });
    if (first.activeTurnPin === null) {
      throw new Error("Expected an active-turn pin");
    }

    const pinned = decideRollout({
      context: CONTEXT,
      config: config({ mode: "legacy", percentage: 100 }),
      candidateAvailable: true,
      activeTurnPin: first.activeTurnPin,
      now: NOW,
    });

    expect(first.mode).toBe("new");
    expect(pinned.mode).toBe("new");
    expect(pinned.writer).toBe("new");
    expect(pinned.source).toBe("active_turn_pin");
    expect(diagnosticCodes(pinned)).toEqual(["active_turn_pin_applied"]);
  });

  it("fails safely instead of applying a pin from another turn", () => {
    const first = decideRollout({
      context: CONTEXT,
      config: config(),
      candidateAvailable: true,
      now: NOW,
    });
    if (first.activeTurnPin === null) {
      throw new Error("Expected an active-turn pin");
    }

    const decision = decideRollout({
      context: { ...CONTEXT, activeTurnId: "turn-10" },
      config: config(),
      candidateAvailable: true,
      activeTurnPin: first.activeTurnPin,
      now: NOW,
    });

    expect(decision.mode).toBe("legacy");
    expect(diagnosticCodes(decision)).toEqual(["active_turn_pin_invalid"]);
  });

  it("lets global and capability kill switches override an active new pin", () => {
    const first = decideRollout({
      context: CONTEXT,
      config: config(),
      candidateAvailable: true,
      now: NOW,
    });
    if (first.activeTurnPin === null) {
      throw new Error("Expected an active-turn pin");
    }

    const globalKill = decideRollout({
      context: CONTEXT,
      config: config(),
      candidateAvailable: true,
      activeTurnPin: first.activeTurnPin,
      globalKillSwitch: true,
      now: NOW,
    });
    const capabilityKill = decideRollout({
      context: CONTEXT,
      config: config({ killSwitch: true }),
      candidateAvailable: true,
      activeTurnPin: first.activeTurnPin,
      now: NOW,
    });

    for (const decision of [globalKill, capabilityKill]) {
      expect(decision.mode).toBe("legacy");
      expect(decision.writer).toBe("legacy");
      expect(decision.source).toBe("kill_switch");
      expect(diagnosticCodes(decision)).toEqual(["kill_switch_active"]);
    }
  });
});

describe("single-writer assertion", () => {
  it("accepts the three valid writer arrangements", () => {
    expect(() =>
      assertSingleWriter({
        mode: "legacy",
        legacyWrites: true,
        newWrites: false,
        shadow: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertSingleWriter({
        mode: "new",
        legacyWrites: false,
        newWrites: true,
        shadow: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertSingleWriter({
        mode: "shadow",
        legacyWrites: true,
        newWrites: false,
        shadow: { readOnly: true, noSideEffects: true },
      }),
    ).not.toThrow();
  });

  it("blocks dual writers, no writer and a side-effectful shadow", () => {
    expect(() =>
      assertSingleWriter({
        mode: "new",
        legacyWrites: true,
        newWrites: true,
        shadow: null,
      }),
    ).toThrow(RolloutInvariantError);
    expect(() =>
      assertSingleWriter({
        mode: "legacy",
        legacyWrites: false,
        newWrites: false,
        shadow: null,
      }),
    ).toThrow(RolloutInvariantError);
    expect(() =>
      assertSingleWriter({
        mode: "shadow",
        legacyWrites: true,
        newWrites: false,
        shadow: { readOnly: true, noSideEffects: false },
      }),
    ).toThrow(RolloutInvariantError);
  });
});
