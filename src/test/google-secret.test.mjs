// R126 (the secret address shows nowhere, and R75 and R66 hold for it) and R128 (a board that does not use the
// Google source is unchanged, whatever its environment holds), written from the contract before the code exists.
// The path is the board's own: the real server, one fetch that plays GitHub, an invented iCloud and an invented
// Google (fixtures/fake-google-ical.mjs), and the sentinel addresses hunted in everything the board outputs.
// board/calendar/google.mjs, readGoogleIcal and the server's building of the Google source do not exist yet and
// are reached lazily, so each test fails by itself.
//
// What the R126 sweep captures: every response (status line, headers, body), every console and process.stdout
// and process.stderr write and every line given to the board's logger, every form token, every file in the data
// directory (last-good.json whole), and every request to GitHub (address, headers, body).
// What it cannot capture: the arguments of a real running process (a release-checklist line: `ps -o args` of the
// running board holds none of the three), anything written outside the data directory, and output of a process
// the board does not start. The static argument checks below say what can be said without a real process.
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
import { fakeGoogleIcal, icsFeed } from '../fixtures/fake-google-ical.mjs';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { needles, findLeaks, newCap, addItem } from '../fixtures/leak-hunt.mjs';
import { createLoader } from '../board/load.mjs';
import { createCalendarSource } from '../board/calendar/icloud.mjs';
import { buildBoard } from '../board/model.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { settings } from '../fixtures/build.mjs';

const { start } = await import('../board/server.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD_DIR = path.join(HERE, '..', 'board');
const SCRIPTS_DIR = path.join(HERE, '..', 'scripts');
const GH_TOKEN = 'ghp-github-fixture-token-77-keep-out'; // deliberately shares nothing with the sentinels
const ICLOUD_USER = 'icloud.fixture.user.51@example.com';
const ICLOUD_PASSWORD = 'icloud-fixture-password-0c52';
const MIN = 60 * 1000;
const CLOCK = { t: Date.parse('2026-10-12T06:10:00Z'), now() { return CLOCK.t; } };
const BASE_ENV = { BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const NAMES = ['Home', 'Work', 'Gym', 'Club', 'Kids'];

// ---------------------------------------------------------------- the sentinels

// Sixteen sentinel addresses, one per place (the redirect chain uses 13 to 16), and the same with `http:` for refused ones.
const addr = (p) => `https://calendar.google.com/calendar/ical/SENTINEL-CAL-ID-${p}/private-SENTINEL-TOKEN-${p}/basic.ics`;
const refused = (p) => `http://calendar.google.com/calendar/ical/SENTINEL-CAL-ID-${p}/private-SENTINEL-TOKEN-${p}/basic.ics`;
const PLACES = Array.from({ length: 16 }, (_, i) => i + 1);
const SECRETS = [
  ...PLACES.flatMap((p) => [addr(p), refused(p), `SENTINEL-CAL-ID-${p}`, `private-SENTINEL-TOKEN-${p}`]),
  'SENTINEL-CAL-ID', 'SENTINEL-TOKEN',
  'calendar.google.com/calendar/ical/',
];
const PARTS = ['SENTINEL-CAL-ID', 'SENTINEL-TOKEN'];

// Where in a capture any secret turns up, raw, lower-cased (case-insensitive), url-encoded, form-encoded, hex and base64.
function hunt(cap) {
  const lowered = { items: cap.items.map((i) => ({ ...i, text: i.text.toLowerCase() })) };
  const out = [];
  for (const secret of SECRETS) {
    const list = needles(secret);
    for (const f of findLeaks(cap, list)) out.push(`${f.form} form of ${secret.length > 40 ? 'an address' : secret} in ${f.kind} at ${f.where}`);
    const low = new Map([...list].map(([value, name]) => [value.toLowerCase(), name + ', case-insensitive']));
    for (const f of findLeaks(lowered, low)) out.push(`${f.form} form of ${secret.length > 40 ? 'an address' : secret} in ${f.kind} at ${f.where}`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- invented data

const DENTIST = { title: 'Dentist', start: '20261012T083000Z', end: '20261012T090000Z' }; // 10:30 Brussels
const STANDUP = { title: 'Standup', start: '20261012T070000Z', end: '20261012T073000Z' }; // 09:00 Brussels
const FILE_EVENT_TEXT = JSON.stringify({ date: '2026-10-12', events: [{ title: 'Standup file', start: '08:00', end: '08:15', kind: 'meeting' }] });
const GBLOCK = { source: 'google', calendars: [{ name: 'Home', kind: 'personal' }, { name: 'Work' }] };
const FIVE_BLOCK = { source: 'google', calendars: NAMES.map((name) => ({ name })) };
const ICLOUD_BLOCK = { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }] };
const varsFor = (map) => Object.fromEntries(Object.entries(map).map(([place, value]) => [`BOARD_GOOGLE_ICAL_${place}`, value]));

function appleWorld() {
  return fakeCalDav({ user: ICLOUD_USER, password: ICLOUD_PASSWORD, calendars: [{ name: 'Home', ics: [vcalendar(vevent({ uid: 'dentist-i@example.com', summary: 'Dentist', start: '20261012T083000Z', end: '20261012T090000Z' }))] }] });
}

function settingsText(block, mutate) {
  const s = JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'settings', 'base.json'), 'utf8'));
  s.projects = [{ key: 'house', number: 3 }];
  s.focus = ['house'];
  s.habits = [{ id: 'move', title: 'Move', start: '2026-09-22' }];
  s.season.goals = [{ title: 'Finish the kitchen and bathroom', project: 'house' }];
  if (block) s.calendar = block;
  if (mutate) mutate(s);
  return JSON.stringify(s);
}

