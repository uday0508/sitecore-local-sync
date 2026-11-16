'use strict';

/*
 * The DevSync "host": every request the UI (src/renderer) can make, in one place.
 * Shared by the Electron desktop app (src/main) and the VS Code extension (extension/),
 * so both front-ends behave identically. Platform-specific bits come in through `platform`:
 *
 *   platform.pickFolder()                  -> absolute path | null
 *   platform.settings.get() / .set(obj)    -> app settings (sync)
 *   platform.secrets.get(key) / .set(k,v)  -> encrypted store (async); get returns null if unavailable
 *   platform.fetchLocal                    -> fetch() that trusts the local CM's dev certificate
 *   platform.send(channel, payload)        -> push 'sync:event' / 'sync:conflicts' / 'ui:command' to the UI
 *   platform.openPath(p)                   -> reveal a folder
 *   platform.saveReportPath(defaultName)   -> chosen file path | null
 *   platform.revealFile(p)                 -> show a saved file (optional)
 *   platform.preferredProject()            -> project root to open first (optional; VS Code: the workspace)
 *   platform.onLoginExpired(root, err)     -> offer to log in again (optional)
 *   platform.dotnet                        -> path to dotnet (optional)
 */
const fs = require('fs');
const path = require('path');
const { loadProject } = require('../core/project');
const { listProfiles, saveProfile, deleteProfile, getLastSync } = require('../core/profiles');
const { createSourceClient, createLocalClient, planSync, executeSync } = require('../core/sync');
const { listProjects, listEnvironments, connectEnvironment } = require('../core/environments');
const { projectDataDir, migrateLegacy, removeLegacy } = require('../core/paths');
const { toHtml, toCsv, loadLastReport } = require('../core/report');

const SETTINGS_ALLOWED = ['lastSource', 'lastTarget', 'authMode', 'lastProfile', 'autoConnect', 'layout'];
// Pane sizes from the resizable separators: only known CSS variables with pixel values.
const LAYOUT_KEYS = ['--col-tree', '--col-sync', '--col-left', '--row-tree', '--tree-h'];
function cleanLayout(v) {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => LAYOUT_KEYS.includes(k) && /^\d{2,4}px$/.test(String(x))));
}

function isLoginExpired(e) {
  return !!e && (e.code === 'LOGIN_EXPIRED' || /login has expired|refresh token (was )?(corrupted|expired|invalid)|invalid refresh token|NotAuthenticated/i.test(String(e.message || e)));
}

