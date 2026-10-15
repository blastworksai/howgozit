// Board review round 1: one test per finding B2 to B11 (B1 was ruled not a defect).
// Written from reference/mapping-redesign/review-board-r1.md and the contract rules it cites (R4, R6, R37, R38, R56, R59, R70, R72),
// never from the fixed code. Every answer is invented. Each test fails on the code before its fix, for the reason the finding names.
// Names are "U B<n> ...". B2 and B7 drive the reader over a fake http; B3, B4, B5, B8 to B11 drive the actions over a stateful
// fake gh; B6 drives the real handlers and the real Notion adapter over the stand-in Notion.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NOW, settings, project, milestone, task, idea, raw, state, resetNumbers, board } from '../fixtures/build.mjs';
import { readAll } from '../board/github/read.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { logIdea, setHabit, sortIdea } from '../board/actions.mjs';
import { verbsFromGh } from '../board/github/adapter.mjs';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { createGuard } from '../board/guard.mjs';
import { createHandlers } from '../board/handlers.mjs';
import { createLoader } from '../board/load.mjs';

const DATA = 'sam-life/life';
const DATA_OWNER = 'sam-life';
const TODAY = '2026-10-12';
const CLOSE = { state: 'closed', state_reason: 'completed' };
const CLOSE_NP = { state: 'closed', state_reason: 'not_planned' };

// ====================================================================== B2 (R72) the reader

const R = `/repos/${DATA}`;
const FIELDS = [
  { id: 100, name: 'Title', data_type: 'title' },
  { id: 101, name: 'Status', data_type: 'single_select' },
  { id: 102, name: 'Due', data_type: 'date' },
];
const b64 = (text) => ({ name: 'file', type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });
const apiIssue = (repoFull, number, extra = {}) => ({
  id: number * 10, number, title: `Task ${number}`, state: 'open', state_reason: null, labels: [], milestone: null, comments: 0,
  created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
  html_url: `https://github.com/${repoFull}/issues/${number}`, repository: { full_name: repoFull }, ...extra,
});
const issueItem = (repoFull, number, extra = {}) => ({
  id: number, content_type: 'Issue', content: apiIssue(repoFull, number, extra),
  fields: [{ id: 101, name: 'Status', data_type: 'single_select', value: { id: 'a', name: { raw: 'Todo', html: 'Todo' }, color: 'GREEN' } }, { id: 102, name: 'Due', data_type: 'date', value: null }],
});

// A fake http for the reader: the data repo (owner sam-life), owners a-org and b-org, a home repo `shared/home` with the given privacy.
function readerWorld({ settingsObj, homePrivate = true, items = {} }) {
  const w = { calls: [], homePrivate };
  const answer = (p) => {
    w.calls.push(p);
    if (p === R) return { private: true, default_branch: 'main', owner: { login: DATA_OWNER, type: 'Organization' } };
    if (p === `${R}/contents/board.config.json`) return b64(JSON.stringify(settingsObj));
    if (p.startsWith(`${R}/contents/`)) throw new GitHubError('not-found', 404, `Nothing is stored at ${p}.`);
    if (p.startsWith(`${R}/issues?`)) return { items: [apiIssue(DATA, 12)], partial: false };
    if (p.startsWith(`${R}/milestones?`)) return { items: [], partial: false };
    let m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p);
    if (m) return { private: w.homePrivate, owner: { login: m[1].split('/')[0], type: 'Organization' } };
    if (/^\/repos\/[^/]+\/[^/]+\/milestones\?/.test(p)) return { items: [], partial: false };
    m = /^\/users\/([^/]+)$/.exec(p);
    if (m) return { login: m[1], type: 'Organization' };
    m = /^\/(?:orgs|users)\/([^/]+)\/projectsV2\?/.exec(p);
    if (m) return { items: [{ number: 3, title: `Project of ${m[1]}`, state: 'open' }], partial: false };
    m = /^\/(?:orgs|users)\/([^/]+)\/projectsV2\/(\d+)\/fields\?/.exec(p);
    if (m) return { items: FIELDS, partial: false };
    m = /^\/(?:orgs|users)\/([^/]+)\/projectsV2\/(\d+)\/items\?/.exec(p);
    if (m) {
      const v = items[m[1]] || [];
      return { items: typeof v === 'function' ? v() : v, partial: false };
    }
    throw new GitHubError('not-found', 404, `Nothing is stored at ${p}.`);
  };
  w.http = {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
  w.down = (owners) => (login) => {
    if (!owners.includes(String(login).toLowerCase())) return w.http;
    const dead = async () => { throw new GitHubError('server', 503, 'GitHub is not answering right now.'); };
    return { get: dead, paged: dead };
  };
  return w;
}

