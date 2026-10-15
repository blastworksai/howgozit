// Review follow-ups: R55 (two posts of one form token at the same moment are one write)
// and R59 (an add answered 422 counts as done; any other failed add stops the sort).
// Written from references/contract.md; fake loader, real guard, recording gh, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../board/guard.mjs';
import { createHandlers } from '../board/handlers.mjs';
import { sortIdea } from '../board/actions.mjs';
import { verbsFromGh } from '../board/github/adapter.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { NOW, settings, project, milestone, task, idea, raw, state, resetNumbers } from '../fixtures/build.mjs';

const HOST = 'localhost:8787';
const TODAY = '2026-10-12';
const SECRET = 'SENTINEL-TOKEN-123';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};
const issueBody = (n, title, labels) => ({
  number: n, title, labels, state: 'open', state_reason: null, created_at: NOW, updated_at: NOW, closed_at: null,
});

// A handler set whose first createIssue is held open on a deferred; later ones answer at once.
function setup() {
  resetNumbers();
  const world = {
    raw: raw({
      ownerType: 'organization',
      issues: [idea({ number: 50, title: 'Shelves' }), task({ number: 60, title: 'Paint the door' })],
      projects: [project(3, 'House', [60])],
      milestones: [milestone(5, 'House · Hallway', '2026-10-20')],
    }),
    settings: settings({
      projects: [{ key: 'house', number: 3 }],
      habits: [{ id: 'move', title: 'Move', start: '2026-10-01' }],
    }),
    state: state(),
  };
  const loader = {
    async load() {
      return {
        ok: true,
        bundle: {
          savedAt: NOW, raw: world.raw, settings: world.settings, theme: resolveTheme(null).theme,
          state: world.state, run: { stale: null, readOnly: false, warnings: [] },
        },
      };
    },
    noteWrite() {},
    fullDue() { return false; },
  };
  const first = deferred();
  const gh = {
    creates: [],
    patches: [],
    next: 900,
    async createIssue({ title, labels }) {
      gh.creates.push({ title, labels });
      if (gh.creates.length === 1) return first.promise;
      return issueBody(gh.next++, title, labels);
    },
    async patchIssue(number, patch) {
      gh.patches.push({ number, patch });
      return { ...issueBody(number, 'x', []), ...patch };
    },
    async addProjectItem() { return {}; },
  };
  const clock = { t: Date.parse(NOW), now() { return this.t; } };
  const guard = createGuard({ token: SECRET, allowedHosts: [HOST], identityHeader: null, clock });
  const env = { repo: 'sam-life/life', readOnly: false };
  const h = createHandlers({ loader, gh, guard, env, clock, random: () => 'NONCE123' });
  return { h, gh, guard, first };
}

const req = (name) => ({
  method: 'POST',
  url: `/actions/${name}`,
  headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
});
const ideaForm = (s, title = 'Shelves for the hall') => ({ token: s.guard.formToken('idea', 'new'), title });
const habitForm = (s) => ({
  token: s.guard.formToken('habit', `move:${TODAY}:on`), id: 'move', date: TODAY, on: '1',
});
const post = (s, name, form) => s.h.action(name, req(name), form);

// ---------- R55 ----------

test('R55 two simultaneous idea posts with one token write once and both answer 303', { timeout: 2000 }, async () => {
  const s = setup();
  const form = ideaForm(s);
  const a = post(s, 'idea', form);
  const b = post(s, 'idea', { ...form });
  await settle();
  s.first.resolve(issueBody(900, form.title, ['idea']));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(s.gh.creates.length, 1);
  assert.equal(ra.status, 303);
  assert.equal(rb.status, 303);
});

test('R55 two simultaneous habit ticks with one token write once and both answer 303', { timeout: 2000 }, async () => {
  const s = setup();
  const form = habitForm(s);
  const a = post(s, 'habit', form);
  const b = post(s, 'habit', { ...form });
  await settle();
  s.first.resolve(issueBody(900, 'Move · 2026-10-12', ['habit:move']));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(s.gh.creates.length, 1);
  assert.equal(ra.status, 303);
  assert.equal(rb.status, 303);
});

