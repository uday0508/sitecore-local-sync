'use strict';

const { extractGuids, normId, normPath, isSameOrUnder, pLimit, NULL_ID } = require('./util');

const ROOTS = {
  media: '/sitecore/media library',
  template: '/sitecore/templates',
  layout: '/sitecore/layout',
  content: '/sitecore/content',
  system: '/sitecore/system',
};

function classify(path) {
  const p = normPath(path);
  if (isSameOrUnder(p, ROOTS.media)) return 'media';
  if (isSameOrUnder(p, ROOTS.template)) return 'template';
  if (isSameOrUnder(p, ROOTS.layout)) return 'layout';
  if (isSameOrUnder(p, ROOTS.content)) return 'content';
  if (isSameOrUnder(p, ROOTS.system)) return 'system';
  return 'other';
}

const DEFAULT_DEP_OPTIONS = {
  media: true,          // images and files referenced by fields
  datasources: true,    // content items referenced by layout or fields (shared datasources, global data)
  templates: true,      // templates of every synced item, plus their base-template chains
  renderings: true,     // rendering definitions used in layouts
  projectOnly: false,   // true: only take templates and renderings under a /Project/ folder
  maxDepth: 2,          // follow content references this many levels deep
  deepScan: true,       // for "with descendants" selections, scan descendants as well as the root
  maxScanItems: 1000,   // cap on items scanned per selection (templates are completed after pull regardless)
  languages: ['en'],
};

// Always present in every SitecoreAI CM, so never pulled.
const ALWAYS_PRESENT = [
  '/sitecore/templates/system',
  '/sitecore/layout/devices',
  '/sitecore/layout/layouts/system',
  '/sitecore/layout/simulators',
];

/**
 * Find everything the selected items need to work locally:
 *  - content references (datasources, linked items) and media, up to maxDepth levels
 *  - the template of every scanned item, plus base templates, followed to the end of the chain
 *  - renderings used in layouts, plus their datasource and parameter templates
 *  - templates of the parent folders DevSync creates
 * Templates and renderings are followed in "templates only" mode, so a template's
 * field sources can't drag random content in.
 */
