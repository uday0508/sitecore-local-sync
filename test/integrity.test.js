'use strict';

// "Filesystem integrity validation found errors in serialized files": DevSync runs
// "ser validate --fix" and pushes again; files SCS still rejects are left out and reported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshome-integrity-'));
const { loadProject } = require('../src/core/project');
const { saveProfile } = require('../src/core/profiles');
const { planSync, executeSync } = require('../src/core/sync');
const { keyErrorLines } = require('../src/core/cliErrors');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('./helpers');

const SYSTEM = [{ id: G(199), path: '/sitecore/templates/System/Templates/Standard template' }, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, { id: G(196), path: '/sitecore/templates/System/Templates/Template' }];
const local = () => [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' }, { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) }];
const ABOUT = '/sitecore/content/Tenant/Site/Home/About';

async function run(simOpts) {
  const dir = tempProject();
  const items = withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }]).filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
  const sim = scsSim({ cloud: items, local: local(), ...simOpts });
  const profile = saveProfile(dir, { name: 'i', source: 'prod', target: 'local', selections: [{ id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' }] });
  const client = fakeClient(items);
  const planned = await planSync(client, profile, { projectRoot: dir, localClient: sim.api });
  const r = await executeSync(loadProject(dir), profile, planned, { client, dotnet: sim.dotnet, localClient: sim.api });
  return { r, sim };
}

test('the report gets the real error line, not just the exit code', () => {
  const lines = [
    "4:10:42 PM[master] [Batch 1] [[U] /sitecore/content/Home] UpdateFieldItemCommand Field __Updated by received a set value command, but its value was already equal to the value to set. This indicates sending extraneous commands.",
    '4:33:05 PMFilesystem integrity validation found errors in serialized files! Use the validate command to fix these.',
    '4:33:05 PM"sitecore ser push" exited with code 1',
  ];
  assert.deepEqual(keyErrorLines(lines), ['Filesystem integrity validation found errors in serialized files! Use the validate command to fix these.']);
});

test('validate --fix repairs the files and the push is retried', async () => {
  const { r, sim } = await run({ badFiles: [ABOUT], fixable: true });
  assert.ok(sim.at(ABOUT), 'item synced after the fix');
  assert.ok(r.report.issues.some((i) => i.type === 'notice' && /validate --fix/.test(i.detail)));
  assert.ok(!r.report.issues.some((i) => i.type === 'error'));
});

test('files SCS still rejects are left out and reported; the rest is synced', async () => {
  for (const listOnPush of [true, false]) {
    const { r, sim } = await run({ badFiles: [ABOUT], fixable: false, listOnPush });
    const bad = r.report.issues.find((i) => i.type === 'invalid-file');
    assert.ok(bad, `reported (listOnPush=${listOnPush})`);
    assert.equal(bad.path, ABOUT);
    assert.ok(!sim.at(ABOUT), 'rejected item not pushed');
    assert.ok(sim.at('/sitecore/content/Tenant/Site/Home/Data/Text 1'), 'everything else synced');
  }
});
