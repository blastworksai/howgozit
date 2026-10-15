// CP3 (SKILLS-75): one GitHub token per owner, and the board's own form key.
// Written from the rules R6, R55, R67, R75, R130 and R131 and from reference/mapping-redesign/cp3-interface.md.
// Every GitHub answer here is an invented one served through the `fetch` the board is given; no fixture was changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { needles, findLeaks, newCap, addItem } from '../fixtures/leak-hunt.mjs';
import {
  issues as worldIssues, milestones as worldMilestones, projectFields, projectItems, apiIssue, R,
} from '../fixtures/github/world.mjs';

const { start } = await import('../board/server.mjs');
const { readEnv } = await import('../board/env.mjs');
const { createGuard } = await import('../board/guard.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-12T06:10:00Z');
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const DEFAULT = 'tok-default-3f9a1c0b77d2e';
const TOK_A = 'tok-owner-a-81b6d4e0c93f1';
const TOK_B = 'tok-owner-b-5c2e7a19d04b8';
const FORM_KEY = 'form-key-0123456789-abcdefghijklmnop';

const BASE_ENV = { BOARD_GITHUB_TOKEN: DEFAULT, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0' };
const READ_BASE = { ...BASE_ENV, BOARD_PORT: '8080', BOARD_DATA_DIR: '/tmp/x-board-data' };
const OWNERS_AB = {
  BOARD_GITHUB_TOKEN_1: TOK_A, BOARD_GITHUB_OWNER_1: 'a',
  BOARD_GITHUB_TOKEN_2: TOK_B, BOARD_GITHUB_OWNER_2: 'b',
};

// ---------------------------------------------------------------- the invented GitHub

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

function authOf(init) {
  const h = init && init.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get('authorization');
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === 'authorization') return String(v);
  return null;
}

function settingsText(projects) {
  const s = JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'settings', 'base.json'), 'utf8'));
  s.projects = projects;
  s.focus = [];
  s.habits = [];
  s.season.goals = [];
  return JSON.stringify(s);
}

const PLIST = (list) => list.map((p) => ({ id: 9000 + p.number, number: p.number, title: p.title, state: p.state || 'open', public: false }));

// owners: login -> { type, projects: [{ number, title }] }. world.down: owners whose every request answers 503.
// world.dataDown: every request outside an owner's projects (and the data repo owner's) answers 503.
function makeWorld({ projects, owners }) {
  const world = {
    calls: [], down: new Set(), dataDown: false, mode: 'good', settings: settingsText(projects), owners,
  };
  const store = new Map();
  const list = [...worldIssues(), apiIssue(20, { title: 'Plan the garden', labels: [{ id: 3, name: 'idea', color: 'cccccc' }] })];
  for (const i of list) store.set(i.number, i);
  let next = 100;
  world.fetch = async (url, init = {}) => {
    const method = (init && init.method) || 'GET';
    const u = new URL(String(url));
    const p = u.pathname;
    const own = /^\/(?:users|orgs)\/([^/]+)/.exec(p);
    const owner = own ? own[1] : null;
    const auth = authOf(init);
    world.calls.push({ url: String(url), method, path: p, owner, auth, headers: { ...(init && init.headers) }, body: init && typeof init.body === 'string' ? init.body : '' });
    if (world.mode === 'net-token') throw new Error(`socket hang up while sending ${auth} to api.github.com`);
    if (world.mode === 'auth401') return fakeResponse(401, { message: 'Bad credentials' });
    if (world.mode === 'down500') return fakeResponse(500, { message: 'Server Error' });
    const isDataSide = owner === null || owner === 'sam-life';
    if (owner !== null && owner !== 'sam-life' && world.down.has(owner)) return fakeResponse(503, { message: 'down' });
    if (isDataSide && world.dataDown) return fakeResponse(503, { message: 'down' });
    if (method !== 'GET') {
      if (world.mode === 'writes500') return fakeResponse(500, { message: 'Server Error' });
      const body = init.body ? JSON.parse(init.body) : {};
      if (method === 'POST' && p === `${R}/issues`) {
        const n = next; next += 1;
        const made = apiIssue(n, { title: body.title, labels: (body.labels || []).map((name) => ({ name })) });
        store.set(n, made);
        return fakeResponse(201, made);
      }
      const m = /\/issues\/(\d+)$/.exec(p);
      if (method === 'PATCH' && m) {
        const n = Number(m[1]);
        const upd = { ...(store.get(n) || apiIssue(n)) };
        if (body.state) upd.state = body.state;
        if (body.state_reason) upd.state_reason = body.state_reason;
        if (Array.isArray(body.labels)) upd.labels = body.labels.map((name) => ({ name }));
        store.set(n, upd);
        return fakeResponse(200, upd);
      }
      return fakeResponse(404, { message: 'Not Found' });
    }
    if (p === '/repos/sam-life/life') return fakeResponse(200, { private: true, owner: { login: 'sam-life', type: 'Organization' } });
    if (p === `${R}/contents/board.config.json`) return fakeResponse(200, { encoding: 'base64', content: Buffer.from(world.settings).toString('base64') });
    if (p.startsWith(`${R}/contents/`)) return fakeResponse(404, { message: 'Not Found' });
    if (p === `${R}/issues`) return fakeResponse(200, [...store.values()]);
    if (p === `${R}/milestones`) return fakeResponse(200, worldMilestones());
    let m;
    if ((m = /^\/users\/([^/]+)$/.exec(p))) {
      const o = world.owners[m[1]];
      return o ? fakeResponse(200, { login: m[1], type: o.type }) : fakeResponse(404, { message: 'Not Found' });
    }
    if ((m = /^\/(?:users|orgs)\/([^/]+)\/projectsV2(?:\/(\d+)\/(fields|items))?$/.exec(p))) {
      const o = world.owners[m[1]] || (m[1] === 'sam-life' ? { projects: [] } : null);
      if (!o) return fakeResponse(404, { message: 'Not Found' });
      if (m[2] === undefined) return fakeResponse(200, PLIST(o.projects));
      if (!o.projects.some((x) => String(x.number) === m[2])) return fakeResponse(404, { message: 'Not Found' });
      return fakeResponse(200, m[3] === 'fields' ? projectFields() : projectItems());
    }
    return fakeResponse(404, { message: 'Not Found' });
  };
  world.writes = () => world.calls.filter((c) => c.method !== 'GET');
  world.callsOf = (owner) => world.calls.filter((c) => c.owner === owner);
  world.dataCalls = () => world.calls.filter((c) => c.owner === null || c.owner === 'sam-life');
  return world;
}

