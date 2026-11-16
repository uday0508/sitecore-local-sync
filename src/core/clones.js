'use strict';

/*
 * Clones. Sitecore refuses to save a clone whose source item doesn't exist yet in the target
 * database ("The clone source has incorrect value. Please fix '__Source Item' value"). SCS saves
 * items in its own order (a clone "Gallery Image 10" can come before its source "Gallery Image 7"),
 * and a failed save leaves the item created but without its language versions.
 *
 * So clones are pushed in two steps: first with their clone link fields (__Source Item, __Source)
 * removed from the YAML, so every item and version is saved; then the link is put back with a
 * small second push of just those clones, once every source exists locally.
 */
const fs = require('fs');
const path = require('path');
const { normId, normPath } = require('./util');

const SOURCE_ITEM = normId('19b597d3-2edd-4ae2-aefe-4a94c7f10e31'); // __Source Item
const SOURCE = normId('1b86697d-60ca-4d80-83fb-7555a2e6ce1c'); // __Source (sitecore://master/{id}?lang=…&ver=…)
const GUID = /\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?/g;
const NULL_ID = normId('00000000-0000-0000-0000-000000000000');

const isSameOrUnder = (p, root) => { const a = normPath(p); const b = normPath(root); return a === b || a.startsWith(b + '/'); };
const isLinkField = (fid, hint) => fid === SOURCE_ITEM || fid === SOURCE || /^__source( item)?$/i.test(hint || '');

/** Clones SCS refused to save, from "[A] <path> (<id>): … clone source has incorrect value" lines. */
function badClonesFromOutput(lines) {
  const out = new Map();
  for (const l of lines) {
    if (!/clone source has incorrect value/i.test(l)) continue;
    const m = /\[[A-Z]\]\s+(\/sitecore\/.+?)\s+\(\{?([0-9a-fA-F-]{36})\}?\)/.exec(l);
    const tail = /Item id:\s*\{?([0-9a-fA-F-]{36})\}?/i.exec(l);
    const id = normId((m && m[2]) || (tail && tail[1]) || '');
    if (!id) continue;
    if (!out.has(id)) out.set(id, { id, path: m ? m[1].trim() : '' });
  }
  return [...out.values()];
}

/** Every pulled file: id, path, file, and the clone source IDs it carries (if any). */
function readWorkspaceItems(itemsDir) {
  const items = [];
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
      items.push({ id: normId(id[1]), path: ip[1].trim(), file: p, sources: cloneSources(text) });
    }
  };
  walk(itemsDir);
  return items;
}

/** Split YAML lines into field entries ("- ID: …" blocks) so link fields can be found or removed. */
function fieldBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s*ID:\s*"?\{?([0-9a-fA-F-]{36})\}?"?\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent)) j++;
    const body = lines.slice(i, j);
    const hint = (body.map((l) => /^\s*Hint:\s*(.+?)\s*$/.exec(l)).find(Boolean) || [])[1];
    blocks.push({ start: i, end: j, fid: normId(m[2]), hint: hint ? hint.replace(/^["']|["']$/g, '') : '', body });
  }
  return blocks;
}

/** GUIDs in the __Source Item / __Source fields of one YAML file (any language or version). */
function cloneSources(text) {
  const found = new Set();
  for (const b of fieldBlocks(text.split(/\r?\n/))) {
    if (!isLinkField(b.fid, b.hint)) continue;
    const value = b.body.filter((l) => !/^\s*(-\s*ID|Hint):/.test(l)).join('\n');
    for (const m of value.matchAll(GUID)) { const g = normId(m[1]); if (g !== NULL_ID) found.add(g); }
  }
  return [...found];
}

/** The YAML without its clone link fields. Empty "SharedFields:"/"Fields:" headers are dropped too. */
function stripCloneLink(text) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  const drop = fieldBlocks(lines).filter((b) => isLinkField(b.fid, b.hint));
  if (!drop.length) return text;
  for (const b of drop.reverse()) lines.splice(b.start, b.end - b.start);
  // A list header left with no entries ("SharedFields:" followed by a sibling key) is removed.
  lines = lines.filter((l, i) => {
    const m = /^(\s*)(SharedFields|Fields):\s*$/.exec(l);
    if (!m) return true;
    const next = lines.slice(i + 1).find((x) => x.trim() !== '');
    return next !== undefined && (next.search(/\S/) > m[1].length || (next.search(/\S/) === m[1].length && /^\s*-\s/.test(next)));
  });
  return lines.join(nl);
}

/** Remove folders left empty under the items folder (SCS validation rejects empty folders). */
function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    pruneEmptyDirs(p);
    if (!fs.readdirSync(p).length) fs.rmdirSync(p);
  }
}

/**
 * Leave items out of this sync: remove their files (and everything under them) and add an
 * "Ignored" rule (or drop the include rooted at them), so SCS neither pushes nor deletes them locally.
 * Include folders themselves are kept; empty folders inside them are removed.
 */
function skipItems(ws, roots, ignorePathInModule) {
  const modulePath = path.join(ws.dir, 'DevSync.module.json');
  let removed = 0;
  for (const it of readWorkspaceItems(ws.itemsDir)) {
    if (roots.some((r) => isSameOrUnder(it.path, r))) { fs.rmSync(it.file, { force: true }); removed++; }
  }
  const mod = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
  mod.items.includes = mod.items.includes.filter((inc) => {
    const below = roots.some((r) => isSameOrUnder(inc.path, r) && normPath(inc.path) !== normPath(r));
    if (below) fs.rmSync(path.join(ws.itemsDir, inc.name), { recursive: true, force: true });
    return !below;
  });
  fs.writeFileSync(modulePath, JSON.stringify(mod, null, 2));
  for (const r of roots) ignorePathInModule(modulePath, r);
  for (const inc of JSON.parse(fs.readFileSync(modulePath, 'utf8')).items.includes) pruneEmptyDirs(path.join(ws.itemsDir, inc.name));
  return removed;
}

/**
 * Item files SCS validation complained about. SCS prints them as absolute paths, or relative to the
 * include folder as "~\Civic-TypeR\form\Torque.yml"; both are matched against the workspace files.
 */
function invalidFilesFromOutput(lines, itemsDir) {
  const out = new Set();
  const norm = (f) => f.replace(/\\/g, '/').toLowerCase();
  const root = norm(path.resolve(itemsDir));
  let all = null;
  for (const l of lines) {
    const s = String(l);
    for (const m of s.matchAll(/(?:[A-Za-z]:)?[\\/][^,"'<>|\r\n]*?\.yml/g)) {
      const f = path.resolve(m[0]);
      if (norm(f).startsWith(root) && fs.existsSync(f)) out.add(f);
    }
    for (const m of s.matchAll(/~([\\/][^,"'<>|\r\n]*?\.yml)/g)) {
      const rel = norm(m[1]);
      all = all || readWorkspaceItems(itemsDir).map((i) => i.file);
      for (const f of all) if (norm(f).endsWith(rel)) out.add(f);
    }
  }
  return [...out];
}

module.exports = { badClonesFromOutput, readWorkspaceItems, cloneSources, stripCloneLink, skipItems, pruneEmptyDirs, invalidFilesFromOutput, isSameOrUnder };
