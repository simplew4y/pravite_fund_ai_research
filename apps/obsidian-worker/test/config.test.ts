import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadObsidianWorkerConfig } from "../src/config.js";

describe("loadObsidianWorkerConfig", () => {
  it("shares the TS control-plane data root and validates worker limits", () => {
    const config = loadObsidianWorkerConfig(
      {
        PRIVATE_FUND_DATA_ROOT: "state",
        PRIVATE_FUND_OBSIDIAN_HEALTH_PORT: "0",
        PRIVATE_FUND_OBSIDIAN_MAX_DRAIN_EVENTS: "25",
      },
      "/srv/private-fund",
    );

    expect(config.dataRoot).toBe(path.resolve("/srv/private-fund/state"));
    expect(config.controlDatabase).toBe(
      path.resolve("/srv/private-fund/state/control.sqlite3"),
    );
    expect(config.healthPort).toBe(0);
    expect(config.maxDrainEvents).toBe(25);
    expect(config.managedRootRelative).toBe("obsidian/managed");
  });

  it("rejects unbounded or malformed numeric settings", () => {
    expect(() =>
      loadObsidianWorkerConfig({
        PRIVATE_FUND_OBSIDIAN_MAX_DRAIN_EVENTS: "0",
      }),
    ).toThrow(/MAX_DRAIN_EVENTS/u);
    expect(() =>
      loadObsidianWorkerConfig({
        PRIVATE_FUND_OBSIDIAN_HEALTH_PORT: "70000",
      }),
    ).toThrow(/HEALTH_PORT/u);
  });
});
