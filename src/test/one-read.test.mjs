// Rule R108 (with R62, R91, R95): one action, at most one read of the page.
// The REAL board/static/board.js is read from disk and run inside node:vm against a small stand-in
// page (a mini DOM written in this file) and a stand-in `fetch` that behaves as a browser does about
// redirects. The server is a recording HTTP server on 127.0.0.1 that answers the way R62 says an
// action is answered; every count below is taken from that server's own log, never from the script.
// If a test goes red with "HARNESS:" in the message, the stand-in lacks an API: fix the harness, not the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, '..', 'board', 'static', 'board.js');
const SCRIPT_SRC = readFileSync(SCRIPT_PATH, 'utf8'); // the real file, read each run of this module

// =====================================================================================
// Recording server: the board's side of R62 (303 to / on success; a plain notice page on 400 / 502)
// =====================================================================================

const MESSAGES = {
  refuse: 'That tick was refused: the day is not open for ticks.',
  fail: 'GitHub is not answering right now, nothing was changed.',
};

function boardHtml(ticks) {
  return `<!doctype html><html><head><title>Board</title><style>.bar{width:${ticks * 10}%}</style></head><body>
<section data-section="habits"><h2>Habits</h2><p class="count">Ticks: ${ticks}</p>
<form action="/actions/habit" method="post"><input type="hidden" name="id" value="move"><input type="hidden" name="date" value="2026-10-12"><input type="hidden" name="on" value="1"><input type="hidden" name="token" value="t.n.m"><button type="submit">Tick</button></form></section>
<section data-section="capture"><h2>Ideas</h2><form action="/actions/idea" method="post"><input type="text" name="title"><input type="hidden" name="token" value="t.n.m"><button type="submit">Log</button></form></section>
</body></html>`;
}

function noticeHtml(title, message) {
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function startServer() {
  const log = [];
  const state = { ticks: 0, nextPost: [], readMode: 'board' }; // readMode: board | login | down
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const p = (req.url || '/').split('?')[0];
      const answer = (status, headers, text) => {
        log.push({ method: req.method, path: p, status, location: headers.location ?? null, body });
        res.writeHead(status, { connection: 'close', 'cache-control': 'no-store', ...headers });
        res.end(text);
      };
      const html = { 'content-type': 'text/html; charset=utf-8' };
      if (req.method === 'GET' && p === '/') {
        if (state.readMode === 'login') return answer(200, html, noticeHtml('Sign in', 'Please sign in to see the board.'));
        if (state.readMode === 'down') return answer(503, html, noticeHtml('Unavailable', 'The board is not available.'));
        return answer(200, html, boardHtml(state.ticks));
      }
      if (req.method === 'POST' && p === '/actions/habit') {
        const mode = state.nextPost.shift() ?? 'ok';
        if (mode === 'refuse') return answer(400, html, noticeHtml('Refused', MESSAGES.refuse));
        if (mode === 'fail') return answer(502, html, noticeHtml('GitHub failed', MESSAGES.fail));
        state.ticks += 1;
        return answer(303, { location: '/' }, '');
      }
      return answer(404, { 'content-type': 'text/plain' }, 'Not found.');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        base: `http://127.0.0.1:${port}/`,
        log,
        state,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
      });
    });
  });
}

