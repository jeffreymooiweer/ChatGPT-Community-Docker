"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const upstream = process.env.UPSTREAM_SOURCE;
if (!upstream) throw new Error("UPSTREAM_SOURCE must point to the Linux wrapper");
const descriptors = require(path.join(upstream, "linux-features/remote-mobile-control/patch.js"));
const apply = descriptors.find((p) => p.id === "linux-remote-mobile-reasoning-summary-none").apply;
const marker = "codexLinuxRemoteMobileReasoningSummaryNone";

// Minimal executable contract from official 26.928.20755. The new caller
// adds ||s to the feature override; all existing access/host checks stay intact.
function fixture(extra = "||s") {
  return "async function arn(e,t,n,r,i,a,o){let s=n.request,D=a.latestThreadSettings,ne=a.initialParams,Fe=a.configRequirements,Re=ne?.summary??`none`;D?.summary!==void 0&&(Re=D.summary),o.reasoningSummaryOverride!=null&&(Re=o.reasoningSummaryOverride),Re=Fe==null?null:Fe.model_reasoning_summary??Re,s.summary!==void 0&&(Re=s.summary);e.logger.info(`Reasoning summary turn-start config resolved`,{safe:{summary:Re}});return{summary:Re}}" +
    "async function start(e,t,n,r,i,a){let s=a.forceSummary;return await arn(e,t,n,r,i,a,{canUseProjectlessWorkspace:!nP(e.getHostId()),canMaterializeHostRoots:!nP(e.getHostId())&&!(s&&a.mode===`durable`),preserveWorkspaceSandboxPolicyWithDefault:nP(e.getHostId()),carryProjectlessRuntimeRoots:!nP(e.getHostId()),latestUseAppServerPermissionDefault:!0,reasoningSummaryOverride:e.getDefaultFeatureOverride(`concurrent_reasoning_summaries`)===!0" + extra + "?`detailed`:null})}";
}

function patchQuietly(source) {
  const warn = console.warn;
  const warnings = [];
  try {
    console.warn = (...args) => warnings.push(args.join(" "));
    return { result: apply(source), warnings };
  } finally {
    console.warn = warn;
  }
}

test("current and recorded callers patch exactly once and remain idempotent", () => {
  for (const extra of ["||s", ""]) {
    const source = fixture(extra);
    const { result, warnings } = patchQuietly(source);
    assert.notEqual(result, source);
    assert.deepEqual(warnings, []);
    assert.equal(result.split(marker).length - 1, 1);
    assert.equal(apply(result), result);
    // The patch only inserts two fragments; the original caller options,
    // feature override, and permission expressions remain byte-identical.
    const stripped = result.replace("codexLinuxRemoteMobileHost:nP(e.getHostId())&&a.mode===`durable`,", "")
      .replace("/*" + marker + "*/navigator.userAgent.includes(`Linux`)&&o.codexLinuxRemoteMobileHost&&s.summary===void 0&&(Re=`none`);", "");
    assert.equal(stripped, source);
  }
});

test("summary override only affects implicit Linux local durable turns", async () => {
  const source = fixture();
  const patched = apply(source);
  for (const platform of ["Linux", "Windows", "Macintosh"]) {
    const context = { navigator: { userAgent: platform }, nP: (id) => id === "local" };
    const original = vm.runInNewContext(source + ";start", context);
    const updated = vm.runInNewContext(patched + ";start", context);
    for (const host of ["local", "remote-ssh:server"]) {
      for (const mode of ["durable", "default"]) {
        for (const summary of [undefined, null, "concise", "detailed", "none"]) {
          for (const force of [false, true]) {
            for (const feature of [false, true]) {
              const manager = { getHostId: () => host, getDefaultFeatureOverride: () => feature, logger: { info() {} } };
              const args = [manager, "thread", { request: { summary } }, null, null,
                { mode, forceSummary: force, initialParams: { summary: "auto" },
                  latestThreadSettings: { summary: "auto" }, configRequirements: {} }];
              const expected = platform === "Linux" && host === "local" && mode === "durable" && summary === undefined
                ? "none" : (await original(...args)).summary;
              assert.equal((await updated(...args)).summary, expected);
            }
          }
        }
      }
    }
  }
});

test("renamed minified identifiers are supported without filename hardcoding", () => {
  const source = fixture().replaceAll("arn", "helperAlias").replaceAll("nP", "hostClassifier")
    .replace("let s=a.forceSummary", "let forcedSummary=a.forceSummary")
    .replaceAll("!(s&&", "!(forcedSummary&&").replace("||s?", "||forcedSummary?");
  assert.notEqual(apply(source), source);
});

test("ambiguous, incomplete and unfamiliar caller contracts fail closed", () => {
  const source = fixture();
  const caller = source.slice(source.indexOf("async function start"));
  const patched = apply(source);
  const cases = [
    source + caller.replace("start(", "duplicate("),
    source + source,
    source.replace("canUseProjectlessWorkspace:!nP", "canUseProjectlessWorkspace:nP"),
    source.replace("concurrent_reasoning_summaries", "another_feature"),
    fixture("||!0"), fixture("||s||another"), fixture("&&s"),
    source.replace("o.reasoningSummaryOverride!=null", "o.reasoningSummaryOverride===null"),
    patched.replace("codexLinuxRemoteMobileHost:nP(e.getHostId())&&a.mode===`durable`,", ""),
    patched.replace("/*" + marker + "*/navigator.userAgent.includes(`Linux`)&&o.codexLinuxRemoteMobileHost&&s.summary===void 0&&(Re=`none`);", ""),
  ];
  for (const invalid of cases) {
    const { result, warnings } = patchQuietly(invalid);
    assert.equal(result, invalid);
    assert.ok(warnings.length > 0);
  }
});

// Optional read-only integration check against a downloaded, checksum-verified
// official archive. The Docker build also enforces all patches on the real app.
test("official ASAR contains one compatible summary owner", { skip: !process.env.OFFICIAL_ASAR }, () => {
  const fd = fs.openSync(process.env.OFFICIAL_ASAR, "r");
  try {
    const prefix = Buffer.alloc(16);
    assert.equal(fs.readSync(fd, prefix, 0, 16, 0), 16);
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    assert.equal(fs.readSync(fd, header, 0, header.length, 16), header.length);
    const files = JSON.parse(header).files.webview.files.assets.files;
    let matches = 0;
    for (const [name, entry] of Object.entries(files)) {
      if (!/^app-shared-[^.]+\.js$/.test(name)) continue;
      assert.equal(entry.unpacked, undefined);
      const data = Buffer.alloc(entry.size);
      assert.equal(fs.readSync(fd, data, 0, data.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset)), data.length);
      const source = data.toString("utf8");
      if (!source.includes("Reasoning summary turn-start config resolved")) continue;
      const { result, warnings } = patchQuietly(source);
      assert.deepEqual(warnings, []);
      assert.notEqual(result, source);
      assert.equal(result.split(marker).length - 1, 1);
      assert.equal(apply(result), result);
      matches++;
    }
    assert.equal(matches, 1);
  } finally {
    fs.closeSync(fd);
  }
});
