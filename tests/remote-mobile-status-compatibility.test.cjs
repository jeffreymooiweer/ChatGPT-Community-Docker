"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const upstream = process.env.UPSTREAM_SOURCE;
if (!upstream) throw new Error("UPSTREAM_SOURCE must point to the Linux wrapper");
const patches = require(path.join(upstream, "linux-features/remote-mobile-control/patch.js"));
const { patchBreaksJavaScriptSyntax } = require(path.join(upstream, "scripts/patches/lib/javascript-syntax.js"));
const terminal = patches.find((entry) => entry.id === "linux-remote-terminal-status-recovery");
const active = patches.find((entry) => entry.id === "linux-remote-mobile-active-status");
assert.ok(terminal && active);

function warningsFrom(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { return { value: fn(), warnings }; }
  finally { console.warn = original; }
}

function factory(id, body, expression = true) {
  return expression ? `${id}:(function(e,t,n){"use strict";${body}})` : `${id}(e,t,n){"use strict";${body}}`;
}

function chunk(modules) {
  return `export const __rspack_esm_ids=[123];export const __webpack_modules__={${modules.join(",")}};`;
}

function loadChunk(source, imports = {}) {
  const sandbox = {};
  vm.runInNewContext(source.replace(/export const /g, "var "), sandbox);
  const cache = new Map();
  const load = (id) => {
    if (Object.hasOwn(imports, id)) return imports[id];
    if (cache.has(id)) return cache.get(id);
    assert.ok(Object.hasOwn(sandbox.__webpack_modules__, id), `Unexpected module ${id}`);
    const exports = {};
    cache.set(id, exports);
    sandbox.__webpack_modules__[id]({}, exports, load);
    return exports;
  };
  load.d = (exports, getters) => {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { get });
  };
  return load;
}

function terminalFixture(expression = true) {
  return chunk([
    factory("Terminal", 'n.d(t,{status:()=>s,read:()=>r});function s({hasInProgressOwnedWork:e,isResponseInProgress:t,latestTurnHasSystemError:n,resumeState:r,threadRuntimeStatus:i}){return e?"loading":i?.type==="systemError"?"error":i?.type==="active"?"loading":"needs_resume"===r?"idle":n?"error":!0===t?"loading":"idle"}function r(c){return s({hasInProgressOwnedWork:!1,isResponseInProgress:c?.isResponseInProgress??null,resumeState:c?.resumeState,threadRuntimeStatus:c?.threadRuntimeStatus,latestTurnHasSystemError:c?.latestTurnError!=null})}', expression),
    factory("Sidebar", 'var s=n("Terminal");n.d(t,{read:()=>r});function r(c){return(0,s.status)({hasInProgressOwnedWork:!1,isResponseInProgress:c?.isResponseInProgress??null,resumeState:c?.resumeState,threadRuntimeStatus:c?.threadRuntimeStatus,latestTurnHasSystemError:c?.latestTurnError!=null})}', expression),
    factory("Pending", 'var l=n("approvals");n.d(t,{read:()=>p});function m(e){return"approval"}function p({mcpServerElicitationKind:e,pendingRequestType:t,requests:n,resumeState:r,threadRuntimeStatus:i,userInputRequestId:a}){return"needs_resume"===r?i?.type==="active"&&i.activeFlags.includes("waitingOnApproval")&&(0,l.PZ)(n)?{blocking:!0,kind:"approval",source:m(t)}:i?.type==="active"&&i.activeFlags.includes("waitingOnUserInput")?{autoResolution:null,blocking:!0,kind:"input",requestId:a,source:"userInput"}:null:null}', expression),
  ]);
}

function activeFixture() {
  return 'const status=function({latestTurnStatus:e,resumeState:t,historyAttached:n,threadRuntimeStatus:a}){return n?a?.type==="active"||"inProgress"===e?"active":"inactive":"needs_resume"===t?"needs-resume":"read-only"};';
}

