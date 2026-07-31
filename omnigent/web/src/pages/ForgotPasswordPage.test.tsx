import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as accountsApi from "@/lib/accountsApi";
import { ForgotPasswordPage } from "./ForgotPasswordPage";

vi.mock("@/lib/accountsApi", () => ({
  sendPasswordResetCode: vi.fn(),
  resetPassword: vi.fn(),
}));

let originalLocation: Location;
let hrefWrites: string[];

beforeEach(() => {
  originalLocation = window.location;
  hrefWrites = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      set href(value: string) {
        hrefWrites.push(value);
      },
      get href() {
        return hrefWrites[hrefWrites.length - 1] ?? "/forgot-password";
      },
    },
  });
  vi.mocked(accountsApi.sendPasswordResetCode).mockResolvedValue({
    ok: true,
    expires_in: 300,
    resend_after: 60,
  });
  vi.mocked(accountsApi.resetPassword).mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("ForgotPasswordPage", () => {
  it("sends a code and resets the password with six normalized digits", async () => {
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: " Researcher@Example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await waitFor(() =>
      expect(accountsApi.sendPasswordResetCode).toHaveBeenCalledWith(
        "Researcher@Example.com",
      ),
    );

    fireEvent.change(screen.getByLabelText("邮箱验证码"), {
      target: { value: "12a3456" },
    });
    fireEvent.change(screen.getByLabelText("新密码"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByLabelText("确认新密码"), {
      target: { value: "new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));

    await waitFor(() =>
      expect(accountsApi.resetPassword).toHaveBeenCalledWith({
        email: "Researcher@Example.com",
        code: "123456",
        new_password: "new-password",
      }),
    );
    expect(hrefWrites).toContain("/login?password=reset");
  });

  it("keeps the form open when password confirmation differs", async () => {
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await screen.findByLabelText("邮箱验证码");
    fireEvent.change(screen.getByLabelText("邮箱验证码"), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "different" } });
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("两次输入的密码不一致。");
    expect(accountsApi.resetPassword).not.toHaveBeenCalled();
  });
});
