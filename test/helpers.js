'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normId } = require('../src/core/util');

/** In-memory content tree that mimics the AuthoringClient's read methods. */
function fakeClient(items) {
  const byId = new Map(items.map((i) => [normId(i.id), i]));
  const byPath = new Map(items.map((i) => [i.path.toLowerCase(), i]));
  const childrenOf = (p) => items.filter((i) => i.path.toLowerCase().startsWith(p.toLowerCase() + '/') && i.path.slice(p.length + 1).split('/').length === 1);
  const shape = (i) => ({ id: normId(i.id), name: i.path.split('/').pop(), path: i.path, updated: i.updated, hasChildren: childrenOf(i.path).length > 0 });
  const calls = { fields: 0, resolve: 0, search: 0 };
  return {
    calls,
    async getItemWithChildren({ id, path }) {
      const it = id ? byId.get(normId(id)) : byPath.get(path.toLowerCase());
      return it ? { ...shape(it), children: childrenOf(it.path).map(shape) } : null;
    },
    async getItemFields(id) {
      calls.fields++;
      const it = byId.get(normId(id));
      return it ? { id: normId(it.id), path: it.path, templateId: normId(it.template || ''), fields: Object.entries(it.fields || {}).map(([name, value]) => ({ name, value })) } : null;
    },
    async resolvePaths(paths) {
      const m = new Map();
      for (const p of paths) { const it = byPath.get(p.toLowerCase()); m.set(p, it ? { id: normId(it.id), path: it.path, templateId: normId(it.template || '') } : null); }
      return m;
    },
    async resolveIds(ids) {
      calls.resolve++;
      const m = new Map();
      for (const id of ids) { const it = byId.get(normId(id)); m.set(normId(id), it ? { id: normId(it.id), name: it.path.split('/').pop(), path: it.path } : null); }
      return m;
    },
    async searchUpdatedUnder(rootId, onPage) {
      calls.search++;
      const root = byId.get(normId(rootId));
      const under = items.filter((i) => i.path.toLowerCase().startsWith(root.path.toLowerCase() + '/') || i === root)
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
        .map((i) => ({ id: normId(i.id), path: i.path, updated: i.updated }));
      onPage(under);
    },
  };
}

const G = (n) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

/** A small site: home page with a local datasource, a shared datasource and media. */
function sampleTree() {
  return [
    // Templates: Page -> _Base Page -> Standard Template (System, always present)
    { id: G(100), path: '/sitecore/templates/Project/Site/Page', fields: { '__Base template': `{${G(101)}}` } },
    { id: G(101), path: '/sitecore/templates/Project/Site/_Base Page', fields: { '__Base template': `{${G(199)}}` } },
    { id: G(102), path: '/sitecore/templates/Project/Site/Promo', fields: {} },
    { id: G(103), path: '/sitecore/templates/Project/Site/Folder', fields: {} },
    { id: G(104), path: '/sitecore/templates/Foundation/Tenant', fields: {} },
    { id: G(199), path: '/sitecore/templates/System/Templates/Standard template', fields: {} },
    { id: G(1), path: '/sitecore/content/Tenant', updated: '20250101T000000Z', template: G(104) },
    { id: G(2), path: '/sitecore/content/Tenant/Site', updated: '20250101T000000Z', template: G(104) },
    { id: G(7), path: '/sitecore/content/Tenant/Site/Data', updated: '20250101T000000Z', template: G(103) },
    { id: G(8), path: '/sitecore/content/Tenant/Site/Data/Promos', updated: '20250101T000000Z', template: G(103) },
    { id: G(3), path: '/sitecore/content/Tenant/Site/Home', updated: '20251110T100000Z', template: G(100),
      fields: { __Renderings: `<r><d><r uid="{AAAAAAAA-0000-0000-0000-000000000000}" s:ds="{${G(20)}}" s:id="{${G(90)}}" /><r s:ds="local:/Data/Text 1" /></d></r>`, Title: 'Home' } },
    { id: G(4), path: '/sitecore/content/Tenant/Site/Home/Data', updated: '20250101T000000Z' },
    { id: G(5), path: '/sitecore/content/Tenant/Site/Home/Data/Text 1', updated: '20251112T090000Z', fields: { Text: 'hello' } },
    { id: G(6), path: '/sitecore/content/Tenant/Site/Home/About', updated: '20250105T000000Z', fields: { Title: 'About' } },
    { id: G(20), path: '/sitecore/content/Tenant/Site/Data/Promos/Promo A', updated: '20250101T000000Z', template: G(102),
      fields: { Image: `<image mediaid="{${G(30)}}" />`, Link: `<link linktype="internal" id="{${G(6)}}" />` } },
    { id: G(30), path: '/sitecore/media library/Project/Site/hero', updated: '20250101T000000Z' },
    { id: G(90), path: '/sitecore/layout/Renderings/Project/Site/Promo', updated: '20250101T000000Z', fields: { 'Datasource Template': `/sitecore/templates/Project/Site/Promo`, 'Parameters Template': `{${G(102)}}` } },
  ];
}