const ALPHA = { type: 'Organization', projects: [{ number: 3, title: 'Alpha House' }] };
const BRAVO = { type: 'User', projects: [{ number: 3, title: 'Bravo Garden' }] };
const CHARLIE = { type: 'Organization', projects: [{ number: 7, title: 'Charlie Boat' }] };
const LISTED_ABC = [
  { key: 'alpha', number: 3, owner: 'a' },
  { key: 'bravo', number: 3, owner: 'b' },
  { key: 'charlie', number: 7, owner: 'c' },
];
const LISTED_AB = LISTED_ABC.slice(0, 2);

// ---------------------------------------------------------------- driving the board

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

// Boots the board over the world; `clock.ms` can be moved by the test. Calls fn({ port, dir, log, clock, page, running }).
async function withBoard(world, env, fn, { dir: givenDir, log: givenLog } = {}) {
  const dir = givenDir || await mkdtemp(path.join(os.tmpdir(), 'board-owners-'));
  const log = givenLog || [];
  const clock = { ms: T0, now() { return this.ms; } };
  let running = null;
  try {
    running = await start({
      processEnv: { ...BASE_ENV, BOARD_DATA_DIR: path.join(dir, 'data'), ...env },
      fetch: world.fetch, clock, log: (line) => log.push(String(line)),
    });
    const port = running.address.port;
    const page = async (reqPath = '/') => sendRequest(port, { reqPath });
    return await fn({ port, dir, log, clock, page, running });
  } finally {
    if (running) await running.close();
    if (!givenDir) await rm(dir, { recursive: true, force: true });
  }
}

const count = (text, needle) => text.split(needle).length - 1;
const UNREADABLE = /could not be read with the GitHub tokens? for (?:that owner|those owners)/;

// ================================================================= R131

test('R131 tokens for owners a and b: their projects carry their own token, c and the data repo carry the default one', async () => {
  const world = makeWorld({ projects: LISTED_ABC, owners: { a: ALPHA, b: BRAVO, c: CHARLIE } });
  await withBoard(world, OWNERS_AB, async ({ page }) => {
    const res = await page();
    assert.equal(res.status, 200);
    for (const title of ['Alpha House', 'Bravo Garden', 'Charlie Boat']) assert.ok(res.body.includes(title), `${title} is on the page`);
  });
  const mine = (owner) => world.callsOf(owner);
  for (const [owner, token] of [['a', TOK_A], ['b', TOK_B], ['c', DEFAULT]]) {
    const calls = mine(owner);
    assert.ok(calls.length >= 3, `owner ${owner}: its projects were requested (${calls.length} requests)`);
    assert.ok(calls.some((c) => /projectsV2/.test(c.path)), `owner ${owner}: its project list was requested`);
    for (const c of calls) assert.equal(c.auth, `Bearer ${token}`, `owner ${owner}: ${c.path}`);
  }
  const data = world.dataCalls();
  assert.ok(data.length > 0);
  for (const c of data) assert.equal(c.auth, `Bearer ${DEFAULT}`, `data repo: ${c.path}`);
});

