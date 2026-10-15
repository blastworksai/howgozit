import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GitHubError } from '../board/github/http.mjs';
import { BackendError, assertAdapter } from '../board/model/adapter.mjs';
import { configHttp, verbsFromGh, createGithubAdapter } from '../board/github/adapter.mjs';

function fake(opts = {}) {
  const calls = [];
  const gh = {
    createIssue: async (a) => { calls.push(['createIssue', a]); return { number: 99 }; },
    patchIssue: async (n, p) => { calls.push(['patchIssue', n, p]); },
    addProjectItem: async (a) => {
      calls.push(['addProjectItem', a]);
      if (opts.addFails) throw opts.addFails;
    },
  };
  return { calls, gh, verbs: verbsFromGh(gh) };
}
const CLOSE = { state: 'closed', state_reason: 'completed' };

test('U GitHubError keeps its name and messages and gains a code', () => {
  const cases = [
    ['auth', 401, 'GitHub did not accept the token.', 'auth'],
    ['not-found', 404, 'GitHub could not find that address.', 'not-found'],
    ['invalid', 422, 'GitHub did not accept that request.', 'conflict'],
    ['rate-limit', 429, 'GitHub is limiting requests right now; try again later.', 'rate-limited'],
    ['server', 503, 'GitHub had a problem answering.', 'unavailable'],
  ];
  for (const [kind, status, message, code] of cases) {
    const e = new GitHubError(kind, status);
    assert.equal(e.name, 'GitHubError');
    assert.equal(e.kind, kind);
    assert.equal(e.status, status);
    assert.equal(e.message, message);
    assert.equal(e.code, code);
    assert.ok(e instanceof BackendError);
    assert.ok(e instanceof Error);
  }
  assert.equal(new GitHubError('rate-limit', 403).code, 'rate-limited');
  assert.equal(new GitHubError('auth', 403).code, 'auth');
});

test('R57 setCheckin sends the same requests as the tick action did', async () => {
  let f = fake();
  await f.verbs.setCheckin({ habitTitle: 'Walk', habitLabel: 'habit:walk', date: '2026-10-14', on: true, existing: [] });
  assert.deepEqual(f.calls, [
    ['createIssue', { title: 'Walk · 2026-10-14', labels: ['habit:walk'] }],
    ['patchIssue', 99, CLOSE],
  ]);
  f = fake();
  const r = await f.verbs.setCheckin({ habitTitle: 'Walk', habitLabel: 'habit:walk', date: 'd', on: true, existing: [{ number: 3, state: 'open' }, { number: 4, state: 'closed' }, { number: 5, state: 'open' }] });
  assert.deepEqual(f.calls, [['patchIssue', 3, CLOSE], ['patchIssue', 5, CLOSE]]);
  assert.deepEqual(r, { cards: [], items: [] });
  f = fake();
  await f.verbs.setCheckin({ habitTitle: 'Walk', habitLabel: 'x', date: 'd', on: true, existing: [{ number: 4, state: 'closed' }] });
  assert.deepEqual(f.calls, []);
});

test('R58 setCheckin untick reopens every closed check-in', async () => {
  const f = fake();
  await f.verbs.setCheckin({ habitTitle: 'Walk', habitLabel: 'x', date: 'd', on: false, existing: [{ number: 3, state: 'open' }, { number: 4, state: 'closed' }, { number: 6, state: 'closed' }] });
  assert.deepEqual(f.calls, [['patchIssue', 4, { state: 'open' }], ['patchIssue', 6, { state: 'open' }]]);
});

test('R59 fileIdea keeps the order add, milestone, labels and treats 422 as done', async () => {
  const steps = [];
  const step = (s) => steps.push(s);
  let f = fake();
  await f.verbs.fileIdea({ number: 7, projectNumber: 2, needAdd: true, milestone: 5, labels: ['a'], step });
  assert.deepEqual(f.calls, [
    ['addProjectItem', { projectNumber: 2, issueNumber: 7 }],
    ['patchIssue', 7, { milestone: 5 }],
    ['patchIssue', 7, { labels: ['a'] }],
  ]);
  assert.deepEqual(steps, ['adding it to the project', 'setting the milestone', 'removing the idea label']);
  f = fake({ addFails: new GitHubError('invalid', 422) });
  await f.verbs.fileIdea({ number: 7, projectNumber: 2, needAdd: true, milestone: null, labels: [], step });
  assert.deepEqual(f.calls, [['addProjectItem', { projectNumber: 2, issueNumber: 7 }], ['patchIssue', 7, { labels: [] }]]);
  f = fake({ addFails: new GitHubError('server', 503) });
  await assert.rejects(f.verbs.fileIdea({ number: 7, projectNumber: 2, needAdd: true, milestone: null, labels: [], step }), { status: 503 });
  f = fake();
  await f.verbs.fileIdea({ number: 7, projectNumber: 2, needAdd: false, milestone: null, labels: ['b'], step });
  assert.deepEqual(f.calls, [['patchIssue', 7, { labels: ['b'] }]]);
});

test('R61 closeCard closes with reason completed', async () => {
  const f = fake();
  assert.deepEqual(await f.verbs.closeCard({ number: 12 }), { cards: [], items: [] });
  assert.deepEqual(f.calls, [['patchIssue', 12, CLOSE]]);
});

test('U logIdea creates the issue', async () => {
  const f = fake();
  await f.verbs.logIdea({ title: 'T', labels: ['idea'] });
  assert.deepEqual(f.calls, [['createIssue', { title: 'T', labels: ['idea'] }]]);
});

test('R72 configHttp reads settings from the config folder', async () => {
  const seen = [];
  const http = { get: async (p) => { seen.push(['get', p]); return { status: 200, json: 'gh' }; }, paged: async (p) => { seen.push(['paged', p]); return 'pg'; } };
  const reads = [];
  const readFile = async (p) => {
    reads.push(p);
    if (p.endsWith('theme.json')) { const e = new Error('no'); e.code = 'ENOENT'; throw e; }
    return '{"a":1}';
  };
  const h = configHttp(http, { configDir: '/cfg', readFile });
  const r = await h.get('/repos/o/r/contents/board.config.json');
  assert.deepEqual(reads, [path.join('/cfg', 'board.config.json')]);
  assert.equal(Buffer.from(r.json.content, 'base64').toString(), '{"a":1}');
  assert.equal(r.json.encoding, 'base64');
  await assert.rejects(h.get('/repos/o/r/contents/theme.json'), (e) => e.name === 'GitHubError' && e.kind === 'not-found' && e.status === 404);
  assert.equal((await h.get('/repos/o/r/issues')).json, 'gh');
  assert.equal((await h.get('/repos/o/r/contents/other.json')).json, 'gh');
  assert.equal(await h.paged('/x'), 'pg');
  assert.equal(configHttp(http, { configDir: '', readFile }), http);
});

test('U the GitHub adapter passes assertAdapter', () => {
  const f = fake();
  const a = createGithubAdapter({ http: {}, repo: 'o/r', configDir: null, readFile: async () => '', gh: f.gh });
  assert.equal(a.kind, 'github');
  assert.equal(assertAdapter(a), a);
});
