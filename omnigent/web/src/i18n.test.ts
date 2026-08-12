import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_LOCALE_STORAGE_KEY, applyAppLocale, enUS, normalizeAppLocale, zhCN } from "@/i18n";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("application locale resources", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    document.documentElement.lang = "zh-CN";
  });

  it("keeps Chinese and English translation keys aligned", () => {
    expect(leafKeys(enUS).sort()).toEqual(leafKeys(zhCN).sort());
  });

  it("normalizes unsupported locales to Simplified Chinese", () => {
    expect(normalizeAppLocale("fr-FR")).toBe("zh-CN");
    expect(normalizeAppLocale("en-US")).toBe("en-US");
  });

  it("updates the document language and device preference", async () => {
    await applyAppLocale("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });
});
