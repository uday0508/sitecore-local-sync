'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadProject } = require('../src/core/project');
const { saveProfile, getLastSync } = require('../src/core/profiles');
const { planSync, executeSync } = require('../src/core/sync');
const { findConflicts, readTree, batchParents, collisionsFromOutput } = require('../src/core/conflicts');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('./helpers');

const HOME = { id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' };
const L = (n) => `${String(n).padStart(8, '0')}-1111-1111-1111-111111111111`; // local-only IDs
const SYSTEM = [{ id: G(199), path: '/sitecore/templates/System/Templates/Standard template' }, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, { id: G(196), path: '/sitecore/templates/System/Templates/Template' }];
// The local CM has the template + content roots that every SitecoreAI CM has.
const LOCAL_TEMPLATES = [
  { id: G(100), path: '/sitecore/templates/Project/Site/Page' },
  { id: G(101), path: '/sitecore/templates/Project/Site/_Base Page' },
  { id: G(103), path: '/sitecore/templates/Project/Site/Folder' },
];
const baseLocal = () => [...SYSTEM,
  { id: G(104), path: '/sitecore/templates/Foundation/Tenant' },
  { id: G(1), path: '/sitecore/content/Tenant', template: G(104) },
  { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) },
];
const tree = () => withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }]);

async function setup(name, { local, onConflict, profileExtra = {}, cloud = tree() } = {}) {
  const dir = tempProject();
  const project = loadProject(dir);
  const sim = scsSim({ cloud, local: local || baseLocal() });
  const client = fakeClient(cloud);
  const profile = saveProfile(dir, { name, source: 'prod', target: 'local', selections: [HOME], dependencies: {}, onConflict, ...profileExtra });
  const planned = await planSync(client, profile, { projectRoot: dir });
  const events = [];
  const go = (opts = {}) => executeSync(project, profile, planned, { client, dotnet: sim.dotnet, onEvent: (e) => events.push(e), ...opts });
  return { dir, project, sim, client, profile, planned, events, go };
}

test('clean local CM: everything syncs, no conflicts, 3 CLI runs in total', async () => {
  const s = await setup('clean');
  const r = await s.go();
  assert.equal(r.conflicts.length, 0);
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home').id, G(3));
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data/Text 1').id, G(5));
  assert.ok(s.sim.at('/sitecore/templates/Project/Site/Page'), 'templates created');
  assert.ok(s.sim.at('/sitecore/media library/Project/Site/hero'), 'media created with parent folders');
  assert.ok(getLastSync(s.dir, 'clean'));
});

test('your case: local Home/Data has a different ID -> replace backs up, deletes local, pushes cloud', async () => {
  const local = [...baseLocal(), ...LOCAL_TEMPLATES,
    { id: G(3), path: '/sitecore/content/Tenant/Site/Home', template: G(100) },
    { id: L(1), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(103) },
    { id: L(2), path: '/sitecore/content/Tenant/Site/Home/Data/Local Only', template: G(103) },
    { id: L(3), path: '/sitecore/content/Tenant/Site/Home/Sibling', template: G(103) },
  ];
  const s = await setup('replace', { local, onConflict: 'ask' });
  let asked = null;
  const r = await s.go({ onConflicts: async (c) => { asked = c; return { decision: 'replace' }; } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].path, '/sitecore/content/Tenant/Site/Home/Data');
  assert.equal(asked[0].localItems, 2);
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data').id, G(4), 'cloud Data now local');
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data/Text 1').id, G(5));
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data/Local Only'), undefined, 'conflicting subtree replaced');
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Sibling').id, L(3), 'unrelated local sibling untouched');
  const backups = fs.readdirSync(path.join(s.dir, '.devsync', 'backups'));
  const files = fs.readdirSync(path.join(s.dir, '.devsync', 'backups', backups[0], 'items'));
  assert.equal(files.length, 2, 'local Data + its child backed up');
  assert.equal(r.decision, 'replace');
});