test('R131 a token for owner a with no token for b: b is read with the default token', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  await withBoard(world, { BOARD_GITHUB_TOKEN_1: TOK_A, BOARD_GITHUB_OWNER_1: 'a' }, async ({ page }) => {
    assert.equal((await page()).status, 200);
  });
  for (const c of world.callsOf('a')) assert.equal(c.auth, `Bearer ${TOK_A}`);
  assert.ok(world.callsOf('b').length > 0);
  for (const c of world.callsOf('b')) assert.equal(c.auth, `Bearer ${DEFAULT}`);
});

test('R131 the owner matches its token whatever the case of the login in the settings', async () => {
  const world = makeWorld({ projects: [{ key: 'alpha', number: 3, owner: 'A' }], owners: { A: ALPHA, a: ALPHA } });
  await withBoard(world, { BOARD_GITHUB_TOKEN_1: TOK_A, BOARD_GITHUB_OWNER_1: 'a' }, async ({ page }) => {
    assert.equal((await page()).status, 200);
  });
  const calls = world.calls.filter((c) => c.owner !== null && c.owner.toLowerCase() === 'a');
  assert.ok(calls.length > 0);
  for (const c of calls) assert.equal(c.auth, `Bearer ${TOK_A}`);
});

test('R131 readEnv lists the owner tokens in n order and a token without its owner, or an owner without its token, is ignored with a warning that holds no value', () => {
  const r = readEnv({
    ...READ_BASE, ...OWNERS_AB,
    BOARD_GITHUB_TOKEN_3: 'tok-orphan-3-secret-value',
    BOARD_GITHUB_OWNER_4: 'orphan-owner-4',
    BOARD_GITHUB_TOKEN_5: TOK_A + '-five', BOARD_GITHUB_OWNER_5: 'A',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.env.githubTokens, [{ owner: 'a', token: TOK_A }, { owner: 'b', token: TOK_B }]);
  const w = r.env.startWarnings;
  assert.ok(Array.isArray(w));
  assert.ok(w.some((s) => s.includes('BOARD_GITHUB_TOKEN_3') && s.includes('BOARD_GITHUB_OWNER_3')), 'token 3 without its owner is named');
  assert.ok(w.some((s) => s.includes('BOARD_GITHUB_OWNER_4') && s.includes('BOARD_GITHUB_TOKEN_4')), 'owner 4 without its token is named');
  assert.ok(w.some((s) => s.includes('BOARD_GITHUB_OWNER_5')), 'a second token for an owner already served is named');
  for (const s of w) {
    for (const secret of [DEFAULT, TOK_A, TOK_B, 'tok-orphan-3-secret-value', 'orphan-owner-4', TOK_A + '-five']) {
      assert.ok(!s.includes(secret), `a warning holds a value: ${s}`);
    }
  }
});

test('R131 an owner that is not a GitHub login is ignored with a warning, and with no owner variables the list is empty', () => {
  const bad = readEnv({ ...READ_BASE, BOARD_GITHUB_TOKEN_1: TOK_A, BOARD_GITHUB_OWNER_1: 'not a login!' });
  assert.equal(bad.ok, true);
  assert.deepEqual(bad.env.githubTokens, []);
  assert.equal(bad.env.startWarnings.length, 1);
  assert.ok(bad.env.startWarnings[0].includes('BOARD_GITHUB_OWNER_1'));
  assert.ok(!bad.env.startWarnings[0].includes(TOK_A));
  const none = readEnv({ ...READ_BASE });
  assert.equal(none.ok, true);
  assert.deepEqual(none.env.githubTokens, []);
  assert.deepEqual(none.env.startWarnings, []);
  assert.equal(none.env.formKey, null);
});

test('R131 start logs each ignored pair once, before it listens, and the lines hold no token', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  await withBoard(world, {
    ...OWNERS_AB, BOARD_GITHUB_TOKEN_3: 'tok-orphan-3-secret-value', BOARD_GITHUB_OWNER_4: 'orphan-owner-4',
  }, async ({ log, page }) => {
    const text = log.join('\n');
    assert.equal(count(text, 'BOARD_GITHUB_TOKEN_3'), 1, 'one line for token 3');
    assert.equal(count(text, 'BOARD_GITHUB_OWNER_4'), 1, 'one line for owner 4');
    for (const secret of [DEFAULT, TOK_A, TOK_B, 'tok-orphan-3-secret-value']) assert.ok(!text.includes(secret));
    assert.equal((await page()).status, 200);
  });
  // the half pairs changed nothing: a and b still use their own tokens, nothing used the orphan
  for (const c of world.callsOf('a')) assert.equal(c.auth, `Bearer ${TOK_A}`);
  for (const c of world.calls) assert.ok(!String(c.auth).includes('orphan'));
});