function rawRequest(base, url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { host: u.host, connection: 'close', 'sec-fetch-site': 'same-origin', ...headers };
    if (method === 'POST') h.origin = new URL(base).origin;
    if (body !== null && body !== undefined) h['content-length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

// =====================================================================================
// Stand-in DOM: a tiny parser, tree and selector matcher. Not a browser.
// =====================================================================================

const gaps = []; // names of APIs the script asked for that the stand-in lacks
const gap = (what) => {
  gaps.push(what);
  return new Error(`HARNESS: the stand-in page lacks ${what}`);
};

const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
const RAW_TEXT = new Set(['style', 'script', 'textarea', 'title']);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const PROBES = new Set(['then', 'toJSON', 'constructor', 'asymmetricMatch', 'nodeType_', 'inspect', '$$typeof']);
const guardHandler = {
  get(t, prop, recv) {
    if (typeof prop === 'symbol' || prop in t || PROBES.has(prop)) return Reflect.get(t, prop, recv);
    throw gap(`${t.constructor.name}.${String(prop)}`);
  },
};

let BASE = 'http://127.0.0.1:1/';

class Txt {
  constructor(text) {
    this.nodeType = 3;
    this.data = text;
    this.parentNode = null;
  }
  get textContent() { return this.data; }
  cloneNode() { return new Txt(this.data); }
}

function toNodes(list) {
  return list.map((n) => (typeof n === 'string' ? new Txt(n) : n));
}
function detach(n) {
  if (n.parentNode) {
    const sib = n.parentNode.childNodes;
    const i = sib.indexOf(n);
    if (i >= 0) sib.splice(i, 1);
    n.parentNode = null;
  }
  return n;
}

// ---- selectors: tag, *, [a], [a="v"], :not([a]), .c, #id, descendant and child combinators, comma lists
const ATOM = /^(?:\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:not\(\[([\w-]+)\]\)|\.([\w-]+)|#([\w-]+))/;
function parseCompound(text) {
  const out = { tag: null, attrs: [], notAttrs: [], classes: [], id: null };
  let rest = text;
  const t = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (t) { out.tag = t[1] === '*' ? null : t[1].toLowerCase(); rest = rest.slice(t[1].length); }
  while (rest) {
    const m = ATOM.exec(rest);
    if (!m) throw gap(`selector syntax "${text}"`);
    if (m[1]) out.attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? null]);
    else if (m[5]) out.notAttrs.push(m[5]);
    else if (m[6]) out.classes.push(m[6]);
    else if (m[7]) out.id = m[7];
    rest = rest.slice(m[0].length);
  }
  return out;
}
const selCache = new Map();
function parseSelector(sel) {
  if (selCache.has(sel)) return selCache.get(sel);
  const groups = sel.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const chain = [];
    const re = /\s*>\s*|\s+/g;
    let last = 0;
    let comb = ' ';
    let m;
    while ((m = re.exec(part))) {
      chain.push({ comp: parseCompound(part.slice(last, m.index)), comb });
      comb = m[0].includes('>') ? '>' : ' ';
      last = m.index + m[0].length;
    }
    chain.push({ comp: parseCompound(part.slice(last)), comb });
    return chain;
  });
  selCache.set(sel, groups);
  return groups;
}
function matchComp(el, c) {
  if (el.nodeType !== 1) return false;
  if (c.tag && el.localName !== c.tag) return false;
  for (const [a, v] of c.attrs) {
    if (!el.hasAttribute(a)) return false;
    if (v !== null && el.getAttribute(a) !== v) return false;
  }
  for (const a of c.notAttrs) if (el.hasAttribute(a)) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  return true;
}
function matchChain(el, chain, i) {
  if (!matchComp(el, chain[i].comp)) return false;
  if (i === 0) return true;
  if (chain[i].comb === '>') return el.parentNode && el.parentNode.nodeType === 1 && matchChain(el.parentNode, chain, i - 1);
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchChain(p, chain, i - 1)) return true;
  return false;
}
const matchesSelector = (el, sel) => parseSelector(sel).some((chain) => matchChain(el, chain, chain.length - 1));
function* descendants(node) {
  for (const c of node.childNodes) {
    if (c.nodeType === 1) { yield c; yield* descendants(c); }
  }
}
const queryAll = (root, sel) => Array.from(descendants(root)).filter((el) => matchesSelector(el, sel));

class ClassList {
  constructor(el) { this.el = el; }
  _list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  contains(c) { return this._list().includes(c); }
  add(...c) { this.el.setAttribute('class', Array.from(new Set([...this._list(), ...c])).join(' ')); }
  remove(...c) { this.el.setAttribute('class', this._list().filter((x) => !c.includes(x)).join(' ')); }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this.add(c); else this.remove(c);
    return want;
  }
}