test("terminal recovery keeps pending-input helpers inside parenthesized module factories", () => {
  for (const expression of [true, false]) {
    const source = terminalFixture(expression);
    const { value: patched, warnings } = warningsFrom(() => terminal.apply(source));
    assert.notEqual(patched, source);
    assert.deepEqual(warnings, []);
    assert.equal(terminal.apply(patched), patched);
    assert.equal(patchBreaksJavaScriptSyntax(source, patched), false);
    assert.equal(patched.split("function codexLinuxRemoteHasUserInputRequest(").length - 1, 3);
    for (const id of ["Terminal", "Sidebar", "Pending"]) {
      const prefix = expression ? `${id}:(function(e,t,n){` : `${id}(e,t,n){`;
      assert.ok(patched.includes(prefix + '"use strict";function codexLinuxRemoteHasUserInputRequest('));
    }
    const load = loadChunk(patched, { approvals: { PZ: () => true } });
    const waiting = { resumeState: "needs_resume", threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnUserInput"] } };
    for (const id of ["Terminal", "Sidebar"]) {
      assert.equal(load(id).read({ ...waiting, requests: [] }), "idle");
      assert.equal(load(id).read({ ...waiting, requests: [{ method: "item/tool/requestUserInput" }] }), "loading");
      assert.equal(load(id).read({ ...waiting, requests: [], isResponseInProgress: true }), "loading");
      assert.equal(load(id).read({ threadRuntimeStatus: { type: "systemError" }, requests: [] }), "error");
    }
    assert.equal(load("Pending").read({ ...waiting, requests: [] }), null);
    assert.equal(load("Pending").read({ ...waiting, requests: [{ method: "item/tool/requestUserInput" }] }).kind, "input");
    assert.equal(load("Pending").read({ ...waiting, requests: [], threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] } }).kind, "approval");
  }
});

test("terminal recovery rejects malformed and unsupported factory boundaries without partial edits", () => {
  const source = terminalFixture();
  for (const candidate of [
    source.replace("}),Sidebar:", "},Sidebar:"),
    source.replace("Terminal:(function(e,t,n){", "Terminal:((e,t,n)=>{"),
    source.replace("export const __webpack_modules__={", "export const unrelated={"),
  ]) {
    assert.notEqual(candidate, source);
    const { value, warnings } = warningsFrom(() => terminal.apply(candidate));
    assert.equal(value, candidate);
    assert.match(warnings.join("\n"), /outside an rspack module factory/);
  }
});

test("revoke setup reset retains module-scope services with parenthesized factories", () => {
  const source = chunk([factory("Settings", [
    'n.d(t,{Settings:()=>ni});var T=n("services"),k=n("track");',
    'async function np(e){let t=T.appServices.remoteConnections;return t.setAutoConnect(e)}',
    'function ni(e){let T,{snapshot:a,store:$}=e,ec=a.localClientId,x={localRemoteControlClientId:ec},ej=a.query,',
    'Se={onRevoked:e=>{ej.setData(t=>t?.filter(t=>t.clientId!==e)),ej.invalidate()},onRevokeResult:e=>{(0,k.yy)($,"revoke",{result:e})}},',
    'toast={id:"remote-control-client-revoke-success"};return{handler:Se.onRevoked,query:ej,x}}',
  ].join(""))]);
  const apply = patches.applyLinuxRemoteControlClientRevokeSetupResetPatch;
  const { value: patched, warnings } = warningsFrom(() => apply(source));
  assert.notEqual(patched, source);
  assert.deepEqual(warnings, []);
  assert.equal(apply(patched), patched);
  const writes = [];
  const load = loadChunk(patched, {
    services: { appServices: { remoteConnections: {}, applicationState: { write: (key, value) => { writes.push([key, value]); return Promise.resolve(); } } } },
    track: { yy() {} },
  });
  const query = { data: [{ clientId: "desktop" }, { clientId: "phone" }], setData(fn) { this.data = fn(this.data); }, invalidate() { this.invalidated = true; } };
  load("Settings").Settings({ snapshot: { localClientId: "desktop", query } }).handler("phone");
  assert.deepEqual(query.data, [{ clientId: "desktop" }]);
  assert.equal(query.invalidated, true);
  assert.deepEqual(writes, [["codex-mobile-has-connected-device", false]]);
});