// ---------------------------------------------------------------- the fake GitHub

function fakeResponse(status, body) {
  const text = JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => JSON.parse(text), text: async () => text };
}

function makeGithub({ block, mutate, stateCalendar = null }) {
  const gh = { mode: 'good', calls: [] };
  const store = new Map();
  const list = [...worldIssues(), apiIssue(20, { title: 'Plan the garden', labels: [{ id: 3, name: 'idea', color: 'cccccc' }] })];
  for (const i of list) store.set(i.number, i);
  const table = worldRoutes({
    issues: list,
    files: {
      'board.config.json': settingsText(block, mutate),
      'theme.json': null, 'state/brief.json': null, 'state/calendar.json': stateCalendar,
      'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null,
    },
  });
  let next = 100;
  gh.fetch = async (url, init = {}) => {
    const method = (init && init.method) || 'GET';
    gh.calls.push({ url: String(url), method, headers: Object.fromEntries([...new Headers((init && init.headers) || {})]), body: init && typeof init.body === 'string' ? init.body : '' });
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

// `google` records every request for calendar.google.com (as the board sent it) before the stand-in answers.
// An address in `rejectAddresses` makes the stand-in fail the way a real fetch can: with an error whose message
// (and cause) carries the address.
function makeRouter({ github, apple, google, rejectAddresses = [] }) {
  const router = { apple, github, google, rejectAddresses: new Set(rejectAddresses), googleSeen: [], appleSeen: [], foreign: [], all: [] };
  router.fetch = async (url, init = {}) => {
    const href = String(url instanceof URL ? url.href : (url && url.url) || url);
    let host = '';
    try { host = new URL(href).hostname; } catch { host = ''; }
    const headers = {};
    for (const [n, v] of new Headers((init && init.headers) || {})) headers[n.toLowerCase()] = v;
    const rec = { host, url: href, method: String((init && init.method) || 'GET').toUpperCase(), headers, redirect: init && init.redirect, body: init && typeof init.body === 'string' ? init.body : '' };
    router.all.push(rec);
    if (host === 'api.github.com') return router.github.fetch(url, init);
    if (isApple(host)) { router.appleSeen.push(rec); return router.apple.fetch(url, init); }
    if (host === 'calendar.google.com') {
      router.googleSeen.push(rec);
      if (router.rejectAddresses.has(href)) {
        const err = new TypeError(`fetch failed: connect ECONNRESET while requesting ${href}`);
        err.cause = new Error(`socket closed for ${href}`);
        throw err;
      }
      return router.google(url, init);
    }
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
      res.on('end', () => done({ status: res.statusCode, statusLine: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => done({ status: 0, statusLine: 'aborted', rawHeaders: [], body: '' }));
    });
    req.on('error', (err) => done({ status: 0, statusLine: `client-error ${err && err.code}`, rawHeaders: [], body: '' }));
    const timer = setTimeout(() => { req.destroy(); done({ status: 0, statusLine: 'timeout', rawHeaders: [], body: '' }); }, 30000);
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

function sectionOf(html, name) {
  const at = html.indexOf(`data-section="${name}"`);
  if (at < 0) return null;
  const from = html.lastIndexOf('<', at);
  const next = html.indexOf('data-section="', at + 10);
  return html.slice(from, next < 0 ? html.length : html.lastIndexOf('<', next));
}

// ---------------------------------------------------------------- one session

async function withSession(body, { block = null, mutate = null, stateCalendar = null, env = {}, feeds = {}, rejectAddresses = [], withApple = false } = {}) {
  const cap = newCap();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-gsecret-'));
  const github = makeGithub({ block, mutate, stateCalendar });
  const google = fakeGoogleIcal({ feeds });
  const router = makeRouter({ github, apple: withApple ? appleWorld() : null, google, rejectAddresses });
  const running = [];
  const restore = installStdCapture(cap);
  const log = (line) => { cap.counts.logs += 1; addItem(cap, 'log', 'log line', line); };
  let failure = null;
  const ctx = {
    cap, dir, github, router, google, log,
    async boot({ sub = 'data', envExtra = {} } = {}) {
      const r = await start({ processEnv: { ...BASE_ENV, BOARD_DATA_DIR: path.join(dir, sub), ...env, ...envExtra }, fetch: router.fetch, clock: CLOCK, log });
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
      for (const f of forms) if (f.fields.token) { cap.counts.formTokens += 1; addItem(cap, 'form-token', `${f.action} [${label}]`, f.fields.token); }
      return { res, forms };
    },
    async post(port, label, form, token) {
      const f = token === undefined ? form : { ...form, fields: { ...form.fields, token } };
      return ctx.request(port, label, { method: 'POST', reqPath: form.action, headers: { ...FORM, origin: `http://localhost:${port}` }, body: submission(f) });
    },
    // every route, every action once (and once with a bad token), then the page again
    async sweep(port, label) {
      const { res, forms } = await ctx.page(port, label);
      await ctx.request(port, label, { reqPath: '/healthz' });
      await ctx.request(port, label, { reqPath: '/static/board.css' });
      await ctx.request(port, label, { reqPath: '/static/board.js' });
      await ctx.request(port, label, { reqPath: '/nope' });
      await ctx.request(port, label, { method: 'DELETE', reqPath: '/' });
      await ctx.request(port, label, { reqPath: '/', headers: { host: 'evil.example:80' } });
      const seen = new Set();
      for (const f of forms) {
        const key = f.action + (f.fields.accept === '1' ? '+accept' : '');
        if (seen.has(key)) continue;
        seen.add(key);
        await ctx.post(port, `${label}, valid token`, f);
        await ctx.post(port, `${label}, bad token`, f, 'not.a.token');
      }
      await ctx.page(port, `${label}, after the actions`);
      return { res, forms };
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
  const files = {};
  try {
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
          files[rel] = text;
        }
      }
    };
    await walk(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const [i, c] of github.calls.entries()) {
    cap.counts.outbound += 1;
    addItem(cap, 'github-request-line', `#${i} ${c.method}`, c.url);
    addItem(cap, 'github-request-headers', `#${i} ${c.method}`, JSON.stringify(c.headers));
    addItem(cap, 'github-request-body', `#${i} ${c.method}`, c.body);
  }
  if (failure) throw failure;
  return { cap, github, router, google, files };
}

const TOTALS = { responses: 0, logs: 0, formTokens: 0, files: 0, googleRequests: 0, githubRequests: 0 };

// The checks every session of R126 ends with. `seen`: addresses the stand-in must have been asked for;
// `notSeen`: addresses it must not have been asked for.
function finish(s, { seen = [], notSeen = [], label, needFiles = true, minResponses = 6 }) {
  const { cap, router, github } = s;
  assert.ok(cap.counts.responses >= minResponses, `${label}: only ${cap.counts.responses} responses were captured, so the sweep proves nothing`);
  assert.ok(cap.counts.logs > 0, `${label}: no log line was captured`);
  if (needFiles) assert.ok(cap.counts.files >= 1, `${label}: no file of the data directory was captured`);
  assert.ok(github.calls.length > 0, `${label}: GitHub was never asked`);
  assert.equal(router.foreign.length, 0, `${label}: requests went to a foreign host: ${router.foreign.map((r) => r.host).join(', ')}`);

  // nothing the board outputs, writes or sends to GitHub holds any form of any address or part of one
  const found = hunt(cap);
  assert.deepEqual(found, [], `${label}: the secret address was found in captured material:\n  ${found.join('\n  ')}`);

  // the other direction: the stand-in saw the address, in the request line only
  const asked = router.googleSeen.map((r) => r.url);
  for (const a of seen) assert.ok(asked.includes(a), `${label}: the stand-in Google was never asked for ${a.replace(/SENTINEL-TOKEN-\d+/, 'SENTINEL-TOKEN-n')}, so the checks above prove nothing for it`);
  for (const a of notSeen) assert.equal(asked.includes(a), false, `${label}: the stand-in Google was asked for an address it must not be asked for (${a.slice(0, 40)}…)`);
  if (seen.length) {
    const probe = newCap();
    for (const u of asked) addItem(probe, 'request-line', 'google', u);
    const hit = new Set(findLeaks(probe, needles('SENTINEL-CAL-ID')).map((f) => f.kind));
    assert.ok(hit.has('request-line'), `${label}: SENTINEL-CAL-ID is not in the recorded request lines`);
    assert.ok(findLeaks(probe, needles('SENTINEL-TOKEN')).length > 0, `${label}: SENTINEL-TOKEN is not in the recorded request lines`);
  }
  for (const r of router.googleSeen) {
    assert.equal(r.method, 'GET', `${label}: a ${r.method} went to Google`);
    assert.equal(r.redirect, 'manual', `${label}: a request to Google was not sent with redirect: 'manual'`);
    assert.equal(r.body, '', `${label}: a request to Google carried a body`);
    for (const name of ['authorization', 'cookie', 'referer']) assert.equal(Object.hasOwn(r.headers, name), false, `${label}: a request to Google carried ${name}`);
    for (const [name, value] of Object.entries(r.headers)) {
      for (const part of PARTS) assert.equal(String(value).toLowerCase().includes(part.toLowerCase()), false, `${label}: ${part} is in the header "${name}" of a request to Google`);
    }
    assert.equal(r.host, 'calendar.google.com');
  }
  for (const c of github.calls) {
    for (const part of PARTS) {
      assert.equal((c.url + JSON.stringify(c.headers) + c.body).toLowerCase().includes(part.toLowerCase()), false, `${label}: ${part} was sent to GitHub`);
    }
  }
  for (const k of ['responses', 'logs', 'formTokens', 'files']) TOTALS[k] += cap.counts[k];
  TOTALS.googleRequests += router.googleSeen.length;
  TOTALS.githubRequests += github.calls.length;
}

// ======================= R126 =======================

test('R126 every route and action with two good calendars: the address is found nowhere, and the stand-in saw it in the request line only', async () => {
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res, forms } = await ctx.sweep(port, 'good');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Dentist') && res.body.includes('Standup'), 'the Google events are not on the page, so the sweep did not reach the calendar');
    for (const a of ['/actions/idea', '/actions/habit', '/actions/close']) assert.ok(forms.some((f) => f.action === a), `the page has no form for ${a}, so that action was not swept`);
  }, { block: GBLOCK, env: varsFor({ 1: addr(1), 2: addr(2) }), feeds: { [addr(1)]: icsFeed([DENTIST]), [addr(2)]: icsFeed([STANDUP]) } });
  finish(s, { seen: [addr(1), addr(2)], label: 'good' });
  assert.ok(s.github.writes().length > 0, 'no write reached GitHub, so the actions were not swept');
});

test('R126 a 404, a 503, an HTML answer, a feed over the size limit and a refused address: the address is found nowhere', async () => {
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res } = await ctx.sweep(port, 'failures');
    assert.equal(res.status, 200);
    const warm = await ctx.boot({ sub: 'restart' });
    await ctx.page(warm, 'failures, a second board');
  }, {
    block: FIVE_BLOCK,
    env: varsFor({ 1: addr(1), 2: addr(2), 3: addr(3), 4: addr(4), 5: refused(5) }),
    feeds: {
      [addr(1)]: { status: 404 },
      [addr(2)]: { status: 503 },
      [addr(3)]: { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>Sign in</html>' },
      [addr(4)]: { stream: 10000001 },
    },
  });
  finish(s, { seen: [addr(1), addr(2), addr(3), addr(4)], notSeen: [refused(5)], label: 'failures' });
});

