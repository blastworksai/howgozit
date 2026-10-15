// R75: the GitHub token appears nowhere. One sweep over every route, action and forced failure,
// with every output the board has captured: logs, console, stdout and stderr, response status lines,
// headers and bodies, form tokens, the data folder, and what the board sends to GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { needles, findLeaks, newCap, addItem } from '../fixtures/leak-hunt.mjs';
import { routes as worldRoutes, issues as worldIssues, apiIssue, R } from '../fixtures/github/world.mjs';

const { start } = await import('../board/server.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'SENTINEL-TOKEN-123-do-not-leak';
const CLOCK_MS = Date.parse('2026-10-12T06:10:00Z');
const CLOCK = { now: () => CLOCK_MS };
const BASE_ENV = { BOARD_GITHUB_TOKEN: TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

function describe(found) {
  return found.map((f) => `${f.form} form in ${f.kind} at ${f.where}`).join('; ');
}

const TOTALS = { responses: 0, logs: 0, formTokens: 0, files: 0, rejections: 0, outbound: 0, writes: 0, outboundAuth: 0, consoleOrStdio: 0 };

function installStdCapture(cap) {
  const saved = {};
  for (const m of ['log', 'error', 'warn', 'info', 'debug']) {
    saved[m] = console[m];
    console[m] = (...args) => addItem(cap, 'console', `console.${m}`, args.map(String).join(' '));
  }
  const out = process.stdout.write;
  const err = process.stderr.write;
  const wrap = (orig, stream, name) => function (chunk, ...rest) {
    addItem(cap, 'stdio', name, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return orig.call(stream, chunk, ...rest);
  };
  process.stdout.write = wrap(out, process.stdout, 'process.stdout');
  process.stderr.write = wrap(err, process.stderr, 'process.stderr');
  return () => {
    for (const m of Object.keys(saved)) console[m] = saved[m];
    process.stdout.write = out;
    process.stderr.write = err;
  };
}

// ---------------------------------------------------------------- the fake GitHub

function settingsText() {
  const s = JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'settings', 'base.json'), 'utf8'));
  s.projects = [{ key: 'house', number: 3 }];
  s.focus = ['house'];
  s.habits = [{ id: 'move', title: 'Move', start: '2026-09-22' }];
  s.season.goals = [{ title: 'Finish the kitchen and bathroom', project: 'house' }];
  return JSON.stringify(s);
}