class El {
  constructor(tag, attrs = {}, doc = null) {
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.attrs = new Map(Object.entries(attrs));
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = doc;
    this._value = null;
    this.style = {};
    const proxy = new Proxy(this, guardHandler);
    this.classList = new ClassList(proxy);
    return proxy;
  }
  get tagName() { return this.localName.toUpperCase(); }
  get nodeName() { return this.tagName; }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get type() { return (this.getAttribute('type') || (this.localName === 'button' ? 'submit' : 'text')).toLowerCase(); }
  get name() { return this.getAttribute('name') || ''; }
  get value() {
    if (this._value !== null) return this._value;
    if (this.localName === 'textarea') return this.textContent;
    return this.getAttribute('value') ?? '';
  }
  set value(v) { this._value = String(v); }
  get checked() { return this._checked ?? this.hasAttribute('checked'); }
  set checked(v) { this._checked = Boolean(v); }
  get action() { return new URL(this.getAttribute('action') ?? '', BASE).href; }
  get method() { return (this.getAttribute('method') || 'get').toLowerCase(); }
  get dataset() {
    const el = this;
    const key = (k) => `data-${String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? el.getAttribute(key(k)) ?? undefined : undefined),
      set: (_t, k, v) => { el.setAttribute(key(k), String(v)); return true; },
      has: (_t, k) => el.hasAttribute(key(k)),
      deleteProperty: (_t, k) => { el.removeAttribute(key(k)); return true; },
    });
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.localName === '#document' || n.localName === 'html'; }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(String(n), String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  toggleAttribute(n, force) {
    const want = force === undefined ? !this.hasAttribute(n) : Boolean(force);
    if (want) this.setAttribute(n, ''); else this.removeAttribute(n);
    return want;
  }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  _siblings() { return this.parentNode ? this.parentNode.childNodes.filter((c) => c.nodeType === 1) : []; }
  get nextElementSibling() { const s = this._siblings(); return s[s.indexOf(this) + 1] ?? null; }
  get previousElementSibling() { const s = this._siblings(); const i = s.indexOf(this); return i > 0 ? s[i - 1] : null; }
  get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.childNodes; return s[s.indexOf(this) + 1] ?? null; }
  get previousSibling() { if (!this.parentNode) return null; const s = this.parentNode.childNodes; const i = s.indexOf(this); return i > 0 ? s[i - 1] : null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(String(v)); }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return this.childNodes.map((c) => serialize(c)).join(''); }
  set innerHTML(html) {
    const frag = parseHtml(String(html), this.ownerDocument);
    this.replaceChildren(...frag.childNodes.slice());
  }
  get outerHTML() { return serialize(this); }
  querySelector(sel) { return queryAll(this, sel)[0] ?? null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  matches(sel) { return matchesSelector(this, sel); }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesSelector(n, sel)) return n;
    return null;
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  appendChild(n) { detach(n); n.parentNode = this; this.childNodes.push(n); return n; }
  append(...ns) { toNodes(ns).forEach((n) => this.appendChild(n)); }
  prepend(...ns) { toNodes(ns).reverse().forEach((n) => { detach(n); n.parentNode = this; this.childNodes.unshift(n); }); }
  insertBefore(n, ref) {
    if (ref === null || ref === undefined) return this.appendChild(n);
    detach(n);
    const i = this.childNodes.indexOf(ref);
    n.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    return n;
  }
  removeChild(n) { if (n.parentNode === this) detach(n); return n; }
  replaceChild(nu, old) { this.insertBefore(nu, old); this.removeChild(old); return old; }
  replaceChildren(...ns) {
    this.childNodes.slice().forEach((c) => { c.parentNode = null; });
    this.childNodes.length = 0;
    this.append(...ns);
  }
  remove() { detach(this); }
  after(...ns) {
    const parent = this.parentNode;
    if (!parent) return;
    let ref = this.nextSibling;
    toNodes(ns).forEach((n) => { parent.insertBefore(n, ref); });
    void ref;
  }
  before(...ns) {
    const parent = this.parentNode;
    if (!parent) return;
    toNodes(ns).forEach((n) => parent.insertBefore(n, this));
  }
  replaceWith(...ns) {
    const parent = this.parentNode;
    if (!parent) return;
    const ref = this.nextSibling;
    detach(this);
    toNodes(ns).forEach((n) => parent.insertBefore(n, ref));
  }
  cloneNode(deep) {
    const c = new El(this.localName, Object.fromEntries(this.attrs), this.ownerDocument);
    if (this._value !== null) c._value = this._value;
    if (deep) this.childNodes.forEach((k) => c.appendChild(k.cloneNode(true)));
    return c;
  }
  focus() { if (this.ownerDocument) this.ownerDocument._active = this; }
  blur() { if (this.ownerDocument && this.ownerDocument._active === this) this.ownerDocument._active = null; }
  addEventListener() {}
  removeEventListener() {}
  submit() { PAGE_HOOKS.nativeSubmits.push({ action: this.action }); }
  scrollIntoView() {}
}
const PAGE_HOOKS = { nativeSubmits: [] };

function serialize(n) {
  if (n.nodeType === 3) return n.parentNode && RAW_TEXT.has(n.parentNode.localName) ? n.data : escText(n.data);
  const attrs = Array.from(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  if (VOID.has(n.localName)) return `<${n.localName}${attrs}>`;
  return `<${n.localName}${attrs}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
}

function parseHtml(text, doc) {
  const root = new El('#document', {}, doc);
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</gi;
  let m;
  const top = () => stack[stack.length - 1];
  while ((m = tokens.exec(text))) {
    const whole = m[0];
    if (whole.startsWith('<!')) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].localName === tag) { stack.length = i; break; }
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = {};
      const re = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = re.exec(m[3] || ''))) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const el = new El(tag, attrs, doc);
      top().appendChild(el);
      if (VOID.has(tag) || m[4]) continue;
      if (RAW_TEXT.has(tag)) {
        const end = text.toLowerCase().indexOf(`</${tag}`, tokens.lastIndex);
        const stop = end < 0 ? text.length : end;
        const raw = text.slice(tokens.lastIndex, stop);
        if (raw) el.appendChild(new Txt(tag === 'style' || tag === 'script' ? raw : decode(raw)));
        const close = text.indexOf('>', stop);
        tokens.lastIndex = close < 0 ? text.length : close + 1;
      } else {
        stack.push(el);
      }
    } else {
      top().appendChild(new Txt(decode(whole)));
    }
  }
  return root;
}