test('skip keeps the local item and its subtree, pushes everything else', async () => {
  const local = [...baseLocal(), ...LOCAL_TEMPLATES,
    { id: G(3), path: '/sitecore/content/Tenant/Site/Home', template: G(100) },
    { id: L(1), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(103) },
  ];
  const s = await setup('skip', { local, onConflict: 'skip' });
  const r = await s.go();
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data').id, L(1), 'local kept');
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data/Text 1'), undefined, 'cloud subtree not pushed');
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/About').id, G(6), 'rest pushed');
  assert.ok(r.warnings.some((w) => /Skipped 1 conflicting/.test(w)));
});

test('the whole local site was created separately: conflict is reported at the top only', async () => {
  const local = [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' },
    { id: G(1), path: '/sitecore/content/Tenant', template: G(104) },
    { id: L(10), path: '/sitecore/content/Tenant/Site', template: G(104) },
    { id: L(11), path: '/sitecore/content/Tenant/Site/Home', template: G(104) },
    { id: L(12), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(104) },
  ];
  const s = await setup('site', { local });
  let asked;
  await s.go({ onConflicts: async (c) => { asked = c; return { decision: 'replace' }; } });
  assert.deepEqual(asked.map((c) => c.path), ['/sitecore/content/Tenant/Site']);
  assert.equal(asked[0].localItems, 3);
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site').id, G(2));
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home').id, G(3));
  assert.equal(s.sim.at('/sitecore/content/Tenant').id, G(1), 'tenant untouched');
});

test('cancel changes nothing locally', async () => {
  const local = [...baseLocal(), { id: L(1), path: '/sitecore/content/Tenant/Site/Home', template: G(100) }];
  const s = await setup('cancel', { local });
  const before = JSON.stringify(s.sim.local());
  await assert.rejects(s.go({ onConflicts: async () => ({ decision: 'cancel' }) }), /Cancelled\. Nothing was pushed/);
  assert.equal(JSON.stringify(s.sim.local()), before);
  assert.equal(getLastSync(s.dir, 'cancel'), null);
});

test('without a way to ask (headless), conflicts stop the run and list the paths', async () => {
  const local = [...baseLocal(), { id: L(1), path: '/sitecore/content/Tenant/Site/Home', template: G(100) }];
  const s = await setup('headless', { local });
  await assert.rejects(s.go(), /same path as cloud items but different IDs:\n {2}\/sitecore\/content\/Tenant\/Site\/Home/);
});

test('dry run reports conflicts and changes nothing', async () => {
  const local = [...baseLocal(), { id: L(1), path: '/sitecore/content/Tenant/Site/Home', template: G(100) }];
  const s = await setup('dry', { local });
  const before = JSON.stringify(s.sim.local());
  const r = await s.go({ skipPush: true });
  assert.equal(r.conflicts.length, 1);
  assert.equal(JSON.stringify(s.sim.local()), before);
});

test('conflicts missed by the pre-check are resolved at push time, then the push is retried', async () => {
  const local = [...baseLocal(), ...LOCAL_TEMPLATES, { id: G(3), path: '/sitecore/content/Tenant/Site/Home', template: G(100) }, { id: L(1), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(103) }];
  const s = await setup('late', { local, onConflict: 'replace' });
  const r = await s.go({ skipPreflight: true });
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data').id, G(4));
  assert.equal(r.conflicts.length, 1);
});

test('template conflicts (repo template with another ID) are detected like content', async () => {
  const local = [...baseLocal(), { id: L(5), path: '/sitecore/templates/Project/Site/Page' }];
  const s = await setup('tpl', { local, onConflict: 'replace' });
  const r = await s.go();
  assert.ok(r.conflicts.some((c) => c.kind === 'template' && c.path.endsWith('/Page')));
  assert.equal(s.sim.at('/sitecore/templates/Project/Site/Page').id, G(100));
});