test('U B2 a failing owner listed first does not hide that its home, shared with a later owner\'s project, is public', async () => {
  const HOME = 'shared/home';
  const w = readerWorld({
    homePrivate: false,
    settingsObj: {
      version: 1, timezone: 'UTC',
      projects: [{ key: 'bravo', number: 3, owner: 'b-org', home: HOME }, { key: 'alpha', number: 3, owner: 'a-org', home: HOME }],
    },
  });
  const { raw: out } = await readAll(w.http, { repo: DATA, full: true, now: '2026-10-12T06:10:00Z', httpFor: w.down(['b-org']) });
  const b = out.owners.find((o) => o.owner === 'b-org');
  assert.equal(b && b.ok, false, 'owner b did fail, as the scenario needs');
  const home = (out.repos || []).find((r) => r.role === 'home' && r.repo.toLowerCase() === HOME);
  assert.ok(home, 'the shared home\'s privacy was read although its first listed owner failed');
  assert.equal(home.private, false, 'and it is public, so the board stops with the public-repository notice');
});

// ====================================================================== B7 (R70) the reader, delta

test('U B7 a closed home card held after a write stays closed when a delta read\'s item content is older and still open', async () => {
  const HOME = 'sam-life/x';
  const settingsObj = { version: 1, timezone: 'UTC', projects: [{ key: 'house', number: 3, home: HOME }] };
  const w = readerWorld({ settingsObj, items: { 'sam-life': [issueItem(HOME, 5, { title: 'Sand the floor', state: 'open', updated_at: '2026-10-01T08:00:00Z' })] } });
  const read = (args) => readAll(w.http, { repo: DATA, now: '2026-10-12T06:10:00Z', fieldCache: new Map(), ...args });
  const first = await read({ full: true });
  const row = first.raw.issues.find((i) => i.ref === `${HOME}#5`);
  assert.ok(row && row.state === 'open', 'the home card is open at the first read');

  // The board closed it and holds the written row (R70): newer than the item content GitHub still serves.
  const held = structuredClone(first.raw);
  const h = held.issues.find((i) => i.ref === `${HOME}#5`);
  h.state = 'closed';
  h.state_reason = 'completed';
  h.closed_at = '2026-10-12T06:07:00Z';
  h.updated_at = '2026-10-12T06:07:00Z';

  const second = await read({ full: false, since: '2026-10-12T06:05:00Z', previous: held });
  const after = second.raw.issues.filter((i) => i.ref === `${HOME}#5`);
  assert.equal(after.length, 1);
  assert.equal(after[0].state, 'closed', 'older item content does not undo the written row');

  // control: item content that is newer wins
  const w2 = readerWorld({ settingsObj, items: { 'sam-life': [issueItem(HOME, 5, { state: 'open', updated_at: '2026-10-12T06:09:00Z' })] } });
  const third = await readAll(w2.http, { repo: DATA, now: '2026-10-12T06:10:00Z', fieldCache: new Map(), full: false, since: '2026-10-12T06:05:00Z', previous: held });
  assert.equal(third.raw.issues.find((i) => i.ref === `${HOME}#5`).state, 'open', 'newer item content replaces the held row');
});

// ====================================================================== the recording / stateful gh

function ghError(status = 500, message = 'GitHub is not answering right now.') {
  return new GitHubError(status >= 300 && status < 400 ? 'server' : status === 500 ? 'server' : 'invalid', status, message);
}