test("active status recognizes mobile work before local history attachment", () => {
  const source = activeFixture();
  assert.ok(active.assetNeedles.every((needle) => source.includes(needle)));
  assert.equal(active.assetMatch(source), true);
  const { value: patched, warnings } = warningsFrom(() => active.apply(source));
  assert.notEqual(patched, source);
  assert.deepEqual(warnings, []);
  assert.equal(active.apply(patched), patched);
  assert.equal(active.assetMatch(patched), true);
  const status = vm.runInNewContext(`${patched};status`);
  assert.equal(status({ historyAttached: false, resumeState: "needs_resume", threadRuntimeStatus: { type: "active" } }), "active");
  assert.equal(status({ historyAttached: false, latestTurnStatus: "inProgress" }), "active");
  assert.equal(status({ historyAttached: false, latestTurnStatus: "completed", resumeState: "needs_resume" }), "needs-resume");
  assert.equal(status({ historyAttached: false, latestTurnStatus: "completed", resumeState: "resumed" }), "read-only");
  assert.equal(status({ historyAttached: true, latestTurnStatus: "completed", threadRuntimeStatus: { type: "idle" } }), "inactive");
  assert.equal(status({ historyAttached: true, threadRuntimeStatus: { type: "active" } }), "active");
});

test("active status refuses duplicate, partial, and unknown reducers", () => {
  const source = activeFixture();
  const patched = active.apply(source);
  for (const candidate of [
    source + source,
    source.replace('return n?', 'return !n?'),
    source + '/*codexLinuxRemoteMobileActiveStatus*/',
    patched.replace('return a?.type', 'return unknown?.type'),
    '/*codexLinuxRemoteMobileActiveStatus*/',
  ]) {
    assert.equal(active.assetMatch(candidate), false);
    const { value, warnings } = warningsFrom(() => active.apply(candidate));
    assert.equal(value, candidate);
    assert.match(warnings.join("\n"), /unique active-status renderer/);
  }
});

function officialWebviewScripts(archive) {
  const fd = fs.openSync(archive, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const prefix = Buffer.alloc(16);
    assert.equal(fs.readSync(fd, prefix, 0, 16, 0), 16);
    const headerSize = prefix.readUInt32LE(12);
    const dataStart = 8 + prefix.readUInt32LE(4);
    assert.ok(headerSize > 0 && headerSize <= 64 * 1024 * 1024);
    assert.ok(dataStart >= 16 + headerSize && dataStart <= size);
    const header = Buffer.alloc(headerSize);
    assert.equal(fs.readSync(fd, header, 0, headerSize, 16), headerSize);
    const files = JSON.parse(header).files?.webview?.files?.assets?.files;
    assert.ok(files);
    const scripts = [];
    const walk = (entries, parent = "") => {
      for (const [name, entry] of Object.entries(entries)) {
        const relative = parent ? `${parent}/${name}` : name;
        if (entry.files) { walk(entry.files, relative); continue; }
        if (!relative.endsWith(".js")) continue;
        assert.ok(!entry.unpacked && !entry.link, `Unsupported script entry ${relative}`);
        const offset = Number(entry.offset);
        assert.ok(Number.isSafeInteger(offset) && offset >= 0);
        assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0 && dataStart + offset + entry.size <= size);
        const buffer = Buffer.alloc(entry.size);
        assert.equal(fs.readSync(fd, buffer, 0, buffer.length, dataStart + offset), buffer.length);
        scripts.push({ name: relative, source: buffer.toString("utf8") });
      }
    };
    walk(files);
    return scripts;
  } finally { fs.closeSync(fd); }
}

test("verified official ASAR has unique, parseable and idempotent status patch owners", {
  skip: !process.env.OFFICIAL_ASAR,
}, () => {
  const scripts = officialWebviewScripts(process.env.OFFICIAL_ASAR);
  for (const descriptor of [terminal, active]) {
    const owners = scripts.filter(({ source }) => descriptor.assetNeedles.every((needle) => source.includes(needle)) && (!descriptor.assetMatch || descriptor.assetMatch(source)));
    assert.equal(owners.length, 1, `${descriptor.id}: expected one semantic owner`);
    const [{ name, source }] = owners;
    const { value: patched, warnings } = warningsFrom(() => descriptor.apply(source));
    assert.notEqual(patched, source, `${descriptor.id}: official owner was not patched`);
    assert.deepEqual(warnings, [], `${descriptor.id}: official owner produced drift warnings`);
    assert.equal(descriptor.apply(patched), patched);
    assert.equal(patchBreaksJavaScriptSyntax(source, patched), false);
    console.log(`Validated official ${descriptor.id} owner: webview/assets/${name}`);
  }
});
