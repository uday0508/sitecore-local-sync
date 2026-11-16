'use strict';

// "Include media" off: media referenced by pages is not planned, not pulled after the pull,
// and the report says how many were left out. Explicitly selected media is still synced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshome-media-'));
const { loadProject } = require('../src/core/project');
const { saveProfile } = require('../src/core/profiles');
const { planSync, executeSync } = require('../src/core/sync');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('./helpers');

const SYSTEM = [{ id: G(199), path: '/sitecore/templates/System/Templates/Standard template' }, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, { id: G(196), path: '/sitecore/templates/System/Templates/Template' }];
const cloud = () => withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }]).filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
const local = () => [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' }, { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) }];

async function run(dependencies, selections = [{ id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' }]) {
  const dir = tempProject();
  const items = cloud();
  const sim = scsSim({ cloud: items, local: local() });
  const profile = saveProfile(dir, { name: 'm', source: 'prod', target: 'local', selections, dependencies });
  const client = fakeClient(items);
  const planned = await planSync(client, profile, { projectRoot: dir, localClient: sim.api });
  const r = await executeSync(loadProject(dir), profile, planned, { client, dotnet: sim.dotnet, localClient: sim.api });
  return { planned, r, sim };
}

test('media on (default): referenced media is pulled', async () => {
  const { planned, sim } = await run({});
  assert.ok(planned.plan.includes.some((i) => i.kind === 'media'));
  assert.ok(sim.at('/sitecore/media library/Project/Site/hero'));
});

test('media off: not planned, not pulled, and reported', async () => {
  const { planned, r, sim } = await run({ media: false });
  assert.ok(!planned.plan.includes.some((i) => /^\/sitecore\/media library\//i.test(i.path)), 'no media includes');
  assert.ok(!sim.at('/sitecore/media library/Project/Site/hero'), 'media not pushed');
  assert.ok(sim.at('/sitecore/content/Tenant/Site/Home'), 'pages still synced');
  assert.ok(sim.at('/sitecore/content/Tenant/Site/Data/Promos/Promo A'), 'datasources still synced');
  const note = r.report.issues.find((i) => i.type === 'media-skipped');
  assert.ok(note, 'report says media was left out');
  assert.match(note.detail, /1 media item/);
});

test('media off still syncs media you select yourself', async () => {
  const { sim } = await run({ media: false }, [{ id: G(30), path: '/sitecore/media library/Project/Site/hero', scope: 'SingleItem' }]);
  assert.ok(sim.at('/sitecore/media library/Project/Site/hero'));
});
