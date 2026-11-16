'use strict';

/**
 * vscode://<publisher>.devsync-sitecoreai/sync?host=<cm host>&item=<id>&lang=<code>&scope=<scope>
 *
 * Used by the Sitecore Marketplace "Sync this page" panel. Links are untrusted input: every
 * value is validated, nothing runs automatically, and the user always confirms the sync.
 */
const SCOPES = new Set(['SingleItem', 'ItemAndChildren', 'ItemAndDescendants']);
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sitecorecloud\.io$/i;
const GUID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function parseSyncLink(uri) {
  const p = String(uri.path || '').replace(/^\/+/, '');
  if (p !== 'sync') throw new Error(`Unknown DevSync link "${p}".`);
  const q = new URLSearchParams(uri.query || '');
  const host = String(q.get('host') || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  const item = String(q.get('item') || '');
  const lang = String(q.get('lang') || 'en');
  const scope = String(q.get('scope') || 'SingleItem');
  if (!HOST.test(host)) throw new Error('The link does not point to a SitecoreAI environment (*.sitecorecloud.io).');
  if (!GUID.test(item)) throw new Error('The link has no valid item ID.');
  if (!LANG.test(lang)) throw new Error('The link has an invalid language code.');
  if (!SCOPES.has(scope)) throw new Error('The link has an invalid scope.');
  return { host, id: item.replace(/[{}-]/g, '').toLowerCase(), language: lang, scope };
}

function hostOf(url) {
  try { return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.toLowerCase(); } catch { return ''; }
}

module.exports = { parseSyncLink, hostOf, SCOPES };
