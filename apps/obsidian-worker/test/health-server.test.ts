import { describe, expect, it } from "vitest";

import { startHealthServer } from "../src/health-server.js";
import type { RunnerHealth } from "../src/runner.js";

function health(status: RunnerHealth["status"]): RunnerHealth {
  return {
    status,
    startedAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    cycleCount: 0,
    projectsDiscovered: 0,
    totals: {
      recovered: 0,
      reconciled: 0,
      processed: 0,
      completed: 0,
      queued: 0,
      failed: 0,
      stale: 0,
      written: 0,
      unchanged: 0,
      archived: 0,
    },
    projects: [],
    lastError: null,
  };
}

describe("Obsidian worker health server", () => {
  it("distinguishes liveness from readiness and binds locally", async () => {
    let snapshot = health("starting");
    const server = await startHealthServer(() => snapshot, {
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const base = `http://${server.host}:${String(server.port)}`;
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);

      snapshot = health("ready");
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({
        ok: true,
        health: { status: "ready" },
      });

      snapshot = health("degraded");
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
      expect((await fetch(`${base}/unknown`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
