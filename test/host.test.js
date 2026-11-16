'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('../src/host/handlers');

function memHost() {
  let s = {};
  return createHost({ settings: { get: () => s, set: (p) => { s = { ...s, ...p }; return s; } }, secrets: { get: async () => null, set: async () => {} }, send: () => {} });
}

test('pane sizes are stored only as known CSS variables with pixel values', async () => {
  const host = memHost();
  const r = await host.handle('settings:set', { layout: { '--col-tree': '420px', '--row-tree': '300px', '--evil': '1px', '--tree-h': 'calc(100vh)', '--col-sync': '99999px' }, other: 'x' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.layout, { '--col-tree': '420px', '--row-tree': '300px' });
  assert.equal(r.data.other, undefined);
});

test('unknown requests are refused', async () => {
  const r = await memHost().handle('fs:rm', {});
  assert.equal(r.ok, false);
});