test('R126 a redirect to another host, a login page, a chain of four redirects, a redirect with no Location and a fetch that fails with the address in its message: the address is found nowhere', async () => {
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res } = await ctx.sweep(port, 'redirects');
    assert.equal(res.status, 200);
    assert.ok(sectionOf(res.body, 'footer'), 'the page has no footer, so no warning was captured');
  }, {
    block: FIVE_BLOCK,
    env: varsFor({ 1: addr(1), 2: addr(2), 3: addr(3), 4: addr(4), 5: addr(5) }),
    rejectAddresses: [addr(5)],
    feeds: {
      [addr(1)]: { redirect: 'https://accounts.google.com/ServiceLogin' },
      [addr(2)]: { redirect: 'https://evil.example/x' },
      [addr(3)]: { redirect: addr(13) },
      [addr(13)]: { redirect: addr(14) },
      [addr(14)]: { redirect: addr(15) },
      [addr(15)]: { redirect: addr(16) },
      [addr(16)]: icsFeed([DENTIST]),
      [addr(4)]: { redirect: '' },
    },
  });
  finish(s, { seen: [addr(1), addr(2), addr(3), addr(13), addr(14), addr(15), addr(4), addr(5)], notSeen: [addr(16)], label: 'redirects' });
});

test('R126 no address set (blank, and a variable beyond the fifth): the address is found nowhere and nothing is requested', async () => {
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res } = await ctx.sweep(port, 'no address');
    assert.equal(res.status, 200);
  }, { block: GBLOCK, env: { BOARD_GOOGLE_ICAL_1: '   ', BOARD_GOOGLE_ICAL_6: addr(6) }, feeds: { [addr(6)]: icsFeed([DENTIST]) } });
  finish(s, { label: 'no address' });
  assert.equal(s.router.googleSeen.length, 0, 'a request went to Google although no calendar has a usable address');
});