/** A temp project folder with sitecore.json and user.json. */
function tempProject({ localHost = 'https://xmcloudcm.localhost' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-'));
  fs.writeFileSync(path.join(dir, 'sitecore.json'), JSON.stringify({
    modules: ['authoring/items/*.module.json'],
    plugins: ['Sitecore.DevEx.Extensibility.Serialization@6.0.18', 'Sitecore.DevEx.Extensibility.XMCloud@1.1.6'],
    serialization: { defaultMaxRelativeItemPathLength: 100, defaultModuleRelativeSerializationPath: 'serialization' },
  }));
  fs.mkdirSync(path.join(dir, '.sitecore'));
  fs.writeFileSync(path.join(dir, '.sitecore', 'user.json'), JSON.stringify({
    endpoints: {
      xmCloud: { authority: 'https://auth.sitecorecloud.io', clientId: 'cli', accessToken: 'old-token', refreshToken: 'r1' },
      prod: { ref: 'XMCloud', host: 'https://xmc-acme-prod.sitecorecloud.io' },
      local: { ref: 'xmcloudlocal', allowWrite: true, host: localHost },
    },
  }, null, 2));
  return dir;
}

/** Fake "dotnet": pull writes one YAML per include, push just logs. Also rotates the token. */
function fakeDotnet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakedotnet-'));
  const script = path.join(dir, 'dotnet');
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const [, , tool, ser, op, flag, env] = process.argv;
fs.appendFileSync(path.join(process.cwd(), 'calls.log'), [tool, ser, op, flag, env].join(' ') + '\\n');
const uj = JSON.parse(fs.readFileSync('.sitecore/user.json', 'utf8'));
const ep = uj.endpoints[env];
if ((op === 'pull' || op === 'push') && !(ep && ep.allowWrite)) { console.log('Environment ' + env + ' is not configured to allow writing data.'); process.exit(1); }
if (op === 'pull') {
  const mod = JSON.parse(fs.readFileSync('DevSync.module.json', 'utf8'));
  for (const inc of mod.items.includes) {
    const d = path.join('items', inc.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'item.yml'), '---\\nID: "x"\\nPath: ' + inc.path + '\\nSharedFields:\\n- ID: "a"\\n  Hint: Email\\n  Value: ceo@acme.com\\n- ID: "b"\\n  Hint: Text\\n  Value: |\\n    Contact jane@acme.com today\\n');
  }
  const u = JSON.parse(fs.readFileSync('.sitecore/user.json', 'utf8'));
  u.endpoints.xmCloud.accessToken = 'new-token'; u.endpoints.xmCloud.refreshToken = 'r2';
  fs.writeFileSync('.sitecore/user.json', JSON.stringify(u));
  console.log('[master] Serialized ' + mod.items.includes.length + ' items');
}
if (op === 'push') console.log('[master] Pushed to ' + env);
if (process.env.FAKE_FAIL === op) { console.error('boom'); process.exit(3); }
`);
  fs.chmodSync(script, 0o755);
  return script;
}

module.exports = { fakeClient, sampleTree, tempProject, fakeDotnet, G };

/**
 * A stricter fake "dotnet" that models SCS semantics against a content tree (JSON file):
 *  - pull writes one SCS-style YAML per item covered by each include (ID, Template, Path, __Base template)
 *  - push fails with the real CLI's "Template ID … did not exist" error when an item's template
 *    is neither pulled nor already present locally (FAKE_LOCAL_TEMPLATES, comma-separated)
 */
function fakeDotnetTree(tree, { localTemplates = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakescs-'));
  const treeFile = path.join(dir, 'tree.json');
  fs.writeFileSync(treeFile, JSON.stringify(tree));
  const script = path.join(dir, 'dotnet');
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const [, , tool, ser, op, flag, env] = process.argv;
fs.appendFileSync(path.join(process.cwd(), 'calls.log'), [tool, ser, op, flag, env].join(' ') + '\\n');
const tree = JSON.parse(fs.readFileSync(${JSON.stringify(treeFile)}, 'utf8'));
const local = new Set(${JSON.stringify(localTemplates)}.map((x) => x.toLowerCase()));
const uj = JSON.parse(fs.readFileSync('.sitecore/user.json', 'utf8'));
if (!(uj.endpoints[env] && uj.endpoints[env].allowWrite)) { console.log('Environment ' + env + ' is not configured to allow writing data.'); process.exit(1); }
const low = (p) => p.toLowerCase();
const depth = (c, p) => { c = low(c); p = low(p); if (c === p) return 0; if (!c.startsWith(p + '/')) return -1; return c.slice(p.length + 1).split('/').length; };
const covers = (inc, p) => { const d = depth(p, inc.path); if (d < 0) return false; return inc.scope === 'SingleItem' ? d === 0 : inc.scope === 'ItemAndChildren' ? d <= 1 : true; };
const mod = JSON.parse(fs.readFileSync('DevSync.module.json', 'utf8'));
if (op === 'pull') {
  let n = 0;
  for (const inc of mod.items.includes) {
    const d = path.join('items', inc.name); fs.mkdirSync(d, { recursive: true });
    tree.filter((it) => covers(inc, it.path)).forEach((it, i) => {
      let y = '---\\nID: "' + it.id + '"\\nTemplate: "' + (it.template || '00000000-0000-0000-0000-0000000000ff') + '"\\nPath: ' + it.path + '\\n';
      if (it.fields && it.fields['__Base template']) y += 'SharedFields:\\n- ID: "12c33f3f-86c5-43a5-aeb4-5598cec45116"\\n  Hint: __Base template\\n  Value: "' + it.fields['__Base template'] + '"\\n';
      fs.writeFileSync(path.join(d, i + '.yml'), y); n++;
    });
  }
  console.log('[master] Serialized ' + n + ' items');
}
if (op === 'push') {
  const ids = new Set(), items = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const t = fs.readFileSync(p, 'utf8'); const id = /^ID: "(.+)"/m.exec(t)[1]; ids.add(id.toLowerCase()); items.push({ id, path: /^Path: (.+)$/m.exec(t)[1], tpl: /^Template: "(.+)"/m.exec(t)[1] }); } } };
  walk('items');
  for (const it of items) {
    if (!ids.has(it.tpl.toLowerCase()) && !local.has(it.tpl.toLowerCase()) && !it.tpl.endsWith('0000000000ff')) {
      console.log('GraphQL.ExecutionError: [A] ' + it.path + ' (' + it.id + '): Template ID ' + it.tpl + ' did not exist');
      process.exit(1);
    }
  }
  console.log('[master] Pushed ' + items.length + ' items to ' + env);
}
`);
  fs.chmodSync(script, 0o755);
  return script;
}

