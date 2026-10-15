// Board review round 2: one test per ruling BR2-1 to BR2-5.
// Written from reference/mapping-redesign/review-board-r2.md (the lead's rulings), never from the fixed code. Every answer is invented.
// Each test fails on the code before its fix, for the reason the ruling names. Names are "U BR2-<n> ...".
// BR2-1 and BR2-2 drive the real loader and reader over a fake http; BR2-3 and BR2-4 drive the actions over a stateful fake gh;
// BR2-5 drives the real handlers and the real Notion adapter over the stand-in Notion.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NOW, settings, project, milestone, task, raw, state, resetNumbers } from '../fixtures/build.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { logIdea, sortIdea } from '../board/actions.mjs';
import { verbsFromGh, createMadeMemory } from '../board/github/adapter.mjs';
import { createLoader } from '../board/load.mjs';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { createGuard } from '../board/guard.mjs';
import { createHandlers } from '../board/handlers.mjs';

const DATA = 'sam-life/life';
const DATA_OWNER = 'sam-life';
const R = `/repos/${DATA}`;
const notFound = (p) => new GitHubError('not-found', 404, `Nothing is stored at ${p}.`);
const down = () => new GitHubError('server', 503, 'GitHub is not answering right now.');

// ====================================================================== a loader over a fake http

const apiIssue = (repoFull, number, extra = {}) => ({
  id: number * 10, number, title: `Task ${number}`, state: 'open', state_reason: null, labels: [], milestone: null, comments: 0,
  created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
  html_url: `https://github.com/${repoFull}/issues/${number}`, repository: { full_name: repoFull }, ...extra,
});

