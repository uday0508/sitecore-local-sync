'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Profiles are saved sync sets (e.g. "Homepage + Products") shared by the team.
 * They live in <project>/.devsync/profiles.json and never contain secrets.
 * Sync state (last successful sync per profile) lives in .devsync/state.json.
 */
function dir(projectRoot) {
  const d = path.join(projectRoot, '.devsync');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readFile(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function listProfiles(projectRoot) {
  return readFile(path.join(dir(projectRoot), 'profiles.json'), { profiles: [] }).profiles;
}

function saveProfile(projectRoot, profile) {
  if (!profile || !profile.name) throw new Error('A profile needs a name.');
  const clean = sanitize(profile);
  const file = path.join(dir(projectRoot), 'profiles.json');
  const data = readFile(file, { profiles: [] });
  const i = data.profiles.findIndex((p) => p.name.toLowerCase() === clean.name.toLowerCase());
  if (i >= 0) data.profiles[i] = clean; else data.profiles.push(clean);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return clean;
}

function deleteProfile(projectRoot, name) {
  const file = path.join(dir(projectRoot), 'profiles.json');
  const data = readFile(file, { profiles: [] });
  data.profiles = data.profiles.filter((p) => p.name.toLowerCase() !== String(name).toLowerCase());
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sanitize(p) {
  return {
    name: String(p.name).trim(),
    source: p.source || '',
    target: p.target || '',
    language: p.language || 'en',
    selections: (p.selections || []).map((s) => ({ id: s.id, path: s.path, name: s.name || s.path.split('/').pop(), scope: s.scope || 'ItemAndDescendants' })),
    dependencies: p.dependencies || {},
    mask: p.mask || {},
    pushMode: p.pushMode === 'mirror' ? 'mirror' : 'safe',
    includeAncestors: p.includeAncestors !== false,
    onConflict: ['ask', 'replace', 'skip'].includes(p.onConflict) ? p.onConflict : 'ask',
  };
}

function getLastSync(projectRoot, profileName) {
  const s = readFile(path.join(dir(projectRoot), 'state.json'), {});
  return (s[profileName] && s[profileName].lastSyncAt) || null;
}

function setLastSync(projectRoot, profileName, when, extra = {}) {
  const file = path.join(dir(projectRoot), 'state.json');
  const s = readFile(file, {});
  s[profileName] = { ...(s[profileName] || {}), lastSyncAt: when, ...extra };
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

module.exports = { listProfiles, saveProfile, deleteProfile, getLastSync, setLastSync, sanitize };
