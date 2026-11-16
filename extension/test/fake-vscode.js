'use strict';

/*
 * A small, scriptable stand-in for the 'vscode' module, so the bundled extension can be activated
 * and driven in plain Node. Answers to quick picks, input boxes and message buttons are queued with
 * fake.answer(...); everything shown to the user is recorded in fake.shown.
 */
const Module = require('module');
const path = require('path');

function createFake({ workspaceRoot, config = {} } = {}) {
  const commands = new Map();
  const contexts = {};
  const shown = { info: [], warn: [], error: [], picks: [], inputs: [], panels: [], progress: [], log: [], terminals: [] };
  const answers = [];
  const answer = (...vals) => answers.push(...vals);
  const next = (kind, prompt) => {
    if (!answers.length) throw new Error(`fake vscode: no queued answer for ${kind}: ${prompt}`);
    const v = answers.shift();
    return typeof v === 'function' ? v(prompt) : v;
  };

  class EventEmitter {
    constructor() { this.listeners = new Set(); this.event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
    fire(v) { for (const l of this.listeners) l(v); }
    dispose() {}
  }
  class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
  class ThemeIcon { constructor(id) { this.id = id; } }
  class MarkdownString { constructor(v) { this.value = v; } }
  const Uri = { file: (p) => ({ fsPath: p, scheme: 'file', path: p }), parse: (s) => { const u = new URL(s); return { scheme: u.protocol.slice(0, -1), authority: u.host, path: u.pathname, query: u.search.slice(1), fsPath: u.pathname }; } };

  const trees = {};
  const message = (kind) => async (msg, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : null;
    shown[kind].push({ msg, opts, buttons: rest });
    if (!rest.length) return undefined;
    return next(kind, msg);
  };

  const vscode = {
    _watchers: [],
    EventEmitter, TreeItem, ThemeIcon, MarkdownString, Uri,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1 },
    window: {
      createOutputChannel: () => {
        const ch = {};
        for (const k of ['info', 'warn', 'error', 'debug', 'trace', 'appendLine']) ch[k] = (m) => shown.log.push(`[${k}] ${m}`);
        ch.show = () => {}; ch.dispose = () => {};
        return ch;
      },
      createTreeView: (id, opts) => {
        const changeCheckbox = new EventEmitter();
        const visibility = new EventEmitter();
        const view = { id, provider: opts.treeDataProvider, onDidChangeCheckboxState: changeCheckbox.event, fireCheckbox: (items) => changeCheckbox.fire({ items }), onDidChangeVisibility: visibility.event, show: () => visibility.fire({ visible: true }), message: undefined, dispose() {} };
        trees[id] = view;
        return view;
      },
      createStatusBarItem: () => ({ text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
      showInformationMessage: message('info'),
      showWarningMessage: message('warn'),
      showErrorMessage: message('error'),
      showQuickPick: async (items, opts) => {
        shown.picks.push({ items, opts });
        const v = next('pick', opts && opts.placeHolder);
        if (v === undefined) return undefined;
        return items.find((i) => i.value === v || i.label === v);
      },
      showInputBox: async (opts) => { shown.inputs.push(opts); return next('input', opts && opts.prompt); },
      withProgress: async (opts, fn) => {
        const cancel = new EventEmitter();
        const token = { isCancellationRequested: false, onCancellationRequested: cancel.event };
        const rec = { title: opts.title, messages: [], cancel: () => { token.isCancellationRequested = true; cancel.fire(); } };
        shown.progress.push(rec);
        return fn({ report: (r) => rec.messages.push(r.message) }, token);
      },
      createWebviewPanel: (type, title, column, options) => {
        const fromUi = new EventEmitter(); const disposed = new EventEmitter();
        const p = {
          type, title, options, revealed: 0, sent: [],
          webview: {
            html: '', cspSource: 'vscode-resource:',
            asWebviewUri: (u) => ({ toString: () => `vscode-resource:${u.fsPath}` }),
            onDidReceiveMessage: fromUi.event,
            postMessage: async (m) => { p.sent.push(m); return true; },
          },
          reveal() { this.revealed++; },
          onDidDispose: disposed.event,
          // test helpers: act as the page
          fromPage: (m) => fromUi.fire(m),
          close: () => disposed.fire(),
        };
        shown.panels.push(p);
        return p;
      },
      registerUriHandler: (h) => { vscode._uriHandler = h; return { dispose() {} }; },
      showSaveDialog: async () => next('save', 'save dialog'),
      activeTextEditor: undefined,
      terminals: [],
      createTerminal: (opts) => { const t = { name: opts.name, cwd: opts.cwd, sent: [], show() {}, sendText(x) { this.sent.push(x); } }; shown.terminals.push(t); vscode.window.terminals.push(t); return t; },
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; },
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') { contexts[args[0]] = args[1]; return; }
        const fn = commands.get(id);
        if (!fn) return undefined; // built-in commands
        return fn(...args);
      },
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
      findFiles: async () => (workspaceRoot ? [Uri.file(path.join(workspaceRoot, 'sitecore.json'))] : []),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      createFileSystemWatcher: () => {
        const w = { handlers: [], onDidChange(fn) { this.handlers.push(fn); }, onDidCreate(fn) { this.handlers.push(fn); }, fire() { this.handlers.forEach((h) => h()); }, dispose() {} };
        vscode._watchers.push(w); return w;
      },
    },
    env: { openExternal: async () => true },
  };

  return { vscode, commands, contexts, shown, answer, trees, answersLeft: () => answers.length };
}

/** Make require('vscode') return the fake, for code loaded after this call. */
function installFake(fake) {
  const orig = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return fake.vscode;
    return orig.call(this, request, parent, isMain);
  };
  return () => { Module._load = orig; };
}

module.exports = { createFake, installFake };
