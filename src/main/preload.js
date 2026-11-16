'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld('devsync', {
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
  openWorkspace: () => ipcRenderer.invoke('shell:open', {}),
  removeLegacy: call('project:removeLegacy'),
  saveReport: call('report:save'),
  onEvent: (fn) => ipcRenderer.on('sync:event', (_e, ev) => fn(ev)),
  onConflicts: (fn) => ipcRenderer.on('sync:conflicts', (_e, list) => fn(list)),
  resolveConflicts: call('sync:resolve'),
  onCommand: (fn) => ipcRenderer.on('ui:command', (_e, cmd) => fn(cmd)),
});
