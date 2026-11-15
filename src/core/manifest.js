'use strict';

const fs = require('fs');
const path = require('path');
const { projectDataDir } = require('./paths');
const { normId, normPath, isSameOrUnder, safeName } = require('./util');
const { coveredBySelection } = require('./dependencies');
const { readTree } = require('./conflicts');

/*
 * Item-ID manifest: after a successful sync, DevSync remembers ID -> path for every item in the
 * profile's selected trees. Next time, an ID in the manifest that is no longer in the cloud
 * (verified by a direct lookup, never on index evidence alone) was deleted there, and DevSync can
 * remove it locally. An ID found at a different path was moved. Stored in the data folder.
 */
function file(projectRoot, profileName) {
  return path.join(projectDataDir(projectRoot), 'manifests', `${safeName(profileName || 'Quick sync', 80)}.json`);
}

function loadManifest(projectRoot, profileName) {
  try { return JSON.parse(fs.readFileSync(file(projectRoot, profileName), 'utf8')); } catch { return null; }
}

function saveManifest(projectRoot, profileName, manifest) {
  const f = file(projectRoot, profileName);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }));
}

const inSelections = (p, selections) => selections.some((s) => coveredBySelection(p, s));

/** Manifest entries (id -> path) for the items pulled within the selected trees. */
function itemsFromPulled(itemsDir, selections) {
  const items = {};
  for (const rec of readTree(itemsDir).byPath.values()) if (inSelections(rec.path, selections)) items[rec.id] = rec.path;
  return items;
}

/** Manifest entries still inside the current selections (selections can change between syncs). */
function relevant(manifest, selections) {
  if (!manifest || !manifest.items) return [];
  return Object.entries(manifest.items).filter(([, p]) => inSelections(p, selections)).map(([id, p]) => ({ id: normId(id), path: p }));
}

/**
 * Candidates not seen in the cloud are looked up directly by ID:
 *   not found          -> deleted in the cloud
 *   found, other path  -> moved (to be synced to its new path)
 * Only the topmost deleted item of each subtree is returned (its children go with it).
 */
async function verifyCandidates(client, candidates) {
  if (!candidates.length) return { deleted: [], moved: [] };
  const found = await client.resolveIds(candidates.map((c) => c.id));
  const deleted = [], moved = [];
  for (const c of candidates) {
    const now = found.get(c.id);
    if (!now) deleted.push(c);
    else if (normPath(now.path) !== normPath(c.path)) moved.push({ id: c.id, path: now.path, from: c.path });
  }
  deleted.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const top = deleted.filter((d) => !deleted.some((o) => o !== d && isSameOrUnder(d.path, o.path) && normPath(d.path) !== normPath(o.path)));
  for (const t of top) t.items = deleted.filter((d) => isSameOrUnder(d.path, t.path)).length;
  return { deleted: top, moved, deletedAll: deleted };
}

/** Full sync: compare with what was just pulled (exact, no index involved). */
async function detectAfterPull(client, manifest, itemsDir, selections) {
  const pulled = new Set(Object.keys(itemsFromPulled(itemsDir, selections)));
  const candidates = relevant(manifest, selections).filter((m) => !pulled.has(m.id));
  return verifyCandidates(client, candidates);
}

/** Delta sync: list IDs under each selection through the index (light), then verify. */
async function detectByIndex(client, manifest, selections, { log = () => {} } = {}) {
  const seen = new Map(); // id -> path in the index
  for (const s of selections) {
    if (s.scope === 'SingleItem') { seen.set(normId(s.id), s.path); continue; }
    await client.searchUpdatedUnder(s.id, (page) => { for (const it of page) seen.set(normId(it.id), it.path); return true; }, { pageSize: 500, maxPages: 200 });
  }
  const known = relevant(manifest, selections);
  // Gone from the index, or at another path than last time (moved): confirm each by direct lookup.
  const candidates = known.filter((m) => !seen.has(m.id) || (seen.get(m.id) && normPath(seen.get(m.id)) !== normPath(m.path)));
  if (candidates.length) log(`${candidates.length} previously synced item(s) are missing from the cloud index or have moved. Checking each one directly…`);
  return verifyCandidates(client, candidates);
}

/** New manifest after a delta sync: old entries minus deletions, plus changed/moved items. */
function mergeAfterDelta(manifest, { deletedAll = [], changed = [], moved = [] }, selections) {
  const items = { ...((manifest && manifest.items) || {}) };
  for (const d of deletedAll) delete items[d.id];
  for (const c of [...changed, ...moved]) items[normId(c.id)] = c.path;
  for (const [id, p] of Object.entries(items)) if (!inSelections(p, selections)) delete items[id];
  return { items };
}

module.exports = { loadManifest, saveManifest, itemsFromPulled, detectAfterPull, detectByIndex, mergeAfterDelta, verifyCandidates };
