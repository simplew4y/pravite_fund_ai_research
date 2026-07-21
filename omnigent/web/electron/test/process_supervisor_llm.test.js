"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const supervisor = require("../src/process_supervisor");

describe("process_supervisor LLM configuration", () => {
  it("maps a user provider to child environment variables", () => {
    assert.deepEqual(
      supervisor.llmRuntimeEnv({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "secret",
        model: "deepseek-chat",
        configured: true,
      }),
      {
        LITELLM_TARGET_PROVIDER: "deepseek",
        LITELLM_TARGET_API_BASE: "https://api.deepseek.com/v1",
        LITELLM_TARGET_API_KEY: "secret",
        LITELLM_TARGET_MODEL_NAME: "deepseek-chat",
        LLM_PROVIDER_CONFIGURED: "1",
      },
    );
  });

  it("writes a model map without persisting the API key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-litellm-"));
    const target = supervisor.writeGeneratedLiteLlmConfig({
      OMNIGENT_CONFIG_HOME: dir,
      LITELLM_TARGET_PROVIDER: "deepseek",
      LITELLM_TARGET_MODEL_NAME: "deepseek-chat",
      LITELLM_TARGET_API_KEY: "must-not-be-written",
    });
    const text = fs.readFileSync(target, "utf8");
    assert.match(text, /deepseek\/deepseek-chat/);
    assert.match(text, /model_name: "private-fund-default"/);
    assert.match(text, /os\.environ\/LITELLM_TARGET_API_KEY/);
    assert.doesNotMatch(text, /must-not-be-written/);
  });

  it("routes chat, pipeline and PDF research through the local gateway", () => {
    const env = supervisor.nativeChildEnv(
      {
        LITELLM_HOST: "127.0.0.1",
        LITELLM_PORT: "4000",
        LITELLM_TARGET_MODEL_NAME: "qwen3-max",
      },
      "C:\\runtime",
      "C:\\runtime\\project",
    );
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4000");
    assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:4000/v1");
    assert.equal(env.LLM_BASE_URL, "http://127.0.0.1:4000/v1");
    assert.equal(env.PDF_RESEARCH_LLM_BASE_URL, "http://127.0.0.1:4000/v1");
    assert.equal(env.ANTHROPIC_MODEL, "private-fund-default");
    assert.equal(env.LLM_MODEL_NAME, "private-fund-default");
    assert.equal(env.PDF_RESEARCH_LLM_MODEL, "private-fund-default");
  });

  it("uses the platform sidecar selected by the runtime layout", () => {
    const root = path.join(os.tmpdir(), "runtime");
    const env = supervisor.nativeChildEnv({}, root, path.join(root, "project"));
    const expected = process.platform === "win32" ? "claude-haha.exe" : "claude-haha";
    assert.equal(env.HARNESS_CC_HAHA_PATH, path.join(root, "bin", expected));
  });

  it("restores the previous gateway when the replacement cannot start", async () => {
    const calls = [];
    const result = await supervisor._swapWithRollback(
      async () => calls.push("stop"),
      async () => {
        calls.push("next");
        return false;
      },
      async () => {
        calls.push("previous");
        return true;
      },
    );
    assert.deepEqual(calls, ["stop", "next", "stop", "previous"]);
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
  });
});
