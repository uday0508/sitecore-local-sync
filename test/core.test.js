'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractGuids, parseSitecoreDate, bracedId } = require('../src/core/util');
const { loadProject, resolveEndpoint, isLocalHost } = require('../src/core/project');
const { discoverDependencies } = require('../src/core/dependencies');
const { findChangedItems } = require('../src/core/delta');
const { buildPlan, toModuleJson } = require('../src/core/plan');
const { maskYamlText } = require('../src/core/mask');
const { assertSafeTargets } = require('../src/core/workspace');
const { saveProfile, listProfiles, getLastSync } = require('../src/core/profiles');
const { planSync, executeSync } = require('../src/core/sync');
const { AuthoringClient } = require('../src/core/graphql');
const { fakeClient, sampleTree, tempProject, fakeDotnet, G } = require('./helpers');

const HOME = { id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' };

test('extracts braced and bare GUIDs and normalises them', () => {
  const s = extractGuids('<r s:ds="{110D559F-DEA5-42EA-9C1C-8A5DF7E70EF9}" x="a58aab49-fe07-4ab5-b03f-927c581e74d7"/>');
  assert.deepEqual([...s].sort(), ['110d559fdea542ea9c1c8a5df7e70ef9', 'a58aab49fe074ab5b03f927c581e74d7']);
  assert.equal(bracedId('110d559fdea542ea9c1c8a5df7e70ef9'), '{110D559F-DEA5-42EA-9C1C-8A5DF7E70EF9}');
  assert.equal(parseSitecoreDate('20241114T120709Z').toISOString(), '2024-11-14T12:07:09.000Z');
});

test('reads endpoints, follows refs case-insensitively, detects local hosts', () => {
  const p = loadProject(tempProject());
  const prod = resolveEndpoint(p.userJson, 'prod');
  assert.equal(prod.host, 'https://xmc-acme-prod.sitecorecloud.io');
  assert.equal(prod.accessToken, 'old-token');
  assert.equal(prod.tokenSource, 'xmCloud');
  assert.deepEqual(p.endpoints.map((e) => [e.name, e.isLocal]), [['prod', false], ['local', true]]);
  assert.ok(isLocalHost('https://xmcloudcm.localhost'));
  assert.ok(isLocalHost('http://127.0.0.1:8080'));
  assert.ok(!isLocalHost('https://evil.localhost.example.com'));
});

test('dependency discovery brings datasources, media, renderings and the full template chain', async () => {
  const client = fakeClient(sampleTree());
  const r = await discoverDependencies(client, [HOME], {});
  const by = (cat) => r.dependencies.filter((d) => d.category === cat).map((d) => d.path).sort();
  assert.deepEqual(by('content'), ['/sitecore/content/Tenant/Site/Data/Promos/Promo A']);
  assert.deepEqual(by('media'), ['/sitecore/media library/Project/Site/hero']);
  assert.deepEqual(by('layout'), ['/sitecore/layout/Renderings/Project/Site/Promo']);
  assert.deepEqual(by('template'), [
    '/sitecore/templates/Foundation/Tenant',            // template of parent folders Tenant/Site
    '/sitecore/templates/Project/Site/Folder',          // template of parent folders Data/Promos
    '/sitecore/templates/Project/Site/Page',            // template of Home
    '/sitecore/templates/Project/Site/Promo',           // template of the Promo A datasource + rendering params
    '/sitecore/templates/Project/Site/_Base Page',      // base template of Page
  ]);
  // System templates are built in, so they are skipped, not pulled.
  assert.ok(r.skipped.some((x) => /System\/Templates\/Standard template/.test(x.path) && x.why === 'built into every CM'));
  // The About link target is inside the selected tree, so it is not added again.
  assert.ok(!r.dependencies.some((d) => d.path.endsWith('/Home/About')));
});

test('templates and renderings can be turned off, or limited to /Project/', async () => {
  const off = await discoverDependencies(fakeClient(sampleTree()), [HOME], { templates: false, renderings: false });
  assert.ok(!off.dependencies.some((d) => d.category === 'template' || d.category === 'layout'));
  const proj = await discoverDependencies(fakeClient(sampleTree()), [HOME], { projectOnly: true });
  assert.ok(!proj.dependencies.some((d) => d.path === '/sitecore/templates/Foundation/Tenant'));
  assert.ok(proj.dependencies.some((d) => d.path === '/sitecore/templates/Project/Site/Page'));
});

test('plan: templates go first, with subtree and CreateOnly so local definitions are never overwritten', async () => {
  const r = await discoverDependencies(fakeClient(sampleTree()), [HOME], {});
  const plan = buildPlan({ selections: [HOME], dependencies: r.dependencies });
  const tpl = plan.includes.filter((i) => i.kind === 'template');
  assert.ok(tpl.length >= 5);
  assert.ok(tpl.every((i) => i.scope === 'ItemAndDescendants' && i.allowedPushOperations === 'CreateOnly'));
  assert.ok(plan.includes[0].path.startsWith('/sitecore/templates'));
  const firstContent = plan.includes.findIndex((i) => i.path.startsWith('/sitecore/content'));
  const lastTemplate = plan.includes.map((i) => i.path.startsWith('/sitecore/templates')).lastIndexOf(true);
  assert.ok(lastTemplate < firstContent, 'all templates before any content');
  assert.equal(plan.includes.find((i) => i.kind === 'layout').allowedPushOperations, 'CreateOnly');
  const over = buildPlan({ selections: [HOME], dependencies: r.dependencies, overwriteDefinitions: true });
  assert.ok(over.includes.filter((i) => i.kind === 'template').every((i) => i.allowedPushOperations === 'CreateAndUpdate'));
});

test('plan removes overlaps, adds CreateOnly parents and orders templates/renderings first', () => {
  const plan = buildPlan({
    selections: [HOME, { id: G(6), path: '/sitecore/content/Tenant/Site/Home/About', scope: 'SingleItem' }],
    dependencies: [
      { path: '/sitecore/media library/Project/Site/hero', category: 'media' },
      { path: '/sitecore/layout/Renderings/Project/Site/Promo', category: 'layout' },
    ],
  });
  const paths = plan.includes.map((i) => i.path);
  assert.ok(!paths.includes('/sitecore/content/Tenant/Site/Home/About'), 'covered child removed');
  // Layout tree first, and every parent appears before its children.
  assert.ok(plan.includes[0].path.startsWith('/sitecore/layout'));
  plan.includes.forEach((inc, i) => {
    const later = plan.includes.slice(i + 1);
    assert.ok(!later.some((o) => inc.path.toLowerCase().startsWith(o.path.toLowerCase() + '/')), `${inc.path} comes before its parent`);
  });
  const tenant = plan.includes.find((i) => i.path === '/sitecore/content/Tenant');
  assert.equal(tenant.allowedPushOperations, 'CreateOnly');
  assert.equal(plan.includes.find((i) => i.path === HOME.path).allowedPushOperations, 'CreateAndUpdate');
  const names = plan.includes.map((i) => i.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'include names unique');
  const mod = toModuleJson(plan);
  assert.equal(mod.namespace, 'DevSync');
  assert.deepEqual(Object.keys(mod.items.includes[0]).sort(), ['allowedPushOperations', 'name', 'path', 'scope']);
});

test('mirror mode only applies delete to user selections', () => {
  const plan = buildPlan({ selections: [HOME], dependencies: [{ path: '/sitecore/media library/Project/Site/hero', category: 'media' }], pushMode: 'mirror' });
  assert.equal(plan.includes.find((i) => i.path === HOME.path).allowedPushOperations, 'CreateUpdateAndDelete');
  assert.equal(plan.includes.find((i) => i.kind === 'media').allowedPushOperations, 'CreateAndUpdate');
});

test('delta finds only items updated after the last sync', async () => {
  const changed = await findChangedItems(fakeClient(sampleTree()), [HOME], '2025-11-11T00:00:00Z');
  assert.deepEqual(changed.map((c) => c.path), ['/sitecore/content/Tenant/Site/Home/Data/Text 1']);
});

test('masking replaces named fields and scrubs emails in block values', () => {
  const yml = '---\nSharedFields:\n- ID: "a"\n  Hint: Email\n  Value: ceo@acme.com\n- ID: "b"\n  Hint: Text\n  Value: |\n    Mail jane@acme.com now\n    second line\n- ID: "c"\n  Hint: Title\n  Value: Hello\n';
  const r = maskYamlText(yml, { enabled: true });
  assert.match(r.text, /Hint: Email\n {2}Value: "\*\*\*"/);
  assert.match(r.text, /Mail masked@example\.invalid now\n {4}second line/);
  assert.match(r.text, /Value: Hello/);
  assert.equal(r.changes, 2);
});

test('refuses to push anywhere except a local CM', () => {
  const p = loadProject(tempProject());
  assert.throws(() => assertSafeTargets(p, 'local', 'prod'), /not a local CM/);
  assert.throws(() => assertSafeTargets(p, 'prod', 'prod'), /different/);
  assert.doesNotThrow(() => assertSafeTargets(p, 'prod', 'local'));
});

test('GraphQL client blocks mutations, retries 401 with a fresh token, batches ID lookups', async () => {
  let tokenCalls = 0; const bodies = [];
  const tokenProvider = { getToken: async (force) => { tokenCalls++; return force ? 'fresh' : 'stale'; } };
  const fetchImpl = async (url, init) => {
    const auth = init.headers.Authorization; bodies.push(JSON.parse(init.body).query);
    if (auth === 'Bearer stale') return { ok: false, status: 401, text: async () => 'unauthorized' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { i0: { itemId: G(5).replace(/-/g, ''), name: 'x', path: '/sitecore/content/x', template: { name: 't', templateId: 'abc' } }, i1: null } }) };
  };
  const c = new AuthoringClient({ host: 'xmc-acme-prod.sitecorecloud.io', tokenProvider, fetchImpl });
  assert.equal(c.endpoint, 'https://xmc-acme-prod.sitecorecloud.io/sitecore/api/authoring/graphql/v1/');
  await assert.rejects(c.query('mutation { deleteItem(input:{path:"/"}) { successful } }'), /read-only/);
  const m = await c.resolveIds([G(5), G(6)]);
  assert.equal(m.get(G(5).replace(/-/g, '')).path, '/sitecore/content/x');
  assert.equal(m.get(G(6).replace(/-/g, '')), null);
  assert.ok(tokenCalls >= 2, 'stale token retried with a fresh one');
  assert.match(bodies[0], /itemId: "\{00000005-0000-0000-0000-000000000000\}"/);
});

