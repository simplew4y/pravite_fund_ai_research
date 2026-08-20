import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { AttachmentsBar } from "./Attachments";

const ATTACHMENT_ID = `resource_${"a".repeat(32)}`;

// Must satisfy sessionAttachmentResourceSchema exactly — it is .strict().
const attachmentResource = {
  id: ATTACHMENT_ID,
  object: "session.resource",
  sessionId: "s-1",
  projectId: "p-1",
  kind: "attachment",
  lifecycle: "active",
  name: "notes.md",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  deletedAt: null,
  attachment: {
    filename: "notes.md",
    mimeType: "text/markdown",
    bytes: 120,
    sha256: "a".repeat(64),
  },
};

const page = (items: unknown[]) => ({
  items,
  total: 1,
  limit: 50,
  offset: 0,
  hasMore: false,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AttachmentsBar", () => {
  it("lists existing attachments as chips linking to their content", async () => {
    stubFetch({
      "GET /v1/sessions/s-1/attachments": page([attachmentResource]),
    });
    renderWithQuery(<AttachmentsBar sessionId="s-1" />);

    const link = await screen.findByRole("link", { name: "notes.md" });
    expect(link).toHaveAttribute(
      "href",
      `/v1/sessions/s-1/attachments/${ATTACHMENT_ID}/content`,
    );
    expect(screen.getByText("0KB")).toBeInTheDocument();
  });

  it("deletes an attachment via DELETE and refetches the list", async () => {
    const calls = stubFetch({
      "GET /v1/sessions/s-1/attachments": page([attachmentResource]),
      [`DELETE /v1/sessions/s-1/attachments/${ATTACHMENT_ID}`]: {},
    });
    renderWithQuery(<AttachmentsBar sessionId="s-1" />);

    await screen.findByRole("link", { name: "notes.md" });
    await userEvent.click(screen.getByRole("button", { name: "关闭 notes.md" }));

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === "DELETE" &&
            call.path === `/v1/sessions/s-1/attachments/${ATTACHMENT_ID}`,
        ),
      ).toBe(true);
    });
  });

  it("uploads a picked file as multipart POST", async () => {
    let uploadBody: unknown;
    const calls = stubFetch({
      "GET /v1/sessions/s-1/attachments": page([]),
      "POST /v1/sessions/s-1/attachments": (init?: RequestInit) => {
        uploadBody = init?.body;
        return attachmentResource;
      },
    });
    const { container } = renderWithQuery(<AttachmentsBar sessionId="s-1" />);

    // Empty list and no error: only the paperclip button renders.
    expect(await screen.findByRole("button", { name: "附件" })).toBeEnabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("file input not rendered");
    const file = new File(["# memo"], "notes.md", { type: "text/markdown" });
    await userEvent.upload(input, file);

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.path === "/v1/sessions/s-1/attachments",
        ),
      ).toBe(true);
    });
    expect(uploadBody).toBeInstanceOf(FormData);
    expect((uploadBody as FormData).get("file")).toBeInstanceOf(File);
  });
});
