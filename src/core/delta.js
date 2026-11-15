'use strict';

const { parseSitecoreDate, pLimit } = require('./util');
const { coveredBySelection } = require('./dependencies');

/**
 * Find items under the selections that changed in the cloud after `since`.
 * Primary: master-index search sorted by updated date (fast, stops at the first old item).
 * Fallback: walk the tree with the Authoring API (slower, capped).
 *
 * Limitation: items deleted in the cloud are not detected. Run a full sync now and then.
 */
async function findChangedItems(client, selections, since, { maxItems = 2000, log = () => {} } = {}) {
  const sinceDate = since instanceof Date ? since : new Date(since);
  const changed = new Map();
  for (const s of selections) {
    if (s.scope === 'SingleItem') {
      const it = await client.getItemWithChildren({ id: s.id });
      if (it && isAfter(it.updated, sinceDate)) changed.set(it.id, { id: it.id, path: it.path, updated: it.updated });
      continue;
    }
    try {
      await client.searchUpdatedUnder(s.id, (page) => {
        let sawOld = false;
        for (const it of page) {
          const d = parseSitecoreDate(it.updated);
          if (!d || d <= sinceDate) { sawOld = true; continue; }
          if (coveredBySelection(it.path, s)) changed.set(it.id, it);
        }
        return !sawOld && changed.size < maxItems;
      });
    } catch (e) {
      log(`Index search failed for ${s.path} (${e.message}). Walking the tree instead.`);
      await walk(client, s, sinceDate, changed, maxItems);
    }
  }
  return [...changed.values()];
}

async function walk(client, selection, sinceDate, changed, maxItems) {
  const limit = pLimit(4);
  let visited = 0;
  const visit = async (id, depth) => {
    if (visited++ > maxItems * 5) return;
    const node = await client.getItemWithChildren({ id });
    if (!node) return;
    if (isAfter(node.updated, sinceDate) && coveredBySelection(node.path, selection)) changed.set(node.id, { id: node.id, path: node.path, updated: node.updated });
    if (selection.scope === 'ItemAndChildren' && depth >= 1) return;
    await Promise.all((node.children || []).filter((c) => c.hasChildren !== false || isAfter(c.updated, sinceDate))
      .map((c) => limit(() => (c.hasChildren === false
        ? (isAfter(c.updated, sinceDate) && coveredBySelection(c.path, selection) && changed.set(c.id, { id: c.id, path: c.path, updated: c.updated }))
        : visit(c.id, depth + 1)))));
  };
  await visit(selection.id, 0);
}

function isAfter(v, sinceDate) {
  const d = parseSitecoreDate(v);
  return !!d && d > sinceDate;
}

module.exports = { findChangedItems };
