'use strict';

/*
 * A small fetch() for the LOCAL CM (https://*.localhost), built on Node's https module.
 *
 * The local Docker CM uses a development certificate (usually from mkcert). The Electron app
 * trusts it through Chromium's certificate store. Inside VS Code's extension host, Node's fetch
 * only knows Node's bundled roots, so the certificate fails verification.
 *
 * Strategy, in order, and never by turning verification off:
 *   1. Plain https request. VS Code patches https to also trust the OS certificate store
 *      (setting "http.systemCertificates", on by default), which is where mkcert -install puts its root.
 *   2. On a certificate error, retry with an explicit CA list: Node's roots, the OS store
 *      (tls.getCACertificates('system') on newer Node), mkcert's rootCA.pem from its usual
 *      locations, and the file in the "devsync.localCaCertificate" setting.
 *   3. Still failing: a clear error that names the setting.
 * Only hosts that are local (localhost, 127.0.0.1, [::1], *.localhost) are ever sent here.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { CancelledError } = require('../../src/core/util');

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1|.*\.localhost)$/i;
const CERT_ERRORS = /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_|DEPTH_ZERO|ERR_TLS/i;

function mkcertRootCandidates(env = process.env, platform = process.platform, home = os.homedir()) {
  const list = [];
  if (env.CAROOT) list.push(path.join(env.CAROOT, 'rootCA.pem'));
  if (platform === 'win32') list.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'mkcert', 'rootCA.pem'));
  else if (platform === 'darwin') list.push(path.join(home, 'Library', 'Application Support', 'mkcert', 'rootCA.pem'));
  else list.push(path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'mkcert', 'rootCA.pem'));
  return list;
}

/** Root certificates to trust for the local CM, plus where the extra ones came from. */
function extraCaBundle({ configuredPath = '', candidates = mkcertRootCandidates() } = {}) {
  const pems = [...tls.rootCertificates];
  const sources = [];
  try {
    if (typeof tls.getCACertificates === 'function') { pems.push(...tls.getCACertificates('system')); sources.push('OS certificate store'); }
  } catch { /* older Node: no system store API */ }
  const files = [configuredPath, ...candidates].filter(Boolean);
  for (const f of files) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
      if (blocks.length) { pems.push(...blocks); sources.push(f); }
      else if (f === configuredPath) throw new Error(`${f} contains no PEM certificate.`);
    } catch (e) {
      if (f === configuredPath && configuredPath) throw new Error(`Can't read devsync.localCaCertificate (${f}): ${e.message}`);
    }
  }
  return { ca: pems, sources };
}

function request(url, opts = {}, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const signal = opts.signal;
    if (signal && signal.aborted) return reject(abortError(signal));
    const lib = u.protocol === 'http:' ? http : https;
    const body = opts.body == null ? null : Buffer.from(String(opts.body));
    const headers = { ...(opts.headers || {}) };
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['Content-Length'] = body.length;
    const req = lib.request(u, { method: opts.method || 'GET', headers, ...(u.protocol === 'https:' ? tlsOptions : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
      res.on('error', reject);
    });
    const onAbort = () => req.destroy(abortError(signal));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    req.on('close', () => { if (signal) signal.removeEventListener('abort', onAbort); });
    if (body) req.write(body);
    req.end();
  });
}

function abortError(signal) {
  const r = signal && signal.reason;
  if (r && (r.name === 'TimeoutError' || r.name === 'AbortError')) return r;
  const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e;
}

/**
 * Returns fetch(url, opts) for the local CM. getConfiguredCa() is read on each certificate
 * failure, so a setting change applies without reloading.
 */
function createLocalFetch({ getConfiguredCa = () => '', candidates, log = () => {} } = {}) {
  let explicit = null; // once the explicit bundle was needed, keep using it
  return async function localFetch(url, opts = {}) {
    const host = new URL(url).hostname;
    if (!LOCAL.test(host)) throw new Error(`Refusing to send a local-CM request to ${host}.`);
    if (explicit) return request(url, opts, { ca: explicit });
    try {
      return await request(url, opts);
    } catch (e) {
      if (!CERT_ERRORS.test(`${e.code || ''} ${e.message}`)) throw e;
      const bundle = extraCaBundle({ configuredPath: getConfiguredCa(), candidates });
      log(`Local CM certificate not trusted by default (${e.code || e.message}). Retrying with: ${bundle.sources.join(', ') || 'Node roots only'}.`);
      try {
        const res = await request(url, opts, { ca: bundle.ca });
        explicit = bundle.ca;
        return res;
      } catch (e2) {
        if (!CERT_ERRORS.test(`${e2.code || ''} ${e2.message}`)) throw e2;
        const err = new Error(`DevSync can't verify the HTTPS certificate of ${host} (${e2.code || e2.message}). Run "mkcert -install" (or your project's init.ps1), or set "devsync.localCaCertificate" to the root certificate (rootCA.pem) that signed it.`);
        err.code = 'LOCAL_CERT_UNTRUSTED';
        throw err;
      }
    }
  };
}

module.exports = { createLocalFetch, extraCaBundle, mkcertRootCandidates, request, LOCAL, CancelledError };
