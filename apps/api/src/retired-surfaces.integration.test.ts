import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";

const WORKER_ENTRY = fileURLToPath(
  new URL("../test/fixtures/fake-agent-worker.mjs", import.meta.url),
);

type RetiredMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

interface RetiredRoute {
  readonly ids: readonly string[];
  readonly method: RetiredMethod;
  readonly path: string;
}

/**
 * Every intentional-retire route in the captured legacy baseline is listed
 * here. Duplicate Host/Runner declarations share one probe and retain all
 * matrix IDs so this file can serve as route-level retirement evidence.
 *
 * Canonical session `/resources` and `/attachments` routes are intentionally
 * absent. They are positive controls in the test below.
 */
const RETIRED_LEGACY_ROUTES: readonly RetiredRoute[] = [
  {
    ids: ["route-012"],
    method: "POST",
    path: "/v1/elicitations/{elicitation_id}",
  },
  {
    ids: ["route-018"],
    method: "GET",
    path: "/v1/private-fund/llm-config",
  },
  {
    ids: ["route-019"],
    method: "PUT",
    path: "/v1/private-fund/llm-config",
  },
  {
    ids: ["route-020"],
    method: "GET",
    path: "/v1/private-fund/llm-config/status",
  },
  {
    ids: ["route-021"],
    method: "POST",
    path: "/v1/private-fund/llm-config/test",
  },
  {
    ids: ["route-034"],
    method: "POST",
    path: "/v1/private-fund/projects/{dataset_id}/activate",
  },
  {
    ids: ["route-095"],
    method: "POST",
    path: "/v1/sessions/{session_id}/agent-cache/reset",
  },
  {
    ids: ["route-096"],
    method: "GET",
    path: "/v1/sessions/{session_id}/agent",
  },
  {
    ids: ["route-097"],
    method: "PUT",
    path: "/v1/sessions/{session_id}/agent",
  },
  {
    ids: ["route-098"],
    method: "GET",
    path: "/v1/sessions/{session_id}/agent/contents",
  },
  {
    ids: ["route-100"],
    method: "GET",
    path: "/v1/sessions/{session_id}/codex-model-options",
  },
  {
    ids: ["route-101"],
    method: "GET",
    path: "/v1/sessions/{session_id}/elicitations/{elicitation_id}",
  },
  {
    ids: ["route-102"],
    method: "POST",
    path: "/v1/sessions/{session_id}/elicitations/{elicitation_id}/resolve",
  },
  {
    ids: ["route-103"],
    method: "POST",
    path: "/v1/sessions/{session_id}/events",
  },
  {
    ids: ["route-104"],
    method: "POST",
    path:
      "/v1/sessions/{session_id}/hooks/antigravity-elicitation-request",
  },
  {
    ids: ["route-105"],
    method: "POST",
    path: "/v1/sessions/{session_id}/hooks/codex-elicitation-request",
  },
  {
    ids: ["route-106"],
    method: "POST",
    path: "/v1/sessions/{session_id}/hooks/cursor-permission-request",
  },
  {
    ids: ["route-107"],
    method: "POST",
    path: "/v1/sessions/{session_id}/hooks/native-permission-request",
  },
  {
    ids: ["route-108"],
    method: "POST",
    path: "/v1/sessions/{session_id}/hooks/permission-request",
  },
  {
    ids: ["route-111"],
    method: "POST",
    path: "/v1/sessions/{session_id}/mcp",
  },
  {
    ids: ["route-112"],
    method: "POST",
    path: "/v1/sessions/{session_id}/mcp/execute",
  },
  {
    ids: ["route-113"],
    method: "GET",
    path: "/v1/sessions/{session_id}/owner",
  },
  {
    ids: ["route-114"],
    method: "GET",
    path: "/v1/sessions/{session_id}/permissions",
  },
  {
    ids: ["route-115"],
    method: "PUT",
    path: "/v1/sessions/{session_id}/permissions",
  },
  {
    ids: ["route-116"],
    method: "DELETE",
    path: "/v1/sessions/{session_id}/permissions/{target_user_id}",
  },
  {
    ids: ["route-117"],
    method: "POST",
    path: "/v1/sessions/{session_id}/policies/evaluate",
  },
  {
    ids: ["route-118"],
    method: "POST",
    path: "/v1/sessions/{session_id}/reset-state",
  },
  {
    ids: ["route-124", "route-125"],
    method: "DELETE",
    path: "/v1/sessions/{session_id}/resources/environments",
  },
  {
    ids: [
      "route-126",
      "route-127",
      "route-128",
      "route-129",
      "route-130",
    ],
    method: "GET",
    path: "/v1/sessions/{session_id}/resources/environments",
  },
  {
    ids: ["route-131", "route-132"],
    method: "PATCH",
    path: "/v1/sessions/{session_id}/resources/environments",
  },
  {
    ids: ["route-133", "route-134"],
    method: "PUT",
    path: "/v1/sessions/{session_id}/resources/environments",
  },
  {
    ids: ["route-135", "route-136"],
    method: "GET",
    path:
      "/v1/sessions/{session_id}/resources/environments/{environment_id}",
  },
  {
    ids: ["route-137", "route-138"],
    method: "GET",
    path:
      "/v1/sessions/{session_id}/resources/environments/{environment_id}/changes",
  },
  {
    ids: ["route-139"],
    method: "GET",
    path:
      "/v1/sessions/{session_id}/resources/environments/{environment_id}/diff/{relative_path:path}",
  },
  {
    ids: ["route-140", "route-141"],
    method: "GET",
    path:
      "/v1/sessions/{session_id}/resources/environments/{environment_id}/filesystem",
  },
  {
    ids: ["route-142", "route-143"],
    method: "GET",
    path:
      "/v1/sessions/{session_id}/resources/environments/{environment_id}/search",
  },
  {
    ids: ["route-144", "route-145"],
    method: "POST",
    path:
      "/v1/sessions/{session_id}/resources/environments/{environment_id}/shell",
  },
  {
    ids: ["route-151", "route-152"],
    method: "GET",
    path: "/v1/sessions/{session_id}/resources/terminals",
  },
  {
    ids: ["route-153", "route-154"],
    method: "POST",
    path: "/v1/sessions/{session_id}/resources/terminals",
  },
  {
    ids: ["route-155", "route-156"],
    method: "DELETE",
    path:
      "/v1/sessions/{session_id}/resources/terminals/{terminal_id}",
  },
  {
    ids: ["route-157", "route-158"],
    method: "GET",
    path:
      "/v1/sessions/{session_id}/resources/terminals/{terminal_id}",
  },
  {
    ids: ["route-159", "route-160"],
    method: "POST",
    path:
      "/v1/sessions/{session_id}/resources/terminals/{terminal_id}/transfer",
  },
  {
    ids: ["route-161"],
    method: "GET",
    path: "/v1/sessions/{session_id}/skills",
  },
  {
    ids: ["route-162"],
    method: "POST",
    path: "/v1/sessions/{session_id}/skills/resolve",
  },
  {
    ids: ["route-165"],
    method: "POST",
    path: "/v1/sessions/{session_id}/switch-agent",
  },
];

