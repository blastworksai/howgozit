// R107: a lock between the proxy and the board. Written from the contract text alone.
// The proxy secret is BOARD_PROXY_SECRET; the header is X-Board-Proxy-Secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { needles, findLeaks, newCap, addItem } from '../fixtures/leak-hunt.mjs';
import { routes as worldRoutes, issues as worldIssues, apiIssue, R } from '../fixtures/github/world.mjs';
import { readEnv } from '../board/env.mjs';
import { createGuard } from '../board/guard.mjs';

const { start } = await import('../board/server.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GH_TOKEN = 'SENTINEL-TOKEN-123-do-not-leak';
// 41 characters, no whitespace, and a "+" and a "/" so that its URL-encoded form differs from the raw one.
const SECRET = 'PROXY+SECRET/sentinel-0123456789abcdefXYZ';
const WRONG_SAME_LENGTH = `${SECRET.slice(0, -1)}Q`;
const WRONG = 'not-the-secret-at-all';
const CLOCK_MS = Date.parse('2026-10-12T06:10:00Z');
const CLOCK = { now: () => CLOCK_MS };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const ID = 'x-board-user';
const PROXY = { BOARD_MODE: 'proxy', BOARD_IDENTITY_HEADER: ID, BOARD_HOST: '127.0.0.1' };
const H = 'x-board-proxy-secret';

assert.ok(SECRET.length >= 32 && !/\s/.test(SECRET));
assert.equal(WRONG_SAME_LENGTH.length, SECRET.length);
assert.notEqual(WRONG_SAME_LENGTH, SECRET);

// ---------------------------------------------------------------- a small invented GitHub

function fakeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function downFetch() {
  return async () => fakeResponse(503, { message: 'down' });
}

function settingsText() {
  const s = JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'settings', 'base.json'), 'utf8'));
  s.projects = [{ key: 'house', number: 3 }];
  s.focus = ['house'];
  s.habits = [{ id: 'move', title: 'Move', start: '2026-09-22' }];
  s.season.goals = [{ title: 'Finish the kitchen and bathroom', project: 'house' }];
  return JSON.stringify(s);
}

