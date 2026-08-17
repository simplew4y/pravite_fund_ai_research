import { describe, expect, it } from "vitest";

import dict, { dictKeys, translate } from "./dict";

describe("i18n dict", () => {
  it("has zh and en for every key", () => {
    for (const key of dictKeys) {
      const entry = dict[key];
      expect(entry.zh, key).toBeTruthy();
      expect(entry.en, key).toBeTruthy();
    }
  });

  it("translates by lang", () => {
    expect(translate("auth.login", "zh")).toBe("登录");
    expect(translate("auth.login", "en")).toBe("Log in");
  });
});
