'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DEVSYNC_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'dshome-'));
const fs = require('fs');
const path = require('path');
const { loadProject } = require('../src/core/project');
const { saveProfile } = require('../src/core/profiles');
const { planSync, executeSync } = require('../src/core/sync');
const { loadManifest } = require('../src/core/manifest');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('./helpers');

const HOME = { id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' };
const SYSTEM = [{ id: G(199), path: '/sitecore/templates/System/Templates/Standard template' }, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, { id: G(196), path: '/sitecore/templates/System/Templates/Template' }];
const baseLocal = () => [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' },
  { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) }];
const cloudV1 = () => withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' },
  { id: G(90 + 0), path: '/sitecore/layout/Renderings/Project/Site/Promo' },
  { id: G(84), path: '/sitecore/content/Tenant/Site/Home/Old Campaign', template: G(100) },
  { id: G(85), path: '/sitecore/content/Tenant/Site/Home/Old Campaign/Banner', template: G(103) },
  { id: G(86), path: '/sitecore/content/Tenant/Site/Home/News', template: G(100) },
]).filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
const without = (items, ...ids) => items.filter((i) => !ids.includes(i.id));

async function world(name) {
  const dir = tempProject();
  const project = loadProject(dir);
  let cloud = cloudV1();
  const sim = scsSim({ cloud, local: baseLocal() });
  const profile = saveProfile(dir, { name, source: 'prod', target: 'local', selections: [HOME], dependencies: {} });
  const sync = async ({ mode = 'full', client, dryRun = false, api = sim.api } = {}) => {
    const c = client || fakeClient(cloud);
    const planned = await planSync(c, profile, { mode, projectRoot: dir, localClient: api, since: mode === 'delta' ? '2025-06-01T00:00:00Z' : undefined });
    return executeSync(project, profile, planned, { client: c, dotnet: sim.dotnet, localClient: api, skipPush: dryRun, onConflicts: async () => ({ decision: 'replace' }) });
  };
  const setCloud = (items) => { cloud = items; sim.setCloud(items); };
  return { dir, sim, sync, setCloud, cloud: () => cloud };
}

test('first sync writes a manifest of IDs in the selected trees and removes nothing', async () => {
  const w = await world('first');
  const r = await w.sync();
  const m = loadManifest(w.dir, 'first');
  assert.ok(m.items[G(84).replace(/-/g, '')] && m.items[G(85).replace(/-/g, '')]);
  assert.ok(!Object.values(m.items).some((p) => !p.startsWith('/sitecore/content/Tenant/Site/Home')), 'only selected trees, no dependencies');
  assert.equal(r.report.counts.deletedInCloud, 0);
});

test('full sync: an item deleted in the cloud is moved to the local Recycle Bin (top item only) and reported', async () => {
  const w = await world('full');
  await w.sync();
  assert.ok(w.sim.at('/sitecore/content/Tenant/Site/Home/Old Campaign/Banner'));
  w.setCloud(without(w.cloud(), G(84), G(85)));
  const r = await w.sync();
  assert.equal(w.sim.at('/sitecore/content/Tenant/Site/Home/Old Campaign'), undefined);
  assert.equal(w.sim.at('/sitecore/content/Tenant/Site/Home/Old Campaign/Banner'), undefined);
  assert.equal(w.sim.at('/sitecore/content/Tenant/Site/Home/News').id, G(86), 'others untouched');
  assert.deepEqual(w.sim.api.calls, [['delete', G(84).replace(/-/g, '')]], 'one delete, for the top item');
  const del = r.report.issues.filter((i) => i.type === 'deleted-in-cloud');
  assert.deepEqual(del.map((d) => [d.path, d.items]), [['/sitecore/content/Tenant/Site/Home/Old Campaign', 2]]);
  assert.ok(!loadManifest(w.dir, 'full').items[G(84).replace(/-/g, '')], 'manifest updated');
});

