'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/*
 * DevSync never stores its own files inside your project. Everything (CLI workspaces, pulled
 * item files, backups, profiles, sync history, reports) lives in a per-user app-data folder:
 *   Windows  %LOCALAPPDATA%\DevSync\projects\<id>\
 *   macOS    ~/Library/Application Support/DevSync/projects/<id>/
 *   Linux    ~/.local/share/devsync/projects/<id>/
 * <id> is a short hash of the project path. Override the root with DEVSYNC_HOME (used by tests).
 * The only project file DevSync ever writes is .sitecore/user.json, and only the token fields
 * the Sitecore CLI refreshed, so your own CLI login keeps working.
 */
function dataRoot() {
  if (process.env.DEVSYNC_HOME) return process.env.DEVSYNC_HOME;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DevSync');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'DevSync');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'devsync');
}

function projectId(projectRoot) {
  const norm = path.resolve(projectRoot).replace(/[\\/]+$/, '');
  const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

/** Per-project data folder (created on first use). Short on purpose: Windows path limits. */
function projectDataDir(projectRoot) {
  const dir = path.join(dataRoot(), 'projects', projectId(projectRoot));
  fs.mkdirSync(dir, { recursive: true });
  const info = path.join(dir, 'project.json');
  if (!fs.existsSync(info)) fs.writeFileSync(info, JSON.stringify({ root: path.resolve(projectRoot), created: new Date().toISOString() }, null, 2));
  return dir;
}

/** The folder older versions created inside the project. */
function legacyDir(projectRoot) { return path.join(projectRoot, '.devsync'); }

function folderSize(dir) {
  let n = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { n += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return n;
}

/**
 * If an older version left <project>/.devsync, move profiles and sync history to the data
 * folder (without overwriting newer ones). The folder itself is only removed by removeLegacy,
 * after the user agrees.
 */
function migrateLegacy(projectRoot) {
  const old = legacyDir(projectRoot);
  if (!fs.existsSync(old)) return { found: false };
  const dest = projectDataDir(projectRoot);
  const moved = [];
  for (const f of ['profiles.json', 'state.json']) {
    const from = path.join(old, f);
    const to = path.join(dest, f);
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.copyFileSync(from, to); moved.push(f); }
  }
  return { found: true, path: old, bytes: folderSize(old), moved };
}

function removeLegacy(projectRoot) {
  const old = legacyDir(projectRoot);
  if (path.basename(old) !== '.devsync') throw new Error('Refusing to remove an unexpected folder.');
  fs.rmSync(old, { recursive: true, force: true });
  return true;
}

/** Keep only the newest `keep` backups. */
function pruneBackups(projectRoot, keep = 5) {
  const dir = path.join(projectDataDir(projectRoot), 'backups');
  if (!fs.existsSync(dir)) return;
  const all = fs.readdirSync(dir).sort();
  for (const d of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
}

module.exports = { dataRoot, projectId, projectDataDir, legacyDir, migrateLegacy, removeLegacy, pruneBackups, folderSize };