test('R126 a calendar that never answers (the time limit): the address is found nowhere, the other calendar is shown', async () => {
  const s = await withSession(async (ctx) => {
    const port = await ctx.boot();
    const { res } = await ctx.page(port, 'time limit');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Standup'), 'the calendar that answered is not shown');
    await ctx.request(port, 'time limit', { reqPath: '/healthz' });
    await ctx.page(port, 'time limit, again');
    await ctx.request(port, 'time limit', { reqPath: '/static/board.css' });
    await ctx.request(port, 'time limit', { reqPath: '/static/board.js' });
  }, { block: GBLOCK, env: varsFor({ 1: addr(1), 2: addr(2) }), feeds: { [addr(1)]: { never: true }, [addr(2)]: icsFeed([STANDUP]) } });
  finish(s, { seen: [addr(1), addr(2)], label: 'time limit', minResponses: 5 });
});

test('R126 a good read, then a failing one six minutes later on a restarted board, then GitHub down: last-good.json holds titles and no address', async () => {
  const t0 = CLOCK.t;
  let s;
  try {
  s = await withSession(async (ctx) => {
    const first = await ctx.boot({ sub: 'warm' });
    const { res } = await ctx.page(first, 'warm, good');
    assert.ok(res.body.includes('Dentist'), 'the Google event is not on the page');
    ctx.google.feeds[addr(1)] = { status: 503 };
    CLOCK.t += 6 * MIN;
    const second = await ctx.boot({ sub: 'warm' });
    await ctx.page(second, 'warm, Google failing');
    ctx.github.mode = 'down500';
    const cold = await ctx.boot({ sub: 'cold' });
    await ctx.page(cold, 'cold, GitHub down');
    await ctx.page(second, 'warm, GitHub down');
  }, { block: GBLOCK, env: varsFor({ 1: addr(1), 2: addr(2) }), feeds: { [addr(1)]: icsFeed([DENTIST]), [addr(2)]: icsFeed([STANDUP]) } });
  } finally {
    CLOCK.t = t0;
  }
  finish(s, { seen: [addr(1), addr(2)], label: 'warm', minResponses: 4 });
  const kept = Object.entries(s.files).filter(([name]) => name.endsWith('last-good.json'));
  assert.ok(kept.length >= 1, `no last-good.json was written: ${Object.keys(s.files).join(', ')}`);
  assert.ok(kept.some(([, text]) => text.includes('Standup')), 'today\'s event titles are not in the board\'s last good read');
  for (const [name, text] of kept) {
    const cap = newCap();
    addItem(cap, 'file', name, text);
    assert.deepEqual(hunt(cap), [], `${name} holds an address or a part of one`);
  }
});

