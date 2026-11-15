'use strict';

const fs = require('fs');
const path = require('path');
const { projectDataDir } = require('./paths');

/*
 * A sync report: what was synced, and every item that needs attention, with how to fix it.
 * Issue types:
 *   orphan            item skipped: its template doesn't exist in the cloud
 *   cloud-duplicate   path skipped: two cloud items share the same name
 *   conflict-replaced local item replaced by the cloud item (backed up / Recycle Bin)
 *   conflict-kept     local item kept, cloud item not pushed
 *   conflict-pending  dry run: a conflict that a real sync would ask about
 *   notice            something worth knowing (e.g. local API not reachable)
 *   error             the sync stopped
 */
const TYPE_LABEL = {
  orphan: 'Skipped: orphaned item',
  'cloud-duplicate': 'Skipped: duplicate name in cloud',
  'conflict-replaced': 'Replaced local item',
  'conflict-kept': 'Kept local item',
  'conflict-pending': 'Conflict (dry run)',
  notice: 'Notice',
  error: 'Sync stopped',
};

function saveReport(projectRoot, report) {
  const dir = path.join(projectDataDir(projectRoot), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(projectDataDir(projectRoot), 'last-report.json'), JSON.stringify(report, null, 2));
  const all = fs.readdirSync(dir).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 20))) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

function loadLastReport(projectRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(projectDataDir(projectRoot), 'last-report.json'), 'utf8')); } catch { return null; }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toCsv(report) {
  const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const rows = [['Type', 'Severity', 'Path', 'Item ID', 'Template ID', 'Items affected', 'What happened', 'How to fix']];
  for (const i of report.issues) rows.push([TYPE_LABEL[i.type] || i.type, i.severity, i.path, i.id, i.templateId, i.items, i.detail, i.fix]);
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

function toHtml(report) {
  const c = report.counts || {};
  const rows = report.issues.map((i) => `<tr class="${esc(i.severity)}"><td>${esc(TYPE_LABEL[i.type] || i.type)}</td><td class="mono">${esc(i.path)}</td><td class="mono">${esc(i.id || '')}${i.templateId ? `<br><small>template ${esc(i.templateId)}</small>` : ''}</td><td>${esc(i.detail)}</td><td>${esc(i.fix || '')}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>DevSync report ${esc(report.at)}</title>
<style>body{font:14px/1.5 Segoe UI,system-ui,sans-serif;margin:32px;color:#1d2330}h1{font-size:20px;margin:0 0 4px}.meta{color:#5b6475;margin-bottom:18px}
.status{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:600;font-size:12px}.ok{background:#e3f6ec;color:#17784a}.fail{background:#fde8e6;color:#b4332a}.warnings{background:#fff3dd;color:#94600b}
.kpis{display:flex;gap:12px;margin:14px 0 22px}.kpi{border:1px solid #e3e6ee;border-radius:10px;padding:10px 14px;min-width:120px}.kpi b{display:block;font-size:20px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #eceff4;vertical-align:top}th{font-size:12px;color:#5b6475;text-transform:uppercase}
.mono{font-family:Consolas,monospace;font-size:12px;word-break:break-all}tr.warning td:first-child{color:#94600b;font-weight:600}tr.error td:first-child{color:#b4332a;font-weight:600}tr.info td:first-child{color:#2f6f8f;font-weight:600}</style></head><body>
<h1>DevSync report</h1>
<div class="meta">${esc(report.profile)} · ${esc(report.source)} → ${esc(report.target)} · ${esc(new Date(report.at).toLocaleString())} · ${esc(report.mode)}${report.dryRun ? ' (dry run)' : ''} · ${Math.round((report.durationMs || 0) / 1000)}s</div>
<span class="status ${report.status === 'failed' ? 'fail' : report.issues.some((i) => i.severity === 'warning') ? 'warnings' : 'ok'}">${report.status === 'failed' ? 'Failed' : report.issues.some((i) => i.severity === 'warning') ? 'Completed with warnings' : 'Completed'}</span>
${report.error ? `<p><b>Error:</b> ${esc(report.error)}</p>` : ''}
<div class="kpis"><div class="kpi"><b>${c.pulledFiles ?? 0}</b>items pulled</div><div class="kpi"><b>${c.includes ?? 0}</b>includes</div><div class="kpi"><b>${c.alreadyLocal ?? 0}</b>already on machine</div><div class="kpi"><b>${c.skippedItems ?? 0}</b>items skipped</div><div class="kpi"><b>${c.conflicts ?? 0}</b>conflicts</div></div>
${report.issues.length ? `<table><thead><tr><th>Type</th><th>Path</th><th>ID</th><th>What happened</th><th>How to fix</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No items needed attention.</p>'}
</body></html>`;
}

module.exports = { saveReport, loadLastReport, toCsv, toHtml, TYPE_LABEL };
