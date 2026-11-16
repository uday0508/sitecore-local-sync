'use strict';

const $ = (id) => document.getElementById(id);
const api = window.devsync;

const state = {
  project: null,
  settings: {},
  connected: false,
  authMode: 'cli',
  selections: new Map(), // id -> { id, path, name, scope }
  planned: null,
  plannedKey: null,
  busy: false,
};

// Resolves when startup (reopen project, auto-connect) is done; host commands wait for it.
let markStarted;
const started = new Promise((r) => { markStarted = r; });

const SCOPES = [
  ['ItemAndDescendants', 'With everything below'],
  ['ItemAndChildren', 'With children'],
  ['SingleItem', 'This item only'],
];

// ---------- helpers ----------
async function call(fn, arg) {
  const r = await fn(arg);
  if (!r.ok) { const e = new Error(r.error); e.cancelled = !!r.cancelled; e.report = r.report || null; throw e; }
  return r.data;
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== '') e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
let toastTimer;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg; t.className = `toast ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}
const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch { return ''; } };
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const short = (h) => String(h).replace(/^https?:\/\//, '').replace(/\/$/, '');
const folderName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const saveSettings = (patch) => { state.settings = { ...state.settings, ...patch }; api.setSettings(patch).catch(() => {}); };

// ---------- project ----------
async function pickProject() {
  try {
    const info = await call(api.pickProject);
    if (info) { applyProject(info); openConnectionIfNeeded(); }
  } catch (e) { toast(e.message, 'err'); }
}

function applyProject(info) {
  state.project = info;
  state.connected = false;
  $('welcome').classList.add('hidden');
  $('projectName').textContent = folderName(info.root);
  $('projectPill').title = `${info.root}\nClick to change project`;

  const cloud = info.endpoints.filter((e) => e.kind === 'cloud');
  const local = info.endpoints.filter((e) => e.kind === 'local');
  fillSelect($('source'), cloud.map((e) => [e.name, `${e.name}  ·  ${short(e.host)}`]), 'No cloud environment yet');
  fillSelect($('target'), local.map((e) => [e.name, `${e.name}  ·  ${short(e.host)}`]), 'No local CM endpoint');
  if (state.settings.lastSource && cloud.some((e) => e.name === state.settings.lastSource)) $('source').value = state.settings.lastSource;
  if (state.settings.lastTarget && local.some((e) => e.name === state.settings.lastTarget)) $('target').value = state.settings.lastTarget;
  $('noCloud').classList.toggle('hidden', cloud.length > 0);
  $('addEnv').classList.toggle('hidden', cloud.length > 0);
  $('connectBtn').disabled = cloud.length === 0;
  if (!info.hasToolManifest) toast('No .config/dotnet-tools.json found. Run "dotnet tool restore" in the project.', 'err');

  renderProfiles();
  renderConn();
  renderReport(info.lastReport || null);
  offerLegacyCleanup(info);
  $('tree').replaceChildren(el('div', { class: 'empty' }, 'Connect to browse your content.'));
  $('sites').replaceChildren();
}

function fillSelect(sel, options, emptyText) {
  sel.replaceChildren(...(options.length ? options.map(([v, t]) => el('option', { value: v }, t)) : [el('option', { value: '' }, emptyText)]));
}

function renderConn(status) {
  const dot = $('connDot');
  const src = $('source').value, tgt = $('target').value;
  dot.className = `dot ${status === 'busy' ? 'busy' : status === 'err' ? 'err' : state.connected ? 'ok' : ''}`;
  $('connText').textContent = src && tgt ? `${src} → ${tgt}` : 'Set up connection';
}

function openConnectionIfNeeded() {
  if (!state.connected) $('connDialog').showModal();
}

// ---------- connection ----------
function setAuthMode(mode, persist = true) {
  state.authMode = mode;
  for (const b of $('authMode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
  $('authCli').classList.toggle('hidden', mode !== 'cli');
  $('authAutomation').classList.toggle('hidden', mode !== 'automation');
  if (persist) saveSettings({ authMode: mode });
  if (mode === 'automation') loadRememberedCreds();
}

async function loadRememberedCreds() {
  if (!state.project || !$('source').value) return null;
  try {
    const c = await call(api.getCreds, { endpoint: $('source').value });
    if (c) { $('clientId').value = c.clientId; $('clientSecret').value = c.clientSecret; }
    return c;
  } catch { return null; }
}

async function connect({ silent = false } = {}) {
  if (!state.project) return;
  const source = $('source').value;
  if (!source) { if (!silent) setStatus('Add a cloud environment first.', 'err'); return; }
  const auth = state.authMode === 'automation'
    ? { mode: 'automation', clientId: $('clientId').value.trim(), clientSecret: $('clientSecret').value.trim() }
    : { mode: 'cli' };
  setStatus('Connecting…'); renderConn('busy');
  $('connectBtn').disabled = true;
  try {
    const r = await call(api.connect, { source, auth, remember: $('remember').checked });
    state.connected = true;
    saveSettings({ lastSource: source, lastTarget: $('target').value });
    setStatus(`Connected · ${r.sites.length} site(s)`, 'ok');
    renderConn();
    if ($('connDialog').open) $('connDialog').close();
    renderSites(r.sites);
    await loadTreeRoot(r.sites.length === 1 ? r.sites[0].rootPath : '/sitecore/content');
  } catch (e) {
    state.connected = false;
    setStatus(e.message, 'err'); renderConn('err');
    if (silent) { $('connDialog').showModal(); }
  } finally { $('connectBtn').disabled = false; }
}
function setStatus(t, k = '') { const s = $('connStatus'); s.textContent = t; s.className = `status ${k}`; }

// add cloud environment
async function loadCloudProjects() {
  const btn = $('loadProjects');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const projects = await call(api.cloudProjects);
    const sel = $('cloudProject');
    sel.replaceChildren(...(projects.length ? projects.map((p) => el('option', { value: p.id }, p.name)) : [el('option', { value: '' }, 'No projects found')]));
    sel.disabled = !projects.length;
    if (projects.length) await loadCloudEnvironments();
  } catch (e) { setStatus(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Load my projects'; }
}
async function loadCloudEnvironments() {
  const projectId = $('cloudProject').value;
  const box = $('envList');
  if (!projectId) return;
  box.replaceChildren(el('div', { class: 'hint' }, 'Loading environments…'));
  try {
    const envs = await call(api.cloudEnvironments, { projectId });
    const hosts = new Set((state.project?.endpoints || []).map((e) => short(e.host).toLowerCase()));
    box.replaceChildren(...(envs.length ? envs.map((e) => {
      const already = e.host && hosts.has(short(e.host).toLowerCase());
      return el('div', { class: 'env-row' },
        el('div', {}, el('b', {}, e.name), e.isProd ? el('span', { class: 'prod' }, 'PROD') : '', el('div', { class: 'host' }, e.host || e.id)),
        el('button', { type: 'button', class: 'btn small', disabled: already, onclick: () => addEnvironment(e.id) }, already ? 'Added' : 'Add'));
    }) : [el('div', { class: 'hint' }, 'No environments in this project.')]));
  } catch (e) { box.replaceChildren(el('div', { class: 'hint' }, e.message)); }
}
async function addEnvironment(environmentId) {
  if (!environmentId) return setStatus('Enter an environment ID.', 'err');
  setStatus('Adding environment with the Sitecore CLI…');
  try {
    const before = new Set((state.project?.endpoints || []).map((e) => e.name));
    const info = await call(api.connectEnvironment, { environmentId });
    applyProject(info);
    const added = info.endpoints.find((e) => e.kind === 'cloud' && !before.has(e.name));
    if (added) $('source').value = added.name;
    setStatus(added ? `Added "${added.name}". Click Connect.` : 'Environment added.', 'ok');
  } catch (e) { setStatus(e.message, 'err'); }
}

// ---------- tree ----------
// A few sites: one-click chips. Many sites (multi-region solutions): a compact picker, so the
// content tree keeps its height.
const MAX_SITE_CHIPS = 6;
function renderSites(sites) {
  const box = $('sites');
  if (sites.length <= MAX_SITE_CHIPS) {
    box.replaceChildren(...sites.map((s) => el('button', { class: 'chip', title: s.rootPath, 'data-root': s.rootPath, onclick: () => loadTreeRoot(s.rootPath) }, s.name)));
    return;
  }
  const sorted = [...sites].sort((a, b) => a.name.localeCompare(b.name));
  const sel = el('select', { class: 'site-select', id: 'siteSelect', title: 'Site', onchange: (e) => { if (e.target.value) loadTreeRoot(e.target.value); } },
    el('option', { value: '/sitecore/content' }, `All content · ${sites.length} sites`),
    ...sorted.map((s) => el('option', { value: s.rootPath }, `${s.name}  ·  ${s.rootPath.replace(/^\/sitecore\/content\//i, '')}`)));
  box.replaceChildren(el('label', { class: 'site-picker' }, el('span', {}, 'Site'), sel));
}
function markSite(path) {
  const p = String(path || '').toLowerCase();
  for (const c of document.querySelectorAll('#sites .chip')) c.classList.toggle('on', String(c.dataset.root).toLowerCase() === p);
  const sel = $('siteSelect');
  if (sel && [...sel.options].some((o) => o.value.toLowerCase() === p)) sel.value = [...sel.options].find((o) => o.value.toLowerCase() === p).value;
}

async function loadTreeRoot(path) {
  if (!state.connected) return;
  markSite(path);
  const tree = $('tree');
  tree.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
  try {
    const item = await call(api.children, { path, language: 'en' });
    if (!item) { tree.replaceChildren(el('div', { class: 'empty' }, `Not found: ${path}`)); return; }
    const parts = item.path.split('/');
    const up = parts.length > 2 ? parts.slice(0, -1).join('/') : null;
    tree.replaceChildren(
      up ? el('div', { class: 'back' }, el('button', { class: 'link', onclick: () => loadTreeRoot(up) }, `↑ ${up}`)) : '',
      renderNode(item, true));
    $('pathInput').value = item.path;
  } catch (e) { tree.replaceChildren(el('div', { class: 'empty' }, e.message)); }
}

function renderNode(item, expanded = false) {
  const box = el('div', { class: 'node-children' });
  const twisty = el('span', { class: `twisty ${item.hasChildren === false ? 'leaf' : ''}` }, expanded ? '▾' : '▸');
  const cb = el('input', { type: 'checkbox', title: 'Sync this item' });
  cb.checked = state.selections.has(item.id);
  const name = el('span', { class: 'node-name', title: item.path }, item.name);
  const node = el('div', { class: `node ${cb.checked ? 'selected' : ''}`, 'data-id': item.id },
    el('div', { class: 'node-row' }, twisty, cb, name, el('span', { class: 'node-tpl' }, item.template || '')), box);

  let loaded = false;
  const fill = (list) => {
    loaded = true;
    box.replaceChildren(...(list.length ? list.map((c) => renderNode(c)) : [el('div', { class: 'hint back' }, 'No children')]));
  };
  if (expanded && item.children) fill(item.children); else box.classList.add('hidden');

  const toggle = async () => {
    if (item.hasChildren === false) return;
    const open = box.classList.contains('hidden');
    twisty.textContent = open ? '▾' : '▸';
    box.classList.toggle('hidden', !open);
    if (open && !loaded) {
      box.replaceChildren(el('div', { class: 'hint back' }, 'Loading…'));
      try { fill((await call(api.children, { id: item.id, language: 'en' })).children || []); }
      catch (e) { box.replaceChildren(el('div', { class: 'hint back' }, e.message)); }
    }
  };
  twisty.addEventListener('click', toggle);
  name.addEventListener('click', toggle);
  cb.addEventListener('change', () => {
    if (state.busy) { cb.checked = state.selections.has(item.id); return; } // locked while running
    if (cb.checked) state.selections.set(item.id, { id: item.id, path: item.path, name: item.name, scope: 'ItemAndDescendants' });
    else state.selections.delete(item.id);
    node.classList.toggle('selected', cb.checked);
    renderSelection();
  });
  return node;
}

function syncTreeChecks() {
  for (const n of document.querySelectorAll('.node')) {
    const on = state.selections.has(n.dataset.id);
    n.classList.toggle('selected', on);
    const cb = n.querySelector(':scope > .node-row input[type=checkbox]');
    if (cb) cb.checked = on;
  }
}

// ---------- selection ----------
function renderSelection() {
  const box = $('selection');
  $('selCount').textContent = `${state.selections.size} selected`;
  if (!state.selections.size) { box.replaceChildren(el('div', { class: 'empty small' }, 'Tick pages or folders in the tree.')); return; }
  box.replaceChildren(...[...state.selections.values()].map((s) => {
    const sel = el('select', { onchange: (e) => { if (state.busy) { e.target.value = s.scope; return; } s.scope = e.target.value; } },
      ...SCOPES.map(([v, t]) => { const o = el('option', { value: v }, t); if (v === s.scope) o.selected = true; return o; }));
    return el('div', { class: 'sel-item' },
      el('div', { class: 'sel-name', title: s.path }, s.name, el('small', {}, s.path)),
      sel,
      el('button', { class: 'icon-btn', title: 'Remove', onclick: () => { if (state.busy) return; state.selections.delete(s.id); renderSelection(); syncTreeChecks(); } }, '✕'));
  }));
}

// ---------- profile <-> form ----------
// Everything else is automatic: all dependencies, parent folders, safe push, ask on conflicts.
function currentProfile() {
  return {
    name: $('profileSelect').value || 'Quick sync',
    source: $('source').value,
    target: $('target').value,
    language: 'en',
    selections: [...state.selections.values()],
    dependencies: $('includeMedia').checked ? {} : { media: false },
    pushMode: 'safe',
    includeAncestors: true,
    onConflict: 'ask',
    mask: { enabled: $('maskOn').checked },
  };
}

function applyProfile(p) {
  if (p.source && [...$('source').options].some((o) => o.value === p.source)) $('source').value = p.source;
  if (p.target && [...$('target').options].some((o) => o.value === p.target)) $('target').value = p.target;
  state.selections = new Map((p.selections || []).map((s) => [s.id, { ...s }]));
  $('maskOn').checked = !!(p.mask && p.mask.enabled);
  $('includeMedia').checked = !(p.dependencies && p.dependencies.media === false);
  renderLastSync(p);
  renderSelection();
  syncTreeChecks();
  renderConn();
}

function renderLastSync(p) {
  const has = !!(p && p.lastSyncAt);
  $('optDelta').disabled = !has;
  if (!has) $('optDelta').checked = false;
  $('lastSyncText').textContent = has ? `Last synced ${fmtDate(p.lastSyncAt)}. Picks up changes in every language and items deleted in the cloud.` : (p && p.name ? 'This profile has not been synced yet.' : 'Save a profile and sync once to use this.');
}

function renderProfiles() {
  const sel = $('profileSelect');
  const cur = sel.value || state.settings.lastProfile || '';
  sel.replaceChildren(el('option', { value: '' }, 'Unsaved selection'), ...(state.project?.profiles || []).map((p) => el('option', { value: p.name }, p.name)));
  if (cur && (state.project?.profiles || []).some((p) => p.name === cur)) sel.value = cur;
}

async function saveProfile() {
  if (!state.selections.size) return toast('Tick some content first.', 'err');
  const name = await askName($('profileSelect').value || '');
  if (!name) return;
  const p = { ...currentProfile(), name: name.trim() };
  try {
    state.project = await call(api.saveProfile, { profile: p });
    renderProfiles();
    $('profileSelect').value = p.name;
    saveSettings({ lastProfile: p.name });
    renderLastSync(state.project.profiles.find((x) => x.name === p.name));
    toast(`Saved "${p.name}".`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function askName(initial) {
  return new Promise((resolve) => {
    const d = $('nameDialog');
    $('profileNameInput').value = initial;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'save' ? $('profileNameInput').value.trim() : ''), { once: true });
    d.showModal();
    $('profileNameInput').select();
  });
}

async function deleteProfile() {
  const name = $('profileSelect').value;
  if (!name || !window.confirm(`Delete profile "${name}"?`)) return;
  try {
    state.project = await call(api.deleteProfile, { name });
    $('profileSelect').value = '';
    saveSettings({ lastProfile: '' });
    renderProfiles();
    renderLastSync(null);
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- plan + run ----------
function checkReady() {
  if (!state.project) { pickProject(); return false; }
  if (!state.connected) { $('connDialog').showModal(); return false; }
  if (!state.selections.size) { toast('Tick at least one item in the tree.', 'err'); return false; }
  if (!$('target').value) { toast('No local CM endpoint. Run "dotnet sitecore connect … -n local".', 'err'); $('connDialog').showModal(); return false; }
  return true;
}

async function makePlan() {
  const profile = currentProfile();
  const mode = $('optDelta').checked ? 'delta' : 'full';
  const key = JSON.stringify({ profile, mode });
  if (state.planned && state.plannedKey === key) return { profile, planned: state.planned };
  step('plan', 'running', 'finding dependencies…');
  const planned = await call(api.plan, { profile, mode });
  state.planned = planned; state.plannedKey = key;
  renderPlan(planned);
  step('plan', 'done', `${planned.plan.includes.length} include(s)`);
  return { profile, planned };
}

async function preview() {
  if (!checkReady()) return;
  setBusy(true); resetSteps();
  try { await makePlan(); showTab('plan'); } catch (e) { fail(e); } finally { setBusy(false); }
}

async function sync(dryRun = false) {
  if (!checkReady()) return;
  const profile = currentProfile();
  if (profile.pushMode === 'mirror' && !dryRun && !window.confirm('Mirror mode deletes local items under your selected trees that do not exist in the cloud. Continue?')) return;
  setBusy(true); resetSteps(); showTab('log');
  $('summary').replaceChildren(el('span', { class: 'hint' }, 'Working…'));
  try {
    await makePlan();
    const r = await call(api.run, { profile, dryRun });
    const needs = ((r.report && r.report.issues) || []).filter((i) => i.severity !== 'info');
    const notes = needs.length
      ? [el('div', { class: 'attention' }, `${needs.length} item(s) need attention. `, el('button', { class: 'link', onclick: () => showTab('report') }, 'Open the report'))]
      : [];
    $('summary').replaceChildren(
      el('div', { class: 'big-note ok' }, dryRun ? `Dry run done: ${r.pulled} item files pulled. Nothing changed locally.` : `Done: ${r.pulled} item files synced to ${profile.target}.`),
      ...summaryTags(state.planned), ...notes);
    toast(dryRun ? 'Dry run finished.' : needs.length ? `Sync finished. ${needs.length} item(s) need attention.` : 'Sync finished.', needs.length ? '' : 'ok');
    if (needs.length) showTab('report');
    state.project = await call(api.reloadProject);
    renderProfiles();
    renderLastSync(state.project.profiles.find((p) => p.name === $('profileSelect').value));
    state.planned = null; // force a fresh plan next time
  } catch (e) { fail(e); }
  finally { setBusy(false); }
}

function fail(e) {
  if (e.cancelled) {
    const running = $('steps').querySelector('li.running, li.waiting');
    if (running) { running.className = 'skipped'; running.querySelector('small')?.remove(); running.append(el('small', {}, 'cancelled')); }
    $('summary').replaceChildren(el('div', { class: 'big-note' }, 'Cancelled'), el('span', { class: 'hint' }, e.message));
    toast(e.message);
    logLine({ level: 'warn', message: e.message, at: new Date().toISOString() });
    state.planned = null;
    return;
  }
  const msg = friendlyError(e.message);
  $('summary').replaceChildren(el('div', { class: 'big-note err' }, 'Sync stopped'), el('span', { class: 'hint' }, msg),
    el('div', { class: 'attention' }, el('button', { class: 'link', onclick: () => showTab('report') }, 'Open the report')));
  toast(msg, 'err');
  logLine({ level: 'err', message: e.message, at: new Date().toISOString() });
}

function friendlyError(m) { return m; } // the engine already adds a plain-language next step

function summaryTags(p) {
  if (!p) return [];
  return Object.entries(p.plan.summary).filter(([k]) => k !== 'total').map(([k, v]) => el('span', { class: `tag ${k}` }, `${v} ${label(k, v)}`));
}
function label(k, n) {
  const map = { template: 'template', layout: 'rendering', media: 'media', content: 'datasource', selection: 'selected', changed: 'changed', ancestor: 'parent folder' };
  const w = map[k] || k;
  return n === 1 || ['media', 'selected', 'changed'].includes(w) ? w : `${w}s`;
}

function renderPlan(p) {
  const inc = p.plan.includes;
  $('planCount').textContent = inc.length;
  $('summary').replaceChildren(
    el('div', { class: 'big-note' }, p.mode === 'delta'
      ? `${p.changed.length} changed item(s) since ${fmtDate(p.since)}${p.changedByLanguage && Object.keys(p.changedByLanguage).length ? `: ${Object.entries(p.changedByLanguage).map(([l, n]) => `${l} ${n}`).join(' · ')}` : ''}`
      : `${inc.length} includes ready`),
    ...summaryTags(p),
    p.alreadyLocal ? el('span', { class: 'tag ancestor', title: 'Sitecore defaults and your serialized items that already exist locally with the same ID' }, `${p.alreadyLocal} already on your machine`) : '',
    p.deletions && p.deletions.deleted.length ? el('span', { class: 'tag layout', title: p.deletions.deleted.map((d) => d.path).join('\n') }, `${p.deletions.deleted.length} deleted in cloud → Recycle Bin`) : '');
  const rows = inc.map((i) => el('tr', {},
    el('td', {}, el('span', { class: `tag ${i.kind}` }, label(i.kind, 1))),
    el('td', { class: 'path', title: i.reason }, i.path),
    el('td', { class: 'ops' }, i.scope === 'SingleItem' ? 'item' : i.scope === 'ItemAndChildren' ? '+ children' : '+ all below'),
    el('td', { class: `ops ${i.allowedPushOperations.includes('Delete') ? 'del' : ''}` }, { CreateOnly: 'create if missing', CreateAndUpdate: 'create / update', CreateUpdateAndDelete: 'mirror' }[i.allowedPushOperations])));
  $('planBody').replaceChildren(el('table', { class: 'plan' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Kind'), el('th', {}, 'Path'), el('th', {}, 'Scope'), el('th', {}, 'Push'))),
    el('tbody', {}, rows)));

}

// While a preview or sync runs, nothing that feeds it can change: project, connection, site,
// tree, selection, profile and options are locked. Only Cancel (and a conflict answer) work.
const LOCK_INERT = ['pathInput', 'sites', 'tree', 'selection'];
const LOCK_DISABLE = ['syncBtn', 'previewBtn', 'dryRunBtn', 'profileSelect', 'saveProfile', 'deleteProfile', 'projectPill', 'connPill', 'optDelta', 'maskOn', 'includeMedia', 'welcomeOpen'];
// On a narrow screen Activity sits below the fold: bring it into view when a run starts.
function revealActivity() {
  const a = document.querySelector('.activity-pane');
  if (!a) return;
  const r = a.getBoundingClientRect();
  if (r.top > window.innerHeight - 160 || r.bottom < 80) a.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setBusy(b) {
  state.busy = b;
  if (b) revealActivity();
  document.body.classList.toggle('locked', b);
  for (const id of LOCK_INERT) { const x = $(id); if (x) x.inert = b; }
  for (const id of LOCK_DISABLE) { const x = $(id); if (x) x.disabled = b; }
  if (b && $('connDialog').open) $('connDialog').close();
  $('syncBtn').textContent = b ? 'Working…' : 'Sync to local';
  const c = $('cancelBtn');
  c.classList.toggle('hidden', !b);
  c.disabled = false;
  c.textContent = 'Cancel';
}

async function cancelRun() {
  if (!state.busy) return;
  const c = $('cancelBtn');
  c.disabled = true; c.textContent = 'Cancelling…';
  logLine({ level: 'warn', message: 'Cancelling… stopping the current step.', at: new Date().toISOString() });
  try { await api.cancel(); } catch { /* the run ends either way */ }
}

function resetSteps() { for (const li of $('steps').children) { li.className = ''; li.querySelector('small')?.remove(); } }
function step(id, status, detail) {
  const li = $('steps').querySelector(`[data-step=${id}]`);
  if (!li) return;
  li.className = status;
  li.querySelector('small')?.remove();
  if (detail) li.append(el('small', { title: detail }, detail));
}

function onEvent(e) {
  if (e.type === 'log') logLine(e);
  if (e.type === 'step' && e.id !== 'prepare') step(e.id, e.status, e.detail);
  if (e.type === 'report') renderReport(e.report);
  if (e.type === 'cancelled') logLine({ level: 'warn', message: e.message, at: e.at });
  if (e.type === 'error') {
    const running = $('steps').querySelector('li.running');
    if (running) running.className = 'error';
  }
}

function logLine(e) {
  const body = $('logBody');
  body.append(el('div', { class: e.level === 'cmd' ? 'cmd' : e.level === 'warn' ? 'warn' : e.level === 'err' ? 'err' : '' }, el('time', {}, fmtTime(e.at)), e.message));
  while (body.childElementCount > 4000) body.firstChild.remove();
  body.scrollTop = body.scrollHeight;
}

function showTab(name) {
  for (const b of $('tabs').querySelectorAll('button[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  for (const b of document.querySelectorAll('.tab-body')) b.classList.toggle('hidden', b.dataset.body !== name);
}

// ---------- report ----------
const TYPE_LABEL = {
  orphan: 'Skipped: orphaned item', 'cloud-duplicate': 'Skipped: duplicate name in cloud', 'media-skipped': 'Media not synced',
  'conflict-replaced': 'Replaced local item', 'conflict-kept': 'Kept local item', 'conflict-pending': 'Conflict (dry run)',
  'deleted-in-cloud': 'Removed: deleted in cloud', 'deleted-in-cloud-pending': 'Deleted in cloud (dry run)', 'deleted-in-cloud-manual': 'Deleted in cloud: remove manually',
  'language-added': 'Added language', 'language-check': 'Check language',
  notice: 'Notice', error: 'Sync stopped',
};
let lastReport = null;
function renderReport(rep) {
  lastReport = rep;
  const box = $('reportBody');
  if (!rep) { box.replaceChildren(el('div', { class: 'empty small' }, 'After a sync, every item that needs attention is listed here with how to fix it.')); $('reportCount').textContent = '0'; return; }
  const warn = rep.issues.filter((i) => i.severity === 'warning').length;
  $('reportCount').textContent = String(rep.issues.filter((i) => i.severity !== 'info').length);
  const status = rep.status === 'failed' ? ['err', 'Failed'] : rep.status === 'cancelled' ? ['warn', 'Cancelled'] : warn ? ['warn', 'Completed with warnings'] : ['ok', 'Completed'];
  const c = rep.counts || {};
  box.replaceChildren(
    el('div', { class: 'report-head' },
      el('span', { class: `badge ${status[0]}` }, status[1]),
      el('span', { class: 'hint grow' }, `${fmtDate(rep.at)} · ${rep.source} → ${rep.target}${rep.dryRun ? ' · dry run' : ''} · ${c.pulledFiles || 0} pulled · ${c.alreadyLocal || 0} already on machine · ${c.skippedItems || 0} skipped · ${c.deletedInCloud || 0} deleted in cloud`),
      el('button', { class: 'btn small', onclick: saveReport }, 'Save report…')),
    rep.issues.length
      ? el('table', { class: 'plan report' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Type'), el('th', {}, 'Item'), el('th', {}, 'What happened'), el('th', {}, 'How to fix'))),
        el('tbody', {}, rep.issues.map((i) => el('tr', { class: `sev-${i.severity}` },
          el('td', {}, el('span', { class: 'tag' }, TYPE_LABEL[i.type] || i.type)),
          el('td', { class: 'path' }, i.path || '—', i.id ? el('div', { class: 'ops' }, `ID ${i.id}`) : '', i.templateId ? el('div', { class: 'ops' }, `template ${i.templateId}`) : ''),
          el('td', {}, i.detail),
          el('td', { class: 'fix' }, i.fix || '')))))
      : el('div', { class: 'empty small' }, 'Nothing needed attention. Everything selected was synced.'));
}
async function saveReport() {
  if (!lastReport) return;
  try { const f = await call(api.saveReport, { report: lastReport }); if (f) toast(`Report saved: ${f}`, 'ok'); } catch (e) { toast(e.message, 'err'); }
}

async function offerLegacyCleanup(info) {
  if (!info.legacy) return;
  const mb = (info.legacy.bytes / 1048576).toFixed(1);
  if (window.confirm(`An older DevSync version created "${info.legacy.path}" inside your project (${mb} MB). DevSync now keeps its files outside your repo, and your profiles were moved over.\n\nDelete the old folder from your project?`)) {
    try { await call(api.removeLegacy); toast('Removed the old .devsync folder from your project.', 'ok'); } catch (e) { toast(e.message, 'err'); }
  }
}

// ---------- conflicts ----------
function showConflicts(list) {
  const total = list.reduce((a, c) => a + (c.localItems || 1), 0);
  $('conflictIntro').textContent = `${list.length} path(s) exist in your local CM with a different item ID than in the cloud, usually because the local site or folder was created separately. SCS can't push over them. ${total} local item(s) are affected.`;
  $('conflictList').replaceChildren(...list.map((c) => el('div', { class: 'conflict-row' },
    el('span', { class: `tag ${c.kind}` }, label(c.kind === 'content' ? 'content' : c.kind, 1)),
    el('div', {}, el('div', { class: 'p' }, c.path), el('div', { class: 'ids' }, `local ${c.localId} · cloud ${c.cloudId}`)),
    el('span', { class: 'n' }, c.localItems != null ? `${c.localItems} local item(s)` : ''))));
  $('conflictTplWarn').classList.toggle('hidden', !list.some((c) => c.kind === 'template' || c.kind === 'layout'));
  const d = $('conflictDialog');
  d.returnValue = '';
  d.addEventListener('close', () => {
    const decision = ['replace', 'skip'].includes(d.returnValue) ? d.returnValue : 'cancel';
    api.resolveConflicts({ decision, remember: false });
  }, { once: true });
  showTab('log');
  d.showModal();
}

// ---------- wiring ----------
function wire() {
  wireGutters();
  $('projectPill').addEventListener('click', pickProject);
  $('welcomeOpen').addEventListener('click', pickProject);
  $('connPill').addEventListener('click', () => $('connDialog').showModal());
  $('authMode').addEventListener('click', (e) => { const m = e.target.dataset && e.target.dataset.mode; if (m) setAuthMode(m); });
  $('source').addEventListener('change', () => { state.connected = false; renderConn(); setStatus(''); loadRememberedCreds(); });
  $('target').addEventListener('change', () => { saveSettings({ lastTarget: $('target').value }); renderConn(); });
  $('connectBtn').addEventListener('click', () => connect());
  $('toggleAddEnv').addEventListener('click', () => $('addEnv').classList.toggle('hidden'));
  $('loadProjects').addEventListener('click', loadCloudProjects);
  $('cloudProject').addEventListener('change', loadCloudEnvironments);
  $('connectManual').addEventListener('click', () => addEnvironment($('envIdManual').value.trim()));
  $('pathInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) loadTreeRoot(e.target.value.trim()); });
  $('profileSelect').addEventListener('change', (e) => {
    const p = (state.project?.profiles || []).find((x) => x.name === e.target.value);
    saveSettings({ lastProfile: e.target.value });
    if (p) applyProfile(p); else renderLastSync(null);
  });
  $('saveProfile').addEventListener('click', saveProfile);
  $('deleteProfile').addEventListener('click', deleteProfile);
  $('syncBtn').addEventListener('click', () => sync(false));
  $('previewBtn').addEventListener('click', preview);
  $('dryRunBtn').addEventListener('click', () => sync(true));
  $('cancelBtn').addEventListener('click', cancelRun);
  $('openWs').addEventListener('click', () => api.openWorkspace());
  $('tabs').addEventListener('click', (e) => { const t = e.target.closest('button[data-tab]'); if (t) showTab(t.dataset.tab); });
  api.onEvent(onEvent);
  api.onConflicts(showConflicts);
  if (api.onCommand) api.onCommand((cmd) => externalCommand(cmd).catch((e) => toast(e.message, 'err')));
}

// ---------- commands from the host (VS Code: "Pull latest" on a .yml, Page Builder links, re-login) ----------
async function externalCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return;
  await started;
  if (cmd.type === 'reconnect') {
    if (state.project && !state.busy && !state.connected && $('source').value) await connect({ silent: true });
    return;
  }
  if (cmd.type !== 'sync') return;
  if (state.busy) { toast('A sync is running. Try again when it finishes.', 'err'); return; }
  if (!state.project) { toast('Open your project first.', 'err'); return; }
  if (cmd.source && $('source').value !== cmd.source) {
    if (![...$('source').options].some((o) => o.value === cmd.source)) { toast(`${cmd.source} isn't connected to this project.`, 'err'); return; }
    $('source').value = cmd.source;
    state.connected = false;
  }
  if (!state.connected) await connect({ silent: true });
  if (!state.connected) { openConnectionIfNeeded(); return; }
  const items = [];
  for (const it of cmd.items || []) {
    let node = it;
    if (!it.path) {
      node = await call(api.children, { id: it.id, language: cmd.language }).catch(() => null);
      if (!node) { toast(`Item ${it.id} was not found in ${$('source').value}.`, 'err'); return; }
    }
    items.push({ id: node.id, path: node.path, name: node.name || node.path.split('/').pop(), scope: it.scope || 'SingleItem' });
  }
  if (!items.length) return;
  state.selections = new Map(items.map((i) => [i.id, i]));
  $('profileSelect').value = '';
  renderLastSync(null);
  renderSelection();
  syncTreeChecks();
  if (cmd.label) toast(cmd.label);
  if (cmd.preview) await preview(); else await sync(false);
}

// ---------- resizable panes ----------
// Drag (or use the arrow keys on) a separator to resize; double-click resets it. Sizes are CSS
// variables on #main, remembered in settings, and re-clamped when the window size changes.
const LAYOUT_VARS = ['--col-tree', '--col-sync', '--col-left', '--row-tree', '--tree-h'];
let layoutVals = {};
const layoutMode = () => (window.innerWidth <= 860 ? 'narrow' : window.innerWidth <= 1280 ? 'medium' : 'wide');
const clampN = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));

function applyLayout() {
  const main = $('main');
  for (const k of LAYOUT_VARS) { if (layoutVals[k]) main.style.setProperty(k, layoutVals[k]); else main.style.removeProperty(k); }
  const rows = !!layoutVals['--row-tree'];
  main.classList.toggle('rows-set', rows);
  if (rows) main.style.setProperty('--row-sync', 'minmax(140px, 1fr)'); else main.style.removeProperty('--row-sync');
}
function setLayoutVar(k, px) { if (px == null) delete layoutVals[k]; else layoutVals[k] = `${px}px`; applyLayout(); }
function saveLayout() { saveSettings({ layout: { ...layoutVals } }); }

function resizeTo(g, x, y) {
  const main = $('main'); const r = main.getBoundingClientRect();
  const cs = getComputedStyle(main); const pad = parseFloat(cs.paddingLeft) || 0;
  const mode = layoutMode();
  const tree = main.querySelector('.pane').getBoundingClientRect();
  if (g === 'g1' && mode === 'wide') {
    setLayoutVar('--col-tree', clampN(x - r.left - pad - 7, 260, r.width - 2 * pad - 28 - 320 - 360));
  } else if (g === 'g2' && mode === 'wide') {
    const sync = document.querySelector('.sync-pane').getBoundingClientRect();
    setLayoutVar('--col-sync', clampN(x - sync.left - 7, 320, r.right - pad - 360 - 14 - sync.left));
  } else if (g === 'g2' && mode === 'medium') {
    setLayoutVar('--col-left', clampN(x - r.left - pad - 6, 300, r.width - 2 * pad - 12 - 360));
  } else if (g === 'g3' && mode === 'medium') {
    setLayoutVar('--row-tree', clampN(y - tree.top - 6, 140, main.clientHeight - 2 * pad - 12 - 140));
  } else if (g === 'g3' && mode === 'narrow') {
    setLayoutVar('--tree-h', clampN(y - tree.top - 6, 200, window.innerHeight * 0.85));
  }
}
function resetGutter(g) {
  const mode = layoutMode();
  const key = { g1: '--col-tree', g2: mode === 'wide' ? '--col-sync' : '--col-left', g3: mode === 'narrow' ? '--tree-h' : '--row-tree' }[g];
  setLayoutVar(key, null);
}
// After a window resize, pull saved sizes back inside what fits.
function clampLayout() {
  for (const g of document.querySelectorAll('.gutter')) {
    if (!g.offsetParent) continue;
    const b = g.getBoundingClientRect();
    const mode = layoutMode();
    const relevant = (g.dataset.g === 'g1' && layoutVals['--col-tree']) || (g.dataset.g === 'g2' && layoutVals[mode === 'wide' ? '--col-sync' : '--col-left'])
      || (g.dataset.g === 'g3' && layoutVals[mode === 'narrow' ? '--tree-h' : '--row-tree']);
    if (relevant) resizeTo(g.dataset.g, b.left + b.width / 2, b.top + b.height / 2);
  }
}
// Show a divider above the pinned Sync button only when the panel actually scrolls.
function watchSyncScroll() {
  const pane = document.querySelector('.sync-pane');
  const update = () => pane.classList.toggle('scrolls', pane.scrollHeight > pane.clientHeight + 2 && pane.scrollTop + pane.clientHeight < pane.scrollHeight - 2);
  pane.addEventListener('scroll', update);
  new ResizeObserver(update).observe(pane);
  new MutationObserver(update).observe(pane, { childList: true, subtree: true });
}
function wireGutters() {
  watchSyncScroll();
  for (const g of document.querySelectorAll('.gutter')) {
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { g.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
      g.classList.add('dragging');
      document.body.classList.add('resizing', g.classList.contains('v') ? 'v-resize' : 'h-resize');
      const move = (ev) => resizeTo(g.dataset.g, ev.clientX, ev.clientY);
      const up = () => {
        g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
        g.classList.remove('dragging'); document.body.classList.remove('resizing', 'v-resize', 'h-resize');
        saveLayout();
      };
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    });
    g.addEventListener('dblclick', () => { resetGutter(g.dataset.g); saveLayout(); });
    g.addEventListener('keydown', (e) => {
      const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const d = dir * (e.shiftKey ? 64 : 16); const b = g.getBoundingClientRect();
      resizeTo(g.dataset.g, b.left + b.width / 2 + d, b.top + b.height / 2 + d);
      saveLayout();
    });
  }
  let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(clampLayout, 120); });
}

// ---------- startup: reopen last project and reconnect ----------
async function start() {
  try { await startInner(); } finally { markStarted(); }
}
async function startInner() {
  wire();
  if (window.__DEVSYNC_DEMO__) $('demoBadge').classList.remove('hidden');
  try { state.settings = (await call(api.getSettings)) || {}; } catch { state.settings = {}; }
  layoutVals = { ...(state.settings.layout || {}) };
  applyLayout();
  setAuthMode(state.settings.authMode || 'cli', false);
  let info = null;
  try { info = await call(api.lastProject); } catch (e) { toast(e.message, 'err'); }
  if (!info) { $('welcome').classList.remove('hidden'); return; }
  applyProject(info);
  const prof = (info.profiles || []).find((p) => p.name === state.settings.lastProfile);
  if (prof) applyProfile(prof);
  // Reconnect automatically when we can do it without asking.
  const canAuto = $('source').value && (state.authMode === 'cli' || (await loadRememberedCreds()));
  if (canAuto && state.settings.autoConnect !== false) await connect({ silent: true });
  else openConnectionIfNeeded();
}

start();
