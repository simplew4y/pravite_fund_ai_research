import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { AccountDialog } from "./AccountDialog";

const infoDisabled = {
  auth_mode: "development",
  accounts_enabled: false,
  registration_mode: null,
  durable_jobs: true,
  research_store: true,
  workflow_store: true,
  insights_store: false,
};

const infoEnabled = { ...infoDisabled, auth_mode: "cloud", accounts_enabled: true };

const usage = {
  items: [],
  summary: {
    request_count: 42,
    prompt_tokens: 1000,
    completion_tokens: 2000,
    total_tokens: 34567,
    charged_amount_cny: "12.34",
  },
  page: 1,
  page_size: 20,
};

const balances = {
  items: [{ id: "rec-0001-abcdef", amount_cny: "50.00" }],
  page: 1,
  page_size: 20,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountDialog", () => {
  it("shows only the unavailable notice when accounts are disabled", async () => {
    stubFetch({ "GET /v1/info": infoDisabled });
    renderWithQuery(<AccountDialog onClose={vi.fn()} />);
    expect(
      await screen.findByText("本地模式下云账号功能不可用"),
    ).toBeInTheDocument();
    expect(screen.queryByText("请求数")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交" })).not.toBeInTheDocument();
  });

  it("renders usage numbers and balance records when accounts are enabled", async () => {
    stubFetch({
      "GET /v1/info": infoEnabled,
      "GET /v1/account/usage": usage,
      "GET /v1/account/balance-records": balances,
    });
    renderWithQuery(<AccountDialog onClose={vi.fn()} />);
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("34567")).toBeInTheDocument();
    expect(screen.getByText("12.34")).toBeInTheDocument();
    expect(screen.getByText("rec-0001-abc…")).toBeInTheDocument();
    expect(screen.getByText("50.00")).toBeInTheDocument();
  });

  it("submits feedback with feedback_type general and confirms", async () => {
    const calls = stubFetch({
      "GET /v1/info": infoEnabled,
      "GET /v1/account/usage": usage,
      "GET /v1/account/balance-records": balances,
      "POST /v1/account/feedback": {},
    });
    renderWithQuery(<AccountDialog onClose={vi.fn()} />);
    await userEvent.type(await screen.findByPlaceholderText("标题"), "上传很慢");
    await userEvent.type(screen.getByPlaceholderText("内容"), "大文件索引要十分钟");
    await userEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(await screen.findByText("已提交，感谢反馈")).toBeInTheDocument();
    expect(calls).toContainEqual({
      method: "POST",
      path: "/v1/account/feedback",
      body: { feedback_type: "general", title: "上传很慢", content: "大文件索引要十分钟" },
    });
  });

  it("shows the server message when changing the password fails", async () => {
    stubFetch({
      "GET /v1/info": infoEnabled,
      "GET /v1/account/usage": usage,
      "GET /v1/account/balance-records": balances,
      "POST /auth/users/me/password": () =>
        new Response(
          JSON.stringify({ error: "invalid_password", message: "旧密码不正确" }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    renderWithQuery(<AccountDialog onClose={vi.fn()} />);
    await userEvent.type(await screen.findByPlaceholderText("当前密码"), "old-pass-1");
    await userEvent.type(
      screen.getByPlaceholderText("新密码（至少 8 位）"),
      "new-pass-123",
    );
    await userEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(await screen.findByText("旧密码不正确")).toBeInTheDocument();
  });
});
