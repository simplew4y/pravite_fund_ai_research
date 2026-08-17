import { describe, expect, it } from "vitest";

import { SessionCipher } from "./session-cipher.js";

describe("SessionCipher", () => {
  it("round-trips a cloud session and rejects tampering", () => {
    const cipher = new SessionCipher("a".repeat(64));
    const token = cipher.seal({
      version: 1,
      accessToken: "access",
      refreshToken: "refresh",
      accessExpiresAt: 2_000_000_000,
      sessionExpiresAt: 2_000_100_000,
      user: {
        id: "4db661dc-937f-4d77-82c8-8c70d1132757",
        email: "user@example.com",
        status: "active",
        is_admin: false,
        is_platform_admin: false,
        data_namespace: "8dbf58b8-1bd5-4f5f-a821-01ffc896e7cc",
        nick_name: null,
        balance_cny: "0.000000",
        last_login_at: null,
        created_at: null,
      },
    });

    expect(cipher.open(token)?.user.email).toBe("user@example.com");
    expect(cipher.open(`${token.slice(0, -2)}aa`)).toBeNull();
  });

  it("requires a strong local cookie secret", () => {
    expect(() => new SessionCipher("short")).toThrow(/at least 32 bytes/);
  });
});