test('R55 a failed first write gives both simultaneous posts the same 502 and the token can be posted again', { timeout: 2000 }, async () => {
  const s = setup();
  const form = ideaForm(s);
  const a = post(s, 'idea', form);
  const b = post(s, 'idea', { ...form });
  await settle();
  s.first.reject(new GitHubError('server', 500));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(s.gh.creates.length, 1);
  assert.equal(ra.status, 502);
  assert.equal(rb.status, 502);
  const third = await post(s, 'idea', { ...form });
  assert.equal(s.gh.creates.length, 2);
  assert.equal(third.status, 303);
});

test('R55 two simultaneous idea posts with different tokens both write', { timeout: 2000 }, async () => {
  const s = setup();
  const a = post(s, 'idea', ideaForm(s, 'First idea'));
  const b = post(s, 'idea', ideaForm(s, 'Second idea'));
  await settle();
  s.first.resolve(issueBody(900, 'First idea', ['idea']));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(s.gh.creates.length, 2);
  assert.equal(ra.status, 303);
  assert.equal(rb.status, 303);
});

test('R55 the same valid post twice in a row writes once and answers 303 both times', { timeout: 2000 }, async () => {
  const s = setup();
  s.first.resolve(issueBody(900, 'Shelves for the hall', ['idea']));
  const form = ideaForm(s);
  const ra = await post(s, 'idea', form);
  const rb = await post(s, 'idea', { ...form });
  assert.equal(s.gh.creates.length, 1);
  assert.equal(ra.status, 303);
  assert.equal(rb.status, 303);
});

// ---------- R59 ----------

function recorder(addBehaviour) {
  const calls = [];
  const gh = {
    async createIssue() { calls.push(['create']); return {}; },
    async patchIssue(number, patch) { calls.push(['patch', number, patch]); return { number, ...patch }; },
    async addProjectItem(args) {
      calls.push(['add', args]);
      if (addBehaviour) throw addBehaviour();
      return {};
    },
  };
  return { gh, calls };
}
function sortWorld() {
  resetNumbers();
  return {
    raw: raw({
      issues: [idea({ number: 41, labels: ['idea', 'home'] })],
      projects: [project(3, 'House'), project(4, 'Garden')],
      milestones: [milestone(5, 'House · Hallway', '2026-10-20')],
    }),
    settings: settings({
      projects: [{ key: 'house', number: 3 }, { key: 'garden', number: 4 }],
      habits: [{ id: 'move', title: 'Move', start: '2026-10-01' }],
    }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
}
const SORT = { number: '41', project: 'house', milestone: '5' };

test('R59 an add answered 422 counts as done: the milestone and then the labels follow, and the sort succeeds', async () => {
  const { gh, calls } = recorder(() => new GitHubError('invalid', 422));
  const res = await sortIdea(sortWorld(), SORT, verbsFromGh(gh), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.slice(1), [
    ['patch', 41, { milestone: 5 }],
    ['patch', 41, { labels: ['home'] }],
  ]);
  assert.equal(calls[0][0], 'add');
});

for (const [label, make] of [
  ['500', () => new GitHubError('server', 500)],
  ['403', () => new GitHubError('auth', 403)],
  ['400', () => new GitHubError('invalid', 400)],
]) {
  test(`R59 an add answered ${label} stops the sort with a 502 naming the step and no patch follows`, async () => {
    const { gh, calls } = recorder(make);
    const res = await sortIdea(sortWorld(), SORT, verbsFromGh(gh), NOW);
    assert.equal(res.ok, false);
    assert.equal(res.status, 502);
    assert.ok(res.message.includes('adding it to the project'), res.message);
    assert.deepEqual(calls.filter((c) => c[0] !== 'add'), []);
  });
}

test('R59 an add that succeeds is followed by the milestone patch and the labels patch', async () => {
  const { gh, calls } = recorder(null);
  const res = await sortIdea(sortWorld(), SORT, verbsFromGh(gh), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'patch', 'patch']);
  assert.deepEqual(calls[1], ['patch', 41, { milestone: 5 }]);
  assert.deepEqual(calls[2], ['patch', 41, { labels: ['home'] }]);
});
