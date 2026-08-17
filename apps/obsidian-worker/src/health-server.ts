import {
  createServer,
  type Server,
} from "node:http";

import type { RunnerHealth } from "./runner.js";

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
}

export interface ObsidianHealthServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function responseBody(
  health: RunnerHealth,
  endpoint: "live" | "ready",
): { readonly ok: boolean; readonly health: RunnerHealth } {
  const ok =
    endpoint === "live"
      ? health.status !== "stopped"
      : health.status === "ready";
  return { ok, health };
}

export async function startHealthServer(
  health: () => RunnerHealth,
  options: HealthServerOptions,
): Promise<ObsidianHealthServer> {
  const server = createServer((request, response) => {
    if (
      request.method !== "GET" ||
      (request.url !== "/health/live" && request.url !== "/health/ready")
    ) {
      response.writeHead(404, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end('{"error":"not_found"}\n');
      return;
    }
    const endpoint = request.url.endsWith("/ready") ? "ready" : "live";
    const body = responseBody(health(), endpoint);
    response.writeHead(body.ok ? 200 : 503, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(`${JSON.stringify(body)}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Health server did not bind a TCP address");
  }
  return {
    server,
    host: options.host,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}
