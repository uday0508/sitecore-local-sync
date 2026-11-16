'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readItemHeader } = require('../src/yamlItem');
const { parseSyncLink, hostOf } = require('../src/deepLink');

test('reads ID and Path from a serialized item, ignoring nested field IDs', () => {
  const h = readItemHeader(`﻿---\nID: "3f6c0d2e-1111-2222-3333-444455556666"\nParent: "9a1b0d2e-1111-2222-3333-444455556666"\nTemplate: "7e2d0d2e-1111-2222-3333-444455556666"\nPath: /sitecore/content/Acme/Home\nSharedFields:\n- ID: "04bf00db-f5fb-41f7-8ab7-22408372a981"\n  Hint: __Final Renderings\n`);
  assert.equal(h.id, '3f6c0d2e111122223333444455556666');
  assert.equal(h.path, '/sitecore/content/Acme/Home');
});

test('rejects files that are not serialized items', () => {
  assert.throws(() => readItemHeader('name: my-app\nversion: 1\n'), /not a serialized Sitecore item/);
  assert.throws(() => readItemHeader('ID: "3f6c0d2e-1111-2222-3333-444455556666"\n'), /no Sitecore item path/);
});

test('deep links: only SitecoreAI hosts, valid IDs, languages and scopes', () => {
  const ok = parseSyncLink({ path: '/sync', query: 'host=https://xmc-acme-prod.sitecorecloud.io/&item={3F6C0D2E-1111-2222-3333-444455556666}&lang=fr-FR&scope=ItemAndDescendants' });
  assert.deepEqual(ok, { host: 'xmc-acme-prod.sitecorecloud.io', id: '3f6c0d2e111122223333444455556666', language: 'fr-FR', scope: 'ItemAndDescendants' });
  const base = 'item=3f6c0d2e111122223333444455556666';
  assert.throws(() => parseSyncLink({ path: '/sync', query: `host=sitecorecloud.io.evil.com&${base}` }), /SitecoreAI environment/);
  assert.throws(() => parseSyncLink({ path: '/sync', query: `host=xmc-a.sitecorecloud.io&${base}&lang=en;rm` }), /language/);
  assert.throws(() => parseSyncLink({ path: '/sync', query: `host=xmc-a.sitecorecloud.io&${base}&scope=CreateUpdateAndDelete` }), /scope/);
  assert.throws(() => parseSyncLink({ path: '/delete', query: base }), /Unknown DevSync link/);
  assert.equal(hostOf('https://XMC-A.sitecorecloud.io/'), 'xmc-a.sitecorecloud.io');
});