test('duplicate names in the cloud: that path is skipped with a warning, the rest syncs', async () => {
  const cloud = [...tree(), { id: G(70), path: '/sitecore/content/Tenant/Site/Home/About', template: G(100) }];
  const s = await setup('dupe', { cloud });
  const r = await s.go();
  assert.ok(r.warnings.some((w) => /two items at \/sitecore\/content\/Tenant\/Site\/Home\/About/.test(w)));
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/About'), undefined);
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home').id, G(3));
  const mod = JSON.parse(fs.readFileSync(path.join(s.dir, '.devsync', 'workspace', 'DevSync.module.json'), 'utf8'));
  assert.ok(mod.items.includes.some((i) => (i.rules || []).some((r) => r.path === '/About' && r.scope === 'Ignored')));
});

test('local CM down: a clear message before anything is pushed', async () => {
  const dir = tempProject();
  const project = loadProject(dir);
  const sim = scsSim({ cloud: tree(), localDown: true });
  const client = fakeClient(tree());
  const profile = saveProfile(dir, { name: 'down', source: 'prod', target: 'local', selections: [HOME], dependencies: {} });
  const planned = await planSync(client, profile, { projectRoot: dir });
  await assert.rejects(executeSync(project, profile, planned, { client, dotnet: sim.dotnet }), /local CM is not reachable.*up\.ps1/);
});

test('rotating refresh tokens survive many CLI runs across workspaces', async () => {
  const local = [...baseLocal(), ...LOCAL_TEMPLATES, { id: G(3), path: '/sitecore/content/Tenant/Site/Home', template: G(100) }, { id: L(1), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(103) }];
  const s = await setup('tokens', { local, onConflict: 'replace' });
  await s.go();
  const projectToken = JSON.parse(fs.readFileSync(path.join(s.dir, '.sitecore', 'user.json'), 'utf8')).endpoints.xmCloud.refreshToken;
  // The last workspace that ran must have the same token as the project (nothing stale left behind).
  const ws = JSON.parse(fs.readFileSync(path.join(s.dir, '.devsync', 'workspace', '.sitecore', 'user.json'), 'utf8')).endpoints.xmCloud.refreshToken;
  assert.equal(projectToken, ws);
  assert.notEqual(projectToken, 'r1');
  // The user's endpoint flags are never changed.
  const user = JSON.parse(fs.readFileSync(path.join(s.dir, '.sitecore', 'user.json'), 'utf8'));
  assert.equal(user.endpoints.prod.allowWrite, undefined);
});

test('helpers: topmost conflicts, parent batching, collision parsing', () => {
  const cloud = { byPath: new Map([['/a/b', { id: 'c1', path: '/a/b' }], ['/a/b/c', { id: 'c2', path: '/a/b/c' }], ['/a/d', { id: 'c3', path: '/a/d' }]]) };
  const local = { byPath: new Map([['/a/b', { id: 'l1', path: '/a/b' }], ['/a/b/c', { id: 'l2', path: '/a/b/c' }], ['/a/d', { id: 'c3', path: '/a/d' }]]) };
  assert.deepEqual(findConflicts(cloud, local).map((c) => c.path), ['/a/b']);
  const b = batchParents(['/x/a', '/x/a/b', '/x/c', '/x/a/b/c/d']);
  for (const batch of b) for (const p of batch) for (const q of batch) if (p !== q) assert.ok(!(q.startsWith(p + '/') && q.split('/').length - p.split('/').length === 1), `${p} and ${q} overlap`);
  const cols = collisionsFromOutput(['/sitecore/content/BizTech/starterkit/Home/Data (4051b852-676b-4ac4-8da0-2acc2f807a07) attempted to be cached, but the cache already contained /sitecore/content/BizTech/starterkit/Home/Data with different ID 1d6b613e-ab20-4e35-93ba-36035851233c. Non-unique paths cannot be serialized.']);
  assert.deepEqual(cols, [{ path: '/sitecore/content/BizTech/starterkit/Home/Data', ids: ['4051b852676b4ac48da02acc2f807a07', '1d6b613eab204e3593ba36035851233c'] }]);
});

