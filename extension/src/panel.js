'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * The DevSync UI (the desktop app's src/renderer) in a full editor tab. Requests from the UI are
 * answered by the shared host; pushes (log lines, conflicts, commands) go the other way.
 */
class DevSyncPanel {
  constructor({ uiDir, host, log, onRunning }) {
    this.uiDir = uiDir; this.host = host; this.log = log; this.onRunning = onRunning || (() => {});
    this.panel = null; this.ready = false; this.queue = [];
  }

  open() {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); return this.panel; }
    const panel = vscode.window.createWebviewPanel('devsync.app', 'DevSync', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true, // keep the tree, log and a running sync when you switch tabs
      localResourceRoots: [vscode.Uri.file(this.uiDir)],
    });
    panel.iconPath = vscode.Uri.file(path.join(this.uiDir, 'icon.png'));
    panel.webview.html = buildHtml(panel.webview, this.uiDir);
    panel.webview.onDidReceiveMessage((m) => this.receive(m));
    panel.onDidDispose(() => {
      // Closing the tab mid-run must not leave the Sitecore CLI running in the background.
      this.host.cancel();
      this.panel = null; this.ready = false; this.queue = [];
    });
    this.panel = panel;
    return panel;
  }

  async receive(m) {
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'ready') {
      this.ready = true;
      for (const q of this.queue.splice(0)) this.panel.webview.postMessage(q);
      return;
    }
    if (m.kind !== 'request' || typeof m.channel !== 'string') return;
    const running = m.channel === 'sync:plan' || m.channel === 'sync:run';
    if (running) this.onRunning(true);
    try {
      const result = await this.host.handle(m.channel, m.arg);
      if (this.panel) this.panel.webview.postMessage({ kind: 'reply', id: m.id, result });
    } finally {
      if (running) this.onRunning(false);
    }
  }

  /** Push to the UI. Queued until the page has loaded. */
  post(channel, payload) {
    if (channel === 'sync:event' && payload && payload.type === 'log') this.log(payload.message, payload.level);
    if (!this.panel) return false;
    const msg = { kind: 'push', channel, payload };
    if (this.ready) this.panel.webview.postMessage(msg); else this.queue.push(msg);
    return true;
  }

  /** Open the panel and send it a command (sync these items, reconnect). */
  command(cmd) {
    this.open();
    this.post('ui:command', cmd);
  }
}

/** index.html from the desktop UI, with webview-safe resource URLs, a nonce CSP and the bridge. */
function buildHtml(webview, uiDir) {
  let html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  const nonce = crypto.randomBytes(18).toString('base64');
  const uri = (f) => webview.asWebviewUri(vscode.Uri.file(path.join(uiDir, f))).toString();
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
  const swaps = [
    [/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp}" />`],
    [/<link rel="stylesheet" href="styles\.css"\s*\/?>/, `<link rel="stylesheet" href="${uri('styles.css')}" />\n  <link rel="stylesheet" href="${uri('vscode-theme.css')}" />`],
    [/<script src="demo\.js"><\/script>\s*/, ''],
    [/<script src="app\.js"><\/script>/, `<script nonce="${nonce}" src="${uri('bridge.js')}"></script>\n  <script nonce="${nonce}" src="${uri('app.js')}"></script>`],
  ];
  for (const [re, to] of swaps) {
    if (!re.test(html)) throw new Error(`DevSync UI: unexpected index.html (${re}). Rebuild the extension.`);
    html = html.replace(re, to);
  }
  return html;
}

module.exports = { DevSyncPanel, buildHtml };
