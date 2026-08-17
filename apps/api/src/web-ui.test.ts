import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerWebUi } from "./web-ui.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "private-fund-web-ui-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), "<main>desktop shell</main>");
  await writeFile(path.join(root, "assets", "app-abc.js"), "export const ok=true;");
  const app = Fastify();
  apps.push(app);
  app.get("/health", async () => ({ status: "ok" }));
  await registerWebUi(app, root);
  return app;
}

describe("canonical Web UI hosting", () => {
  it("serves hashed assets and SPA routes without shadowing API routes", async () => {
    const app = await fixture();

    const asset = await app.inject({ method: "GET", url: "/assets/app-abc.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.body).toContain("ok=true");

    const spa = await app.inject({ method: "GET", url: "/projects/acme/research" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("desktop shell");

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toEqual({ status: "ok" });

    const missingApi = await app.inject({ method: "GET", url: "/v1/missing" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ error: "not_found" });
  });

  it("does not serve files outside the configured web root", async () => {
    const app = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/../../../../etc/passwd",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("desktop shell");
    expect(response.body).not.toContain("root:");
  });
});
