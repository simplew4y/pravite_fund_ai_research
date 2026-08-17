import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { sealedCloudSessionSchema, type SealedCloudSession } from "./types.js";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export class SessionCipher {
  readonly #key: Buffer;

  public constructor(secret: string) {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Session cookie secret must contain at least 32 bytes");
    }
    this.#key = createHash("sha256").update(secret, "utf8").digest();
  }

  public seal(session: SealedCloudSession): string {
    const payload = Buffer.from(
      JSON.stringify(sealedCloudSessionSchema.parse(session)),
      "utf8",
    );
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(`private-fund-session:v${VERSION}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [String(VERSION), encode(iv), encode(ciphertext), encode(tag)].join(".");
  }

  public open(token: string): SealedCloudSession | null {
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== String(VERSION)) {
      return null;
    }
    try {
      const iv = decode(parts[1] ?? "");
      const ciphertext = decode(parts[2] ?? "");
      const tag = decode(parts[3] ?? "");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        return null;
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(Buffer.from(`private-fund-session:v${VERSION}`, "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return sealedCloudSessionSchema.parse(
        JSON.parse(plaintext.toString("utf8")) as unknown,
      );
    } catch {
      return null;
    }
  }

  public sameToken(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return (
      leftBytes.length === rightBytes.length &&
      timingSafeEqual(leftBytes, rightBytes)
    );
  }
}
