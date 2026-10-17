"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const upstream = process.env.UPSTREAM_SOURCE;
if (!upstream) throw new Error("UPSTREAM_SOURCE must point to the Linux wrapper");
const descriptors = require(path.join(upstream, "linux-features/remote-mobile-control/patch.js"));
const apply = descriptors.find((p) => p.id === "linux-remote-mobile-reasoning-summary-none").apply;
const marker = "codexLinuxRemoteMobileReasoningSummaryNone";
const ownerAnchor = "Reasoning summary turn-start config resolved";

// Minimal executable contract from official 26.928. The current caller
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

test("current caller patches exactly once and remains idempotent", () => {
  const source = fixture();
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
    fixture(""), fixture("||!0"), fixture("||s||another"), fixture("&&s"),
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

// Locate the owner by content, not a generated chunk name. The upstream patch
// also searches JavaScript assets beyond app-shared-* in newer official builds.
// Keep the compatibility, uniqueness and idempotence checks mandatory.
function verifyArchiveOwner(archivePath) {
  const fd = fs.openSync(archivePath, "r");
  try {
    const archiveSize = fs.fstatSync(fd).size;
    const prefix = Buffer.alloc(16);
    assert.equal(fs.readSync(fd, prefix, 0, 16, 0), 16, "Truncated ASAR prefix");
    const headerSize = prefix.readUInt32LE(12);
    const dataStart = 8 + prefix.readUInt32LE(4);
    assert.ok(headerSize > 0 && headerSize <= 64 * 1024 * 1024, "Invalid ASAR header size");
    assert.ok(dataStart >= 16 + headerSize && dataStart <= archiveSize, "Invalid ASAR data offset");
    const header = Buffer.alloc(headerSize);
    assert.equal(fs.readSync(fd, header, 0, header.length, 16), header.length, "Truncated ASAR header");
    const files = JSON.parse(header).files?.webview?.files?.assets?.files;
    assert.ok(files && typeof files === "object", "Missing webview/assets in official ASAR");
    const matches = [];
    for (const [name, entry] of Object.entries(files)) {
      if (!/^[^.]+\.js$/.test(name)) continue;
      assert.equal(entry.unpacked, undefined, `${name}: expected a packed JavaScript asset`);
      assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0, `${name}: invalid size`);
      assert.ok(typeof entry.offset === "string" && /^\d+$/.test(entry.offset), `${name}: invalid offset`);
      const offset = Number(entry.offset);
      assert.ok(Number.isSafeInteger(offset) && offset <= archiveSize - dataStart - entry.size,
        `${name}: asset extends beyond the ASAR`);
      const data = Buffer.alloc(entry.size);
      assert.equal(fs.readSync(fd, data, 0, data.length, dataStart + offset), data.length,
        `${name}: truncated JavaScript asset`);
      const source = data.toString("utf8");
      if (!source.includes(ownerAnchor)) continue;
      const { result, warnings } = patchQuietly(source);
      assert.deepEqual(warnings, [], `${name}: upstream patch rejected the summary owner`);
      assert.notEqual(result, source, `${name}: upstream patch made no change`);
      assert.equal(result.split(marker).length - 1, 1, `${name}: expected one summary patch`);
      assert.equal(apply(result), result, `${name}: summary patch must be idempotent`);
      matches.push(name);
    }
    assert.equal(matches.length, 1,
      `Expected exactly one compatible summary owner across JavaScript assets; found ${matches.length}: ${matches.join(", ") || "none"}`);
    return matches[0];
  } finally {
    fs.closeSync(fd);
  }
}

// Small packed-ASAR fixtures exercise the same reader as the official archive.
function withArchive(assets, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "summary-owner-test-"));
  try {
    const files = {};
    const payloads = [];
    let offset = 0;
    for (const [name, source] of Object.entries(assets)) {
      const data = Buffer.from(source, "utf8");
      files[name] = { size: data.length, offset: String(offset) };
      payloads.push(data);
      offset += data.length;
    }
    const header = Buffer.from(JSON.stringify({ files: { webview: { files: { assets: { files } } } } }));
    const alignedLength = Math.ceil(header.length / 4) * 4;
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(8 + alignedLength, 4);
    prefix.writeUInt32LE(4 + alignedLength, 8);
    prefix.writeUInt32LE(header.length, 12);
    const archive = path.join(directory, "app.asar");
    fs.writeFileSync(archive, Buffer.concat([
      prefix, header, Buffer.alloc(alignedLength - header.length), ...payloads,
    ]));
    return run(archive);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("ASAR discovery follows the summary owner across renamed JavaScript chunks", () => {
  for (const name of ["app-shared-old.js", "app-primary-new.js", "turn-runtime-renamed.js"]) {
    withArchive({
      "unrelated.js": "console.log('unrelated');",
      "source.js.map": fixture(),
      [name]: fixture(),
    }, (archive) => assert.equal(verifyArchiveOwner(archive), name));
  }
});

test("ASAR discovery still rejects missing, duplicate and incompatible owners", () => {
  withArchive({ "unrelated.js": "console.log('unrelated');" }, (archive) => {
    assert.throws(() => verifyArchiveOwner(archive), /found 0: none/);
  });
  withArchive({ "app-shared-old.js": fixture(), "turn-runtime-new.js": fixture() }, (archive) => {
    assert.throws(() => verifyArchiveOwner(archive), /found 2: app-shared-old.js, turn-runtime-new.js/);
  });
  withArchive({ "turn-runtime-new.js": fixture("||!0") }, (archive) => {
    assert.throws(() => verifyArchiveOwner(archive), /upstream patch rejected the summary owner/);
  });
});

// Read-only integration check against a downloaded, checksum-verified official
// archive. Optional locally, but the Dockerfile explicitly runs it before build.
test("official ASAR contains one compatible summary owner", { skip: !process.env.OFFICIAL_ASAR }, (t) => {
  const owner = verifyArchiveOwner(process.env.OFFICIAL_ASAR);
  t.diagnostic(`Validated official reasoning-summary owner: webview/assets/${owner}`);
});
