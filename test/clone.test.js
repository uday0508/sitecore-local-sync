'use strict';

// Clones: Sitecore won't save a clone whose '__Source Item' is missing in the local CM.
// DevSync pushes clones without their link first, links them after, pulls missing sources,
// and syncs a clone whose source is gone as a regular item.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshome-clone-'));
const { loadProject } = require('../src/core/project');
const { saveProfile } = require('../src/core/profiles');
const { planSync, executeSync } = require('../src/core/sync');
const { badClonesFromOutput, cloneSources, stripCloneLink } = require('../src/core/clones');
const { normId } = require('../src/core/util');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('./helpers');

const SYSTEM = [{ id: G(199), path: '/sitecore/templates/System/Templates/Standard template' }, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, { id: G(196), path: '/sitecore/templates/System/Templates/Template' }];
const baseLocal = () => [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' }, { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) }];
const BANNER = G(500);
const banner = (source) => ({ id: BANNER, path: '/sitecore/content/Tenant/Site/Home/About/Banner', updated: '20250101T000000Z', fields: { '__Source Item': `{${source.toUpperCase()}}`, Title: 'Banner' } });

async function run(extra, { local = baseLocal() } = {}) {
  const dir = tempProject();
  const items = withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, ...extra]).filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
  const sim = scsSim({ cloud: items, local });
  const profile = saveProfile(dir, { name: 'c', source: 'prod', target: 'local', selections: [{ id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' }] });
  const client = fakeClient(items);
  const planned = await planSync(client, profile, { projectRoot: dir, localClient: sim.api });
  const logs = [];
  const r = await executeSync(loadProject(dir), profile, planned, { client, dotnet: sim.dotnet, localClient: sim.api, onEvent: (e) => { if (e.type === 'log') logs.push(e.message); } });
  return { r, sim, logs };
}

test('parses the clone error and the source fields', () => {
  const line = "4:10:45 PMGraphQL.ExecutionError: [A] /sitecore/content/honda-world/mideast/Home/automobiles/cars/Civic-TypeR/convinience section/Conveneince Banner (289bb803-dba1-4856-bfee-b8ff6183ae4b): [Inner Exception] The clone source has incorrect value. Please fix '__Source Item' value ('Advanced' section) to continue. Item id:{289BB803-DBA1-4856-BFEE-B8FF6183AE4B}";
  const [c] = badClonesFromOutput([line, line]);
  assert.equal(c.id, normId('289bb803-dba1-4856-bfee-b8ff6183ae4b'));
  assert.equal(c.path, '/sitecore/content/honda-world/mideast/Home/automobiles/cars/Civic-TypeR/convinience section/Conveneince Banner');
  const yml = [
    'SharedFields:',
    '- ID: "19b597d3-2edd-4ae2-aefe-4a94c7f10e31"',
    '  Hint: __Source Item',
    '  Value: "{AAAAAAAA-1111-2222-3333-444444444444}"',
    'Languages:',
    '- Language: en',
    '  Versions:',
    '  - Version: 1',
    '    Fields:',
    '    - ID: "1b86697d-60ca-4d80-83fb-7555a2e6ce1c"',
    '      Value: "sitecore://master/{BBBBBBBB-1111-2222-3333-444444444444}?lang=en&ver=1"',
    '    - ID: "25bed78c-4957-4165-998a-ca1b52f67497"',
    '      Hint: __Created',
    '      Value: 20250101T000000Z',
  ].join('\n');
  assert.deepEqual(cloneSources(yml).sort(), ['aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444'].map(normId));
});

test('strips only the clone link fields from the YAML', () => {
  const yml = [
    '---', 'ID: "35ee413c-7395-44f8-808e-524588eba1b7"', 'Template: "10a7b340-3695-4c2c-aab8-9cd1000000ab"', 'Path: /sitecore/content/x/Gallery Image 10',
    'SharedFields:',
    '- ID: "19b597d3-2edd-4ae2-aefe-4a94c7f10e31"',
    '  Hint: __Source Item',
    '  Value: "{4C24F4FE-0D66-4A08-B287-A027EA991C68}"',
    'Languages:', '- Language: en', '  Versions:', '  - Version: 1', '    Fields:',
    '    - ID: "1b86697d-60ca-4d80-83fb-7555a2e6ce1c"',
    '      Hint: __Source',
    '      Value: "sitecore://master/{4C24F4FE-0D66-4A08-B287-A027EA991C68}?lang=en&ver=1"',
    '    - ID: "fa000000-0000-0000-0000-000000000000"',
    '      Hint: Title',
    '      Value: Gallery',
  ].join('\n');
  const out = stripCloneLink(yml);
  assert.doesNotMatch(out, /__Source|SharedFields/);
  assert.match(out, /Hint: Title\n      Value: Gallery/);
  assert.match(out, /- Language: en/);
  assert.deepEqual(cloneSources(out), []);
});

test('clone saved before its source (siblings): unlinked first, linked again after the push', async () => {
  const src = { id: G(501), path: '/sitecore/content/Tenant/Site/Home/About/Gallery Image 7', updated: '20250101T000000Z', fields: { Title: 'Source' } };
  const clone = { ...banner(src.id), path: '/sitecore/content/Tenant/Site/Home/About/Gallery Image 10' };
  const { r, sim, logs } = await run([clone, src]);
  assert.ok(logs.some((l) => /pushed first without their clone link/.test(l)), 'unlinked before the push');
  assert.ok(!logs.some((l) => /clone source has incorrect value/.test(l)), 'the push never hit the clone error');
  assert.ok(sim.at(src.path), 'source synced');
  const local = sim.at(clone.path);
  assert.ok(local, 'clone synced');
  assert.equal(normId(local.source || ''), normId(src.id), 'clone link restored');
  assert.ok(!r.report.issues.some((i) => /clone/.test(i.type)));
});

test('source outside the selection: pulled, then the clone is linked', async () => {
  const src = { id: G(502), path: '/sitecore/system/Modules/Shared Clones/Source B', updated: '20250101T000000Z', fields: { Title: 'Source' } };
  const { r, sim, logs } = await run([src, banner(src.id)]);
  assert.ok(sim.at(src.path), 'source pulled and synced');
  assert.equal(normId(sim.at(banner(src.id).path).source || ''), normId(src.id));
  assert.ok(logs.some((l) => /clone source item\(s\)/.test(l)), 'pulled the source');
  assert.ok(!r.report.issues.some((i) => /clone/.test(i.type)));
});

test('source missing in the cloud: synced as a regular item and reported', async () => {
  const missing = G(777);
  const { r, sim } = await run([banner(missing)]);
  const issue = r.report.issues.find((i) => i.type === 'broken-clone');
  assert.ok(issue, 'reported');
  assert.equal(issue.path, '/sitecore/content/Tenant/Site/Home/About/Banner');
  assert.match(issue.fix, /__Source Item/);
  const local = sim.at('/sitecore/content/Tenant/Site/Home/About/Banner');
  assert.ok(local, 'clone content synced');
  assert.ok(!local.source, 'without the broken link');
  assert.ok(sim.at('/sitecore/content/Tenant/Site/Home/Data/Text 1'), 'everything else synced');
});
