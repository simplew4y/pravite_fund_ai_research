import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { useUiStore } from "../../store/ui";
import { ChatView } from "./ChatView";

const session = {
  id: "s-1",
  projectId: "p-1",
  title: "集采影响",
  status: "idle" as const,
  archivedAt: null,
  forkedFromSessionId: null,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  lastSequence: 3,
};

const resource = {
  id: "resource_0123456789abcdef0123456789abcdef",
  object: "session.resource",
  sessionId: "s-1",
  projectId: "p-1",
  lifecycle: "active",
  name: "2025 年报.pdf",
  kind: "document_reference",
  documentReference: { documentId: "doc_1", versionId: "ver_1" },
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  deletedAt: null,
};

function userMessageEvent(text: string) {
  return {
    sessionId: "s-1",
    sequence: 2,
    type: "message.user",
    timestamp: "2026-08-18T00:00:00.000Z",
    operationId: "op-1",
    payload: { content: text, clientMessageId: "msg-1" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  useUiStore.setState({ expandedSessionId: null, lang: "zh" });
});

describe("ChatView", () => {
  it("renders the user's own message text from the server payload", async () => {
    stubFetch({
      "GET /v1/sessions/s-1/events": { events: [userMessageEvent("集采影响？")] },
      "GET /v1/sessions/s-1/resources": {
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      },
    });
    renderWithQuery(<ChatView session={session} />);
    expect(await screen.findByText("集采影响？")).toBeInTheDocument();
  });

  it("removes a context chip through the canonical resource route", async () => {
    const calls = stubFetch({
      "GET /v1/sessions/s-1/events": { events: [] },
      "GET /v1/sessions/s-1/resources": {
        items: [resource],
        total: 1,
        limit: 50,
        offset: 0,
        hasMore: false,
      },
      "DELETE /v1/sessions/s-1/resources/resource_0123456789abcdef0123456789abcdef": {
        id: "resource_0123456789abcdef0123456789abcdef",
        object: "session.resource.deleted",
        kind: "document_reference",
        deleted: true,
        deletedAt: "2026-08-18T00:01:00.000Z",
      },
    });
    renderWithQuery(<ChatView session={session} />);
    await userEvent.click(await screen.findByText("2025 年报.pdf"));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "DELETE" &&
            call.path ===
              "/v1/sessions/s-1/resources/resource_0123456789abcdef0123456789abcdef",
        ),
      ).toBe(true),
    );
  });

  it("queues a follow-up through steer while a turn is running", async () => {
    const calls = stubFetch({
      "GET /v1/sessions/s-1/events": {
        events: [
          userMessageEvent("第一问"),
          {
            sessionId: "s-1",
            sequence: 3,
            type: "session.status",
            timestamp: "2026-08-18T00:00:01.000Z",
            operationId: null,
            payload: { status: "running" },
          },
        ],
      },
      "GET /v1/sessions/s-1/resources": {
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      },
      "POST /v1/sessions/s-1/steer": { ok: true },
    });
    renderWithQuery(<ChatView session={session} />);
    await screen.findByText("第一问");
    await userEvent.type(
      screen.getByPlaceholderText(/继续追问/),
      "追问一句",
    );
    await userEvent.click(screen.getByRole("button", { name: /排队发送|发送/ }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.path === "/v1/sessions/s-1/steer")?.body,
      ).toMatchObject({ content: "追问一句" }),
    );
    expect(
      calls.some((call) => call.path === "/v1/sessions/s-1/messages"),
    ).toBe(false);
  });
});