// good, writes500, down500
function makeWorld() {
  const world = { mode: 'good', calls: [] };
  const store = new Map();
  const list = [...worldIssues(), apiIssue(20, { title: 'Plan the garden', labels: [{ id: 3, name: 'idea', color: 'cccccc' }] })];
  for (const i of list) store.set(i.number, i);
  const table = worldRoutes({
    issues: list,
    files: {
      'board.config.json': settingsText(),
      'theme.json': null, 'state/brief.json': null, 'state/calendar.json': null,
      'state/inbox.json': null, 'state/log.json': null,
      // a fresh suggestion for the idea (#20) so the page offers a real sort form (Accept) to the sweep
      'state/proposals.json': JSON.stringify({ updated: '2026-10-12T06:00:00Z', focus: null, ideas: [{ number: 20, project: 'house', milestone: 5, newProject: null, why: 'Same room' }] }),
    },
  });
  let next = 100;
  world.fetch = async (url, init = {}) => {
    const method = (init && init.method) || 'GET';
    world.calls.push({ url: String(url), method });
    if (world.mode === 'down500') return fakeResponse(500, { message: 'Server Error' });
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
        const upd = { ...(store.get(n) || apiIssue(n)) };
        if (body.state) upd.state = body.state;
        if (Array.isArray(body.labels)) upd.labels = body.labels.map((name) => ({ name }));
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
  return world;
}

// ---------------------------------------------------------------- requests

// headers may hold an array value: node then sends that header once per entry.
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

async function withServer({ env = {}, fetch = downFetch(), log = () => {}, dir: givenDir } = {}, fn) {
  const dir = givenDir || await mkdtemp(path.join(os.tmpdir(), 'board-proxy-secret-'));
  let running = null;
  try {
    running = await start({
      processEnv: { BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: dir, ...env },
      fetch, clock: CLOCK, log,
    });
    return await fn({ port: running.address.port, dir });
  } finally {
    if (running) await running.close();
    if (!givenDir) await rm(dir, { recursive: true, force: true });
  }
}

async function startRejection(env) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-proxy-secret-'));
  let running = null;
  try {
    try {
      running = await start({
        processEnv: { BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: dir, ...env },
        fetch: downFetch(), clock: CLOCK, log: () => {},
      });
    } catch (err) {
      return err;
    }
    return null;
  } finally {
    if (running) await running.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// The eight routes of R80.
const ROUTES = [
  { name: 'GET /', method: 'GET', reqPath: '/' },
  { name: 'GET /static/board.css', method: 'GET', reqPath: '/static/board.css' },
  { name: 'GET /static/board.js', method: 'GET', reqPath: '/static/board.js' },
  { name: 'GET /healthz', method: 'GET', reqPath: '/healthz', health: true },
  { name: 'POST /actions/idea', method: 'POST', reqPath: '/actions/idea' },
  { name: 'POST /actions/habit', method: 'POST', reqPath: '/actions/habit' },
  { name: 'POST /actions/sort', method: 'POST', reqPath: '/actions/sort' },
  { name: 'POST /actions/close', method: 'POST', reqPath: '/actions/close' },
];

function routeRequest(route, port, headers) {
  const post = route.method === 'POST';
  return sendRequest(port, {
    method: route.method,
    reqPath: route.reqPath,
    headers: { ...(post ? { ...FORM, origin: `http://localhost:${port}` } : {}), ...headers },
    body: post ? 'title=x' : null,
  });
}

const HEADER_CASES = [
  { name: 'absent', headers: {}, right: false },
  { name: 'wrong', headers: { [H]: WRONG }, right: false },
  { name: 'wrong but of equal length', headers: { [H]: WRONG_SAME_LENGTH }, right: false },
  { name: 'right but sent twice', headers: { [H]: [SECRET, SECRET] }, right: false },
  { name: 'right', headers: { [H]: SECRET }, right: true },
];
const IDENTITY_CASES = [
  { name: 'identity absent', headers: {}, present: false },
  { name: 'identity present', headers: { [ID]: 'sam' }, present: true },
];

// The whole answer of one response, for an exact comparison: status, status line, headers apart from date, body.
function sameAnswer(actual, expected, cell) {
  assert.equal(actual.status, expected.status, `${cell}: status`);
  assert.equal(actual.statusLine, expected.statusLine, `${cell}: status line`);
  assert.deepEqual(withoutDate(actual), withoutDate(expected), `${cell}: headers apart from date`);
  assert.equal(actual.body, expected.body, `${cell}: body`);
}

// Proof that the lock is really on: a request with a wrong secret and a good identity is refused.
// Without this, a "right header" cell would pass on a board that ignores the setting.
async function witnessLockIsOn(port) {
  const r = await sendRequest(port, { reqPath: '/static/board.css', headers: { [H]: WRONG, [ID]: 'sam' } });
  assert.equal(r.status, 401, 'witness: a wrong secret with an identity must be refused, or the lock is not on');
}

// ---------------------------------------------------------------- the grid, secret set

for (const route of ROUTES) {
  test(`R107 with the secret set, ${route.name} answers every header and identity case as the rule says`, async () => {
    await withServer({ env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
      // the route's own answer: the same request on a board with no secret and the identity present
      const twin = await withServer({ env: PROXY }, ({ port: p2 }) => routeRequest(route, p2, { [ID]: 'sam' }));
      if (!route.health) assert.notEqual(twin.status, 401, `${route.name}: the unlocked board's own answer must not be a 401`);
      await witnessLockIsOn(port);
      // R107: a failed lock answers as a missing identity does. The reference is taken on this very server:
      // the right secret and no identity, which only the identity lock refuses.
      const missingIdentity = route.health ? null : await routeRequest(route, port, { [H]: SECRET });
      if (missingIdentity) assert.equal(missingIdentity.status, 401, `${route.name}: the identity lock refuses`);
      for (const hc of HEADER_CASES) {
        for (const ic of IDENTITY_CASES) {
          const cell = `${route.name} / header ${hc.name} / ${ic.name}`;
          const res = await routeRequest(route, port, { ...hc.headers, ...ic.headers });
          if (route.health) {
            assert.equal(res.status, 200, `${cell}: status`);
            assert.equal(res.body, 'ok', `${cell}: body`);
          } else if (hc.right && ic.present) {
            // the route's own answer, whole: status, headers apart from date, and body
            sameAnswer(res, twin, `${cell}: the route's own answer`);
          } else {
            sameAnswer(res, missingIdentity, `${cell}: the same 401 as a missing identity`);
            assert.equal(res.status, 401, `${cell}: status`);
            assert.ok(!res.body.includes('<form'), `${cell}: no board in a 401`);
          }
        }
      }
    });
  });
}

for (const route of ROUTES) {
  test(`R107 with the secret set, ${route.name} on a foreign Host answers as the rule says whatever the header`, async () => {
    await withServer({ env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
      await witnessLockIsOn(port);
      for (const hc of HEADER_CASES) {
        for (const ic of IDENTITY_CASES) {
          const cell = `${route.name} / foreign host / header ${hc.name} / ${ic.name}`;
          const res = await routeRequest(route, port, { host: 'evil.example:80', ...hc.headers, ...ic.headers });
          if (route.health) {
            assert.equal(res.status, 200, `${cell}: status`);
            assert.equal(res.body, 'ok', `${cell}: body`);
          } else {
            assert.equal(res.status, 421, `${cell}: status`);
            assert.equal(res.body, '', `${cell}: body`);
          }
        }
      }
    });
  });
}

test('R107 with the secret set in local mode, the lock holds there too', async () => {
  await withServer({ env: { BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
    const none = await sendRequest(port, { reqPath: '/static/board.css' });
    assert.equal(none.status, 401, 'local mode, header absent');
    const wrong = await sendRequest(port, { reqPath: '/static/board.css', headers: { [H]: WRONG_SAME_LENGTH } });
    assert.equal(wrong.status, 401, 'local mode, wrong header');
    const twice = await sendRequest(port, { reqPath: '/static/board.css', headers: { [H]: [SECRET, SECRET] } });
    assert.equal(twice.status, 401, 'local mode, right header sent twice');
    const right = await sendRequest(port, { reqPath: '/static/board.css', headers: { [H]: SECRET } });
    assert.equal(right.status, 200, 'local mode, right header');
  });
});

test('R107 with the secret set in hosted mode, the lock holds there too', async () => {
  await withServer({ env: { ...PROXY, BOARD_MODE: 'hosted', BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
    const wrong = await sendRequest(port, { reqPath: '/static/board.css', headers: { [ID]: 'sam', [H]: WRONG } });
    assert.equal(wrong.status, 401, 'hosted mode, wrong header');
    const right = await sendRequest(port, { reqPath: '/static/board.css', headers: { [ID]: 'sam', [H]: SECRET } });
    assert.equal(right.status, 200, 'hosted mode, right header');
  });
});

test('R107 the right header with a Host that is allowed but a different case still passes the lock', async () => {
  await withServer({ env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
    await witnessLockIsOn(port);
    const r = await sendRequest(port, { reqPath: '/static/board.css', headers: { [H]: SECRET, [ID]: 'sam', host: `LOCALHOST:${port}` } });
    assert.equal(r.status, 200);
  });
});

// ---------------------------------------------------------------- the grid, secret unset

for (const [label, env] of [['unset', {}], ['empty', { BOARD_PROXY_SECRET: '' }]]) {
  for (const route of ROUTES) {
    test(`R107 with the secret ${label}, ${route.name} answers as it does without the rule, whatever the header`, async () => {
      await withServer({ env: { ...PROXY, ...env } }, async ({ port }) => {
        for (const hc of HEADER_CASES) {
          for (const ic of IDENTITY_CASES) {
            const cell = `${label} / ${route.name} / header ${hc.name} / ${ic.name}`;
            const res = await routeRequest(route, port, { ...hc.headers, ...ic.headers });
            // R107: with the setting absent every answer is the one the board gives without the rule.
            // The reference is the same request on this same server with no X-Board-Proxy-Secret header at all.
            const baseline = await routeRequest(route, port, { ...ic.headers });
            sameAnswer(res, baseline, `${cell}: as without the header`);
            if (route.health) {
              assert.equal(res.status, 200, `${cell}: status`);
              assert.equal(res.body, 'ok', `${cell}: body`);
            } else if (ic.present) {
              assert.notEqual(res.status, 401, `${cell}: the identity is enough`);
            } else {
              assert.equal(res.status, 401, `${cell}: no identity, as today`);
            }
          }
        }
      });
    });
  }

  test(`R107 with the secret ${label}, a foreign Host is still 421 and local mode needs no header`, async () => {
    await withServer({ env: { ...PROXY, ...env } }, async ({ port }) => {
      const r = await sendRequest(port, { reqPath: '/', headers: { host: 'evil.example:80', [ID]: 'sam', [H]: WRONG } });
      assert.equal(r.status, 421);
      assert.equal(r.body, '');
    });
    await withServer({ env }, async ({ port }) => {
      const r = await sendRequest(port, { reqPath: '/static/board.css', headers: { [H]: WRONG } });
      assert.equal(r.status, 200);
    });
  });
}

// ---------------------------------------------------------------- one answer for both locks

function withoutDate(res) {
  const pairs = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (res.rawHeaders[i].toLowerCase() !== 'date') pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
  }
  return pairs.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}

test('R107 the 401 for a wrong secret and the 401 for a missing identity are equal in status, headers apart from date, and body', async () => {
  await withServer({ env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
    for (const reqPath of ['/', '/static/board.css']) {
      const missingIdentity = await sendRequest(port, { reqPath, headers: { [H]: SECRET } });
      assert.equal(missingIdentity.status, 401, `${reqPath}: the identity lock refuses`);
      const cases = {
        'wrong secret, identity present': { [H]: WRONG, [ID]: 'sam' },
        'wrong secret of equal length, identity present': { [H]: WRONG_SAME_LENGTH, [ID]: 'sam' },
        'no secret, identity present': { [ID]: 'sam' },
        'right secret sent twice, identity present': { [H]: [SECRET, SECRET], [ID]: 'sam' },
        'wrong secret, no identity': { [H]: WRONG },
        'no secret, no identity': {},
      };
      for (const [name, headers] of Object.entries(cases)) {
        const other = await sendRequest(port, { reqPath, headers });
        const cell = `${reqPath} / ${name}`;
        assert.equal(other.status, missingIdentity.status, `${cell}: status`);
        assert.equal(other.statusLine, missingIdentity.statusLine, `${cell}: status line`);
        assert.deepEqual(withoutDate(other), withoutDate(missingIdentity), `${cell}: headers apart from date`);
        assert.equal(other.body, missingIdentity.body, `${cell}: body`);
      }
    }
  });
});

test('R107 the 401 of a board with the lock is the 401 of a board without it', async () => {
  const plain = await withServer({ env: PROXY }, ({ port }) => sendRequest(port, { reqPath: '/' }));
  await withServer({ env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
    const locked = await sendRequest(port, { reqPath: '/', headers: { [H]: WRONG, [ID]: 'sam' } });
    assert.equal(plain.status, 401);
    assert.equal(locked.status, plain.status);
    assert.equal(locked.statusLine, plain.statusLine);
    assert.deepEqual(withoutDate(locked), withoutDate(plain));
    assert.equal(locked.body, plain.body);
  });
});

// ---------------------------------------------------------------- start-up

const REFUSALS = [
  { name: '31 characters', value: 'k'.repeat(31), parts: ['k'.repeat(31)] },
  { name: '32 characters holding a space', value: `${'a'.repeat(15)} ${'b'.repeat(16)}`, parts: ['a'.repeat(15), 'b'.repeat(16)] },
  { name: '32 characters ending in a newline', value: `${'c'.repeat(31)}\n`, parts: ['c'.repeat(31)] },
  { name: '32 characters holding a tab', value: `${'d'.repeat(15)}\t${'e'.repeat(16)}`, parts: ['d'.repeat(15), 'e'.repeat(16)] },
  { name: 'spaces only', value: ' '.repeat(40), parts: [' '.repeat(40)] },
  { name: 'a few spaces only', value: '   ', parts: [] },
];

function assertPlainSentenceWithout(msg, refusal, label) {
  assert.equal(typeof msg, 'string', `${label}: a message`);
  assert.ok(msg.length > 10, `${label}: not empty`);
  assert.ok(!msg.includes('\n'), `${label}: one line`);
  assert.ok(/[.]$/.test(msg), `${label}: ends as a sentence`);
  assert.ok(!msg.includes(refusal.value), `${label}: the message holds the value`);
  for (const part of refusal.parts) assert.ok(!msg.includes(part), `${label}: the message holds a piece of the value`);
  assert.ok(!msg.includes(GH_TOKEN), `${label}: the message holds the GitHub token`);
}

for (const refusal of REFUSALS) {
  test(`R107 readEnv refuses a secret of ${refusal.name}, in one sentence without the value`, () => {
    const r = readEnv({ BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PROXY_SECRET: refusal.value });
    assert.equal(r.ok, false, 'it must refuse');
    assertPlainSentenceWithout(r.message, refusal, refusal.name);
    assert.match(r.message, /BOARD_PROXY_SECRET/, 'it names the setting');
  });

  test(`R107 the board refuses to start with a secret of ${refusal.name}, in one sentence without the value`, async () => {
    const err = await startRejection({ ...PROXY, BOARD_PROXY_SECRET: refusal.value });
    assert.ok(err instanceof Error, 'start must reject with an Error');
    assertPlainSentenceWithout(err.message, refusal, refusal.name);
    assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(err.message), 'no stack in the message');
  });
}

test('R107 a secret of exactly 32 characters is read as it is and the board starts', async () => {
  const value = 'z'.repeat(32);
  const r = readEnv({ BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PROXY_SECRET: value });
  assert.equal(r.ok, true);
  assert.equal(r.env.proxySecret, value);
  assert.equal(await startRejection({ ...PROXY, BOARD_PROXY_SECRET: value }), null, 'it must start');
  await withServer({ env: { ...PROXY, BOARD_PROXY_SECRET: value } }, async ({ port }) => {
    assert.equal((await sendRequest(port, { reqPath: '/static/board.css', headers: { [ID]: 'sam' } })).status, 401);
    assert.equal((await sendRequest(port, { reqPath: '/static/board.css', headers: { [ID]: 'sam', [H]: value } })).status, 200);
  });
});

test('R107 a longer secret is read as it is', () => {
  const value = SECRET + SECRET;
  const r = readEnv({ BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PROXY_SECRET: value });
  assert.equal(r.ok, true);
  assert.equal(r.env.proxySecret, value);
});

test('R107 an unset or empty secret is read as null, in every mode', () => {
  const base = { BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life' };
  for (const extra of [{}, { BOARD_MODE: 'proxy', BOARD_IDENTITY_HEADER: ID }, { BOARD_MODE: 'hosted', BOARD_IDENTITY_HEADER: ID }]) {
    const unset = readEnv({ ...base, ...extra });
    assert.equal(unset.ok, true);
    assert.equal(unset.env.proxySecret, null, 'unset gives null');
    const empty = readEnv({ ...base, ...extra, BOARD_PROXY_SECRET: '' });
    assert.equal(empty.ok, true);
    assert.equal(empty.env.proxySecret, null, 'empty gives null');
  }
});

test('R107 the secret check does not change the other settings', () => {
  const base = { BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life' };
  const without = readEnv(base).env;
  const withSecret = readEnv({ ...base, BOARD_PROXY_SECRET: SECRET }).env;
  const { proxySecret, ...rest } = withSecret;
  assert.equal(proxySecret, SECRET);
  const { proxySecret: ignored, ...restWithout } = without;
  assert.deepEqual(rest, restWithout);
});

// ---------------------------------------------------------------- cold start

test('R107 the first request after a fresh start with an empty data folder and no header is refused, as on a board that has already served a page', async () => {
  const env = { ...PROXY, BOARD_PROXY_SECRET: SECRET };
  const cold = await withServer({ env, fetch: makeWorld().fetch }, async ({ port }) => {
    const first = await sendRequest(port, { reqPath: '/', headers: { [ID]: 'sam' } });
    assert.equal(first.status, 401, 'cold: first request, no header');
    const ok = await sendRequest(port, { reqPath: '/', headers: { [ID]: 'sam', [H]: SECRET } });
    assert.equal(ok.status, 200, 'cold: the right header gets the page');
    return first;
  });
  const warm = await withServer({ env, fetch: makeWorld().fetch }, async ({ port }) => {
    const page = await sendRequest(port, { reqPath: '/', headers: { [ID]: 'sam', [H]: SECRET } });
    assert.equal(page.status, 200, 'warm: a page was served');
    const again = await sendRequest(port, { reqPath: '/', headers: { [ID]: 'sam' } });
    assert.equal(again.status, 401, 'warm: no header');
    return again;
  });
  assert.equal(cold.status, warm.status);
  assert.deepEqual(withoutDate(cold), withoutDate(warm));
  assert.equal(cold.body, warm.body);
});

test('R107 a restart over a saved copy in the data folder still refuses the first request without the header', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-proxy-secret-'));
  try {
    const env = { ...PROXY, BOARD_PROXY_SECRET: SECRET };
    await withServer({ env, fetch: makeWorld().fetch, dir }, async ({ port }) => {
      const page = await sendRequest(port, { reqPath: '/', headers: { [ID]: 'sam', [H]: SECRET } });
      assert.equal(page.status, 200);
    });
    await withServer({ env, fetch: downFetch(), dir }, async ({ port }) => {
      const first = await sendRequest(port, { reqPath: '/', headers: { [ID]: 'sam' } });
      assert.equal(first.status, 401);
      const body = first.body;
      assert.ok(!body.includes('<form'));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- health check

test('R107 GET /healthz with a wrong secret and a foreign Host answers 200 and exactly ok', async () => {
  await withServer({ env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
    await witnessLockIsOn(port);
    for (const headers of [{ [H]: WRONG }, { [H]: WRONG_SAME_LENGTH }, { [H]: [SECRET, SECRET] }, {}]) {
      const res = await sendRequest(port, { reqPath: '/healthz', headers: { host: 'evil.example:80', ...headers } });
      assert.equal(res.status, 200);
      assert.equal(res.body, 'ok');
    }
  });
});

// ---------------------------------------------------------------- the guard, as a unit

function makeGuard(over = {}) {
  return createGuard({ token: GH_TOKEN, allowedHosts: ['board.example'], identityHeader: null, clock: CLOCK, ...over });
}
const greq = (headers = {}) => ({ method: 'GET', url: '/', headers: { host: 'board.example', ...headers } });

test('R107 proxyOk is true for everything when no secret is configured', () => {
  for (const over of [{}, { proxySecret: null }, { proxySecret: undefined }, { proxySecret: '' }]) {
    const g = makeGuard(over);
    assert.equal(typeof g.proxyOk, 'function', 'proxyOk exists');
    assert.equal(g.proxyOk(greq()), true);
    assert.equal(g.proxyOk(greq({ [H]: WRONG })), true);
    assert.equal(g.proxyOk(greq({ [H]: SECRET })), true);
  }
});

test('R107 proxyOk with a secret is true only for the present and equal header', () => {
  const g = makeGuard({ proxySecret: SECRET });
  assert.equal(typeof g.proxyOk, 'function', 'proxyOk exists');
  assert.equal(g.proxyOk(greq({ [H]: SECRET })), true, 'right');
  assert.equal(g.proxyOk(greq()), false, 'absent');
  assert.equal(g.proxyOk(greq({ [H]: WRONG })), false, 'wrong');
  assert.equal(g.proxyOk(greq({ [H]: WRONG_SAME_LENGTH })), false, 'wrong but of equal length');
  assert.equal(g.proxyOk(greq({ [H]: SECRET.toLowerCase() })), false, 'different case');
  assert.equal(g.proxyOk(greq({ [H]: ` ${SECRET}` })), false, 'with a leading space');
  assert.equal(g.proxyOk(greq({ [H]: `${SECRET}, ${SECRET}` })), false, 'sent twice, as node joins it');
});

test('R107 proxyOk does not throw and returns false for header values of other lengths', () => {
  const g = makeGuard({ proxySecret: SECRET });
  assert.equal(typeof g.proxyOk, 'function', 'proxyOk exists');
  for (const [name, value] of [['empty', ''], ['1 character', 'x'], ['1000 characters', 'x'.repeat(1000)], ['one short', SECRET.slice(1)], ['one long', `${SECRET}x`]]) {
    let out;
    assert.doesNotThrow(() => { out = g.proxyOk(greq({ [H]: value })); }, `${name}: no throw`);
    assert.equal(out, false, `${name}: false`);
  }
});

test('R107 proxyOk does not throw and returns false for a missing or non-string header', () => {
  const g = makeGuard({ proxySecret: SECRET });
  assert.equal(typeof g.proxyOk, 'function', 'proxyOk exists');
  const odd = [['undefined', undefined], ['null', null], ['number', 42], ['array', [SECRET, SECRET]], ['array of one', [SECRET]], ['object', { a: 1 }], ['boolean', true], ['buffer', Buffer.from(SECRET)]];
  for (const [name, value] of odd) {
    let out;
    assert.doesNotThrow(() => { out = g.proxyOk({ method: 'GET', url: '/', headers: { host: 'board.example', [H]: value } }); }, `${name}: no throw`);
    assert.equal(out, false, `${name}: false`);
  }
  assert.doesNotThrow(() => g.proxyOk({ method: 'GET', url: '/', headers: {} }), 'no headers at all');
  assert.equal(g.proxyOk({ method: 'GET', url: '/', headers: {} }), false);
});

// This is a tripwire on the SOURCE, not a timing measurement: timing cannot be measured reliably in a test.
// It fails if proxyOk stops comparing through timingSafeEqual on fixed-length digests, or compares with ===, == or their negations.
test('R107 proxyOk compares through timingSafeEqual on fixed-length digests', () => {
  const src = readFileSync(path.join(HERE, '..', 'board', 'guard.mjs'), 'utf8');
  const start = src.search(/function\s+proxyOk\s*\(/);
  assert.ok(start >= 0, 'proxyOk is defined as a function in guard.mjs');
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, 'the body of proxyOk was isolated');
  const body = src.slice(open, end + 1);
  assert.match(body, /timingSafeEqual\s*\(/, 'proxyOk calls timingSafeEqual');
  assert.match(body, /createHash\s*\(/, 'proxyOk compares digests of fixed length');
  // a test of presence (against null or undefined) is allowed; any other ==, ===, != or !== is a comparison of values
  const rest = body.replace(/[!=]==?\s*(null|undefined)\b/g, '').replace(/\b(null|undefined)\s*[!=]==?/g, '');
  assert.ok(!/[!=]==?/.test(rest), `proxyOk holds a plain comparison: ${(/.{0,40}[!=]==?.{0,40}/.exec(rest) || [''])[0]}`);
});

test('R107 proxyOk leaves the other checks of the guard as they were', () => {
  const g = makeGuard({ proxySecret: SECRET, identityHeader: ID });
  assert.equal(g.hostOk(greq()), true);
  assert.equal(g.hostOk({ method: 'GET', url: '/', headers: { host: 'evil.example' } }), false);
  assert.equal(g.identityOk(greq({ [ID]: 'sam' })), true);
  assert.equal(g.identityOk(greq()), false);
  assert.equal(typeof g.proxyOk, 'function', 'proxyOk exists');
  assert.equal(g.proxyOk(greq({ [ID]: 'sam' })), false, 'the identity is not the secret');
});

test('U the guard keeps the secret out of its own surface', () => {
  const g = makeGuard({ proxySecret: SECRET });
  const t = g.formToken('idea', 'new');
  assert.ok(!t.includes(SECRET));
  assert.ok(!JSON.stringify(Object.keys(g)).includes(SECRET));
  assert.ok(!String(g.proxyOk).includes(SECRET));
});

// ---------------------------------------------------------------- the invariant sweep

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

async function sweepSession(body) {
  const cap = newCap();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-proxy-sweep-'));
  const world = makeWorld();
  const running = [];
  const restore = installStdCapture(cap);
  const log = (line) => { cap.counts.logs += 1; addItem(cap, 'log', 'log line', line); };
  const env = { ...PROXY, BOARD_PROXY_SECRET: SECRET };
  let failure = null;
  const ctx = {
    world, dir,
    async boot(sub = 'data') {
      const r = await start({
        processEnv: { BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: path.join(dir, sub), ...env },
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
    async page(port, label, headers) {
      const res = await ctx.request(port, label, { reqPath: '/', headers });
      const forms = parseForms(res.body);
      for (const f of forms) if (f.fields.token) { cap.counts.formTokens += 1; addItem(cap, 'form-token', `${f.action} [${label}]`, f.fields.token); }
      return { res, forms };
    },
    post(port, label, form, headers, bad = false) {
      const f = bad ? { ...form, fields: { ...form.fields, token: 'not.a.token' } } : form;
      return ctx.request(port, label, {
        method: 'POST', reqPath: form.action, headers: { ...FORM, origin: `http://localhost:${port}`, ...headers }, body: submission(f),
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

test('R107 the secret appears nowhere: every route, every action and every forced failure, raw, URL-encoded and base64-encoded', async () => {
  const good = { [ID]: 'sam', [H]: SECRET };
  const seenStatus = new Set();
  const note = (r) => { seenStatus.add(r.status); return r; };
  const { cap, world } = await sweepSession(async (ctx) => {
    const port = await ctx.boot();
    // every route with the right header, then the actions with a real token, a repeated one, and a bad one
    const { res, forms } = await ctx.page(port, 'right header', good);
    assert.equal(res.status, 200, 'the sweep needs a served page');
    await witnessLockIsOn(port);
    for (const p of ['/healthz', '/static/board.css', '/static/board.js']) note(await ctx.request(port, 'right header', { reqPath: p, headers: good }));
    const seen = new Set();
    for (const f of forms) {
      const key = f.action + (f.fields.accept === '1' ? '+accept' : '');
      if (seen.has(key)) continue;
      seen.add(key);
      note(await ctx.post(port, 'valid token', f, good));
      note(await ctx.post(port, 'same token again', f, good));
      note(await ctx.post(port, 'bad token', f, good, true));
      note(await ctx.post(port, 'no secret', f, { [ID]: 'sam' }));
      note(await ctx.post(port, 'wrong secret', f, { [ID]: 'sam', [H]: WRONG_SAME_LENGTH }));
    }
    for (const a of ['idea', 'habit', 'sort', 'close']) assert.ok(forms.some((f) => f.action === `/actions/${a}`), `a ${a} form to drive`);
    // the refusals, on every route
    for (const route of ROUTES) {
      for (const hc of HEADER_CASES) {
        for (const ic of IDENTITY_CASES) {
          const res2 = await ctx.request(port, `${hc.name}, ${ic.name}`, {
            method: route.method, reqPath: route.reqPath,
            headers: { ...(route.method === 'POST' ? { ...FORM, origin: `http://localhost:${port}` } : {}), ...hc.headers, ...ic.headers },
            body: route.method === 'POST' ? 'title=x' : null,
          });
          note(res2);
        }
      }
    }
    // the secret sent where it does not belong
    note(await ctx.request(port, 'foreign host', { reqPath: '/', headers: { host: 'evil.example:80', ...good } }));
    note(await ctx.request(port, 'foreign host health', { reqPath: '/healthz', headers: { host: 'evil.example:80', ...good } }));
    note(await ctx.request(port, 'in the query', { reqPath: `/?k=${encodeURIComponent(SECRET)}`, headers: good }));
    note(await ctx.request(port, 'in the query, no header', { reqPath: `/?k=${encodeURIComponent(SECRET)}`, headers: { [ID]: 'sam' } }));
    note(await ctx.request(port, 'not found', { reqPath: '/nope', headers: good }));
    note(await ctx.request(port, 'wrong method', { method: 'DELETE', reqPath: '/', headers: good }));
    note(await ctx.request(port, 'wrong method', { method: 'GET', reqPath: '/actions/idea', headers: good }));
    note(await ctx.request(port, 'bad content type', { method: 'POST', reqPath: '/actions/idea', headers: { 'content-type': 'application/json', ...good }, body: '{}' }));
    note(await ctx.request(port, 'huge body', { method: 'POST', reqPath: '/actions/idea', headers: { ...FORM, ...good }, body: `title=${'a'.repeat(200000)}` }));
    // GitHub failing: warm, then cold; and writes failing
    ctx.world.mode = 'writes500';
    for (const f of forms) note(await ctx.post(port, 'writes fail', f, good));
    ctx.world.mode = 'down500';
    note((await ctx.page(port, 'github down, warm', good)).res);
    const cold = await ctx.boot('cold');
    note((await ctx.page(cold, 'github down, cold', good)).res);
    note((await ctx.page(cold, 'github down, cold, no header', { [ID]: 'sam' })).res);
    ctx.world.mode = 'good';
    const again = await ctx.boot('data');
    note((await ctx.page(again, 'restarted', good)).res);
    note((await ctx.page(again, 'restarted, no header', { [ID]: 'sam' })).res);
  });
  // not vacuous
  assert.ok(world.calls.length > 0, 'the fake GitHub was never reached');
  assert.ok(seenStatus.has(200), 'a served response was captured');
  assert.ok(seenStatus.has(401), 'a 401 was captured');
  assert.ok(seenStatus.has(421), 'a 421 was captured');
  assert.ok(cap.counts.responses >= 100, `only ${cap.counts.responses} responses were examined`);
  assert.ok(cap.counts.logs >= 5, `only ${cap.counts.logs} log lines were examined`);
  assert.ok(cap.counts.formTokens >= 3, `only ${cap.counts.formTokens} form tokens were examined`);
  assert.ok(cap.counts.files >= 1, `only ${cap.counts.files} files were examined`);
  assert.ok(world.calls.some((c) => c.method !== 'GET'), 'no write reached the fake GitHub');
  const found = findLeaks(cap, needles(SECRET));
  assert.equal(found.length, 0, `the proxy secret was found in captured material: ${found.map((f) => `${f.form} form in ${f.kind} at ${f.where}`).join('; ')}`);
  // and the finder sees all three forms of the sentinel when they are planted
  const probe = newCap();
  addItem(probe, 'body', 'raw', SECRET);
  addItem(probe, 'body', 'url', encodeURIComponent(SECRET));
  addItem(probe, 'body', 'b64', `x ${Buffer.from(SECRET).toString('base64')} y`);
  const kinds = new Set(findLeaks(probe, needles(SECRET)).map((f) => f.where));
  assert.deepEqual([...kinds].sort(), ['b64', 'raw', 'url']);
  // the lock was really on during the sweep
  assert.ok(![...cap.items].some((i) => i.kind === 'status-line' && /no secret/.test(i.where) && /200/.test(i.text)), 'a post without the secret was served');
});

// R107: "or it gets 401 and no board". A refused action must not have been performed: wrong code that does the write
// and then answers 401 must fail. Each cell uses a real form with a valid token, so that without the lock it would write.
const writes = (world, from) => world.calls.slice(from).filter((c) => c.method !== 'GET');

for (const action of ['idea', 'habit', 'sort', 'close']) {
  test(`R107 a refused POST /actions/${action} with a valid form reaches no write on GitHub and gives the same 401 as a missing identity`, async () => {
    const world = makeWorld();
    await withServer({ env: { ...PROXY, BOARD_PROXY_SECRET: SECRET }, fetch: world.fetch }, async ({ port }) => {
      await witnessLockIsOn(port);
      const good = { [ID]: 'sam', [H]: SECRET };
      const formsNow = async () => {
        const page = await sendRequest(port, { reqPath: '/', headers: good });
        assert.equal(page.status, 200, 'a page to take forms from');
        return parseForms(page.body).filter((f) => f.action === `/actions/${action}`);
      };
      const post = (form, headers) => sendRequest(port, {
        method: 'POST', reqPath: form.action, headers: { ...FORM, origin: `http://localhost:${port}`, ...headers }, body: submission(form),
      });
      // the reference: a valid form, the right secret, no identity
      const [first] = await formsNow();
      assert.ok(first, `the page offers a ${action} form`);
      const missingIdentity = await post(first, { [H]: SECRET });
      assert.equal(missingIdentity.status, 401, 'the identity lock refuses');
      for (const hc of HEADER_CASES) {
        for (const ic of IDENTITY_CASES) {
          if (hc.right && ic.present) continue;
          const cell = `${action} / header ${hc.name} / ${ic.name}`;
          const [form] = await formsNow();
          const before = world.calls.length;
          const res = await post(form, { ...hc.headers, ...ic.headers });
          sameAnswer(res, missingIdentity, `${cell}: the same 401 as a missing identity`);
          assert.deepEqual(writes(world, before), [], `${cell}: a write reached GitHub`);
        }
      }
      // positive control: the same kind of form, with the right header and identity, does write
      const [ok] = await formsNow();
      const before = world.calls.length;
      const done = await post(ok, good);
      assert.notEqual(done.status, 401, 'the unlocked request is not refused');
      assert.ok(writes(world, before).length > 0, `the form for ${action} writes when the lock is passed, so the refusals above prove something`);
    });
  });
}

test('R107 the refusals to start leave the secret in no message', async () => {
  const cap = newCap();
  const restore = installStdCapture(cap);
  let errs = [];
  try {
    const values = ['k'.repeat(31), `${SECRET.slice(0, 20)} ${SECRET.slice(21)}`, `${SECRET}\n`, '          '];
    for (const v of values) {
      const err = await startRejection({ ...PROXY, BOARD_PROXY_SECRET: v });
      errs.push(err);
      if (err) addItem(cap, 'rejection', 'start', `${err.name} ${err.message} ${err.stack || ''}`);
    }
  } finally {
    restore();
  }
  assert.ok(errs.every((e) => e instanceof Error), 'every bad value is refused');
  const found = findLeaks(cap, needles(SECRET));
  assert.equal(found.length, 0, 'the value was found in a refusal');
  for (const e of errs) assert.ok(!e.message.includes(SECRET.slice(0, 20)), 'a piece of the value is in the message');
});

// ---------------------------------------------------------------- this file's own rules

test('U every --import in this file hands over a file address', () => {
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const uses = own.split('\n').filter((l) => l.includes("'--import'") && !l.includes('own.split'));
  for (const line of uses) assert.ok(line.includes('pathToFileURL'), `a plain path after --import: ${line.trim()}`);
});
