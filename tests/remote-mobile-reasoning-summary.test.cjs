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
const descriptor = descriptors.find((p) => p.id === "linux-remote-mobile-reasoning-summary-none");
assert.ok(descriptor && typeof descriptor.apply === "function", "Missing reasoning-summary patch");
const apply = descriptor.apply;
const rspack = Array.isArray(descriptor.assetNeedles);
const classifier = rspack ? "(0,nP.ZJ)" : "nP";
const marker = "codexLinuxRemoteMobileReasoningSummaryNone";
const ownerAnchor = "Reasoning summary turn-start config resolved";

// Keep executable contracts for both the recorded Vite release and the current
// rspack release. Selection follows the descriptor API, never a generated name.
// The expected host, permission and explicit-summary behavior is the same.
function fixture(extra = "||s") {
  const source = "async function arn(e,t,n,r,i,a,o){let s=n.request,D=a.latestThreadSettings,ne=a.initialParams,Fe=a.configRequirements,Re=ne?.summary??`none`;D?.summary!==void 0&&(Re=D.summary),o.reasoningSummaryOverride!=null&&(Re=o.reasoningSummaryOverride),Re=Fe==null?null:Fe.model_reasoning_summary??Re,s.summary!==void 0&&(Re=s.summary);e.logger.info(`Reasoning summary turn-start config resolved`,{safe:{summary:Re}});return{summary:Re}}" +
    "async function start(e,t,n,r,i,a){let s=a.forceSummary;return await arn(e,t,n,r,i,a,{canUseProjectlessWorkspace:!nP(e.getHostId()),canMaterializeHostRoots:!nP(e.getHostId())&&!(s&&a.mode===`durable`),preserveWorkspaceSandboxPolicyWithDefault:nP(e.getHostId()),carryProjectlessRuntimeRoots:!nP(e.getHostId()),latestUseAppServerPermissionDefault:!0,reasoningSummaryOverride:e.getDefaultFeatureOverride(`concurrent_reasoning_summaries`)===!0" + extra + "?`detailed`:null})}";
  if (!rspack) return source;
  return source.replaceAll("`", '"')
    .replaceAll("nP(e.getHostId())", "(0,nP.ZJ)(e.getHostId())")
    .replace("o.reasoningSummaryOverride!=null", "null!=o.reasoningSummaryOverride")
    .replace("Re=Fe==null", "Re=null==Fe")
    .replace("s.summary!==void 0", "void 0!==s.summary")
    .replace('e.getDefaultFeatureOverride("concurrent_reasoning_summaries")===!0',
      '!0===e.getDefaultFeatureOverride("concurrent_reasoning_summaries")');
}

const callerInsertion = rspack
  ? 'codexLinuxRemoteMobileHost:(0,nP.ZJ)(e.getHostId())&&"durable"===a.mode,'
  : "codexLinuxRemoteMobileHost:nP(e.getHostId())&&a.mode===`durable`,";
const resolverInsertion = rspack
  ? '/*' + marker + '*/navigator.userAgent.includes("Linux")&&o.codexLinuxRemoteMobileHost&&void 0===s.summary&&(Re="none");'
  : "/*" + marker + "*/navigator.userAgent.includes(`Linux`)&&o.codexLinuxRemoteMobileHost&&s.summary===void 0&&(Re=`none`);";

