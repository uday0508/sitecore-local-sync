'use strict';

// Hang and cancel cases: every long step must finish quickly, report progress, and stop on Cancel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshome-'));
const { AuthoringClient } = require('../src/core/graphql');
const { runCliOnce } = require('../src/core/workspace');
const { readPulledContent } = require('../src/core/closure');
const { loadProject } = require('../src/core/project');
const { saveProfile } = require('../src/core/profiles');
const { planSync, executeSync } = require('../src/core/sync');
const { isCancelled } = require('../src/core/util');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('./helpers');

const tokens = { getToken: async () => 't' };
const guid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** Fake API: answers item aliases from `known`; everything else is null. Counts requests. */
function fakeApi({ known = new Map(), rejectBatches = false, hang = false } = {}) {
  const stats = { requests: 0 };
  const fetchImpl = (url, opts) => {
    stats.requests++;
    if (hang) {
      return new Promise((_r, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    const { query } = JSON.parse(opts.body);
    const aliases = [...query.matchAll(/(\w+): item\(where: \{[^}]*itemId: "\{([0-9a-fA-F-]+)\}"/g)];
    if (rejectBatches && aliases.length > 1) return Promise.resolve(new Response(JSON.stringify({ errors: [{ message: 'bad id' }] }), { status: 200 }));
    const data = {};
    for (const [, alias, id] of aliases) {
      const hit = known.get(id.replace(/-/g, '').toLowerCase());
      data[alias] = hit ? { itemId: id, name: 'x', path: hit, template: { name: 't', templateId: G(100) } } : null;
    }
    if (/search\(/.test(query)) data.search = { results: [] };
    return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
  };
  return { stats, client: (o = {}) => new AuthoringClient({ host: 'xmc-x.sitecorecloud.io', tokenProvider: tokens, fetchImpl, ...o }) };
}

test('3000 non-item GUIDs resolve in ~120 batched requests, with no per-ID retries', async () => {
  const ids = Array.from({ length: 3000 }, (_, i) => guid(i + 1));
  const { stats, client } = fakeApi({ known: new Map([[guid(5).replace(/-/g, ''), '/sitecore/content/A']]) });
  const progress = [];
  const out = await client().resolveIds(ids, { onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(stats.requests, 120);
  assert.equal(out.get(guid(5).replace(/-/g, '')).path, '/sitecore/content/A');
  assert.equal(out.get(guid(6).replace(/-/g, '')), null);
  assert.deepEqual(progress[progress.length - 1], [3000, 3000]);
});

test('thorough lookups (missing templates only) try the extra fallbacks', async () => {
  const { stats, client } = fakeApi();
  await client().resolveIds([guid(1), guid(2)], { thorough: true });
  assert.equal(stats.requests, 1 + 2 * 2); // batch, then language + index lookup per ID
});

test('a rejected batch is retried one ID at a time', async () => {
  const { stats, client } = fakeApi({ rejectBatches: true, known: new Map([[guid(2).replace(/-/g, ''), '/sitecore/content/B']]) });
  const out = await client().resolveIds([guid(1), guid(2), guid(3)]);
  assert.equal(stats.requests, 4);
  assert.equal(out.get(guid(2).replace(/-/g, '')).path, '/sitecore/content/B');
});

test('a request that never answers times out, is retried once, then fails with a clear message', async () => {
  const { stats, client } = fakeApi({ hang: true });
  const t0 = Date.now();
  await assert.rejects(client({ timeoutMs: 80 }).resolveIds([guid(1)]), /did not answer within/);
  assert.equal(stats.requests, 2);
  assert.ok(Date.now() - t0 < 2000);
});

test('Cancel stops a hanging API request immediately', async () => {
  const { client } = fakeApi({ hang: true });
  const ac = new AbortController();
  const c = client({ signal: ac.signal, timeoutMs: 60000 });
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(c.resolveIds(Array.from({ length: 200 }, (_, i) => guid(i + 1))), (e) => isCancelled(e));
  assert.ok(Date.now() - t0 < 1000);
});

function script(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecli-'));
  const p = path.join(dir, 'dotnet');
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

test('a CLI that prints nothing is stopped by the idle watchdog', async () => {
  const dotnet = script('setTimeout(() => {}, 60000);');
  const t0 = Date.now();
  await assert.rejects(runCliOnce(['sitecore', 'ser', 'pull'], { dotnet, idleMs: 300 }), /printed nothing/);
  assert.ok(Date.now() - t0 < 5000);
});

test('a CLI prompt gets end-of-input instead of waiting for a keyboard', async () => {
  const dotnet = script(`process.stdout.write('Password: ');
process.stdin.on('data', () => {}); process.stdin.on('end', () => { console.log('no input'); process.exit(2); });
setTimeout(() => process.exit(9), 20000);`);
  await assert.rejects(runCliOnce(['sitecore', 'login'], { dotnet, idleMs: 30000 }), /exited with code 2/);
});

test('Cancel kills a running CLI and rejects as cancelled', async () => {
  const dotnet = script('setInterval(() => console.log("working"), 50);');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(runCliOnce(['sitecore', 'ser', 'pull'], { dotnet, signal: ac.signal }), (e) => isCancelled(e));
  assert.ok(Date.now() - t0 < 4000);
});

test('rendering uids and __Revision values are not treated as references', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'items-'));
  fs.writeFileSync(path.join(dir, 'home.yml'), `---
ID: "${guid(1)}"
Path: /sitecore/content/Site/Home
Languages:
- Language: "fr-FR"
  Versions:
  - Version: 1
    Fields:
    - ID: "8cdc337e-a112-42fb-bbb4-4143751e123f"
      Hint: __Revision
      Value: "${guid(900)}"
    - ID: "04bf00db-f5fb-41f7-8ab7-22408372a981"
      Hint: __Final Renderings
      Value: |
        <r><d id="{${guid(800)}}"><r uid="{${guid(901)}}" s:ds="{${guid(2)}}" s:id="{${guid(3)}}" /></d></r>
`);
  const { refs, languages } = readPulledContent(dir);
  const ids = [...refs.keys()];
  assert.ok(ids.includes(guid(2).replace(/-/g, '')));
  assert.ok(ids.includes(guid(3).replace(/-/g, '')));
  assert.ok(!ids.includes(guid(900).replace(/-/g, '')), '__Revision is not a reference');
  assert.ok(!ids.includes(guid(901).replace(/-/g, '')), 'rendering uid is not a reference');
  assert.equal(languages.get('fr-FR'), 1);
});

test('Cancel during the pull stops the run, pushes nothing and writes a "cancelled" report', async () => {
  const SYSTEM = [{ id: G(199), path: '/sitecore/templates/System/Templates/Standard template' }, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, { id: G(196), path: '/sitecore/templates/System/Templates/Template' }];
  const local = [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' },
    { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104) }];
  const cloud = withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }]).filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
  const dir = tempProject();
  const sim = scsSim({ cloud, local });
  const profile = saveProfile(dir, { name: 'cancel', source: 'prod', target: 'local', selections: [{ id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' }], dependencies: {} });
  const client = fakeClient(cloud);
  const planned = await planSync(client, profile, { projectRoot: dir, localClient: sim.api });
  const before = JSON.stringify(sim.local());
  const ac = new AbortController();
  const events = [];
  const err = await executeSync(loadProject(dir), profile, planned, {
    client, dotnet: sim.dotnet, localClient: sim.api, signal: ac.signal,
    onEvent: (e) => { events.push(e); if (e.type === 'log' && e.level === 'cmd') ac.abort(); },
  }).then(() => null, (e) => e);
  assert.ok(err && isCancelled(err), `expected cancel, got ${err && err.message}`);
  assert.equal(err.report.status, 'cancelled');
  assert.ok(events.some((e) => e.type === 'cancelled'));
  assert.ok(!events.some((e) => e.type === 'step' && e.id === 'push' && e.status === 'running'));
  assert.equal(JSON.stringify(sim.local()), before);
});

test('Cancel during the plan stops it', async () => {
  const dir = tempProject();
  const profile = saveProfile(dir, { name: 'p', source: 'prod', target: 'local', selections: [{ id: G(3), path: '/sitecore/content/Tenant/Site/Home', scope: 'ItemAndDescendants' }], dependencies: {} });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(planSync(fakeClient(sampleTree()), profile, { projectRoot: dir, signal: ac.signal }), (e) => isCancelled(e));
});
