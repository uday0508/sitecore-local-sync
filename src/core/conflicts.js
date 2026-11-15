'use strict';

const fs = require('fs');
const path = require('path');
const { normId, normPath, isSameOrUnder, parentPath } = require('./util');
const { classify, coveredBySelection } = require('./dependencies');

/*
 * Path/ID conflicts between the cloud and the local CM.
 *
 * SCS identifies items by ID but caches the tree by path. If the local CM already has an
 * item at a path the cloud uses, with a different ID (typical when the local site was
 * created separately from the cloud one), the push fails with:
 *   "<path> (<id>) attempted to be cached, but the cache already contained <path> with
 *    different ID <id>. Non-unique paths cannot be serialized."
 *
 * DevSync detects these before pushing (by pulling a snapshot of the same paths from the
 * local CM), asks what to do, and resolves them:
 *   replace: back up the local item, then delete it locally (CLI push of its parent with
 *            the item left out, using CreateUpdateAndDelete), then push the cloud item.
 *   skip:    leave the local item alone and drop the cloud item (and its subtree) from the push.
 */

/** Map of lower-case path -> { id, path, template, file } for every SCS file under dir. */
function readTree(itemsDir) {
  const byPath = new Map();
  const dupes = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.yml')) continue;
      const text = fs.readFileSync(p, 'utf8');
      const id = /^ID:\s*"?([0-9a-fA-F-]{36})"?/m.exec(text);
      const ip = /^Path:\s*(.+)$/m.exec(text);
      if (!id || !ip) continue;
      const rec = { id: normId(id[1]), path: ip[1].trim(), file: p };
      const t = /^Template:\s*"?([0-9a-fA-F-]{36})"?/m.exec(text);
      if (t) rec.template = normId(t[1]);
      const k = normPath(rec.path);
      const prev = byPath.get(k);
      if (prev && prev.id !== rec.id) dupes.push({ path: rec.path, ids: [prev.id, rec.id] });
      byPath.set(k, rec);
    }
  };
  walk(itemsDir);
  return { byPath, dupes };
}

/**
 * Compare cloud files with a local snapshot of the same includes.
 * Returns only the topmost conflicts: replacing or skipping a parent covers its subtree.
 */
function findConflicts(cloud, local) {
  const all = [];
  for (const [k, c] of cloud.byPath) {
    const l = local.byPath.get(k);
    if (l && l.id !== c.id) all.push({ path: c.path, cloudId: c.id, localId: l.id, kind: classify(c.path) });
  }
  all.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const top = [];
  for (const c of all) if (!top.some((t) => isStrictlyBelow(c.path, t.path))) top.push(c);
  for (const t of top) {
    t.localItems = [...local.byPath.values()].filter((x) => isSameOrUnder(x.path, t.path)).length;
    t.cloudItems = [...cloud.byPath.values()].filter((x) => isSameOrUnder(x.path, t.path)).length;
  }
  return top;
}

function isStrictlyBelow(child, parent) { return normPath(child).startsWith(normPath(parent) + '/'); }

/** Conflicts reported by a failed CLI run: [{ path, ids: [a, b] }]. */
function collisionsFromOutput(lines) {
  const out = [];
  const re = /(\/sitecore\/[^\n]*?) \(\{?([0-9a-fA-F-]{36})\}?\) attempted to be cached, but the cache already contained .*? with different ID \{?([0-9a-fA-F-]{36})\}?/i;
  for (const l of lines) {
    const m = re.exec(l);
    if (m) out.push({ path: m[1].trim(), ids: [normId(m[2]), normId(m[3])] });
  }
  return out;
}

/** Turn a reported collision into a conflict, using the cloud files to tell which ID is the cloud's. */
function conflictFromCollision(col, cloud) {
  // Only the file we are pushing tells us which ID is the cloud's. Never guess.
  const c = cloud.byPath.get(normPath(col.path));
  const cloudId = c && col.ids.includes(c.id) ? c.id : null;
  const localId = cloudId ? col.ids.find((x) => x !== cloudId) : null;
  return { path: col.path, cloudId, localId, kind: classify(col.path), localItems: null, cloudItems: null };
}