test('end to end: plan, pull, mask, push in an isolated workspace, record state, save tokens back', async () => {
  const dir = tempProject();
  const project = loadProject(dir);
  const profile = saveProfile(dir, {
    name: 'Homepage', source: 'prod', target: 'local', selections: [HOME],
    dependencies: { media: true, datasources: true }, mask: { enabled: true },
  });
  assert.equal(listProfiles(dir).length, 1);
  const planned = await planSync(fakeClient(sampleTree()), profile, { projectRoot: dir });
  const events = [];
  const r = await executeSync(project, profile, planned, { dotnet: fakeDotnet(), onEvent: (e) => events.push(e) });

  const ws = path.join(dir, '.devsync', 'workspace');
  const calls = fs.readFileSync(path.join(ws, 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['sitecore ser pull -n prod', 'sitecore ser push -n local']);
  assert.equal(r.pulled, planned.plan.includes.length);

  // The user's project files are untouched apart from refreshed token fields.
  const sj = JSON.parse(fs.readFileSync(path.join(dir, 'sitecore.json'), 'utf8'));
  assert.deepEqual(sj.modules, ['authoring/items/*.module.json']);
  const wsSj = JSON.parse(fs.readFileSync(path.join(ws, 'sitecore.json'), 'utf8'));
  assert.deepEqual(wsSj.modules, ['DevSync.module.json']);
  assert.equal(wsSj.plugins.length, 2);
  const user = JSON.parse(fs.readFileSync(path.join(dir, '.sitecore', 'user.json'), 'utf8'));
  assert.equal(user.endpoints.xmCloud.refreshToken, 'r2');
  assert.equal(user.endpoints.prod.host, 'https://xmc-acme-prod.sitecorecloud.io');
  // allowWrite was only enabled in the private workspace copy, never in the user's file.
  assert.equal(user.endpoints.prod.allowWrite, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '.sitecore', 'user.json'), 'utf8')).endpoints.prod.allowWrite, true);
  assert.ok(fs.existsSync(path.join(dir, '.devsync', 'user.json.bak')));

  // Masking ran before push.
  const anyYml = fs.readdirSync(path.join(ws, 'items'))[0];
  const yml = fs.readFileSync(path.join(ws, 'items', anyYml, 'item.yml'), 'utf8');
  assert.ok(!/acme\.com/.test(yml));
  assert.ok(events.some((e) => e.type === 'step' && e.id === 'mask' && e.status === 'done'));

  // State recorded, so a delta run now works.
  assert.ok(getLastSync(dir, 'Homepage'));
  const delta = await planSync(fakeClient(sampleTree()), profile, { mode: 'delta', projectRoot: dir, since: '2025-11-11T00:00:00Z' });
  assert.ok(delta.plan.includes.some((i) => i.kind === 'changed' && i.path.endsWith('Text 1')));
});