// ---- Local Authoring API path: delete by ID, works with duplicate names ----
const { AuthoringClient } = require('../src/core/graphql');

function dupLocal(cloudFirst) {
  const data = [
    { id: L(1), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(103), parent: G(3) },        // local original
    { id: G(4), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(103), parent: G(3) },        // cloud ID, left by an earlier run
  ];
  return [...baseLocal(), ...LOCAL_TEMPLATES,
    { id: G(3), path: '/sitecore/content/Tenant/Site/Home', template: G(100), parent: G(2) },
    ...(cloudFirst ? data.reverse() : data),
    { id: L(2), path: '/sitecore/content/Tenant/Site/Home/Data/Text 9', template: G(103), parent: L(1) },
    { id: G(5), path: '/sitecore/content/Tenant/Site/Home/Data/Text 1', template: G(103), parent: G(4) },
  ];
}

for (const cloudFirst of [false, true]) {
  test(`your exact case: two local "Data" items (local + cloud ID), ${cloudFirst ? 'cloud one listed first' : 'local one listed first'} -> local one removed by ID, sync completes`, async () => {
    const s = await setup(`dup-${cloudFirst}`, { local: dupLocal(cloudFirst) });
    let asked = 0;
    const r = await s.go({ localClient: s.sim.api, onConflicts: async () => { asked++; return { decision: 'replace' }; } });
    const datas = s.sim.local().filter((i) => i.path === '/sitecore/content/Tenant/Site/Home/Data');
    assert.deepEqual(datas.map((d) => d.id), [G(4)], 'only the cloud Data remains');
    assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data/Text 9'), undefined, 'local-only child went with it');
    assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data/Text 1').id, G(5));
    assert.deepEqual(s.sim.api.calls, [['delete', L(1).replace(/-/g, '')]], 'exactly one delete, by the local ID');
    assert.equal(asked, 1, 'asked once');
    assert.equal(r.decision, 'replace');
    assert.ok(getLastSync(s.dir, `dup-${cloudFirst}`));
  });
}

test('several conflicts surfacing one by one at push time are all handled with a single question', async () => {
  const local = [...baseLocal(), ...LOCAL_TEMPLATES,
    { id: G(3), path: '/sitecore/content/Tenant/Site/Home', template: G(100), parent: G(2) },
    { id: L(1), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(103), parent: G(3) },
    { id: L(3), path: '/sitecore/content/Tenant/Site/Home/About', template: G(100), parent: G(3) },
    { id: L(4), path: '/sitecore/content/Tenant/Site/Home/Contact', template: G(100), parent: G(3) },
  ];
  const cloud = [...tree(), { id: G(71), path: '/sitecore/content/Tenant/Site/Home/Contact', template: G(100) }];
  const s = await setup('many', { local, cloud });
  let asked = 0;
  await s.go({ localClient: s.sim.api, skipPreflight: true, onConflicts: async () => { asked++; return { decision: 'replace' }; } });
  assert.equal(asked, 1);
  assert.equal(s.sim.api.calls.length, 3);
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Contact').id, G(71));
});

test('without the local API, duplicates give a precise manual instruction instead of a loop', async () => {
  const s = await setup('noapi', { local: dupLocal(false), onConflict: 'replace' });
  await assert.rejects(s.go(), /duplicate item names at: \/sitecore\/content\/Tenant\/Site\/Home\/Data \(local ID 00000001111111111111111111111111\)\. Delete the local item/);
});