function fakeResponse(status, body, headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (Object.prototype.hasOwnProperty.call(h, String(n).toLowerCase()) ? h[String(n).toLowerCase()] : null) },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// modes: good, down500, auth401, rate403, net-plain, net-token, writes500
function makeWorld({ ideaTitle = 'Plan the garden' } = {}) {
  const world = { mode: 'good', calls: [] };
  const store = new Map();
  const list = [
    ...worldIssues(),
    apiIssue(20, { title: ideaTitle, labels: [{ id: 3, name: 'idea', color: 'cccccc' }] }),
  ];
  for (const i of list) store.set(i.number, i);
  const table = worldRoutes({
    issues: list,
    files: {
      'board.config.json': settingsText(),
      'theme.json': null, 'state/brief.json': null, 'state/calendar.json': null,
      'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null,
    },
  });
  let next = 100;
  world.fetch = async (url, init = {}) => {
    const method = (init && init.method) || 'GET';
    const headers = { ...(init && init.headers) };
    world.calls.push({ url: String(url), method, headers, body: init && typeof init.body === 'string' ? init.body : '' });
    if (world.mode === 'net-plain') throw new Error('connect ECONNREFUSED 10.0.0.9:443');
    if (world.mode === 'net-token') throw new Error(`socket hang up while sending Bearer ${TOKEN} to api.github.com`);
    if (world.mode === 'down500') return fakeResponse(500, { message: 'Server Error' });
    if (world.mode === 'auth401') return fakeResponse(401, { message: 'Bad credentials' });
    if (world.mode === 'rate403') return fakeResponse(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    const u = new URL(String(url));
    if (method !== 'GET') {
      if (world.mode === 'writes500') return fakeResponse(500, { message: 'Server Error' });
      const body = init.body ? JSON.parse(init.body) : {};
      if (method === 'POST' && u.pathname === `${R}/issues`) {
        const n = next; next += 1;
        const made = apiIssue(n, { title: body.title, labels: (body.labels || []).map((name) => ({ name })) });
        store.set(n, made);
        return fakeResponse(201, made);
      }
      const m = /\/issues\/(\d+)$/.exec(u.pathname);
      if (method === 'PATCH' && m) {
        const n = Number(m[1]);
        const old = store.get(n) || apiIssue(n);
        const upd = { ...old };
        if (body.state) upd.state = body.state;
        if (body.state_reason) upd.state_reason = body.state_reason;
        if (Array.isArray(body.labels)) upd.labels = body.labels.map((name) => ({ name }));
        if (body.milestone) upd.milestone = { number: body.milestone, title: 'House · Hallway', state: 'open' };
        store.set(n, upd);
        return fakeResponse(200, upd);
      }
      if (method === 'POST' && /\/projectsV2\/3\/items$/.test(u.pathname)) return fakeResponse(201, { id: 7001 });
      return fakeResponse(404, { message: 'Not Found' });
    }
    const key = u.pathname + u.search;
    if (key === `${R}/issues?state=all&per_page=100` || key.startsWith(`${R}/issues?state=all&per_page=100&since=`)) {
      return fakeResponse(200, [...store.values()]);
    }
    if (Object.prototype.hasOwnProperty.call(table, key)) return fakeResponse(200, table[key]);
    return fakeResponse(404, { message: 'Not Found' });
  };
  world.writes = () => world.calls.filter((c) => c.method !== 'GET');
  return world;
}

// ---------------------------------------------------------------- requests

function sendRequest(port, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const h = { host: `localhost:${port}`, ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish({
        status: res.statusCode,
        statusLine: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`,
        rawHeaders: res.rawHeaders,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', () => finish({ status: 0, statusLine: 'aborted', rawHeaders: [], headers: {}, body: '' }));
    });
    req.on('error', (err) => finish({ status: 0, statusLine: `client-error ${err && err.code}`, rawHeaders: [], headers: {}, body: '' }));
    const timer = setTimeout(() => { req.destroy(); finish({ status: 0, statusLine: 'timeout', rawHeaders: [], headers: {}, body: '' }); }, 15000);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    if (body !== null) req.write(body);
    req.end();
  });
}

const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function parseForms(html) {
  const forms = [];
  const re = /<form method="post" action="(\/actions\/[a-z]+)">([\s\S]*?)<\/form>/g;
  for (const m of html.matchAll(re)) {
    const fields = {};
    for (const f of m[2].matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) fields[unesc(f[1])] = unesc(f[2]);
    const opt = /<option value="([^"]*)"/.exec(m[2]);
    forms.push({ action: m[1], fields, firstTarget: opt ? unesc(opt[1]) : null });
  }
  return forms;
}

function submission(form) {
  const f = { ...form.fields };
  if (form.action === '/actions/idea') f.title = 'A sweep idea';
  if (form.action === '/actions/sort' && f.accept !== '1' && form.firstTarget) f.target = form.firstTarget;
  return new URLSearchParams(f).toString();
}

// ---------------------------------------------------------------- one sweep session

async function withSweep(body, { env = {}, ideaTitle } = {}) {
  const cap = newCap();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-sweep-'));
  const world = makeWorld({ ideaTitle });
  const running = [];
  const restore = installStdCapture(cap);
  const log = (line) => { cap.counts.logs += 1; addItem(cap, 'log', 'log line', line); };
  let failure = null;
  const ctx = {
    cap, world, dir, log,
    async boot({ sub = 'data', envExtra = {} } = {}) {
      const dataDir = path.join(dir, sub);
      const r = await start({
        processEnv: { ...BASE_ENV, BOARD_DATA_DIR: dataDir, ...env, ...envExtra },
        fetch: world.fetch, clock: CLOCK, log,
      });
      running.push(r);
      return r.address.port;
    },
    async request(port, label, opts = {}) {
      const res = await sendRequest(port, opts);
      const where = `${opts.method || 'GET'} ${opts.reqPath || '/'} [${label}]`;
      cap.counts.responses += 1;
      addItem(cap, 'status-line', where, res.statusLine);
      addItem(cap, 'header', where, res.rawHeaders.join('\n'));
      addItem(cap, 'body', where, res.body);
      return res;
    },
    // fetch the page, record the form tokens found in it, return the forms
    async page(port, label, opts = {}) {
      const res = await ctx.request(port, label, { reqPath: '/', ...opts });
      const forms = parseForms(res.body);
      for (const f of forms) {
        if (f.fields.token) { cap.counts.formTokens += 1; addItem(cap, 'form-token', `${f.action} [${label}]`, f.fields.token); }
      }
      return { res, forms };
    },
    async post(port, label, form, extra = {}) {
      const origin = `http://localhost:${port}`;
      return ctx.request(port, label, {
        method: 'POST', reqPath: form.action, headers: { ...FORM, origin, ...extra }, body: submission(form),
      });
    },
    async postBadToken(port, label, form) {
      const bad = { ...form, fields: { ...form.fields, token: 'not.a.token' } };
      return ctx.post(port, `${label}, bad token`, bad);
    },
  };
  try {
    await body(ctx);
  } catch (err) {
    failure = err;
  } finally {
    restore();
    for (const r of running) await r.close().catch(() => {});
  }
  try {
    // every file the board left in the data folder
    const walk = async (d) => {
      let names = [];
      try { names = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) await walk(p);
        else {
          cap.counts.files += 1;
          addItem(cap, 'file-name', path.relative(dir, p), p);
          addItem(cap, 'file', path.relative(dir, p), await readFile(p, 'utf8'));
        }
      }
    };
    await walk(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return { cap, world };
}

// What the board sent to GitHub: the token only in `authorization`, nowhere else.
function outboundAudit(cap, world, list) {
  const problems = [];
  let auth = 0;
  for (const c of world.calls) {
    cap.counts.outbound += 1;
    for (const [name, value] of Object.entries(c.headers)) {
      if (name.toLowerCase() === 'authorization') {
        if (value === `Bearer ${TOKEN}`) auth += 1;
        else problems.push(`authorization header is not the bearer form (${c.method})`);
        continue;
      }
      for (const [needle, nm] of list) if (String(value).includes(needle)) problems.push(`${nm} form in header "${name}" sent to GitHub (${c.method})`);
    }
    for (const [needle, nm] of list) {
      if (c.url.includes(needle)) problems.push(`${nm} form in the URL sent to GitHub (${c.method})`);
      if (c.body.includes(needle)) problems.push(`${nm} form in the body sent to GitHub (${c.method})`);
    }
  }
  return { problems, auth };
}

function finish({ cap, world }, { expectWrites = false } = {}) {
  const list = needles(TOKEN);
  const found = findLeaks(cap, list);
  const out = outboundAudit(cap, world, list);
  // not vacuous: GitHub was reached, and every request carried the token in authorization
  assert.ok(world.calls.length > 0, 'the fake GitHub was never reached, so the sweep proves nothing');
  assert.equal(out.auth, world.calls.length, 'every request to GitHub must carry the token in the authorization header');
  assert.ok(cap.items.length > 0 && cap.counts.responses + cap.counts.rejections > 0, 'nothing was captured');
  if (expectWrites) assert.ok(world.writes().length > 0, 'no write reached the fake GitHub, so the write paths were not swept');
  assert.equal(found.length, 0, `the token was found in captured material: ${describe(found)}`);
  assert.equal(out.problems.length, 0, `the token was sent to GitHub outside the authorization header: ${out.problems.join('; ')}`);
  for (const k of Object.keys(cap.counts)) TOTALS[k] += cap.counts[k];
  TOTALS.writes += world.writes().length;
  TOTALS.outboundAuth += out.auth;
  TOTALS.consoleOrStdio += cap.items.filter((i) => i.kind === 'console' || i.kind === 'stdio').length;
}

// ---------------------------------------------------------------- tests

test('U the capture sees a planted marker in every kind of output', async () => {
  const MARK = 'PLANTED-MARKER-77x';
  let planted;
  const sweep = await withSweep(async (ctx) => {
    const port = await ctx.boot();
    ctx.log(MARK);
    console.log(MARK);
    process.stderr.write(`${MARK}\n`);
    await mkdir(path.join(ctx.dir, 'data'), { recursive: true });
    await writeFile(path.join(ctx.dir, 'data', 'planted.txt'), MARK);
    const { res } = await ctx.page(port, 'planted');
    assert.equal(res.status, 200);
    planted = res.status;
  }, { ideaTitle: MARK });
  const list = new Map([[MARK, 'marker'], ['no-store', 'header word']]);
  const kinds = new Set(findLeaks(sweep.cap, list).map((f) => `${f.form}:${f.kind}`));
  for (const k of ['marker:log', 'marker:console', 'marker:stdio', 'marker:file', 'marker:body', 'header word:header']) {
    assert.ok(kinds.has(k), `the capture did not see the planted ${k}`);
  }
  assert.equal(planted, 200);
  // and the finder stays quiet when the needle is absent
  assert.equal(findLeaks(sweep.cap, new Map([['ZZ-NOT-THERE-ZZ-1', 'absent']])).length, 0);
  // the needle forms are really built
  const names = new Set(needles(TOKEN).values());
  for (const n of ['form-encoded', 'hex', 'base64url (alignment 0)', 'base64url (alignment 1)', 'base64url (alignment 2)']) {
    assert.ok(names.has(n), `needle form missing: ${n}`);
  }
  // a base64 copy of the token inside a larger string would be caught
  const b64 = Buffer.from(`xx${TOKEN}yy`).toString('base64');
  const probe = newCap();
  addItem(probe, 'body', 'probe', `prefix ${b64} suffix`);
  assert.equal(findLeaks(probe, needles(TOKEN)).length > 0, true, 'a base64 copy of the token must be found');
});

test('R75 every route and every action in the good world leaves the token nowhere', async () => {
  const sweep = await withSweep(async (ctx) => {
    const port = await ctx.boot();
    const { res, forms } = await ctx.page(port, 'good');
    assert.equal(res.status, 200);
    for (const a of ['idea', 'habit', 'close']) {
      assert.ok(forms.some((f) => f.action === `/actions/${a}`), `the page has no ${a} form to drive`);
    }
    await ctx.request(port, 'good', { reqPath: '/healthz' });
    await ctx.request(port, 'good', { reqPath: '/static/board.css' });
    await ctx.request(port, 'good', { reqPath: '/static/board.js' });
    // each action with a real token from the page, once more with the same token, and with a bad one
    const seen = new Set();
    for (const f of forms) {
      const key = f.action + (f.fields.accept === '1' ? '+accept' : '');
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.post(port, 'good, valid token', f);
      await ctx.post(port, 'good, same token again', f);
      await ctx.postBadToken(port, 'good', f);
    }
    // a token signed for another action or target
    const idea = forms.find((f) => f.action === '/actions/idea');
    const close = forms.find((f) => f.action === '/actions/close');
    await ctx.post(port, 'good, token of another action', { ...close, fields: { ...close.fields, token: idea.fields.token } });
    await ctx.page(port, 'good, after the writes');
  });
  const methods = sweep.world.writes().map((c) => c.method + ' ' + new URL(c.url).pathname.replace(/\/\d+/g, '/N'));
  assert.ok(methods.some((m) => m.startsWith('POST') && m.endsWith('/issues')), 'no issue was created');
  assert.ok(methods.some((m) => m.startsWith('PATCH')), 'no issue was patched');
  finish(sweep, { expectWrites: true });
});

test('R75 a GitHub that refuses every write leaves the token nowhere', async () => {
  const sweep = await withSweep(async (ctx) => {
    const port = await ctx.boot();
    const { forms } = await ctx.page(port, 'before the writes fail');
    ctx.world.mode = 'writes500';
    const seen = new Set();
    for (const f of forms) {
      const key = f.action + (f.fields.accept === '1' ? '+accept' : '');
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await ctx.post(port, 'writes fail', f);
      assert.notEqual(r.status, 0);
    }
    await ctx.page(port, 'writes fail, page');
  });
  assert.ok(sweep.world.writes().length > 0, 'no write was attempted against the failing GitHub');
  finish(sweep);
});

test('R75 every forced GitHub failure, cold and warm, leaves the token nowhere', async () => {
  const sweep = await withSweep(async (ctx) => {
    // tokens issued by a healthy page stay valid for a restarted board (the key comes from the GitHub token)
    const warm = await ctx.boot({ sub: 'warm' });
    const { forms } = await ctx.page(warm, 'healthy');
    const idea = forms.find((f) => f.action === '/actions/idea');
    const close = forms.find((f) => f.action === '/actions/close');
    const habit = forms.find((f) => f.action === '/actions/habit');
    const modes = ['down500', 'auth401', 'rate403', 'net-plain', 'net-token'];
    for (const mode of modes) {
      // warm: the board holds a good read and then GitHub fails
      ctx.world.mode = 'good';
      const port = await ctx.boot({ sub: `warm-${mode}` });
      await ctx.page(port, `warm before ${mode}`);
      ctx.world.mode = mode;
      const { res } = await ctx.page(port, `warm ${mode}`);
      assert.ok(res.status >= 200 && res.status < 600);
      for (const f of [idea, close, habit]) await ctx.post(port, `warm ${mode}`, f);
      // cold: a fresh data folder, GitHub already failing
      const cold = await ctx.boot({ sub: `cold-${mode}` });
      const c = await ctx.page(cold, `cold ${mode}`);
      assert.ok(c.res.status >= 400, `cold ${mode} should not give a good page`);
      for (const f of [idea, close, habit]) await ctx.post(cold, `cold ${mode}`, f);
      // restarted over the saved read in the same data folder
      const again = await ctx.boot({ sub: `warm-${mode}` });
      await ctx.page(again, `restarted ${mode}`);
    }
  });
  finish(sweep);
});

test('R75 a foreign host, 404, 405, a bad content type and a huge POST leave the token nowhere', async () => {
  const sweep = await withSweep(async (ctx) => {
    const port = await ctx.boot();
    const { forms } = await ctx.page(port, 'good');
    const idea = forms.find((f) => f.action === '/actions/idea');
    const f1 = await ctx.request(port, 'foreign host', { reqPath: '/', headers: { host: 'evil.example:80' } });
    assert.equal(f1.status, 421);
    await ctx.request(port, 'foreign host', { method: 'POST', reqPath: '/actions/idea', headers: { ...FORM, host: 'evil.example:80' }, body: submission(idea) });
    await ctx.request(port, 'foreign host', { reqPath: '/healthz', headers: { host: 'evil.example:80' } });
    const nf = await ctx.request(port, 'missing', { reqPath: '/nope/../etc/passwd' });
    assert.equal(nf.status, 404);
    await ctx.request(port, 'missing', { reqPath: '/static/other.js' });
    const m = await ctx.request(port, 'wrong method', { method: 'DELETE', reqPath: '/' });
    assert.equal(m.status, 405);
    await ctx.request(port, 'wrong method', { method: 'GET', reqPath: '/actions/idea' });
    await ctx.request(port, 'wrong method', { method: 'POST', reqPath: '/static/board.css', headers: FORM, body: 'a=b' });
    await ctx.request(port, 'wrong method', { method: 'POST', reqPath: '/healthz', headers: FORM, body: 'a=b' });
    const ct = await ctx.request(port, 'bad content type', { method: 'POST', reqPath: '/actions/idea', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(ct.status, 400);
    const huge = await ctx.request(port, 'huge body', { method: 'POST', reqPath: '/actions/idea', headers: FORM, body: `title=${'a'.repeat(200000)}` });
    assert.ok(huge.status === 413 || huge.status === 0, `unexpected status ${huge.status} for a huge body`);
    await ctx.request(port, 'empty form', { method: 'POST', reqPath: '/actions/sort', headers: FORM, body: '' });
    await ctx.request(port, 'query string', { reqPath: `/?q=${encodeURIComponent('hello')}` });
  });
  finish(sweep);
});

test('R75 proxy mode, with and without the identity header, leaves the token nowhere', async () => {
  const sweep = await withSweep(async (ctx) => {
    const port = await ctx.boot();
    assert.ok(port > 0);
    const { forms } = await ctx.page(port, 'proxy, with header', { headers: { 'x-forwarded-user': 'sam' } });
    const none = await ctx.request(port, 'proxy, no header', { reqPath: '/' });
    assert.equal(none.status, 401);
    await ctx.request(port, 'proxy, empty header', { reqPath: '/', headers: { 'x-forwarded-user': '' } });
    const idea = forms.find((f) => f.action === '/actions/idea');
    await ctx.post(port, 'proxy, with header', idea, { 'x-forwarded-user': 'sam' });
    await ctx.post(port, 'proxy, no header', idea);
    await ctx.request(port, 'proxy, no header', { reqPath: '/static/board.css' });
    await ctx.request(port, 'proxy, no header', { reqPath: '/healthz' });
  }, { env: { BOARD_MODE: 'proxy', BOARD_IDENTITY_HEADER: 'X-Forwarded-User', BOARD_HOST: '127.0.0.1' } });
  finish(sweep, { expectWrites: true });
});

test('R75 a bad environment is refused without the token in the message', async () => {
  const cap = newCap();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-sweep-'));
  const calls = [];
  const noFetch = async (url) => { calls.push(String(url)); throw new Error('no network in this check'); };
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = String(blocker.address().port);
  const restore = installStdCapture(cap);
  const cases = {
    'missing repo': { BOARD_REPO: '' },
    'malformed repo': { BOARD_REPO: 'not a repo' },
    'bad mode': { BOARD_MODE: 'cloud' },
    'bad port': { BOARD_PORT: 'seventy' },
    'port too large': { BOARD_PORT: '70000' },
    'hosted without identity header': { BOARD_MODE: 'hosted' },
    'proxy without identity header': { BOARD_MODE: 'proxy' },
    'port already in use': { BOARD_PORT: busy, BOARD_HOST: '127.0.0.1' },
    'no environment at all': null,
  };
  const messages = {};
  try {
    for (const [name, extra] of Object.entries(cases)) {
      const processEnv = extra === null ? undefined : { ...BASE_ENV, BOARD_DATA_DIR: dir, ...extra };
      let started = null;
      try {
        started = await start({ processEnv, fetch: noFetch, clock: CLOCK, log: () => {} });
      } catch (err) {
        cap.counts.rejections += 1;
        messages[name] = err && err.message;
        addItem(cap, 'rejection', name, `${err && err.name} ${err && err.message} ${err && err.stack ? 'stack' : ''}`);
        addItem(cap, 'rejection-stack', name, err && err.stack ? err.stack : '');
      }
      if (started) await started.close();
    }
  } finally {
    restore();
    await new Promise((resolve) => blocker.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(Object.keys(messages).length, Object.keys(cases).length, 'every bad environment must be refused');
  for (const [name, msg] of Object.entries(messages)) assert.ok(typeof msg === 'string' && msg.length > 0, `refusal "${name}" has no message`);
  const found = findLeaks(cap, needles(TOKEN));
  assert.equal(found.length, 0, `the token was found in a refusal: ${describe(found)}`);
  for (const k of ['rejections']) TOTALS[k] += cap.counts[k];
  assert.equal(calls.length, 0, 'a refused start must not reach GitHub');
});

test('R75 the sweep as a whole was not vacuous', async (t) => {
  t.diagnostic(`sweep totals: ${JSON.stringify(TOTALS)}`);
  assert.ok(TOTALS.responses >= 60, `only ${TOTALS.responses} responses were examined`);
  assert.ok(TOTALS.logs >= 40, `only ${TOTALS.logs} log lines were examined`);
  assert.ok(TOTALS.formTokens >= 10, `only ${TOTALS.formTokens} form tokens were examined`);
  assert.ok(TOTALS.files >= 3, `only ${TOTALS.files} files were examined`);
  assert.ok(TOTALS.writes >= 4, `only ${TOTALS.writes} writes reached the fake GitHub`);
  assert.equal(TOTALS.outboundAuth, TOTALS.outbound, 'every request to GitHub carried the token in authorization');
  assert.ok(TOTALS.rejections >= 9, `only ${TOTALS.rejections} refusals were examined`);
  assert.equal(console.log.name === 'log' || typeof console.log === 'function', true);
});