// ================================================================= R130

test('R130 only a Notion token and no form key is refused, naming BOARD_FORM_KEY and no token', () => {
  const r = readEnv({ BOARD_BACKEND: 'notion', BOARD_NOTION_TOKEN: 'notion-secret-value-123', BOARD_REPO: 'sam-life/life', BOARD_PORT: '8080', BOARD_DATA_DIR: '/tmp/x-board-data' });
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_FORM_KEY/);
  assert.ok(!r.message.includes('notion-secret-value-123'));
  assert.ok(!/\n/.test(r.message));
});

test('R130 start with only a Notion token and no form key rejects with one plain sentence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-owners-'));
  let running = null;
  try {
    let err = null;
    try {
      running = await start({
        processEnv: { BOARD_BACKEND: 'notion', BOARD_NOTION_TOKEN: 'notion-secret-value-123', BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: dir },
        fetch: async () => { throw new Error('no network in this check'); }, clock: { now: () => T0 }, log: () => {},
      });
    } catch (e) { err = e; }
    assert.ok(err instanceof Error, 'start rejected');
    assert.match(err.message, /BOARD_FORM_KEY/);
    assert.ok(!err.message.includes('notion-secret-value-123'));
  } finally {
    if (running) await running.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('R130 a 31-character form key is refused and a 32-character one is accepted', () => {
  const short = 'k'.repeat(31);
  const r = readEnv({ ...READ_BASE, BOARD_FORM_KEY: short });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'BOARD_FORM_KEY must be at least 32 characters long and hold no spaces or line breaks.');
  assert.ok(!r.message.includes(short));
  const ok = readEnv({ ...READ_BASE, BOARD_FORM_KEY: 'k'.repeat(32) });
  assert.equal(ok.ok, true);
  assert.equal(ok.env.formKey, 'k'.repeat(32));
});

test('R130 a form key with a space or a line break is refused', () => {
  for (const key of ['a'.repeat(20) + ' ' + 'b'.repeat(20), 'a'.repeat(20) + '\n' + 'b'.repeat(20), ' ' + 'a'.repeat(40)]) {
    const r = readEnv({ ...READ_BASE, BOARD_FORM_KEY: key });
    assert.equal(r.ok, false, JSON.stringify(key));
    assert.match(r.message, /BOARD_FORM_KEY/);
  }
});

test('R130 an unset or empty form key reads as no key', () => {
  assert.equal(readEnv({ ...READ_BASE }).env.formKey, null);
  assert.equal(readEnv({ ...READ_BASE, BOARD_FORM_KEY: '' }).env.formKey, null);
});

const HOST = 'board.example';
const reqFor = () => ({ method: 'POST', url: '/actions/idea', headers: { host: HOST } });
const mkGuard = (over) => createGuard({ allowedHosts: [HOST], identityHeader: null, clock: { now: () => T0 }, ...over });
const accepts = (guard, token) => guard.checkPost(reqFor(), 'idea', 'new', token).ok === true;

test('R130 a GitHub token and no form key: a form token from createGuard survives a restart and equals the token-derived one', () => {
  const t = mkGuard({ token: DEFAULT }).formToken('idea', 'new');
  assert.ok(accepts(mkGuard({ token: DEFAULT }), t), 'a guard built the same way after a restart');
  assert.ok(accepts(mkGuard({ token: DEFAULT, formKey: undefined }), t), 'a guard built with formKey undefined');
  assert.ok(accepts(mkGuard({ token: DEFAULT, formKey: null }), t), 'a guard built with formKey null');
  assert.ok(accepts(mkGuard({ token: DEFAULT, formKey: '' }), t), 'a guard built with an empty formKey');
  assert.ok(!accepts(mkGuard({ token: 'another-github-token-value' }), t), 'another GitHub token does not accept it');
});

test('R130 a form token from a started board with only a GitHub token is accepted by a token-derived guard', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  await withBoard(world, {}, async ({ page }) => {
    const forms = parseForms((await page()).body);
    const idea = forms.find((f) => f.action === '/actions/idea');
    assert.ok(idea && idea.fields.token, 'the page carries an idea form token');
    assert.ok(accepts(mkGuard({ token: DEFAULT }), idea.fields.token), 'derived from the GitHub token as before');
    assert.ok(!accepts(mkGuard({ token: DEFAULT, formKey: FORM_KEY }), idea.fields.token), 'not the board-own key');
  });
});

