// CP6 (SKILLS-78) job D2, score half: R140 (the grid and the refusals), R55 (the score target), R57/R58 (a scored habit takes no
// tick), R62 (five 502 pages), R63 (five 403s), R80 (nine routes), R70 holds (a score shows on the redirected load).
// Written from the rule text (references/contract.md) and reference/mapping-redesign/cp6-interface.md sections 4d, 4e, 4f, 4g, 4h,
// never from the new code. A recording fake gh with the section 4h methods stands in for GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { NOW, settings, project, checkin, raw, state, resetNumbers, board } from '../fixtures/build.mjs';
import { setHabit, setScore } from '../board/actions.mjs';
import { verbsFromGh } from '../board/github/adapter.mjs';
import { createGuard } from '../board/guard.mjs';
import { createHandlers } from '../board/handlers.mjs';
import { createLoader } from '../board/load.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { GitHubError } from '../board/github/http.mjs';

const DATA = 'sam-life/life';
const OWNER = 'sam-life';
const TODAY = '2026-10-12';
const YESTERDAY = '2026-10-11';
const CLOSE = { state: 'closed', state_reason: 'completed' };
const SCORE_FIELD = 104;
const HOST = 'localhost:8787';
const SECRET = 'SENTINEL-TOKEN-123';
const HOUR = 3600 * 1000;

function ghError(status = 500) {
  return Object.assign(new Error('GitHub is not answering right now.'), { name: 'GitHubError', kind: status === 500 ? 'server' : 'invalid', status });
}

// A recording gh with the section 4h methods. failOn(entry) may return true (500) or a status number.
function recorder({ failOn = null } = {}) {
  const calls = [];
  let nextIssue = 900;
  const rec = (entry) => {
    calls.push(entry);
    const f = failOn ? failOn(entry) : false;
    if (f) throw ghError(typeof f === 'number' ? f : 500);
  };
  const gh = {
    async createIssue({ title, labels }) { rec(['create', { title, labels }]); return { number: nextIssue++, title, labels, state: 'open' }; },
    async createIssueIn() { rec(['createIn']); return {}; },
    async patchIssue(n, p) { rec(['patch', n, p]); return { number: n, ...p }; },
    async patchIssueIn(repo, n, p) { rec(['patchIn', repo, n, p]); return { number: n, ...p }; },
    async getIssueIn() { rec(['getIssue']); return {}; },
    async getRepo() { rec(['getRepo']); return {}; },
    async transferIssue() { rec(['transfer']); return {}; },
    async listComments() { rec(['listComments']); return []; },
    async addComment() { rec(['addComment']); return {}; },
    async addProjectItem(a) { rec(['add', a]); return { id: 7001 }; },
    async deleteProjectItem(a) { rec(['delete', a]); return null; },
    async setItemNumber(a) { rec(['setNumber', a]); return {}; },
    noteRemoved() {},
  };
  return { gh, calls };
}
const kinds = (calls) => calls.map((c) => c[0]);

const HABITS = [
  { id: 'move', title: 'Move', start: '2026-10-01', score: { min: 1, max: 10 } },
  { id: 'read', title: 'Read', start: '2026-10-01' },
];