function interpolateLegacyPath(
  template: string,
  projectId: string,
  sessionId: string,
): string {
  return template
    .replaceAll("{dataset_id}", projectId)
    .replaceAll("{session_id}", sessionId)
    .replaceAll("{elicitation_id}", "elicitation_test")
    .replaceAll("{environment_id}", "environment_test")
    .replaceAll("{terminal_id}", "terminal_test")
    .replaceAll("{target_user_id}", "target_user_test")
    .replaceAll("{relative_path:path}", "reports/model.md");
}

function totalDatabaseChanges(runtime: ApiRuntime): number {
  const row = runtime.database
    .prepare("SELECT total_changes() AS value")
    .get() as { value: number | bigint };
  return Number(row.value);
}

async function artifactTreeSnapshot(root: string): Promise<string[]> {
  const snapshot: string[] = [];

  async function visit(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath =
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (
        relativePath === "control.sqlite3" ||
        relativePath === "control.sqlite3-shm" ||
        relativePath === "control.sqlite3-wal"
      ) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const stat = await lstat(absolutePath);
      if (stat.isDirectory()) {
        snapshot.push(`${relativePath}:directory:${stat.mode & 0o777}`);
        await visit(absolutePath, relativePath);
      } else if (stat.isSymbolicLink()) {
        snapshot.push(
          `${relativePath}:symlink:${await readlink(absolutePath)}`,
        );
      } else if (stat.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(absolutePath))
          .digest("hex");
        snapshot.push(
          `${relativePath}:file:${stat.mode & 0o777}:${stat.size}:${digest}`,
        );
      } else {
        snapshot.push(`${relativePath}:other:${stat.mode & 0o777}`);
      }
    }
  }

  await visit(root, "");
  return snapshot;
}

