'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isLocalHost, resolveEndpoint, isLoginEndpoint, getEndpoint } = require('./project');

const NAMESPACE = 'DevSync';
const ITEMS_DIR = 'items';
const TOKEN_KEY = /token|expires|lastupdated/i;

/**
 * DevSync runs the Sitecore CLI inside a private workspace (<project>/.devsync/workspace)
 * that holds only DevSync's generated module. That way:
 *  - your repo's sitecore.json and *.module.json files are never touched, and
 *  - SCS's rule that an item appears in only one include can't clash with your modules.
 * The workspace sits inside the project, so the CLI tool manifest (.config/dotnet-tools.json)
 * is still found by walking up the folders.
 */
function prepareWorkspace(project, moduleJson, { sourceName, dirName = 'workspace' } = {}) {
  const base = path.join(project.root, '.devsync');
  const ws = path.join(base, dirName);
  fs.mkdirSync(path.join(ws, '.sitecore'), { recursive: true });
  // Ignore the workspace, state and token backups, but let teams commit shared profiles.
  fs.writeFileSync(path.join(base, '.gitignore'), '*\n!.gitignore\n!profiles.json\n');

  const sj = project.sitecoreJson;
  const sitecoreJson = {
    modules: [`${NAMESPACE}.module.json`],
    plugins: sj.plugins || [],
    serialization: { ...(sj.serialization || {}), defaultModuleRelativeSerializationPath: ITEMS_DIR },
  };
  if (sj.settings) sitecoreJson.settings = sj.settings;
  fs.writeFileSync(path.join(ws, 'sitecore.json'), JSON.stringify(sitecoreJson, null, 2));
  fs.writeFileSync(path.join(ws, `${NAMESPACE}.module.json`), JSON.stringify(moduleJson, null, 2));

  // Copy the CLI connection settings and schemas so endpoint names work unchanged.
  // The Sitecore CLI refuses even "ser pull" unless the endpoint has allowWrite: true.
  // So allowWrite is enabled for the source *only in this private copy*. The user's own
  // user.json stays read-only, and DevSync never runs push against the source (see executeSync).
  if (project.hasUserJson) {
    const copy = JSON.parse(fs.readFileSync(project.userJsonPath, 'utf8').replace(/^\uFEFF/, ''));
    const key = sourceName && Object.keys(copy.endpoints || {}).find((k) => k.toLowerCase() === sourceName.toLowerCase());
    if (key) copy.endpoints[key].allowWrite = true;
    fs.writeFileSync(path.join(ws, '.sitecore', 'user.json'), JSON.stringify(copy, null, 2));
  }
  const schemas = path.join(project.root, '.sitecore', 'schemas');
  if (fs.existsSync(schemas)) fs.cpSync(schemas, path.join(ws, '.sitecore', 'schemas'), { recursive: true });

  // Start each run from an empty items folder.
  const itemsDir = path.join(ws, ITEMS_DIR);
  fs.rmSync(itemsDir, { recursive: true, force: true });
  return { dir: ws, itemsDir, base };
}

/** Refuse any run whose push target isn't a local CM. This is DevSync's core promise. */
function assertSafeTargets(project, sourceName, targetName, { allowRemoteTarget = false } = {}) {
  if (!sourceName || !targetName) throw new Error('Choose both a source (cloud) and a target (local) environment.');
  if (sourceName.toLowerCase() === targetName.toLowerCase()) throw new Error('Source and target must be different environments.');
  const target = resolveEndpoint(project.userJson, targetName);
  const source = resolveEndpoint(project.userJson, sourceName);
  if (!source || !source.host) throw new Error(`Source endpoint "${sourceName}" not found in .sitecore/user.json.`);
  if (isLoginEndpoint(source.name, getEndpoint(project.userJson, sourceName))) throw new Error(`"${sourceName}" is the Sitecore Cloud login endpoint, not an environment.`);
  if (!target || !target.host) throw new Error(`Target endpoint "${targetName}" not found in .sitecore/user.json.`);
  if (!allowRemoteTarget && !isLocalHost(target.host)) {
    throw new Error(`Target "${targetName}" (${target.host}) is not a local CM. DevSync only pushes to localhost or *.localhost hosts.`);
  }
  return { source, target };
}

