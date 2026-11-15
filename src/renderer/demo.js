'use strict';

/*
 * Demo mode: when the page runs without the Electron preload (window.devsync is missing),
 * install a mock API with a realistic SitecoreAI content tree. Good for sales demos and
 * UI work. It never touches a real environment.
 */
(function () {
  if (window.devsync) return;

  let n = 0;
  const id = () => (++n).toString(16).padStart(32, '0');
  const T = (name, template, children = [], extra = {}) => ({ id: id(), name, template, children, updated: '20251101T090000Z', ...extra });

  const tree = T('sitecore', 'Root', [
    T('content', 'Main section', [
      T('Acme', 'Headless Tenant', [
        T('Acme Global', 'Headless Site', [
          T('Home', 'Page', [
            T('Data', 'Page Data', [T('Hero Banner', 'Hero', [], { updated: '20251113T101500Z' }), T('Text 1', 'Text')]),
            T('Products', 'Page', [T('SitecoreAI Suite', 'Product Page', [], { updated: '20251112T080000Z' }), T('Personalize', 'Product Page'), T('Content Hub', 'Product Page')]),
            T('About Us', 'Page'),
            T('Contact', 'Page', [], { updated: '20251113T150000Z' }),
          ]),
          T('Data', 'Data Folder', [T('Promos', 'Folder', [T('Spring Promo', 'Promo'), T('Webinar Promo', 'Promo')])]),
          T('Media', 'Virtual Media Folder'),
          T('Settings', 'Settings'),
          T('Dictionary', 'Dictionary'),
          T('Presentation', 'Presentation'),
        ]),
        T('Acme India', 'Headless Site', [T('Home', 'Page', [T('Data', 'Page Data')])]),
      ]),
    ]),
    T('media library', 'Media library', [T('Project', 'Media folder', [T('Acme', 'Media folder', [T('hero-banner', 'Jpeg'), T('logo', 'Image'), T('brochure', 'Pdf')])])]),
    T('templates', 'Folder', [T('Project', 'Template Folder', [T('Acme', 'Template Folder', [T('Page', 'Template'), T('Hero', 'Template'), T('Promo', 'Template')])])]),
    T('layout', 'Layout', [T('Renderings', 'Folder', [T('Project', 'Folder', [T('Acme', 'Folder', [T('Hero', 'Json Rendering'), T('Promo', 'Json Rendering')])])])]),
    T('system', 'Main section'),
  ]);

  const byId = new Map();
  const byPath = new Map();
  (function index(node, parentPath) {
    node.path = parentPath ? `${parentPath}/${node.name}` : '/sitecore';
    byId.set(node.id, node); byPath.set(node.path.toLowerCase(), node);
    node.children.forEach((c) => index(c, node.path));
  })(tree, '');
  const shape = (x, kids) => ({ id: x.id, name: x.name, path: x.path, template: x.template, hasChildren: x.children.length > 0, updated: x.updated, ...(kids ? { children: x.children.map((c) => shape(c, false)) } : {}) });

  let listener = () => {};
  const emit = (e) => listener({ at: new Date().toISOString(), ...e });
  const okr = (data) => Promise.resolve({ ok: true, data });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const profiles = [];
  let lastSync = {};

  const project = () => ({
    root: 'C:\\Projects\\acme-sitecoreai',
    hasUserJson: true, hasToolManifest: true,
    endpoints: [
      { name: 'xmCloud', host: 'https://xmclouddeploy-api.sitecorecloud.io/', isLocal: false, kind: 'login' },
      { name: 'prod', host: 'https://xmc-acme-prod.sitecorecloud.io', isLocal: false, kind: 'cloud' },
      { name: 'uat', host: 'https://xmc-acme-uat.sitecorecloud.io', isLocal: false, kind: 'cloud' },
      { name: 'local', host: 'https://xmcloudcm.localhost', isLocal: true, kind: 'local' },
    ],
    profiles: profiles.map((p) => ({ ...p, lastSyncAt: lastSync[p.name] || null })),
  });

  function ancestors(path) {
    const parts = path.split('/'); const out = [];
    for (let i = 4; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
    return out;
  }

  function plan(profile, mode) {
    profile = { ...profile, dependencies: { templates: true, renderings: true, datasources: true, media: true } };
    const inc = [];
    const add = (path, scope, ops, kind, reason) => { if (!inc.some((i) => i.path.toLowerCase() === path.toLowerCase())) inc.push({ path, scope, allowedPushOperations: ops, kind, reason }); };
    const deps = [];
    if (profile.dependencies.templates) deps.push(['/sitecore/templates/Project/Acme/Page', 'template'], ['/sitecore/templates/Project/Acme/Hero', 'template'], ['/sitecore/templates/Project/Acme/Promo', 'template']);
    if (profile.dependencies.renderings) deps.push(['/sitecore/layout/Renderings/Project/Acme/Hero', 'layout'], ['/sitecore/layout/Renderings/Project/Acme/Promo', 'layout']);
    if (profile.dependencies.media) deps.push(['/sitecore/media library/Project/Acme/hero-banner', 'media'], ['/sitecore/media library/Project/Acme/logo', 'media']);
    if (profile.dependencies.datasources) deps.push(['/sitecore/content/Acme/Acme Global/Data/Promos/Spring Promo', 'content']);
    let changed = null;
    let selections = profile.selections;
    if (mode === 'delta') {
      changed = [...byId.values()].filter((x) => x.updated > '20251110' && profile.selections.some((s) => x.path.toLowerCase().startsWith(s.path.toLowerCase())));
      selections = changed.map((c) => ({ path: c.path, scope: 'SingleItem' }));
    }
    const all = [...selections.map((s) => [s.path, changed ? 'changed' : 'selection', s.scope]), ...deps.map(([p, k]) => [p, k, 'SingleItem'])];
    for (const [p] of all) if (profile.includeAncestors) ancestors(p).forEach((a) => add(a, 'SingleItem', 'CreateOnly', 'ancestor', `parent of ${p}`));
    for (const [p, k, scope] of all) {
      const def = k === 'template' || k === 'layout';
      add(p, k === 'template' ? 'ItemAndDescendants' : (scope || 'SingleItem'),
        def ? (profile.dependencies.overwriteDefinitions ? 'CreateAndUpdate' : 'CreateOnly') : k === 'selection' && profile.pushMode === 'mirror' ? 'CreateUpdateAndDelete' : 'CreateAndUpdate', k, k);
    }
    const rank = (p) => (/\/templates/i.test(p) ? 0 : /\/layout/i.test(p) ? 1 : /media library/i.test(p) ? 2 : 3);
    inc.sort((a, b) => rank(a.path) - rank(b.path) || a.path.split('/').length - b.path.split('/').length);
    inc.forEach((i, k) => { i.name = `${String(k + 1).padStart(3, '0')}-${i.path.split('/').pop().replace(/\W+/g, '-')}`; });
    const summary = { total: inc.length };
    inc.forEach((i) => { summary[i.kind] = (summary[i.kind] || 0) + 1; });
    const skipped = [{ path: '/sitecore/templates/System/Templates/Standard template', category: 'template', why: 'built into every CM' }];
    return {
      mode, since: mode === 'delta' ? lastSync[profile.name] : null, changed, skipped,
      plan: { includes: inc, summary }, alreadyLocal: 9,
      moduleJson: { namespace: 'DevSync', items: { includes: inc.map(({ name, path, scope, allowedPushOperations }) => ({ name, path, scope, allowedPushOperations })) } },
    };
  }

  let current = null;
  let conflictListener = () => {};
  let conflictResolve = null;
  let conflictShown = false;
  let demoSettings = { lastSource: 'prod', lastTarget: 'local', authMode: 'cli' };
  window.devsync = {
    lastProject: () => okr(project()),
    getSettings: () => okr(demoSettings),
    setSettings: (patch) => { demoSettings = { ...demoSettings, ...patch }; return okr(demoSettings); },
    pickProject: () => okr(project()),
    openProject: () => okr(project()),
    reloadProject: () => okr(project()),
    getCreds: () => okr(null),
    cloudProjects: async () => { await wait(300); return okr([{ id: 'p1', name: 'Acme' }]); },
    cloudEnvironments: async () => { await wait(300); return okr([{ id: 'e1', name: 'prod', host: 'xmc-acme-prod.sitecorecloud.io', isProd: true }, { id: 'e2', name: 'uat', host: 'xmc-acme-uat.sitecorecloud.io' }]); },
    connectEnvironment: () => okr(project()),
    connect: async () => { await wait(500); return { ok: true, data: { sites: [{ name: 'Acme Global', rootPath: '/sitecore/content/Acme/Acme Global' }, { name: 'Acme India', rootPath: '/sitecore/content/Acme/Acme India' }], endpoint: 'demo' } }; },
    children: async ({ id: i, path }) => { await wait(120); const x = i ? byId.get(i) : byPath.get(String(path).toLowerCase()); return okr(x ? shape(x, true) : null); },
    saveProfile: ({ profile }) => { const k = profiles.findIndex((p) => p.name === profile.name); if (k >= 0) profiles[k] = profile; else profiles.push(profile); return okr(project()); },
    deleteProfile: ({ name }) => { const k = profiles.findIndex((p) => p.name === name); if (k >= 0) profiles.splice(k, 1); return okr(project()); },
    plan: async ({ profile, mode }) => {
      if (mode === 'delta' && !lastSync[profile.name]) return { ok: false, error: 'No previous sync recorded for this profile. Run a full sync first.' };
      emit({ type: 'log', level: 'info', message: 'Discovering dependencies (datasources, media, ...)' });
      await wait(500);
      current = plan(profile, mode);
      emit({ type: 'log', level: 'info', message: `Plan ready: ${current.plan.includes.length} include(s)` });
      return okr(current);
    },
    run: async ({ profile, dryRun }) => {
      const step = (s, status, detail) => emit({ type: 'step', id: s, status, detail });
      step('prepare', 'running'); await wait(200); step('prepare', 'done', '.devsync/workspace');
      step('pull', 'running', profile.source);
      emit({ type: 'log', level: 'cmd', message: `> dotnet sitecore ser pull -n ${profile.source}` });
      for (const i of current.plan.includes) { await wait(90); emit({ type: 'log', level: 'info', message: `[master] Serialized ${i.path}` }); }
      const files = current.plan.includes.reduce((a, i) => a + (i.scope === 'SingleItem' ? 1 : 6), 0);
      step('pull', 'done', `${files} item file(s)`);
      if (profile.mask.enabled) { step('mask', 'running'); await wait(300); step('mask', 'done', '4 value(s) masked in 3 file(s)'); } else step('mask', 'skipped');
      step('check', 'running', 'comparing with your local CM');
      emit({ type: 'log', level: 'cmd', message: `> dotnet sitecore ser pull -n ${profile.target}` });
      await wait(300);
      let conflicts = [];
      if (!conflictShown && !dryRun) {
        conflictShown = true;
        conflicts = [{ path: '/sitecore/content/Acme/Acme Global/Home/Data', kind: 'content', localId: '1d6b613eab204e3593ba36035851233c', cloudId: '4051b852676b4ac48da02acc2f807a07', localItems: 3 }];
        emit({ type: 'log', level: 'warn', message: '1 local item(s) have the same path as a cloud item but a different ID.' });
        step('check', 'waiting', '1 conflict(s): waiting for your choice');
        const answer = profile.onConflict !== 'ask' && profile.onConflict ? { decision: profile.onConflict } : await new Promise((r) => { conflictResolve = r; conflictListener(conflicts); });
        if (answer.decision === 'cancel') { emit({ type: 'error', message: 'Cancelled. Nothing was pushed to the local CM.' }); return { ok: false, error: 'Cancelled. Nothing was pushed to the local CM.' }; }
        emit({ type: 'log', level: 'info', message: answer.decision === 'replace' ? 'Backed up 3 local item(s) to .devsync/backups/…' : 'Skipped 1 conflicting path(s). Your local versions were kept.' });
        step('check', 'done', `1 conflict(s): ${answer.decision === 'replace' ? 'replaced local' : 'kept local'}`);
        current.decision = answer.decision;
      } else step('check', 'done', 'no conflicts');
      if (dryRun) step('push', 'skipped', 'dry run: items left in .devsync/workspace/items');
      else {
        step('push', 'running', profile.target);
        emit({ type: 'log', level: 'cmd', message: `> dotnet sitecore ser push -n ${profile.target}` });
        for (const i of current.plan.includes) { await wait(70); emit({ type: 'log', level: 'info', message: `[master] ${i.allowedPushOperations === 'CreateOnly' ? 'Exists' : 'Updated'} ${i.path}` }); }
        step('push', 'done');
        lastSync[profile.name] = new Date().toISOString();
      }
      emit({ type: 'done', pulled: files });
      return okr({ pulled: files, conflicts: current.decision ? [{ path: '/sitecore/content/Acme/Acme Global/Home/Data' }] : [], decision: current.decision, warnings: [] });
    },
    cancel: () => { if (conflictResolve) conflictResolve({ decision: 'cancel' }); return okr(true); },
    onConflicts: (fn) => { conflictListener = fn; },
    resolveConflicts: (a) => { if (conflictResolve) { conflictResolve(a); conflictResolve = null; } return okr(true); },
    openWorkspace: () => okr(true),
    onEvent: (fn) => { listener = fn; },
  };

  window.__DEVSYNC_DEMO__ = true;
})();
