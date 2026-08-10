// Tests for RegisterPage (the /register?invite=… invite-redemption page).
//
// Mirrors LoginPage.test.tsx: window.location.href is stubbed so success
// navigation is observable without jsdom navigating. The page calls
// register() from accountsApi; success hard-navigates to "/", failure shows a
// role="alert". The page also gates on the invite query param (missing → alert,
// no form).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterPage } from "./RegisterPage";
import * as accountsApi from "@/lib/accountsApi";
import { CapabilitiesContext } from "@/lib/CapabilitiesContext";

vi.mock("@/lib/accountsApi", () => ({
  clearUserScopedBrowserState: vi.fn(),
  register: vi.fn(),
  sendRegistrationCode: vi.fn(),
}));

const ORIGIN = "https://app.example.com";
let hrefWrites: string[];
let originalLocation: Location;

function renderRegisterAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/register${search}`]}>
      <RegisterPage />
    </MemoryRouter>,
  );
}

function renderCloudRegister() {
  return render(
    <CapabilitiesContext.Provider
      value={{
        accounts_enabled: true,
        cloud_accounts_enabled: true,
        login_url: "/login",
        needs_setup: false,
        registration_mode: "open",
        databricks_features: false,
        managed_sandboxes_enabled: false,
        sandbox_provider: null,
        server_version: "test",
        smart_routing_enabled: false,
        llm_configuration_enabled: true,
      }}
    >
      <MemoryRouter initialEntries={["/register"]}>
        <RegisterPage />
      </MemoryRouter>
    </CapabilitiesContext.Provider>,
  );
}

function fillForm(username: string, password: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: username } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: confirm } });
}

beforeEach(() => {
  hrefWrites = [];
  originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      origin: ORIGIN,
      set href(value: string) {
        hrefWrites.push(value);
      },
      get href() {
        return hrefWrites[hrefWrites.length - 1] ?? `${ORIGIN}/register`;
      },
    },
  });
  vi.mocked(accountsApi.register).mockResolvedValue({
    ok: true,
    user: { id: "alice", is_admin: false },
    token: "t",
    expires_in: 3600,
  });
  vi.mocked(accountsApi.sendRegistrationCode).mockResolvedValue({
    ok: true,
    expires_in: 300,
    resend_after: 60,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("RegisterPage", () => {
  it("shows an invite-required alert and no form when the invite token is missing", () => {
    renderRegisterAt("");
    expect(screen.getByRole("alert", { name: /invite token/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
  });

  it("renders the form when an invite token is present", () => {
    renderRegisterAt("?invite=tok123");
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
  });

  it("disables submit until a username and an 8+ char password are entered", () => {
    renderRegisterAt("?invite=tok123");
    const submit = screen.getByRole("button", { name: /create account/i });
    expect(submit).toBeDisabled();

    fillForm("alice", "short", "short");
    expect(submit).toBeDisabled(); // password < 8

    fillForm("alice", "longenough", "longenough");
    expect(submit).toBeEnabled();
  });

  it("blocks submit and shows an error when the passwords don't match", () => {
    renderRegisterAt("?invite=tok123");
    fillForm("alice", "longenough", "different1");
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(screen.getByRole("alert")).toHaveTextContent("两次输入的密码不一致。");
    expect(accountsApi.register).not.toHaveBeenCalled();
  });

  it("redeems the invite and navigates home on success", async () => {
    renderRegisterAt("?invite=tok123");
    fillForm("alice", "longenough", "longenough");
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(accountsApi.register).toHaveBeenCalledWith({
        invite: "tok123",
        username: "alice",
        password: "longenough",
      }),
    );
    await waitFor(() => expect(hrefWrites[0]).toBe("/"));
  });

  it("surfaces the server error on failure and does not navigate", async () => {
    vi.mocked(accountsApi.register).mockResolvedValue({
      ok: false,
      error: "invite expired",
      status: 400,
    });
    renderRegisterAt("?invite=tok123");
    fillForm("alice", "longenough", "longenough");
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invite expired");
    expect(hrefWrites).toHaveLength(0);
  });

  it("sends a cloud email code and registers without exposing cloud tokens", async () => {
    renderCloudRegister();
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: " Cloud@Example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));

    await waitFor(() =>
      expect(accountsApi.sendRegistrationCode).toHaveBeenCalledWith("cloud@example.com"),
    );
    expect(screen.getByText(/验证码已发送/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/verification code/i), {
      target: { value: "12a3456" },
    });
    fireEvent.change(screen.getByLabelText(/nickname/i), {
      target: { value: " Cloud Researcher " },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "longenough" },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: "longenough" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(accountsApi.register).toHaveBeenCalledWith({
        email: "cloud@example.com",
        code: "123456",
        password: "longenough",
        nick_name: "Cloud Researcher",
      }),
    );
    await waitFor(() => expect(hrefWrites[0]).toBe("/"));
  });

  it("highlights a duplicate email and preserves valid cloud registration input", async () => {
    vi.mocked(accountsApi.register).mockResolvedValue({
      ok: false,
      error: "email already registered",
      code: "email_exists",
      status: 409,
    });
    renderCloudRegister();

    const email = screen.getByLabelText(/email/i);
    const code = screen.getByLabelText(/verification code/i);
    const nickname = screen.getByLabelText(/nickname/i);
    fireEvent.change(email, { target: { value: "existing@example.com" } });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.change(nickname, { target: { value: "研究员" } });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "Valid-Password1!" },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: "Valid-Password1!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(accountsApi.register).toHaveBeenCalled());
    expect(screen.getByRole("alert")).toHaveTextContent("该邮箱已被注册");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveValue("existing@example.com");
    expect(code).toHaveValue("123456");
    expect(nickname).toHaveValue("研究员");
    expect(hrefWrites).toHaveLength(0);
  });
});
