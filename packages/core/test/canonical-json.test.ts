import { describe, expect, it } from "vitest";

import {
  CanonicalJsonError,
  canonicalJsonSha256,
  canonicalizeJson,
} from "../src/index.js";

describe("canonical JSON", () => {
  it("is stable across object insertion order and normalizes negative zero", () => {
    const left = { z: [3, { b: true, a: "value" }], a: -0 };
    const right = { a: 0, z: [3, { a: "value", b: true }] };

    expect(canonicalizeJson(left)).toBe(
      '{"a":0,"z":[3,{"a":"value","b":true}]}',
    );
    expect(canonicalJsonSha256(left)).toBe(canonicalJsonSha256(right));
  });

  it("rejects values that JSON.stringify would silently lose or coerce", () => {
    expect(() => canonicalizeJson({ unsafe: undefined })).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalizeJson([Number.NaN])).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(new Date())).toThrow(CanonicalJsonError);

    const symbolKeyed = { safe: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("hidden")] = "not serialized by JSON.stringify";
    expect(() => canonicalizeJson(symbolKeyed)).toThrow(CanonicalJsonError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(CanonicalJsonError);
  });
});