test('if the local API is unreachable, DevSync warns and falls back to serialization checks', async () => {
  const local = [...baseLocal(), ...LOCAL_TEMPLATES, { id: G(3), path: '/sitecore/content/Tenant/Site/Home', template: G(100) }, { id: L(1), path: '/sitecore/content/Tenant/Site/Home/Data', template: G(103) }];
  const s = await setup('apidown', { local, onConflict: 'replace' });
  const broken = { resolvePaths: async () => { throw new Error('certificate not trusted'); }, deleteItem: async () => { throw new Error('nope'); } };
  const r = await s.go({ localClient: broken });
  assert.ok(r.warnings.some((w) => /Could not use the local CM's Authoring API \(certificate not trusted\)/.test(w)));
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data').id, G(4));
});

test('write access is impossible against a cloud host; the cloud client blocks mutations', async () => {
  assert.throws(() => new AuthoringClient({ host: 'https://xmc-acme-prod.sitecorecloud.io', tokenProvider: {}, allowWrite: true }), /non-local/);
  const cloud = new AuthoringClient({ host: 'https://xmc-acme-prod.sitecorecloud.io', tokenProvider: { getToken: async () => 't' }, fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(cloud.deleteItem('x'), /only available on the local CM/);
  const local = new AuthoringClient({ host: 'https://xmcloudcm.localhost', tokenProvider: { getToken: async () => 't' }, allowWrite: true,
    fetchImpl: async (_u, init) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { deleteItem: { successful: /permanently: false/.test(JSON.parse(init.body).query) } } }) }) });
  assert.equal(await local.deleteItem('00000001-1111-1111-1111-111111111111'), true, 'goes to the Recycle Bin (permanently: false)');
});

// ---- Templates: null ID, batch rejection, templates outside /sitecore/templates, strict order ----
const { readPulledItems } = require('../src/core/closure');
const os = require('os');

test('the null ID in __Base template is never treated as a missing template', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullid-'));
  fs.writeFileSync(path.join(dir, 'a.yml'), `---\nID: "${G(110)}"\nTemplate: "${G(198)}"\nPath: /sitecore/templates/Foundation/JSS Experience Accelerator/Multisite/Base/Sites/_Description\nSharedFields:\n- ID: "12c33f3f-86c5-43a5-aeb4-5598cec45116"\n  Hint: __Base template\n  Value: "{00000000-0000-0000-0000-000000000000}"\n`);
  assert.ok(![...readPulledItems(dir).templateRefs.keys()].includes('00000000000000000000000000000000'));
});

test('one bad ID no longer poisons a batch: the rest are resolved one by one', async () => {
  const real = G(110).replace(/-/g, '');
  const fetchImpl = async (_u, init) => {
    const q = JSON.parse(init.body).query;
    if (/i0:.*i1:/s.test(q)) return { ok: true, status: 200, text: async () => JSON.stringify({ data: null, errors: [{ message: 'Item {DEADBEEF…} not found' }] }) };
    if (q.includes(G(110).toUpperCase())) return { ok: true, status: 200, text: async () => JSON.stringify({ data: { x: { itemId: real, name: 'Mock-Link List', path: '/sitecore/system/Generated/Mock-Link List', template: { name: 'Template', templateId: 'ab86861a6030464686a3b1d3e7b47f1e' } } } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { x: null, search: { results: [] } } }) };
  };
  const c = new AuthoringClient({ host: 'https://xmc.sitecorecloud.io', tokenProvider: { getToken: async () => 't' }, fetchImpl });
  const m = await c.resolveIds([G(110), 'deadbeef-0000-0000-0000-000000000000']);
  assert.equal(m.get(real).path, '/sitecore/system/Generated/Mock-Link List');
  assert.equal(m.get('deadbeef000000000000000000000000'), null);
});