/** Copy the local files of conflicting subtrees to .devsync/backups/<timestamp>/. */
function backupConflicts(projectRoot, conflicts, localTree) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(projectRoot, '.devsync', 'backups', stamp);
  fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
  let n = 0;
  for (const rec of localTree.byPath.values()) {
    if (!conflicts.some((c) => isSameOrUnder(rec.path, c.path))) continue;
    fs.copyFileSync(rec.file, path.join(dir, 'items', `${String(n++).padStart(5, '0')}-${rec.id}.yml`));
  }
  fs.writeFileSync(path.join(dir, 'conflicts.json'), JSON.stringify({ at: new Date().toISOString(), conflicts }, null, 2));
  return { dir, files: n };
}

/**
 * Group parents into batches where no parent include overlaps another
 * (a parent and its own child can't share a module).
 */
function batchParents(parents) {
  const sorted = [...new Set(parents.map(normPath))].sort((a, b) => a.split('/').length - b.split('/').length);
  const batches = [];
  for (const p of sorted) {
    const overlaps = (q) => p === q || isStrictlyBelow(p, q) && p.split('/').length - q.split('/').length <= 1 || isStrictlyBelow(q, p) && q.split('/').length - p.split('/').length <= 1;
    const b = batches.find((list) => !list.some(overlaps));
    if (b) b.push(p); else batches.push([p]);
  }
  return batches;
}

/** Cleanup module: each parent with its children, CreateUpdateAndDelete. */
function cleanupModule(parentPaths, original) {
  return {
    namespace: 'DevSync',
    items: {
      includes: parentPaths.map((p, i) => ({
        name: `c${String(i).padStart(3, '0')}`,
        path: original.get(p) || p,
        scope: 'ItemAndChildren',
        allowedPushOperations: 'CreateUpdateAndDelete',
      })),
    },
  };
}

/** Drop cloud items in conflicting subtrees from the workspace, and includes rooted inside them. */
function skipInWorkspace(ws, conflicts) {
  const modulePath = path.join(ws.dir, 'DevSync.module.json');
  const mod = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
  const tree = readTree(ws.itemsDir);
  let removed = 0;
  for (const rec of tree.byPath.values()) {
    if (conflicts.some((c) => isSameOrUnder(rec.path, c.path))) { fs.rmSync(rec.file, { force: true }); removed++; }
  }
  const before = mod.items.includes.length;
  mod.items.includes = mod.items.includes.filter((inc) => {
    const inside = conflicts.some((c) => isSameOrUnder(inc.path, c.path));
    if (inside) fs.rmSync(path.join(ws.itemsDir, inc.name), { recursive: true, force: true });
    return !inside;
  });
  fs.writeFileSync(modulePath, JSON.stringify(mod, null, 2));
  return { removedFiles: removed, removedIncludes: before - mod.items.includes.length };
}

/**
 * Exclude a duplicated cloud path from the pull with an SCS "Ignored" rule (or drop the
 * include if the duplicate is its root). Returns true when the module changed.
 */
function ignorePathInModule(modulePath, dupPath) {
  const mod = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
  let changed = false;
  mod.items.includes = mod.items.includes.filter((inc) => {
    if (normPath(inc.path) === normPath(dupPath)) { changed = true; return false; }
    if (inc.scope !== 'SingleItem' && coveredBySelection(dupPath, inc)) {
      const rel = dupPath.slice(inc.path.replace(/\/+$/, '').length);
      inc.rules = inc.rules || [];
      if (!inc.rules.some((r) => normPath(r.path) === normPath(rel))) { inc.rules.unshift({ path: rel, scope: 'Ignored' }); changed = true; }
    }
    return true;
  });
  fs.writeFileSync(modulePath, JSON.stringify(mod, null, 2));
  return changed;
}

module.exports = {
  readTree, findConflicts, collisionsFromOutput, conflictFromCollision, backupConflicts,
  batchParents, cleanupModule, skipInWorkspace, ignorePathInModule, parentPath,
};
