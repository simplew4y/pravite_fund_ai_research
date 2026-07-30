import { beforeEach, describe, expect, it } from "vitest";
import {
  accountDisplayName,
  clearUserScopedBrowserState,
  maskedAccountEmail,
  type CurrentAccount,
} from "./accountsApi";

function account(overrides: Partial<CurrentAccount> = {}): CurrentAccount {
  return {
    id: "user-1",
    is_admin: false,
    email: "researcher@example.com",
    ...overrides,
  };
}

describe("account display helpers", () => {
  it("uses a trimmed nickname when one is present", () => {
    expect(accountDisplayName(account({ nick_name: "  张三  " }))).toBe("张三");
  });

  it("uses the full email when the nickname is empty", () => {
    expect(accountDisplayName(account({ nick_name: " " }))).toBe("researcher@example.com");
  });

  it("masks a non-email account identifier", () => {
    expect(maskedAccountEmail("local-user")).toBe("lo***");
  });
});

describe("clearUserScopedBrowserState", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("clears user-scoped state from both persistent and session storage", () => {
    window.localStorage.setItem("omnigent.privateFund.activeProject", "project-a");
    window.localStorage.setItem("omnigent.llmConfigPrompt.dismissed", "1");
    window.sessionStorage.setItem("unrelated", "keep");

    clearUserScopedBrowserState();

    expect(window.localStorage.getItem("omnigent.privateFund.activeProject")).toBeNull();
    expect(window.localStorage.getItem("omnigent.llmConfigPrompt.dismissed")).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
  });
});
