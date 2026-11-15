'use strict';

const { bracedId, normId, NULL_ID } = require('./util');

const ITEM_FIELDS = 'itemId name path template { name templateId }';

/**
 * Read-only client for the SitecoreAI Authoring and Management GraphQL API:
 *   https://<cm-host>/sitecore/api/authoring/graphql/v1/
 * DevSync only reads from the cloud. Mutations are refused here as a hard safety rule.
 */
class AuthoringClient {
  constructor({ host, tokenProvider, fetchImpl = fetch, database = 'master', log = () => {}, allowWrite = false }) {
    if (!host) throw new Error('CM host is required.');
    const base = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    // Writes are only ever allowed against a local CM. Cloud clients are strictly read-only.
    if (allowWrite && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]*\.localhost)(:\d+)?(\/|$)/i.test(base)) {
      throw new Error('Refusing write access to a non-local CM.');
    }
    this.allowWrite = allowWrite;
    this.endpoint = `${base.replace(/\/+$/, '')}/sitecore/api/authoring/graphql/v1/`;
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImpl;
    this.database = database;
    this.log = log;
    this.supportsHasChildren = true;
  }

  async query(query, variables = {}, attempt = 0) {
    if (/^\s*mutation\b/i.test(query) && !this.allowWrite) throw new Error('DevSync is read-only against cloud environments: mutations are blocked.');
    const token = await this.tokenProvider.getToken(attempt > 0);
    let res;
    try {
      res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      throw new Error(`Can't reach ${new URL(this.endpoint).host}. Check your internet connection or VPN, and that the environment is running. (${e.cause?.code || e.message})`);
    }
    if (res.status === 401 && attempt === 0) return this.query(query, variables, 1);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = 500 * 2 ** attempt;
      this.log(`API returned ${res.status}, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return this.query(query, variables, attempt + 1);
    }
    const text = await res.text();
    if (res.status === 404) throw new Error(`No Authoring API found at ${this.endpoint} (404). Check that this endpoint is a SitecoreAI CM environment host (xmc-....sitecorecloud.io).`);
    if (res.status === 403) throw new Error('Access denied (403). Your login or automation client has no access to this environment.');
    let json; try { json = JSON.parse(text); } catch { throw new Error(`Authoring API returned non-JSON (${res.status}): ${text.slice(0, 200) || 'empty response'}`); }
    if (!res.ok && !json.data) throw new Error(`Authoring API error ${res.status}: ${text.slice(0, 300)}`);
    if (json.errors && json.errors.length && !json.data) {
      const err = new Error(json.errors.map((e) => e.message).join('; '));
      err.graphqlErrors = json.errors;
      throw err;
    }
    return json.data;
  }

  async listSites() {
    const data = await this.query('query { sites { name rootPath rootItem { itemId } } }');
    return (data.sites || []).map((s) => ({ name: s.name, rootPath: s.rootPath, rootId: normId(s.rootItem && s.rootItem.itemId) }));
  }

  _nodeFields() {
    return `itemId name path ${this.supportsHasChildren ? 'hasChildren' : ''} template { name templateId }
      updated: field(name: "__Updated") { value }`;
  }

  /** One item plus its direct children, for the tree picker. */
  async getItemWithChildren({ path, id, language = 'en' }) {
    const where = id ? `itemId: ${JSON.stringify(bracedId(id))}` : `path: ${JSON.stringify(path)}`;
    const q = `query { item(where: { database: ${JSON.stringify(this.database)}, ${where}, language: ${JSON.stringify(language)} }) {
      ${this._nodeFields()}
      children { nodes { ${this._nodeFields()} } }
    } }`;
    try {
      const data = await this.query(q);
      return data.item ? shapeItem(data.item, true) : null;
    } catch (e) {
      if (this.supportsHasChildren && /hasChildren/i.test(e.message)) {
        this.supportsHasChildren = false; // Older schema: fall back and let the UI treat nodes as expandable.
        return this.getItemWithChildren({ path, id, language });
      }
      throw e;
    }
  }

  /**
   * Resolve many IDs to { id, name, path, template, templateId }. Unknown IDs map to null.
   * Batched for speed. One bad ID (e.g. a deleted item) can make the API reject a whole batch,
   * so failed or empty answers are retried one by one, then with a language, then via the index.
   */
  async resolveIds(ids, { batchSize = 25 } = {}) {
    const list = [...new Set([...ids].map(normId))].filter((x) => x.length === 32 && x !== NULL_ID);
    const out = new Map();
    const shape = (it) => (it ? { id: normId(it.itemId), name: it.name, path: it.path, template: it.template && it.template.name, templateId: normId(it.template && it.template.templateId) } : null);
    for (let i = 0; i < list.length; i += batchSize) {
      const chunk = list.slice(i, i + batchSize);
      const body = chunk.map((id, j) => `i${j}: item(where: { database: ${JSON.stringify(this.database)}, itemId: ${JSON.stringify(bracedId(id))} }) { ${ITEM_FIELDS} }`).join('\n');
      let data = null;
      try { data = await this.query(`query {\n${body}\n}`); } catch (e) { if (!e.graphqlErrors) throw e; }
      for (let j = 0; j < chunk.length; j++) {
        const hit = data && data[`i${j}`];
        out.set(chunk[j], hit ? shape(hit) : await this.resolveOne(chunk[j]).then(shape));
      }
    }
    return out;
  }

  async resolveOne(id) {
    const attempts = [
      `item(where: { database: ${JSON.stringify(this.database)}, itemId: ${JSON.stringify(bracedId(id))} }) { ${ITEM_FIELDS} }`,
      `item(where: { database: ${JSON.stringify(this.database)}, itemId: ${JSON.stringify(bracedId(id))}, language: "en" }) { ${ITEM_FIELDS} }`,
    ];
    for (const a of attempts) {
      try { const d = await this.query(`query { x: ${a} }`); if (d && d.x) return d.x; } catch (e) { if (!e.graphqlErrors) throw e; }
    }
    try {
      const d = await this.query(`query { search(query: { index: "sitecore_master_index", searchStatement: { criteria: [ { operator: MUST, field: "_group", value: ${JSON.stringify(normId(id))} } ] } }) { results { innerItem { ${ITEM_FIELDS} } } } }`);
      const r = d && d.search && d.search.results && d.search.results.find((x) => x.innerItem && normId(x.innerItem.itemId) === normId(id));
      if (r) return r.innerItem;
    } catch (e) { if (!e.graphqlErrors) throw e; }
    return null;
  }

  /** Resolve item paths to { id, path, templateId }, batched, with a one-by-one retry if a batch is rejected. */
  async resolvePaths(paths, { batchSize = 25 } = {}) {
    const list = [...new Set(paths)];
    const out = new Map();
    const shape = (it) => (it ? { id: normId(it.itemId), path: it.path, templateId: normId(it.template && it.template.templateId) } : null);
    const q = (p) => `item(where: { database: ${JSON.stringify(this.database)}, path: ${JSON.stringify(p)} }) { itemId path template { templateId } }`;
    for (let i = 0; i < list.length; i += batchSize) {
      const chunk = list.slice(i, i + batchSize);
      let data = null;
      try { data = await this.query(`query {\n${chunk.map((p, j) => `p${j}: ${q(p)}`).join('\n')}\n}`); } catch (e) { if (!e.graphqlErrors) throw e; }
      for (let j = 0; j < chunk.length; j++) {
        let hit = data ? data[`p${j}`] : undefined;
        if (hit === undefined) { try { const d = await this.query(`query { x: ${q(chunk[j])} }`); hit = d && d.x; } catch (e) { if (!e.graphqlErrors) throw e; hit = null; } }
        out.set(chunk[j], shape(hit));
      }
    }
    return out;
  }

  /** Local CM only: move an item (and its subtree) to the Recycle Bin, or delete it permanently. */
  async deleteItem(id, { permanently = false } = {}) {
    if (!this.allowWrite) throw new Error('deleteItem is only available on the local CM.');
    const data = await this.query(`mutation { deleteItem(input: { itemId: ${JSON.stringify(bracedId(id))}, permanently: ${permanently ? 'true' : 'false'} }) { successful } }`);
    if (!data.deleteItem || !data.deleteItem.successful) throw new Error(`The local CM did not delete item ${id}.`);
    return true;
  }

  /** All field values stored on an item (including standard fields such as __Final Renderings). */
  async getItemFields(id, language = 'en') {
    const q = `query { item(where: { database: ${JSON.stringify(this.database)}, itemId: ${JSON.stringify(bracedId(id))}, language: ${JSON.stringify(language)} }) {
      itemId path template { templateId }
      fields(ownFields: true) { nodes { name value } }
    } }`;
    const data = await this.query(q);
    if (!data.item) return null;
    return {
      id: normId(data.item.itemId),
      path: data.item.path,
      templateId: normId(data.item.template && data.item.template.templateId),
      fields: (data.item.fields && data.item.fields.nodes) || [],
    };
  }

  /**
   * Items under rootId, newest-updated first, using the master index.
   * Calls onPage(results) and stops when onPage returns false.
   */
  /**
   * With `language`, only index documents of that language version are returned. The index keeps
   * one document per language version, so its __Updated is that version's own date.
   */
  async searchUpdatedUnder(rootId, onPage, { pageSize = 100, maxPages = 50, language = null } = {}) {
    const criteria = [`{ operator: MUST, field: "_path", value: ${JSON.stringify(normId(rootId))} }`];
    if (language) criteria.push(`{ operator: MUST, field: "_language", value: ${JSON.stringify(String(language).toLowerCase())} }`);
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const q = `query { search(query: {
          index: "sitecore_master_index"
          sort: { field: "__smallupdateddate", direction: DESCENDING }
          paging: { pageSize: ${pageSize}, pageIndex: ${pageIndex} }
          searchStatement: { criteria: [ ${criteria.join(', ')} ] }
        }) { totalCount results { innerItem { itemId path updated: field(name: "__Updated") { value } created: field(name: "__Created") { value } } } } }`;
      const data = await this.query(q);
      const results = ((data.search && data.search.results) || []).map((r) => r.innerItem).filter(Boolean).map((it) => ({
        id: normId(it.itemId), path: it.path, updated: it.updated && it.updated.value, created: it.created && it.created.value,
      }));
      const keepGoing = onPage(results);
      if (keepGoing === false || results.length < pageSize) return;
    }
  }
}

/** Language names defined in the CM (children of /sitecore/system/Languages). */
AuthoringClient.prototype.listLanguages = async function listLanguages() {
  const node = await this.getItemWithChildren({ path: '/sitecore/system/Languages' });
  const names = ((node && node.children) || []).map((c) => c.name).filter((n) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(n));
  return names.length ? names : ['en'];
};

function shapeItem(it, withChildren) {
  const node = {
    id: normId(it.itemId),
    name: it.name,
    path: it.path,
    hasChildren: it.hasChildren === undefined ? null : !!it.hasChildren,
    template: it.template && it.template.name,
    templateId: normId(it.template && it.template.templateId),
    updated: it.updated && it.updated.value,
  };
  if (withChildren && it.children) node.children = (it.children.nodes || []).map((c) => shapeItem(c, false));
  return node;
}

module.exports = { AuthoringClient };
