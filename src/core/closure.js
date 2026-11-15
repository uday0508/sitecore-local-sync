'use strict';

const fs = require('fs');
const path = require('path');
const { normId, normPath, isSameOrUnder, NULL_ID } = require('./util');
const { buildPlan, sortIncludes } = require('./plan');
const { coveredBySelection } = require('./dependencies');
const { prepareWorkspace } = require('./workspace');

const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const BUILT_IN = ['/sitecore/templates/system'];

/**
 * Read every pulled SCS YAML file and collect:
 *  - ids: the item IDs that were pulled
 *  - templateRefs: each item's Template ID, plus the "__Base template" IDs of pulled templates
 * This is the ground truth of what the push needs, regardless of scan limits.
 */
function readPulledItems(itemsDir) {
  const ids = new Set();
  const templateRefs = new Map(); // template id -> one item path that needs it (for messages)
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.yml')) continue;
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      let itemPath = '';
      let inBase = false;
      for (const line of lines) {
        let m;
        if (inBase && /^\s*-\s*ID:/.test(line)) inBase = false;
        if ((m = /^ID:\s*"?([0-9a-fA-F-]{36})"?/.exec(line))) ids.add(normId(m[1]));
        else if ((m = /^Path:\s*(.+)$/.exec(line))) itemPath = m[1].trim();
        else if ((m = /^Template:\s*"?([0-9a-fA-F-]{36})"?/.exec(line))) {
          const t = normId(m[1]);
          if (!templateRefs.has(t)) templateRefs.set(t, itemPath || p);
        } else if (/^\s*Hint:\s*__Base template\s*$/.test(line)) { inBase = true; continue; }
        else if (inBase && /^\s*Value:/.test(line)) {
          for (const g of line.match(GUID) || []) if (!templateRefs.has(normId(g))) templateRefs.set(normId(g), `${itemPath} (base template)`);
          if (!/Value:\s*[|>]/.test(line)) inBase = false;
          continue;
        } else if (inBase && /^\s{4,}\S/.test(line)) {
          for (const g of line.match(GUID) || []) if (!templateRefs.has(normId(g))) templateRefs.set(normId(g), `${itemPath} (base template)`);
          continue;
        }
      }
    }
  };
  walk(itemsDir);
  templateRefs.delete(NULL_ID); // "no base template" in Sitecore, not a real item
  return { ids, templateRefs };
}

/**
 * Make sure every template the pulled items need is pulled too. Missing templates (and their
 * base-template chains, found round by round) are pulled in a side workspace, merged into
 * the main workspace, and added to its module so they push first, as CreateOnly.
 *
 * forceIds: template IDs the local CM reported as missing. These are pulled even if they
 * live under a "built-in" path.
 */
