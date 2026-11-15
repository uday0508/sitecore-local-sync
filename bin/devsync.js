#!/usr/bin/env node
'use strict';

/*
 * Headless DevSync: same engine as the desktop app, for scripts and onboarding.
 *
 *   devsync endpoints                        list endpoints from .sitecore/user.json
 *   devsync profiles                         list saved profiles
 *   devsync plan  --profile "Homepage"       show what would be pulled
 *   devsync run   --profile "Homepage"       pull from cloud and push to local
 *        [--delta] [--dry-run] [--on-conflict replace|skip] [--project <dir>]
 *
 * Auth: set DEVSYNC_CLIENT_ID and DEVSYNC_CLIENT_SECRET (environment automation client),
 * or leave them unset to reuse your "dotnet sitecore cloud login" session.
 */
const path = require('path');
const { loadProject } = require('../src/core/project');
const { listProfiles } = require('../src/core/profiles');
const { createSourceClient, createLocalClient, planSync, executeSync } = require('../src/core/sync');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0] || 'help';
  const project = loadProject(path.resolve(a.project || process.cwd()));

  if (cmd === 'endpoints') {
    for (const e of project.endpoints) console.log(`${e.isLocal ? 'local ' : 'cloud '} ${e.name.padEnd(20)} ${e.host}`);
    return;
  }
  if (cmd === 'profiles') {
    for (const p of listProfiles(project.root)) console.log(`${p.name}  (${p.source} -> ${p.target}, ${p.selections.length} selection(s))`);
    return;
  }
  if (cmd === 'plan' || cmd === 'run') {
    const profile = listProfiles(project.root).find((p) => p.name.toLowerCase() === String(a.profile || '').toLowerCase());
    if (!profile) throw new Error(`Profile "${a.profile}" not found. Save one from the desktop app first, or run "devsync profiles".`);
    const auth = process.env.DEVSYNC_CLIENT_ID
      ? { mode: 'automation', clientId: process.env.DEVSYNC_CLIENT_ID, clientSecret: process.env.DEVSYNC_CLIENT_SECRET }
      : { mode: 'cli' };
    const log = (m) => console.log(`  ${m}`);
    const client = createSourceClient(project, profile.source, auth, { log });
    const planned = await planSync(client, profile, { mode: a.delta ? 'delta' : 'full', projectRoot: project.root, log, localClient: createLocalClient(project, profile.target) });
    console.log(`\nPlan: ${planned.plan.includes.length} include(s)`);
    for (const i of planned.plan.includes) console.log(`  [${i.kind.padEnd(9)}] ${i.scope.padEnd(18)} ${i.allowedPushOperations.padEnd(21)} ${i.path}`);
    if (cmd === 'plan') return;
    await executeSync(project, profile, planned, {
      client,
      // Node needs the local dev root certificate: set NODE_EXTRA_CA_CERTS to "$(mkcert -CAROOT)/rootCA.pem".
      localClient: createLocalClient(project, profile.target),
      onConflict: a['on-conflict'],
      skipPush: !!a['dry-run'],
      onEvent: (e) => {
        if (e.type === 'log') console.log(e.level === 'cmd' ? `\n${e.message}` : `  ${e.message}`);
        if (e.type === 'step') console.log(`[${e.id}] ${e.status}${e.detail ? `: ${e.detail}` : ''}`);
      },
    });
    console.log('\nDone.');
    return;
  }
  console.log('Usage: devsync <endpoints|profiles|plan|run> [--profile <name>] [--delta] [--dry-run] [--on-conflict replace|skip] [--project <dir>]');
}

main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
