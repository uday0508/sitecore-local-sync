'use strict';

// UI smoke test: loads the renderer in demo mode (no preload), drives the main flow and
// saves screenshots. Run with:  xvfb-run npx electron --no-sandbox test/ui-smoke.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'build', 'screenshots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 1920, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  // A hidden window paints lazily: invalidate, let a frame land, then capture.
  const shot = async (name) => {
    win.webContents.invalidate(); await wait(400); await win.webContents.capturePage();
    win.webContents.invalidate(); await wait(300);
    fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  };
  const checks = {};

  await wait(1800); // auto-open last project + auto-connect
  checks.autoConnected = await js(`document.getElementById('connDot').className.includes('ok') && !document.getElementById('connDialog').open`);
  checks.project = await js(`document.getElementById('projectName').textContent`);

  await js(`[...document.querySelectorAll('.chip')].find(c => c.textContent === 'Acme Global').click()`);
  await wait(700);
  await js(`(() => { const n = [...document.querySelectorAll('.node')].find(n => n.querySelector('.node-name').textContent === 'Home');
    n.querySelector('.node-name').click(); n.querySelector('input').click(); })()`);
  await wait(500);
  await shot('1-pick.png');

  await js(`document.getElementById('syncBtn').click()`);
  await wait(3500);
  checks.conflictDialogOpen = await js(`document.getElementById('conflictDialog').open`);
  await shot('2-conflict.png');
  await js(`document.querySelector('#conflictDialog button[value=replace]').click()`);
  await wait(4500);
  await shot('2-synced.png');
  checks.afterSync = await js(`({
    note: document.querySelector('#summary .big-note')?.textContent,
    attention: document.querySelector('#summary .attention')?.textContent,
    reportRows: document.querySelectorAll('#reportBody tbody tr').length,
    reportTabActive: document.querySelector('#tabs button[data-tab=report]').classList.contains('on'),
    steps: [...document.querySelectorAll('#steps li')].map(l => l.className).join(','),
    planRows: document.querySelectorAll('#planBody tbody tr').length,
    templates: [...document.querySelectorAll('#planBody tbody tr')].filter(r => r.textContent.includes('/sitecore/templates/Project')).length,
  })`);

  // Save as profile via the dialog, then use "only changes".
  await js(`document.getElementById('saveProfile').click()`);
  await wait(200);
  await js(`document.getElementById('profileNameInput').value = 'Homepage'; document.getElementById('nameSave').click()`);
  await wait(400);
  await js(`document.getElementById('syncBtn').click()`);
  await wait(5000);
  await js(`document.getElementById('optDelta').click()`);
  await js(`document.getElementById('previewBtn').click()`);
  await wait(1200);
  checks.delta = await js(`({ profile: document.getElementById('profileSelect').value, deltaEnabled: !document.getElementById('optDelta').disabled, note: document.querySelector('#summary .big-note')?.textContent })`);
  await shot('3-delta.png');

  // Lock + cancel: while a sync runs nothing can change, and Cancel always resets the button.
  await js(`document.getElementById('optDelta').click()`);
  const selBefore = await js(`document.getElementById('selCount').textContent`);
  await js(`document.getElementById('syncBtn').click()`);
  await wait(400);
  checks.locked = await js(`(() => {
    const cb = document.querySelector('#tree .node input[type=checkbox]:not(:checked)');
    if (cb) cb.click(); // must be ignored
    return {
      bodyLocked: document.body.classList.contains('locked'),
      treeInert: document.getElementById('tree').inert,
      profileDisabled: document.getElementById('profileSelect').disabled,
      projectDisabled: document.getElementById('projectPill').disabled,
      connDisabled: document.getElementById('connPill').disabled,
      cancelVisible: !document.getElementById('cancelBtn').classList.contains('hidden'),
      syncText: document.getElementById('syncBtn').textContent,
      selCount: document.getElementById('selCount').textContent,
    };
  })()`);
  checks.locked.selectionUnchanged = checks.locked.selCount === selBefore;
  await shot('7-locked.png');
  await js(`document.getElementById('cancelBtn').click()`);
  await wait(800);
  checks.cancelled = await js(`({
    note: document.querySelector('#summary .big-note')?.textContent,
    syncText: document.getElementById('syncBtn').textContent,
    syncEnabled: !document.getElementById('syncBtn').disabled,
    cancelHidden: document.getElementById('cancelBtn').classList.contains('hidden'),
    unlocked: !document.body.classList.contains('locked') && !document.getElementById('tree').inert,
    reportBadge: document.querySelector('#reportBody .badge')?.textContent,
  })`);
  await shot('8-cancelled.png');
  await js(`document.getElementById('connPill').click()`);
  await wait(300);
  await shot('4-connection.png');

  await js(`document.querySelector('#tabs button[data-tab=report]').click()`);
  await wait(200);
  await shot('6-report.png');
  await js(`document.getElementById('connDialog').close()`);
  win.setSize(1200, 900);
  await wait(500);
  await shot('5-narrow.png');
  console.log(JSON.stringify({ checks, errors }, null, 2));
  const l = checks.locked; const c = checks.cancelled;
  const lockOk = l.bodyLocked && l.treeInert && l.profileDisabled && l.projectDisabled && l.connDisabled && l.cancelVisible && l.selectionUnchanged;
  const cancelOk = c.note === 'Cancelled' && c.syncText === 'Sync to local' && c.syncEnabled && c.cancelHidden && c.unlocked;
  if (!lockOk || !cancelOk) console.log('LOCK/CANCEL CHECK FAILED');
  app.exit(errors.length || !lockOk || !cancelOk ? 1 : 0);
});