test('R126 a settings file that holds the address (in a url key, in a name, in agentName) gives a 503 page naming the key and none of the address', async () => {
  const variants = [
    ['calendar', (s) => { s.calendar = { source: 'google', calendars: [{ name: 'Home', url: addr(1) }] }; }],
    ['calendar', (s) => { s.calendar = { source: 'google', calendars: [{ name: addr(1) }] }; }],
    ['agentName', (s) => { s.agentName = addr(1); s.calendar = { source: 'google', calendars: [{ name: 'Home' }] }; }],
  ];
  for (const [key, mutate] of variants) {
    let status = 0; let body = '';
    const s = await withSession(async (ctx) => {
      const port = await ctx.boot();
      const { res } = await ctx.page(port, 'settings hold the address');
      status = res.status; body = res.body;
      await ctx.request(port, 'settings hold the address', { reqPath: '/healthz' });
      await ctx.request(port, 'settings hold the address', { reqPath: '/static/board.css' });
      await ctx.request(port, 'settings hold the address', { reqPath: '/static/board.js' });
      await ctx.request(port, 'settings hold the address', { reqPath: '/nope' });
      await ctx.request(port, 'settings hold the address', { method: 'DELETE', reqPath: '/' });
    }, { mutate, env: varsFor({ 1: addr(1) }), feeds: { [addr(1)]: icsFeed([DENTIST]) } });
    assert.equal(status, 503, `a settings file holding an address in ${key} must give the 503 page`);
    assert.ok(body.includes(key), `the page does not name the top-level key ${key}`);
    assert.ok(/google calendar address/i.test(unesc(body)), 'the page does not say that the file holds a Google Calendar address');
    assert.equal(s.router.googleSeen.length, 0, 'Google was asked although the settings file is invalid');
    finish(s, { label: 'settings with the address in ' + key, needFiles: false });
  }
});

// ---- errors thrown or logged when the stand-in rejects ----

async function googleModule() {
  const mod = await import('../board/calendar/google.mjs');
  assert.equal(typeof mod.createGoogleSource, 'function', 'board/calendar/google.mjs does not export createGoogleSource');
  return mod;
}

test('R126 a fetch that rejects with the address in its message or its cause, and a body that breaks with it: read never throws and nothing echoes the address', async () => {
  const { createGoogleSource } = await googleModule();
  const a = addr(1);
  const throwing = async (url) => {
    const err = new TypeError(`fetch failed: connect ECONNRESET while requesting ${url}`);
    err.cause = new Error(`socket closed for ${url}`);
    err.stack = `TypeError: ${err.message}\n    at fetch (${url})`;
    throw err;
  };
  const breaking = async () => new Response(new ReadableStream({ start(c) { c.error(new Error(`stream broke while reading ${a}`)); } }), { status: 200, headers: { 'content-type': 'text/calendar' } });
  const abortLike = async (url) => { throw new DOMException(`The operation to ${url} was aborted`, 'AbortError'); };
  const cap = newCap();
  const restore = installStdCapture(cap);
  const results = [];
  try {
    for (const [label, fetch] of [['a rejecting fetch', throwing], ['a breaking body', breaking], ['an abort that names the address', abortLike]]) {
      const source = createGoogleSource({ fetch, addresses: { 1: a }, budgetMs: 800, requestMs: 400 });
      let out; let thrown = null;
      try { out = await source.read({ calendars: [{ name: 'Home', kind: 'meeting', place: 1 }], tz: 'Europe/Brussels', now: '2026-10-12T06:10:00.900Z' }); } catch (err) { thrown = err; }
      assert.equal(thrown, null, `${label}: read threw ${thrown && thrown.name}`);
      results.push([label, out]);
      addItem(cap, 'read result', label, JSON.stringify(out));
    }
  } finally {
    restore();
  }
  for (const [label, out] of results) {
    assert.ok(out && out.value, `${label}: read gave no value`);
    assert.deepEqual(out.warnings.filter((w) => w.code.startsWith('calendar-google-')), [{ code: 'calendar-google-unreachable', count: 1, names: ['Home'] }], `${label}: expected calendar-google-unreachable once, naming Home`);
  }
  const found = hunt(cap);
  assert.deepEqual(found, [], `the address was echoed:\n  ${found.join('\n  ')}`);
});