class Doc {
  constructor(html) {
    this._listeners = {};
    this._active = null;
    this.root = parseHtml(html, this);
    this.readyState = 'complete';
    const self = new Proxy(this, guardHandler);
    return self;
  }
  get documentElement() { return this.root.querySelector('html') ?? this.root; }
  get head() { return this.root.querySelector('head'); }
  get body() { return this.root.querySelector('body') ?? this.root; }
  get activeElement() { return this._active ?? this.body; }
  get childNodes() { return this.root.childNodes; }
  get nodeType() { return 9; }
  querySelector(sel) { return this.root.querySelector(sel); }
  querySelectorAll(sel) { return this.root.querySelectorAll(sel); }
  getElementById(id) { return this.root.querySelector(`#${id}`); }
  createElement(tag) { return new El(String(tag), {}, this); }
  createTextNode(t) { return new Txt(String(t)); }
  importNode(n, deep) { const c = n.cloneNode(Boolean(deep)); c.ownerDocument = this; return c; }
  adoptNode(n) { detach(n); return n; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  get textContent() { return this.root.textContent; }
}

// =====================================================================================
// Stand-in browser: fetch with real redirect semantics, location, FormData, DOMParser
// =====================================================================================

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function lowerHeaders(h) {
  const out = {};
  if (!h) return out;
  const pairs = typeof h.entries === 'function' ? Array.from(h.entries()) : Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of pairs) out[String(k).toLowerCase()] = String(v);
  return out;
}