test('a template living outside /sitecore/templates is pulled and pushed before the content that uses it', async () => {
  const cloud = withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' },
    { id: G(120), path: '/sitecore/system/Generated/Components/Mock-Link List', fields: { '__Base template': `{${G(101)}}|{00000000-0000-0000-0000-000000000000}` } },
    { id: G(65), path: '/sitecore/content/Tenant/Site/Home/Quick Links', template: G(120) },
  ]);
  const local = [...baseLocal(), { id: G(197), path: '/sitecore/system', template: G(198) }];
  const s = await setup('outside', { cloud, local });
  await s.go({ localClient: s.sim.api });
  assert.equal(s.sim.at('/sitecore/system/Generated/Components/Mock-Link List').id, G(120));
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Quick Links').id, G(65));
  const mod = JSON.parse(fs.readFileSync(path.join(s.dir, '.devsync', 'workspace', 'DevSync.module.json'), 'utf8')).items.includes;
  const tpl = mod.findIndex((i) => i.path.endsWith('/Mock-Link List'));
  const firstContent = mod.findIndex((i) => i.path.startsWith('/sitecore/content'));
  assert.ok(tpl >= 0 && tpl < firstContent, 'template include ordered before content');
  assert.equal(mod[tpl].scope, 'ItemAndDescendants');
  assert.equal(mod[tpl].allowedPushOperations, 'CreateOnly');
});

test('even when the scan misses it, a template outside /sitecore/templates is found after pull and ordered first', async () => {
  const cloud = withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' },
    { id: G(120), path: '/sitecore/system/Generated/Components/Mock-Link List', fields: {} },
    { id: G(66), path: '/sitecore/content/Tenant/Site/Home/About/Deep/Quick Links', template: G(120) },
  ]);
  const local = [...baseLocal(), { id: G(197), path: '/sitecore/system', template: G(198) }];
  const s = await setup('outside2', { cloud, local, profileExtra: { dependencies: { maxScanItems: 1 } } });
  await s.go({ localClient: s.sim.api });
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/About/Deep/Quick Links').id, G(66));
  const calls = fs.readFileSync(path.join(s.dir, '.devsync', 'workspace', 'calls.log'), 'utf8').trim().split('\n');
  assert.equal(calls.filter((c) => c.includes('push')).length, 1, 'no failed push: ordering was right the first time');
});

// ---- Sitecore defaults (same ID in both images) are never pulled ----
function withDefaults() {
  const jssBase = { id: G(130), path: '/sitecore/templates/Foundation/JSS Experience Accelerator/Multisite/Base/Sites/_Description', fields: { '__Base template': '{00000000-0000-0000-0000-000000000000}' } };
  const t = sampleTree().map((i) => (i.id === G(101) ? { ...i, fields: { '__Base template': `{${G(199)}}|{${G(130)}}` } } : i));
  const cloud = withFolders([...t, jssBase, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }]);
  // The local image ships the same Sitecore items with the same IDs: System + Foundation trees.
  const shipped = cloud.filter((i) => /^\/sitecore\/templates\/(System|Foundation)(\/|$)/.test(i.path));
  return { cloud, shipped };
}