// A stateful gh. Issues of the data repo and of homes live in `issues` (key "repo#n"). Comments live in `thread`.
// failOn(entry) returns false, true (500) or a status. It is called after the call is recorded.
function fakeGh({ failOn = null, issues = {}, comments = {}, projectItems = [] } = {}) {
  const calls = [];
  const thread = structuredClone(comments);
  const store = new Map(Object.entries(structuredClone(issues)));
  const numbers = { [DATA]: 900 };
  const rec = (entry) => {
    calls.push(entry);
    const f = failOn ? failOn(entry) : false;
    if (f) throw ghError(typeof f === 'number' ? f : 500);
  };
  const inRepo = (repo) => [...store.entries()].filter(([k]) => k.toLowerCase().startsWith(`${repo.toLowerCase()}#`)).map(([, v]) => structuredClone(v));
  const gh = {
    repo: DATA,
    async createIssue({ title, labels }) {
      rec(['create', { title, labels }]);
      const n = numbers[DATA]++;
      const made = { number: n, title, labels: labels.map((name) => ({ name })), state: 'open', body: null, created_at: NOW, html_url: `https://github.com/${DATA}/issues/${n}` };
      store.set(`${DATA}#${n}`, made);
      return structuredClone(made);
    },
    async createIssueIn(repo, a) {
      rec(['createIn', repo, a]);
      numbers[repo] ??= 20;
      const n = numbers[repo]++;
      const made = { number: n, title: a.title, body: a.body, labels: (a.labels || []).map((name) => ({ name })), state: 'open', created_at: NOW, html_url: `https://github.com/${repo}/issues/${n}` };
      store.set(`${repo}#${n}`, made);
      return structuredClone(made);
    },
    async patchIssue(n, p) { rec(['patch', DATA, n, p]); return { number: n, ...p }; },
    async patchIssueIn(repo, n, p) { rec(['patch', repo, n, p]); return { number: n, ...p }; },
    async getIssueIn(repo, n) {
      rec(['getIssue', repo, n]);
      const got = store.get(`${repo}#${n}`);
      if (got) return { node_id: `I_${repo}#${n}`, ...structuredClone(got) };
      return { number: n, node_id: `I_${repo}#${n}`, title: 'Shelves', state: 'open', labels: [], milestone: null, body: null, html_url: `https://github.com/${repo}/issues/${n}` };
    },
    async getRepo(repo) { rec(['getRepo', repo]); return { node_id: `R_${repo}`, full_name: repo }; },
    async transferIssue(a) { rec(['transfer', a]); return { transferIssue: { issue: { number: 7, repositoryNameWithOwner: 'x' } }, issue: { number: 7 }, number: 7 }; },
    async listComments(repo, n) { rec(['listComments', repo, n]); return structuredClone(thread[`${repo}#${n}`] ?? []); },
    async addComment(repo, n, body) { rec(['addComment', repo, n, body]); (thread[`${repo}#${n}`] ??= []).push({ body }); return { body }; },
    async addProjectItem(a) { rec(['add', a]); return { id: 8001 }; },
    async deleteProjectItem(a) { rec(['delete', a]); return null; },
    async setItemNumber(a) { rec(['setNumber', a]); return {}; },
    // The two reading verbs the fixed adapter needs (names as the review's builders gave them): open issues of a repo, and a Project's items.
    async listIssuesIn(repo, opts) { rec(['listIssues', repo, opts]); return inRepo(repo).filter((i) => i.state === 'open'); },
    async listProjectIssues(p) { rec(['listProject', p]); return structuredClone(projectItems); },
    noteIssue() {},
    noteRemoved() {},
  };
  return { gh, calls, thread, store };
}
const kinds = (calls) => calls.map((c) => c[0]);

// ====================================================================== B3 (R59) sort sends the target project's owner

