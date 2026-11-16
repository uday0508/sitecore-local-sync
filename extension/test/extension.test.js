'use strict';

// Activates the BUNDLED extension (dist/extension.js) against a fake 'vscode' module and plays the
// webview's side of the conversation: the same messages bridge.js sends. The UI itself is covered by
// test/webview-smoke.js (real app.js in Electron); this file covers the extension host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshome-ext-'));
const { createFake, installFake } = require('./fake-vscode');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('../../test/helpers');

const DIST = path.join(__dirname, '..', 'dist', 'extension.js');
const manifest = require('../package.json');

const SYSTEM = [
  { id: G(199), path: '/sitecore/templates/System/Templates/Standard template' },
  { id: G(198), path: '/sitecore/templates/System/Templates/Folder' },
  { id: G(196), path: '/sitecore/templates/System/Templates/Template' },
];
const cloudTree = () => withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }]).filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
const baseLocal = () => [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' },
  { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) }];

function setup({ local = baseLocal(), listSites } = {}) {
  const root = tempProject();
  const cloud = cloudTree();
  const sim = scsSim({ cloud, local });
  const fake = createFake({ workspaceRoot: root, config: { dotnetPath: sim.dotnet } });
  const restore = installFake(fake);
  delete require.cache[require.resolve(DIST)];
  const ext = require(DIST);
  const client = fakeClient(cloud);
  client.listSites = listSites || (async () => [{ name: 'Site', rootPath: '/sitecore/content/Tenant/Site', rootId: G(2) }]);
  const memento = () => { const m = new Map(); return { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); } }; };
  const context = {
    subscriptions: [],
    extensionPath: path.join(__dirname, '..'),
    workspaceState: memento(), globalState: memento(),
    secrets: { _m: new Map(), async get(k) { return this._m.get(k); }, async store(k, v) { this._m.set(k, v); } },
    devsyncFactories: { createSourceClient: () => client, createLocalClient: () => sim.api },
  };
  const api = ext.activate(context);
  // Act as the webview page: send a request, await its reply.
  let seq = 0;
  const request = async (channel, arg) => {
    const p = fake.shown.panels.at(-1);
    const id = ++seq;
    p.fromPage({ kind: 'request', id, channel, arg });
    for (let i = 0; i < 400; i++) {
      const r = p.sent.find((m) => m.kind === 'reply' && m.id === id);
      if (r) return r.result;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error(`no reply to ${channel}`);
  };
  const pushes = (channel) => fake.shown.panels.at(-1).sent.filter((m) => m.kind === 'push' && m.channel === channel).map((m) => m.payload);
  return { root, sim, fake, ext, api, context, client, restore, request, pushes, cmd: (id, ...a) => fake.vscode.commands.executeCommand(id, ...a) };
}

test('manifest and code agree, and the package ships the UI', () => {
  const t = setup();
  try {
    const contributed = manifest.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual([...t.fake.commands.keys()].sort(), contributed);
    for (const group of Object.values(manifest.contributes.menus)) for (const m of group) assert.ok(contributed.includes(m.command), m.command);
    for (const f of ['index.html', 'app.js', 'styles.css', 'bridge.js', 'vscode-theme.css']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'dist', 'ui', f)), f);
    assert.match(fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8'), /!dist\/ui\/\*\*/);
  } finally { t.restore(); }
});

