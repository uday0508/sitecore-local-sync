'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DEVSYNC_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'dshome-'));
const { loadProject } = require('../src/core/project');
const { saveProfile } = require('../src/core/profiles');
const { planSync, executeSync } = require('../src/core/sync');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('./helpers');

const HOME = { id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' };
const SYSTEM = [{ id: G(199), path: '/sitecore/templates/System/Templates/Standard template' }, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, { id: G(196), path: '/sitecore/templates/System/Templates/Template' }];
const baseLocal = () => [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' },
  { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) },
  { id: G(140), path: '/sitecore/system/Languages', template: G(198) }, { id: G(141), path: '/sitecore/system/Languages/en', template: G(198) }];

function cloudML() {
  const t = sampleTree().map((i) => (i.id === G(3)
    ? { ...i, langs: { 'fr-FR': { updated: '20250101T000000Z', fields: { __Renderings: `<r><d><r s:ds="{${G(21)}}" /></d></r>` } } } }
    : i));
  return withFolders([...t, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' },
    { id: G(21), path: '/sitecore/content/Tenant/Site/Data/Promos/Promo B FR', template: G(102) },
    { id: G(86), path: '/sitecore/content/Tenant/Site/Home/News', template: G(100), updated: '20250101T000000Z', langs: { 'fr-FR': { updated: '20251114T120000Z', fields: { Title: 'Actualités' } } } },
    { id: G(140), path: '/sitecore/system/Languages', template: G(198) },
    { id: G(141), path: '/sitecore/system/Languages/en', template: G(198) },
    { id: G(142), path: '/sitecore/system/Languages/fr-FR', template: G(198) },
  ]).filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
}

async function setup(name, { local = baseLocal(), cloud = cloudML() } = {}) {
  const dir = tempProject();
  const sim = scsSim({ cloud, local });
  const profile = saveProfile(dir, { name, source: 'prod', target: 'local', selections: [HOME], dependencies: {} });
  const run = async ({ mode = 'full', client = fakeClient(cloud), api = sim.api } = {}) => {
    const planned = await planSync(client, profile, { mode, projectRoot: dir, localClient: api, since: mode === 'delta' ? '2025-11-13T00:00:00Z' : undefined });
    const r = await executeSync(loadProject(dir), profile, planned, { client, dotnet: sim.dotnet, localClient: api, onConflicts: async () => ({ decision: 'replace' }) });
    return { planned, r };
  };
  return { dir, sim, run, cloud };
}

test('delta: an item changed only in fr-FR is found (its English version is untouched)', async () => {
  const s = await setup('fr-only');
  const { planned, r } = await s.run({ mode: 'delta' });
  assert.ok(planned.changed.some((c) => c.path.endsWith('/Home/News') && c.languages.includes('fr-FR')));
  assert.equal(planned.changedByLanguage['fr-FR'], 1);
  assert.deepEqual(r.report.counts.changedByLanguage, planned.changedByLanguage);
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Home/News').id, G(86));
});

test('delta: if the index cannot filter by language, it falls back to one search and says so', async () => {
  const cloud = cloudML();
  cloud.failLanguageFilter = true;
  const s = await setup('nofilter', { cloud });
  const { planned, r } = await s.run({ mode: 'delta', client: fakeClient(cloud) });
  assert.ok(planned.languageNotices.length === 1);
  assert.ok(r.report.issues.some((i) => i.type === 'notice' && /filter by language/.test(i.detail)));
});

test('a datasource used only in the fr-FR layout is pulled (references are read in every language)', async () => {
  const s = await setup('fr-ref');
  const { r } = await s.run();
  assert.equal(s.sim.at('/sitecore/content/Tenant/Site/Data/Promos/Promo B FR').id, G(21));
  assert.equal(r.report.status, 'completed');
});

test('a language the local CM lacks is added (create-only) and reported', async () => {
  const s = await setup('lang-add');
  const { r } = await s.run();
  assert.equal(s.sim.at('/sitecore/system/Languages/fr-FR').id, G(142));
  assert.deepEqual(r.report.issues.filter((i) => i.type === 'language-added').map((i) => i.path), ['/sitecore/system/Languages/fr-FR']);
});

test('a local language with another ID is left alone: languages match by name, so no conflict', async () => {
  const local = [...baseLocal(), { id: '00000999-1111-1111-1111-111111111111', path: '/sitecore/system/Languages/fr-FR', template: G(198) }];
  const s = await setup('lang-exists', { local });
  const { r } = await s.run();
  assert.equal(s.sim.at('/sitecore/system/Languages/fr-FR').id, '00000999-1111-1111-1111-111111111111');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.report.issues.filter((i) => i.type.startsWith('language')).length, 0);
});

test('without the local API, non-English languages are flagged to check, not pulled', async () => {
  const s = await setup('lang-noapi');
  const { r } = await s.run({ api: null });
  assert.equal(s.sim.at('/sitecore/system/Languages/fr-FR'), undefined);
  assert.deepEqual(r.report.issues.filter((i) => i.type === 'language-check').map((i) => i.path), ['/sitecore/system/Languages/fr-FR']);
});