test('a failing CLI step surfaces an error event and does not record a sync', async () => {
  const dir = tempProject();
  const project = loadProject(dir);
  const profile = saveProfile(dir, { name: 'X', source: 'prod', target: 'local', selections: [HOME], dependencies: { media: false, datasources: false } });
  const planned = await planSync(fakeClient(sampleTree()), profile, { projectRoot: dir });
  process.env.FAKE_FAIL = 'push';
  const events = [];
  await assert.rejects(executeSync(project, profile, planned, { dotnet: fakeDotnet(), onEvent: (e) => events.push(e) }), /exited with code 3/);
  delete process.env.FAKE_FAIL;
  assert.ok(events.some((e) => e.type === 'error'));
  assert.equal(getLastSync(dir, 'X'), null);
});

test('.devsync gitignore keeps profiles shareable but ignores workspace and secrets', async () => {
  const dir = tempProject();
  const project = loadProject(dir);
  const profile = saveProfile(dir, { name: 'G', source: 'prod', target: 'local', selections: [HOME], dependencies: { media: false, datasources: false } });
  const planned = await planSync(fakeClient(sampleTree()), profile, { projectRoot: dir });
  await executeSync(project, profile, planned, { dotnet: fakeDotnet() });
  assert.equal(fs.readFileSync(path.join(dir, '.devsync', '.gitignore'), 'utf8'), '*\n!.gitignore\n!profiles.json\n');
});

