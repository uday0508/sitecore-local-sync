'use strict';

/*
 * Runs inside the VS Code webview, before the DevSync UI (app.js). It provides the same
 * window.devsync API that the desktop app's preload provides, carried over postMessage to the
 * extension host, which answers with the shared handlers in src/host/handlers.js.
 */
(function () {
  const vscode = acquireVsCodeApi();
  let seq = 0;
  const pending = new Map();
  const listeners = { 'sync:event': [], 'sync:conflicts': [], 'ui:command': [] };
  const queued = []; // commands that arrive before the UI subscribes

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'reply') {
      const done = pending.get(m.id);
      if (done) { pending.delete(m.id); done(m.result); }
    } else if (m.kind === 'push' && listeners[m.channel]) {
      if (m.channel === 'ui:command' && !listeners['ui:command'].length) { queued.push(m.payload); return; }
      for (const fn of listeners[m.channel]) fn(m.payload);
    }
  });

  const call = (channel) => (arg) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    vscode.postMessage({ kind: 'request', id, channel, arg: arg === undefined ? null : arg });
  });
  const on = (channel) => (fn) => {
    listeners[channel].push(fn);
    if (channel === 'ui:command') while (queued.length) fn(queued.shift());
  };

  window.devsync = {
    pickProject: call('project:pick'),
    lastProject: call('project:last'),
    getSettings: call('settings:get'),
    setSettings: call('settings:set'),
    openProject: call('project:open'),
    reloadProject: call('project:reload'),
    getCreds: call('creds:get'),
    connect: call('source:connect'),
    cloudProjects: call('env:projects'),
    cloudEnvironments: call('env:list'),
    connectEnvironment: call('env:connect'),
    children: call('tree:children'),
    saveProfile: call('profiles:save'),
    deleteProfile: call('profiles:delete'),
    plan: call('sync:plan'),
    run: call('sync:run'),
    cancel: call('sync:cancel'),
    openWorkspace: () => call('shell:open')({}),
    removeLegacy: call('project:removeLegacy'),
    saveReport: call('report:save'),
    resolveConflicts: call('sync:resolve'),
    onEvent: on('sync:event'),
    onConflicts: on('sync:conflicts'),
    onCommand: on('ui:command'),
  };
  window.__DEVSYNC_HOST__ = 'vscode';
  document.documentElement.classList.add('in-vscode');
  vscode.postMessage({ kind: 'ready' });
})();
