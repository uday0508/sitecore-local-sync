'use strict';

const fs = require('fs');
const path = require('path');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w{-])\+?\d[\d\s().-]{8,}\d(?![\w}-])/g;

const DEFAULT_MASK_OPTIONS = {
  enabled: false,
  fieldNames: ['Email', 'Phone', 'Mobile', 'PhoneNumber', 'Address', 'FirstName', 'LastName'],
  maskEmails: true,   // scrub email addresses in any text field
  maskPhones: false,  // off by default, because it can hit numbers in content
  replacement: '***',
};

/**
 * Mask personal data in SCS YAML before it is pushed to a laptop.
 * Works line by line on the SCS format:
 *   - ID: "..."
 *     Hint: Email
 *     Value: someone@example.com      (or "Value: |" followed by an indented block)
 */
function maskYamlText(text, options = {}) {
  const opt = { ...DEFAULT_MASK_OPTIONS, ...options };
  const names = new Set(opt.fieldNames.map((n) => n.toLowerCase()));
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = [];
  let currentHint = null;
  let changes = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hint = /^\s*Hint:\s*(.+?)\s*$/.exec(line);
    if (hint) { currentHint = hint[1].replace(/^["']|["']$/g, '').toLowerCase(); out.push(line); continue; }
    if (/^\s*-\s*ID:/.test(line)) currentHint = null;

    const val = /^(\s*)Value:\s?(.*)$/.exec(line);
    if (!val) { out.push(line); continue; }

    const indent = val[1];
    const isBlock = /^[|>][+-]?\s*$/.test(val[2]);
    // Gather block lines (indented deeper than "Value:").
    let block = [];
    if (isBlock) {
      while (i + 1 < lines.length && (lines[i + 1].startsWith(indent + ' ') || lines[i + 1].trim() === '') && !/^\s*-\s*ID:/.test(lines[i + 1])) {
        block.push(lines[++i]);
      }
      // Hand back trailing blank lines that belong to the next node.
      while (block.length && block[block.length - 1].trim() === '') { block.pop(); i--; }
    }

    if (currentHint && names.has(currentHint)) {
      out.push(`${indent}Value: ${JSON.stringify(opt.replacement)}`);
      changes++;
      continue;
    }

    const scrub = (s) => {
      let r = s;
      if (opt.maskEmails) r = r.replace(EMAIL, 'masked@example.invalid');
      if (opt.maskPhones) r = r.replace(PHONE, '000-000-0000');
      return r;
    };
    const head = isBlock ? line : `${indent}Value: ${scrub(val[2])}`;
    const body = block.map(scrub);
    if (head !== line || body.some((b, k) => b !== block[k])) changes++;
    out.push(head, ...body);
  }
  return { text: out.join(eol), changes };
}

/** Mask every .yml file under dir. Returns { files, changes }. */
function maskDirectory(dir, options = {}) {
  let files = 0, changes = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.yml')) {
        const src = fs.readFileSync(p, 'utf8');
        const r = maskYamlText(src, options);
        if (r.changes) { fs.writeFileSync(p, r.text); files++; changes += r.changes; }
      }
    }
  };
  walk(dir);
  return { files, changes };
}

module.exports = { maskYamlText, maskDirectory, DEFAULT_MASK_OPTIONS };