function makeResponse(raw, url, redirected) {
  let used = false;
  const read = () => {
    if (used) return Promise.reject(new TypeError('HARNESS: body stream already read (a browser rejects a second text())'));
    used = true;
    return Promise.resolve(raw.body);
  };
  return {
    type: 'basic',
    status: raw.status,
    ok: raw.status >= 200 && raw.status <= 299,
    statusText: '',
    url: url.href,
    redirected,
    headers: { get: (n) => raw.headers[String(n).toLowerCase()] ?? null, has: (n) => String(n).toLowerCase() in raw.headers },
    get bodyUsed() { return used; },
    text: read,
    json: () => read().then((t) => JSON.parse(t)),
    clone: () => makeResponse(raw, url, redirected),
  };
}

function createPage(srv, { withScript = true } = {}) {
  BASE = srv.base;
  PAGE_HOOKS.nativeSubmits = [];
  gaps.length = 0;
  const page = { inflight: 0, reloads: 0, srv, nativeSubmits: PAGE_HOOKS.nativeSubmits, baseline: 0, doc: null };

  async function doFetch(input, init = {}) {
    let method = String(init.method || 'GET').toUpperCase();
    let url = new URL(String(input), srv.base);
    const redirect = init.redirect || 'follow';
    const headers = lowerHeaders(init.headers);
    let body = init.body === undefined || init.body === null ? null : String(init.body);
    if (body !== null && !headers['content-type'] && init.body instanceof URLSearchParams) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    if (url.origin !== new URL(srv.base).origin) throw new TypeError('HARNESS: stand-in fetch only reaches the board itself');
    let redirected = false;
    for (let hops = 0; hops < 20; hops++) {
      const raw = await rawRequest(srv.base, url.href, method, headers, body);
      if (REDIRECT_CODES.has(raw.status) && raw.headers.location) {
        if (redirect === 'manual') {
          return { type: 'opaqueredirect', status: 0, ok: false, statusText: '', url: url.href, redirected: false, headers: { get: () => null }, text: async () => '', json: async () => { throw new SyntaxError('empty'); } };
        }
        if (redirect === 'error') throw new TypeError('Failed to fetch (redirect mode is error)');
        if (raw.status === 303 || ((raw.status === 301 || raw.status === 302) && method === 'POST')) {
          method = 'GET';
          body = null;
          delete headers['content-type'];
        }
        url = new URL(raw.headers.location, url);
        redirected = true;
        continue;
      }
      return makeResponse(raw, url, redirected);
    }
    throw new TypeError('Failed to fetch (too many redirects)');
  }
  page.fetch = (input, init) => {
    page.inflight += 1;
    return doFetch(input, init).finally(() => { page.inflight -= 1; });
  };

  const rawDoc = null; void rawDoc;
  page.load = async () => {
    const first = await rawRequest(srv.base, srv.base, 'GET', {}, null);
    page.doc = new Doc(first.body);
    page.baseline = srv.log.length; // counts below start after the page's own load
  };

  page.location = {
    href: srv.base, origin: new URL(srv.base).origin, pathname: '/', search: '', hash: '', protocol: 'http:', host: new URL(srv.base).host,
    reload() {
      page.reloads += 1;
      page.inflight += 1;
      rawRequest(srv.base, srv.base, 'GET', {}, null).catch(() => {}).finally(() => { page.inflight -= 1; });
    },
    assign() { throw gap('location.assign'); },
    replace() { throw gap('location.replace'); },
    toString() { return srv.base; },
  };

  class FormDataStandIn {
    constructor(form, submitter) {
      if (!form || form.localName !== 'form') throw new TypeError('HARNESS: FormData needs a form element');
      this.list = [];
      for (const el of form.querySelectorAll('input, textarea, select, button')) {
        if (!el.name || el.disabled) continue;
        if (el.localName === 'button' || ['submit', 'button', 'image', 'file', 'reset'].includes(el.type)) continue;
        if (['checkbox', 'radio'].includes(el.type) && !el.checked) continue;
        this.list.push([el.name, el.value]);
      }
      if (submitter && submitter.name) this.list.push([submitter.name, submitter.value]);
    }
    [Symbol.iterator]() { return this.list[Symbol.iterator](); }
    entries() { return this.list[Symbol.iterator](); }
    get(k) { return this.list.find(([n]) => n === k)?.[1] ?? null; }
    getAll(k) { return this.list.filter(([n]) => n === k).map(([, v]) => v); }
    has(k) { return this.list.some(([n]) => n === k); }
    append(k, v) { this.list.push([k, String(v)]); }
  }
  page.FormData = FormDataStandIn;

  page.dispatchSubmit = (form, submitter = null) => {
    const ev = {
      type: 'submit', target: form, submitter, defaultPrevented: false, bubbles: true, cancelable: true,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {}, stopImmediatePropagation() {},
    };
    for (const fn of page.doc._listeners.submit || []) fn.call(page.doc, ev);
    return ev;
  };

  if (withScript) {
    const win = {};
    Object.assign(win, {
      window: win,
      self: win,
      document: page.doc,
      location: page.location,
      fetch: page.fetch,
      DOMParser: class { parseFromString(t) { return new Doc(t); } },
      FormData: FormDataStandIn,
      URLSearchParams,
      console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      requestAnimationFrame: (fn) => setTimeout(fn, 0),
      addEventListener() {},
      removeEventListener() {},
      history: { replaceState() {}, pushState() {} },
      navigator: { userAgent: 'harness' },
      Promise, Map, Set, Array, Object, String, Number, Boolean, JSON, Error, TypeError, Math, Date, RegExp, Symbol,
    });
    page.window = win;
    page.start = () => {
      win.document = page.doc;
      const ctx = vm.createContext(win);
      vm.runInContext(SCRIPT_SRC, ctx, { filename: SCRIPT_PATH });
    };
  }
  return page;
}