test('delta sync: deletions found through the index, verified, applied; moved items follow their new path', async () => {
  const w = await world('delta');
  await w.sync();
  const moved = w.cloud().map((i) => (i.id === G(86) ? { ...i, path: '/sitecore/content/Tenant/Site/Home/About/News' } : i));
  w.setCloud(without(moved, G(84), G(85)));
  const r = await w.sync({ mode: 'delta' });
  assert.equal(w.sim.at('/sitecore/content/Tenant/Site/Home/Old Campaign'), undefined);
  assert.equal(w.sim.at('/sitecore/content/Tenant/Site/Home/About/News').id, G(86), 'moved locally to the new path');
  assert.equal(w.sim.at('/sitecore/content/Tenant/Site/Home/News'), undefined);
  assert.equal(r.report.counts.deletedInCloud, 1);
  const m = loadManifest(w.dir, 'delta').items;
  assert.equal(m[G(86).replace(/-/g, '')], '/sitecore/content/Tenant/Site/Home/About/News');
  assert.ok(!m[G(84).replace(/-/g, '')]);
});

test('a stale index never causes a deletion: missing from the index but found by ID = kept', async () => {
  const w = await world('stale');
  await w.sync();
  const c = fakeClient(w.cloud());
  const realSearch = c.searchUpdatedUnder;
  c.searchUpdatedUnder = (id, onPage, o) => realSearch(id, (page) => onPage(page.filter((p) => p.id !== G(84).replace(/-/g, ''))), o);
  const r = await w.sync({ mode: 'delta', client: c });
  assert.ok(w.sim.at('/sitecore/content/Tenant/Site/Home/Old Campaign'), 'still there');
  assert.equal(r.report.counts.deletedInCloud, 0);
  assert.equal(w.sim.api.calls.length, 0);
});

test('dry run lists cloud deletions and changes nothing (manifest untouched too)', async () => {
  const w = await world('dry');
  await w.sync();
  const before = JSON.stringify(loadManifest(w.dir, 'dry'));
  w.setCloud(without(w.cloud(), G(84), G(85)));
  const r = await w.sync({ dryRun: true });
  assert.ok(w.sim.at('/sitecore/content/Tenant/Site/Home/Old Campaign'));
  assert.deepEqual(r.report.issues.filter((i) => i.type === 'deleted-in-cloud-pending').map((i) => i.path), ['/sitecore/content/Tenant/Site/Home/Old Campaign']);
  assert.equal(JSON.stringify(loadManifest(w.dir, 'dry')), before);
});

test('without the local API nothing is removed; the report says what to delete', async () => {
  const w = await world('noapi');
  await w.sync();
  w.setCloud(without(w.cloud(), G(84), G(85)));
  const r = await w.sync({ api: null });
  assert.ok(w.sim.at('/sitecore/content/Tenant/Site/Home/Old Campaign'));
  const i = r.report.issues.find((x) => x.type === 'deleted-in-cloud-manual');
  assert.match(i.fix, new RegExp(`Delete item ${G(84).replace(/-/g, '')}`));
});

test('items outside the current selection are never removed, even if they left the cloud', async () => {
  const w = await world('narrowed');
  await w.sync();
  // Selection narrowed to About only; Old Campaign is now outside the selection.
  const dir = w.dir;
  const profile = saveProfile(dir, { name: 'narrowed', source: 'prod', target: 'local', selections: [{ id: G(6), path: '/sitecore/content/Tenant/Site/Home/About', scope: 'ItemAndDescendants' }], dependencies: {} });
  w.setCloud(without(w.cloud(), G(84), G(85)));
  const c = fakeClient(w.cloud());
  const planned = await planSync(c, profile, { projectRoot: dir, localClient: w.sim.api });
  const r = await executeSync(loadProject(dir), profile, planned, { client: c, dotnet: w.sim.dotnet, localClient: w.sim.api });
  assert.ok(w.sim.at('/sitecore/content/Tenant/Site/Home/Old Campaign'));
  assert.equal(r.report.counts.deletedInCloud, 0);
});

test('an item already deleted locally is skipped quietly', async () => {
  const w = await world('gone');
  await w.sync();
  await w.sim.api.deleteItem(G(84));
  w.sim.api.calls.length = 0;
  w.setCloud(without(w.cloud(), G(84), G(85)));
  const r = await w.sync();
  assert.equal(w.sim.api.calls.length, 0);
  assert.equal(r.report.issues.filter((i) => i.type.startsWith('deleted-in-cloud')).length, 0);
});