test('Open DevSync shows the desktop UI in a full editor tab, with a nonce CSP and the bridge', async () => {
  const t = setup();
  try {
    await t.cmd('devsync.open');
    const p = t.fake.shown.panels.at(-1);
    assert.equal(p.title, 'DevSync');
    assert.equal(p.options.enableScripts, true);
    assert.equal(p.options.retainContextWhenHidden, true);
    const html = p.webview.html;
    assert.match(html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
    assert.ok(html.indexOf('bridge.js') < html.indexOf('app.js'));
    assert.doesNotMatch(html, /demo\.js/);
    assert.match(html, /vscode-resource:.*styles\.css/);
    assert.match(html, /id="syncBtn"/, 'the same UI as the desktop app');
    // Opening again reuses the tab.
    await t.cmd('devsync.open');
    assert.equal(t.fake.shown.panels.length, 1);
    assert.equal(p.revealed, 1);
  } finally { t.restore(); }
});

test('the Activity Bar icon opens the panel', async () => {
  const t = setup();
  try {
    t.fake.trees['devsync.home'].show();
    assert.equal(t.fake.shown.panels.length, 1);
  } finally { t.restore(); }
});

test('the page talks to the shared host: opens the workspace project, connects, syncs with conflicts', async () => {
  const t = setup({ local: [...baseLocal(), { id: G(777), path: '/sitecore/content/Tenant/Site/Data', template: G(198), parent: G(2) }] });
  try {
    await t.cmd('devsync.open');
    t.fake.shown.panels.at(-1).fromPage({ kind: 'ready' });
    const proj = await t.request('project:last');
    assert.equal(proj.ok, true);
    assert.equal(proj.data.root, t.root, 'the workspace folder is the project');
    const conn = await t.request('source:connect', { source: 'prod', auth: { mode: 'cli' } });
    assert.equal(conn.ok, true);
    assert.equal(conn.data.sites[0].name, 'Site');
    const profile = { name: 'Quick sync', source: 'prod', target: 'local', language: 'en', selections: [{ id: G(3), path: '/sitecore/content/Tenant/Site/Home', name: 'Home', scope: 'ItemAndDescendants' }], dependencies: {}, pushMode: 'safe', includeAncestors: true, onConflict: 'ask', mask: { enabled: false } };
    const plan = await t.request('sync:plan', { profile, mode: 'full' });
    assert.equal(plan.ok, true);
    const run = t.request('sync:run', { profile });
    for (let i = 0; i < 300 && !t.pushes('sync:conflicts').length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.fake.contexts['devsync.running'], true);
    assert.equal(t.pushes('sync:conflicts')[0][0].path, '/sitecore/content/Tenant/Site/Data');
    await t.request('sync:resolve', { decision: 'replace' });
    const r = await run;
    assert.equal(r.ok, true);
    assert.equal(t.fake.contexts['devsync.running'], false);
    assert.equal(t.sim.at('/sitecore/content/Tenant/Site/Data').id, G(7));
    assert.ok(t.pushes('sync:event').some((e) => e.type === 'report'));
    assert.ok(t.fake.shown.log.some((l) => /ser push -n local/.test(l)), 'CLI output mirrored to the DevSync output channel');
  } finally { t.restore(); }
});

test('closing the tab during a sync cancels it', async () => {
  const t = setup();
  try {
    fs.writeFileSync(t.sim.dotnet, '#!/bin/sh\nwhile true; do echo "[master] Serialized item"; sleep 0.1; done\n');
    await t.cmd('devsync.open');
    await t.request('project:last');
    await t.request('source:connect', { source: 'prod' });
    const profile = { name: 'Quick sync', source: 'prod', target: 'local', selections: [{ id: G(3), path: '/sitecore/content/Tenant/Site/Home', name: 'Home', scope: 'SingleItem' }], dependencies: {} };
    await t.request('sync:plan', { profile, mode: 'full' });
    const p = t.fake.shown.panels.at(-1);
    const id = 999; p.fromPage({ kind: 'request', id, channel: 'sync:run', arg: { profile } });
    for (let i = 0; i < 200 && !t.api.host.session.running; i++) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 100 && !t.fake.shown.log.some((l) => /ser pull/.test(l)); i++) await new Promise((r) => setTimeout(r, 20));
    p.close();
    for (let i = 0; i < 300 && t.api.host.session.running; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.api.host.session.running, null);
  } finally { t.restore(); }
});

test('right-click a .yml: asks for scope, opens the panel and hands it the item', async () => {
  const t = setup();
  try {
    const yml = path.join(t.root, 'About.yml');
    fs.writeFileSync(yml, `---\nID: "${G(6)}"\nParent: "${G(3)}"\nPath: /sitecore/content/Tenant/Site/Home/About\nSharedFields:\n`);
    t.fake.answer('SingleItem');
    await t.cmd('devsync.pullItem', t.fake.vscode.Uri.file(yml));
    const p = t.fake.shown.panels.at(-1);
    assert.ok(p, 'panel opened');
    p.fromPage({ kind: 'ready' }); // queued until the page is ready
    const cmd = t.pushes('ui:command')[0];
    assert.equal(cmd.type, 'sync');
    assert.deepEqual(cmd.items, [{ id: G(6).replace(/-/g, ''), path: '/sitecore/content/Tenant/Site/Home/About', scope: 'SingleItem' }]);
  } finally { t.restore(); }
});

test('a non-item .yml is refused with a clear message', async () => {
  const t = setup();
  try {
    const yml = path.join(t.root, 'docker-compose.yml');
    fs.writeFileSync(yml, 'services:\n  cm:\n    image: x\n');
    t.fake.answer(undefined);
    await t.cmd('devsync.pullItem', t.fake.vscode.Uri.file(yml));
    assert.ok(t.fake.shown.error.some((m) => /not a serialized Sitecore item/.test(m.msg)));
  } finally { t.restore(); }
});