async function settle(page, limitMs = 5000) {
  const t0 = Date.now();
  let quiet = 0;
  while (quiet < 4) {
    await new Promise((r) => setTimeout(r, 10));
    quiet = page.inflight === 0 ? quiet + 1 : 0;
    if (Date.now() - t0 > limitMs) throw new Error(`the script did not settle within ${limitMs} ms (requests still in flight: ${page.inflight})`);
  }
}

async function withBoard(options, fn) {
  const srv = await startServer();
  try {
    const page = createPage(srv, options);
    await page.load();
    if (page.start) page.start();
    return await fn({ srv, page });
  } finally {
    await srv.close();
  }
}

// ---- helpers for the assertions

const habitsSection = (page) => page.doc.querySelector('[data-section="habits"]');
const tickForm = (page) => page.doc.querySelector('form[action="/actions/habit"]');
const describeLog = (entries) => entries.map((e) => `${e.method} ${e.path} ${e.status}${e.location ? ` -> ${e.location}` : ''}`).join('; ') || '(nothing)';

function assertHarnessOk(page) {
  assert.deepEqual(gaps, [], `HARNESS: the stand-in page lacks ${gaps.join(', ')}`);
  assert.deepEqual(page.nativeSubmits, [], 'the script fell back to a native form.submit()');
}

async function tick(page, srv) {
  const form = tickForm(page);
  assert.ok(form, 'a tick form is on the page');
  const start = srv.log.length;
  const ev = page.dispatchSubmit(form, form.querySelector('button'));
  assert.equal(ev.defaultPrevented, true, 'the script takes over the submit (preventDefault) and sends it in the background');
  await settle(page);
  return srv.log.slice(start);
}

const getsOfRoot = (entries) => entries.filter((e) => e.method === 'GET' && e.path === '/');

function assertOneRead(entries, label = 'the post') {
  assert.ok(entries.length >= 1, `${label}: a request was made`);
  const [post, ...rest] = entries;
  assert.equal(post.method, 'POST', `${label}: first request is a POST (log: ${describeLog(entries)})`);
  assert.equal(post.path, '/actions/habit');
  assert.equal(post.status, 303, 'the post is answered 303');
  assert.equal(post.location, '/', 'the 303 points to /');
  const reads = getsOfRoot(rest);
  assert.equal(reads.length, 1, `expected 1 GET / after ${label}, saw ${reads.length} (log: ${describeLog(entries)})`);
  assert.equal(rest.length, 1, `expected no other request after ${label} (log: ${describeLog(entries)})`);
}

