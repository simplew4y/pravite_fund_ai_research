import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery, stubFetch } from "../../test-utils";
import { LoginGate } from "./LoginGate";

const baseInfo = {
  auth_mode: "development",
  accounts_enabled: false,
  registration_mode: null,
  durable_jobs: true,
  research_store: true,
  workflow_store: true,
  insights_store: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("LoginGate", () => {
  it("renders children directly in development mode", async () => {
    stubFetch({ "GET /v1/info": baseInfo });
    renderWithQuery(
      <LoginGate>
        <p>content</p>
      </LoginGate>,
    );
    expect(await screen.findByText("content")).toBeInTheDocument();
  });

  it("shows the login form when cloud accounts reject the session", async () => {
    stubFetch({
      "GET /v1/info": { ...baseInfo, auth_mode: "cloud", accounts_enabled: true },
    });
    renderWithQuery(
      <LoginGate>
        <p>content</p>
      </LoginGate>,
    );
    expect(await screen.findByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("supports registration: send code then submit", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const calls = stubFetch({
      "GET /v1/info": { ...baseInfo, auth_mode: "cloud", accounts_enabled: true },
      "POST /auth/register/send-code": { detail: "sent" },
      "POST /auth/register": { user: { id: "u-1", email: "a@b.co" } },
    });
    renderWithQuery(
      <LoginGate>
        <p>content</p>
      </LoginGate>,
    );
    await userEvent.click(await screen.findByRole("tab", { name: "注册" }));
    await userEvent.type(screen.getByLabelText("邮箱"), "a@b.co");
    await userEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await userEvent.type(screen.getByLabelText("邮箱验证码"), "1234");
    await userEvent.type(screen.getByLabelText("密码"), "password123");
    await userEvent.click(screen.getByRole("button", { name: "注册" }));
    expect(
      calls.filter((call) => call.path === "/auth/register/send-code"),
    ).toHaveLength(1);
    const registerCall = calls.find((call) => call.path === "/auth/register");
    expect(registerCall?.body).toMatchObject({
      email: "a@b.co",
      code: "1234",
      password: "password123",
    });
  });

  it("supports password reset and returns to login", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const calls = stubFetch({
      "GET /v1/info": { ...baseInfo, auth_mode: "cloud", accounts_enabled: true },
      "POST /auth/password/reset/send-code": { detail: "sent" },
      "POST /auth/password/reset": { detail: "ok" },
    });
    renderWithQuery(
      <LoginGate>
        <p>content</p>
      </LoginGate>,
    );
    await userEvent.click(await screen.findByRole("tab", { name: "忘记密码" }));
    await userEvent.type(screen.getByLabelText("邮箱"), "a@b.co");
    await userEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await userEvent.type(screen.getByLabelText("邮箱验证码"), "567890");
    await userEvent.type(screen.getByLabelText("新密码（至少 8 位）"), "newpassword1");
    await userEvent.click(screen.getByRole("button", { name: "重置密码" }));
    expect(
      calls.find((call) => call.path === "/auth/password/reset")?.body,
    ).toMatchObject({ email: "a@b.co", code: "567890", password: "newpassword1" });
    // Back on the login tab with a success notice.
    expect(await screen.findByText("密码已重置，请用新密码登录")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "登录", selected: true })).toBeInTheDocument();
  });
});
