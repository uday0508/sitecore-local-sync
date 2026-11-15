'use strict';

const { normPath, safeName, parentPath } = require('./util');
const { coveredBySelection, depthBelow, classify } = require('./dependencies');

const RANK = { SingleItem: 0, ItemAndChildren: 1, ItemAndDescendants: 2 };
const TREE_ORDER = { template: 0, layout: 1, media: 2, content: 3, system: 4, other: 5 };
const KIND_ORDER ={ template: 0, layout: 1, ancestor: 2, media: 3, selection: 4, changed: 4, content: 5, other: 6 };

/**
 * Turn selections, dependencies and (for delta runs) changed items into a
 * non-overlapping, correctly ordered list of SCS includes.
 *
 * SCS only allows an item to appear in one include, so overlaps are removed.
 * Templates and renderings go first, then parent folders, then content.
 */
function buildPlan({ selections = [], dependencies = [], changed = null, pushMode = 'safe', includeAncestors = true, overwriteDefinitions = false } = {}) {
  // Templates and renderings usually also live in your repo's serialization. By default they
  // are only created when missing (CreateOnly), so local work on them is never overwritten.
  const defOps = overwriteDefinitions ? 'CreateAndUpdate' : 'CreateOnly';
  const selectionOps = pushMode === 'mirror' ? 'CreateUpdateAndDelete' : 'CreateAndUpdate';
  let candidates = [];

  if (changed) {
    // Delta run: only the changed items (and their dependencies), item by item.
    for (const c of changed) candidates.push({ path: c.path, scope: 'SingleItem', allowedPushOperations: 'CreateAndUpdate', kind: 'changed', reason: `changed ${c.updated || ''}`.trim() });
  } else {
    for (const s of selections) candidates.push({ path: s.path, scope: s.scope || 'ItemAndDescendants', allowedPushOperations: selectionOps, kind: 'selection', reason: 'selected' });
  }
  for (const d of dependencies) {
    const cat = d.category || classify(d.path);
    if (cat === 'template' || d.category === 'template') {
      // A template needs its sections, fields and __Standard Values, so include its subtree.
      candidates.push({ path: d.path, scope: 'ItemAndDescendants', allowedPushOperations: defOps, kind: 'template', reason: d.reason || 'template' });
    } else if (cat === 'layout') {
      candidates.push({ path: d.path, scope: 'SingleItem', allowedPushOperations: defOps, kind: 'layout', reason: d.reason || 'rendering' });
    } else {
      candidates.push({ path: d.path, scope: 'SingleItem', allowedPushOperations: 'CreateAndUpdate', kind: cat === 'content' ? 'content' : cat, reason: d.reason || 'dependency' });
    }
  }

  candidates = mergeSamePath(candidates);
  candidates = removeCovered(candidates);

  if (includeAncestors) {
    const ancestors = [];
    for (const c of candidates) {
      for (const a of ancestorsOf(c.path)) {
        ancestors.push({ path: a, scope: 'SingleItem', allowedPushOperations: 'CreateOnly', kind: 'ancestor', reason: `parent of ${c.path}` });
      }
    }
    candidates = removeCovered(mergeSamePath([...candidates, ...ancestors]));
  }

  const definitionPaths = dependencies.filter((d) => (d.category || classify(d.path)) === 'template').map((d) => d.path);
  sortIncludes(candidates, { definitionPaths });

  const used = new Set();
  const includes = candidates.map((c, i) => {
    let name = `${String(i + 1).padStart(3, '0')}-${safeName(c.path.split('/').pop(), 30)}`;
    while (used.has(name.toLowerCase())) name += 'x';
    used.add(name.toLowerCase());
    return { name, ...c };
  });

  return { includes, summary: summarize(includes) };
}

/**
 * Templates first, then layout, media and content. Within each tree go shallow to deep,
 * so a parent is always pushed before its children. Sorts in place and returns the list.
 */
function sortIncludes(list, { definitionPaths = [] } = {}) {
  // A template can live outside /sitecore/templates (e.g. generated component templates).
  // Such templates, and the folders above them, sort with the templates.
  const defs = definitionPaths.map(normPath);
  const isDef = (p) => { const n = normPath(p); return defs.some((d) => d === n || d.startsWith(n + '/')); };
  const order = (p) => (isDef(p) && classify(p) !== 'template' ? TREE_ORDER.template : (TREE_ORDER[classify(p)] ?? 9));
  return list.sort((a, b) => order(a.path) - order(b.path)
    || segments(a.path) - segments(b.path)
    || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
    || normPath(a.path).localeCompare(normPath(b.path)));
}

function mergeSamePath(list) {
  const m = new Map();
  for (const c of list) {
    const k = normPath(c.path);
    const prev = m.get(k);
    if (!prev) { m.set(k, { ...c }); continue; }
    // Keep the broadest scope and the strongest push operation, preferring user selections.
    const keep = (RANK[c.scope] ?? 0) > (RANK[prev.scope] ?? 0) ? { ...c } : prev;
    keep.allowedPushOperations = strongestOps(prev.allowedPushOperations, c.allowedPushOperations);
    if (prev.kind === 'selection' || c.kind === 'selection') keep.kind = 'selection';
    m.set(k, keep);
  }
  return [...m.values()];
}

function strongestOps(a, b) {
  const order = ['CreateOnly', 'CreateAndUpdate', 'CreateUpdateAndDelete'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

/** Drop includes whose whole extent is already inside another include's extent. */
function removeCovered(list) {
  return list.filter((a) => !list.some((b) => b !== a && extentContains(b, a)));
}

function extentContains(b, a) {
  if (normPath(a.path) === normPath(b.path)) return false; // handled by mergeSamePath
  if (!coveredBySelection(a.path, b)) return false;
  if (b.scope === 'ItemAndDescendants' || b.scope === 'DescendantsOnly') return true;
  if (b.scope === 'ItemAndChildren') return a.scope === 'SingleItem' && depthBelow(a.path, b.path) === 1;
  return false;
}

/** Ancestors below the fixed /sitecore/<root> level, which always exists. */
function ancestorsOf(path) {
  const out = [];
  let p = parentPath(path);
  while (segments(p) > 2) { out.push(p); p = parentPath(p); }
  return out;
}

function segments(p) { return normPath(p).split('/').filter(Boolean).length; }

function summarize(includes) {
  const s = { total: includes.length };
  for (const i of includes) s[i.kind] = (s[i.kind] || 0) + 1;
  return s;
}

/** The module.json DevSync writes into its private workspace. */
function toModuleJson(plan, namespace = 'DevSync') {
  return {
    namespace,
    items: {
      includes: plan.includes.map(({ name, path, scope, allowedPushOperations }) => ({ name, path, scope, allowedPushOperations })),
    },
  };
}

module.exports = { buildPlan, toModuleJson, ancestorsOf, sortIncludes };