// ---- Regression: user.json with only the CLI login ("xmCloud" -> Deploy API) and a local "default" ----
const { listEndpoints, isLoginEndpoint } = require('../src/core/project');
const { listProjects, listEnvironments, connectEnvironment, parseJsonOutput } = require('../src/core/environments');
const { createSourceClient } = require('../src/core/sync');
const os = require('os');

const LOGIN_ONLY = {
  endpoints: {
    xmCloud: { host: 'https://xmclouddeploy-api.sitecorecloud.io/', authority: 'https://auth.sitecorecloud.io/', clientId: 'Chi8E', accessToken: 'a', refreshToken: 'r', allowWrite: true },
    default: { ref: 'xmCloud', host: 'https://xmcloudcm.localhost/', allowWrite: true },
  },
};

test('the CLI login endpoint (Deploy API host) is never offered as a sync source', () => {
  const eps = listEndpoints(LOGIN_ONLY);
  assert.deepEqual(eps.map((e) => [e.name, e.kind]), [['xmCloud', 'login'], ['default', 'local']]);
  assert.ok(isLoginEndpoint('xmCloud', LOGIN_ONLY.endpoints.xmCloud));
  const p = loadProject(tempProject());
  p.userJson = LOGIN_ONLY;
  assert.throws(() => createSourceClient(p, 'xmCloud', { mode: 'cli' }), /login.*not an environment/i);
});

test('an environment endpoint without its own host does not inherit the Deploy API host', () => {
  const uj = { endpoints: { ...LOGIN_ONLY.endpoints, broken: { ref: 'xmCloud' } } };
  assert.equal(resolveEndpoint(uj, 'broken').host, '');
  assert.ok(!listEndpoints(uj).some((e) => e.name === 'broken'));
});

test('a clear message when the host is not a CM (404)', async () => {
  const c = new AuthoringClient({ host: 'https://xmclouddeploy-api.sitecorecloud.io', tokenProvider: { getToken: async () => 't' },
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) });
  await assert.rejects(c.listSites(), /No Authoring API found.*404/);
});

test('parses CLI JSON even with banner text around it', () => {
  assert.deepEqual(parseJsonOutput('Sitecore CLI v6\n[{"id":"a"}]\nDone'), [{ id: 'a' }]);
  assert.throws(() => parseJsonOutput('You are not logged in'), /did not return JSON/);
});

