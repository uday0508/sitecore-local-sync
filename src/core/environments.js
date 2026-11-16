'use strict';

const { runCli } = require('./workspace');

/**
 * Discover and connect SitecoreAI environments with the official Sitecore CLI commands:
 *   dotnet sitecore cloud project list --json
 *   dotnet sitecore cloud environment list --project-id <id> --json
 *   dotnet sitecore cloud environment connect --environment-id <id>
 * "connect" writes a standard endpoint into .sitecore/user.json, exactly as a developer
 * would by hand. DevSync connects without --allow-write, so the endpoint stays read-only.
 */
async function captureCli(args, { cwd, dotnet, onLine = () => {} }) {
  const lines = []; const all = [];
  try {
    await runCli(args, { cwd, dotnet, idleMs: 120000, onLine: (l, kind) => { all.push(l); if (kind === 'out') lines.push(l); onLine(l, kind); } });
  } catch (e) {
    if (/NotAuthenticated|refresh token was (corrupted|expired)|re-login|not logged in/i.test(all.join('\n'))) {
      const err = new Error('Your Sitecore CLI login has expired. Run "dotnet sitecore cloud login" in the project folder, then try again.');
      err.code = 'LOGIN_EXPIRED';
      throw err;
    }
    throw e;
  }
  return lines.join('\n');
}

/** Pull the first JSON array/object out of CLI output (it may print banners first). */
function parseJsonOutput(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('The Sitecore CLI did not return JSON. Is the XM Cloud plugin installed and are you logged in ("dotnet sitecore cloud login")?');
  for (let end = text.length; end > start; end--) {
    const ch = text[end - 1];
    if (ch !== ']' && ch !== '}') continue;
    try { return JSON.parse(text.slice(start, end)); } catch { /* keep shrinking */ }
  }
  throw new Error('Could not parse JSON from the Sitecore CLI output.');
}

/** Case-insensitive pick of the first present key. */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = Object.fromEntries(Object.keys(obj).map((k) => [k.toLowerCase(), obj[k]]));
  for (const k of keys) if (map[k.toLowerCase()] != null && map[k.toLowerCase()] !== '') return map[k.toLowerCase()];
  return undefined;
}

function asArray(json) {
  if (Array.isArray(json)) return json;
  for (const k of ['items', 'data', 'results', 'projects', 'environments', 'value']) {
    const v = pick(json, [k]);
    if (Array.isArray(v)) return v;
  }
  return [];
}

async function listProjects(projectRoot, opts = {}) {
  const out = await captureCli(['sitecore', 'cloud', 'project', 'list', '--json'], { cwd: projectRoot, ...opts });
  return asArray(parseJsonOutput(out)).map((p) => ({
    id: pick(p, ['id', 'projectId']),
    name: pick(p, ['name', 'projectName']) || pick(p, ['id']),
  })).filter((p) => p.id);
}

async function listEnvironments(projectRoot, projectId, opts = {}) {
  if (!/^[\w-]+$/.test(String(projectId))) throw new Error('Invalid project ID.');
  const out = await captureCli(['sitecore', 'cloud', 'environment', 'list', '--project-id', projectId, '--json'], { cwd: projectRoot, ...opts });
  return asArray(parseJsonOutput(out)).map((e) => ({
    id: pick(e, ['id', 'environmentId']),
    name: pick(e, ['name', 'environmentName']) || pick(e, ['id']),
    host: pick(e, ['host', 'cmHost', 'hostName', 'environmentHost', 'url']) || '',
    isProd: !!pick(e, ['prod', 'isProd', 'isProduction', 'production']),
  })).filter((e) => e.id);
}

async function connectEnvironment(projectRoot, environmentId, opts = {}) {
  if (!/^[\w-]+$/.test(String(environmentId))) throw new Error('Invalid environment ID.');
  await captureCli(['sitecore', 'cloud', 'environment', 'connect', '--environment-id', environmentId], { cwd: projectRoot, ...opts });
}

module.exports = { listProjects, listEnvironments, connectEnvironment, parseJsonOutput };