test('R126 the stand-in\'s own record is the only place the address is, and it is in the request line: the helper sees what it should', async () => {
  const { createGoogleSource } = await googleModule();
  const fake = fakeGoogleIcal({ feeds: { [addr(1)]: icsFeed([DENTIST]) } });
  const source = createGoogleSource({ fetch: fake, addresses: { 1: addr(1) }, budgetMs: 800, requestMs: 400 });
  const out = await source.read({ calendars: [{ name: 'Home', kind: 'meeting', place: 1 }], tz: 'Europe/Brussels', now: '2026-10-12T06:10:00.900Z' });
  assert.deepEqual(out.value.events.map((e) => e.title), ['Dentist']);
  const cap = newCap();
  addItem(cap, 'read result', 'one good read', JSON.stringify(out));
  assert.deepEqual(hunt(cap), [], 'a good read\'s result holds the address');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, addr(1));
  for (const [name, value] of Object.entries(fake.calls[0].headers)) assert.equal(/SENTINEL/i.test(value), false, `the address is in the header ${name}`);
});

// ---- the process arguments ----

test('R126 no script of the board takes an address as an argument, and the server reads no argument but its own file name', async () => {
  const server = readFileSync(path.join(BOARD_DIR, 'server.mjs'), 'utf8');
  assert.equal(/process\.argv(?!\[1\])/.test(server), false, 'board/server.mjs reads process.argv beyond process.argv[1] (its own path)');
  assert.equal(/\bargv\b/.test(server.replace(/process\.argv\[1\]/g, '')), false, 'board/server.mjs handles argv');
  const boardFiles = (await readdir(BOARD_DIR, { recursive: true })).filter((f) => f.endsWith('.mjs'));
  assert.ok(boardFiles.length > 10, 'the board folder was not read');
  for (const f of boardFiles) {
    const text = readFileSync(path.join(BOARD_DIR, f), 'utf8');
    assert.equal(/child_process/.test(text), false, `board/${f} can start a process, which could be handed the address`);
  }
  let google = null;
  try { google = readFileSync(path.join(BOARD_DIR, 'calendar', 'google.mjs'), 'utf8'); } catch { google = null; }
  assert.ok(google !== null, 'board/calendar/google.mjs does not exist');
  assert.equal(/process\.argv|child_process/.test(google), false, 'board/calendar/google.mjs reads argv or starts a process');
  const scripts = (await readdir(SCRIPTS_DIR)).filter((f) => f.endsWith('.mjs'));
  assert.ok(scripts.length >= 5, 'the scripts folder was not read');
  for (const f of scripts) {
    const text = readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
    for (const m of text.matchAll(/'(--[a-z][a-z-]*)'/g)) {
      assert.equal(/google|ical|address|url|secret|link|feed/i.test(m[1]), false, `scripts/${f} takes the argument ${m[1]}, which could carry an address`);
    }
  }
  // Not testable here, and left to the release checklist: the argument list of the real running board
  // (`ps -o args= -p <pid>`) holds none of the three, the address coming only from the environment.
});

// ======================= R128 =======================

const ENV_CASES = [
  ['none', {}],
  ['all five valid', varsFor({ 1: addr(1), 2: addr(2), 3: addr(3), 4: addr(4), 5: addr(5) })],
  ['all five "not an address"', varsFor({ 1: 'not an address', 2: 'not an address', 3: 'not an address', 4: 'not an address', 5: 'not an address' })],
];
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const AT = '2026-10-12T06:10:00.900Z';

