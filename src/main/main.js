'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadProject } = require('../core/project');
const { listProfiles, saveProfile, deleteProfile, getLastSync } = require('../core/profiles');
const { createSourceClient, createLocalClient, planSync, executeSync } = require('../core/sync');
const { listProjects, listEnvironments, connectEnvironment } = require('../core/environments');
const { projectDataDir, migrateLegacy, removeLegacy } = require('../core/paths');
const { toHtml, toCsv, loadLastReport } = require('../core/report');

let win;
const session = { project: null, client: null, sourceName: null, abort: null, planned: null, running: null };

// While a preview or sync runs, nothing that changes its inputs is allowed (project, connection,
// profiles), and only one run at a time. The renderer locks the same controls; this is the backstop.
function notWhileRunning() {
  if (session.running) throw new Error(`A ${session.running === 'plan' ? 'preview' : 'sync'} is running. Wait for it to finish or click Cancel.`);
}
async function exclusive(kind, clients, fn) {
  notWhileRunning();
  session.running = kind;
  session.abort = new AbortController();
  for (const c of clients) if (c) c.signal = session.abort.signal;
  try { return await fn(session.abort.signal); } finally {
    for (const c of clients) if (c) c.signal = null; // the shared client must work again after a cancel
    session.abort = null;
    session.running = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 900, minWidth: 1100, minHeight: 700,
    title: 'DevSync for SitecoreAI',
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
// Closing the window mid-run must not leave the Sitecore CLI running in the background.
app.on('before-quit', () => { if (session.abort) session.abort.abort(); });

// Encrypted credential store (OS keychain-backed via safeStorage). Never written to the project.
const credFile = () => path.join(app.getPath('userData'), 'credentials.json');
function readCreds() { try { return JSON.parse(fs.readFileSync(credFile(), 'utf8')); } catch { return {}; } }
function credKey(root, ep) { return `${root}::${ep}`.toLowerCase(); }

function ok(fn) {
  return async (_e, arg) => {
    try { return { ok: true, data: await fn(arg || {}) }; } catch (err) { return { ok: false, error: err.message, cancelled: !!err.cancelled, report: err.report || null }; }
  };
}

function projectInfo() {
  const p = session.project;
  const legacy = migrateLegacy(p.root); // older versions wrote <project>/.devsync
  return {
    legacy: legacy.found ? { path: legacy.path, bytes: legacy.bytes } : null,
    lastReport: loadLastReport(p.root),
    root: p.root, endpoints: p.endpoints, hasUserJson: p.hasUserJson, hasToolManifest: p.hasToolManifest,
    profiles: listProfiles(p.root).map((pr) => ({ ...pr, lastSyncAt: getLastSync(p.root, pr.name) })),
  };
}

// App settings (last project, endpoints, auth mode, profile) so DevSync reopens where you left off.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}
ipcMain.handle('settings:get', ok(async () => readSettings()));
ipcMain.handle('settings:set', ok(async (patch) => {
  const allowed = ['lastSource', 'lastTarget', 'authMode', 'lastProfile', 'autoConnect'];
  return writeSettings(Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))));
}));
ipcMain.handle('project:last', ok(async () => {
  notWhileRunning();
  const { lastProject } = readSettings();
  if (!lastProject || !fs.existsSync(path.join(lastProject, 'sitecore.json'))) return null;
  session.project = loadProject(lastProject);
  session.client = null;
  return projectInfo();
}));

