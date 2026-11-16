'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { createHost } = require('../host/handlers');

let win;

// App settings (last project, endpoints, auth mode, profile) so DevSync reopens where you left off.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// Encrypted credential store (OS keychain-backed via safeStorage). Never written to the project.
const credFile = () => path.join(app.getPath('userData'), 'credentials.json');
function readCreds() { try { return JSON.parse(fs.readFileSync(credFile(), 'utf8')); } catch { return {}; } }

const host = createHost({
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select your SitecoreAI solution folder (contains sitecore.json)', properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  },
  settings: { get: readSettings, set: writeSettings },
  secrets: {
    async get(key) {
      const c = readCreds()[key];
      if (!c || !safeStorage.isEncryptionAvailable()) return null;
      const plain = safeStorage.decryptString(Buffer.from(c.secret, 'base64'));
      // v0.12 stored { clientId, secret: <encrypted client secret> }; newer entries encrypt the whole JSON.
      return c.clientId ? JSON.stringify({ clientId: c.clientId, clientSecret: plain }) : plain;
    },
    async set(key, value) {
      if (!safeStorage.isEncryptionAvailable()) return;
      const all = readCreds();
      all[key] = { secret: safeStorage.encryptString(value).toString('base64') };
      fs.mkdirSync(path.dirname(credFile()), { recursive: true });
      fs.writeFileSync(credFile(), JSON.stringify(all, null, 2));
    },
  },
  // Electron's net.fetch uses the OS certificate store, so the local dev cert (mkcert) is trusted.
  fetchLocal: (u, o) => net.fetch(u, o),
  send: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
  openPath: (p) => shell.openPath(p),
  saveReportPath: async (name) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save sync report',
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [{ name: 'Web page (HTML)', extensions: ['html'] }, { name: 'Spreadsheet (CSV)', extensions: ['csv'] }],
    });
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  revealFile: (p) => shell.showItemInFolder(p),
});

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

for (const channel of host.channels) ipcMain.handle(channel, (_e, arg) => host.handle(channel, arg));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
// Closing the window mid-run must not leave the Sitecore CLI running in the background.
app.on('before-quit', () => host.cancel());

module.exports = { host };