test('R130 with BOARD_FORM_KEY set the form token differs from the token-derived one and is signed by the key alone', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  await withBoard(world, { BOARD_FORM_KEY: FORM_KEY }, async ({ page }) => {
    const forms = parseForms((await page()).body);
    const idea = forms.find((f) => f.action === '/actions/idea');
    assert.ok(idea && idea.fields.token);
    assert.ok(!accepts(mkGuard({ token: DEFAULT }), idea.fields.token), 'differs from the token-derived key');
    assert.ok(accepts(mkGuard({ token: DEFAULT, formKey: FORM_KEY }), idea.fields.token), 'the form key signs it');
    assert.ok(accepts(mkGuard({ token: 'a-different-github-token-1', formKey: FORM_KEY }), idea.fields.token), 'the GitHub token no longer matters');
  });
});

test('R130 a form key signs and verifies on its own, with no GitHub token', () => {
  const t = mkGuard({ formKey: FORM_KEY }).formToken('idea', 'new');
  assert.ok(accepts(mkGuard({ formKey: FORM_KEY }), t));
  assert.ok(!accepts(mkGuard({ formKey: FORM_KEY + 'x' }), t));
});

test('R130 createGuard with no token and no form key throws and never signs with a fixed key', () => {
  assert.throws(() => mkGuard({}), /no key to sign its forms with/);
  assert.throws(() => mkGuard({ token: '' }));
  assert.throws(() => mkGuard({ token: '', formKey: '' }));
  assert.throws(() => mkGuard({ token: undefined, formKey: undefined }));
  assert.throws(() => mkGuard({ token: null, formKey: null }));
});

// ================================================================= R55

test('R55 given BOARD_FORM_KEY set, the form token differs from the one derived from the GitHub token', () => {
  const derived = mkGuard({ token: DEFAULT });
  const own = mkGuard({ token: DEFAULT, formKey: FORM_KEY });
  const tOwn = own.formToken('close', '12');
  const tDerived = derived.formToken('close', '12');
  assert.ok(!derived.checkPost(reqFor(), 'close', '12', tOwn).ok, 'a key-signed token is not valid under the token-derived key');
  assert.ok(!own.checkPost(reqFor(), 'close', '12', tDerived).ok, 'a token-derived token is not valid under the form key');
  assert.ok(own.checkPost(reqFor(), 'close', '12', tOwn).ok);
});

test('R55 a form-key token still lapses after 12 hours and is bound to its action and target', () => {
  const clock = { t: T0, now() { return this.t; } };
  const g = createGuard({ formKey: FORM_KEY, allowedHosts: [HOST], identityHeader: null, clock });
  const t = g.formToken('close', '12');
  assert.ok(g.checkPost(reqFor(), 'close', '12', t).ok);
  assert.ok(!g.checkPost(reqFor(), 'close', '13', t).ok, 'another target');
  assert.ok(!g.checkPost(reqFor(), 'sort', '12', t).ok, 'another action');
  clock.t = T0 + 13 * HOUR;
  assert.ok(!g.checkPost(reqFor(), 'close', '12', t).ok, '13 hours old');
});

// ================================================================= R6

test('R6 a project listed under an owner that could not be read is left out with project-owner-unreadable at 1 and no project-missing', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  world.down.add('b');
  await withBoard(world, OWNERS_AB, async ({ page }) => {
    const res = await page();
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Alpha House'));
    assert.ok(!res.body.includes('Bravo Garden'));
    assert.ok(unesc(res.body).includes('1 listed project of "b" could not be read with the GitHub token for that owner, so it is left out.'));
    assert.ok(!res.body.includes('not found on GitHub'), 'project-missing is absent');
  });
});

test('R6 an owner the token is refused for (401) is left out the same way', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  const real = world.fetch;
  world.fetch = async (url, init) => {
    if (/^\/(?:users|orgs)\/b(?:\/|$)/.test(new URL(String(url)).pathname)) return fakeResponse(401, { message: 'Bad credentials' });
    return real(url, init);
  };
  await withBoard(world, OWNERS_AB, async ({ page }) => {
    const res = await page();
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Alpha House'));
    assert.ok(!res.body.includes('Bravo Garden'));
    assert.ok(unesc(res.body).includes('1 listed project of "b"'));
    assert.ok(!res.body.includes('not found on GitHub'));
  });
});

test('R6 number 3 listed under owners a and b with only a returning it: b is left out with project-missing and the owner is not called unreadable', async () => {
  const world = makeWorld({
    projects: LISTED_AB,
    owners: { a: ALPHA, b: { type: 'User', projects: [{ number: 4, title: 'Bravo Other' }] } },
  });
  await withBoard(world, OWNERS_AB, async ({ page }) => {
    const res = await page();
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Alpha House'));
    assert.ok(!res.body.includes('Bravo Other'), 'b has number 4 but only 3 is listed');
    assert.ok(res.body.includes('1 listed project was not found on GitHub.'));
    assert.ok(!UNREADABLE.test(res.body), 'b was read, so it is not unreadable');
  });
});