// `projects`: settings entries. `hook(path, world)` may return a value or throw to replace an answer. Project item lists are empty.
function loaderWorld({ projects, hook = null }) {
  const w = { calls: [], files: { 'board.config.json': JSON.stringify(settings({ projects })) } };
  function answer(p) {
    w.calls.push(p);
    if (hook) {
      const r = hook(p, w);
      if (r !== undefined) return r;
    }
    if (p === R) return { private: true, default_branch: 'main', owner: { login: DATA_OWNER, type: 'Organization' } };
    if (p.startsWith(`${R}/contents/`)) {
      const f = p.slice(`${R}/contents/`.length);
      if (typeof w.files[f] !== 'string') throw notFound(p);
      return { content: Buffer.from(w.files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(`${R}/issues?`)) return { items: p.includes('&since=') ? [] : [apiIssue(DATA, 1)], partial: false };
    if (/^\/repos\/[^/]+\/[^/]+\/milestones\?/.test(p)) return { items: [], partial: false };
    let m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p);
    if (m) return { private: true, owner: { login: m[1].split('/')[0], type: 'Organization' } };
    m = /^\/users\/([^/]+)$/.exec(p);
    if (m) return { login: m[1], type: 'Organization' };
    m = /^\/(?:orgs|users)\/([^/]+)\/projectsV2\?/.exec(p);
    if (m) return { items: [{ number: 3, title: `Project of ${m[1]}`, state: 'open' }], partial: false };
    if (/^\/(?:orgs|users)\/[^/]+\/projectsV2\/\d+\/fields\?/.test(p)) return { items: [{ id: 11, name: 'Status' }, { id: 12, name: 'Due' }], partial: false };
    if (/^\/(?:orgs|users)\/[^/]+\/projectsV2\/\d+\/items\?/.test(p)) return { items: [], partial: false };
    throw notFound(p);
  }
  w.http = {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
  return w;
}

function makeLoader(world, at = '2026-10-12T06:10:00Z') {
  const clock = { t: Date.parse(at), now() { return clock.t; } };
  const cache = { async readLastGood() { return null; }, async writeLastGood() {}, etags: new Map() };
  const loader = createLoader({ http: world.http, httpFor: () => world.http, env: { repo: DATA, readOnly: false, configDir: null }, cache, clock });
  return { loader, clock };
}

// ====================================================================== BR2-1 (R72) observed privacy wins over the held value

test('U BR2-1 a shared home held private, seen public in a full read by a group whose milestone request then fails, stops the board', async () => {
  const HOME = 'shared/home';
  let phase = 1;
  let privacyReads = 0;
  const w = loaderWorld({
    projects: [{ key: 'alpha', number: 3, owner: 'a-org', home: HOME }, { key: 'bravo', number: 3, owner: 'b-org', home: HOME }],
    hook: (p) => {
      if (phase !== 2) return undefined;
      if (p === `/repos/${HOME}`) {
        privacyReads += 1;
        if (privacyReads === 1) return { private: false, owner: { login: 'shared', type: 'Organization' } };
        throw down();
      }
      if (p.startsWith(`/repos/${HOME}/milestones?`)) throw down();
      return undefined;
    },
  });
  const { loader } = makeLoader(w);
  const first = await loader.load({ full: true });
  assert.equal(first.ok, true, 'while the home is private the board shows');

  phase = 2;
  const second = await loader.load({ full: true });
  assert.ok(privacyReads >= 1, 'the home\'s privacy was asked in the second read');
  assert.equal(second.ok, false, 'a home seen public during the read stops the board, whatever the held value says');
  assert.match(second.notice.title + ' ' + second.notice.message, /public/i);
  assert.ok(second.notice.message.includes(HOME), 'the notice names the home');
  assert.ok(!second.bundle, 'no board is shown');
});

// ====================================================================== BR2-2 (R70) a written home card survives a lagging Project list

test('U BR2-2 a home card written by a sort (issue noted, then its item noted, as the handlers do) shows in a delta read whose items omit it, for the pending window only', async () => {
  const HOME = 'sam-life/home';
  const w = loaderWorld({ projects: [{ key: 'house', number: 3, home: HOME }] });
  const { loader, clock } = makeLoader(w);
  const first = await loader.load({ full: true });
  assert.equal(first.ok, true);
  assert.ok(!first.bundle.raw.issues.some((i) => i.ref === `${HOME}#7`), 'the card is not there before the write');

  clock.t += 60000;
  // the handlers' real order: the issue GitHub returned, then the Project item, in two separate noteWrite calls
  loader.noteWrite({ apiIssue: apiIssue(HOME, 7, { title: 'Shelves', updated_at: '2026-10-12T06:11:00Z', created_at: '2026-10-12T06:11:00Z' }), repo: HOME });
  loader.noteWrite({ item: { projectOwner: DATA_OWNER, projectNumber: 3, issueNumber: 7, repo: HOME } });

  clock.t += 60000;
  const delta = await loader.load({ full: false });
  assert.equal(delta.ok, true);
  const rows = delta.bundle.raw.issues.filter((i) => i.ref === `${HOME}#7`);
  assert.equal(rows.length, 1, 'the written card\'s issue row is in the bundle although the Project list omits it');
  assert.equal(rows[0].title, 'Shelves');

  clock.t += 11 * 60000;
  const late = await loader.load({ full: false });
  assert.equal(late.ok, true);
  assert.ok(!late.bundle.raw.issues.some((i) => i.ref === `${HOME}#7`), 'after the pending window the card is gone');
});

// ====================================================================== a stateful gh

function ghError(status = 500) {
  return new GitHubError(status === 500 ? 'server' : 'invalid', status, 'GitHub is not answering right now.');
}

function fakeGh({ failOn = null, issues = {}, comments = {} } = {}) {
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
    async transferIssue(a) { rec(['transfer', a]); return { issue: { number: 7 }, number: 7 }; },
    async listComments(repo, n) { rec(['listComments', repo, n]); return structuredClone(thread[`${repo}#${n}`] ?? []); },
    async addComment(repo, n, body) { rec(['addComment', repo, n, body]); (thread[`${repo}#${n}`] ??= []).push({ body }); return { body }; },
    async addProjectItem(a) { rec(['add', a]); return { id: 8001 }; },
    async deleteProjectItem(a) { rec(['delete', a]); return null; },
    async setItemNumber(a) { rec(['setNumber', a]); return {}; },
    async listIssuesIn(repo, opts) { rec(['listIssues', repo, opts]); return inRepo(repo).filter((i) => i.state === 'open'); },
    async listProjectIssues(p) { rec(['listProject', p]); return []; },
    noteIssue() {},
    noteRemoved() {},
  };
  return { gh, calls, thread, store };
}

const ideasWorld = () => {
  resetNumbers();
  return {
    raw: raw({ issues: [], projects: [project(3, 'House'), project(9, 'Ideas', [], { role: 'ideas', owner: DATA_OWNER, ownerType: 'organization' })] }),
    settings: settings({ projects: [{ key: 'house', number: 3 }], ideas: { owner: DATA_OWNER, number: 9 } }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
};

// ====================================================================== BR2-3 (a) logIdea memory

test('U BR2-3 logIdea: the issue was created, the Ideas add failed, and the issue list still lags: a re-post makes no second issue', async () => {
  const title = 'Lagging list idea';
  const w = ideasWorld();
  const g = fakeGh({ failOn: (e) => e[0] === 'add' });
  g.gh.listIssuesIn = async (repo, opts) => { g.calls.push(['listIssues', repo, opts]); return []; }; // GitHub's list does not show the new issue yet
  const memory = createMadeMemory();
  const first = await logIdea(w, { title }, verbsFromGh(g.gh, DATA, memory), NOW);
  assert.equal(first.ok, false, 'the Ideas add failed');
  assert.equal(g.calls.filter((c) => c[0] === 'create').length, 1);

  const before = g.calls.length;
  g.gh.addProjectItem = async (a) => { g.calls.push(['add', a]); return { id: 8001 }; };
  const again = await logIdea(w, { title }, verbsFromGh(g.gh, DATA, memory), NOW);
  assert.equal(again.ok, true);
  assert.equal(g.calls.filter((c) => c[0] === 'create').length, 1, 'no second issue');
  const added = g.calls.slice(before).filter((c) => c[0] === 'add');
  assert.equal(added.length, 1);
  assert.equal(added[0][1].issueNumber, 900, 'the first issue joined the Ideas Project');
});

// ====================================================================== BR2-3 (b) sort move memory

test('U BR2-3 sort move: the copy was created, the linking comment failed, and the home list still lags: a re-post makes no second copy', async () => {
  const HOME_OTHER = 'other-org/house';
  resetNumbers();
  const w = {
    raw: raw({
      issues: [task({ number: 41, title: 'Shelves', labels: ['home', 'idea'] })],
      projects: [project(3, 'House')],
      milestones: [milestone(12, 'House · Hallway', '2026-10-20', { repo: HOME_OTHER })],
    }),
    settings: settings({ projects: [{ key: 'house', number: 3, home: HOME_OTHER }] }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
  const g = fakeGh({ failOn: (e) => e[0] === 'addComment' });
  g.gh.listIssuesIn = async (repo, opts) => { g.calls.push(['listIssues', repo, opts]); return []; }; // the home's list does not show the copy yet
  const memory = createMadeMemory();
  const first = await sortIdea(w, { number: '41', project: 'house' }, verbsFromGh(g.gh, DATA, memory), NOW);
  assert.equal(first.ok, false, 'the linking comment failed');
  assert.equal(g.calls.filter((c) => c[0] === 'createIn').length, 1);

  const before = g.calls.length;
  g.gh.addComment = async (repo, n, body) => { g.calls.push(['addComment', repo, n, body]); (g.thread[`${repo}#${n}`] ??= []).push({ body }); return { body }; };
  const again = await sortIdea(w, { number: '41', project: 'house' }, verbsFromGh(g.gh, DATA, memory), NOW);
  assert.equal(again.ok, true);
  assert.equal(g.calls.filter((c) => c[0] === 'createIn').length, 1, 'still one copy in all');
  const second = g.calls.slice(before);
  assert.ok(!second.some((c) => c[0] === 'createIn'), 'no copy on the re-post');
  const add = second.find((c) => c[0] === 'add');
  assert.ok(add && add[1].issueNumber === 20 && add[1].repo === HOME_OTHER, 'the add is of the existing copy');
});

// ====================================================================== BR2-4 now arrives as an ISO string

test('U BR2-4 logging a title that matches a months-old open idea issue not on the Ideas Project makes a new issue when now is an ISO string', async () => {
  const title = 'Old shelves idea';
  const w = ideasWorld();
  const g = fakeGh({
    issues: { [`${DATA}#5`]: { number: 5, title, labels: [{ name: 'idea' }], state: 'open', body: null, created_at: '2026-05-01T08:00:00Z', html_url: `https://github.com/${DATA}/issues/5` } },
  });
  const res = await logIdea(w, { title }, verbsFromGh(g.gh, DATA), NOW);
  assert.equal(typeof NOW, 'string');
  assert.equal(res.ok, true);
  assert.equal(g.calls.filter((c) => c[0] === 'create').length, 1, 'a new issue was made');
  const added = g.calls.filter((c) => c[0] === 'add');
  assert.equal(added.length, 1);
  assert.notEqual(added[0][1].issueNumber, 5, 'the months-old issue was not adopted');
  assert.equal(added[0][1].issueNumber, 900);
});

// ====================================================================== BR2-5 Notion fileIdea retry takes the retry's Project and Goal

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
const P_A = pid(1);
const P_B = pid(3);
const G_HALL = pid(2);
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

function notionSetup() {
  const fake = createFakeNotion({ token: TOKEN, dataSources: SCHEMA });
  fake.addPage(PROJECTS, { Name: 'Alpha', ID: 3 }, { id: P_A });
  fake.addPage(PROJECTS, { Name: 'Bravo', ID: 4 }, { id: P_B });
  fake.addPage(GOALS, { Name: 'Hallway', ID: 1, Project: [P_A], Due: '2026-10-20' }, { id: G_HALL });
  fake.addPage(IDEAS, { Name: 'Shelves for the hall', ID: 1, Filed: false }, { id: I_SHELVES });
  const cfg = settings({
    projects: [{ key: 'alpha', number: 3 }, { key: 'bravo', number: 4 }],
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
  const sort = (target) => h.action('sort', {
    method: 'POST', url: '/actions/sort',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
  }, { token: guard.formToken('sort', '1'), number: '1', target });
  const live = (id) => fake.state.dataSources[dashed(id)].pages.filter((p) => !p.trashed);
  return { fake, sort, live };
}

test('U BR2-5 fileIdea: the Card was made in Project A and marking the idea filed failed; the retry with Project B moves the Card to B and files the idea', async () => {
  const s = notionSetup();
  s.fake.fail((c) => c.method === 'PATCH' && c.path === '/v1/pages/' + I_SHELVES, 500);
  const first = await s.sort('alpha');
  assert.equal(first.status, 502, 'marking the idea filed failed');
  const cards = s.live(CARDS);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].values.Project, [P_A], 'the first Card is in Project A');

  const second = await s.sort('bravo');
  assert.equal(second.status, 303);
  const after = s.live(CARDS);
  assert.equal(after.length, 1, 'no second Card');
  assert.deepEqual(after[0].values.Project, [P_B], 'the Card takes the retry\'s Project');
  assert.equal(s.live(IDEAS).find((p) => p.id === I_SHELVES).values.Filed, true, 'the idea is filed');
});

test('U BR2-5 fileIdea: a retry with no goal clears the Goal the first attempt put on the Card', async () => {
  const s = notionSetup();
  s.fake.fail((c) => c.method === 'PATCH' && c.path === '/v1/pages/' + I_SHELVES, 500);
  assert.equal((await s.sort('alpha/1')).status, 502);
  assert.deepEqual(s.live(CARDS)[0].values.Goal, [G_HALL], 'the first attempt put the Card under the goal');

  assert.equal((await s.sort('bravo')).status, 303);
  const after = s.live(CARDS);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].values.Project, [P_B]);
  assert.ok(!after[0].values.Goal || after[0].values.Goal.length === 0, 'the retry named no goal, so the Card has none');
  assert.equal(s.live(IDEAS).find((p) => p.id === I_SHELVES).values.Filed, true);
});
