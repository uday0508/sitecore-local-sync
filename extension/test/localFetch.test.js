'use strict';

// Real TLS: a local HTTPS server whose certificate is signed by a private CA (like mkcert).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { createLocalFetch, extraCaBundle } = require('../src/localFetch');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-'));
const f = (n) => path.join(dir, n);
const ssl = (...a) => execFileSync('openssl', a, { stdio: 'ignore' });
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('rootCA.pem'), '-days', '2', '-subj', '/CN=Test Dev CA');
ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('cm.key'), '-out', f('cm.csr'), '-subj', '/CN=xmcloudcm.localhost');
fs.writeFileSync(f('ext.cnf'), 'subjectAltName=DNS:xmcloudcm.localhost,DNS:localhost,IP:127.0.0.1\n');
ssl('x509', '-req', '-in', f('cm.csr'), '-CA', f('rootCA.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('cm.pem'), '-days', '2', '-extfile', f('ext.cnf'));

let server; let port; let hits = 0; let hang = false;
test.before(async () => {
  server = https.createServer({ key: fs.readFileSync(f('cm.key')), cert: fs.readFileSync(f('cm.pem')) }, (req, res) => {
    hits++;
    if (hang) return; // never answer
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: { echo: body, auth: req.headers.authorization } })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(() => server.close());

const url = () => `https://localhost:${port}/sitecore/api/authoring/graphql/v1/`;
const post = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: '{"query":"{ x }"}' };

test('an untrusted dev certificate fails with a clear message, never by turning checks off', async () => {
  const fetch = createLocalFetch({ candidates: [] });
  await assert.rejects(fetch(url(), post), (e) => e.code === 'LOCAL_CERT_UNTRUSTED' && /devsync\.localCaCertificate/.test(e.message));
});

test('with the CA configured (or found where mkcert keeps it) the request succeeds', async () => {
  const logs = [];
  const fetch = createLocalFetch({ getConfiguredCa: () => f('rootCA.pem'), candidates: [], log: (m) => logs.push(m) });
  const res = await fetch(url(), post);
  assert.equal(res.status, 200);
  const json = JSON.parse(await res.text());
  assert.equal(json.data.echo, post.body);
  assert.equal(json.data.auth, 'Bearer t');
  assert.match(logs[0], /rootCA\.pem/);
  // mkcert's default location is found without any setting:
  const fetch2 = createLocalFetch({ candidates: [f('rootCA.pem')] });
  assert.equal((await fetch2(url(), post)).status, 200);
});

test('refuses to send anything to a non-local host', async () => {
  const fetch = createLocalFetch({});
  await assert.rejects(fetch('https://xmc-acme-prod.sitecorecloud.io/x', post), /Refusing/);
});

test('a broken configured CA path is reported, not ignored', async () => {
  const fetch = createLocalFetch({ getConfiguredCa: () => f('missing.pem'), candidates: [] });
  await assert.rejects(fetch(url(), post), /devsync\.localCaCertificate/);
});

test('abort signals stop a request that never answers', async () => {
  hang = true;
  try {
    const fetch = createLocalFetch({ getConfiguredCa: () => f('rootCA.pem'), candidates: [] });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    await assert.rejects(fetch(url(), { ...post, signal: ac.signal }), (e) => e.name === 'AbortError');
    assert.ok(Date.now() - t0 < 2000);
  } finally { hang = false; server.closeAllConnections(); }
});

test('the bundle includes Node roots plus the extra PEM files', () => {
  const b = extraCaBundle({ configuredPath: f('rootCA.pem'), candidates: [] });
  assert.ok(b.ca.length > 50);
  assert.ok(b.sources.includes(f('rootCA.pem')));
});

test('the engine\'s Authoring API client works over this fetch against the local CM', async () => {
  const { AuthoringClient } = require('../../src/core/graphql');
  const fetch = createLocalFetch({ getConfiguredCa: () => f('rootCA.pem'), candidates: [] });
  const client = new AuthoringClient({ host: `https://localhost:${port}`, tokenProvider: { getToken: async () => 'tok' }, fetchImpl: fetch, allowWrite: true });
  const data = await client.query('query { x }');
  assert.equal(data.auth, 'Bearer tok');
});