module.exports.fakeDotnetTree = fakeDotnetTree;

/** SCS simulator instance: cloud items + a stateful local DB. Returns { dotnet, local(), setLocal() }. */
function scsSim({ cloud, local = [], localDown = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scssim-'));
  const cfgFile = path.join(dir, 'cfg.json');
  const localDbFile = path.join(dir, 'local.json');
  fs.writeFileSync(localDbFile, JSON.stringify(local, null, 2));
  fs.writeFileSync(cfgFile, JSON.stringify({ cloud, localDbFile, cloudEnvs: ['prod'], localDown }));
  const dotnet = path.join(dir, 'dotnet');
  fs.writeFileSync(dotnet, `#!/bin/sh\nFAKE_SCS_CONFIG='${cfgFile}' exec node '${path.join(__dirname, 'fake-scs.js')}' "$@"\n`);
  fs.chmodSync(dotnet, 0o755);
  const readDb = () => JSON.parse(fs.readFileSync(localDbFile, 'utf8'));
  const norm = (x) => String(x).replace(/[{}-]/g, '').toLowerCase();
  // Fake local Authoring API over the same database: resolvePaths returns the FIRST item at a
  // path (like Sitecore does with duplicate names), deleteItem removes an item and its subtree.
  const api = {
    calls: [],
    async resolvePaths(paths) {
      if (localDown) throw new Error("Can't reach xmcloudcm.localhost");
      const db = readDb(); const m = new Map();
      for (const p of paths) { const it = db.find((i) => i.path.toLowerCase() === p.toLowerCase()); m.set(p, it ? { id: norm(it.id), path: it.path } : null); }
      return m;
    },
    async resolveIds(ids) {
      if (localDown) throw new Error("Can't reach xmcloudcm.localhost");
      const db = readDb(); const m = new Map();
      for (const id of ids) { const it = db.find((i) => norm(i.id) === norm(id)); m.set(norm(id), it ? { id: norm(it.id), path: it.path } : null); }
      return m;
    },
    async deleteItem(id) {
      api.calls.push(['delete', norm(id)]);
      let db = readDb();
      const doomed = new Set([norm(id)]);
      let grew = true;
      while (grew) { grew = false; for (const it of db) if (it.parent && doomed.has(norm(it.parent)) && !doomed.has(norm(it.id))) { doomed.add(norm(it.id)); grew = true; } }
      const before = db.length;
      db = db.filter((it) => !doomed.has(norm(it.id)));
      if (db.length === before) throw new Error(`item ${id} not found`);
      fs.writeFileSync(localDbFile, JSON.stringify(db, null, 2));
      return true;
    },
  };
  return {
    dotnet,
    api,
    local: () => JSON.parse(fs.readFileSync(localDbFile, 'utf8')),
    at: (p) => JSON.parse(fs.readFileSync(localDbFile, 'utf8')).find((i) => i.path.toLowerCase() === p.toLowerCase()),
  };
}
module.exports.scsSim = scsSim;

/** Add the folder items a real tree has between /sitecore/<root> and each item. */
function withFolders(items, folderTemplate = G(198)) {
  const TEMPLATE_TPL = G(196); // /sitecore/templates/System/Templates/Template
  const out = items.map((i) => (i.template ? i : /^\/sitecore\/templates\//i.test(i.path) ? { ...i, template: TEMPLATE_TPL } : { ...i, template: folderTemplate }));
  if (!out.some((i) => i.id === TEMPLATE_TPL)) out.push({ id: TEMPLATE_TPL, path: '/sitecore/templates/System/Templates/Template', template: TEMPLATE_TPL });
  const have = new Set(out.map((i) => i.path.toLowerCase()));
  let n = 0;
  for (const it of items) {
    const parts = it.path.split('/');
    for (let i = 4; i < parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!have.has(p.toLowerCase())) { have.add(p.toLowerCase()); out.push({ id: `${String(++n).padStart(8, '0')}-f0f0-f0f0-f0f0-f0f0f0f0f0f0`, path: p, template: folderTemplate, updated: '20240101T000000Z' }); }
    }
  }
  return out;
}
module.exports.withFolders = withFolders;
