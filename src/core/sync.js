'use strict';

const fs = require('fs');
const path = require('path');
const { AuthoringClient } = require('./graphql');
const { automationClientProvider, cliSessionProvider } = require('./auth');
const { resolveEndpoint, isLoginEndpoint, getEndpoint, isLocalHost, readJson } = require('./project');
const { isFresh } = require('./auth');
const { discoverDependencies, DEFAULT_DEP_OPTIONS } = require('./dependencies');
const { findChangedItems } = require('./delta');
const { buildPlan, toModuleJson } = require('./plan');
const { maskDirectory, DEFAULT_MASK_OPTIONS } = require('./mask');
const { prepareWorkspace, assertSafeTargets, runCli, syncTokensBack, pushTokensInto, countYaml } = require('./workspace');
const { explainCliFailure } = require('./cliErrors');
const { normPath } = require('./util');
const {
  readTree, findConflicts, collisionsFromOutput, conflictFromCollision, backupConflicts,
  batchParents, cleanupModule, skipInWorkspace, ignorePathInModule, parentPath,
} = require('./conflicts');
const { getLastSync, setLastSync } = require('./profiles');
const { ensureTemplates, missingTemplatesFromOutput, writeDefinitionPaths } = require('./closure');

/** Build a read-only Authoring API client for the source (cloud) endpoint. */
function createSourceClient(project, sourceName, auth = {}, { fetchImpl = fetch, log } = {}) {
  const ep = resolveEndpoint(project.userJson, sourceName);
  if (!ep || !ep.host) throw new Error(`Endpoint "${sourceName}" has no host in .sitecore/user.json.`);
  if (isLoginEndpoint(ep.name, getEndpoint(project.userJson, sourceName))) {
    throw new Error(`"${sourceName}" is your Sitecore Cloud login (${ep.host}), not an environment. Use "Add cloud environment" to connect one.`);
  }
  const tokenProvider = auth.mode === 'automation'
    ? automationClientProvider({ clientId: auth.clientId, clientSecret: auth.clientSecret, fetchImpl })
    : cliSessionProvider({ endpoint: ep, fetchImpl });
  return new AuthoringClient({ host: ep.host, tokenProvider, fetchImpl, log });
}

/**
 * Read/write Authoring API client for the LOCAL CM (target endpoint), used to check paths and
 * to move conflicting local items to the Recycle Bin by ID. It reuses the Sitecore CLI login
 * from .sitecore/user.json (the local endpoint refs the cloud login). If it has to refresh
 * the token, the rotated tokens are written back so the CLI keeps working.
 * Pass fetchImpl = electron net.fetch in the desktop app, so the local dev certificate is trusted.
 */
function createLocalClient(project, targetName, { fetchImpl = fetch, log } = {}) {
  const ep = resolveEndpoint(project.userJson, targetName);
  if (!ep || !ep.host || !isLocalHost(ep.host)) return null;
  const tokenProvider = {
    async getToken(force = false) {
      const fresh = resolveEndpoint(readJson(project.userJsonPath), targetName) || {};
      if (!force && fresh.accessToken && isFresh(fresh.accessToken)) return fresh.accessToken;
      if (fresh.refreshToken && fresh.clientId) {
        const res = await fetch(`${String(fresh.authority || 'https://auth.sitecorecloud.io').replace(/\/+$/, '')}/oauth/token`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: fresh.clientId, refresh_token: fresh.refreshToken }).toString(),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.access_token) throw new Error('Your Sitecore login has expired. Run "dotnet sitecore cloud login" in the project folder.');
        const uj = readJson(project.userJsonPath);
        const holder = fresh.tokenSource && Object.keys(uj.endpoints || {}).find((k) => k.toLowerCase() === fresh.tokenSource.toLowerCase());
        if (holder) {
          uj.endpoints[holder].accessToken = json.access_token;
          if (json.refresh_token) uj.endpoints[holder].refreshToken = json.refresh_token;
          fs.writeFileSync(project.userJsonPath, JSON.stringify(uj, null, 2));
        }
        return json.access_token;
      }
      if (fresh.accessToken) return fresh.accessToken;
      throw new Error('No Sitecore login found for the local CM. Run "dotnet sitecore cloud login".');
    },
  };
  return new AuthoringClient({ host: ep.host, tokenProvider, fetchImpl, log, allowWrite: true });
}