async function ensureTemplates({ project, profile, client, ws, run, log = () => {}, forceIds = [], maxRounds = 6, localClient = null, isShipped = () => false, unavailable = new Map() }) {
  const modulePath = path.join(ws.dir, 'DevSync.module.json');
  const attempted = new Set();
  const forced = new Set(forceIds.map(normId));
  let added = 0;

  for (let round = 0; round < maxRounds; round++) {
    const { ids, templateRefs } = readPulledItems(ws.itemsDir);
    templateRefs.delete(NULL_ID);
    let missing = [...new Set([...templateRefs.keys(), ...forced])].filter((t) => !ids.has(t) && !attempted.has(t));
    if (!missing.length) break;
    missing.forEach((t) => attempted.add(t));
    // Templates the local CM already has (Sitecore defaults, serialized ones) need nothing.
    if (localClient) {
      try {
        const local = await localClient.resolveIds(missing.filter((t) => !forced.has(t)));
        missing = missing.filter((t) => forced.has(t) || !local.get(t));
      } catch { /* fall back to the shipped-folder list below */ }
    }
    if (!missing.length) break;

    const resolved = await client.resolveIds(missing);
    const deps = [];
    for (const t of missing) {
      const info = resolved.get(t);
      if (!info) { unavailable.set(t, templateRefs.get(t) || 'the local CM'); continue; }
      if (!forced.has(t) && (BUILT_IN.some((r) => isSameOrUnder(info.path, r)) || isShipped(info.path))) continue; // ships with every CM
      deps.push({ path: info.path, category: 'template', reason: forced.has(t) ? 'reported missing by local CM' : `needed by ${templateRefs.get(t)}` });
    }
    if (!deps.length) break;

    const moduleJson = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
    const existing = moduleJson.items.includes;
    const extra = buildPlan({ dependencies: deps, includeAncestors: true }).includes
      .filter((x) => !existing.some((e) => normPath(e.path) === normPath(x.path) || (e.scope !== 'SingleItem' && coveredBySelection(x.path, e))))
      .map((x, i) => ({ name: `t${round}${String(i).padStart(3, '0')}-${x.name.slice(4)}`, path: x.path, scope: x.scope, allowedPushOperations: x.allowedPushOperations }));
    if (!extra.length) break;

    log(`Pulling ${deps.length} missing template(s): ${deps.map((d) => d.path).join(', ')}`);
    const side = prepareWorkspace(project, { namespace: 'DevSync', items: { includes: extra } }, { sourceName: profile.source, dirName: 'workspace-extra' });
    await run(side, ['sitecore', 'ser', 'pull', '-n', profile.source]);
    for (const inc of extra) {
      const from = path.join(side.itemsDir, inc.name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(ws.itemsDir, inc.name), { recursive: true });
    }
    const defs = new Set([...readDefinitionPaths(modulePath), ...deps.map((d) => d.path)]);
    moduleJson.items.includes = sortIncludes([...existing, ...extra], { definitionPaths: [...defs] });
    moduleJson.definitionPaths = undefined;
    writeDefinitionPaths(modulePath, [...defs]);
    fs.writeFileSync(modulePath, JSON.stringify(moduleJson, null, 2));
    added += extra.length;
  }
  return added;
}

// Template paths outside /sitecore/templates must still sort first. Kept beside the module,
// since SCS module files shouldn't carry extra properties.
function readDefinitionPaths(modulePath) {
  try { return JSON.parse(fs.readFileSync(modulePath.replace(/\.module\.json$/, '.definitions.json'), 'utf8')); } catch { return []; }
}
function writeDefinitionPaths(modulePath, list) {
  fs.writeFileSync(modulePath.replace(/\.module\.json$/, '.definitions.json'), JSON.stringify(list, null, 2));
}

/**
 * Items whose template exists in neither the cloud nor the local CM are orphans: the template
 * was deleted, but the item still points to it. SCS can't push them. Leave them (and their
 * subtrees) out so the rest of the sync goes through, and return what was left out.
 */
function dropItemsUsingTemplates(ws, templateIds) {
  const ids = new Set([...templateIds].map(normId));
  const modulePath = path.join(ws.dir, 'DevSync.module.json');
  const files = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.yml')) continue;
      const text = fs.readFileSync(p, 'utf8');
      const ip = /^Path:\s*(.+)$/m.exec(text);
      const t = /^Template:\s*"?([0-9a-fA-F-]{36})"?/m.exec(text);
      const idm = /^ID:\s*"?([0-9a-fA-F-]{36})"?/m.exec(text);
      files.push({ file: p, path: ip ? ip[1].trim() : '', template: t ? normId(t[1]) : '', id: idm ? normId(idm[1]) : '' });
    }
  };
  walk(ws.itemsDir);
  // Only content-type items are ever left out. Dropping a template or rendering would just move
  // the failure onto everything that uses it.
  const isDefinition = (p) => /^\/sitecore\/(templates|layout)(\/|$)/i.test(p);
  const roots = files.filter((f) => ids.has(f.template) && !isDefinition(f.path)).map((f) => ({ path: f.path, template: f.template }));
  if (!roots.length) return [];
  for (const f of files) if (roots.some((r) => isSameOrUnder(f.path, r.path))) fs.rmSync(f.file, { force: true });
  const mod = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
  mod.items.includes = mod.items.includes.filter((inc) => {
    const inside = roots.some((r) => isSameOrUnder(inc.path, r.path));
    if (inside) fs.rmSync(path.join(ws.itemsDir, inc.name), { recursive: true, force: true });
    return !inside;
  });
  fs.writeFileSync(modulePath, JSON.stringify(mod, null, 2));
  // Report only the top of each dropped subtree, with how many items it held.
  const tops = roots.filter((r) => !roots.some((o) => o !== r && isSameOrUnder(r.path, o.path) && normPath(r.path) !== normPath(o.path)));
  for (const t of tops) {
    t.items = files.filter((f) => isSameOrUnder(f.path, t.path)).length;
    const own = files.find((f) => normPath(f.path) === normPath(t.path));
    if (own) t.id = own.id;
  }
  return tops;
}