test('discovers projects/environments and connects one through the Sitecore CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecli-'));
  const script = path.join(dir, 'dotnet');
  fs.writeFileSync(script, `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
require('fs').appendFileSync(require('path').join(process.cwd(), 'cli.log'), a + '\\n');
if (a.includes('project list')) console.log('Info: org Acme\\n[{"Id":"p1","Name":"Biztech"}]');
else if (a.includes('environment list')) console.log(JSON.stringify([{ id: 'e1', name: 'dev', host: 'xmc-biz-dev.sitecorecloud.io', isProd: false }]));
else if (a.includes('environment connect')) {
  const f = '.sitecore/user.json'; const u = JSON.parse(require('fs').readFileSync(f, 'utf8'));
  u.endpoints.dev = { ref: 'xmCloud', allowWrite: false, host: 'https://xmc-biz-dev.sitecorecloud.io' };
  require('fs').writeFileSync(f, JSON.stringify(u));
}
`);
  fs.chmodSync(script, 0o755);
  const proj = tempProject();
  fs.writeFileSync(path.join(proj, '.sitecore', 'user.json'), JSON.stringify(LOGIN_ONLY));
  const opts = { dotnet: script };
  assert.deepEqual(await listProjects(proj, opts), [{ id: 'p1', name: 'Biztech' }]);
  const envs = await listEnvironments(proj, 'p1', opts);
  assert.equal(envs[0].host, 'xmc-biz-dev.sitecorecloud.io');
  await connectEnvironment(proj, 'e1', opts);
  const eps = loadProject(proj).endpoints;
  assert.deepEqual(eps.map((e) => [e.name, e.kind]), [['xmCloud', 'login'], ['default', 'local'], ['dev', 'cloud']]);
  // Token comes from the login endpoint through the ref.
  assert.equal(resolveEndpoint(loadProject(proj).userJson, 'dev').accessToken, 'a');
  const log = fs.readFileSync(path.join(proj, 'cli.log'), 'utf8');
  assert.match(log, /cloud environment connect --environment-id e1\n/);
  assert.ok(!/allow-write/.test(log), 'connects read-only');
  await assert.rejects(listEnvironments(proj, 'p1; rm -rf /', opts), /Invalid project ID/);
});

// ---- Template completeness: scan limits must never cause "Template ID … did not exist" ----
const { fakeDotnetTree } = require('./helpers');
const { readPulledItems } = require('../src/core/closure');

function bigTree() {
  const t = sampleTree();
  // Deep in Home, past any scan cap: an item whose template (and its base) nothing else uses.
  t.push({ id: G(60), path: '/sitecore/content/Tenant/Site/Home/Products', updated: '20250101T000000Z', template: G(100) });
  t.push({ id: G(61), path: '/sitecore/content/Tenant/Site/Home/Products/Data', updated: '20250101T000000Z', template: G(103) });
  t.push({ id: G(62), path: '/sitecore/content/Tenant/Site/Home/Products/Data/Quick Links', updated: '20250101T000000Z', template: G(110) });
  t.push({ id: G(110), path: '/sitecore/templates/Project/Site/Mock-Link List', fields: { '__Base template': `{${G(111)}}` } });
  t.push({ id: G(111), path: '/sitecore/templates/Project/Site/_Link List Base', fields: {} });
  t.push({ id: G(112), path: '/sitecore/templates/System/Custom/Odd Template', fields: {} });
  t.push({ id: G(63), path: '/sitecore/content/Tenant/Site/Home/About/Odd', updated: '20250101T000000Z', template: G(112) });
  return t;
}
const SYSTEM_TEMPLATES = [G(199)];

test('reads template IDs and base templates from pulled SCS files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yml-'));
  fs.writeFileSync(path.join(dir, 'a.yml'), `---\nID: "${G(62)}"\nParent: "x"\nTemplate: "${G(110)}"\nPath: /sitecore/content/x\nLanguages:\n- Language: en\n  Versions:\n  - Version: 1\n    Fields:\n    - ID: "f"\n      Hint: Title\n      Value: hi\n`);
  fs.writeFileSync(path.join(dir, 'b.yml'), `---\nID: "${G(110)}"\nTemplate: "ab3c1b4a-0000-0000-0000-000000000000"\nPath: /sitecore/templates/x\nSharedFields:\n- ID: "12c33f3f-86c5-43a5-aeb4-5598cec45116"\n  Hint: __Base template\n  Value: |\n    {${G(111)}}\n    {${G(101)}}\n- ID: "z"\n  Hint: __Icon\n  Value: {${G(5)}}\n`);
  const r = readPulledItems(dir);
  assert.ok(r.ids.has(G(62).replace(/-/g, '')) && r.ids.has(G(110).replace(/-/g, '')));
  const refs = [...r.templateRefs.keys()];
  assert.ok(refs.includes(G(110).replace(/-/g, '')));
  assert.ok(refs.includes(G(111).replace(/-/g, '')) && refs.includes(G(101).replace(/-/g, '')), 'block base templates');
  assert.ok(!refs.includes(G(5).replace(/-/g, '')), 'other fields are not templates');
});