/** Run a CLI command in the workspace and stream output lines. */
function runCli(args, { cwd, dotnet = process.env.DEVSYNC_DOTNET || 'dotnet', onLine = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    onLine(`> ${dotnet} ${args.join(' ')}`, 'cmd');
    const child = spawn(dotnet, args, { cwd, shell: process.platform === 'win32', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    const pipe = (stream, kind) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        parts.forEach((l) => l.trim() && onLine(l, kind));
      });
      stream.on('end', () => buf.trim() && onLine(buf, kind));
    };
    pipe(child.stdout, 'out');
    pipe(child.stderr, 'err');
    if (signal) signal.addEventListener('abort', () => child.kill(), { once: true });
    child.on('error', (e) => reject(new Error(`Could not start "${dotnet}": ${e.message}. Is the .NET SDK installed and the Sitecore CLI restored (dotnet tool restore)?`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`"${args.slice(0, 3).join(' ')}" exited with code ${code}`))));
  });
}

/**
 * The CLI may refresh tokens while it runs in the workspace. Copy refreshed token fields
 * back to the project's user.json so the developer's own CLI session keeps working
 * (refresh tokens can rotate). Only token fields change, and a backup is kept.
 */
function syncTokensBack(project, ws) {
  const wsUser = path.join(ws.dir, '.sitecore', 'user.json');
  if (!project.hasUserJson || !fs.existsSync(wsUser)) return false;
  const original = JSON.parse(fs.readFileSync(project.userJsonPath, 'utf8').replace(/^﻿/, ''));
  const updated = JSON.parse(fs.readFileSync(wsUser, 'utf8').replace(/^﻿/, ''));
  let changed = false;
  for (const [name, ep] of Object.entries(updated.endpoints || {})) {
    const target = original.endpoints && original.endpoints[name];
    if (!target) continue;
    for (const [k, v] of Object.entries(ep)) {
      if (TOKEN_KEY.test(k) && JSON.stringify(target[k]) !== JSON.stringify(v)) { target[k] = v; changed = true; }
    }
  }
  if (changed) {
    fs.copyFileSync(project.userJsonPath, path.join(ws.base, 'user.json.bak'));
    fs.writeFileSync(project.userJsonPath, JSON.stringify(original, null, 2));
  }
  return changed;
}

/**
 * Before each CLI run, copy the latest token fields from the project's user.json into the
 * workspace copy. Several workspaces run one after another, and refresh tokens can rotate,
 * so a stale copy would make the next run fail to log in.
 */
function pushTokensInto(project, ws) {
  const wsUser = path.join(ws.dir, '.sitecore', 'user.json');
  if (!project.hasUserJson || !fs.existsSync(wsUser)) return false;
  const latest = JSON.parse(fs.readFileSync(project.userJsonPath, 'utf8').replace(/^\uFEFF/, ''));
  const copy = JSON.parse(fs.readFileSync(wsUser, 'utf8').replace(/^\uFEFF/, ''));
  let changed = false;
  for (const [name, ep] of Object.entries(latest.endpoints || {})) {
    const target = copy.endpoints && copy.endpoints[name];
    if (!target) continue;
    for (const [k, v] of Object.entries(ep)) {
      if (TOKEN_KEY.test(k) && JSON.stringify(target[k]) !== JSON.stringify(v)) { target[k] = v; changed = true; }
    }
  }
  if (changed) fs.writeFileSync(wsUser, JSON.stringify(copy, null, 2));
  return changed;
}

function countYaml(dir) {
  let n = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.yml')) n++;
    }
  };
  walk(dir);
  return n;
}

module.exports = { prepareWorkspace, assertSafeTargets, runCli, syncTokensBack, pushTokensInto, countYaml, NAMESPACE };
