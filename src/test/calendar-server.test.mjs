// R96 and R102 end to end: the real server, one fake fetch that plays GitHub and an iCloud-like CalDAV service,
// the page's calendar section, and both sign-in sentinels hunted in everything the board outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { routes as worldRoutes, issues as worldIssues, apiIssue, R } from '../fixtures/github/world.mjs';
import { fakeCalDav } from '../fixtures/fake-caldav.mjs';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { needles, findLeaks, newCap, addItem } from '../fixtures/leak-hunt.mjs';
import { warningText } from '../board/render/page.mjs';

const { start } = await import('../board/server.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GH_TOKEN = 'SENTINEL-TOKEN-123-do-not-leak';
const ICLOUD_USER = 'sentinel.apple.user.4417@example.com';
const ICLOUD_PASSWORD = 'SENTINEL-APPLE-PASSWORD-9d41-keep-out';
const CLOCK_MS = Date.parse('2026-10-12T06:10:00Z');
const CLOCK = { now: () => CLOCK_MS };
const BASE_ENV = { BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0' };
const LOGIN_ENV = { BOARD_ICLOUD_USER: ICLOUD_USER, BOARD_ICLOUD_APP_PASSWORD: ICLOUD_PASSWORD };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const CALENDAR_BLOCK = { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }] };

// ---------------------------------------------------------------- invented data

// Today is 2026-10-12 in Europe/Brussels (the settings zone): 08:30 to 09:00 UTC is 10:30 to 11:00 there.
const APPLE_EVENT = vevent({ uid: 'dentist-1@example.com', summary: 'Dentist', start: '20261012T083000Z', end: '20261012T090000Z' });
const FILE_EVENT_TEXT = JSON.stringify({
  date: '2026-10-12',
  events: [{ title: 'Standup', start: '09:00', end: '09:30', kind: 'meeting' }],
});

function appleWorld(password = ICLOUD_PASSWORD) {
  return fakeCalDav({ user: ICLOUD_USER, password, calendars: [{ name: 'Home', ics: [vcalendar(APPLE_EVENT)] }] });
}

function settingsText(block) {
  const s = JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'settings', 'base.json'), 'utf8'));
  s.projects = [{ key: 'house', number: 3 }];
  s.focus = ['house'];
  s.habits = [{ id: 'move', title: 'Move', start: '2026-09-22' }];
  s.season.goals = [{ title: 'Finish the kitchen and bathroom', project: 'house' }];
  if (block) s.calendar = block;
  return JSON.stringify(s);
}

// ---------------------------------------------------------------- the fake GitHub

function fakeResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// modes: good, down500
function makeGithub({ block, stateCalendar = null }) {
  const gh = { mode: 'good', calls: [] };
  const store = new Map();
  const list = [...worldIssues(), apiIssue(20, { title: 'Plan the garden', labels: [{ id: 3, name: 'idea', color: 'cccccc' }] })];
  for (const i of list) store.set(i.number, i);
  const table = worldRoutes({
    issues: list,
    files: {
      'board.config.json': settingsText(block),
      'theme.json': null, 'state/brief.json': null, 'state/calendar.json': stateCalendar,
      'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null,
    },
  });
  let next = 100;
  gh.fetch = async (url, init = {}) => {
    const method = (init && init.method) || 'GET';
    gh.calls.push({
      url: String(url), method, headers: Object.fromEntries([...new Headers((init && init.headers) || {})]), body: init && typeof init.body === 'string' ? init.body : '',
    });
    if (gh.mode === 'down500') return fakeResponse(500, { message: 'Server Error' });
    const u = new URL(String(url));
    if (method !== 'GET') {
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
        const upd = { ...(store.get(n) || apiIssue(n)) };
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
    if (key.startsWith(`${R}/issues?state=all&per_page=100`)) return fakeResponse(200, [...store.values()]);
    if (Object.prototype.hasOwnProperty.call(table, key)) return fakeResponse(200, table[key]);
    return fakeResponse(404, { message: 'Not Found' });
  };
  gh.writes = () => gh.calls.filter((c) => c.method !== 'GET');
  return gh;
}

// ---------------------------------------------------------------- one fetch for all hosts

const isApple = (host) => host === 'icloud.com' || host.endsWith('.icloud.com');

function makeRouter({ github, apple }) {
  const router = { apple, github, appleSeen: [], foreign: [], all: [] };
  router.fetch = async (url, init = {}) => {
    const href = String(url instanceof URL ? url.href : url);
    let host = '';
    try { host = new URL(href).hostname; } catch { host = ''; }
    const headers = {};
    for (const [n, v] of new Headers((init && init.headers) || {})) headers[n.toLowerCase()] = v;
    const rec = {
      host, url: href, method: String((init && init.method) || 'GET').toUpperCase(), headers,
      body: init && typeof init.body === 'string' ? init.body : '',
    };
    router.all.push(rec);
    if (host === 'api.github.com') return router.github.fetch(url, init);
    if (isApple(host)) { router.appleSeen.push(rec); return router.apple.fetch(url, init); }
    router.foreign.push(rec);
    throw new TypeError(`foreign host refused by the test: ${host}`);
  };
  return router;
}

// ---------------------------------------------------------------- requests and capture

function sendRequest(port, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const h = { host: `localhost:${port}`, ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({
        status: res.statusCode,
        statusLine: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`,
        rawHeaders: res.rawHeaders,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', () => done({ status: 0, statusLine: 'aborted', rawHeaders: [], body: '' }));
    });
    req.on('error', (err) => done({ status: 0, statusLine: `client-error ${err && err.code}`, rawHeaders: [], body: '' }));
    const timer = setTimeout(() => { req.destroy(); done({ status: 0, statusLine: 'timeout', rawHeaders: [], body: '' }); }, 15000);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    if (body !== null) req.write(body);
    req.end();
  });
}

const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function parseForms(html) {
  const forms = [];
  for (const m of html.matchAll(/<form method="post" action="(\/actions\/[a-z]+)">([\s\S]*?)<\/form>/g)) {
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

// The text of one section of the page, from its opening tag to the next section or the end.
function sectionOf(html, name) {
  const at = html.indexOf(`data-section="${name}"`);
  if (at < 0) return null;
  const from = html.lastIndexOf('<', at);
  const next = html.indexOf('data-section="', at + 10);
  return html.slice(from, next < 0 ? html.length : html.lastIndexOf('<', next));
}

// ---------------------------------------------------------------- one session

async function withSession(body, { block = null, stateCalendar = null, env = LOGIN_ENV, apple = appleWorld(), capture = false } = {}) {
  const cap = newCap();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-calsrv-'));
  const github = makeGithub({ block, stateCalendar });
  const router = makeRouter({ github, apple });
  const running = [];
  const restore = capture ? installStdCapture(cap) : () => {};
  const log = (line) => { cap.counts.logs += 1; addItem(cap, 'log', 'log line', line); };
  let failure = null;
  const ctx = {
    cap, dir, github, router, log,
    async boot({ sub = 'data', envExtra = {} } = {}) {
      const r = await start({
        processEnv: { ...BASE_ENV, BOARD_DATA_DIR: path.join(dir, sub), ...env, ...envExtra },
        fetch: router.fetch, clock: CLOCK, log,
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
    async page(port, label) {
      const res = await ctx.request(port, label, { reqPath: '/' });
      const forms = parseForms(res.body);
      for (const f of forms) {
        if (f.fields.token) { cap.counts.formTokens += 1; addItem(cap, 'form-token', `${f.action} [${label}]`, f.fields.token); }
      }
      return { res, forms };
    },
    async post(port, label, form) {
      return ctx.request(port, label, {
        method: 'POST', reqPath: form.action, headers: { ...FORM, origin: `http://localhost:${port}` }, body: submission(form),
      });
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
    // every file the board left under the temp folder, read before it is removed
    const walk = async (d) => {
      let names = [];
      try { names = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) await walk(p);
        else {
          cap.counts.files += 1;
          const rel = path.relative(dir, p);
          addItem(cap, 'file-name', rel, p);
          const text = await readFile(p, 'utf8');
          addItem(cap, 'file', rel, text);
          ctx.files = { ...(ctx.files || {}), [rel]: text };
        }
      }
    };
    await walk(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return { cap, github, router, files: ctx.files || {} };
}

// ---------------------------------------------------------------- R96

test('R96 the iCloud event is on the page and the state file\'s event is not', async () => {
  let html = '';
  let status = 0;
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res } = await ctx.page(port, 'block on');
    status = res.status;
    html = res.body;
  }, { block: CALENDAR_BLOCK, stateCalendar: FILE_EVENT_TEXT });
  assert.equal(status, 200);
  const cal = sectionOf(html, 'calendar');
  assert.ok(cal, 'the page has no calendar section');
  assert.ok(cal.includes('Dentist'), 'the iCloud event is missing from the calendar section');
  assert.ok(!cal.includes('Standup'), 'the state file\'s event is shown although the settings name iCloud calendars');
  assert.ok(!html.includes('Standup'), 'the state file\'s event is somewhere on the page');
  assert.ok(s.router.appleSeen.length > 0, 'Apple was never asked, so the title cannot have come from there');
});

