'use strict';

const { parseSitecoreDate, pLimit } = require('./util');
const { coveredBySelection } = require('./dependencies');

/**
 * Find items under the selections that changed in the cloud after `since`, in ANY language.
 * The index holds one document per language version, each with its own __Updated, so DevSync
 * searches once per language (plus once unfiltered) and merges. An item changed only in fr-FR
 * is found even if its English version is untouched. SCS then pulls the item with all its
 * languages. If the index can't filter by language, the unfiltered search is used and a notice
 * is returned.
 * Fallback when search fails entirely: walk the tree with the Authoring API (slower, capped).
 * Deletions and moves are detected separately, with the item-ID manifest.
 */
async function findChangedItems(client, selections, since, { maxItems = 2000, log = () => {}, languages = null, notices = [] } = {}) {
  const sinceDate = since instanceof Date ? since : new Date(since);
  const changed = new Map();
  const note = (id, it, lang) => {
    const prev = changed.get(id);
    const langs = new Set(prev ? prev.languages : []);
    if (lang) langs.add(lang);
    changed.set(id, { id, path: it.path, updated: prev && prev.updated > it.updated ? prev.updated : it.updated, languages: [...langs] });
  };
  let languageFilterWorks = true;
  for (const s of selections) {
    if (s.scope === 'SingleItem') {
      const it = await client.getItemWithChildren({ id: s.id });
      if (it && isAfter(it.updated, sinceDate)) note(it.id, it, null);
      continue;
    }
    const scan = (lang) => client.searchUpdatedUnder(s.id, (page) => {
      let sawOld = false;
      for (const it of page) {
        const d = parseSitecoreDate(it.updated);
        if (!d || d <= sinceDate) { sawOld = true; continue; }
        if (coveredBySelection(it.path, s)) note(it.id, it, lang);
      }
      return !sawOld && changed.size < maxItems;
    }, lang ? { language: lang } : {});
    try {
      await scan(null);
      for (const lang of languages || []) {
        if (!languageFilterWorks) break;
        try { await scan(lang); } catch (e) {
          languageFilterWorks = false;
          notices.push(`The cloud index could not filter by language (${e.message}). Changes were detected with a single search across languages.`);
          log(notices[notices.length - 1]);
        }
      }
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