/**
 * Work out what to pull. mode = "full" | "delta".
 * Returns everything the UI needs to show a preview before anything runs.
 */
// Folders that ship inside every SitecoreAI CM image. Used only when the local API can't be reached.
const SHIPPED = [
  /^\/sitecore\/templates\/system(\/|$)/i,
  /\/(experience accelerator|jss experience accelerator|headless experience accelerator|javascript services)(\/|$)/i,
  /^\/sitecore\/templates\/sample(\/|$)/i,
  /^\/sitecore\/layout\/(devices|simulators|layouts\/system)(\/|$)/i,
];
const isShipped = (p) => SHIPPED.some((re) => re.test(p));

/**
 * Drop definitions (templates, renderings) and parent folders that the local CM already has with
 * the SAME ID: Sitecore's own items ship in both images, and repo-serialized ones are already
 * pushed. Pulling them would only cost time. Content is never dropped here.
 */
async function pruneAlreadyLocal(client, localClient, plan, log) {
  const candidates = plan.includes.filter((i) => ['template', 'layout', 'ancestor'].includes(i.kind));
  if (!candidates.length) return { dropped: [] };
  let same = new Set();
  if (localClient) {
    try {
      const paths = candidates.map((i) => i.path);
      const [cloud, local] = await Promise.all([client.resolvePaths(paths), localClient.resolvePaths(paths)]);
      for (const p of paths) {
        const c = cloud.get(p), l = local.get(p);
        if (c && l && c.id === l.id) same.add(p);
      }
    } catch (e) {
      log(`Local CM not reachable for the "already on your machine" check (${e.message}). Using the list of Sitecore product folders instead.`);
      same = new Set(candidates.filter((i) => isShipped(i.path)).map((i) => i.path));
    }
  } else {
    same = new Set(candidates.filter((i) => isShipped(i.path)).map((i) => i.path));
  }
  const dropped = plan.includes.filter((i) => same.has(i.path));
  plan.includes = plan.includes.filter((i) => !same.has(i.path));
  plan.summary = { total: plan.includes.length };
  for (const i of plan.includes) plan.summary[i.kind] = (plan.summary[i.kind] || 0) + 1;
  return { dropped };
}

async function planSync(client, profile, { mode = 'full', projectRoot, since, log = () => {}, localClient = null } = {}) {
  if (!profile.selections || !profile.selections.length) throw new Error('Select at least one item to sync.');
  // Everything a page needs is always brought. Older profiles may still carry switches that
  // turned some of it off; those are ignored, because a partial set can't be pushed.
  const depOpts = { ...DEFAULT_DEP_OPTIONS, ...(profile.dependencies || {}), templates: true, renderings: true, datasources: true, media: true, projectOnly: false, languages: [profile.language || 'en'] };

  let changed = null;
  let scanSet = profile.selections;
  let sinceUsed = null;
  if (mode === 'delta') {
    sinceUsed = since || (projectRoot && getLastSync(projectRoot, profile.name));
    if (!sinceUsed) throw new Error('No previous sync recorded for this profile. Run a full sync first.');
    log(`Looking for items changed since ${sinceUsed}`);
    changed = await findChangedItems(client, profile.selections, sinceUsed, { log });
    log(`${changed.length} changed item(s) found`);
    scanSet = changed.map((c) => ({ id: c.id, path: c.path, scope: 'SingleItem' }));
  }

  let deps = { dependencies: [], skipped: [], scanned: 0 };
  const anyDeps = depOpts.media || depOpts.datasources || depOpts.templates || depOpts.renderings;
  if (anyDeps && scanSet.length) {
    log('Discovering dependencies (datasources, media, ...)');
    // Delta runs scan only the changed items themselves.
    deps = await discoverDependencies(client, scanSet, mode === 'delta' ? { ...depOpts, deepScan: false } : depOpts, log);
    log(`Scanned ${deps.scanned} item version(s): ${deps.dependencies.length} dependencies to add, ${deps.skipped.length} skipped`);
  }

  const plan = buildPlan({
    selections: profile.selections,
    dependencies: deps.dependencies,
    changed,
    pushMode: profile.pushMode,
    includeAncestors: profile.includeAncestors !== false,
    overwriteDefinitions: !!(profile.dependencies && profile.dependencies.overwriteDefinitions),
  });
  const { dropped } = await pruneAlreadyLocal(client, localClient, plan, log);
  if (dropped.length) log(`${dropped.length} template(s), rendering(s) and folder(s) are already on your machine with the same ID (Sitecore defaults or your serialized items). Not pulling them.`);
  const alreadyLocal = new Set(dropped.map((d) => d.path.toLowerCase()));
  return {
    mode, since: sinceUsed, plan, moduleJson: toModuleJson(plan), changed,
    dependencies: deps.dependencies.filter((d) => !alreadyLocal.has(d.path.toLowerCase())),
    skipped: [...deps.skipped, ...dropped.map((d) => ({ path: d.path, category: d.kind, why: 'already on your machine' }))],
    alreadyLocal: dropped.length,
  };
}

