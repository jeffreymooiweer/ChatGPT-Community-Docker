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
const loadGate = patches.find((entry) => entry.id === "linux-remote-control-load-gate");
const copy = patches.find((entry) => entry.id === "linux-remote-control-copy");
const settings = patches.find((entry) => entry.id === "linux-remote-control-settings-ux");
assert.ok(loadGate && copy && settings);

function captureWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { return { value: run(), warnings }; }
  finally { console.warn = original; }
}

function factory(id, body, expression) {
  if (expression === "function") return `${id}:function(e,t,n){${body}}`;
  return expression ? `${id}:(function(e,t,n){${body}})` : `${id}(e,t,n){${body}}`;
}

function chunk(modules) {
  return `export const __rspack_esm_ids=[123];export const __webpack_modules__={${modules.join(",")}};`;
}

function loadChunk(source, imports, userAgent) {
  const sandbox = userAgent == null ? {} : { navigator: { userAgent } };
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
  load.d = (target, getters, values = {}) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
    Object.assign(target, values);
  };
  return load;
}

function loaderFixture(expression = false) {
  return chunk([factory("Loader", [
    'var s=n("statsig");let p="1042620455",v={key:"features.remote_connections"};',
    'n.d(t,{},{i2:p,mC:function(){return(0,s.Zj)(p)}})',
  ].join(""), expression)]);
}

function settingsFixture(panel = true, expression = false) {
  const modules = [factory("Catalog", [
    'var a=n("jotai"),c=n("gates"),d=n("state"),h=n("visibility"),m=n("loader");',
    'let f="782640499",C={otherDevices:{id:"settings.remoteConnections.tabs.accessOtherDevices",defaultMessage:"Control other devices"}},',
    'x=(0,a.un)(null,({get:e})=>{let t="linux",n=e(d.h9),s=null!=n&&(0,h.Zi)({remoteControlConnectionsState:n,slingshotEnabled:e(c.P,m.i2)}),o=[];',
    's&&!e(c.P,f)&&o.push(p("access-other-devices",t));return o});',
    'function p(e,t){return e}n.d(t,{},{K0:f,V4:x})',
  ].join(""), expression)];
  if (panel) modules.push(factory("Panel", [
    'var B=n("statsig"),eI=n("Catalog"),h=n("visibility"),d=n("state");',
    'let label={id:"settings.remoteConnections.refresh",defaultMessage:"Refresh"};',
    'function read(x,slingshot){let tN=(0,B.Zj)(eI.K0),nT=!tN,nH=null==x,',
    'nG=nT&&(0,h.Zi)({remoteControlConnectionsState:x,slingshotEnabled:slingshot});',
    'return{selectedConnectionsTab:"access-other-devices",showControlOtherDevices:nG}}n.d(t,{},{read})',
  ].join(""), expression));
  return chunk(modules);
}

test("loader copies keep the module-local rollout binding and Linux-only behavior", () => {
  assert.equal(loadGate.assetMatch, undefined, "Every copied loader module must be selected");
  for (const expression of [false, true, "function"]) {
    const source = loaderFixture(expression);
    assert.ok(loadGate.assetNeedles.every((needle) => source.includes(needle)));
    const { value: patched, warnings } = captureWarnings(() => loadGate.apply(source));
    assert.notEqual(patched, source);
    assert.deepEqual(warnings, []);
    assert.equal(patchBreaksJavaScriptSyntax(source, patched), false);
    assert.deepEqual(captureWarnings(() => loadGate.apply(patched)), { value: patched, warnings: [] });
    for (const userAgent of [undefined, "X11; Linux x86_64", "Macintosh", "Windows"]) {
      for (const enabled of [false, true]) {
        const calls = [];
        const module = loadChunk(patched, { statsig: { Zj: (id) => { calls.push(id); return enabled; } } }, userAgent)("Loader");
        const linux = userAgent?.includes("Linux") ?? false;
        assert.equal(module.mC(), linux || enabled);
        assert.equal(module.i2, "1042620455");
        assert.deepEqual(calls, linux ? [] : ["1042620455"]);
      }
    }
  }
});

test("inline loader contracts stay idempotent and reject duplicate owners", () => {
  const source = 'function loader(){return(0,flags.read)("1042620455")}';
  const { value: patched, warnings } = captureWarnings(() => loadGate.apply(source));
  assert.notEqual(patched, source);
  assert.deepEqual(warnings, []);
  assert.deepEqual(captureWarnings(() => loadGate.apply(patched)), { value: patched, warnings: [] });
  const duplicate = source + source;
  const rejected = captureWarnings(() => loadGate.apply(duplicate));
  assert.equal(rejected.value, duplicate);
  assert.match(rejected.warnings.join("\n"), /unique remote-control loader rollout gate/);
});