// A world. `issues` are the data repo's; `habitItems` are the Habits Project's items (project 10, role row, Score field 104).
function world({ issues = [], habitItems = [], roleRow = true, scoreField = SCORE_FIELD } = {}) {
  return {
    raw: raw({
      issues,
      projects: [
        project(3, 'House'),
        ...(roleRow
          ? [project(10, 'Habits', habitItems, { role: 'habits', owner: OWNER, ownerType: 'organization', ...(scoreField === null ? {} : { scoreField }) })]
          : []),
      ],
    }),
    settings: settings({ projects: [{ key: 'house', number: 3 }], habits: HABITS, habitsProject: { owner: OWNER, number: 10 } }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
}
const item = (number, extra = {}) => ({ repo: DATA, number, itemId: 7000 + number, ...extra });

function assertRefusal(res, label = '') {
  assert.equal(res.ok, false, `${label} refused`);
  assert.equal(res.status, 400, `${label} status`);
  assert.ok(typeof res.message === 'string' && res.message.trim().length > 0, `${label} has a message`);
}
const score = (w, over, gh) => setScore(w, { id: 'move', date: TODAY, score: '7', ...over }, verbsFromGh(gh, DATA), NOW);

function setNumberOf(c, itemId, value) {
  const a = c[1];
  assert.equal(c[0], 'setNumber');
  assert.equal(a.projectNumber, 10);
  assert.equal(a.owner, OWNER);
  assert.equal(a.ownerType, 'organization');
  assert.equal(a.itemId, itemId);
  assert.equal(a.fieldId, SCORE_FIELD);
  assert.equal(a.value, value);
}
function addOf(c, issueNumber) {
  const a = c[1];
  assert.equal(c[0], 'add');
  assert.equal(a.projectNumber, 10);
  assert.equal(a.owner, OWNER);
  assert.equal(a.ownerType, 'organization');
  assert.equal(a.issueNumber, issueNumber);
  assert.equal(a.repo ?? DATA, DATA);
}

// ---------- R140: the grid ----------

test('R140 no check-in, first score: create, close, add to the Habits Project, set Score', async () => {
  resetNumbers();
  const { gh, calls } = recorder();
  const res = await score(world(), {}, gh);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(kinds(calls), ['create', 'patch', 'add', 'setNumber']);
  assert.deepEqual(calls[0], ['create', { title: `Move · ${TODAY}`, labels: ['habit:move'] }]);
  assert.deepEqual(calls[1], ['patch', 900, CLOSE]);
  addOf(calls[2], 900);
  setNumberOf(calls[3], 7001, 7);
});

test('R140 an open check-in, first score: close it, add it, set Score; nothing is created', async () => {
  resetNumbers();
  const c = checkin('move', TODAY, { closed: false });
  const { gh, calls } = recorder();
  const res = await score(world({ issues: [c] }), {}, gh);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['patch', 'add', 'setNumber']);
  assert.deepEqual(calls[0], ['patch', c.number, CLOSE]);
  addOf(calls[1], c.number);
  setNumberOf(calls[2], 7001, 7);
});

test('R140 a closed check-in, first score: no create and no close; add it, set Score', async () => {
  resetNumbers();
  const c = checkin('move', TODAY, { closed: true });
  const { gh, calls } = recorder();
  const res = await score(world({ issues: [c] }), {}, gh);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['add', 'setNumber']);
  addOf(calls[0], c.number);
  setNumberOf(calls[1], 7001, 7);
});

test('R140 two open check-ins, first score: both are closed, then one add and one Score', async () => {
  resetNumbers();
  const a = checkin('move', TODAY, { closed: false });
  const b = checkin('move', TODAY, { closed: false });
  const { gh, calls } = recorder();
  const res = await score(world({ issues: [a, b] }), {}, gh);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['patch', 'patch', 'add', 'setNumber']);
  assert.deepEqual(calls.slice(0, 2).map((c) => c[1]).sort((x, y) => x - y), [a.number, b.number].sort((x, y) => x - y));
});

for (const [name, start] of [
  ['no check-in', () => []],
  ['an open check-in', () => [checkin('move', TODAY, { closed: false })]],
  ['a closed check-in', () => [checkin('move', TODAY, { closed: true })]],
]) {
  test(`R140 ${name}, second score on the same day: only Score is set, with no create, close or add`, async () => {
    resetNumbers();
    // After the first score the day holds one closed check-in that is an item of the Habits Project with its item id.
    const first = recorder();
    const w1 = world({ issues: start() });
    assert.equal((await score(w1, {}, first.gh)).ok, true);
    const number = w1.raw.issues[0]?.number ?? 900;
    const second = recorder();
    const w2 = world({
      issues: [{ ...checkin('move', TODAY, { closed: true }), number }],
      habitItems: [item(number, { score: 7 })],
    });
    const res = await score(w2, { score: '9' }, second.gh);
    assert.equal(res.ok, true);
    assert.deepEqual(kinds(second.calls), ['setNumber']);
    setNumberOf(second.calls[0], 7000 + number, 9);
  });
}