test('R6 the same number under two owners is two projects, and a failed owner takes only its own', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  await withBoard(world, OWNERS_AB, async ({ page }) => {
    const res = await page();
    assert.ok(res.body.includes('Alpha House') && res.body.includes('Bravo Garden'), 'both number-3 projects are shown');
    assert.ok(!res.body.includes('not found on GitHub'));
    assert.ok(!UNREADABLE.test(res.body));
  });
});

// ================================================================= R67

test('R67 every request for owner b answers 503: a board with a\'s projects, b left out with one count, a notice naming b, no stale banner', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  world.down.add('b');
  await withBoard(world, OWNERS_AB, async ({ page }) => {
    const res = await page();
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('data-section="header"'), 'a board, not an error page');
    assert.ok(res.body.includes('Alpha House'));
    assert.ok(!res.body.includes('Bravo Garden'));
    assert.equal(count(unesc(res.body), '1 listed project of "b" could not be read with the GitHub token for that owner, so it is left out.'), 1);
    assert.ok(!res.body.includes('data-banner'), 'no stale banner');
    assert.ok(!res.body.includes('Showing the last good read'));
  });
});

test('R67 two failed owners give one notice naming both, with the plural wording', async () => {
  const world = makeWorld({ projects: LISTED_ABC, owners: { a: ALPHA, b: BRAVO, c: CHARLIE } });
  world.down.add('b');
  world.down.add('c');
  await withBoard(world, OWNERS_AB, async ({ page }) => {
    const res = await page();
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Alpha House'));
    assert.equal(count(res.body, 'could not be read with the GitHub token'), 1, 'one notice in total');
    assert.ok(unesc(res.body).includes('2 listed projects of "b", "c" could not be read with the GitHub tokens for those owners, so they are left out.'));
    assert.ok(!res.body.includes('data-banner'));
  });
});

test('R67 an owner that fails after a good read is left out on the next read and the board is not stale', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  await withBoard(world, OWNERS_AB, async ({ page, clock }) => {
    const first = await page();
    assert.ok(first.body.includes('Bravo Garden'));
    world.down.add('b');
    clock.ms = T0 + 2 * HOUR;
    const second = await page();
    assert.equal(second.status, 200);
    assert.ok(!second.body.includes('data-banner'), 'no stale banner');
    assert.ok(second.body.includes('Alpha House'));
    assert.ok(unesc(second.body).includes('1 listed project of "b"'), 'the notice names b');
  });
});

test('R67 the data repo answering 503 after one good read gives the last good read and one stale banner, as before', async () => {
  const world = makeWorld({ projects: LISTED_AB, owners: { a: ALPHA, b: BRAVO } });
  await withBoard(world, OWNERS_AB, async ({ page, clock }) => {
    const first = await page();
    assert.equal(first.status, 200);
    assert.ok(first.body.includes('Bravo Garden'));
    assert.ok(!first.body.includes('data-banner'));
    world.dataDown = true;
    clock.ms = T0 + 2 * HOUR;
    const second = await page();
    assert.equal(second.status, 200);
    assert.equal(count(second.body, 'data-banner'), 1);
    assert.ok(second.body.includes('Alpha House') && second.body.includes('Bravo Garden'), 'the last good read, with both owners');
  });
});

// ================================================================= R75

const SENT = {
  default: 'SENT-DEFAULT-tok-7a1f0c93d5b2e8',
  t1: 'SENT-TOKEN-1-a2c4e6f8091b3d5',
  t2: 'SENT-TOKEN-2-b3d5f70a1c2e4f6',
  t3: 'SENT-TOKEN-3-c4e6081b2d3f507',
  t4: 'SENT-TOKEN-4-d5f7192c3e40618',
  t5: 'SENT-TOKEN-5-e60822d3f4517a9',
  notion: 'SENT-NOTION-tok-f719a3e4056b82c',
  formKey: 'SENT-FORM-KEY-0a1b2c3d4e5f60718293',
};
const SENT_ENV = {
  BOARD_GITHUB_TOKEN: SENT.default,
  BOARD_GITHUB_TOKEN_1: SENT.t1, BOARD_GITHUB_OWNER_1: 'a',
  BOARD_GITHUB_TOKEN_2: SENT.t2, BOARD_GITHUB_OWNER_2: 'b',
  BOARD_GITHUB_TOKEN_3: SENT.t3, BOARD_GITHUB_OWNER_3: 'd',
  BOARD_GITHUB_TOKEN_4: SENT.t4, BOARD_GITHUB_OWNER_4: 'e',
  BOARD_GITHUB_TOKEN_5: SENT.t5, BOARD_GITHUB_OWNER_5: 'f',
  BOARD_NOTION_TOKEN: SENT.notion,
  BOARD_FORM_KEY: SENT.formKey,
};

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

