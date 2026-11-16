'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let host = null;

function activate(context) {
  const output = vscode.window.createOutputChannel('DevSync', { log: true });
  const cfg = vscode.workspace.getConfiguration('devsync');
  // The engine reads these once, when it is first loaded, so set them before requiring it.
  process.env.DEVSYNC_CLI_IDLE_MS = String(Math.max(1, Number(cfg.get('cliIdleMinutes', 10)) || 10) * 60000);
  process.env.DEVSYNC_API_TIMEOUT_MS = String(Math.max(10, Number(cfg.get('apiTimeoutSeconds', 60)) || 60) * 1000);

  const { createHost } = require('../../src/host/handlers');
  const { createLocalFetch } = require('./localFetch');
  const { DevSyncPanel } = require('./panel');
  const { readItemHeader } = require('./yamlItem');
  const { parseSyncLink, hostOf } = require('./deepLink');
  const { loadProject } = require('../../src/core/project');

  const log = (m, level = 'info') => {
    const fn = { warn: 'warn', error: 'error' }[level] || 'info';
    output[fn](String(m));
  };

  const findWorkspaceProject = async () => {
    const files = await vscode.workspace.findFiles('**/sitecore.json', '**/{node_modules,.git,bin,obj,dist}/**', 20);
    const roots = [...new Set(files.map((f) => path.dirname(f.fsPath)))].sort((a, b) => a.length - b.length);
    return roots[0] || null;
  };

  const settingsKey = 'devsync.settings';
  let panel = null;
  host = createHost({
    pickFolder: async () => {
      const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this SitecoreAI solution', title: 'Select your SitecoreAI solution folder (contains sitecore.json)' });
      return r && r[0] ? r[0].fsPath : null;
    },
    settings: {
      get: () => context.globalState.get(settingsKey) || {},
      set: (patch) => { const next = { ...(context.globalState.get(settingsKey) || {}), ...patch }; context.globalState.update(settingsKey, next); return next; },
    },
    secrets: { get: (k) => context.secrets.get(`devsync:${k}`), set: (k, v) => context.secrets.store(`devsync:${k}`, v) },
    fetchLocal: createLocalFetch({ getConfiguredCa: () => vscode.workspace.getConfiguration('devsync').get('localCaCertificate', ''), log: (m) => log(m, 'warn') }),
    send: (channel, payload) => panel && panel.post(channel, payload),
    openPath: (p) => vscode.env.openExternal(vscode.Uri.file(p)),
    saveReportPath: async (name) => {
      const u = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), name)), filters: { 'Web page': ['html'], Spreadsheet: ['csv'] } });
      return u ? u.fsPath : null;
    },
    revealFile: (p) => vscode.window.showInformationMessage(`DevSync: report saved to ${p}`),
    preferredProject: findWorkspaceProject,
    onLoginExpired: (root) => offerLogin(root),
    get dotnet() { return vscode.workspace.getConfiguration('devsync').get('dotnetPath', '') || undefined; },
  }, context.devsyncFactories || {}); // tests inject fake Sitecore clients here

  const setRunning = (on) => {
    vscode.commands.executeCommand('setContext', 'devsync.running', on);
    status.text = on ? '$(sync~spin) DevSync: working…' : '$(cloud-download) DevSync';
  };
  panel = new DevSyncPanel({ uiDir: path.join(context.extensionPath, 'dist', 'ui'), host, log, onRunning: setRunning });

  // Status bar entry and a launcher in the Activity Bar: both open the full-screen panel.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = '$(cloud-download) DevSync'; status.tooltip = 'Open DevSync'; status.command = 'devsync.open';
  status.show();
  const launcher = vscode.window.createTreeView('devsync.home', { treeDataProvider: { getChildren: () => [], getTreeItem: (x) => x } });
  launcher.onDidChangeVisibility((e) => { if (e.visible) panel.open(); });

  let loginOffered = false;
  async function offerLogin(root) {
    if (loginOffered) return; // one prompt per login problem
    loginOffered = true;
    try {
      const a = await vscode.window.showErrorMessage('DevSync: your Sitecore CLI login has expired. Log in again, and DevSync reconnects automatically.', 'Log in', 'Show log');
      if (a === 'Log in') {
        const t = vscode.window.terminals.find((x) => x.name === 'DevSync: Sitecore login') || vscode.window.createTerminal({ name: 'DevSync: Sitecore login', cwd: root });
        t.show();
        t.sendText('dotnet sitecore cloud login');
      }
      if (a === 'Show log') output.show(true);
    } finally { const t = setTimeout(() => { loginOffered = false; }, 30000); if (t.unref) t.unref(); }
  }

  // After "dotnet sitecore cloud login" rewrites .sitecore/user.json, reconnect without a click.
  const watcher = vscode.workspace.createFileSystemWatcher('**/.sitecore/user.json');
  let timer = null;
  const onUserJson = () => { clearTimeout(timer); timer = setTimeout(() => { if (panel.panel) panel.post('ui:command', { type: 'reconnect' }); }, 1500); };
  watcher.onDidChange(onUserJson); watcher.onDidCreate(onUserJson);

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try { return await fn(...args); } catch (e) {
      log(e.message, 'error');
      const a = await vscode.window.showErrorMessage(`DevSync: ${e.message}`, 'Show log');
      if (a) output.show(true);
      return undefined;
    }
  }));

  cmd('devsync.open', () => { panel.open(); });
  cmd('devsync.cancel', () => host.cancel());
  cmd('devsync.showLog', () => output.show(true));

  // Right-click a serialized item (.yml) -> pull its latest version from the cloud.
  cmd('devsync.pullItem', async (uri) => {
    const target = uri && uri.fsPath ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
    if (!target || !/\.yml$/i.test(target.fsPath)) throw new Error('Open or right-click a serialized item file (.yml).');
    if (host.session.running) throw new Error('A sync is running. Wait for it to finish or cancel it.');
    const item = readItemHeader(fs.readFileSync(target.fsPath, 'utf8'));
    const scope = await vscode.window.showQuickPick([
      { label: 'This item only', value: 'SingleItem' },
      { label: 'With everything below', value: 'ItemAndDescendants' },
    ], { placeHolder: `Pull the latest ${item.path} from the cloud` });
    if (!scope) return;
    panel.command({ type: 'sync', items: [{ id: item.id, path: item.path, scope: scope.value }], label: `Pulling the latest ${item.path.split('/').pop()}` });
  });

  // vscode://<publisher>.devsync-sitecoreai/sync?host=...&item=...&lang=...&scope=...  (Page Builder handoff)
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      try {
        const link = parseSyncLink(uri);
        const root = (host.session.project && host.session.project.root) || (await findWorkspaceProject());
        if (!root) throw new Error('Open your SitecoreAI solution in VS Code first, then use the link again.');
        const ep = loadProject(root).endpoints.find((e) => e.kind === 'cloud' && hostOf(e.host) === link.host);
        if (!ep) {
          panel.open();
          throw new Error(`This project has no connection to ${link.host}. Use "Add cloud environment" in DevSync, then open the link again.`);
        }
        const scopeText = { SingleItem: 'this item only', ItemAndChildren: 'with its children', ItemAndDescendants: 'with everything below' }[link.scope];
        const go = await vscode.window.showInformationMessage(`Sync the page from Page Builder (${scopeText}) from ${ep.name} to your local CM?`,
          { modal: true, detail: `Item ${link.id} · language ${link.language}` }, 'Sync', 'Preview first');
        if (!go) return;
        panel.command({ type: 'sync', source: ep.name, language: link.language, items: [{ id: link.id, scope: link.scope }], preview: go === 'Preview first', label: 'Opened from Page Builder' });
      } catch (e) {
        log(e.message, 'error');
        vscode.window.showErrorMessage(`DevSync: ${e.message}`);
      }
    },
  }));

  context.subscriptions.push(output, status, launcher, watcher, { dispose: () => { clearTimeout(timer); host.cancel(); } });
  return { host, panel }; // for tests
}

function deactivate() {
  // Closing VS Code mid-run must not leave the Sitecore CLI running in the background.
  if (host) host.cancel();
}

module.exports = { activate, deactivate };