// =====================================================================================
// U: the stand-in itself
// =====================================================================================

test('U the stand-in fetch counts the redirect it follows: a 303 under redirect "follow" makes exactly one extra GET /', async () => {
  await withBoard({ withScript: false }, async ({ srv, page }) => {
    const res = await page.fetch('/actions/habit', { method: 'POST', body: new URLSearchParams({ id: 'move' }), redirect: 'follow' });
    const log = srv.log.slice(page.baseline);
    assert.equal(describeLog(log), 'POST /actions/habit 303 -> /; GET / 200');
    assert.equal(res.redirected, true);
    assert.equal(res.status, 200);
    assert.ok(res.url.endsWith('/'));
    assert.match(await res.text(), /data-section="habits"/);
  });
});

test('U the stand-in fetch with redirect "manual" returns an opaque redirect and requests nothing more; "error" rejects', async () => {
  await withBoard({ withScript: false }, async ({ srv, page }) => {
    const res = await page.fetch('/actions/habit', { method: 'POST', body: 'id=move', redirect: 'manual' });
    assert.equal(res.type, 'opaqueredirect');
    assert.equal(res.status, 0);
    assert.equal(res.ok, false);
    assert.equal(describeLog(srv.log.slice(page.baseline)), 'POST /actions/habit 303 -> /');
    await assert.rejects(page.fetch('/actions/habit', { method: 'POST', body: 'id=move', redirect: 'error' }), TypeError);
  });
});

test('U the stand-in page finds the board sections and the form fields it needs', async () => {
  await withBoard({ withScript: false }, async ({ page }) => {
    assert.equal(page.doc.querySelectorAll('[data-section]').length, 2);
    assert.equal(page.doc.querySelector('head style').textContent, '.bar{width:0%}');
    const form = tickForm(page);
    assert.equal(String(new URLSearchParams(new page.FormData(form, form.querySelector('button')))), 'id=move&date=2026-10-12&on=1&token=t.n.m');
    assert.match(habitsSection(page).textContent, /Ticks: 0/);
  });
});

// =====================================================================================
// R108
// =====================================================================================

test('R108 a valid tick: one POST answered 303 to /, exactly one GET / after it, and the new state on the page', async () => {
  await withBoard({}, async ({ srv, page }) => {
    const entries = await tick(page, srv);
    assertHarnessOk(page);
    assertOneRead(entries);
    assert.match(habitsSection(page).textContent, /Ticks: 1/, 'the swapped section shows the tick');
    assert.equal(page.reloads, 0, 'no reload for an ordinary answer');
  });
});

test('R108 the same tick five more times in a row: five more posts, five more reads, never two for one action', async () => {
  await withBoard({}, async ({ srv, page }) => {
    const first = await tick(page, srv);
    assertHarnessOk(page);
    assertOneRead(first, 'the first post');
    const start = srv.log.length;
    for (let n = 2; n <= 6; n++) {
      const entries = await tick(page, srv);
      assertHarnessOk(page);
      assertOneRead(entries, `post number ${n}`);
      assert.match(habitsSection(page).textContent, new RegExp(`Ticks: ${n}`), `tick ${n} shows`);
    }
    const all = srv.log.slice(start);
    assert.equal(all.filter((e) => e.method === 'POST').length, 5, `five more posts (log: ${describeLog(all)})`);
    assert.equal(getsOfRoot(all).length, 5, `expected exactly 5 more GET /, saw ${getsOfRoot(all).length} (log: ${describeLog(all)})`);
  });
});

