"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const upstream = process.env.UPSTREAM_SOURCE;
if (!upstream) throw new Error("UPSTREAM_SOURCE must point to the checked-out Linux wrapper");
const descriptors = require(path.join(upstream, "linux-features/remote-mobile-control/patch.js"));
const descriptor = descriptors.find((entry) => entry.id === "linux-remote-control-visibility");
assert.ok(descriptor, "Upstream must provide the remote-control visibility patch");
assert.equal(typeof descriptor.apply, "function");
const source = "function s({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
const marker = "codexLinuxRemoteControlVisibilityEnabled";

// Older wrappers select a unique contract with a filename pattern. Current
// rspack wrappers find every copied module through stable content needles.
// Both routes must still pass the independent access-gate behavior checks.
function selects(name, text) {
  const pattern = descriptor.assetPattern ?? descriptor.pattern;
  const needles = descriptor.assetNeedles;
  assert.ok(pattern instanceof RegExp || Array.isArray(needles),
    "Visibility discovery must declare a filename pattern or content needles");
  if (pattern != null) {
    assert.ok(pattern instanceof RegExp);
    pattern.lastIndex = 0;
    if (!pattern.test(path.posix.basename(name))) return false;
  }
  if (needles != null) {
    assert.ok(Array.isArray(needles) && needles.length > 0);
    assert.ok(needles.every((needle) => typeof needle === "string" && needle.length > 0));
    if (!needles.every((needle) => text.includes(needle))) return false;
  }
  if (descriptor.assetMatch != null) {
    assert.equal(typeof descriptor.assetMatch, "function");
    return descriptor.assetMatch(text, name, {});
  }
  return true;
}

function patchQuietly(text) {
  const warn = console.warn;
  const warnings = [];
  try {
    console.warn = (...args) => warnings.push(args.join(" "));
    return { result: descriptor.apply(text), warnings };
  } finally {
    console.warn = warn;
  }
}

test("visibility discovery follows the declared legacy or content-based contract", () => {
  for (const name of [
    "remote-control-connections-visibility-a07582a4850b.js",
    "remote-control-connections-visibility-futurehash.js",
    "app-initial-previoushash.js",
  ]) {
    assert.equal(selects(name, source), true, name);
  }
  if (descriptor.assetNeedles != null) {
    for (const name of ["435221.eac941d988.js", "async/446738.83dee6513b.js"]) {
      assert.equal(selects(name, source), true, name);
    }
  }
  assert.equal(selects("remote-connections-settings-fixture.js", "function settings(){return true}"), false);
  assert.equal(selects("unrelated.js", "function unrelated(){return true}"), false);
});

test("the patch rejects missing, ambiguous and changed access gates byte-identically", () => {
  for (const invalid of [
    "function unrelated(){return true}",
    source + source.replace("function s(", "function duplicate("),
    source.replace("&&e?.accessRequired!==!0", ""),
    source.replace("accessRequired!==!0", "accessRequired===!0"),
    source.replace("return t&&", "return !t&&"),
    source.replace("available??!0", "available??!1"),
  ]) {
    const { result, warnings } = patchQuietly(invalid);
    assert.equal(result, invalid);
    if (invalid.includes("remoteControlConnectionsState")) {
      assert.ok(warnings.length > 0, "Changed or ambiguous access gates must report drift");
    }
  }
});

test("copied rspack modules are independently eligible and retain one owner per chunk",
  { skip: descriptor.assetNeedles == null }, () => {
  const copies = [
    ["async/435221.eac941d988.js", source],
    ["async/446738.83dee6513b.js", source.replace("function s(", "function renamed(")
      .replace("slingshotEnabled:t}){return t&&", "slingshotEnabled:n}){return n&&")],
  ];
  for (const [name, original] of copies) {
    assert.equal(selects(name, original), true);
    const { result, warnings } = patchQuietly(original);
    assert.deepEqual(warnings, []);
    assert.notEqual(result, original);
    assert.equal(result.split(marker).length - 1, 1);
    assert.doesNotThrow(() => new vm.Script(result), `${name}: patched source must remain valid JavaScript`);
    assert.equal(descriptor.apply(result), result);
  }
});

test("patch is idempotent and preserves access restrictions and non-Linux behavior", () => {
  const { result: patched, warnings } = patchQuietly(source);
  assert.deepEqual(warnings, []);
  assert.notEqual(patched, source);
  assert.equal(patched.split(marker).length - 1, 1);
  assert.equal(selects("remote-control-connections-visibility-fixture.js", patched), true);
  assert.equal(descriptor.apply(patched), patched);
  for (const ua of [undefined, "Linux", "Windows", "Macintosh"]) {
    const context = ua === undefined ? {} : { navigator: { userAgent: ua } };
    const original = vm.runInNewContext(source + ";s", context);
    const updated = vm.runInNewContext(patched + ";s", context);
    for (const state of [undefined, null, {}, { available: false }, { available: true },
      { accessRequired: true }, { available: true, accessRequired: true },
      { available: false, accessRequired: true }, { accessRequired: false },
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