test('R140 a closed check-in that is already an item gets Score only, whatever the old score was', async () => {
  resetNumbers();
  const c = checkin('move', TODAY, { closed: true });
  const { gh, calls } = recorder();
  const res = await score(world({ issues: [c], habitItems: [item(c.number)] }), { score: '1' }, gh);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['setNumber']);
  setNumberOf(calls[0], 7000 + c.number, 1);
});

test('R140 the lowest and the highest whole score of the range are accepted', async () => {
  for (const s of ['1', '10']) {
    resetNumbers();
    const c = checkin('move', TODAY, { closed: true });
    const { gh, calls } = recorder();
    const res = await score(world({ issues: [c], habitItems: [item(c.number)] }), { score: s }, gh);
    assert.equal(res.ok, true, s);
    assert.equal(calls[0][1].value, Number(s));
  }
});

test('R140 an add answered 422 with no item id to be found is a failure that names GitHub, and no score is set', async () => {
  resetNumbers();
  const c = checkin('move', TODAY, { closed: true });
  const { gh, calls } = recorder({ failOn: (e) => (e[0] === 'add' ? 422 : false) });
  const res = await score(world({ issues: [c] }), {}, gh);
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.ok(!calls.some((x) => x[0] === 'setNumber'));
});

// ---------- R140: the refusals ----------

test('R140 an unknown habit, a habit without score, a date that is not today and a score out of range are each 400 with no request', async () => {
  resetNumbers();
  const w = world({ issues: [checkin('move', TODAY, { closed: false })] });
  const { gh, calls } = recorder();
  assertRefusal(await score(w, { id: 'ghost' }, gh), 'unknown habit');
  assertRefusal(await score(w, { id: 'read' }, gh), 'habit without score');
  assertRefusal(await score(w, { date: YESTERDAY }, gh), 'date not today');
  assertRefusal(await score(w, { score: '0' }, gh), 'below min');
  assertRefusal(await score(w, { score: '11' }, gh), 'above max');
  assertRefusal(await score(w, { score: '5.5' }, gh), 'not whole');
  assertRefusal(await score(w, { score: 'seven' }, gh), 'not a number');
  assert.deepEqual(calls, []);
});

test('R140 a score outside a habit\'s own narrower range is refused', async () => {
  resetNumbers();
  const w = world();
  w.settings.habits = [{ id: 'move', title: 'Move', start: '2026-10-01', score: { min: 3, max: 5 } }];
  const { gh, calls } = recorder();
  assertRefusal(await score(w, { score: '2' }, gh));
  assertRefusal(await score(w, { score: '6' }, gh));
  assert.deepEqual(calls, []);
});

test('R140 with no Habits role row, or no Score field in the read, the answer is 400 and no request is sent', async () => {
  resetNumbers();
  const { gh, calls } = recorder();
  assertRefusal(await score(world({ roleRow: false }), {}, gh), 'no role row');
  const noField = await score(world({ scoreField: null }), {}, gh);
  assertRefusal(noField, 'no Score field');
  assert.match(noField.message, /Score/);
  assert.deepEqual(calls, []);
});

// ---------- R57 / R58 ----------

test('R57 a tick post for a scored habit is 400 with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await setHabit(world(), { id: 'move', date: TODAY, on: true }, verbsFromGh(gh, DATA), NOW));
  assert.deepEqual(calls, []);
});

test('R58 an untick post for a scored habit is 400 with no request, even with a closed check-in today', async () => {
  resetNumbers();
  const { gh, calls } = recorder();
  const w = world({ issues: [checkin('move', TODAY, { closed: true })] });
  assertRefusal(await setHabit(w, { id: 'move', date: TODAY, on: false }, verbsFromGh(gh, DATA), NOW));
  assert.deepEqual(calls, []);
});

test('R57 a habit without score is still ticked as before', async () => {
  const { gh, calls } = recorder();
  const res = await setHabit(world(), { id: 'read', date: TODAY, on: true }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['create', { title: `Read · ${TODAY}`, labels: ['habit:read'] }], ['patch', 900, CLOSE]]);
});

// ---------- through the handlers: R55, R62, R63, R57/58 ----------

const NAMES = ['idea', 'habit', 'sort', 'close', 'score'];