/**
 * Run the plan:
 *   pull (cloud) -> complete templates -> mask -> check against local -> resolve conflicts -> push (local)
 * Self-repairs during the push: missing templates are fetched, and path/ID conflicts the
 * check could not see are resolved, then the push is retried.
 *
 * Options:
 *   client        read-only Authoring API client (enables template completion and repair)
 *   onConflict    'ask' | 'replace' | 'skip' (falls back to profile.onConflict, then 'ask')
 *   onConflicts   async (conflicts) => ({ decision: 'replace'|'skip'|'cancel', remember })
 *   skipPush      dry run: pull, mask and check only. Nothing changes locally.
 *   skipPreflight don't snapshot the local CM before pushing (conflicts are then handled at push time)
 */
async function executeSync(project, profile, planned, {
  onEvent = () => {}, signal, dotnet, skipPush = false, allowRemoteTarget = false, client = null,
  onConflict, onConflicts, skipPreflight = false, maxRepairs = 25, localClient = null,
} = {}) {
  const emit = (e) => onEvent({ at: new Date().toISOString(), ...e });
  const log = (message, level = 'info') => emit({ type: 'log', message, level });
  const step = (id, status, detail) => emit({ type: 'step', id, status, detail });
  const startedAt = new Date().toISOString();
  const warnings = [];
  const warn = (m) => { warnings.push(m); log(m, 'warn'); };

  if (!planned.plan.includes.length) { log('Nothing to sync: the plan is empty.'); emit({ type: 'done', pulled: 0 }); return { pulled: 0, conflicts: [], warnings }; }
  assertSafeTargets(project, profile.source, profile.target, { allowRemoteTarget });

  step('prepare', 'running');
  const ws = prepareWorkspace(project, planned.moduleJson, { sourceName: profile.source });
  const modulePath = path.join(ws.dir, 'DevSync.module.json');
  writeDefinitionPaths(modulePath, (planned.dependencies || []).filter((d) => d.category === 'template').map((d) => d.path));
  step('prepare', 'done', ws.dir);

  // Every CLI run goes through here: fresh tokens in, refreshed tokens out, output kept for diagnosis.
  let recent = [];
  const cliLine = (line, kind) => {
    recent.push(line);
    if (recent.length > 600) recent = recent.slice(-300);
    log(line, kind === 'err' ? 'warn' : kind === 'cmd' ? 'cmd' : 'info');
  };
  const run = async (w, args) => {
    pushTokensInto(project, w);
    recent = [];
    try { await runCli(args, { cwd: w.dir, dotnet, onLine: cliLine, signal }); }
    finally { try { syncTokensBack(project, w); } catch { /* best effort */ } }
  };
  const explain = (e, stage) => {
    const hint = explainCliFailure(recent, stage);
    if (hint && !e.hint) { e.hint = hint; e.message = `${hint} (${e.message})`; }
    return e;
  };

  // Conflict decisions: one answer per run, unless a policy is set.
  let policy = onConflict || profile.onConflict || 'ask';
  const handled = new Set();
  const keyOf = (c) => `${normPath(c.path)}|${c.localId}`;
  const decide = async (conflicts) => {
    if (policy === 'replace' || policy === 'skip') return policy;
    if (!onConflicts) {
      const list = conflicts.map((c) => `  ${c.path} (local ${c.localId}, cloud ${c.cloudId})`).join('\n');
      throw new Error(`Local items have the same path as cloud items but different IDs:\n${list}\nChoose how to handle them (replace or skip) and sync again.`);
    }
    step('check', 'waiting', `${conflicts.length} conflict(s): waiting for your choice`);
    const answer = await onConflicts(conflicts);
    const decision = answer && answer.decision;
    if (decision !== 'replace' && decision !== 'skip') throw new Error('Cancelled. Nothing was pushed to the local CM.');
    policy = decision; // asked once per run; "remember" also stores it on the profile
    return decision;
  };

  // Is the local Authoring API usable? (checked once; falls back to SCS-only handling)
  let localApi = null;
  const getLocalApi = async () => {
    if (localApi !== null) return localApi || null;
    localApi = false;
    if (!localClient) return null;
    try { await localClient.resolvePaths(['/sitecore/content']); localApi = localClient; }
    catch (e) { warn(`Could not use the local CM's Authoring API (${e.message}). Falling back to serialization-only checks.`); }
    return localApi || null;
  };

  const duplicateHelp = (conflicts) => `Your local CM has duplicate item names at: ${conflicts.map((c) => `${c.path} (local ID ${c.localId})`).join('; ')}. Delete the local item(s) with those IDs in the local Content Editor, then sync again. (DevSync couldn't reach the local Authoring API to do it for you. In the desktop app it uses your CLI login; check that https://xmcloudcm.localhost opens without a certificate warning.)`;

  const resolve = async (conflicts, decision) => {
    conflicts.forEach((c) => handled.add(keyOf(c)));
    if (decision === 'skip') {
      const r = skipInWorkspace(ws, conflicts);
      warn(`Skipped ${conflicts.length} conflicting path(s) (${r.removedFiles} cloud item(s) not pushed). Your local versions were kept: ${conflicts.map((c) => c.path).join(', ')}`);
      return;
    }
    // Replace. Back up the local subtrees first (best effort: duplicates can make SCS refuse).
    const api = await getLocalApi();
    try {
      const snapMod = { namespace: 'DevSync', items: { includes: conflicts.map((c, i) => ({ name: `b${String(i).padStart(3, '0')}`, path: c.path, scope: 'ItemAndDescendants', allowedPushOperations: 'CreateOnly' })) } };
      const bws = prepareWorkspace(project, snapMod, { sourceName: profile.target, dirName: 'backup-snapshot' });
      await run(bws, ['sitecore', 'ser', 'pull', '-n', profile.target]);
      const backup = backupConflicts(project.root, conflicts, readTree(bws.itemsDir));
      log(`Backed up ${backup.files} local item(s) to ${backup.dir}`);
    } catch (e) {
      if (!api) {
        if (collisionsFromOutput(recent).length) { e.message = duplicateHelp(conflicts); throw e; }
        throw explain(e, 'snapshot');
      }
      warn(`File backup skipped (${e.hint || 'serialization refused these paths'}). Removed local items go to the local Recycle Bin, so you can restore them from there.`);
    }
    if (api) {
      // Precise: remove exactly the conflicting local item by ID, even when names are duplicated.
      for (const c of conflicts) {
        await api.deleteItem(c.localId);
        log(`Moved local ${c.path} (${c.localId}) and its children to the local Recycle Bin.`);
      }
      return;
    }
    // Serialization-only fallback: push each parent with the conflicting child left out.
    const original = new Map(conflicts.map((c) => [normPath(parentPath(c.path)), parentPath(c.path)]));
    const localIds = new Set(conflicts.map((c) => c.localId));
    const batches = batchParents(conflicts.map((c) => parentPath(c.path)));
    for (let i = 0; i < batches.length; i++) {
      const cws = prepareWorkspace(project, cleanupModule(batches[i], original), { sourceName: profile.target, dirName: `cleanup-${i}` });
      try {
        await run(cws, ['sitecore', 'ser', 'pull', '-n', profile.target]);
        let removed = 0;
        for (const rec of readTree(cws.itemsDir).byPath.values()) if (localIds.has(rec.id)) { fs.rmSync(rec.file, { force: true }); removed++; }
        if (removed) await run(cws, ['sitecore', 'ser', 'push', '-n', profile.target]);
      } catch (e) {
        if (collisionsFromOutput(recent).length) { e.message = duplicateHelp(conflicts); throw e; }
        throw explain(e, 'cleanup');
      }
    }
    log(`Removed ${conflicts.length} conflicting local item(s) so the cloud versions can be pushed.`);
  };

  const wantTemplates = !!client;
  const closure = (forceIds = []) => ensureTemplates({ project, profile, client, ws, run, log: (m, l) => log(m, l), forceIds, localClient: localApi || null, isShipped });
  let conflictsFound = [];
  let decisionTaken = null;

  try {
    // 1. Pull from the cloud. Duplicate sibling names in the cloud are excluded and reported.
    step('pull', 'running', profile.source);
    for (let attempt = 0; ; attempt++) {
      try { await run(ws, ['sitecore', 'ser', 'pull', '-n', profile.source]); break; } catch (e) {
        const cols = collisionsFromOutput(recent);
        if (!cols.length || attempt >= 5) throw explain(e, 'pull');
        for (const c of cols) {
          ignorePathInModule(modulePath, c.path);
          warn(`The cloud has two items at ${c.path} (${c.ids.join(', ')}). SCS can't serialize duplicate names, so this path is skipped. Rename one of them in the cloud to sync it.`);
        }
        fs.rmSync(ws.itemsDir, { recursive: true, force: true });
      }
    }
    // 2. Every pulled item's template (and base templates) must be there, whatever the scan limits.
    if (wantTemplates) {
      step('pull', 'running', 'checking templates of every pulled item');
      await getLocalApi();
      const added = await closure();
      if (added) log(`Added ${added} template include(s) found by checking every pulled item.`);
    }
    let pulled = countYaml(ws.itemsDir);
    step('pull', 'done', `${pulled} item file(s)`);

    // 3. Mask personal data before anything reaches the local CM.
    const maskOpts = { ...DEFAULT_MASK_OPTIONS, ...(profile.mask || {}) };
    if (maskOpts.enabled) {
      step('mask', 'running');
      const r = maskDirectory(ws.itemsDir, maskOpts);
      step('mask', 'done', `${r.changes} value(s) masked in ${r.files} file(s)`);
    } else step('mask', 'skipped');

    // 4. Check: does the local CM have items at the same paths with different IDs?
    if (!skipPreflight) {
      step('check', 'running', 'comparing with your local CM');
      const cloudTree = readTree(ws.itemsDir);
      const api = await getLocalApi();
      let localTree = null;
      if (api) {
        const paths = [...cloudTree.byPath.values()].map((r) => r.path);
        const found = await api.resolvePaths(paths);
        localTree = { byPath: new Map() };
        for (const [p, it] of found) if (it) localTree.byPath.set(normPath(p), { id: it.id, path: p });
      } else {
        const currentModule = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
        const snap = prepareWorkspace(project, currentModule, { sourceName: profile.target, dirName: 'local-snapshot' });
        try { await run(snap, ['sitecore', 'ser', 'pull', '-n', profile.target]); localTree = readTree(snap.itemsDir); } catch (e) {
          if (!collisionsFromOutput(recent).length) throw explain(e, 'snapshot');
          warn('The local CM has duplicate item names under the selected paths, so the pre-check was skipped. Conflicts will be handled during the push.');
        }
      }
      if (localTree) {
        conflictsFound = findConflicts(cloudTree, localTree);
        if (conflictsFound.length) {
          log(`${conflictsFound.length} local item(s) have the same path as a cloud item but a different ID.`, 'warn');
          for (const c of conflictsFound) log(`  ${c.path}: local ${c.localId}, cloud ${c.cloudId}`, 'warn');
        }
      }
      if (conflictsFound.length && !skipPush) {
        decisionTaken = await decide(conflictsFound);
        await resolve(conflictsFound, decisionTaken);
        step('check', 'done', `${conflictsFound.length} conflict(s): ${decisionTaken === 'replace' ? 'replaced local' : 'kept local'}`);
      } else step('check', 'done', conflictsFound.length ? `${conflictsFound.length} conflict(s) found` : 'no conflicts');
    } else step('check', 'skipped');

    // 5. Push to the local CM, repairing what the CM reports.
    if (skipPush) {
      step('push', 'skipped', 'dry run: nothing changed locally');
      if (conflictsFound.length) warn(`Dry run: ${conflictsFound.length} conflict(s) would need a decision (replace or skip) on a real sync.`);
    } else {
      step('push', 'running', profile.target);
      for (let attempt = 0; ; attempt++) {
        try { await run(ws, ['sitecore', 'ser', 'push', '-n', profile.target]); break; } catch (e) {
          if (attempt >= maxRepairs) throw explain(e, 'push');
          const ids = missingTemplatesFromOutput(recent);
          const cols = collisionsFromOutput(recent);
          if (ids.length && client) {
            log(`Local CM is missing template(s) ${ids.join(', ')}. Pulling them and retrying.`, 'warn');
            step('push', 'running', 'adding missing templates');
            const added = await closure(ids);
            if (!added) { e.message = `Local CM is missing template(s) ${ids.join(', ')}, and they could not be found in the cloud. ${e.message}`; throw e; }
          } else if (cols.length) {
            const cloudTree = readTree(ws.itemsDir);
            const fresh = cols.map((c) => conflictFromCollision(c, cloudTree))
              .filter((c) => c.cloudId !== c.localId && !handled.has(keyOf(c)));
            if (!fresh.length) throw explain(e, 'push');
            log(`Push found ${fresh.length} more conflict(s): ${fresh.map((c) => c.path).join(', ')}`, 'warn');
            const decision = await decide(fresh);
            decisionTaken = decisionTaken || decision;
            conflictsFound.push(...fresh);
            step('push', 'running', 'resolving conflicts');
            await resolve(fresh, decision);
          } else {
            if (ids.length) e.message = `Local CM is missing template(s) ${ids.join(', ')}. ${e.message}`;
            throw explain(e, 'push');
          }
          pulled = countYaml(ws.itemsDir);
          step('push', 'running', `retrying (${attempt + 1})`);
        }
      }
      step('push', 'done');
    }

    if (!skipPush) setLastSync(project.root, profile.name || 'adhoc', startedAt, { includes: planned.plan.includes.length, items: pulled, mode: planned.mode });
    writeRunReport(ws, planned, pulled, { conflicts: conflictsFound, decision: decisionTaken, warnings });
    emit({ type: 'done', pulled, conflicts: conflictsFound.length, warnings });
    return { pulled, workspace: ws.dir, conflicts: conflictsFound, decision: decisionTaken, warnings };
  } catch (e) {
    emit({ type: 'error', message: e.message });
    throw e;
  }
}

function writeRunReport(ws, planned, pulled, extra = {}) {
  const report = {
    at: new Date().toISOString(), mode: planned.mode, since: planned.since, pulledFiles: pulled,
    includes: planned.plan.includes, skippedDependencies: planned.skipped, ...extra,
  };
  fs.writeFileSync(path.join(ws.base, 'last-run.json'), JSON.stringify(report, null, 2));
}

module.exports = { createSourceClient, createLocalClient, planSync, executeSync, isShipped };