test('R96 without the block the state file\'s event shows and no request reaches an Apple host', async () => {
  let html = '';
  let status = 0;
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res } = await ctx.page(port, 'block off');
    status = res.status;
    html = res.body;
  }, { block: null, stateCalendar: FILE_EVENT_TEXT });
  assert.equal(status, 200);
  const cal = sectionOf(html, 'calendar');
  assert.ok(cal, 'the page has no calendar section');
  assert.ok(cal.includes('Standup'), 'the state file\'s event is missing');
  assert.ok(!cal.includes('Dentist'));
  assert.ok(s.github.calls.length > 0, 'GitHub was never reached, so the zero below proves nothing');
  assert.equal(s.router.appleSeen.length, 0, 'a request reached an Apple host although the settings have no calendar block');
  assert.equal(s.router.foreign.length, 0);
});

test('R96 the block without an iCloud sign-in gives the broken card and the no-login sentence', async () => {
  let html = '';
  let status = 0;
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res } = await ctx.page(port, 'block on, no login');
    status = res.status;
    html = res.body;
  }, { block: CALENDAR_BLOCK, stateCalendar: FILE_EVENT_TEXT, env: {} });
  assert.equal(status, 200);
  const cal = sectionOf(html, 'calendar');
  assert.ok(cal, 'the page has no calendar section');
  assert.ok(cal.includes('class="panel-error"'), 'the calendar section is not the broken card');
  assert.ok(!cal.includes('Standup'), 'the state file\'s event shows although the settings name iCloud calendars');
  const footer = sectionOf(html, 'footer');
  assert.ok(footer, 'the page has no footer');
  const sentence = warningText({ code: 'calendar-no-login', count: 1 });
  assert.ok(footer.includes(sentence), `the footer lacks: ${sentence}`);
  assert.equal(s.router.appleSeen.length, 0);
  assert.ok(s.github.calls.length > 0);
});

test('R96 the event titles reach the page and the board\'s own last good read, and nothing is written to GitHub', async () => {
  let html = '';
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const first = await ctx.page(port, 'first load');
    html = first.res.body;
    await ctx.page(port, 'second load');
  }, { block: CALENDAR_BLOCK, stateCalendar: FILE_EVENT_TEXT });
  assert.ok(html.includes('Dentist'));
  const keep = Object.entries(s.files).filter(([name]) => name.endsWith('last-good.json'));
  assert.equal(keep.length, 1, `expected one last-good.json, found: ${Object.keys(s.files).join(', ')}`);
  assert.ok(keep[0][1].includes('Dentist'), 'the event title is not in the board\'s last good read');
  assert.ok(s.github.calls.length > 0, 'GitHub was never reached');
  assert.deepEqual(s.github.writes().map((c) => `${c.method} ${c.url}`), [], 'a request other than GET reached GitHub while loading');
  for (const c of s.github.calls) assert.ok(!c.url.includes('Dentist') && !c.body.includes('Dentist'), 'a title was sent to GitHub');
});

// ---------------------------------------------------------------- R102

