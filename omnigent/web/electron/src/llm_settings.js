"use strict";

const PRESETS = Object.freeze({
  dashscope: Object.freeze({
    provider: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  }),
  deepseek: Object.freeze({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
  }),
  openai: Object.freeze({
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  }),
  anthropic: Object.freeze({
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
  }),
  // Keep generic OpenAI-compatible services on Chat Completions. Using the
  // native `openai` provider makes LiteLLM auto-route thinking turns to the
  // Responses API, which many compatible gateways do not implement.
  custom: Object.freeze({ provider: "custom_openai", baseUrl: "" }),
});

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function maskApiKey(value) {
  const key = cleanText(value);
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}*****************${key.slice(-1)}`;
  return `${key.slice(0, 6)}*****************${key.slice(-2)}`;
}

function validateInput(input) {
  const preset = cleanText(input?.preset);
  const definition = PRESETS[preset];
  if (!definition) throw new Error("Unsupported model provider.");

  const model = cleanText(input?.model);
  if (!model) throw new Error("Model name is required.");

  const baseUrl = cleanText(input?.baseUrl) || definition.baseUrl;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Base URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Base URL must use HTTP or HTTPS.");
  }

  return {
    preset,
    provider: definition.provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
  };
}

function decryptApiKey(record, encryption) {
  const encoded = cleanText(record?.api_key_encrypted);
  if (!encoded) return "";
  try {
    return encryption.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return "";
  }
}

function publicConfig(settings) {
  const record = settings?.llm_provider;
  if (!record || typeof record !== "object") {
    return {
      preset: "dashscope",
      provider: PRESETS.dashscope.provider,
      baseUrl: PRESETS.dashscope.baseUrl,
      model: "qwen3-max",
      hasApiKey: false,
      configured: false,
    };
  }
  const preset = PRESETS[record.preset] ? record.preset : "custom";
  const definition = PRESETS[preset];
  return {
    preset,
    provider: definition.provider,
    baseUrl: cleanText(record.base_url) || definition.baseUrl,
    model: cleanText(record.model),
    hasApiKey: Boolean(cleanText(record.api_key_encrypted)),
    configured: Boolean(cleanText(record.model) && cleanText(record.api_key_encrypted)),
  };
}

function runtimeConfig(settings, encryption) {
  const view = publicConfig(settings);
  const apiKey = decryptApiKey(settings?.llm_provider, encryption);
  return {
    preset: view.preset,
    provider: view.provider,
    baseUrl: view.baseUrl,
    model: view.model || "qwen3-max",
    apiKey,
    configured: Boolean(view.model && apiKey),
  };
}

function candidateConfig(settings, input, encryption) {
  const normalized = validateInput(input);
  const suppliedKey = cleanText(input?.apiKey);
  const existingKey = decryptApiKey(settings?.llm_provider, encryption);
  return {
    ...normalized,
    apiKey: suppliedKey || existingKey,
  };
}

function saveConfig(settings, input, encryption) {
  const candidate = candidateConfig(settings, input, encryption);
  if (!candidate.apiKey) throw new Error("API Key is required.");
  if (candidate.apiKey && !encryption.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this device.");
  }
  const encrypted = candidate.apiKey
    ? encryption.encryptString(candidate.apiKey).toString("base64")
    : "";
  return {
    ...settings,
    llm_provider: {
      preset: candidate.preset,
      provider: candidate.provider,
      base_url: candidate.baseUrl,
      model: candidate.model,
      api_key_encrypted: encrypted,
    },
  };
}

module.exports = {
  PRESETS,
  validateInput,
  publicConfig,
  runtimeConfig,
  candidateConfig,
  saveConfig,
  maskApiKey,
};
