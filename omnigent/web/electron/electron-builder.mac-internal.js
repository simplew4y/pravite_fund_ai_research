"use strict";

// Internal Apple Silicon distribution. The existing package.json mac config
// remains the source of truth for a future Developer ID/notarized release.
const base = require("./package.json").build;
const {
  identity: _identity,
  provisioningProfile: _provisioningProfile,
  entitlements: _entitlements,
  entitlementsInherit: _entitlementsInherit,
  ...baseMac
} = base.mac;

module.exports = {
  ...base,
  forceCodeSigning: false,
  extraMetadata: {
    omnigentInternalAdhocBuild: true,
  },
  mac: {
    ...baseMac,
    target: ["dmg", "zip"],
    artifactName: "${productName}-${version}-${arch}.${ext}",
    identity: "-",
    hardenedRuntime: false,
    entitlements: "build/entitlements.mac.internal.plist",
    entitlementsInherit: "build/entitlements.mac.internal.inherit.plist",
    notarize: false,
    gatekeeperAssess: false,
    minimumSystemVersion: "12.0",
  },
};