async function walkFiles(root, cap) {
  let names = [];
  try { names = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const n of names) {
    const p = path.join(root, n.name);
    if (n.isDirectory()) await walkFiles(p, cap);
    else {
      cap.counts.files += 1;
      addItem(cap, 'file-name', p, p);
      addItem(cap, 'file', p, await readFile(p, 'utf8'));
    }
  }
}

test('R75 a sentinel for each GitHub token, the Notion token and the form key appears in no output, log, header, form token, refusal, request or file', async () => {
  const cap = newCap();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-owners-sweep-'));
  const world = makeWorld({ projects: LISTED_ABC, owners: { a: ALPHA, b: BRAVO, c: CHARLIE } });
  const restore = installStdCapture(cap);
  const log = (line) => { cap.counts.logs += 1; addItem(cap, 'log', 'log line', line); };
  const running = [];
  const clock = { ms: T0, now() { return this.ms; } };
  const boot = async (sub, env = {}) => {
    const r = await start({
      processEnv: { ...BASE_ENV, ...SENT_ENV, BOARD_DATA_DIR: path.join(dir, sub), ...env },
      fetch: world.fetch, clock, log,
    });
    running.push(r);
    return r.address.port;
  };
  const request = async (port, label, opts = {}) => {
    const res = await sendRequest(port, opts);
    const where = `${opts.method || 'GET'} ${opts.reqPath || '/'} [${label}]`;
    cap.counts.responses += 1;
    addItem(cap, 'status-line', where, res.statusLine);
    addItem(cap, 'header', where, res.rawHeaders.join('\n'));
    addItem(cap, 'body', where, res.body);
    return res;
  };
  const pageOf = async (port, label) => {
    const res = await request(port, label);
    const forms = parseForms(res.body);
    for (const f of forms) if (f.fields.token) { cap.counts.formTokens += 1; addItem(cap, 'form-token', `${f.action} [${label}]`, f.fields.token); }
    return { res, forms };
  };
  const post = (port, label, form, extra = {}) => request(port, label, {
    method: 'POST', reqPath: form.action, headers: { ...FORM, origin: `http://localhost:${port}`, ...extra }, body: submission(form),
  });
  const refusals = {};
  let failure = null;
  try {
    // every route and every action, good world
    const port = await boot('good');
    const { res, forms } = await pageOf(port, 'good');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Alpha House') && res.body.includes('Bravo Garden') && res.body.includes('Charlie Boat'));
    await request(port, 'good', { reqPath: '/healthz' });
    await request(port, 'good', { reqPath: '/static/board.css' });
    await request(port, 'good', { reqPath: '/static/board.js' });
    const seen = new Set();
    for (const f of forms) {
      const key = f.action + (f.fields.accept === '1' ? '+accept' : '');
      if (seen.has(key)) continue;
      seen.add(key);
      await post(port, 'good, valid token', f);
      await post(port, 'good, same token again', f);
      await post(port, 'good, bad token', { ...f, fields: { ...f.fields, token: 'not.a.token' } });
    }
    await pageOf(port, 'good, after the writes');
    await request(port, 'foreign host', { reqPath: '/', headers: { host: 'evil.example:80' } });
    await request(port, 'missing', { reqPath: '/nope' });
    await request(port, 'wrong method', { method: 'DELETE', reqPath: '/' });
    await request(port, 'bad content type', { method: 'POST', reqPath: '/actions/idea', headers: { 'content-type': 'application/json' }, body: '{}' });

    // forced failures: an owner down, the data repo down (warm), every failure mode warm and cold
    world.down.add('b');
    clock.ms = T0 + 2 * HOUR;
    await pageOf(port, 'owner b down');
    world.down.add('a');
    world.down.add('c');
    clock.ms = T0 + 4 * HOUR;
    await pageOf(port, 'every owner down');
    world.down.clear();
    world.dataDown = true;
    clock.ms = T0 + 6 * HOUR;
    await pageOf(port, 'data repo down');
    for (const f of forms.slice(0, 3)) await post(port, 'data repo down', f);
    world.dataDown = false;
    for (const mode of ['down500', 'auth401', 'net-token', 'writes500']) {
      world.mode = 'good';
      const warm = await boot(`warm-${mode}`);
      await pageOf(warm, `warm before ${mode}`);
      world.mode = mode;
      clock.ms += 2 * HOUR;
      await pageOf(warm, `warm ${mode}`);
      for (const f of forms.slice(0, 3)) await post(warm, `warm ${mode}`, f);
      const cold = await boot(`cold-${mode}`);
      await pageOf(cold, `cold ${mode}`);
      for (const f of forms.slice(0, 3)) await post(cold, `cold ${mode}`, f);
    }
    world.mode = 'good';

    // refusals and start warnings
    const bad = {
      'form key of 31 characters': { BOARD_FORM_KEY: SENT.formKey.slice(0, 31) },
      'form key with a space': { BOARD_FORM_KEY: SENT.formKey.slice(0, 20) + ' ' + SENT.formKey.slice(20) },
      'notion with no form key': { BOARD_BACKEND: 'notion', BOARD_FORM_KEY: '' },
      'notion with a form key': { BOARD_BACKEND: 'notion' },
    };
    for (const [name, extra] of Object.entries(bad)) {
      let started = null;
      try {
        started = await start({
          processEnv: { ...BASE_ENV, ...SENT_ENV, BOARD_DATA_DIR: path.join(dir, 'refused'), ...extra },
          fetch: world.fetch, clock, log,
        });
      } catch (err) {
        cap.counts.rejections += 1;
        refusals[name] = err && err.message;
        addItem(cap, 'rejection', name, `${err && err.name} ${err && err.message}`);
        addItem(cap, 'rejection-stack', name, err && err.stack ? err.stack : '');
      }
      if (started) await started.close();
    }
    // half pairs and a bad login: the start warnings name the variable and no value
    const half = await boot('half-pairs', {
      BOARD_GITHUB_TOKEN_3: SENT.t3, BOARD_GITHUB_OWNER_3: '', BOARD_GITHUB_OWNER_4: 'e', BOARD_GITHUB_TOKEN_4: '',
      BOARD_GITHUB_OWNER_5: 'bad login!',
    });
    await pageOf(half, 'half pairs');
  } catch (err) {
    failure = err;
  } finally {
    restore();
    for (const r of running) await r.close().catch(() => {});
  }
  try {
    await walkFiles(dir, cap);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (failure) throw failure;

  // every refusal happened and has a message
  for (const name of Object.keys({ 'form key of 31 characters': 1, 'form key with a space': 1, 'notion with no form key': 1, 'notion with a form key': 1 })) {
    assert.ok(typeof refusals[name] === 'string' && refusals[name].length > 0, `"${name}" was refused with a message`);
  }
  // not vacuous
  assert.ok(cap.counts.responses >= 40, `only ${cap.counts.responses} responses were examined`);
  assert.ok(cap.counts.logs >= 3, `only ${cap.counts.logs} log lines were examined`);
  assert.ok(cap.counts.formTokens >= 6, `only ${cap.counts.formTokens} form tokens were examined`);
  assert.ok(cap.counts.files >= 1, 'the data folder held no file to examine');
  assert.ok(world.writes().length > 0, 'no write reached the fake GitHub');
  assert.ok(world.calls.length > 0);

  // none of the eight sentinels anywhere in what the board gave out
  const names = new Map(Object.entries(SENT).map(([k, v]) => [v, k]));
  const leaks = [];
  for (const [sentinel, name] of names) {
    for (const f of findLeaks(cap, needles(sentinel))) leaks.push(`${name}: ${f.form} form in ${f.kind} at ${f.where}`);
  }
  assert.deepEqual(leaks, [], `sentinels found in captured material: ${leaks.join('; ')}`);

  // what the board sent to GitHub: each token only in an authorization header, the right one for the owner, and the
  // Notion token and the form key never
  const authFor = (c) => (c.owner === 'a' ? SENT.t1 : c.owner === 'b' ? SENT.t2 : SENT.default);
  const problems = [];
  const used = new Set();
  for (const c of world.calls) {
    for (const [k, v] of Object.entries(c.headers)) {
      if (k.toLowerCase() === 'authorization') continue;
      for (const [s, nm] of names) if (String(v).includes(s)) problems.push(`${nm} in header ${k}`);
    }
    for (const [s, nm] of names) {
      if (c.url.includes(s)) problems.push(`${nm} in a URL`);
      if (c.body.includes(s)) problems.push(`${nm} in a request body`);
    }
    if (c.auth !== `Bearer ${authFor(c)}`) problems.push(`wrong authorization for owner ${c.owner}: ${c.method} ${c.path}`);
    used.add(c.auth);
  }
  assert.deepEqual(problems, []);
  for (const t of [SENT.default, SENT.t1, SENT.t2]) assert.ok(used.has(`Bearer ${t}`), 'the sweep used that token, so it proves something');
});