function notFound(p) { return new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.'); }
function makeHttp(files, calls) {
  const answer = (method, p) => {
    calls.push(method + ' ' + p);
    if (p === R) return { private: true, owner: { login: 'sam-life', type: 'Organization' } };
    if (p.startsWith(R + '/contents/')) {
      const f = p.slice((R + '/contents/').length);
      if (!Object.hasOwn(files, f) || files[f] === null) throw notFound(p);
      return { content: Buffer.from(files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?') || p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    if (p === '/orgs/sam-life/projectsV2?per_page=100') return { items: [], partial: false };
    throw notFound(p);
  };
  return { async get(p) { return { status: 200, json: answer('get', p), notModified: false, link: null }; }, async paged(p) { return answer('paged', p); } };
}

// The loader's path, as the server builds it: an iCloud source, and a Google source from the environment's addresses.
async function boardFor(block, vars) {
  const { createGoogleSource } = await googleModule();
  const mod = await import('../board/env.mjs');
  assert.equal(typeof mod.readGoogleIcal, 'function', 'board/env.mjs does not export readGoogleIcal');
  const feeds = Object.fromEntries([1, 2, 3, 4, 5].map((p) => [addr(p), icsFeed([{ title: 'Google only ' + p, start: '20261012T100000Z', end: '20261012T103000Z' }])]));
  const stand = fakeGoogleIcal({ feeds });
  const apple = appleWorld();
  const ghCalls = [];
  const cfg = settings({ timezone: 'Europe/Brussels', ...(block === undefined ? {} : { calendar: block }) });
  const files = {
    'board.config.json': JSON.stringify(cfg), 'theme.json': null, 'state/brief.json': null, 'state/calendar.json': FILE_EVENT_TEXT,
    'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null,
  };
  const cache = { async readLastGood() { return null; }, async writeLastGood() {}, etags: { get() {}, set() {} } };
  const clock = { now: () => Date.parse(AT) };
  const env = { repo: REPO_NAME, readOnly: false, configDir: null, token: GH_TOKEN };
  const calendar = createCalendarSource({ fetch: apple.fetch, login: { user: ICLOUD_USER, password: ICLOUD_PASSWORD } });
  const googleCalendar = createGoogleSource({ fetch: stand, addresses: (await mod.readGoogleIcal(vars)) ?? {}, budgetMs: 800, requestMs: 400 });
  const loader = createLoader({ http: makeHttp(files, ghCalls), env, cache, clock, calendar, googleCalendar });
  const out = await loader.load();
  assert.equal(out.ok, true, 'the board did not load (the harness is wrong, not the rule)');
  const board = buildBoard({ ...out.bundle, now: AT });
  const html = renderPage(board, THEME, OPTS);
  return { board, html, panel: board.panels.calendar, appleCalls: apple.calls.map((c) => c.method + ' ' + c.url), ghCalls, googleCalls: stand.calls };
}
const REPO_NAME = 'sam-life/life';

for (const [label, block] of [['source icloud with a working iCloud', ICLOUD_BLOCK], ['no calendar block', undefined]]) {
  test(`R128 ${label}: the board, the page and the requests are equal with no variable, with all five valid and with all five "not an address"; Google is never asked`, async () => {
    const runs = [];
    for (const [name, vars] of ENV_CASES) runs.push([name, await boardFor(block, vars)]);
    const [, base] = runs[0];
    if (block) assert.ok(base.appleCalls.length > 0, 'iCloud was never asked, so the comparison proves nothing');
    assert.ok(base.ghCalls.length > 0, 'GitHub was never asked');
    for (const [name, r] of runs) {
      assert.deepEqual(r.board, base.board, `${name}: the board differs from the one with no variable`);
      assert.equal(r.html, base.html, `${name}: the page differs from the one with no variable`);
      assert.equal(JSON.stringify(r.board), JSON.stringify(base.board), `${name}: the board differs byte for byte`);
      assert.deepEqual(r.appleCalls, base.appleCalls, `${name}: the requests to iCloud differ`);
      assert.deepEqual(r.ghCalls, base.ghCalls, `${name}: the requests to GitHub differ`);
      assert.equal(r.googleCalls.length, 0, `${name}: ${r.googleCalls.length} request(s) went to the stand-in Google`);
      assert.equal(r.html.includes('data-source'), false, `${name}: data-source on the page`);
      assert.equal(r.html.includes('Google only'), false, `${name}: a Google event is on the page`);
      assert.equal((r.board.meta.warnings || []).some((w) => Object.hasOwn(w, 'names') || w.code.startsWith('calendar-google-')), false, `${name}: a names key or a Google warning is in the board`);
    }
    assert.equal(runs[0][1].panel.error, undefined, 'the panel of the baseline is broken, so the equality proves little');
  });
}

for (const [label, block, stateCalendar] of [['source icloud with a working iCloud', ICLOUD_BLOCK, FILE_EVENT_TEXT], ['no calendar block', null, FILE_EVENT_TEXT]]) {
  test(`R128 started as a real board, ${label}: the requests, the files written and the stand-in Google are the same with no variable, all five valid and all five "not an address"`, async () => {
    const marks = {};
    const pages = {};
    const s = await withSession(async (ctx) => {
      for (const [name, vars] of ENV_CASES) {
        const sub = name.replace(/\W+/g, '-');
        const mark = ctx.router.all.length;
        const port = await ctx.boot({ sub, envExtra: vars });
        const { res } = await ctx.page(port, name);
        assert.equal(res.status, 200, name);
        pages[name] = res.body;
        marks[name] = { sub, from: mark, to: ctx.router.all.length };
      }
    }, {
      block, stateCalendar, env: block ? { BOARD_ICLOUD_USER: ICLOUD_USER, BOARD_ICLOUD_APP_PASSWORD: ICLOUD_PASSWORD } : {}, withApple: true,
      feeds: Object.fromEntries([1, 2, 3, 4, 5].map((p) => [addr(p), icsFeed([{ title: 'Google only', start: '20261012T100000Z', end: '20261012T103000Z' }])])),
    });
    assert.equal(s.router.googleSeen.length, 0, `${s.router.googleSeen.length} request(s) went to calendar.google.com`);
    assert.equal(s.google.calls.length, 0, 'the stand-in Google recorded a call');
    const lines = (name) => s.router.all.slice(marks[name].from, marks[name].to).map((r) => `${r.method} ${r.url} ${JSON.stringify(r.headers)}`);
    const base = lines('none');
    assert.ok(base.length > 0, 'the board made no request, so the comparison proves nothing');
    for (const [name] of ENV_CASES) {
      assert.deepEqual(lines(name), base, `${name}: the requests differ from those of the board started with no variable`);
      assert.equal(pages[name].includes('data-source'), false, `${name}: data-source on the page`);
      assert.equal(pages[name].includes('Google only'), false, `${name}: a Google event is on the page`);
      assert.equal(/calendar-google|"names"/.test(pages[name]), false, `${name}: a names key or a Google warning on the page`);
    }
    const written = (name) => Object.fromEntries(Object.entries(s.files).filter(([f]) => f.startsWith(marks[name].sub + path.sep)).map(([f, text]) => [f.slice(marks[name].sub.length + 1), text]));
    const baseFiles = written('none');
    assert.ok(Object.keys(baseFiles).length > 0, 'the board wrote no file, so the comparison proves nothing');
    for (const [name] of ENV_CASES) assert.deepEqual(written(name), baseFiles, `${name}: the files written differ from those of the board started with no variable`);
  });
}

// ---------------------------------------------------------------- the helpers themselves, and the sweep as a whole

test('U the hunt finds an address, SENTINEL-CAL-ID and SENTINEL-TOKEN in every encoded form and in any letter case, and stays quiet on clean text', () => {
  const forms = {
    raw: addr(1),
    'lower-case': addr(1).toLowerCase(),
    'mixed case': addr(1).replace('SENTINEL', 'Sentinel'),
    'url-encoded': encodeURIComponent(addr(1)),
    hex: Buffer.from(addr(1)).toString('hex'),
    base64: Buffer.from('x' + addr(1) + 'y').toString('base64'),
    'cal id': 'in a log: SENTINEL-CAL-ID seen',
    token: 'header: private-SENTINEL-TOKEN-1',
    'token, lower': 'private-sentinel-token-9',
  };
  for (const [name, text] of Object.entries(forms)) {
    const cap = newCap();
    addItem(cap, 'log', 'planted', `before ${text} after`);
    assert.ok(hunt(cap).length > 0, `a ${name} copy was not found`);
  }
  const clean = newCap();
  addItem(clean, 'body', 'page', '<p>Home and Work, nothing else. Google did not answer for these calendars: "Home".</p>');
  assert.deepEqual(hunt(clean), []);
});

test('U the router records a request for calendar.google.com before answering, refuses other hosts, and fails with the address in its message when told to', async () => {
  const github = makeGithub({});
  const google = fakeGoogleIcal({ feeds: { [addr(1)]: icsFeed([DENTIST]) } });
  const router = makeRouter({ github, apple: null, google, rejectAddresses: [addr(2)] });
  const ok = await router.fetch(addr(1), { method: 'GET', headers: { Accept: 'text/calendar' }, redirect: 'manual' });
  assert.equal(ok.status, 200);
  await assert.rejects(() => router.fetch(addr(2), { method: 'GET' }), (err) => err.message.includes(addr(2)));
  await assert.rejects(() => router.fetch('https://evil.example/x'), /foreign host/);
  assert.equal(router.googleSeen.length, 2);
  assert.equal(router.googleSeen[0].redirect, 'manual');
  assert.equal(router.foreign.length, 1);
});

test('R126 the sweep as a whole was not vacuous', (t) => {
  t.diagnostic(`sweep totals: ${JSON.stringify(TOTALS)}`);
  assert.ok(TOTALS.responses >= 40, `only ${TOTALS.responses} responses were examined`);
  assert.ok(TOTALS.logs >= 20, `only ${TOTALS.logs} log lines were examined`);
  assert.ok(TOTALS.formTokens >= 4, `only ${TOTALS.formTokens} form tokens were examined`);
  assert.ok(TOTALS.files >= 4, `only ${TOTALS.files} files were examined`);
  assert.ok(TOTALS.googleRequests >= 15, `only ${TOTALS.googleRequests} requests reached the stand-in Google`);
  assert.ok(TOTALS.githubRequests >= 30, `only ${TOTALS.githubRequests} requests reached GitHub`);
});
