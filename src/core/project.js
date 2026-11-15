'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Loads a Sitecore CLI project: sitecore.json + .sitecore/user.json.
 * DevSync never edits sitecore.json. It only reads it to copy plugin and
 * serialization settings into its own isolated workspace.
 */
function loadProject(projectDir) {
  const root = path.resolve(projectDir);
  const sitecoreJsonPath = path.join(root, 'sitecore.json');
  if (!fs.existsSync(sitecoreJsonPath)) {
    throw new Error(`No sitecore.json found in ${root}. Pick the root folder of your SitecoreAI solution (where you run "dotnet sitecore ...").`);
  }
  const sitecoreJson = readJson(sitecoreJsonPath);
  const userJsonPath = path.join(root, '.sitecore', 'user.json');
  const userJson = fs.existsSync(userJsonPath) ? readJson(userJsonPath) : { endpoints: {} };
  const toolManifest = path.join(root, '.config', 'dotnet-tools.json');

  return {
    root,
    sitecoreJsonPath,
    sitecoreJson,
    userJsonPath,
    userJson,
    hasUserJson: fs.existsSync(userJsonPath),
    hasToolManifest: fs.existsSync(toolManifest),
    endpoints: listEndpoints(userJson),
  };
}

function readJson(p) {
  // Strip a UTF-8 BOM, which Windows editors sometimes add.
  const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  try { return JSON.parse(raw); } catch (e) { throw new Error(`Could not parse ${p}: ${e.message}`); }
}

const LOCAL_HOST = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|[^/]*\.localhost)(:\d+)?(\/|$)/i;

function isLocalHost(host) {
  return LOCAL_HOST.test(String(host || ''));
}

/** Find an endpoint by name, case-insensitively (the CLI writes "xmCloud" but refs say "XMCloud"). */
function getEndpoint(userJson, name) {
  const eps = (userJson && userJson.endpoints) || {};
  const key = Object.keys(eps).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key ? { name: key, ...eps[key] } : null;
}

/** Follow "ref" links and merge, so we can find host + token fields wherever the CLI put them. */
function resolveEndpoint(userJson, name) {
  const chain = [];
  let cur = getEndpoint(userJson, name);
  const seen = new Set();
  while (cur && !seen.has(cur.name.toLowerCase())) {
    seen.add(cur.name.toLowerCase());
    chain.push(cur);
    cur = cur.ref ? getEndpoint(userJson, cur.ref) : null;
  }
  if (!chain.length) return null;
  // Values on the named endpoint win over values inherited from refs.
  const merged = Object.assign({}, ...chain.slice().reverse());
  merged.name = chain[0].name;
  // The host belongs to the named endpoint only. Inheriting it from a ref would point
  // an environment at the login/Deploy API host.
  merged.host = chain[0].host || '';
  merged.tokenSource = chain.find((e) => e.accessToken || e.refreshToken)?.name || null;
  return merged;
}

/**
 * The CLI's login endpoint (usually "xmCloud", created by "dotnet sitecore cloud login")
 * holds the tokens and points at the Deploy API, not at a CM. It can't be a sync source.
 */
const DEPLOY_HOST = /deploy-api|xmclouddeploy|deploy\.sitecorecloud\.io|auth\.sitecorecloud\.io/i;
function isLoginEndpoint(name, ep) {
  if (DEPLOY_HOST.test(String(ep.host || ''))) return true;
  return !ep.ref && !!(ep.authority || ep.accessToken || ep.refreshToken) && !isLocalHost(ep.host) && /^xmcloud$/i.test(name);
}

function listEndpoints(userJson) {
  const eps = (userJson && userJson.endpoints) || {};
  return Object.keys(eps).map((name) => {
    const r = resolveEndpoint(userJson, name);
    const host = r.host || '';
    const isLocal = isLocalHost(host);
    const login = isLoginEndpoint(name, eps[name]);
    return {
      name,
      host,
      ref: eps[name].ref || null,
      allowWrite: !!eps[name].allowWrite,
      isLocal,
      kind: login ? 'login' : isLocal ? 'local' : 'cloud',
      hasHost: !!host,
    };
  }).filter((e) => e.hasHost);
}

module.exports = { loadProject, readJson, isLocalHost, isLoginEndpoint, getEndpoint, resolveEndpoint, listEndpoints };
