const MAX_RAW_ERROR_LENGTH = 8_192;
const MAX_SAFE_ERROR_LENGTH = 512;
const REDACTED = "[REDACTED]";

const AUTHORIZATION_VALUE_PATTERN =
  /(["']?authorization["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/giu;
const NAMED_CREDENTIAL_VALUE_PATTERN =
  /(["']?(?:api[-_ ]?key|x-api-key|access[-_ ]?token|refresh[-_ ]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]&]+)/giu;
const UNASSIGNED_API_KEY_PATTERN =
  /\b(api[-_ ]?key)\s+(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[A-Za-z0-9._-]{8,})/giu;
const BEARER_VALUE_PATTERN = /\bBearer\s+[^\s,;]+/giu;
const PREFIXED_SECRET_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|pfm_[A-Za-z0-9._-]{8,})\b/giu;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  try {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converts an unknown failure into a short, single-line diagnostic suitable for
 * crossing the worker boundary. Raw errors and stacks are intentionally not
 * retained because provider failures may echo credentials.
 */
export function safeErrorMessage(error: unknown): string | undefined {
  const rawMessage = errorMessage(error)?.slice(0, MAX_RAW_ERROR_LENGTH);
  if (rawMessage === undefined) {
    return undefined;
  }

  const redacted = redactSensitiveText(rawMessage)
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (redacted.length === 0) {
    return undefined;
  }
  if (redacted.length <= MAX_SAFE_ERROR_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_SAFE_ERROR_LENGTH - 1)}…`;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_PATTERN, `$1${REDACTED}`)
    .replace(NAMED_CREDENTIAL_VALUE_PATTERN, `$1${REDACTED}`)
    .replace(UNASSIGNED_API_KEY_PATTERN, `$1 ${REDACTED}`)
    .replace(BEARER_VALUE_PATTERN, `Bearer ${REDACTED}`)
    .replace(PREFIXED_SECRET_PATTERN, REDACTED);
}
