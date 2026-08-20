#!/usr/bin/env node

import { createServer } from "node:http";

const entry = process.argv.find((argument) =>
  /apps\/(api|job-worker)\/dist\/main\.js$/.test(argument),
);
if (entry === undefined) {
  throw new Error("Fixture did not receive a canonical service entry");
}

const serviceId = entry.includes("/apps/api/")
  ? "api"
  : entry.includes("/apps/job-worker/")
    ? "job-worker"
    : "job-worker";

if (process.env.PRIVATE_FUND_SERVICE_FIXTURE_FAIL === serviceId) {
  process.stderr.write(`fixture_failure:${serviceId}\n`);
  process.exit(23);
}

let server;
if (
  serviceId === "api" &&
  process.env.PRIVATE_FUND_SERVICE_TEST_MODE !== "1"
) {
  const host =
    serviceId === "api"
      ? process.env.PRIVATE_FUND_API_HOST ?? "127.0.0.1"
      : process.env.PRIVATE_FUND_OBSIDIAN_HEALTH_HOST ?? "127.0.0.1";
  const port = Number(
    serviceId === "api"
      ? process.env.PRIVATE_FUND_API_PORT
      : process.env.PRIVATE_FUND_OBSIDIAN_HEALTH_PORT,
  );
  const expectedPath =
    serviceId === "api" ? "/health" : "/health/ready";
  server = createServer((request, response) => {
    if (request.url !== expectedPath) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, service: serviceId }));
  });
  server.listen(port, host, () => {
    process.stderr.write(`fixture_ready:${serviceId}\n`);
  });
} else if (serviceId === "job-worker") {
  process.stderr.write(
    `${JSON.stringify({
      event: "compute_worker_ready",
      worker: "test-fixture",
      dependencies: {},
      pythonExecutable:
        process.env.PRIVATE_FUND_PYTHON_EXECUTABLE ?? null,
    })}\n`,
  );
} else {
  process.stderr.write(`fixture_ready:${serviceId}\n`);
}

const keepAlive = setInterval(() => {}, 60_000);
const stop = () => {
  clearInterval(keepAlive);
  if (server === undefined) {
    process.exit(0);
  }
  server.close(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