test('templates missed by the scan cap are found after pull, with their base chain, before push', async () => {
  const tree = bigTree();
  const dir = tempProject();
  const project = loadProject(dir);
  const client = fakeClient(tree);
  const profile = saveProfile(dir, { name: 'Big', source: 'prod', target: 'local', selections: [HOME], dependencies: {} });
  // Tiny scan cap: discovery won't see Quick Links, like a real site with more than 500 items.
  const planned = await planSync(client, { ...profile, dependencies: { maxScanItems: 1 } }, { projectRoot: dir });
  assert.ok(!planned.plan.includes.some((i) => i.path.endsWith('Mock-Link List')), 'scan really missed it');
  const logs = [];
  await executeSync(project, profile, planned, { client, dotnet: fakeDotnetTree(tree, { localTemplates: [...SYSTEM_TEMPLATES, G(112)] }), onEvent: (e) => e.type === 'log' && logs.push(e.message) });
  const ws = path.join(dir, '.devsync', 'workspace');
  const mod = JSON.parse(fs.readFileSync(path.join(ws, 'DevSync.module.json'), 'utf8')).items.includes;
  const ml = mod.findIndex((i) => i.path.endsWith('Mock-Link List'));
  const base = mod.findIndex((i) => i.path.endsWith('_Link List Base'));
  const firstContent = mod.findIndex((i) => i.path.startsWith('/sitecore/content'));
  assert.ok(ml >= 0 && base >= 0, 'missing template and its base template added');
  assert.ok(ml < firstContent && base < firstContent, 'added templates are pushed before content');
  assert.equal(mod[ml].allowedPushOperations, 'CreateOnly');
  const calls = fs.readFileSync(path.join(ws, 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['sitecore ser pull -n prod', 'sitecore ser push -n local'], 'one push, no failure');
  assert.ok(logs.some((l) => /missing template/i.test(l)));
});

test('if the local CM still reports a missing template, DevSync pulls it and retries the push', async () => {
  const tree = bigTree();
  const dir = tempProject();
  const project = loadProject(dir);
  const client = fakeClient(tree);
  const profile = saveProfile(dir, { name: 'Odd', source: 'prod', target: 'local', selections: [HOME], dependencies: {} });
  const planned = await planSync(client, profile, { projectRoot: dir });
  // G(112) lives under /System, so it's assumed built in and skipped, but this local CM lacks it.
  await executeSync(project, profile, planned, { client, dotnet: fakeDotnetTree(tree, { localTemplates: SYSTEM_TEMPLATES }) });
  const ws = path.join(dir, '.devsync', 'workspace');
  const calls = fs.readFileSync(path.join(ws, 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['sitecore ser pull -n prod', 'sitecore ser push -n local', 'sitecore ser push -n local']);
  const mod = JSON.parse(fs.readFileSync(path.join(ws, 'DevSync.module.json'), 'utf8')).items.includes;
  assert.ok(mod.some((i) => i.path === '/sitecore/templates/System/Custom/Odd Template'));
  assert.ok(getLastSync(dir, 'Odd'));
});

test('an item whose template exists nowhere (orphan) is left out with a clear warning; the rest syncs', async () => {
  const tree = bigTree().filter((i) => i.id !== G(112)); // template deleted in the cloud
  const dir = tempProject();
  const project = loadProject(dir);
  const client = fakeClient(tree);
  const profile = saveProfile(dir, { name: 'Gone', source: 'prod', target: 'local', selections: [HOME], dependencies: {} });
  const planned = await planSync(client, profile, { projectRoot: dir });
  const r = await executeSync(project, profile, planned, { client, dotnet: fakeDotnetTree(tree, { localTemplates: SYSTEM_TEMPLATES }) });
  assert.deepEqual(r.orphans.map((o) => o.path), ['/sitecore/content/Tenant/Site/Home/About/Odd']);
  assert.ok(r.warnings.some((w) => /00000112.*doesn't exist in the cloud/.test(w)));
});