for (const [mode, status] of [['refuse', 400], ['fail', 502]]) {
  test(`R108 an action the server ${mode === 'refuse' ? 'refuses (400)' : 'fails (502)'}: no GET / after it, and the server's message beside the control`, async () => {
    await withBoard({}, async ({ srv, page }) => {
      srv.state.nextPost.push(mode);
      const before = habitsSection(page).textContent;
      const entries = await tick(page, srv);
      assertHarnessOk(page);
      assert.equal(entries[0].method, 'POST');
      assert.equal(entries[0].status, status);
      const reads = getsOfRoot(entries.slice(1));
      assert.equal(reads.length, 0, `expected no GET / after a ${status}, saw ${reads.length} (log: ${describeLog(entries)})`);
      assert.equal(entries.length, 1, `expected only the post (log: ${describeLog(entries)})`);
      const form = tickForm(page);
      const note = form.nextElementSibling;
      assert.ok(note && note.hasAttribute('data-message'), 'a message element sits right after the form');
      assert.ok(note.textContent.includes(MESSAGES[mode]), `the message shows the server's words (saw "${note.textContent}")`);
      assert.equal(page.reloads, 0, 'no reload after a refusal or failure');
      assert.equal(habitsSection(page).textContent.includes('Ticks: 0'), true);
      assert.ok(before.includes('Ticks: 0'));
    });
  });
}

for (const [readMode, label] of [['login', 'a login page (200, no section)'], ['down', 'an answer that is not OK (503)']]) {
  test(`R108 the one read answered with ${label}: the window is reloaded and at most one further GET /`, async () => {
    await withBoard({}, async ({ srv, page }) => {
      srv.state.readMode = readMode;
      const sectionsBefore = page.doc.querySelectorAll('[data-section]').map((s) => s.textContent);
      const entries = await tick(page, srv);
      assertHarnessOk(page);
      assert.equal(entries[0].method, 'POST');
      assert.equal(entries[0].status, 303);
      assert.equal(page.reloads, 1, `expected location.reload() once, saw ${page.reloads} (log: ${describeLog(entries)})`);
      const reads = getsOfRoot(entries);
      // the one read, plus at most one more GET / that the reload itself makes
      assert.ok(reads.length <= 2, `expected at most 2 GET / in all (the read and the reload), saw ${reads.length} (log: ${describeLog(entries)})`);
      assert.deepEqual(page.doc.querySelectorAll('[data-section]').map((s) => s.textContent), sectionsBefore, 'the page is changed by nothing but the reload');
    });
  });
}

test('R108 without the script: a plain post of the same form, followed by hand once, is a 303 and exactly one GET /', async () => {
  await withBoard({ withScript: false }, async ({ srv, page }) => {
    const form = tickForm(page);
    const body = String(new URLSearchParams(new page.FormData(form, form.querySelector('button'))));
    const start = srv.log.length;
    const post = await rawRequest(srv.base, form.action, 'POST', { 'content-type': 'application/x-www-form-urlencoded' }, body);
    assert.equal(post.status, 303);
    assert.equal(post.headers.location, '/');
    const follow = await rawRequest(srv.base, new URL(post.headers.location, srv.base).href, 'GET', {}, null); // what a browser does
    assert.equal(follow.status, 200);
    const entries = srv.log.slice(start);
    assertOneRead(entries, 'the plain post');
    assert.match(follow.body, /Ticks: 1/);
  });
});

test('R108 the answers to the posts are equal in status and Location with and without the script', async () => {
  for (const mode of ['ok', 'refuse', 'fail']) {
    let withJs;
    let without;
    await withBoard({}, async ({ srv, page }) => {
      if (mode !== 'ok') srv.state.nextPost.push(mode);
      const entries = await tick(page, srv);
      assertHarnessOk(page);
      withJs = entries.find((e) => e.method === 'POST');
    });
    await withBoard({ withScript: false }, async ({ srv, page }) => {
      if (mode !== 'ok') srv.state.nextPost.push(mode);
      const form = tickForm(page);
      const body = String(new URLSearchParams(new page.FormData(form, form.querySelector('button'))));
      const start = srv.log.length;
      await rawRequest(srv.base, form.action, 'POST', { 'content-type': 'application/x-www-form-urlencoded' }, body);
      without = srv.log.slice(start)[0];
    });
    assert.ok(withJs && without, `${mode}: both posts were recorded`);
    assert.equal(withJs.status, without.status, `${mode}: same status`);
    assert.equal(withJs.location, without.location, `${mode}: same Location`);
    assert.equal(withJs.body, without.body, `${mode}: the script sent the same body as a plain post`);
  }
});
