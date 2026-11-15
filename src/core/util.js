'use strict';

// Braced or bare dashed GUIDs, plus 32-char hex IDs (as returned by the Authoring API).
const GUID_DASHED = /\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?/g;

/** Normalise any Sitecore ID form to lower-case 32-char hex (no braces, no dashes). */
function normId(id) {
  if (!id) return '';
  return String(id).replace(/[{}-]/g, '').toLowerCase();
}

/** Format as {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} which the Authoring API accepts in `where.itemId`. */
function bracedId(id) {
  const h = normId(id).toUpperCase();
  if (h.length !== 32) return id;
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}

/** Extract every dashed GUID referenced in a string (layout XML, link fields, multilists, ...). */
const NULL_ID = '00000000000000000000000000000000';

/** Extract every dashed GUID referenced in a string (layout XML, link fields, multilists, ...). The null ID is ignored. */
function extractGuids(text) {
  const out = new Set();
  if (!text) return out;
  for (const m of String(text).matchAll(GUID_DASHED)) { const id = normId(m[1]); if (id !== NULL_ID) out.add(id); }
  return out;
}

/** Sitecore paths are case-insensitive. Compare in lower case, without trailing slash. */
function normPath(p) {
  return String(p || '').trim().replace(/\/+$/, '').toLowerCase();
}

function isSameOrUnder(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p + '/');
}

function isStrictlyUnder(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  return c.startsWith(p + '/');
}

function parentPath(p) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : s;
}

/** Parse Sitecore ISO basic date "20241114T120709Z" (or full ISO) into a Date, or null. */
function parseSitecoreDate(v) {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z?$/.exec(String(v).trim());
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

/** Minimal concurrency limiter. */
function pLimit(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/** Folder-safe, short include name for SCS (becomes a folder on disk). */
function safeName(s, max = 40) {
  return String(s).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'item';
}

module.exports = {
  NULL_ID, normId, bracedId, extractGuids, normPath, isSameOrUnder, isStrictlyUnder,
  parentPath, parseSitecoreDate, pLimit, safeName,
};
