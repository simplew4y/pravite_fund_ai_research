"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const llm = require("../src/llm_settings");

function encryption() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
}

describe("llm_settings", () => {
  it("normalizes provider presets and validates URLs", () => {
    assert.deepEqual(llm.validateInput({ preset: "deepseek", model: "deepseek-chat" }), {
      preset: "deepseek",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });
    assert.throws(
      () => llm.validateInput({ preset: "custom", baseUrl: "file:///tmp/model", model: "x" }),
      /HTTP or HTTPS/,
    );
  });

  it("encrypts API keys and never exposes plaintext in the public view", () => {
    const saved = llm.saveConfig(
      {},
      { preset: "dashscope", model: "qwen3-max", apiKey: "secret-key" },
      encryption(),
    );
    assert.equal(saved.llm_provider.api_key_encrypted.includes("secret-key"), false);
    assert.deepEqual(llm.publicConfig(saved), {
      preset: "dashscope",
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-max",
      hasApiKey: true,
      configured: true,
    });
    assert.equal(llm.runtimeConfig(saved, encryption()).apiKey, "secret-key");
    assert.equal(llm.maskApiKey("sk-bab1234567890d2"), "sk-bab*****************d2");
  });

  it("preserves an existing key when the edit form leaves it blank", () => {
    const first = llm.saveConfig(
      {},
      { preset: "dashscope", model: "qwen3-max", apiKey: "secret-key" },
      encryption(),
    );
    const second = llm.saveConfig(
      first,
      { preset: "deepseek", model: "deepseek-chat", apiKey: "" },
      encryption(),
    );
    assert.equal(llm.runtimeConfig(second, encryption()).apiKey, "secret-key");
  });

  it("requires whole-key replacement and does not support clearing a stored key", () => {
    const first = llm.saveConfig(
      {},
      { preset: "dashscope", model: "qwen3-max", apiKey: "secret-key" },
      encryption(),
    );
    const preserved = llm.saveConfig(
      first,
      { preset: "dashscope", model: "qwen3-max", apiKey: "" },
      encryption(),
    );
    assert.equal(llm.runtimeConfig(preserved, encryption()).apiKey, "secret-key");
  });
});
