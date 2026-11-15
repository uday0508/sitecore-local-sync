#!/usr/bin/env node
'use strict';

/*
 * A small simulator of the Sitecore CLI serialization commands, for tests.
 * Config (env FAKE_SCS_CONFIG -> JSON): { cloud: [items], localDbFile, cloudEnvs: ['prod'] }
 * An item: { id, path, template, fields }
 *
 * Models what matters to DevSync:
 *  - endpoint must have allowWrite in .sitecore/user.json (even for pull)
 *  - include scopes, and "Ignored" rules
 *  - pull: "Non-unique paths" error when two source items share a path
 *  - push: "Non-unique paths" error when a file's path exists locally with another ID
 *  - push: "Template ID … did not exist" when a template is neither local nor in the files
 *  - push: parent must exist; CreateOnly / CreateAndUpdate / CreateUpdateAndDelete
 *  - token rotation on every run
 */
const fs = require('fs');
const path = require('path');

const [, , tool, ser, op, flag, env] = process.argv;
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_SCS_CONFIG, 'utf8'));
fs.appendFileSync('calls.log', [tool, ser, op, flag, env].join(' ') + '\n');

const uj = JSON.parse(fs.readFileSync('.sitecore/user.json', 'utf8'));
const ep = uj.endpoints[env];
if (!ep || !ep.allowWrite) { console.log(`Environment ${env} is not configured to allow writing data.`); process.exit(1); }
if (cfg.localDown && !cfg.cloudEnvs.includes(env)) { console.log('No connection could be made because the target machine actively refused it. (xmcloudcm.localhost:443)'); process.exit(1); }
// Rotate tokens like the real CLI does on refresh.
const tok = uj.endpoints.xmCloud;
if (tok) { tok.refreshToken = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`; tok.accessToken = `a-${tok.refreshToken}`; fs.writeFileSync('.sitecore/user.json', JSON.stringify(uj)); }
if (cfg.expectRefresh && tok && cfg.expectRefresh !== 'any') { /* unused */ }

const low = (p) => p.toLowerCase();
const nid = (i) => String(i).toLowerCase();
const depth = (c, p) => { c = low(c); p = low(p); if (c === p) return 0; if (!c.startsWith(p + '/')) return -1; return c.slice(p.length + 1).split('/').length; };
function covers(inc, p) {
  const d = depth(p, inc.path);
  if (d < 0) return false;
  for (const r of inc.rules || []) {
    if (/^ignored$/i.test(r.scope) && depth(p, inc.path + r.path) >= 0) return false;
  }
  if (inc.scope === 'SingleItem') return d === 0;
  if (inc.scope === 'ItemAndChildren') return d <= 1;
  if (inc.scope === 'DescendantsOnly') return d >= 1;
  return true;
}
const mod = JSON.parse(fs.readFileSync('DevSync.module.json', 'utf8'));
const isCloud = cfg.cloudEnvs.includes(env);
const readDb = () => (isCloud ? cfg.cloud : JSON.parse(fs.readFileSync(cfg.localDbFile, 'utf8')));
const collision = (p, a, b) => { console.log(`${p} (${a}) attempted to be cached, but the cache already contained ${p} with different ID ${b}. Non-unique paths cannot be serialized. Please choose a different item name.`); process.exit(1); };

if (op === 'pull') {
  const db = readDb();
  let n = 0;
  for (const inc of mod.items.includes) {
    const items = db.filter((it) => covers(inc, it.path));
    const seen = new Map();
    for (const it of items) {
      const prev = seen.get(low(it.path));
      if (prev && nid(prev) !== nid(it.id)) collision(it.path, it.id, prev);
      seen.set(low(it.path), it.id);
    }
    const d = path.join('items', inc.name);
    fs.mkdirSync(d, { recursive: true });
    items.forEach((it, i) => {
      let y = `---\nID: "${it.id}"\nTemplate: "${it.template || 'ffffffff-ffff-ffff-ffff-ffffffffffff'}"\nPath: ${it.path}\n`;
      if (it.fields && it.fields['__Base template']) y += `SharedFields:\n- ID: "12c33f3f-86c5-43a5-aeb4-5598cec45116"\n  Hint: __Base template\n  Value: "${it.fields['__Base template']}"\n`;
      if (it.fields && it.fields.Email) y += `${it.fields['__Base template'] ? '' : 'SharedFields:\n'}- ID: "e"\n  Hint: Email\n  Value: ${it.fields.Email}\n`;
      fs.writeFileSync(path.join(d, `${i}.yml`), y);
      n++;
    });
  }
  console.log(`[master] Serialized ${n} items`);
  process.exit(0);
}

if (op === 'push') {
  if (isCloud) { console.log('DevSync must never push to the cloud'); process.exit(9); }
  let db = readDb();
  // Read files per include.
  const files = [];
  for (const inc of mod.items.includes) {
    const d = path.join('items', inc.name);
    if (!fs.existsSync(d)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const t = fs.readFileSync(p, 'utf8');
        files.push({ inc, id: /^ID: "(.+)"/m.exec(t)[1], path: /^Path: (.+)$/m.exec(t)[1].trim(), template: /^Template: "(.+)"/m.exec(t)[1] });
      }
    };
    walk(d);
  }
  // 1. Path cache: a file path that already exists with another ID (locally or in files) is fatal.
  const byPath = new Map();
  for (const f of files) {
    const prev = byPath.get(low(f.path));
    if (prev && nid(prev) !== nid(f.id)) collision(f.path, f.id, prev);
    byPath.set(low(f.path), f.id);
  }
  for (const f of files) {
    const other = db.find((it) => low(it.path) === low(f.path) && nid(it.id) !== nid(f.id));
    if (other) collision(f.path, f.id, other.id);
  }
  // 2. Templates are checked when each item is written (strict order, like real SCS), below.
  const tplOk = (t) => nid(t) === 'ffffffff-ffff-ffff-ffff-ffffffffffff' || db.some((i) => nid(i.id) === nid(t));
  const fail = (f) => { fs.writeFileSync(cfg.localDbFile, JSON.stringify(db, null, 2)); console.log(`GraphQL.ExecutionError: [A] ${f.path} (${f.id}): Template ID ${f.template} did not exist`); process.exit(1); };
  // 3. Apply include by include, in module order.
  let created = 0, updated = 0, deleted = 0;
  for (const inc of mod.items.includes) {
    const mine = files.filter((f) => f.inc === inc).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    if (inc.allowedPushOperations === 'CreateUpdateAndDelete') {
      const ids = new Set(mine.map((f) => nid(f.id)));
      const gone = db.filter((it) => covers(inc, it.path) && !ids.has(nid(it.id)));
      for (const g of gone) {
        const before = db.length;
        db = db.filter((it) => !(depth(it.path, g.path) >= 0));
        deleted += before - db.length;
      }
    }
    for (const f of mine) {
      const existing = db.find((it) => nid(it.id) === nid(f.id));
      if (!tplOk(f.template) && !(existing && inc.allowedPushOperations === 'CreateOnly')) fail(f);
      if (existing) {
        if (inc.allowedPushOperations === 'CreateOnly') continue;
        const oldPath = existing.path;
        db.forEach((it) => { if (depth(it.path, oldPath) > 0) it.path = f.path + it.path.slice(oldPath.length); });
        existing.path = f.path; existing.template = f.template; updated++;
        continue;
      }
      const parent = f.path.split('/').slice(0, -1).join('/');
      if (parent.split('/').length > 3 && !db.some((it) => low(it.path) === low(parent))) {
        console.log(`Cannot create ${f.path}: parent item ${parent} does not exist.`); process.exit(1);
      }
      const parentItem = db.find((it) => low(it.path) === low(parent));
      db.push({ id: f.id, path: f.path, template: f.template, parent: parentItem && parentItem.id }); created++;
    }
  }
  fs.writeFileSync(cfg.localDbFile, JSON.stringify(db, null, 2));
  console.log(`[master] Pushed: ${created} created, ${updated} updated, ${deleted} deleted`);
  process.exit(0);
}
console.log(`unknown op ${op}`);
process.exit(2);