/**
 * Read every pulled file and collect, across ALL languages and versions:
 *  - ids: pulled item IDs
 *  - refs: IDs referenced in field values (layout, links, multilists…) -> an item that uses it
 *  - languages: language name -> number of items with versions in it
 * Field IDs and "__Base template" (templates are handled separately) are not references.
 */
function readPulledContent(itemsDir) {
  const ids = new Set();
  const refs = new Map();
  const languages = new Map();
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.yml')) continue;
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      let itemPath = '';
      let hint = '';
      let inValue = false;
      const langsHere = new Set();
      const add = (line) => {
        if (/^__base template$/i.test(hint)) return;
        for (const g of line.match(GUID) || []) { const id = normId(g); if (id !== NULL_ID && !refs.has(id)) refs.set(id, itemPath); }
      };
      for (const line of lines) {
        let m;
        if ((m = /^ID:\s*"?([0-9a-fA-F-]{36})"?/.exec(line))) { ids.add(normId(m[1])); continue; }
        if ((m = /^Path:\s*(.+)$/.exec(line))) { itemPath = m[1].trim(); continue; }
        if ((m = /^-\s*Language:\s*"?([^"\s]+)"?\s*$/.exec(line))) { langsHere.add(m[1]); continue; }
        if ((m = /^\s*Hint:\s*(.+?)\s*$/.exec(line))) { hint = m[1].replace(/^["']|["']$/g, ''); inValue = false; continue; }
        if (/^\s*-\s*ID:/.test(line)) { inValue = false; hint = ''; continue; }
        if ((m = /^(\s*)Value:\s?(.*)$/.exec(line))) { add(m[2]); inValue = /^[|>]/.test(m[2]); continue; }
        if (inValue && /^\s{2,}\S/.test(line)) { add(line); continue; }
        inValue = false;
      }
      for (const l of langsHere) languages.set(l, (languages.get(l) || 0) + 1);
    }
  };
  walk(itemsDir);
  for (const id of ids) refs.delete(id);
  return { ids, refs, languages };
}

/** Pull extra includes into the side workspace, copy them in, merge into the module. Returns how many were added. */
async function pullExtra({ project, profile, ws, run, deps, tag }) {
  const modulePath = path.join(ws.dir, 'DevSync.module.json');
  const moduleJson = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
  const existing = moduleJson.items.includes;
  const extra = buildPlan({ dependencies: deps, includeAncestors: true }).includes
    .filter((x) => !existing.some((e) => normPath(e.path) === normPath(x.path) || (e.scope !== 'SingleItem' && coveredBySelection(x.path, e))))
    .map((x, i) => ({ name: `${tag}${String(i).padStart(3, '0')}-${x.name.slice(4)}`, path: x.path, scope: x.scope, allowedPushOperations: x.allowedPushOperations }));
  if (!extra.length) return 0;
  const side = prepareWorkspace(project, { namespace: 'DevSync', items: { includes: extra } }, { sourceName: profile.source, dirName: 'workspace-extra' });
  await run(side, ['sitecore', 'ser', 'pull', '-n', profile.source]);
  for (const inc of extra) {
    const from = path.join(side.itemsDir, inc.name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(ws.itemsDir, inc.name), { recursive: true });
  }
  moduleJson.items.includes = sortIncludes([...existing, ...extra], { definitionPaths: readDefinitionPaths(modulePath) });
  fs.writeFileSync(modulePath, JSON.stringify(moduleJson, null, 2));
  return extra.length;
}

/**
 * References found in ANY language version of the pulled items (e.g. a datasource used only in
 * the fr-FR layout) are pulled too, the same way the API scan does for the default language.
 * Content and media are pulled; renderings only when the local CM doesn't already have them.
 */
async function ensureReferences({ project, profile, client, ws, run, localClient = null, isShipped = () => false, log = () => {}, maxRounds = 3 }) {
  const { classify } = require('./dependencies');
  const attempted = new Set();
  let added = 0;
  for (let round = 0; round < maxRounds; round++) {
    const { refs } = readPulledContent(ws.itemsDir);
    const todo = [...refs.keys()].filter((id) => !attempted.has(id));
    if (!todo.length) break;
    todo.forEach((id) => attempted.add(id));
    const found = await client.resolveIds(todo);
    let candidates = todo.map((id) => ({ id, info: found.get(id) })).filter((x) => x.info)
      .map((x) => ({ ...x, category: classify(x.info.path) }))
      .filter((x) => ['content', 'media', 'layout'].includes(x.category) && !isShipped(x.info.path));
    if (localClient && candidates.some((c) => c.category === 'layout')) {
      const local = await localClient.resolveIds(candidates.filter((c) => c.category === 'layout').map((c) => c.id)).catch(() => new Map());
      candidates = candidates.filter((c) => c.category !== 'layout' || !local.get(c.id));
    }
    if (!candidates.length) break;
    const deps = candidates.map((c) => ({ path: c.info.path, category: c.category, reason: `referenced by ${refs.get(c.id)}` }));
    log(`Pulling ${deps.length} item(s) referenced in other languages or beyond the scan: ${deps.slice(0, 5).map((d) => d.path).join(', ')}${deps.length > 5 ? '…' : ''}`);
    added += await pullExtra({ project, profile, ws, run, deps, tag: `r${round}` });
  }
  return added;
}

/**
 * Language definitions: content with fr-FR versions is invisible in a CM without a fr-FR language
 * item. Sitecore matches versions by language NAME, so the definition's ID doesn't matter: only
 * languages the local CM lacks entirely are pulled (create-only).
 */
async function ensureLanguages({ project, profile, client, ws, run, localClient = null }) {
  const { languages } = readPulledContent(ws.itemsDir);
  const names = [...languages.keys()];
  if (!names.length) return { added: [], unknown: [], languages };
  if (!localClient) return { added: [], unknown: names.filter((n) => n.toLowerCase() !== 'en'), languages };
  const paths = names.map((n) => `/sitecore/system/Languages/${n}`);
  const local = await localClient.resolvePaths(paths);
  const missing = paths.filter((p) => !local.get(p));
  if (!missing.length) return { added: [], unknown: [], languages };
  const cloud = await client.resolvePaths(missing);
  const deps = missing.filter((p) => cloud.get(p)).map((p) => ({ path: cloud.get(p).path || p, category: 'system', reason: 'language used by pulled content' }));
  if (deps.length) await pullExtra({ project, profile, ws, run, deps: deps.map((d) => ({ ...d, category: 'content' })), tag: 'lang' });
  // Language items are definitions: never overwrite one that appears meanwhile.
  const modulePath = path.join(ws.dir, 'DevSync.module.json');
  const mod = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
  for (const inc of mod.items.includes) if (/^\/sitecore\/system\/languages\//i.test(inc.path)) inc.allowedPushOperations = 'CreateOnly';
  fs.writeFileSync(modulePath, JSON.stringify(mod, null, 2));
  return { added: deps.map((d) => d.path.split('/').pop()), unknown: [], languages };
}

/** Template IDs from "Template ID <guid> did not exist" lines in CLI output. */
function missingTemplatesFromOutput(lines) {
  const out = new Set();
  for (const l of lines) {
    const m = /Template ID \{?([0-9a-fA-F-]{36})\}? did not exist/i.exec(l);
    if (m && normId(m[1]) !== NULL_ID) out.add(normId(m[1]));
  }
  return [...out];
}

module.exports = { readPulledItems, readPulledContent, ensureTemplates, ensureReferences, ensureLanguages, missingTemplatesFromOutput, writeDefinitionPaths, dropItemsUsingTemplates };
