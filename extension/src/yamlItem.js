'use strict';

/**
 * Read the item identity from a serialized SCS file (*.yml), without a YAML library:
 * the top-level ID, Path, Parent and Template lines are all DevSync needs.
 */
const GUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function readItemHeader(text) {
  const out = {};
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^\s/.test(line) || line.startsWith('- ')) continue; // only top-level keys
    const m = /^(ID|Path|Parent|Template):\s*"?([^"]*?)"?\s*$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
    if (/^(SharedFields|Languages):/.test(line)) break;
  }
  if (!out.id || !GUID.test(out.id.replace(/[{}]/g, ''))) throw new Error('This file is not a serialized Sitecore item (no ID found).');
  if (!out.path || !out.path.startsWith('/sitecore/')) throw new Error('This file has no Sitecore item path.');
  return { id: out.id.replace(/[{}-]/g, '').toLowerCase(), path: out.path, parent: out.parent || null, template: out.template || null };
}

module.exports = { readItemHeader };