test("loader contracts reject foreign bindings, duplicates, and partial patches", () => {
  const source = loaderFixture(true);
  const patched = loadGate.apply(source);
  const legacy = 'function legacyGate(){return(0,old.Zj)("1042620455")}';
  for (const candidate of [
    source + source,
    source + legacy,
    source + 'let duplicateGate="1042620455";' + legacy,
    patched + legacy,
    source + loadGate.apply(legacy),
    source.replace('Loader:(function(e,t,n){', 'Loader:(function(e,t){'),
    source.replace('(0,s.Zj)(p)', '(0,s.Zj)(other)'),
    source.replace('var s=n("statsig")', 'var unrelated=n("statsig")'),
    source.replace('let p="1042620455",', 'let p="another-gate",'),
    source.replace('"features.remote_connections"', '"unrelated-feature"'),
    source.replace('mC:function(){return(0,s.Zj)(p)}', 'mC:function(){return(0,s.Zj)(p)},second:function(){return(0,s.Zj)(p)}'),
    source + '/*codexLinuxRemoteControlLoadGateEnabled*/',
    patched.replace('codexLinuxRemoteControlLoadGateEnabled()||', ''),
    patched.replace(';function codexLinuxRemoteControlLoadGateEnabled(){return"undefined"!=typeof navigator&&navigator.userAgent.includes("Linux")}', ''),
  ]) {
    assert.notEqual(candidate, source);
    const { value, warnings } = captureWarnings(() => loadGate.apply(candidate));
    assert.equal(value, candidate);
    assert.match(warnings.join("\n"), /unique remote-control loader rollout gate/);
  }
});

test("settings page and search retain account restrictions and non-Linux hide gates", () => {
  for (const panel of [false, true]) {
    for (const expression of [false, true, "function"]) {
      const source = settingsFixture(panel, expression);
      assert.ok(settings.assetNeedles.every((needle) => source.includes(needle)));
      const { value: patched, warnings } = captureWarnings(() => settings.apply(source));
      assert.notEqual(patched, source);
      assert.deepEqual(warnings, []);
      assert.equal(patchBreaksJavaScriptSyntax(source, patched), false);
      assert.deepEqual(captureWarnings(() => settings.apply(patched)), { value: patched, warnings: [] });
      assert.equal(patched.split("codexLinuxRemoteControlOutboundTabGate").length - 1, panel ? 2 : 1);
      for (const userAgent of [undefined, "Linux", "Macintosh", "Windows"]) {
        for (const hidden of [false, true]) {
          for (const slingshot of [false, true]) {
            for (const available of [false, true]) {
              for (const accessRequired of [false, true]) {
                const state = { available, accessRequired };
                const imports = {
                  jotai: { un: (scope, run) => run }, gates: { P: "gate" }, state: { h9: "state" },
                  loader: { i2: "1042620455" }, statsig: { Zj: (id) => { assert.equal(id, "782640499"); return hidden; } },
                  visibility: { Zi: ({ remoteControlConnectionsState: value, slingshotEnabled }) =>
                    slingshotEnabled && (value?.available ?? true) && value?.accessRequired !== true },
                };
                const load = loadChunk(patched, imports, userAgent);
                const actual = load("Catalog").V4({ get: (atom, id) => atom === "state" ? state : id === "782640499" ? hidden : slingshot });
                const allowed = available && !accessRequired && slingshot;
                const expected = allowed && (userAgent === "Linux" || !hidden);
                assert.deepEqual(Array.from(actual), expected ? ["access-other-devices"] : []);
                if (panel) assert.equal(load("Panel").read(state, slingshot).showControlOtherDevices, expected);
                assert.equal(load("Catalog").K0, "782640499");
              }
            }
          }
        }
      }
    }
  }
});