test('R102 only one of the two variables: start refuses, names both, holds neither value', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-calsrv-'));
  const calls = [];
  const noFetch = async (url) => { calls.push(String(url)); throw new Error('no network in this check'); };
  try {
    for (const extra of [{ BOARD_ICLOUD_USER: ICLOUD_USER }, { BOARD_ICLOUD_APP_PASSWORD: ICLOUD_PASSWORD }]) {
      let started = null;
      let error = null;
      try {
        started = await start({ processEnv: { ...BASE_ENV, BOARD_DATA_DIR: dir, ...extra }, fetch: noFetch, clock: CLOCK, log: () => {} });
      } catch (err) {
        error = err;
      }
      if (started) await started.close();
      const which = Object.keys(extra)[0];
      assert.ok(error, `start accepted ${which} alone`);
      const text = `${error.message}\n${error.stack || ''}`;
      assert.ok(error.message.includes('BOARD_ICLOUD_USER'), `the refusal for ${which} does not name BOARD_ICLOUD_USER`);
      assert.ok(error.message.includes('BOARD_ICLOUD_APP_PASSWORD'), `the refusal for ${which} does not name BOARD_ICLOUD_APP_PASSWORD`);
      assert.ok(!text.includes(ICLOUD_USER) && !text.includes(ICLOUD_PASSWORD), `the refusal for ${which} holds a value`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(calls.length, 0, 'a refused start reached the network');
});

test('R102 the sign-in is found nowhere the board outputs, and goes only to Apple inside authorization', async () => {
  const wrongPassword = appleWorld('a-different-app-password-1');
  const s = await withSession(async (ctx) => {
    // good: page, static files, health, every action
    const port = await ctx.boot({ sub: 'good' });
    const { res, forms } = await ctx.page(port, 'good');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Dentist'), 'the iCloud event is not on the page, so the sweep did not reach the calendar');
    await ctx.request(port, 'good', { reqPath: '/healthz' });
    await ctx.request(port, 'good', { reqPath: '/static/board.css' });
    await ctx.request(port, 'good', { reqPath: '/static/board.js' });
    const posted = new Set();
    const seen = new Set();
    for (const f of forms) {
      const key = f.action + (f.fields.accept === '1' ? '+accept' : '');
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await ctx.post(port, 'good, valid token', f);
      assert.notEqual(r.status, 0);
      posted.add(f.action);
    }
    for (const a of ['/actions/idea', '/actions/habit', '/actions/sort', '/actions/close']) {
      assert.ok(posted.has(a), `the page has no form for ${a}, so that action was not swept`);
    }
    await ctx.page(port, 'good, after the actions');

    // iCloud fails: a service error on the report, and a dead network
    ctx.router.apple.state.fail = { step: 'report', status: 500 };
    const failing = await ctx.boot({ sub: 'apple-500' });
    const f1 = await ctx.page(failing, 'iCloud fails (report 500)');
    assert.equal(f1.res.status, 200);
    ctx.router.apple.state.fail = { step: 'principal', status: 'network' };
    const dead = await ctx.boot({ sub: 'apple-network' });
    await ctx.page(dead, 'iCloud unreachable');
    ctx.router.apple.state.fail = null;

    // iCloud refuses the sign-in: another password in the service
    const goodApple = ctx.router.apple;
    ctx.router.apple = wrongPassword;
    const refused = await ctx.boot({ sub: 'apple-refused' });
    const rf = await ctx.page(refused, 'iCloud refuses the sign-in');
    assert.equal(rf.res.status, 200);
    ctx.router.apple = goodApple;

    // GitHub fails: warm (a good read held) and cold
    const warm = await ctx.boot({ sub: 'warm' });
    await ctx.page(warm, 'warm before GitHub fails');
    ctx.github.mode = 'down500';
    await ctx.page(warm, 'warm, GitHub fails');
    for (const f of forms.slice(0, 4)) await ctx.post(warm, 'warm, GitHub fails', f);
    const cold = await ctx.boot({ sub: 'cold' });
    await ctx.page(cold, 'cold, GitHub fails');
    ctx.github.mode = 'good';
  }, { block: CALENDAR_BLOCK, stateCalendar: FILE_EVENT_TEXT, capture: true });

  const { cap, router, github } = s;
  // not vacuous
  assert.ok(cap.counts.responses >= 15, `only ${cap.counts.responses} responses were captured`);
  assert.ok(cap.counts.logs > 0, 'no log line was captured');
  assert.ok(cap.counts.formTokens >= 4, `only ${cap.counts.formTokens} form tokens were captured`);
  assert.ok(cap.counts.files >= 2, `only ${cap.counts.files} files were captured`);
  assert.ok(router.appleSeen.length > 0, 'Apple was never asked');
  assert.ok(github.calls.length > 0, 'GitHub was never asked');
  assert.equal(router.foreign.length, 0, `requests went to a foreign host: ${router.foreign.map((r) => r.host).join(', ')}`);

  // nothing the board outputs holds either sentinel, in any form
  for (const [label, secret] of [['password', ICLOUD_PASSWORD], ['user name', ICLOUD_USER]]) {
    const found = findLeaks(cap, needles(secret));
    assert.deepEqual(found, [], `the ${label} was found in captured material: ${found.map((f) => `${f.form} in ${f.kind} at ${f.where}`).join('; ')}`);
  }

  // the other direction: what the board sends
  const expectedAuth = `Basic ${Buffer.from(`${ICLOUD_USER}:${ICLOUD_PASSWORD}`).toString('base64')}`;
  const pwNeedles = needles(ICLOUD_PASSWORD);
  const userNeedles = needles(ICLOUD_USER);
  let withPassword = 0;
  for (const r of router.all) {
    const apple = isApple(r.host);
    for (const [name, value] of Object.entries(r.headers)) {
      if (apple && name === 'authorization') {
        if (value === expectedAuth) withPassword += 1;
        continue;
      }
      for (const [needle, form] of [...pwNeedles, ...userNeedles]) {
        assert.ok(!String(value).includes(needle), `${form} form of a sign-in value in header "${name}" of a ${r.method} to ${r.host}`);
      }
    }
    for (const [needle, form] of pwNeedles) {
      assert.ok(!r.url.includes(needle) && !r.body.includes(needle), `${form} form of the password in the address or body of a ${r.method} to ${r.host}`);
    }
    if (!apple) {
      for (const [needle, form] of userNeedles) {
        assert.ok(!r.url.includes(needle) && !r.body.includes(needle), `${form} form of the user name in the address or body of a ${r.method} to ${r.host}`);
      }
    }
  }
  assert.ok(withPassword > 0, 'no request to Apple carried the expected authorization, so the check on where the password goes proves nothing');
  // and the password's base64 form is found by the same needles inside that header (the twin of the check above)
  const probe = newCap();
  for (const r of router.appleSeen) if (r.headers.authorization === expectedAuth) addItem(probe, 'header', 'authorization', r.headers.authorization);
  assert.ok(findLeaks(probe, pwNeedles).some((f) => f.form.startsWith('base64')), 'the password\'s base64 form is not found in the Apple authorization header');
  // GitHub saw its own token and nothing of Apple's
  assert.ok(github.calls.every((c) => c.headers.authorization === `Bearer ${GH_TOKEN}`), 'a GitHub request lacks the GitHub token');
});

test('R102 the page never contains the user name', async () => {
  let html = '';
  await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res } = await ctx.page(port, 'good');
    html = res.body;
    assert.ok(res.body.includes('Dentist'), 'the iCloud event is not on the page');
  }, { block: CALENDAR_BLOCK });
  const cap = newCap();
  addItem(cap, 'body', 'page', html);
  assert.deepEqual(findLeaks(cap, needles(ICLOUD_USER)), []);
  assert.deepEqual(findLeaks(cap, needles(ICLOUD_PASSWORD)), []);
});