function setup({ readOnly = false } = {}) {
  resetNumbers();
  const w = world({ issues: [{ ...checkin('move', TODAY, { closed: true }), number: 70 }] });
  w.raw.issues.push({ number: 50, title: 'Shelves', state: 'open', state_reason: null, is_pr: false, labels: ['idea'], milestone: null, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null, html_url: `https://github.com/${DATA}/issues/50` });
  w.raw.issues.push({ number: 60, title: 'Paint the door', state: 'open', state_reason: null, is_pr: false, labels: [], milestone: null, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null, html_url: `https://github.com/${DATA}/issues/60` });
  w.raw.projects[0].items.push({ type: 'Issue', repo: DATA, number: 60, status: null, due: null });
  w.raw.milestones = [{ number: 5, title: 'House · Hallway', state: 'open', due_on: '2026-10-20T07:00:00Z', closed_at: null, html_url: `https://github.com/${DATA}/milestone/5` }];
  const loader = {
    writes: [],
    async load() {
      return { ok: true, bundle: { savedAt: NOW, raw: w.raw, settings: w.settings, theme: resolveTheme(null).theme, state: w.state, run: { stale: null, readOnly, warnings: [] } } };
    },
    noteWrite(x) { loader.writes.push(x); },
    fullDue() { return false; },
  };
  const gh = { calls: [], fail: false, next: 900 };
  const attempt = (name, args) => { gh.calls.push({ name, args }); if (gh.fail) throw ghError(); };
  const apiIssue = (number, extra = {}) => ({ number, title: 'x', labels: [], state: 'open', state_reason: null, created_at: NOW, updated_at: NOW, closed_at: null, ...extra });
  Object.assign(gh, {
    async createIssue({ title, labels }) { attempt('createIssue', { title, labels }); return apiIssue(gh.next++, { title, labels }); },
    async createIssueIn(repo, a) { attempt('createIssueIn', a); return apiIssue(3, { title: a.title }); },
    async patchIssue(number, patch) { attempt('patchIssue', { number, patch }); return apiIssue(number, patch); },
    async patchIssueIn(repo, number, patch) { attempt('patchIssueIn', { repo, number, patch }); return apiIssue(number, patch); },
    async getIssueIn() { attempt('getIssueIn', {}); return apiIssue(1); },
    async getRepo() { attempt('getRepo', {}); return { node_id: 'R' }; },
    async transferIssue() { attempt('transferIssue', {}); return {}; },
    async listComments() { attempt('listComments', {}); return []; },
    async addComment() { attempt('addComment', {}); return {}; },
    async addProjectItem(a) { attempt('addProjectItem', a); return { id: 7001 }; },
    async deleteProjectItem(a) { attempt('deleteProjectItem', a); return null; },
    async setItemNumber(a) { attempt('setItemNumber', a); return {}; },
    noteRemoved() {},
  });
  const clock = { t: Date.parse(NOW), now() { return this.t; } };
  const guard = createGuard({ token: SECRET, allowedHosts: [HOST], identityHeader: null, clock });
  const env = { repo: DATA, readOnly };
  const h = createHandlers({ loader, gh, guard, env, clock, random: () => 'NONCE123' });
  return { h, w, loader, gh, guard, clock };
}

const req = (extra = {}, url = '/actions/score') => ({
  method: 'POST',
  url,
  headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded', ...extra },
});
const act = (s, name, form, extra = {}) => s.h.action(name, req(extra, `/actions/${name}`), form);
const scoreForm = (s, over = {}) => ({ token: s.guard.formToken('score', `move:${TODAY}:score`), id: 'move', date: TODAY, score: '7', ...over });
const forms = {
  idea: (s) => ({ token: s.guard.formToken('idea', 'new'), title: 'Shelves for the hall' }),
  habit: (s) => ({ token: s.guard.formToken('habit', `read:${TODAY}:on`), id: 'read', date: TODAY, on: '1' }),
  sort: (s) => ({ token: s.guard.formToken('sort', '50'), number: '50', target: 'house/5' }),
  close: (s) => ({ token: s.guard.formToken('close', '60'), number: '60' }),
  score: (s) => scoreForm(s),
};
const noTrace = (body) => assert.ok(!/^ {4}at /m.test(body), 'no stack trace line');