test('Page Builder links: validated, matched to a connected environment, confirmed, then handed to the UI', async () => {
  const t = setup();
  try {
    const h = t.fake.vscode._uriHandler;
    const u = (q) => t.fake.vscode.Uri.parse(`vscode://uday0508.devsync-sitecoreai/sync?${q}`);
    await h.handleUri(u(`host=evil.example.com&item=${G(3)}`));
    assert.ok(t.fake.shown.error.some((m) => /SitecoreAI environment/.test(m.msg)));
    await h.handleUri(u(`host=xmc-other.sitecorecloud.io&item=${G(3)}`));
    assert.ok(t.fake.shown.error.some((m) => /no connection to xmc-other\.sitecorecloud\.io/.test(m.msg)));
    t.fake.answer(undefined); // declined: nothing happens
    await h.handleUri(u(`host=xmc-acme-prod.sitecorecloud.io&item=${G(3)}&lang=fr-FR&scope=SingleItem`));
    assert.equal(t.fake.shown.panels.length, 1, 'only the earlier panel');
    t.fake.answer('Preview first');
    await h.handleUri(u(`host=xmc-acme-prod.sitecorecloud.io&item=${G(3)}&lang=fr-FR&scope=SingleItem`));
    t.fake.shown.panels.at(-1).fromPage({ kind: 'ready' });
    const cmd = t.pushes('ui:command').at(-1);
    assert.deepEqual(cmd, { type: 'sync', source: 'prod', language: 'fr-FR', items: [{ id: G(3).replace(/-/g, ''), scope: 'SingleItem' }], preview: true, label: 'Opened from Page Builder' });
    const asked = t.fake.shown.info.find((m) => /Sync the page from Page Builder/.test(m.msg));
    assert.ok(asked.opts.modal);
  } finally { t.restore(); }
});

test('expired CLI login: "Log in" runs the login in a terminal, and the panel reconnects when user.json changes', async () => {
  let expired = true;
  const t = setup({ listSites: async () => {
    if (expired) { const e = new Error('Your Sitecore CLI login has expired. Run "dotnet sitecore cloud login" in the project folder, then connect again.'); e.code = 'LOGIN_EXPIRED'; throw e; }
    return [{ name: 'Site', rootPath: '/sitecore/content/Tenant/Site', rootId: G(2) }];
  } });
  try {
    await t.cmd('devsync.open');
    t.fake.shown.panels.at(-1).fromPage({ kind: 'ready' });
    await t.request('project:last');
    t.fake.answer('Log in');
    const r = await t.request('source:connect', { source: 'prod' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LOGIN_EXPIRED');
    for (let i = 0; i < 100 && !t.fake.shown.terminals.length; i++) await new Promise((res) => setTimeout(res, 10));
    const term = t.fake.shown.terminals[0];
    assert.equal(term.cwd, t.root);
    assert.deepEqual(term.sent, ['dotnet sitecore cloud login']);
    expired = false;
    t.fake.vscode._watchers[0].fire();
    for (let i = 0; i < 300 && !t.pushes('ui:command').length; i++) await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(t.pushes('ui:command')[0], { type: 'reconnect' });
  } finally { t.restore(); }
});

test('settings and secrets stay in VS Code storage, never in the repo', async () => {
  const t = setup();
  try {
    await t.cmd('devsync.open');
    await t.request('project:last');
    await t.request('source:connect', { source: 'prod', auth: { mode: 'automation', clientId: 'cid', clientSecret: 's3cret' }, remember: true });
    const creds = await t.request('creds:get', { endpoint: 'prod' });
    assert.deepEqual(creds.data, { clientId: 'cid', clientSecret: 's3cret' });
    await t.request('settings:set', { lastSource: 'prod', evil: 'x' });
    const s = await t.request('settings:get');
    assert.equal(s.data.lastSource, 'prod');
    assert.equal(s.data.evil, undefined, 'only known settings are stored');
    const repo = fs.readdirSync(t.root, { recursive: true }).map((f) => path.join(t.root, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join(' ');
    assert.doesNotMatch(repo, /s3cret/);
  } finally { t.restore(); }
});

test('unknown requests from the page are refused', async () => {
  const t = setup();
  try {
    await t.cmd('devsync.open');
    const r = await t.request('fs:delete', { path: '/' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Unknown request/);
  } finally { t.restore(); }
});

test('engine: a rejected refresh token becomes LOGIN_EXPIRED, a rejected client CLIENT_REJECTED', async () => {
  const { cliSessionProvider, automationClientProvider } = require('../../src/core/auth');
  const deny = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }), { status: 403 });
  const p = cliSessionProvider({ endpoint: { name: 'prod', clientId: 'c', refreshToken: 'dead', authority: 'https://auth.sitecorecloud.io' }, fetchImpl: deny });
  await assert.rejects(p.getToken(true), (e) => e.code === 'LOGIN_EXPIRED');
  const a = automationClientProvider({ clientId: 'x', clientSecret: 'y', fetchImpl: deny });
  await assert.rejects(a.getToken(true), (e) => e.code === 'CLIENT_REJECTED');
});
