import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

const API_PREFIXES = ["/api", "/auth", "/health", "/v1"] as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function regularFile(pathname: string): Promise<boolean> {
  try {
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

function sendFile(reply: FastifyReply, filename: string, immutable: boolean) {
  const extension = path.extname(filename).toLowerCase();
  reply
    .header(
      "cache-control",
      immutable ? "public, max-age=31536000, immutable" : "no-cache",
    )
    .header(
      "content-type",
      CONTENT_TYPES[extension] ?? "application/octet-stream",
    )
    .header("cross-origin-resource-policy", "same-origin")
    .header("x-content-type-options", "nosniff");
  return reply.send(createReadStream(filename));
}

/**
 * Serve the production React bundle from the canonical API origin.
 *
 * Electron relies on this same-origin mode so uploads, cookies, downloads and
 * SSE behave exactly as they do behind the development Vite proxy. Unknown API
 * routes remain JSON 404s; only application routes receive the SPA fallback.
 */
export async function registerWebUi(
  app: FastifyInstance,
  configuredRoot: string,
): Promise<void> {
  const root = await realpath(configuredRoot);
  const indexPath = path.join(root, "index.html");
  if (!(await regularFile(indexPath))) {
    throw new Error(`Web UI index.html is missing from ${root}`);
  }

  const handle = async (
    pathname: string,
    wildcard: string,
    reply: FastifyReply,
  ) => {
    if (isApiPath(pathname)) {
      return reply
        .status(404)
        .send({ error: "not_found", message: "Route not found" });
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(wildcard);
    } catch {
      return reply
        .status(400)
        .send({ error: "invalid_path", message: "Path is not valid UTF-8" });
    }
    if (decoded.includes("\0")) {
      return reply
        .status(400)
        .send({ error: "invalid_path", message: "Path contains NUL" });
    }

    const candidate = path.resolve(root, decoded);
    if (isWithin(candidate, root) && (await regularFile(candidate))) {
      return sendFile(reply, candidate, pathname.startsWith("/assets/"));
    }
    return sendFile(reply, indexPath, false);
  };

  app.get("/", (_request, reply) => handle("/", "", reply));
  app.get<{ Params: { "*": string } }>("/*", (request, reply) =>
    handle(request.url.split("?", 1)[0] ?? "/", request.params["*"], reply),
  );
}