// Official 26.1103 passes a context record into an anonymous resolver. Its
// authoritative conversation mode comes from the manager, not a.mode.
function modernFixture() {
  return 'async function modernStart(e,t,n,r,i,a){let payload={manager:e,conversationId:t,operation:n,turnStarts:[],capabilities:r};return await async function({manager:e,conversationId:t,operation:n,capabilities:r},a){' +
    'let h=n.request,Q=a.initialParams,H=a.latestThreadSettings,eV=a.configRequirements,s={canUseProjectlessWorkspace:!(0,nP.ZJ)(e.getHostId()),canMaterializeHostRoots:!(0,nP.ZJ)(e.getHostId())&&!(a.forceSummary&&a.mode==="durable"),preserveWorkspaceSandboxPolicyWithDefault:(0,nP.ZJ)(e.getHostId()),carryProjectlessRuntimeRoots:!(0,nP.ZJ)(e.getHostId()),latestUseAppServerPermissionDefault:!0,reasoningSummaryOverride:!0===e.getDefaultFeatureOverride("concurrent_reasoning_summaries")||a.forceSummary?"detailed":null},eZ=Q?.summary??"none";' +
    'H?.summary!==void 0&&(eZ=H.summary),null!=s.reasoningSummaryOverride&&(eZ=s.reasoningSummaryOverride),eZ=null==eV?null:eV.model_reasoning_summary??eZ,void 0!==h.summary&&(eZ=h.summary);e.logger.info("Reasoning summary turn-start config resolved",{safe:{summary:eZ}});return{summary:eZ,options:s}}(payload,a)}';
}

const modernCallerInsertion = 'codexLinuxRemoteMobileHost:"local"===e.getHostId()&&"durable"===e.getConversation(t)?.mode,';
const modernHeaderInsertion = 'codexLinuxRemoteMobileHost:codexLinuxRemoteMobileHost,';
const modernResolverInsertion = '/*' + marker + '*/navigator.userAgent.includes("Linux")&&codexLinuxRemoteMobileHost&&void 0===h.summary&&(eZ="none");';


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
  const stripped = result.replace(callerInsertion, "").replace(resolverInsertion, "");
  assert.equal(stripped, source);
});

test("summary override only affects implicit Linux local durable turns", async () => {
  const source = fixture();
  const patched = apply(source);
  for (const platform of ["Linux", "Windows", "Macintosh"]) {
    const context = { navigator: { userAgent: platform }, nP: rspack ? { ZJ: (id) => id === "local" } : (id) => id === "local" };
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
    source.replace("canUseProjectlessWorkspace:!" + classifier, "canUseProjectlessWorkspace:" + classifier),
    source.replace("concurrent_reasoning_summaries", "another_feature"),
    fixture(""), fixture("||!0"), fixture("||s||another"), fixture("&&s"),
    source.replace(rspack ? "null!=o.reasoningSummaryOverride" : "o.reasoningSummaryOverride!=null", "o.reasoningSummaryOverride===null"),
    patched.replace(callerInsertion, ""),
    patched.replace(resolverInsertion, ""),
  ];
  for (const invalid of cases) {
    const { result, warnings } = patchQuietly(invalid);
    assert.equal(result, invalid);
    assert.ok(warnings.length > 0);
  }
});

test("modern anonymous resolver patches once and preserves caller security options", { skip: !rspack }, () => {
  const source = modernFixture();
  const { result, warnings } = patchQuietly(source);
  assert.notEqual(result, source);
  assert.deepEqual(warnings, []);
  assert.equal(result.split(marker).length - 1, 1);
  assert.equal(apply(result), result);
  assert.doesNotThrow(() => new vm.Script(result));
  assert.equal(result.replace(modernCallerInsertion, "").replace(modernHeaderInsertion, "")
    .replace(modernResolverInsertion, ""), source);
});