test('R55 a score form posted with a token signed for <id>:<date>:score is accepted and writes', async () => {
  const s = setup();
  const res = await act(s, 'score', scoreForm(s));
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
  assert.ok(s.gh.calls.some((c) => c.name === 'setItemNumber'));
});

test('R55 a token signed for another target, another action, or a tick target is a 403 on the score route and writes nothing', async () => {
  const s = setup();
  const bad = [
    s.guard.formToken('score', `read:${TODAY}:score`),
    s.guard.formToken('score', 'move'),
    s.guard.formToken('score', `move:${TODAY}:on`),
    s.guard.formToken('habit', `move:${TODAY}:score`),
  ];
  for (const token of bad) assert.equal((await act(s, 'score', scoreForm(s, { token }))).status, 403);
  assert.equal((await act(s, 'score', { id: 'move', date: TODAY, score: '7' })).status, 403, 'no token');
  assert.equal((await act(s, 'score', scoreForm(s), { origin: 'http://evil.example' })).status, 403, 'cross-site origin');
  assert.equal((await act(s, 'score', scoreForm(s), { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site fetch');
  const old = scoreForm(s);
  s.clock.t += 13 * HOUR;
  assert.equal((await act(s, 'score', old)).status, 403, 'a token 13 hours old');
  assert.equal(s.gh.calls.length, 0);
});

test('R55 the same score form token posted twice writes once and answers 303 both times', async () => {
  const s = setup();
  const form = scoreForm(s);
  assert.equal((await act(s, 'score', form)).status, 303);
  const written = s.gh.calls.length;
  assert.ok(written > 0);
  assert.equal((await act(s, 'score', form)).status, 303);
  assert.equal(s.gh.calls.length, written);
});

test('R55 the token of a score form is bound to the score field being a field of the form: the score changes nothing about the target', async () => {
  const s = setup();
  const token = s.guard.formToken('score', `move:${TODAY}:score`);
  const a = await act(s, 'score', scoreForm(s, { token, score: '4' }));
  assert.equal(a.status, 303);
  assert.equal(s.gh.calls.at(-1).args.value, 4);
});

test('R57 a tick or untick posted to the habit route for a scored habit is 400 with no GitHub request', async () => {
  const s = setup();
  const on = await act(s, 'habit', { token: s.guard.formToken('habit', `move:${TODAY}:on`), id: 'move', date: TODAY, on: '1' });
  const off = await act(s, 'habit', { token: s.guard.formToken('habit', `move:${TODAY}:off`), id: 'move', date: TODAY, on: '0' });
  assert.equal(on.status, 400);
  assert.equal(off.status, 400);
  noTrace(on.body);
  assert.equal(s.gh.calls.length, 0);
});

test('R140 the four refusals through the route answer 400 and send nothing', async () => {
  const s = setup();
  const cases = [
    { id: 'ghost' },
    { id: 'read' },
    { date: YESTERDAY },
    { score: '11' },
  ];
  for (const over of cases) {
    const target = `${over.id ?? 'move'}:${over.date ?? TODAY}:score`;
    const res = await act(s, 'score', scoreForm(s, { token: s.guard.formToken('score', target), ...over }));
    assert.equal(res.status, 400, JSON.stringify(over));
    noTrace(res.body);
  }
  assert.equal(s.gh.calls.length, 0);
});

test('R62 each of the five actions with a valid post answers 303 to the front page', async () => {
  for (const name of NAMES) {
    const s = setup();
    const res = await act(s, name, forms[name](s));
    assert.equal(res.status, 303, name);
    assert.equal(res.headers.location, '/', name);
    assert.ok(s.gh.calls.length > 0, `${name} wrote`);
  }
});

test('R62 a forced GitHub 500 on each of the five actions answers five 502 pages with no stack line and no token', async () => {
  const statuses = [];
  for (const name of NAMES) {
    const s = setup();
    s.gh.fail = true;
    const res = await act(s, name, forms[name](s));
    statuses.push(res.status);
    assert.match(res.headers['content-type'], /^text\/html/, name);
    assert.ok(res.body.includes('GitHub is not answering right now'), name);
    noTrace(res.body);
    assert.ok(!res.body.includes(SECRET), name);
    assert.equal(res.headers.location, undefined, name);
  }
  assert.deepEqual(statuses, [502, 502, 502, 502, 502]);
});

test('R63 read-only: the page holds no form and the five action paths answer 403 with no GitHub write', async () => {
  const s = setup({ readOnly: true });
  const page = await s.h.page({ method: 'GET', url: '/', headers: { host: HOST } });
  assert.equal(page.status, 200);
  assert.equal((page.body.match(/<form/g) || []).length, 0);
  const statuses = [];
  for (const name of NAMES) {
    const res = await act(s, name, forms[name](s));
    statuses.push(res.status);
    noTrace(res.body);
  }
  assert.deepEqual(statuses, [403, 403, 403, 403, 403]);
  assert.equal(s.gh.calls.length, 0);
});

// ---------- R80: the real server ----------

const { start } = await import('../board/server.mjs');
const CLOCK_MS = Date.parse('2026-10-12T06:10:00Z');

function downFetch() {
  const fn = async () => ({ status: 503, ok: false, headers: { get: () => null }, json: async () => ({ message: 'down' }), text: async () => '{"message":"down"}' });
  return fn;
}
function send(port, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: { host: `localhost:${port}`, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== null) r.write(body);
    r.end();
  });
}
async function withServer(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-score-test-'));
  let running = null;
  try {
    running = await start({
      processEnv: { BOARD_GITHUB_TOKEN: SECRET, BOARD_REPO: DATA, BOARD_PORT: '0', BOARD_DATA_DIR: dir },
      fetch: downFetch(),
      clock: { now: () => CLOCK_MS },
      log: () => {},
    });
    return await fn(running.address.port);
  } finally {
    if (running) await running.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('R80 the nine routes answer something other than 404 or 405', async () => {
  await withServer(async (port) => {
    let n = 0;
    for (const p of ['/', '/static/board.css', '/static/board.js', '/healthz']) {
      const res = await send(port, { reqPath: p });
      assert.ok(res.status !== 404 && res.status !== 405, `GET ${p} gave ${res.status}`);
      n += 1;
    }
    for (const p of ['/actions/idea', '/actions/habit', '/actions/sort', '/actions/close', '/actions/score']) {
      const res = await send(port, { method: 'POST', reqPath: p, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=x' });
      assert.ok(res.status !== 404 && res.status !== 405, `POST ${p} gave ${res.status}`);
      n += 1;
    }
    assert.equal(n, 9);
  });
});

test('R80 GET /actions/score answers 405', async () => {
  await withServer(async (port) => {
    const res = await send(port, { reqPath: '/actions/score' });
    assert.equal(res.status, 405);
  });
});

test('R80 a score post with a bad token is 403 through the real server', async () => {
  await withServer(async (port) => {
    const res = await send(port, { method: 'POST', reqPath: '/actions/score', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=x&id=move&date=2026-10-12&score=7' });
    assert.equal(res.status, 403);
  });
});

// ---------- R70: the redirected load shows the score ----------

const R = `/repos/${DATA}`;
const notFound = (p) => new GitHubError('not-found', 404, `Nothing is stored at ${p}.`);
const apiIssue = (number, extra = {}) => ({
  id: number * 10, number, title: `Item ${number}`, state: 'open', state_reason: null, labels: [], milestone: null, comments: 0,
  created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
  html_url: `https://github.com/${DATA}/issues/${number}`, ...extra,
});

function liveWorld() {
  const w = {
    files: {
      'board.config.json': JSON.stringify(settings({
        projects: [{ key: 'house', number: 3 }],
        habits: [{ id: 'move', title: 'Move', start: '2026-10-01', score: { min: 1, max: 10 } }],
        habitsProject: { owner: OWNER, number: 10 },
      })),
    },
    issues: [], // no check-in yet today
    items: { 3: [], 10: [] }, // the item lists never catch up
  };
  const answer = (p) => {
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p.startsWith(`${R}/contents/`)) {
      const f = p.slice(`${R}/contents/`.length);
      if (w.files[f] == null) throw notFound(p);
      return { content: Buffer.from(w.files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(`${R}/issues?`)) return { items: structuredClone(p.includes('&since=') ? [] : w.issues), partial: false };
    if (p.startsWith(`${R}/milestones?`)) return { items: [], partial: false };
    if (p === `/orgs/${OWNER}/projectsV2?per_page=100`) {
      return { items: Object.keys(w.items).map((n) => ({ number: Number(n), title: `Project ${n}`, state: 'open' })), partial: false };
    }
    let m = new RegExp(`^/orgs/${OWNER}/projectsV2/(\\d+)/fields\\?`).exec(p);
    if (m) {
      const f = [{ id: 100, name: 'Title', data_type: 'title' }, { id: 101, name: 'Status', data_type: 'single_select' }, { id: 102, name: 'Due', data_type: 'date' }];
      return { items: m[1] === '10' ? [...f, { id: SCORE_FIELD, name: 'Score', data_type: 'number' }] : f, partial: false };
    }
    m = new RegExp(`^/orgs/${OWNER}/projectsV2/(\\d+)/items\\?`).exec(p);
    if (m) return { items: structuredClone(w.items[m[1]] ?? []), partial: false };
    throw notFound(p);
  };
  const httpFake = {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
  const cache = {
    stored: null,
    async readLastGood() { return cache.stored; },
    async writeLastGood(b) { cache.stored = structuredClone(b); },
    etags: { get() {}, set() {} },
  };
  const clock = { t: Date.parse('2026-10-12T06:10:00.900Z'), now() { return this.t; } };
  const env = { repo: DATA, readOnly: false, configDir: null, token: SECRET };
  const loader = createLoader({ http: httpFake, env, cache, clock });
  const sent = [];
  let next = 900;
  const gh = {
    async createIssue({ title, labels }) {
      sent.push(['create']);
      return apiIssue(next, { title, labels: labels.map((name) => ({ name })), created_at: '2026-10-12T06:10:00Z', updated_at: '2026-10-12T06:10:00Z', number: next++ });
    },
    async patchIssue(number, patch) {
      sent.push(['patch', number]);
      return apiIssue(number, { title: `Move · ${TODAY}`, labels: [{ name: 'habit:move' }], created_at: '2026-10-12T06:10:00Z', ...patch, closed_at: '2026-10-12T06:10:01Z', updated_at: '2026-10-12T06:10:01Z' });
    },
    async patchIssueIn() { return {}; },
    async addProjectItem(a) { sent.push(['add', a]); return { id: 7001 }; },
    async deleteProjectItem() { return null; },
    async setItemNumber(a) { sent.push(['setNumber', a]); return {}; },
    async getIssueIn() { return {}; },
    async getRepo() { return {}; },
    async transferIssue() { return {}; },
    async listComments() { return []; },
    async addComment() { return {}; },
    async createIssueIn() { return {}; },
    noteRemoved() {},
  };
  const guard = createGuard({ token: SECRET, allowedHosts: [HOST], identityHeader: null, clock });
  const h = createHandlers({ loader, gh, guard, env, clock, random: () => 'NONCE123' });
  return { h, guard, loader, sent };
}

test('R70 after a score is set the redirected load shows the check-in under the Habits Project with its score, though GitHub\'s item list still runs behind', async () => {
  const s = liveWorld();
  const before = await s.loader.load();
  assert.equal(before.ok, true);
  const res = await s.h.action('score', { method: 'POST', url: '/actions/score', headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' } }, {
    token: s.guard.formToken('score', `move:${TODAY}:score`), id: 'move', date: TODAY, score: '7',
  });
  assert.equal(res.status, 303);
  assert.deepEqual(s.sent.map((c) => c[0]), ['create', 'patch', 'add', 'setNumber']);

  const after = await s.loader.load();
  assert.equal(after.ok, true);
  const row = after.bundle.raw.projects.find((p) => p.role === 'habits');
  const held = row.items.find((i) => i.number === 900);
  assert.ok(held, 'the new check-in is an item of the Habits Project');
  assert.equal(held.score, 7);
  const b = board({ raw: after.bundle.raw, settings: after.bundle.settings, state: after.bundle.state });
  const move = b.habits.find((h) => h.id === 'move');
  assert.equal(move.score.today, 7, 'the habit shows today\'s score');
});
