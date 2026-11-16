'use strict';

/*
 * End-to-end check of the VS Code panel WITHOUT VS Code: the exact HTML the extension serves,
 * the real bridge.js + app.js, and the shared host (src/host/handlers.js) answering over a
 * postMessage channel, exactly as the webview does. Sitecore is the repo's SCS simulator.
 * Renders with VS Code Dark Modern and Light Modern theme variables and saves screenshots.
 *
 *   cd extension && node build.js && xvfb-run -a ../node_modules/.bin/electron --no-sandbox test/webview-smoke.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshome-wv-'));
const { createFake, installFake } = require('./fake-vscode');
installFake(createFake({}));
const { buildHtml } = require('../src/panel');
const { createHost } = require('../../src/host/handlers');
const { fakeClient, sampleTree, tempProject, scsSim, withFolders, G } = require('../../test/helpers');

const uiDir = path.join(__dirname, '..', 'dist', 'ui');
const out = path.join(__dirname, '..', 'build', 'screenshots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const THEMES = {
  dark: { '--vscode-editor-background': '#1f1f1f', '--vscode-sideBar-background': '#181818', '--vscode-input-background': '#313131', '--vscode-input-foreground': '#cccccc', '--vscode-input-border': '#3c3c3c', '--vscode-panel-border': '#2b2b2b', '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-button-background': '#0078d4', '--vscode-button-hoverBackground': '#026ec1', '--vscode-button-foreground': '#ffffff', '--vscode-list-hoverBackground': '#2a2d2e', '--vscode-list-inactiveSelectionBackground': '#37373d', '--vscode-badge-background': '#616161', '--vscode-badge-foreground': '#f8f8f8', '--vscode-editorWidget-background': '#202020', '--vscode-editorWidget-border': '#313131', '--vscode-editorGroupHeader-tabsBackground': '#181818', '--vscode-focusBorder': '#0078d4', '--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif', '--vscode-font-size': '13px', '--vscode-notifications-background': '#1f1f1f', '--vscode-checkbox-background': '#313131' },
  light: { '--vscode-editor-background': '#ffffff', '--vscode-sideBar-background': '#f8f8f8', '--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#3b3b3b', '--vscode-input-border': '#cecece', '--vscode-panel-border': '#e5e5e5', '--vscode-foreground': '#3b3b3b', '--vscode-descriptionForeground': '#717171', '--vscode-button-background': '#005fb8', '--vscode-button-hoverBackground': '#0258a8', '--vscode-button-foreground': '#ffffff', '--vscode-list-hoverBackground': '#f2f2f2', '--vscode-list-inactiveSelectionBackground': '#e4e6f1', '--vscode-badge-background': '#cccccc', '--vscode-badge-foreground': '#3b3b3b', '--vscode-editorWidget-background': '#f8f8f8', '--vscode-editorWidget-border': '#c8c8c8', '--vscode-editorGroupHeader-tabsBackground': '#f8f8f8', '--vscode-focusBorder': '#005fb8', '--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif', '--vscode-font-size': '13px', '--vscode-notifications-background': '#ffffff', '--vscode-checkbox-background': '#f8f8f8' },
};

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const checks = {}; const errors = [];

  // Sitecore side: a cloud tree, and a local CM with a conflicting Data folder.
  const SYSTEM = [{ id: G(199), path: '/sitecore/templates/System/Templates/Standard template' }, { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }, { id: G(196), path: '/sitecore/templates/System/Templates/Template' }];
  const cloud = withFolders([...sampleTree(), { id: G(198), path: '/sitecore/templates/System/Templates/Folder' }]).filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
  const local = [...SYSTEM, { id: G(104), path: '/sitecore/templates/Foundation/Tenant' }, { id: G(1), path: '/sitecore/content/Tenant', template: G(104) }, { id: G(2), path: '/sitecore/content/Tenant/Site', template: G(104), parent: G(1) }, { id: G(777), path: '/sitecore/content/Tenant/Site/Data', template: G(198), parent: G(2) }];
  const root = tempProject();
  const sim = scsSim({ cloud, local });
  const client = fakeClient(cloud);
  client.listSites = async () => [{ name: 'Site', rootPath: '/sitecore/content/Tenant/Site', rootId: G(2) }];

  let win;
  const settings = {};
  const secrets = new Map();
  const host = createHost({
    pickFolder: async () => root,
    settings: { get: () => ({ ...settings }), set: (p) => Object.assign(settings, p) },
    secrets: { get: async (k) => secrets.get(k) || null, set: async (k, v) => { secrets.set(k, v); } },
    fetchLocal: null,
    send: (channel, payload) => win && win.webContents.send('wv', { kind: 'push', channel, payload }),
    openPath: async () => true,
    saveReportPath: async () => null,
    preferredProject: async () => root,
    dotnet: sim.dotnet,
  }, { createSourceClient: () => client, createLocalClient: () => sim.api });

  // The webview's postMessage channel.
  ipcMain.on('wv', async (_e, m) => {
    if (!m || m.kind !== 'request') return;
    const result = await host.handle(m.channel, m.arg);
    win.webContents.send('wv', { kind: 'reply', id: m.id, result });
  });

  // Exactly the HTML the extension serves, with file: standing in for the webview origin.
  const fakeWebview = { cspSource: 'file:', asWebviewUri: (u) => `file://${u.fsPath}` };
  const html = buildHtml(fakeWebview, uiDir);
  checks.cspNonce = /script-src 'nonce-[^']+'/.test(html) && !/unsafe-inline/.test(html.match(/Content-Security-Policy" content="([^"]+)"/)[1].replace(/style-src[^;]*;/, ''));
  checks.noDemo = !/demo\.js/.test(html);
  checks.bridgeFirst = html.indexOf('bridge.js') > 0 && html.indexOf('bridge.js') < html.indexOf('app.js');
  const page = path.join(uiDir, '_smoke.html');
  fs.writeFileSync(page, html);

  const preload = path.join(os.tmpdir(), 'wv-preload.js');
  fs.writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({ postMessage: (m) => ipcRenderer.send('wv', m), setState() {}, getState() { return undefined; } }));
ipcRenderer.on('wv', (_e, m) => window.postMessage(m, '*'));`);

  win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { preload, contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const theme = (name) => js(`(() => { const s = document.documentElement.style; for (const [k, v] of Object.entries(${JSON.stringify(THEMES[name])})) s.setProperty(k, v); document.body.classList.toggle('vscode-light', ${name === 'light'}); })()`);
  const shot = async (name) => {
    win.webContents.invalidate(); await wait(400); await win.webContents.capturePage();
    win.webContents.invalidate(); await wait(300);
    fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  };

  await win.loadFile(page);
  await theme('dark');
  await wait(1200);
  checks.inVscode = await js(`document.documentElement.classList.contains('in-vscode') && window.__DEVSYNC_HOST__ === 'vscode' && !window.__DEVSYNC_DEMO__`);
  checks.projectOpened = await js(`document.getElementById('projectName').textContent`);
  checks.connectDialogOpen = await js(`document.getElementById('connDialog').open`);
  await shot('vscode-1-connect.png');

  await js(`document.getElementById('connectBtn').click()`);
  await wait(1200);
  checks.connected = await js(`document.getElementById('connDot').className.includes('ok')`);
  await js(`(() => { const n = [...document.querySelectorAll('.node')].find(n => n.querySelector('.node-name').textContent === 'Home'); n.querySelector('input').click(); })()`);
  await wait(300);
  checks.selected = await js(`document.getElementById('selCount').textContent`);
  await shot('vscode-2-selected.png');

  await js(`document.getElementById('syncBtn').click()`);
  for (let i = 0; i < 60 && !(await js(`document.getElementById('conflictDialog').open`)); i++) await wait(200);
  checks.conflictDialog = await js(`document.getElementById('conflictDialog').open`);
  await shot('vscode-3-conflict.png');
  await js(`document.querySelector('#conflictDialog button[value=replace]').click()`);
  for (let i = 0; i < 80 && (await js(`document.getElementById('syncBtn').textContent`)) !== 'Sync to local'; i++) await wait(200);
  await wait(500);
  checks.synced = await js(`document.querySelector('#summary .big-note')?.textContent`);
  checks.localHasHome = !!sim.at('/sitecore/content/Tenant/Site/Home');
  checks.conflictReplaced = sim.at('/sitecore/content/Tenant/Site/Data')?.id === G(7);
  await js(`document.querySelector('#tabs button[data-tab=report]').click()`);
  await shot('vscode-4-report-dark.png');
  await theme('light');
  await shot('vscode-5-report-light.png');
  await theme('dark');

  // Responsive layout: medium (editor next to the Explorer) and narrow (split editor).
  const layout = async (w, h, name) => {
    win.setContentSize(w, h); await wait(500);
    await shot(name);
    return js(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const a = r('.activity-pane'), t = r('.app-layout > .pane'), y = r('.sync-pane');
      return { activityVisible: a.top < innerHeight && a.bottom > 0 && a.left >= t.right - 1, syncUnderTree: y.top >= t.bottom - 1, pageScrolls: document.scrollingElement.scrollHeight > innerHeight + 2,
        noHorizontalScroll: document.scrollingElement.scrollWidth <= innerWidth + 1 }; })()`);
  };
  checks.medium = await layout(1180, 820, 'vscode-7-medium.png');
  checks.narrow = await layout(760, 900, 'vscode-8-narrow.png');
  win.setContentSize(1600, 900); await wait(400);

  // "Pull latest from cloud" on a .yml / a Page Builder link: the host pushes a command to the UI.
  win.webContents.send('wv', { kind: 'push', channel: 'ui:command', payload: { type: 'sync', items: [{ id: G(6).replace(/-/g, ''), scope: 'SingleItem' }], label: 'Pulling the latest About' } });
  for (let i = 0; i < 20 && (await js(`document.getElementById('syncBtn').textContent`)) === 'Sync to local'; i++) await wait(100);
  for (let i = 0; i < 80 && (await js(`document.getElementById('syncBtn').textContent`)) !== 'Sync to local'; i++) await wait(200);
  await wait(400);
  checks.commandSelection = await js(`[...document.querySelectorAll('#selection .sel-name')].map(e => e.firstChild.textContent).join(',')`);
  checks.commandSynced = !!sim.at('/sitecore/content/Tenant/Site/Home/About');
  await shot('vscode-6-pull-latest.png');

  fs.unlinkSync(page);
  console.log(JSON.stringify({ checks, errors }, null, 2));
  const ok = checks.cspNonce && checks.noDemo && checks.bridgeFirst && checks.inVscode && checks.projectOpened && checks.connected
    && checks.selected === '1 selected' && checks.conflictDialog && /Done/.test(checks.synced || '') && checks.localHasHome && checks.conflictReplaced
    && checks.commandSelection === 'About' && checks.commandSynced && !errors.length
    && checks.medium.activityVisible && checks.medium.syncUnderTree && !checks.medium.pageScrolls && checks.medium.noHorizontalScroll
    && checks.narrow.noHorizontalScroll && checks.narrow.syncUnderTree;
  console.log(ok ? 'WEBVIEW SMOKE OK' : 'WEBVIEW SMOKE FAILED');
  app.exit(ok ? 0 : 1);
});
