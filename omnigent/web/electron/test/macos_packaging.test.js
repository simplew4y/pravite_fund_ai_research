"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const electronDir = path.join(__dirname, "..");
const config = require("../electron-builder.mac-internal");

describe("macOS internal packaging", () => {
  it("uses ad-hoc signing without a provisioning profile or notarization", () => {
    assert.equal(config.mac.identity, "-");
    assert.equal(config.mac.provisioningProfile, undefined);
    assert.equal(config.mac.notarize, false);
    assert.equal(config.mac.hardenedRuntime, false);
    assert.equal(config.mac.minimumSystemVersion, "12.0");
    assert.equal(config.extraMetadata.omnigentInternalAdhocBuild, true);
    assert.deepEqual(config.mac.target, ["dmg", "zip"]);
  });

  it("does not grant the restricted WebAuthn keychain access group", () => {
    const entitlements = fs.readFileSync(
      path.join(electronDir, config.mac.entitlements),
      "utf8",
    );
    assert.doesNotMatch(entitlements, /keychain-access-groups/);
    assert.doesNotMatch(entitlements, /8RMX4WU6F8/);
  });
});