test('Sitecore default templates and folders already in the local image are not pulled or pushed', async () => {
  const { cloud, shipped } = withDefaults();
  const local = [...shipped, { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) }];
  const s = await setup('defaults', { cloud, local });
  const planned = await planSync(s.client, s.profile, { projectRoot: s.dir, localClient: s.sim.api });
  const paths = planned.plan.includes.map((i) => i.path);
  assert.ok(!paths.some((p) => /\/Foundation(\/|$)/.test(p)), `no Foundation items in plan: ${paths.filter((p) => /Foundation/.test(p))}`);
  assert.ok(!paths.includes('/sitecore/content/Tenant') && !paths.includes('/sitecore/content/Tenant/Site'), 'existing parent folders skipped');
  assert.ok(paths.includes('/sitecore/templates/Project/Site/Page'), 'project templates still pulled');
  assert.ok(planned.alreadyLocal >= 4);
  await executeSync(s.project, s.profile, planned, { client: s.client, dotnet: s.sim.dotnet, localClient: s.sim.api });
  const mod = JSON.parse(fs.readFileSync(path.join(s.dir, '.devsync', 'workspace', 'DevSync.module.json'), 'utf8')).items.includes;
  assert.ok(!mod.some((i) => /JSS Experience Accelerator/.test(i.path)), 'the _Description base chain was not pulled after the fact either');
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home').id, G(3));
  const calls = fs.readFileSync(path.join(s.dir, '.devsync', 'workspace', 'calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['sitecore ser pull -n prod', 'sitecore ser push -n local']);
});

test('without the local API, known Sitecore product folders are still skipped', async () => {
  const { cloud, shipped } = withDefaults();
  const s = await setup('defaults-noapi', { cloud, local: [...shipped, ...baseLocal()] });
  const planned = await planSync(s.client, s.profile, { projectRoot: s.dir });
  assert.ok(!planned.plan.includes.some((i) => /JSS Experience Accelerator/.test(i.path)));
  await executeSync(s.project, s.profile, planned, { client: s.client, dotnet: s.sim.dotnet });
  const mod = JSON.parse(fs.readFileSync(path.join(s.dir, '.devsync', 'workspace', 'DevSync.module.json'), 'utf8')).items.includes;
  assert.ok(!mod.some((i) => /JSS Experience Accelerator/.test(i.path)));
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home').id, G(3));
});

test('a local folder at the same path but with another ID is NOT skipped (it goes to the conflict check)', async () => {
  const { cloud, shipped } = withDefaults();
  const local = [...shipped, { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: L(9), path: '/sitecore/content/Tenant/Site', template: G(104) }];
  const s = await setup('diff-id', { cloud, local });
  const planned = await planSync(s.client, s.profile, { projectRoot: s.dir, localClient: s.sim.api });
  assert.ok(planned.plan.includes.some((i) => i.path === '/sitecore/content/Tenant/Site'));
  const r = await executeSync(s.project, s.profile, planned, { client: s.client, dotnet: s.sim.dotnet, localClient: s.sim.api, onConflicts: async () => ({ decision: 'replace' }) });
  assert.deepEqual(r.conflicts.map((c) => c.path), ['/sitecore/content/Tenant/Site']);
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site').id, G(2));
});

// ---- Orphans: items whose template was deleted in the cloud ----
function orphanCloud() {
  return withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' },
    { id: G(80), path: '/sitecore/content/Tenant/Site/Home/Products', template: G(100) },
    { id: G(81), path: '/sitecore/content/Tenant/Site/Home/Products/Data', template: G(103) },
    { id: G(82), path: '/sitecore/content/Tenant/Site/Home/Products/Data/Quick Links', template: 'af8c3de5-068c-4bc4-b178-90e29168da29' },
    { id: G(83), path: '/sitecore/content/Tenant/Site/Home/Products/Data/Quick Links/AboutUs', template: '2861b653-214e-412f-b017-d5e7bf1271f8' },
  ]); // neither template exists anywhere
}

for (const withApi of [true, false]) {
  test(`your case: "Quick Links" uses a template deleted in the cloud -> skipped with a warning, everything else syncs (${withApi ? 'local API' : 'no local API'})`, async () => {
    const s = await setup(`orphan-${withApi}`, { cloud: orphanCloud() });
    const r = await s.go(withApi ? { localClient: s.sim.api } : {});
    assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Products/Data/Quick Links'), undefined);
    assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Products/Data/Quick Links/AboutUs'), undefined);
    assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Products/Data').id, G(81), 'its parent still synced');
    assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/Data/Text 1').id, G(5), 'the rest synced');
    assert.deepEqual(r.orphans.map((o) => o.path), ['/sitecore/content/Tenant/Site/Home/Products/Data/Quick Links']);
    assert.ok(r.warnings.some((w) => /Quick Links.*af8c3de5068c4bc4b17890e29168da29.*orphaned/.test(w)));
    const pushes = fs.readFileSync(path.join(s.dir, '.devsync', 'workspace', 'calls.log'), 'utf8').split('\n').filter((l) => l.includes('push')).length;
    assert.equal(pushes, withApi ? 1 : 2, withApi ? 'left out before the push' : 'found by the push, left out, retried');
    assert.ok(getLastSync(s.dir, `orphan-${withApi}`));
  });
}
