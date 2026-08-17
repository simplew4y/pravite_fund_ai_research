import { describe, expect, it } from "vitest";

import { errorMessage, toIpcValue } from "../src/serialization.js";

describe("agent IPC serialization", () => {
  it("redacts private-fund model tokens from errors and nested payloads", () => {
    const token = `pfm_${"a".repeat(48)}`;
    expect(errorMessage(new Error(`Gateway rejected ${token}`))).toBe(
      "Gateway rejected [REDACTED]",
    );
    const serialized = JSON.stringify(
      toIpcValue({
        nested: { message: `Authorization: Bearer ${token}` },
        error: new Error(`Failed with ${token}`),
      }),
    );
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("[REDACTED]");
  });
});