ipcMain.handle('project:pick', ok(async () => {
  notWhileRunning();
  const r = await dialog.showOpenDialog(win, { title: 'Select your SitecoreAI solution folder (contains sitecore.json)', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  session.project = loadProject(r.filePaths[0]);
  session.client = null;
  writeSettings({ lastProject: session.project.root });
  return projectInfo();
}));

ipcMain.handle('project:open', ok(async ({ root }) => { notWhileRunning(); session.project = loadProject(root); session.client = null; return projectInfo(); }));
ipcMain.handle('project:reload', ok(async () => { notWhileRunning(); session.project = loadProject(session.project.root); return projectInfo(); }));

ipcMain.handle('creds:get', ok(async ({ endpoint }) => {
  const c = readCreds()[credKey(session.project.root, endpoint)];
  if (!c || !safeStorage.isEncryptionAvailable()) return null;
  return { clientId: c.clientId, clientSecret: safeStorage.decryptString(Buffer.from(c.secret, 'base64')) };
}));

ipcMain.handle('source:connect', ok(async ({ source, auth, remember }) => {
  if (!session.project) throw new Error('Open a project first.');
  notWhileRunning();
  session.project = loadProject(session.project.root); // pick up a fresh CLI login
  const client = createSourceClient(session.project, source, auth);
  const sites = await client.listSites();
  session.client = client;
  session.sourceName = source;
  if (auth.mode === 'automation' && remember && safeStorage.isEncryptionAvailable()) {
    const all = readCreds();
    all[credKey(session.project.root, source)] = { clientId: auth.clientId, secret: safeStorage.encryptString(auth.clientSecret).toString('base64') };
    fs.mkdirSync(path.dirname(credFile()), { recursive: true });
    fs.writeFileSync(credFile(), JSON.stringify(all, null, 2));
  }
  return { sites, endpoint: client.endpoint };
}));

// Environment discovery through the official Sitecore CLI (runs in the project folder).
const cliLog = (line, kind) => win.webContents.send('sync:event', { type: 'log', level: kind === 'err' ? 'warn' : kind === 'cmd' ? 'cmd' : 'info', message: line, at: new Date().toISOString() });
const needProject = () => { if (!session.project) throw new Error('Open a project first.'); return session.project.root; };
ipcMain.handle('env:projects', ok(async () => listProjects(needProject(), { onLine: cliLog })));
ipcMain.handle('env:list', ok(async ({ projectId }) => listEnvironments(needProject(), projectId, { onLine: cliLog })));
ipcMain.handle('env:connect', ok(async ({ environmentId }) => {
  notWhileRunning();
  await connectEnvironment(needProject(), environmentId, { onLine: cliLog });
  session.project = loadProject(session.project.root);
  return projectInfo();
}));

ipcMain.handle('tree:children', ok(async ({ id, path: p, language }) => {
  if (!session.client) throw new Error('Connect to a source environment first.');
  return session.client.getItemWithChildren({ id, path: p, language });
}));

ipcMain.handle('profiles:save', ok(async ({ profile }) => { notWhileRunning(); saveProfile(session.project.root, profile); return projectInfo(); }));
ipcMain.handle('profiles:delete', ok(async ({ name }) => { notWhileRunning(); deleteProfile(session.project.root, name); return projectInfo(); }));

ipcMain.handle('sync:plan', ok(async ({ profile, mode }) => {
  if (!session.client) throw new Error('Connect to a source environment first.');
  const send = (message) => win.webContents.send('sync:event', { type: 'log', level: 'info', message, at: new Date().toISOString() });
  const localClient = createLocalClient(session.project, profile.target, { fetchImpl: (u, o) => net.fetch(u, o) });
  session.planned = null;
  return exclusive('plan', [session.client, localClient], async (signal) => {
    const planned = await planSync(session.client, profile, { mode, projectRoot: session.project.root, log: send, localClient, signal });
    session.planned = planned;
    session.plannedFor = JSON.stringify(profile);
    return planned;
  });
}));

// Conflict decisions: the engine asks, the renderer answers through 'sync:resolve'.
let pendingConflict = null;
ipcMain.handle('sync:resolve', ok(async ({ decision, remember }) => {
  if (pendingConflict) { const r = pendingConflict; pendingConflict = null; r({ decision, remember }); }
  return true;
}));

ipcMain.handle('sync:run', ok(async ({ profile, dryRun }) => {
  notWhileRunning();
  if (!session.planned || session.plannedFor !== JSON.stringify(profile)) throw new Error('Settings changed since the preview. Click "Preview plan" again before syncing.');
  // Electron's net.fetch uses the OS certificate store, so the local dev cert (mkcert) is trusted.
  const localClient = createLocalClient(session.project, profile.target, { fetchImpl: (u, o) => net.fetch(u, o) });
  return exclusive('sync', [session.client, localClient], (signal) => executeSync(session.project, profile, session.planned, {
      client: session.client,
      localClient,
      skipPush: !!dryRun, signal,
      onConflicts: (conflicts) => new Promise((resolve) => {
        pendingConflict = (answer) => {
          // "Remember" stores the choice on the saved profile, so next time it isn't asked.
          if (answer.remember && ['replace', 'skip'].includes(answer.decision)) {
            const saved = listProfiles(session.project.root).find((p) => p.name === profile.name);
            if (saved) saveProfile(session.project.root, { ...saved, onConflict: answer.decision });
          }
          resolve(answer);
        };
        win.webContents.send('sync:conflicts', conflicts);
      }),
      onEvent: (e) => { if (!win.isDestroyed()) win.webContents.send('sync:event', e); },
    }).finally(() => { pendingConflict = null; }));
}));

ipcMain.handle('sync:cancel', ok(async () => {
  if (pendingConflict) { const r = pendingConflict; pendingConflict = null; r({ decision: 'cancel' }); }
  if (session.abort) session.abort.abort();
  return !!session.running;
}));
ipcMain.handle('shell:open', ok(async () => { await shell.openPath(projectDataDir(session.project.root)); return true; }));
ipcMain.handle('project:removeLegacy', ok(async () => { notWhileRunning(); removeLegacy(session.project.root); return true; }));
ipcMain.handle('report:save', ok(async ({ report }) => {
  const stamp = String(report.at).slice(0, 16).replace(/[:T]/g, '-');
  const r = await dialog.showSaveDialog(win, {
    title: 'Save sync report',
    defaultPath: path.join(app.getPath('documents'), `devsync-report-${stamp}.html`),
    filters: [{ name: 'Web page (HTML)', extensions: ['html'] }, { name: 'Spreadsheet (CSV)', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, /\.csv$/i.test(r.filePath) ? toCsv(report) : toHtml(report));
  shell.showItemInFolder(r.filePath);
  return r.filePath;
}));