// ---------------------------------------------------------------- the hunt itself

test('U the hunt reports a sentinel planted in a captured item, in every encoded form', () => {
  const forms = {
    raw: ICLOUD_PASSWORD,
    'url-encoded': encodeURIComponent(`${ICLOUD_PASSWORD} & ${ICLOUD_USER}`),
    hex: Buffer.from(ICLOUD_PASSWORD).toString('hex'),
    base64: Buffer.from(`${ICLOUD_USER}:${ICLOUD_PASSWORD}`).toString('base64'),
  };
  for (const [name, text] of Object.entries(forms)) {
    const cap = newCap();
    addItem(cap, 'log', 'planted line', `before ${text} after`);
    const found = findLeaks(cap, needles(ICLOUD_PASSWORD));
    assert.ok(found.length > 0, `a ${name} copy of the password was not found`);
    assert.equal(found[0].kind, 'log');
    assert.equal(found[0].where, 'planted line');
  }
  const user = newCap();
  addItem(user, 'body', 'page', `<p>${ICLOUD_USER}</p>`);
  assert.ok(findLeaks(user, needles(ICLOUD_USER)).length > 0, 'the user name was not found');
  const clean = newCap();
  addItem(clean, 'body', 'page', '<p>nothing here</p>');
  assert.deepEqual(findLeaks(clean, needles(ICLOUD_PASSWORD)), []);
});

test('U the calendar section finder and the broken card marker see what the tests rely on', async () => {
  let okHtml = '';
  let brokenHtml = '';
  await withSession(async (ctx) => {
    okHtml = (await ctx.page(await ctx.boot({ sub: 'a' }), 'state file')).res.body;
  }, { block: null, stateCalendar: FILE_EVENT_TEXT });
  await withSession(async (ctx) => {
    brokenHtml = (await ctx.page(await ctx.boot({ sub: 'b' }), 'no login')).res.body;
  }, { block: CALENDAR_BLOCK, env: {} });
  assert.ok(sectionOf(okHtml, 'calendar').includes('Standup'));
  assert.ok(!sectionOf(okHtml, 'calendar').includes('class="panel-error"'));
  assert.ok(sectionOf(brokenHtml, 'calendar').includes('class="panel-error"'));
  assert.equal(sectionOf('<p>none</p>', 'calendar'), null);
});