test('U B3 two owners both with a Project number 3: a data-repo idea sorted into owner b\'s project (no home, no ideas) is added to owner b\'s', async () => {
  resetNumbers();
  const w = {
    raw: raw({
      issues: [idea({ number: 41, title: 'Shelves' })],
      projects: [
        project(3, 'Alpha House', [], { owner: 'a-org', ownerType: 'organization' }),
        project(3, 'Bravo Garden', [], { owner: 'b-org', ownerType: 'user' }),
      ],
    }),
    settings: settings({ projects: [{ key: 'alpha', number: 3, owner: 'a-org' }, { key: 'bravo', number: 3, owner: 'b-org' }] }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
  const { gh, calls } = fakeGh();
  const res = await sortIdea(w, { number: '41', project: 'bravo' }, verbsFromGh(gh, DATA), NOW);
  assert.deepEqual(res, { ok: true });
  const adds = calls.filter((c) => c[0] === 'add');
  assert.equal(adds.length, 1);
  assert.equal(adds[0][1].projectNumber, 3);
  assert.equal(adds[0][1].issueNumber, 41);
  assert.equal(adds[0][1].owner, 'b-org', 'the add names the project\'s owner, not the data repo\'s');
  assert.equal(adds[0][1].ownerType, 'user');
});

// ====================================================================== B4 (R37, R38) a check-in is a data-repo issue only

test('U B4 a home-repo card with today\'s habit label is no check-in: ticking never patches data-repo #5', async () => {
  resetNumbers();
  const HOME = 'a/home';
  const homeCard = task({
    number: 5, repo: HOME, ref: `${HOME}#5`, title: `Move · ${TODAY}`, labels: ['habit:move'],
    created_at: `${TODAY}T05:00:00Z`, updated_at: `${TODAY}T05:00:00Z`, html_url: `https://github.com/${HOME}/issues/5`,
  });
  const dataFive = task({ number: 5, title: 'Paint the door' });
  const w = {
    raw: raw({ issues: [dataFive, homeCard], projects: [project(3, 'House', [{ repo: HOME, number: 5 }])] }),
    settings: settings({ projects: [{ key: 'house', number: 3, home: HOME }], habits: [{ id: 'move', title: 'Move', start: '2026-10-01' }] }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
  const { gh, calls } = fakeGh();
  const res = await setHabit(w, { id: 'move', date: TODAY, on: true }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.ok(!calls.some((c) => (c[0] === 'patch' && c[2] === 5) || (c[0] === 'patch' && c[1] === HOME)), 'neither data-repo #5 nor the home card was patched');
  assert.deepEqual(calls, [
    ['create', { title: `Move · ${TODAY}`, labels: ['habit:move'] }],
    ['patch', DATA, 900, CLOSE],
  ], 'with no check-in today a new one is created and closed');
});

// ====================================================================== B5 (CP6) a numbered proposal matches a data-repo idea only

test('U B5 a proposal for 5 attaches to the data-repo idea #5 and not to the home idea b/home#5', () => {
  resetNumbers();
  const HOME = 'b/home';
  const homeIdea = task({
    number: 5, repo: HOME, ref: `${HOME}#5`, title: 'Hooks by the door', labels: ['idea'],
    html_url: `https://github.com/${HOME}/issues/5`,
  });
  const dataIdea = idea({ number: 5, title: 'Shelves for the hall' });
  const b = board({
    settings: settings({ projects: [{ key: 'house', number: 3 }, { key: 'garden', number: 4, home: HOME }] }),
    raw: raw({
      issues: [dataIdea, homeIdea],
      projects: [project(3, 'House'), project(4, 'Garden', [{ repo: HOME, number: 5 }])],
      milestones: [milestone(5, 'House · Hallway', '2026-10-20')],
    }),
    state: state({ proposals: { updated: '2026-10-12T04:10:00Z', focus: null, ideas: [{ number: 5, project: 'house', milestone: 5, newProject: null, why: 'Same room' }] } }),
  });
  const items = b.ideas?.items ?? [];
  const data = items.find((i) => i.title === 'Shelves for the hall');
  const home = items.find((i) => i.title === 'Hooks by the door');
  assert.ok(data, 'the data-repo idea is listed');
  assert.ok(data.suggestion, 'and carries the suggestion');
  if (home) assert.ok(!home.suggestion, 'the home idea carries none');
  assert.equal(items.filter((i) => i.suggestion).length, 1, 'exactly one idea carries the suggestion');
});

// ====================================================================== B6 (CP9) Notion fileIdea never adopts a Card by title

const TOKEN = 'ntn_SENTINEL_token_4711';
const FORM_KEY = 'f'.repeat(16) + 'ORM-KEY-SENTINEL-' + 'z'.repeat(8);
const HOST = 'localhost:8787';
const CONFIG = '/srv/board-config';
const PROJECTS = '1000000000000000000000000000000a';
const CARDS = '1000000000000000000000000000000b';
const GOALS = '1000000000000000000000000000000c';
const IDEAS = '1000000000000000000000000000000d';
const HABITS = '1000000000000000000000000000000e';
const dashed = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const pid = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P_HOUSE = pid(1);
const G_HALL = pid(2);
const C_OLD = pid(10);
const I_SHELVES = pid(20);

const SCHEMA = {
  [PROJECTS]: { properties: { Name: { type: 'title' }, ID: { type: 'unique_id' } } },
  [CARDS]: {
    properties: {
      Name: { type: 'title' }, ID: { type: 'unique_id' },
      Status: {
        type: 'status',
        options: [{ name: 'Not started' }, { name: 'In progress' }, { name: 'Done' }],
        groups: [{ name: 'To-do', option_ids: ['Not started'] }, { name: 'In progress', option_ids: ['In progress'] }, { name: 'Complete', option_ids: ['Done'] }],
      },
      Project: { type: 'relation', data_source_id: PROJECTS },
      Goal: { type: 'relation', data_source_id: GOALS },
      'Blocked by': { type: 'relation', data_source_id: CARDS },
      Mode: { type: 'select', options: [{ name: 'DO', color: 'green' }] },
      Due: { type: 'date' },
    },
  },
  [GOALS]: { properties: { Name: { type: 'title' }, ID: { type: 'unique_id' }, Project: { type: 'relation', data_source_id: PROJECTS }, Due: { type: 'date' }, Done: { type: 'checkbox' } } },
  [IDEAS]: { properties: { Name: { type: 'title' }, ID: { type: 'unique_id' }, Filed: { type: 'checkbox' } } },
  [HABITS]: {
    properties: {
      Name: { type: 'title' }, ID: { type: 'unique_id' }, Habit: { type: 'select', options: [{ name: 'move' }] },
      Date: { type: 'date' }, Done: { type: 'checkbox' }, Score: { type: 'number' },
    },
  },
};

test('U B6 filing an idea on Notion creates a new Card even when an open Card in the same Project has the same title, and leaves that Card\'s Goal alone', async () => {
  const fake = createFakeNotion({ token: TOKEN, dataSources: SCHEMA });
  fake.addPage(PROJECTS, { Name: 'House', ID: 3 }, { id: P_HOUSE });
  fake.addPage(GOALS, { Name: 'Hallway', ID: 1, Project: [P_HOUSE], Due: '2026-10-20' }, { id: G_HALL });
  // An older, unrelated Card that happens to carry the idea's title: open, in the project, with no goal.
  fake.addPage(CARDS, { Name: 'Shelves for the hall', ID: 7, Status: 'Not started', Project: [P_HOUSE] }, { id: C_OLD });
  fake.addPage(IDEAS, { Name: 'Shelves for the hall', ID: 1, Filed: false }, { id: I_SHELVES });

  const cfg = settings({
    projects: [{ key: 'house', number: 3 }],
    habits: [{ id: 'move', title: 'Move', start: '2026-10-01' }],
    habitsProject: { owner: 'notion', number: 1 },
    notion: { projects: PROJECTS, cards: CARDS, goals: GOALS, ideas: IDEAS, habitLog: HABITS },
  });
  const http = createNotionHttp({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  const files = { 'board.config.json': JSON.stringify(cfg) };
  const readFile = async (p) => {
    const prefix = path.join(CONFIG, 'x').slice(0, -1);
    const name = String(p).startsWith(prefix) ? String(p).slice(prefix.length).replaceAll('\\', '/') : String(p);
    if (name in files) return files[name];
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  };
  const adapter = createNotionAdapter({ http, configDir: CONFIG, readFile });
  const clock = { now: () => Date.parse(NOW) };
  const env = { backend: 'notion', repo: 'notion', readOnly: false, configDir: CONFIG };
  const cache = { readLastGood: async () => null, writeLastGood: async () => {}, etags: new Map() };
  const loader = createLoader({ env, cache, clock, adapter });
  const guard = createGuard({ formKey: FORM_KEY, allowedHosts: [HOST], identityHeader: null, clock });
  const h = createHandlers({ loader, gh: null, guard, env, clock, verbsFor: () => adapter });
  const req = { method: 'POST', url: '/actions/sort', headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' } };

  const res = await h.action('sort', req, { token: guard.formToken('sort', '1'), number: '1', target: 'house/1' });
  assert.equal(res.status, 303, 'the sort went through');
  const ds = fake.state.dataSources[dashed(CARDS)];
  const live = ds.pages.filter((p) => !p.trashed);
  assert.equal(live.length, 2, 'a new Card was made beside the old one');
  const old = live.find((p) => p.id === C_OLD);
  assert.ok(!old.values.Goal || old.values.Goal.length === 0, 'the old Card\'s Goal is unchanged');
  const made = live.find((p) => p.id !== C_OLD);
  assert.deepEqual(made.values.Goal, [G_HALL], 'the new Card carries the goal chosen in the sort');
  assert.equal(fake.state.dataSources[dashed(IDEAS)].pages.find((p) => p.id === I_SHELVES).values.Filed, true, 'the idea is filed');
});

// ====================================================================== B8 (R59) an original that answers "moved"

const HOME_SAME = 'sam-life/house';
const HOME_OTHER = 'other-org/house';
const ALREADY_MOVED = 'This idea was already moved to its project\'s repository; reload the board and sort it from there.';

function sortWorld({ home }) {
  resetNumbers();
  return {
    raw: raw({
      issues: [task({ number: 41, title: 'Shelves', labels: ['home', 'idea'] })],
      projects: [project(3, 'House')],
      milestones: [milestone(12, 'House · Hallway', '2026-10-20', { repo: home })],
    }),
    settings: settings({ projects: [{ key: 'house', number: 3, home }] }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
}

test('U B8 a same-owner sort whose original answers moved (3xx) stops with the one plain sentence and makes no second transfer', async () => {
  const MOVED = 'GitHub sent the request somewhere else, and the board did not follow.';
  const { gh, calls } = fakeGh({ failOn: (e) => (e[0] === 'getIssue' && e[1] === DATA && e[2] === 41 ? 301 : false) });
  const orig = gh.getIssueIn;
  gh.getIssueIn = async (repo, n) => {
    try { return await orig(repo, n); } catch (e) { throw new GitHubError('server', 301, MOVED); }
  };
  const res = await sortIdea(sortWorld({ home: HOME_SAME }), { number: '41', project: 'house' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, false);
  assert.ok(res.message.includes(ALREADY_MOVED), `the answer holds the B8 sentence, got: ${res.message}`);
  assert.ok(!kinds(calls).includes('transfer'), 'no transfer');
  assert.ok(!kinds(calls).includes('add'), 'nothing after the failed fetch');
});

// ====================================================================== B9 + B10 (R59) the copy is found by its marker

const MARKER = `<!-- howgozit-moved-from: ${DATA}#41 -->`;

test('U B9 a cross-owner copy whose Moved-to comment failed is found again by its body marker: a re-post makes no second copy', async () => {
  const g = fakeGh({ failOn: (e) => e[0] === 'addComment' });
  const w = sortWorld({ home: HOME_OTHER });
  const first = await sortIdea(w, { number: '41', project: 'house' }, verbsFromGh(g.gh, DATA), NOW);
  assert.equal(first.ok, false, 'the comment failed, so the first post failed');
  const copies = g.calls.filter((c) => c[0] === 'createIn');
  assert.equal(copies.length, 1);
  assert.equal(copies[0][2].body.trimEnd().split('\n').pop(), MARKER, 'the marker is the last line of the copy\'s body');

  // the comment endpoint works on the re-post
  const before = g.calls.length;
  g.gh.addComment = async (repo, n, body) => { g.calls.push(['addComment', repo, n, body]); (g.thread[`${repo}#${n}`] ??= []).push({ body }); return { body }; };
  const again = await sortIdea(w, { number: '41', project: 'house' }, verbsFromGh(g.gh, DATA), NOW);
  assert.equal(again.ok, true);
  assert.equal(g.calls.filter((c) => c[0] === 'createIn').length, 1, 'still one copy in all');
  const second = g.calls.slice(before);
  assert.ok(!second.some((c) => c[0] === 'createIn'), 'no copy on the re-post');
  const add = second.find((c) => c[0] === 'add');
  assert.ok(add && add[1].issueNumber === 20 && add[1].repo === HOME_OTHER, 'the add is of the existing copy');
});

test('U B10 a Moved-to comment naming an issue without this original\'s marker is not trusted: a proper copy is made', async () => {
  const stranger = { number: 9, title: 'Something else', body: 'A different issue.', labels: [], state: 'open', created_at: NOW, html_url: `https://github.com/${HOME_OTHER}/issues/9` };
  const g = fakeGh({
    issues: { [`${HOME_OTHER}#9`]: stranger },
    comments: { [`${DATA}#41`]: [{ body: `Moved to ${HOME_OTHER}#9: https://github.com/${HOME_OTHER}/issues/9` }] },
  });
  const res = await sortIdea(sortWorld({ home: HOME_OTHER }), { number: '41', project: 'house' }, verbsFromGh(g.gh, DATA), NOW);
  assert.equal(res.ok, true);
  const copies = g.calls.filter((c) => c[0] === 'createIn');
  assert.equal(copies.length, 1, 'a proper copy was made');
  assert.equal(copies[0][2].body.trimEnd().split('\n').pop(), MARKER);
  const add = g.calls.find((c) => c[0] === 'add');
  assert.notEqual(add[1].issueNumber, 9, 'the stranger issue #9 is not the one added to the project');
});

// ====================================================================== B11 (R56) the Ideas add failed after the issue was created

test('U B11 with settings.ideas, an Ideas add that failed after the issue was created: the re-post makes no second issue and the first joins the Ideas Project', async () => {
  resetNumbers();
  const w = {
    raw: raw({
      issues: [],
      projects: [project(3, 'House'), project(9, 'Ideas', [], { role: 'ideas', owner: DATA_OWNER, ownerType: 'organization' })],
    }),
    settings: settings({ projects: [{ key: 'house', number: 3 }], ideas: { owner: DATA_OWNER, number: 9 } }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
  const g = fakeGh({ failOn: (e) => e[0] === 'add' });
  const first = await logIdea(w, { title: 'Shelves for the hall' }, verbsFromGh(g.gh, DATA), NOW);
  assert.equal(first.ok, false, 'the Ideas add failed');
  assert.equal(g.calls.filter((c) => c[0] === 'create').length, 1);

  const before = g.calls.length;
  g.gh.addProjectItem = async (a) => { g.calls.push(['add', a]); return { id: 8001 }; };
  const again = await logIdea(w, { title: 'Shelves for the hall' }, verbsFromGh(g.gh, DATA), NOW);
  assert.equal(again.ok, true);
  assert.equal(g.calls.filter((c) => c[0] === 'create').length, 1, 'no second issue');
  const added = g.calls.slice(before).filter((c) => c[0] === 'add');
  assert.equal(added.length, 1);
  assert.equal(added[0][1].issueNumber, 900, 'the first issue joined the Ideas Project');
  assert.equal(added[0][1].projectNumber, 9);
});
