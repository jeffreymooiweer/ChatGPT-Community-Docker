"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const upstream = process.env.UPSTREAM_SOURCE;
if (!upstream) throw new Error("UPSTREAM_SOURCE must point to the checked-out Linux wrapper");
const descriptors = require(path.join(upstream, "linux-features/remote-mobile-control/patch.js"));
const descriptor = descriptors.find((entry) => entry.id === "linux-remote-control-visibility");
const source = "function s({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
const splitAsset = "remote-control-connections-visibility-a07582a4850b.js";

test("locates the split visibility asset in official 26.924.50649", () => {
  assert.ok(descriptor.pattern.test(splitAsset));
  assert.ok(descriptor.assetMatch(source));
  assert.ok(descriptor.pattern.test("remote-control-connections-visibility-futurehash.js"));
  assert.ok(descriptor.pattern.test("app-initial-previoushash.js"));
  // Filenames may change. Upstream searches all JS assets but only selects
  // the unique function matching the access-gate contract, not arbitrary JS.
  const selects = (name, text) => descriptor.pattern.test(name) && descriptor.assetMatch(text);
  assert.equal(selects("remote-connections-settings-fixture.js", "function settings(){return true}"), false);
  assert.equal(selects("unrelated.js", "function unrelated(){return true}"), false);
});

test("rejects missing, ambiguous and changed access gates", () => {
  assert.equal(descriptor.assetMatch("function unrelated(){return true}"), false);
  assert.equal(descriptor.assetMatch(source + source), false);
  assert.equal(descriptor.assetMatch(source.replace("&&e?.accessRequired!==!0", "")), false);
  assert.equal(descriptor.assetMatch(source.replace("accessRequired!==!0", "accessRequired===!0")), false);
});

test("patch is idempotent and preserves access restrictions and non-Linux behavior", () => {
  const patched = descriptor.apply(source);
  assert.notEqual(patched, source);
  assert.ok(descriptor.assetMatch(patched));
  assert.equal(descriptor.apply(patched), patched);
  for (const ua of ["Linux", "Windows", "Macintosh"]) {
    const original = vm.runInNewContext(source + ";s", { navigator: { userAgent: ua } });
    const updated = vm.runInNewContext(patched + ";s", { navigator: { userAgent: ua } });
    for (const state of [undefined, {}, { available: false }, { available: true },
      { accessRequired: true }, { available: true, accessRequired: true },
      { available: false, accessRequired: false }]) {
      for (const enabled of [false, true]) {
        const args = { remoteControlConnectionsState: state, slingshotEnabled: enabled };
        if (state?.accessRequired === true) assert.equal(updated(args), false);
        else if (ua === "Linux") assert.equal(updated(args), true);
        else assert.equal(updated(args), original(args));
      }
    }
  }
});
