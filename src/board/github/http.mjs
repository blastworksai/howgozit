import { BackendError, codeOfStatus } from '../model/adapter.mjs';

export const API_BASE = 'https://api.github.com';

const MESSAGES = {
  auth: 'GitHub did not accept the token.',
  'not-found': 'GitHub could not find that address.',
  'rate-limit': 'GitHub is limiting requests right now; try again later.',
  network: 'GitHub could not be reached.',
  invalid: 'GitHub did not accept that request.',
  server: 'GitHub had a problem answering.',
};

export class GitHubError extends BackendError {
  constructor(kind, status, message) {
    super(kind === 'rate-limit' ? 'rate-limited' : codeOfStatus(status), status, message || MESSAGES[kind]);
    this.name = 'GitHubError';
    this.kind = kind;
  }
}

const MOVED = 'GitHub sent the request somewhere else, and the board did not follow.';

function kindFor(res) {
  const s = res.status;
  const limited = res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') != null;
  if (s === 401) return 'auth';
  if (s === 429 || (s === 403 && limited)) return 'rate-limit';
  if (s === 403) return 'auth';
  if (s === 404) return 'not-found';
  if (s >= 400 && s < 500) return 'invalid';
  return 'server';
}

function nextLink(link) {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]*)>\s*;(.*)/.exec(part.trim());
    if (m && /rel\s*=\s*"?next"?/.test(m[2])) return m[1];
  }
  return null;
}

function toUrl(path) {
  return path.startsWith('/') ? API_BASE + path : path;
}

export function createHttp({ token, fetch, etags }) {
  async function request(url, init) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'board',
      ...(init.headers || {}),
    };
    let origin = null;
    try { origin = new URL(url).origin; } catch { origin = null; }
    if (origin !== API_BASE) throw new GitHubError('invalid', 0);
    let res;
    try {
      res = await fetch(url, { ...init, redirect: 'manual', headers, signal: AbortSignal.timeout(10000) });
    } catch {
      throw new GitHubError('network', 0);
    }
    return res;
  }

  async function body(res) {
    try {
      return await res.json();
    } catch {
      throw new GitHubError('server', res.status, 'GitHub sent an answer that could not be read.');
    }
  }

  async function get(path) {
    const url = toUrl(path);
    const stored = etags ? etags.get(url) : undefined;
    const headers = stored ? { 'If-None-Match': stored.etag } : {};
    let res = await request(url, { method: 'GET', headers });
    let at = url;
    for (let hops = 0; res.status >= 300 && res.status < 400 && res.status !== 304; hops += 1) {
      const loc = res.headers.get('location');
      let next = null;
      try { if (loc && hops < 3) next = new URL(loc, at); } catch { next = null; }
      if (!next || next.origin !== API_BASE) throw new GitHubError('server', res.status, MOVED);
      at = next.href;
      res = await request(at, { method: 'GET', headers });
    }
    const link = res.headers.get('link') || null;
    if (res.status === 304) {
      if (!stored) throw new GitHubError('server', 304, 'GitHub sent no new data and nothing was stored.');
      return { status: 200, json: stored.body, notModified: true, link };
    }
    if (!res.ok) throw new GitHubError(kindFor(res), res.status);
    const json = await body(res);
    const etag = res.headers.get('etag');
    if (etag && etags) etags.set(url, etag, json);
    return { status: 200, json, notModified: false, link };
  }

  async function paged(path, { maxPages }) {
    const items = [];
    let url = path;
    let requests = 0;
    while (url) {
      if (requests >= maxPages) return { items, partial: true };
      const page = await get(url);
      requests += 1;
      const json = page.json;
      const list = Array.isArray(json) ? json : (json && Array.isArray(json.items) ? json.items : []);
      items.push(...list);
      const next = nextLink(page.link);
      url = null;
      if (next) {
        let origin = null;
        try { origin = new URL(next).origin; } catch { origin = null; }
        if (origin === API_BASE) url = next;
      }
    }
    return { items, partial: false };
  }

  async function send(method, path, payload) {
    const res = await request(toUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status >= 300 && res.status < 400) throw new GitHubError('server', res.status, MOVED);
    if (!res.ok) throw new GitHubError(kindFor(res), res.status);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GitHubError('server', res.status, 'GitHub sent an answer that could not be read.');
    }
  }

  async function graphql(query, variables) {
    const out = await send('POST', '/graphql', { query, variables });
    if (out && Array.isArray(out.errors) && out.errors.length) {
      const first = out.errors[0] || {};
      const m = first.message;
      const kind = first.type === 'NOT_FOUND' ? 'not-found' : 'invalid';
      throw new GitHubError(kind, 200, typeof m === 'string' && m ? m : MESSAGES[kind]);
    }
    return out ? out.data : undefined;
  }

  return { get, paged, send, graphql };
}
