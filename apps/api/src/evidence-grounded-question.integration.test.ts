import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SessionEvent } from "@private-fund/contracts";

import type { ApiConfig } from "./config.js";
import { createApiRuntime, type ApiRuntime } from "./main.js";
import { ProjectResearchStoreManager } from "./research-stores.js";

const WORKER_ENTRY = "unused-agent-worker-entry";
const DATA_NAMESPACE = "00000000-0000-4000-8000-000000000078";

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 4_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
}

import { startFakeChatServer } from "../test/fixtures/fake-chat-server.mjs";

let fakeChat: Awaited<ReturnType<typeof startFakeChatServer>> | undefined;

function fakeModelEndpoint(): { baseUrl: string; apiKey: string; model: string } {
  if (fakeChat === undefined) throw new Error("fake chat server not started");
  return { baseUrl: fakeChat.url, apiKey: "test-model-key", model: "fake-model" };
}

beforeAll(async () => {
  fakeChat = await startFakeChatServer();
});

afterAll(async () => {
  await fakeChat?.close();
  fakeChat = undefined;
});

describe("evidence-grounded session questions", () => {
  let runtime: ApiRuntime | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    await runtime?.close();
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("answers through evidence.search plus evidence.get and persists the citation in replay", async () => {
    dataRoot = await mkdtemp(
      path.join(tmpdir(), "pf-evidence-question-"),
    );
    const config: ApiConfig = {
      host: "127.0.0.1",
      port: 6768,
      dataRoot,
      controlDatabase: path.join(dataRoot, "control.sqlite3"),
      auth: {
        mode: "development",
        userId: "evidence-question-user",
        dataNamespace: DATA_NAMESPACE,
      },
      agentWorkerEntry: WORKER_ENTRY,
    agentModel: fakeModelEndpoint(),
    };
    runtime = await createApiRuntime(config);

    const projectResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Evidence grounded project" },
    });
    expect(projectResponse.statusCode, projectResponse.body).toBe(201);
    const project = projectResponse.json<{ id: string }>();
    const projectRoot = path.join(
      dataRoot,
      "users",
      DATA_NAMESPACE,
      "projects",
      project.id,
    );
    const sourceText =
      "Revenue growth was exactly 42.75 percent in the audited period.";
    const sourcePath = path.join(
      projectRoot,
      "sources",
      "audited-revenue.txt",
    );
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceText, "utf8");
    const seeder = new ProjectResearchStoreManager();
    const research = seeder.get(projectRoot);
    const registration = research.documents.registerVersion({
      logicalKey: "audited-revenue",
      sourceRoot: "upload",
      sourceRelpath: "audited-revenue.txt",
      title: "Audited revenue",
      originalFilename: "audited-revenue.txt",
      storedPath: path.relative(projectRoot, sourcePath),
      fileType: "txt",
      mimeType: "text/plain",
      sha256: createHash("sha256").update(sourceText).digest("hex"),
      fileSize: Buffer.byteLength(sourceText),
      status: "indexed",
      activate: true,
    });
    research.evidence.put({
      evidenceId: "chunk:audited-revenue-growth",
      kind: "chunk",
      documentVersionId: registration.version.id,
      originalText: sourceText,
      locator: {
        pageStart: 7,
        headingPath: "Audited financial highlights",
      },
    });
    seeder.close();

    const sessionResponse = await runtime.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        projectId: project.id,
        title: "Evidence question",
      },
    });
    expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
    const session = sessionResponse.json<{ id: string }>();
    const prompt = await runtime.app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/messages`,
      payload: {
        content: "Evidence question: Revenue growth audited period",
        clientMessageId: "evidence-question-1",
      },
    });
    expect(prompt.statusCode, prompt.body).toBe(202);
    const operation = prompt.json<{ operationId: string }>();

    const events = await eventually(
      async () => {
        const response = await runtime?.app.inject({
          method: "GET",
          url: `/v1/sessions/${session.id}/events?stream=0`,
        });
        return response?.json<{ events: SessionEvent[] }>().events ?? [];
      },
      (current) =>
        current.some(
          (event) =>
            event.operationId === operation.operationId &&
            event.type === "operation.completed",
        ),
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "tool.started",
        "tool.completed",
        "message.assistant.delta",
        "operation.completed",
      ]),
    );
    const searchResult = events.find(
      (event) =>
        event.type === "tool.completed" &&
        event.payload.toolName === "evidence.search",
    );
    expect(searchResult?.payload).toMatchObject({
      isError: false,
      result: {
        hits: [
          {
            evidenceId: "chunk:audited-revenue-growth",
            documentId: registration.document.id,
            locator: { page: 7 },
          },
        ],
      },
    });
    const detailResult = events.find(
      (event) =>
        event.type === "tool.completed" &&
        event.payload.toolName === "evidence.get",
    );
    expect(detailResult?.payload).toMatchObject({
      isError: false,
      result: {
        items: [
          {
            evidenceId: "chunk:audited-revenue-growth",
            documentId: registration.document.id,
            content: sourceText,
          },
        ],
      },
    });
    const answer = events
      .filter(
        (event) =>
          event.operationId === operation.operationId &&
          event.type === "message.assistant.delta",
      )
      .map((event) => String(event.payload.delta ?? ""))
      .join("");
    expect(answer).toContain(sourceText);
    expect(answer).toContain(
      `[Evidence: chunk:audited-revenue-growth; document=${registration.document.id}]`,
    );
    expect(answer).not.toContain("Synthetic answer");

    const operationResponse = await runtime.app.inject({
      method: "GET",
      url:
        `/v1/sessions/${session.id}/operations/` +
        operation.operationId,
    });
    expect(operationResponse.statusCode, operationResponse.body).toBe(
      200,
    );
    expect(operationResponse.json()).toMatchObject({
      id: operation.operationId,
      status: "completed",
    });
  });
});