function createHost(platform, factories = {}) {
  const make = {
    source: factories.createSourceClient || createSourceClient,
    local: factories.createLocalClient || createLocalClient,
  };
  const session = { project: null, client: null, sourceName: null, abort: null, planned: null, plannedFor: null, running: null };
  let pendingConflict = null;

  // While a preview or sync runs, nothing that changes its inputs is allowed (project, connection,
  // profiles), and only one run at a time. The UI locks the same controls; this is the backstop.
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

  const needProject = () => { if (!session.project) throw new Error('Open a project first.'); return session.project.root; };
  const credKey = (root, ep) => `${root}::${ep}`.toLowerCase();
  const localClientFor = (target) => make.local(session.project, target, { fetchImpl: platform.fetchLocal });
  const cliLog = (line, kind) => platform.send('sync:event', { type: 'log', level: kind === 'err' ? 'warn' : kind === 'cmd' ? 'cmd' : 'info', message: line, at: new Date().toISOString() });

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
  function openProject(root) {
    session.project = loadProject(root);
    session.client = null; session.sourceName = null; session.planned = null;
    platform.settings.set({ lastProject: session.project.root });
    return projectInfo();
  }

  const handlers = {
    'settings:get': async () => platform.settings.get(),
    'settings:set': async (patch) => {
      const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => SETTINGS_ALLOWED.includes(k)));
      if ('layout' in clean) clean.layout = cleanLayout(clean.layout);
      return platform.settings.set(clean);
    },

    'project:last': async () => {
      notWhileRunning();
      const preferred = platform.preferredProject && (await platform.preferredProject());
      const { lastProject } = platform.settings.get();
      const root = [preferred, lastProject].find((r) => r && fs.existsSync(path.join(r, 'sitecore.json')));
      if (!root) return null;
      return openProject(root);
    },
    'project:pick': async () => {
      notWhileRunning();
      const root = await platform.pickFolder();
      if (!root) return null;
      return openProject(root);
    },
    'project:open': async ({ root }) => { notWhileRunning(); return openProject(root); },
    'project:reload': async () => { notWhileRunning(); session.project = loadProject(needProject()); return projectInfo(); },
    'project:removeLegacy': async () => { notWhileRunning(); removeLegacy(needProject()); return true; },

    'creds:get': async ({ endpoint }) => {
      const raw = await platform.secrets.get(credKey(needProject(), endpoint));
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },

    'source:connect': async ({ source, auth = { mode: 'cli' }, remember }) => {
      needProject();
      notWhileRunning();
      session.project = loadProject(session.project.root); // pick up a fresh CLI login
      try {
        const client = make.source(session.project, source, auth);
        const sites = await client.listSites();
        session.client = client;
        session.sourceName = source;
        if (auth.mode === 'automation' && remember) {
          await platform.secrets.set(credKey(session.project.root, source), JSON.stringify({ clientId: auth.clientId, clientSecret: auth.clientSecret }));
        }
        return { sites, endpoint: client.endpoint };
      } catch (e) {
        if (isLoginExpired(e) && platform.onLoginExpired) platform.onLoginExpired(session.project.root, e);
        throw e;
      }
    },

    // Environment discovery through the official Sitecore CLI (runs in the project folder).
    'env:projects': async () => withLogin(() => listProjects(needProject(), { onLine: cliLog, dotnet: platform.dotnet })),
    'env:list': async ({ projectId }) => withLogin(() => listEnvironments(needProject(), projectId, { onLine: cliLog, dotnet: platform.dotnet })),
    'env:connect': async ({ environmentId }) => {
      notWhileRunning();
      await withLogin(() => connectEnvironment(needProject(), environmentId, { onLine: cliLog, dotnet: platform.dotnet }));
      session.project = loadProject(session.project.root);
      return projectInfo();
    },

    'tree:children': async ({ id, path: p, language }) => {
      if (!session.client) throw new Error('Connect to a source environment first.');
      return session.client.getItemWithChildren({ id, path: p, language });
    },

    'profiles:save': async ({ profile }) => { notWhileRunning(); saveProfile(needProject(), profile); return projectInfo(); },
    'profiles:delete': async ({ name }) => { notWhileRunning(); deleteProfile(needProject(), name); return projectInfo(); },

    'sync:plan': async ({ profile, mode }) => {
      if (!session.client) throw new Error('Connect to a source environment first.');
      const send = (message) => platform.send('sync:event', { type: 'log', level: 'info', message, at: new Date().toISOString() });
      const localClient = localClientFor(profile.target);
      session.planned = null;
      return exclusive('plan', [session.client, localClient], async (signal) => {
        const planned = await planSync(session.client, profile, { mode, projectRoot: session.project.root, log: send, localClient, signal });
        session.planned = planned;
        session.plannedFor = JSON.stringify(profile);
        return planned;
      });
    },

    // Conflict decisions: the engine asks, the UI answers through 'sync:resolve'.
    'sync:resolve': async ({ decision, remember }) => {
      if (pendingConflict) { const r = pendingConflict; pendingConflict = null; r({ decision, remember }); }
      return true;
    },

    'sync:run': async ({ profile, dryRun }) => {
      notWhileRunning();
      if (!session.planned || session.plannedFor !== JSON.stringify(profile)) throw new Error('Settings changed since the preview. Click "Preview plan" again before syncing.');
      const localClient = localClientFor(profile.target);
      return exclusive('sync', [session.client, localClient], (signal) => executeSync(session.project, profile, session.planned, {
        client: session.client,
        localClient,
        dotnet: platform.dotnet,
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
          platform.send('sync:conflicts', conflicts);
        }),
        onEvent: (e) => platform.send('sync:event', e),
      }).finally(() => { pendingConflict = null; }));
    },

    'sync:cancel': async () => cancel(),
    'shell:open': async () => { await platform.openPath(projectDataDir(needProject())); return true; },
    'report:save': async ({ report }) => {
      const stamp = String(report.at).slice(0, 16).replace(/[:T]/g, '-');
      const file = await platform.saveReportPath(`devsync-report-${stamp}.html`);
      if (!file) return null;
      fs.writeFileSync(file, /\.csv$/i.test(file) ? toCsv(report) : toHtml(report));
      if (platform.revealFile) platform.revealFile(file);
      return file;
    },
  };

  async function withLogin(fn) {
    try { return await fn(); } catch (e) {
      if (isLoginExpired(e) && platform.onLoginExpired && session.project) platform.onLoginExpired(session.project.root, e);
      throw e;
    }
  }

  function cancel() {
    if (pendingConflict) { const r = pendingConflict; pendingConflict = null; r({ decision: 'cancel' }); }
    if (session.abort) session.abort.abort();
    return !!session.running;
  }

  /** Run one request. Never throws: the UI gets { ok, data } or { ok:false, error, cancelled, report }. */
  async function handle(channel, arg) {
    const fn = handlers[channel];
    if (!fn) return { ok: false, error: `Unknown request "${channel}".` };
    try { return { ok: true, data: await fn(arg || {}) }; } catch (err) {
      return { ok: false, error: err.message, cancelled: !!err.cancelled, report: err.report || null, code: err.code || null };
    }
  }

  return { handle, cancel, session, channels: Object.keys(handlers), isLoginExpired };
}

module.exports = { createHost, isLoginExpired, SETTINGS_ALLOWED };