test("modern summary behavior uses the manager conversation and preserves explicit null", { skip: !rspack }, async () => {
  const source = modernFixture();
  const patched = apply(source);
  for (const platform of ["Linux", "Windows", "Macintosh"]) {
    const context = { navigator: { userAgent: platform }, nP: { ZJ: (id) => id === "local" } };
    const original = vm.runInNewContext(source + ";modernStart", context);
    const updated = vm.runInNewContext(patched + ";modernStart", context);
    for (const host of ["local", "remote-ssh:server", "durable"]) {
      for (const conversation of [undefined, null, {}, { mode: "default" }, { mode: "durable" }]) {
        for (const passedMode of ["default", "durable"]) {
          for (const summary of [undefined, null, "concise", "detailed", "none"]) {
            for (const force of [false, true]) {
              for (const feature of [false, true]) {
                for (const modelSummary of [undefined, "model"]) {
                  const manager = { getHostId: () => host, getDefaultFeatureOverride: () => feature,
                    getConversation: (id) => { assert.equal(id, "thread"); return conversation; },
                    logger: { info() {} } };
                  const args = [manager, "thread", { request: { summary } }, {}, null,
                    { mode: passedMode, forceSummary: force, initialParams: { summary: "auto" },
                      latestThreadSettings: { summary: "concise" }, configRequirements: { model_reasoning_summary: modelSummary } }];
                  const before = await original(...args);
                  const after = await updated(...args);
                  const expected = platform === "Linux" && host === "local" && conversation?.mode === "durable" && summary === undefined
                    ? "none" : before.summary;
                  assert.equal(after.summary, expected,
                    JSON.stringify({ platform, host, conversation, passedMode, summary, force, feature, modelSummary }));
                  assert.deepEqual({ ...after.options }, { ...before.options });
                }
              }
            }
          }
        }
      }
    }
  }
});

test("modern missing, duplicate and partial resolver/caller pairs fail closed", { skip: !rspack }, () => {
  const source = modernFixture();
  const patched = apply(source);
  const duplicateCaller = 'function duplicate(e,t,n){let second={manager:e,conversationId:t,operation:n,turnStarts:[]};return second}';
  const duplicateHeader = 'let unused=async function({manager:e,conversationId:t,operation:n,capabilities:r}){};';
  for (const invalid of [
    source.replace("turnStarts:[]", "changedTurns:[]"),
    source.replace("operation:n,capabilities:r},a)", "operation:n,changedCapabilities:r},a)"),
    source + duplicateCaller,
    source + source,
    source.replace("{let payload=", "{" + duplicateHeader + "let payload="),
    source.replace("eZ=null==eV?null:eV.model_reasoning_summary??eZ,", ""),
    patched.replace(modernCallerInsertion, ""),
    patched.replace(modernHeaderInsertion, ""),
    patched.replace(modernResolverInsertion, ""),
  ]) {
    const { result, warnings } = patchQuietly(invalid);
    assert.equal(result, invalid);
    assert.ok(warnings.length > 0, "Incomplete or ambiguous modern pairs must report drift");
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
    function* walk(entries, parent = "") {
      for (const [name, entry] of Object.entries(entries)) {
        assert.ok(name && name !== "." && name !== ".." && !/[\\/\0]/.test(name),
          "Invalid ASAR entry name");
        assert.ok(entry && typeof entry === "object", `${parent}${name}: invalid entry`);
        const location = parent + name;
        if (entry.files) yield* walk(entry.files, location + "/");
        else yield [location, entry];
      }
    }
    for (const [name, entry] of walk(files)) {
      if (!name.endsWith(".js")) continue;
      assert.equal(entry.link, undefined, `${name}: expected a regular JavaScript asset`);
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
      const parts = name.split("/");
      let parent = files;
      for (const part of parts.slice(0, -1)) {
        parent[part] ??= { files: {} };
        parent = parent[part].files;
      }
      parent[parts.at(-1)] = { size: data.length, offset: String(offset) };
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
  for (const name of ["app-shared-old.js", "app-primary-new.js", "turn-runtime-renamed.js",
    "182735.5b42af8792.js", "async/182735.5b42af8792.js", "async/nested/turn.runtime.js"]) {
    withArchive({
      "unrelated.js": "console.log('unrelated');",
      "async/source.js.map": fixture(),
      [name]: fixture(),
    }, (archive) => assert.equal(verifyArchiveOwner(archive), name));
  }
});

test("ASAR discovery still rejects missing, duplicate and incompatible owners", () => {
  withArchive({ "unrelated.js": "console.log('unrelated');" }, (archive) => {
    assert.throws(() => verifyArchiveOwner(archive), /found 0: none/);
  });
  withArchive({ "app-shared-old.js": fixture(), "async/turn.runtime.js": fixture() }, (archive) => {
    assert.throws(() => verifyArchiveOwner(archive), /found 2: app-shared-old.js, async\/turn.runtime.js/);
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