describe("retired Omnigent Host/Runner surfaces", () => {
  let runtime: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await runtime?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("returns 404 without side effects while canonical resources stay available", async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "pf-retired-surfaces-"));
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "retirement-test-user",
        dataNamespace: "00000000-0000-4000-8000-000000000077",
      },
      agentWorkerEntry: WORKER_ENTRY,
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Retirement acceptance project" },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();

    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        projectId: project.id,
        title: "Retirement acceptance session",
      },
    });
    expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
    const session = sessionResponse.json<{ id: string }>();

    const canonicalResources = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/resources`,
    });
    expect(canonicalResources.statusCode, canonicalResources.body).toBe(200);
    expect(canonicalResources.json()).toMatchObject({
      items: [],
      total: 0,
    });

    const canonicalAttachments = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/attachments`,
    });
    expect(
      canonicalAttachments.statusCode,
      canonicalAttachments.body,
    ).toBe(200);
    expect(canonicalAttachments.json()).toMatchObject({
      items: [],
      total: 0,
    });

    const sentinel = path.join(dataRoot, "retired-shell-must-not-run");
    const changesBefore = totalDatabaseChanges(runtime);
    const artifactsBefore = await artifactTreeSnapshot(dataRoot);

    for (const route of RETIRED_LEGACY_ROUTES) {
      const url = interpolateLegacyPath(
        route.path,
        project.id,
        session.id,
      );
      const response = await runtime.app.inject({
        method: route.method,
        url,
        ...(route.method === "GET"
          ? {}
          : {
              payload: {
                action: "execute",
                command: `touch ${sentinel}`,
                environmentId: "environment_test",
                mcpServer: "untrusted-server",
                path: "../../outside",
                permission: "allow",
                terminalId: "terminal_test",
                tool: "shell",
              },
            }),
      });

      const evidenceLabel =
        `${route.ids.join(",")} ${route.method} ${route.path}`;
      expect(response.statusCode, `${evidenceLabel}: ${response.body}`).toBe(
        404,
      );
      expect(
        totalDatabaseChanges(runtime),
        `${evidenceLabel} changed the control database`,
      ).toBe(changesBefore);
      await expect(
        access(sentinel),
        `${evidenceLabel} executed a retired shell action`,
      ).rejects.toMatchObject({ code: "ENOENT" });
    }

    expect(await artifactTreeSnapshot(dataRoot)).toEqual(artifactsBefore);

    const resourcesAfter = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/resources`,
    });
    expect(resourcesAfter.statusCode, resourcesAfter.body).toBe(200);
    expect(resourcesAfter.json()).toEqual(canonicalResources.json());

    const attachmentsAfter = await runtime.app.inject({
      method: "GET",
      url: `/v1/sessions/${session.id}/attachments`,
    });
    expect(attachmentsAfter.statusCode, attachmentsAfter.body).toBe(200);
    expect(attachmentsAfter.json()).toEqual(canonicalAttachments.json());
  });
});
