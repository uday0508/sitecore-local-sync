'use strict';

const DEFAULT_AUTHORITY = 'https://auth.sitecorecloud.io';
const DEFAULT_AUDIENCE = 'https://api.sitecorecloud.io';

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

function isFresh(token, skewMs = 60_000) {
  if (!token) return false;
  const exp = jwtExpiry(token);
  return exp == null ? true : exp - skewMs > Date.now();
}

async function postToken(fetchImpl, authority, body) {
  const url = `${String(authority || DEFAULT_AUTHORITY).replace(/\/+$/, '')}/oauth/token`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`The Sitecore login service (${new URL(url).host}) did not answer within 30 seconds. Try again.`);
    throw new Error(`Can't reach the Sitecore login service (${new URL(url).host}). Check your internet connection or VPN. (${e.cause?.code || e.message})`);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = {}; }
  if (!res.ok || !json.access_token) {
    const why = json.error_description || json.error || text.slice(0, 200);
    if ([400, 401, 403].includes(res.status) && body && body.grant_type === 'refresh_token') {
      const e = new Error('Your Sitecore CLI login has expired. Run "dotnet sitecore cloud login" in the project folder, then connect again.');
      e.code = 'LOGIN_EXPIRED'; e.detail = why;
      throw e;
    }
    if ([400, 401, 403].includes(res.status) && body && body.grant_type === 'client_credentials') {
      const e = new Error(`The automation client was rejected (${why}). Check the client ID and secret, and that the client belongs to this organization.`);
      e.code = 'CLIENT_REJECTED';
      throw e;
    }
    throw new Error(`Token request failed (${res.status}): ${why}`);
  }
  return json;
}

/**
 * Token from an environment automation client (Deploy app > Credentials > Environment > Automation).
 * This is the recommended mode: read-only use, no interactive login, the token lasts about 24 hours.
 */
function automationClientProvider({ clientId, clientSecret, authority = DEFAULT_AUTHORITY, audience = DEFAULT_AUDIENCE, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) throw new Error('Client ID and client secret are required for automation-client auth.');
  let cached = null;
  return {
    mode: 'automation',
    async getToken(force = false) {
      if (!force && cached && isFresh(cached)) return cached;
      const json = await postToken(fetchImpl, authority, {
        client_id: clientId, client_secret: clientSecret, audience, grant_type: 'client_credentials',
      });
      cached = json.access_token;
      return cached;
    },
  };
}

/**
 * Reuses the token the Sitecore CLI stored in .sitecore/user.json after "dotnet sitecore cloud login".
 * If it has expired, we try a refresh_token grant *in memory only*. We never write user.json here.
 */
function cliSessionProvider({ endpoint, fetchImpl = fetch }) {
  if (!endpoint) throw new Error('No endpoint selected.');
  let access = endpoint.accessToken || null;
  return {
    mode: 'cli',
    async getToken(force = false) {
      if (!force && isFresh(access)) return access;
      if (endpoint.refreshToken && endpoint.clientId) {
        const json = await postToken(fetchImpl, endpoint.authority, {
          grant_type: 'refresh_token', client_id: endpoint.clientId, refresh_token: endpoint.refreshToken,
        });
        access = json.access_token;
        return access;
      }
      if (access) return access; // No expiry info, so try it anyway.
      throw new Error('No CLI session token found. Run "dotnet sitecore cloud login" in your project folder, or use an automation client.');
    },
  };
}

module.exports = { automationClientProvider, cliSessionProvider, jwtExpiry, isFresh, DEFAULT_AUTHORITY, DEFAULT_AUDIENCE };