test("settings contracts reject missing, foreign, duplicate, and partially patched consumers", () => {
  const source = settingsFixture(true, true);
  const patched = settings.apply(source);
  const marker = '/*codexLinuxRemoteControlOutboundTabGate*/(typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`)||';
  for (const candidate of [
    source + source,
    source + 'var oldHidden=(0,oldGates.read)("782640499"),oldVisible=!oldHidden,oldNull=null==oldValue;',
    source.replace('s&&!e(c.P,f)', 's&&e(c.P,f)'),
    source.replace('remoteControlConnectionsState:n', 'remoteControlConnectionsState:foreign'),
    source.replace('eI=n("Catalog")', 'eI=n("Unrelated")'),
    source.replace('K0:f', 'Changed:f'),
    source.replace('nT=!tN', 'nT=tN'),
    source.replace('showControlOtherDevices:nG', 'changedVisibility:nG'),
    source.replace('tN=(0,B.Zj)(eI.K0)', 'duplicate=(0,B.Zj)(eI.K0),tN=(0,B.Zj)(eI.K0)'),
    source + '/*codexLinuxRemoteControlOutboundTabGate*/',
    patched.replace(`${marker}!tN)`, '!tN'),
  ]) {
    assert.notEqual(candidate, source);
    const { value, warnings } = captureWarnings(() => settings.apply(candidate));
    assert.equal(value, candidate);
    assert.match(warnings.join("\n"), /complete remote-control outbound tab contracts/);
  }
});

test("copy discovery accepts stripped descriptions and changes only remote feature messages", () => {
  const unrelated = 'let meetings={id:"meetings.profile.oldSoundHint",defaultMessage:"Play a sound on this Mac"};let other="this Mac";';
  const source = [
    unrelated,
    'let mobile={id:"codexMobile.setupDialog.initial.heading.desktop",defaultMessage:"Connect a device to this Mac"};',
    'let settings={id:"settings.remoteConnections.tabs.controlThisMac",defaultMessage:"Control this Mac"};',
    'let security={accessRequired:true,authRequired:true,clientAuthorized:false};',
  ].join("");
  assert.ok(copy.assetNeedles.every((needle) => source.includes(needle)));
  const { value: patched, warnings } = captureWarnings(() => copy.apply(source));
  assert.notEqual(patched, source);
  assert.deepEqual(warnings, []);
  assert.ok(patched.includes(unrelated));
  assert.ok(patched.includes('defaultMessage:"Connect a device to this Linux desktop"'));
  assert.ok(patched.includes('defaultMessage:"Control this Linux desktop"'));
  assert.ok(patched.includes('let security={accessRequired:true,authRequired:true,clientAuthorized:false};'));
  assert.deepEqual(captureWarnings(() => copy.apply(patched)), { value: patched, warnings: [] });
});

function officialScripts(archive) {
  const fd = fs.openSync(archive, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const prefix = Buffer.alloc(16);
    assert.equal(fs.readSync(fd, prefix, 0, 16, 0), 16, "Truncated ASAR prefix");
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
        assert.ok(name && name !== "." && name !== ".." && !/[\\/\0]/.test(name));
        const location = parent + name;
        if (entry.files) { walk(entry.files, location + "/"); continue; }
        if (!location.endsWith(".js")) continue;
        assert.equal(entry.link, undefined);
        assert.equal(entry.unpacked, undefined);
        assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0);
        assert.ok(typeof entry.offset === "string" && /^\d+$/.test(entry.offset));
        const offset = Number(entry.offset);
        assert.ok(Number.isSafeInteger(offset) && offset <= size - dataStart - entry.size);
        const bytes = Buffer.alloc(entry.size);
        assert.equal(fs.readSync(fd, bytes, 0, bytes.length, dataStart + offset), bytes.length);
        scripts.push({ name: location, source: bytes.toString("utf8") });
      }
    };
    walk(files);
    return scripts;
  } finally { fs.closeSync(fd); }
}

test("verified official ASAR patches every current loader, copy and settings owner", {
  skip: !process.env.OFFICIAL_ASAR,
}, (t) => {
  const scripts = officialScripts(process.env.OFFICIAL_ASAR);
  for (const descriptor of [loadGate, copy, settings]) {
    const owners = scripts.filter(({ source }) => descriptor.assetNeedles.every((needle) => source.includes(needle)));
    assert.ok(owners.length > 0, `${descriptor.id}: no official owners`);
    for (const { name, source } of owners) {
      if (descriptor === copy) assert.match(source, /id:"(?:settings\.remote(?:Control)?Connections|codexMobile\.setup(?:Dialog|Page))\./);
      const { value: patched, warnings } = captureWarnings(() => descriptor.apply(source));
      assert.notEqual(patched, source, `${name}: ${descriptor.id} made no change`);
      assert.deepEqual(warnings, [], `${name}: ${descriptor.id} rejected the current owner`);
      assert.equal(patchBreaksJavaScriptSyntax(source, patched), false, `${name}: invalid patched JavaScript`);
      assert.deepEqual(captureWarnings(() => descriptor.apply(patched)), { value: patched, warnings: [] }, `${name}: not idempotent`);
    }
    t.diagnostic(`${descriptor.id}: ${owners.length} official owner copies passed`);
  }
});