async function discoverDependencies(client, selections, options = {}, log = () => {}) {
  const opt = { ...DEFAULT_DEP_OPTIONS, ...options };
  const covered = (path) => selections.some((s) => coveredBySelection(path, s));
  const known = new Map();     // id -> resolved info (or null when not found)
  const deps = new Map();      // id -> dependency record
  const skipped = [];
  const limit = pLimit(6);
  const visited = new Set();
  let scanned = 0;

  // Level 0: the selected items (plus descendants when deepScan is on).
  const start = [];
  for (const s of selections) {
    start.push(normId(s.id));
    if (opt.deepScan && (s.scope === 'ItemAndDescendants' || s.scope === 'ItemAndChildren') && s.id) {
      const ids = [];
      try {
        await client.searchUpdatedUnder(s.id, (page) => {
          for (const it of page) {
            if (s.scope === 'ItemAndChildren' && depthBelow(it.path, s.path) > 1) continue;
            ids.push(it.id);
          }
          return ids.length < opt.maxScanItems;
        });
      } catch (e) {
        log(`Search not available for ${s.path} (${e.message}). Scanning only the selected item.`);
      }
      if (ids.length >= opt.maxScanItems) log(`${s.path}: scanned the first ${opt.maxScanItems} items for references. Templates of every pulled item are still checked after the pull.`);
      start.push(...ids.slice(0, opt.maxScanItems));
    }
  }
  let frontier = [...new Set(start.filter(Boolean))].map((id) => ({ id, mode: 'all', depth: 0 }));

  const run = async (label) => {
    for (let round = 0; frontier.length && round < 25; round++) {
      // Collect references. A ref found in "all" mode beats the same ref found in "templates" mode.
      const refs = new Map(); // id -> { mode, depth, asTemplate }
      const addRef = (g, mode, depth, asTemplate = false) => {
        if (!g || g === NULL_ID) return;
        const prev = refs.get(g);
        if (!prev || (prev.mode === 'templates' && mode === 'all')) refs.set(g, { mode, depth, asTemplate: asTemplate || !!(prev && prev.asTemplate) });
        else if (asTemplate) prev.asTemplate = true;
      };
      await Promise.all(frontier.filter((f) => !visited.has(f.id)).map((f) => limit(async () => {
        visited.add(f.id);
        for (const lang of opt.languages) {
          let item;
          try { item = await client.getItemFields(f.id, lang); } catch (e) { log(`Could not read ${f.id}: ${e.message}`); continue; }
          if (!item) continue;
          scanned++;
          // Whatever an item uses as its template IS a template, wherever it lives.
          if (item.templateId && opt.templates) addRef(item.templateId, 'templates', f.depth, true);
          for (const fld of item.fields) {
            const isBase = /^__base template$/i.test(fld.name);
            if (/^(__revision|__owner|__updated by|__created by|__lock)$/i.test(fld.name)) continue;
            const value = String(fld.value || '').replace(/\buid="\{?[0-9a-fA-F-]{36}\}?"/g, '');
            for (const g of extractGuids(value)) if (g !== f.id) addRef(g, isBase ? 'templates' : f.mode, f.depth, isBase);
          }
        }
      })));

      const unresolved = [...refs.keys()].filter((g) => !known.has(g));
      if (unresolved.length) {
        log(`Resolving ${unresolved.length} referenced IDs (${label}, round ${round + 1})`);
        const resolved = await client.resolveIds(unresolved, { onProgress: (d, t) => { if (t > 500 && d % 500 < 25 && d < t) log(`  resolved ${d} of ${t}`); } });
        for (const [k, v] of resolved) known.set(k, v);
      }

      const next = [];
      for (const [g, src] of refs) {
        const info = known.get(g);
        if (!info || deps.has(g)) continue;  // not an item (e.g. a rendering uid), or already added
        if (covered(info.path)) continue;    // already inside a selected tree
        const category = src.asTemplate ? 'template' : classify(info.path);
        // Templates and renderings only lead to more templates.
        if (src.mode === 'templates' && category !== 'template') continue;
        const verdict = accept(category, info.path, opt);
        if (!verdict.ok) { skipped.push({ ...info, category, why: verdict.why }); continue; }
        deps.set(g, { id: g, path: info.path, name: info.name, category, reason: src.mode === 'templates' ? 'template chain' : `referenced (level ${src.depth + 1})` });
        if (category === 'content' && src.depth + 1 <= opt.maxDepth) next.push({ id: g, mode: 'all', depth: src.depth + 1 });
        else if (category === 'content') next.push({ id: g, mode: 'templates', depth: src.depth + 1 }); // still needs its template
        if (category === 'template' || category === 'layout') next.push({ id: g, mode: 'templates', depth: 0 });
      }
      frontier = next;
    }
  };

  await run('references');

  // Parent folders that DevSync will create also need their templates to exist.
  if (opt.templates && typeof client.resolvePaths === 'function') {
    const ancestorPaths = new Set();
    for (const p of [...selections.map((s) => s.path), ...[...deps.values()].map((d) => d.path)]) {
      const parts = p.split('/');
      for (let i = 4; i < parts.length; i++) ancestorPaths.add(parts.slice(0, i).join('/'));
    }
    if (ancestorPaths.size) {
      log(`Checking templates of ${ancestorPaths.size} parent folder(s)`);
      const byPath = await client.resolvePaths([...ancestorPaths]);
      const tplIds = [...new Set([...byPath.values()].filter((x) => x && x.templateId).map((x) => x.templateId))]
        .filter((t) => !deps.has(t));
      const toResolve = tplIds.filter((id) => !known.has(id));
      if (toResolve.length) for (const [k, v] of await client.resolveIds(toResolve)) known.set(k, v);
      frontier = [];
      for (const t of tplIds) {
        const info = known.get(t);
        if (!info || covered(info.path)) continue;
        const verdict = accept('template', info.path, opt);
        if (!verdict.ok) { skipped.push({ ...info, category: 'template', why: verdict.why }); continue; }
        deps.set(t, { id: t, path: info.path, name: info.name, category: 'template', reason: 'template of a parent folder' });
        frontier.push({ id: t, mode: 'templates', depth: 0 });
      }
      await run('parent templates');
    }
  }

  return { dependencies: [...deps.values()], skipped: dedupeSkipped(skipped), scanned };
}

function accept(category, path, opt) {
  if (ALWAYS_PRESENT.some((root) => isSameOrUnder(path, root))) return { ok: false, why: 'built into every CM' };
  switch (category) {
    case 'media': return opt.media ? { ok: true } : { ok: false, why: 'media turned off' };
    case 'content': return opt.datasources ? { ok: true } : { ok: false, why: 'datasources turned off' };
    case 'template':
      if (!opt.templates) return { ok: false, why: 'templates turned off' };
      if (opt.projectOnly && !/\/project\//i.test(path)) return { ok: false, why: 'not under /Project/' };
      return { ok: true };
    case 'layout':
      if (!opt.renderings) return { ok: false, why: 'renderings turned off' };
      if (opt.projectOnly && !/\/project\//i.test(path)) return { ok: false, why: 'not under /Project/' };
      return { ok: true };
    default: return { ok: false, why: `${category} items are never synced` };
  }
}

function coveredBySelection(path, s) {
  const d = depthBelow(path, s.path);
  if (d < 0) return false;
  switch (s.scope) {
    case 'SingleItem': return d === 0;
    case 'ItemAndChildren': return d <= 1;
    case 'DescendantsOnly': return d >= 1;
    default: return true; // ItemAndDescendants
  }
}

/** 0 = same item, 1 = child, ...; -1 when not under. */
function depthBelow(child, parent) {
  const c = normPath(child), p = normPath(parent);
  if (c === p) return 0;
  if (!c.startsWith(p + '/')) return -1;
  return c.slice(p.length + 1).split('/').length;
}

function dedupeSkipped(list) {
  const m = new Map();
  for (const s of list) if (!m.has(s.id)) m.set(s.id, s);
  return [...m.values()];
}

module.exports = { discoverDependencies, classify, coveredBySelection, depthBelow, DEFAULT_DEP_OPTIONS };
