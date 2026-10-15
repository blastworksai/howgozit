// CP6 (SKILLS-78) job D2, ideas half: R56 and R59 with the Ideas Project, moving an idea home, and R70 holds.
// Written from the rule text (references/contract.md) and reference/mapping-redesign/cp6-interface.md sections 4b, 4c, 4f, 4h,
// never from the new code. A recording fake gh with the section 4h methods stands in for GitHub; one test runs the real
// handlers and the real loader on a fake http whose Project item lists never catch up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, settings, project, milestone, task, idea, raw, state, resetNumbers, board } from '../fixtures/build.mjs';
import { logIdea, sortIdea } from '../board/actions.mjs';
import { verbsFromGh } from '../board/github/adapter.mjs';
import { createGuard } from '../board/guard.mjs';
import { createHandlers } from '../board/handlers.mjs';
import { createLoader } from '../board/load.mjs';
import { GitHubError } from '../board/github/http.mjs';

const DATA = 'sam-life/life';
const OWNER = 'sam-life';
const HOME_SAME = 'sam-life/house';
const HOME_OTHER = 'other-org/house';
const CLOSE_NP = { state: 'closed', state_reason: 'not_planned' };

function ghError(status = 500) {
  return Object.assign(new Error('GitHub is not answering right now.'), { name: 'GitHubError', kind: status === 500 ? 'server' : 'invalid', status });
}

// A recording gh with the section 4h methods. Each call is recorded before failOn(entry) decides whether it throws.
// Patches are recorded as ['patch', repo, number, patch] whichever of patchIssue / patchIssueIn made them.
function recorder({ failOn = null, comments = {}, transferredNumber = 7, copyNumber = 3 } = {}) {
  const calls = [];
  const thread = structuredClone(comments);
  const noted = [];
  const bodies = new Map();
  let nextIssue = 900;
  const rec = (entry) => {
    calls.push(entry);
    if (failOn && failOn(entry)) throw ghError(typeof failOn(entry) === 'number' ? failOn(entry) : 500);
  };
  const gh = {
    async createIssue({ title, labels }) { rec(['create', { title, labels }]); return { number: nextIssue++, title, labels, state: 'open' }; },
    async createIssueIn(repo, a) {
      rec(['createIn', repo, a]);
      bodies.set(`${repo}#${copyNumber}`, a.body);
      return { number: copyNumber, title: a.title, labels: a.labels, state: 'open', html_url: `https://github.com/${repo}/issues/${copyNumber}` };
    },
    async patchIssue(n, p) { rec(['patch', DATA, n, p]); return { number: n, ...p }; },
    async patchIssueIn(repo, n, p) { rec(['patch', repo, n, p]); return { number: n, ...p }; },
    async getIssueIn(repo, n) {
      rec(['getIssue', repo, n]);
      return { number: n, node_id: `I_${repo}#${n}`, title: 'Shelves', state: 'open', labels: [], milestone: null, body: bodies.get(`${repo}#${n}`) ?? null, html_url: `https://github.com/${repo}/issues/${n}` };
    },
    async getRepo(repo) { rec(['getRepo', repo]); return { node_id: `R_${repo}`, full_name: repo }; },
    async transferIssue(a) {
      rec(['transfer', a]);
      const issue = { number: transferredNumber, repository: { nameWithOwner: HOME_SAME } };
      // The shape GitHub's parsed JSON takes is not fixed by the interface; answer in both readings.
      return { transferIssue: { issue }, issue, number: transferredNumber };
    },
    async listComments(repo, n) { rec(['listComments', repo, n]); return structuredClone(thread[`${repo}#${n}`] ?? []); },
    async addComment(repo, n, body) {
      rec(['addComment', repo, n, body]);
      (thread[`${repo}#${n}`] ??= []).push({ body });
      return { body };
    },
    async addProjectItem(a) { rec(['add', a]); return { id: 8001 }; },
    async deleteProjectItem(a) { rec(['delete', a]); return null; },
    async setItemNumber(a) { rec(['setNumber', a]); return {}; },
    noteIssue(repo, apiIssue) { noted.push([repo, apiIssue]); },
    noteRemoved() {},
  };
  return { gh, calls, thread, noted };
}

const kinds = (calls) => calls.map((c) => c[0]);
const addOf = (c) => ({ projectNumber: c[1].projectNumber, issueNumber: c[1].issueNumber, repo: c[1].repo ?? DATA });

// The world. House (3, shown), Garden (4, shown), the Ideas Project (9, role row). Issue 41 is an idea only by being
// an item of project 9 (R2/R135); it still carries the idea label so that any label write would show.
function world({ ideasSetting = true, roleRow = true, homeOf = null, withMilestones = true, ideaItem = true, issues = null } = {}) {
  resetNumbers();
  const ideasRow = project(9, 'Ideas', ideaItem ? [{ repo: DATA, number: 41, itemId: 555 }] : [], {
    role: 'ideas', owner: OWNER, ownerType: 'organization',
  });
  const homeMilestone = homeOf ? [milestone(12, 'House · Hallway', '2026-10-20', { repo: homeOf })] : [];
  return {
    raw: raw({
      issues: issues ?? [task({ number: 41, title: 'Shelves', labels: ['home', 'idea'] }), task({ number: 60, title: 'Paint the door' })],
      projects: [project(3, 'House'), project(4, 'Garden'), ...(roleRow ? [ideasRow] : [])],
      milestones: withMilestones
        ? [
            ...(homeOf ? homeMilestone : [milestone(5, 'House · Hallway', '2026-10-20')]),
            milestone(7, 'Garden · Beds', '2026-11-02'),
            milestone(8, 'House · Old', '2026-09-01', { state: 'closed', closed_at: '2026-09-02T10:00:00Z' }),
          ]
        : [],
    }),
    settings: settings({
      projects: [{ key: 'house', number: 3, ...(homeOf ? { home: homeOf } : {}) }, { key: 'garden', number: 4 }],
      ...(ideasSetting ? { ideas: { owner: OWNER, number: 9 } } : {}),
    }),
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
}

function assertRefusal(res, label = '') {
  assert.equal(res.ok, false, `${label} refused`);
  assert.equal(res.status, 400, `${label} status`);
  assert.ok(typeof res.message === 'string' && res.message.trim().length > 0, `${label} has a message`);
}

// ---------- R56 ----------

test('R56 with settings.ideas one create with the idea label and no body, then one add-item to the Ideas Project', async () => {
  const { gh, calls } = recorder();
  const res = await logIdea(world(), { title: '  Shelves\n for   the hall  ' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['create', 'add']);
  assert.deepEqual(calls[0], ['create', { title: 'Shelves for the hall', labels: ['idea'] }]);
  const a = calls[1][1];
  assert.equal(a.projectNumber, 9);
  assert.equal(a.issueNumber, 900);
  assert.equal(a.owner, OWNER);
  assert.equal(a.ownerType, 'organization');
  assert.equal(a.repo ?? DATA, DATA);
});

test('R56 with settings.ideas an add answered 422 counts as done', async () => {
  const { gh, calls } = recorder({ failOn: (e) => (e[0] === 'add' ? 422 : false) });
  const res = await logIdea(world(), { title: 'Shelves' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['create', 'add']);
});

test('R56 with settings.ideas but no ideas role row in the read the answer is 400 and no request is sent', async () => {
  const { gh, calls } = recorder();
  const res = await logIdea(world({ roleRow: false }), { title: 'Shelves' }, verbsFromGh(gh, DATA), NOW);
  assertRefusal(res);
  assert.match(res.message, /Ideas Project/);
  assert.deepEqual(calls, []);
});

test('R56 without settings.ideas exactly one create and nothing else', async () => {
  const { gh, calls } = recorder();
  const res = await logIdea(world({ ideasSetting: false }), { title: 'Shelves' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['create', { title: 'Shelves', labels: ['idea'] }]]);
});

// ---------- R59: with settings.ideas, no move ----------

test('R59 with settings.ideas a sort adds the item, sets the milestone, then removes the Ideas item, and writes no label', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(world(), { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh, DATA), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(kinds(calls), ['add', 'patch', 'delete']);
  assert.deepEqual(addOf(calls[0]), { projectNumber: 3, issueNumber: 41, repo: DATA });
  assert.deepEqual(calls[1], ['patch', DATA, 41, { milestone: 5 }]);
  const d = calls[2][1];
  assert.equal(d.projectNumber, 9);
  assert.equal(d.itemId, 555);
  assert.equal(d.owner, OWNER);
  assert.equal(d.ownerType, 'organization');
  assert.ok(!calls.some((c) => c[0] === 'patch' && 'labels' in c[3]), 'no label change');
});

test('R59 with settings.ideas a sort without a goal adds and removes only', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(world(), { number: '41', project: 'house' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['add', 'delete']);
});

test('R59 with settings.ideas a removal answered 404 counts as done', async () => {
  const { gh, calls } = recorder({ failOn: (e) => (e[0] === 'delete' ? 404 : false) });
  const res = await sortIdea(world(), { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['add', 'patch', 'delete']);
});

test('R59 with settings.ideas a failure at the milestone leaves the Ideas item, names the step, and a second post finishes', async () => {
  const first = recorder({ failOn: (e) => e[0] === 'patch' });
  const res = await sortIdea(world(), { number: '41', project: 'house', milestone: '5' }, verbsFromGh(first.gh, DATA), NOW);
  assert.equal(res.ok, false);
  assert.match(res.message, /milestone/);
  assert.deepEqual(kinds(first.calls), ['add', 'patch']);
  // The second post reads a world where the add has landed.
  const w = world();
  w.raw.projects[0].items.push({ type: 'Issue', repo: DATA, number: 41, status: null, due: null });
  const second = recorder();
  const again = await sortIdea(w, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(second.gh, DATA), NOW);
  assert.equal(again.ok, true);
  assert.deepEqual(kinds(second.calls), ['patch', 'delete']);
});

test('R59 with settings.ideas a goal of another project is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(world(), { number: '41', project: 'house', milestone: '7' }, verbsFromGh(gh, DATA), NOW), 'garden goal');
  assertRefusal(await sortIdea(world(), { number: '41', project: 'house', milestone: '8' }, verbsFromGh(gh, DATA), NOW), 'closed goal');
  assert.deepEqual(calls, []);
});

test('R59 with settings.ideas a goal that is a milestone of the data repo is refused for a project whose home is another repo', async () => {
  const w = world({ homeOf: HOME_SAME });
  w.raw.milestones.push(milestone(5, 'House · Hallway', '2026-10-20')); // the data repo's, not a goal of the home project
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(w, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh, DATA), NOW));
  assert.deepEqual(calls, []);
});

test('R59 with settings.ideas a card that is not an item of the Ideas Project is not an idea and is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(world(), { number: '60', project: 'house' }, verbsFromGh(gh, DATA), NOW));
  assert.deepEqual(calls, []);
});

// ---------- R59: moving home, same owner ----------

test('R59 a sort into a project whose home is under the idea\'s owner transfers the issue before the add, then acts on the home issue', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(world({ homeOf: HOME_SAME }), { number: '41', project: 'house', milestone: '12' }, verbsFromGh(gh, DATA), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(kinds(calls), ['getIssue', 'getRepo', 'transfer', 'getIssue', 'add', 'patch', 'delete']);
  assert.deepEqual(calls[0], ['getIssue', DATA, 41]);
  assert.deepEqual(calls[1], ['getRepo', HOME_SAME]);
  assert.equal(calls[2][1].owner, OWNER);
  assert.equal(calls[2][1].issueId, `I_${DATA}#41`);
  assert.equal(calls[2][1].repositoryId, `R_${HOME_SAME}`);
  assert.deepEqual(calls[3], ['getIssue', HOME_SAME, 7]);
  assert.deepEqual(addOf(calls[4]), { projectNumber: 3, issueNumber: 7, repo: HOME_SAME });
  assert.deepEqual(calls[5], ['patch', HOME_SAME, 7, { milestone: 12 }]);
  assert.equal(calls[6][1].projectNumber, 9);
  assert.equal(calls[6][1].itemId, 555, 'the removal is of the ORIGINAL idea\'s Ideas item');
  assert.ok(!calls.some((c) => c[0] === 'patch' && 'labels' in c[3]), 'no label change');
  assert.ok(!calls.some((c) => c[0] === 'patch' && c[3].state), 'a transferred issue is not closed');
  assert.ok(!calls.some((c) => c[0] === 'createIn' || c[0] === 'addComment'), 'no copy, no comment');
});

test('R59 a sort into a home project without a goal still moves the idea home', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(world({ homeOf: HOME_SAME }), { number: '41', project: 'house' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(kinds(calls), ['getIssue', 'getRepo', 'transfer', 'getIssue', 'add', 'delete']);
});

test('R59 a transfer that fails stops there: no add, no removal, and the answer names the step', async () => {
  const { gh, calls } = recorder({ failOn: (e) => e[0] === 'transfer' });
  const res = await sortIdea(world({ homeOf: HOME_SAME }), { number: '41', project: 'house', milestone: '12' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, false);
  assert.match(res.message, /moving it/);
  assert.deepEqual(kinds(calls), ['getIssue', 'getRepo', 'transfer']);
});

// ---------- R59: moving home, other owner ----------

test('R59 a sort into a project whose home is under another owner copies, comments, adds, sets the goal, removes and closes the original as not planned', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(world({ homeOf: HOME_OTHER }), { number: '41', project: 'house', milestone: '12' }, verbsFromGh(gh, DATA), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(kinds(calls), ['listComments', 'createIn', 'addComment', 'add', 'patch', 'delete', 'patch']);
  assert.deepEqual(calls[0], ['listComments', DATA, 41]);
  assert.equal(calls[1][1], HOME_OTHER);
  assert.equal(calls[1][2].title, 'Shelves');
  assert.equal(calls[1][2].body, `Moved from ${DATA}#41.\n\n<!-- howgozit-moved-from: ${DATA}#41 -->`);
  assert.deepEqual(calls[1][2].labels, ['home'], 'the original\'s labels without the idea label');
  assert.deepEqual(calls[2], ['addComment', DATA, 41, `Moved to ${HOME_OTHER}#3: https://github.com/${HOME_OTHER}/issues/3`]);
  assert.deepEqual(addOf(calls[3]), { projectNumber: 3, issueNumber: 3, repo: HOME_OTHER });
  assert.deepEqual(calls[4], ['patch', HOME_OTHER, 3, { milestone: 12 }]);
  assert.equal(calls[5][1].itemId, 555);
  assert.deepEqual(calls[6], ['patch', DATA, 41, CLOSE_NP]);
  assert.ok(!calls.some((c) => c[0] === 'transfer'), 'no transfer across owners');
});

test('R59 the same cross-owner sort posted again after a failure at the milestone finds the copy through the comment and creates no second copy', async () => {
  const r = recorder({ failOn: (e) => e[0] === 'patch' && e[1] === HOME_OTHER });
  const w = world({ homeOf: HOME_OTHER });
  const first = await sortIdea(w, { number: '41', project: 'house', milestone: '12' }, verbsFromGh(r.gh, DATA), NOW);
  assert.equal(first.ok, false);
  assert.match(first.message, /milestone/);
  assert.deepEqual(kinds(r.calls), ['listComments', 'createIn', 'addComment', 'add', 'patch']);
  const before = r.calls.length;
  r.gh.patchIssueIn = async (repo, n, p) => { r.calls.push(['patch', repo, n, p]); return { number: n, ...p }; };
  const again = await sortIdea(w, { number: '41', project: 'house', milestone: '12' }, verbsFromGh(r.gh, DATA), NOW);
  assert.equal(again.ok, true);
  const second = r.calls.slice(before);
  assert.ok(!second.some((c) => c[0] === 'createIn'), 'no second copy');
  assert.ok(!second.some((c) => c[0] === 'addComment'), 'no second comment');
  assert.deepEqual(kinds(second), ['listComments', 'getIssue', 'getIssue', 'add', 'patch', 'delete', 'patch']);
  assert.deepEqual(second[1], ['getIssue', HOME_OTHER, 3], 'the copy is fetched once before the add');
  assert.ok(r.noted.some(([repo, i]) => repo === HOME_OTHER && i.number === 3), 'and held with noteIssue');
  assert.deepEqual(second.find((c) => c[0] === 'patch' && c[1] === HOME_OTHER), ['patch', HOME_OTHER, 3, { milestone: 12 }], 'the goal lands on the existing copy #3');
  assert.deepEqual(second[second.length - 1], ['patch', DATA, 41, CLOSE_NP]);
  assert.equal(r.calls.filter((c) => c[0] === 'createIn').length, 1, 'one copy in all');
});

test('R59 a Moved-to comment for a different repo does not count as the copy', async () => {
  const { gh, calls } = recorder({ comments: { [`${DATA}#41`]: [{ body: 'Moved to someone/else#9: https://github.com/someone/else/issues/9' }] } });
  const res = await sortIdea(world({ homeOf: HOME_OTHER }), { number: '41', project: 'house' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.equal(calls.filter((c) => c[0] === 'createIn').length, 1);
});

// ---------- R59: the off path ----------

test('R59 without settings.ideas and without a home a sort sends exactly today\'s requests', async () => {
  const w = world({ ideasSetting: false, roleRow: false });
  const { gh, calls } = recorder();
  const res = await sortIdea(w, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh, DATA), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, [
    ['add', { projectNumber: 3, issueNumber: 41 }],
    ['patch', DATA, 41, { milestone: 5 }],
    ['patch', DATA, 41, { labels: ['home'] }],
  ]);
});

// ---------- R70: what the redirected load shows ----------

const HOST = 'localhost:8787';
const SECRET = 'SENTINEL-TOKEN-123';
const R = `/repos/${DATA}`;
const notFound = (p) => new GitHubError('not-found', 404, `Nothing is stored at ${p}.`);
const apiIssue = (number, extra = {}) => ({
  id: number * 10, number, title: `Item ${number}`, state: 'open', state_reason: null, labels: [], milestone: null, comments: 0,
  created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
  html_url: `https://github.com/${DATA}/issues/${number}`, ...extra,
});
const FIELDS = [
  { id: 100, name: 'Title', data_type: 'title' },
  { id: 101, name: 'Status', data_type: 'single_select' },
  { id: 102, name: 'Due', data_type: 'date' },
];

function liveWorld() {
  const w = {
    files: { 'board.config.json': JSON.stringify(settings({ projects: [{ key: 'house', number: 3 }], ideas: { owner: OWNER, number: 9 } })) },
    // Issue 41 is an idea only by membership of project 9; the item lists below never change.
    issues: [apiIssue(41, { title: 'Shelves for the hall', labels: [{ name: 'idea' }] })],
    items: {
      3: [],
      9: [{ id: 555, content_type: 'Issue', content: { ...apiIssue(41, { title: 'Shelves for the hall' }), repository: { full_name: DATA } }, fields: [] }],
    },
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
    if (m) return { items: FIELDS, partial: false };
    m = new RegExp(`^/orgs/${OWNER}/projectsV2/(\\d+)/items\\?`).exec(p);
    if (m) return { items: structuredClone(w.items[m[1]] ?? []), partial: false };
    throw notFound(p);
  };
  const http = {
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
  const loader = createLoader({ http, env, cache, clock });
  const sent = [];
  const gh = {
    async createIssue() { return {}; },
    async patchIssue(number, patch) { sent.push(['patch', number, patch]); return { ...apiIssue(number, { title: 'Shelves for the hall' }), ...patch }; },
    async patchIssueIn(repo, number, patch) { return { ...apiIssue(number), ...patch }; },
    async addProjectItem(a) { sent.push(['add', a]); return { id: 8001 }; },
    async deleteProjectItem(a) { sent.push(['delete', a]); return null; },
    async setItemNumber() { return {}; },
    async getIssueIn() { return apiIssue(41); },
    async getRepo() { return { node_id: 'R_x' }; },
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

const postReq = (name) => ({
  method: 'POST',
  url: `/actions/${name}`,
  headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
});
const ideaNumbers = (bundle) => (board({ raw: bundle.raw, settings: bundle.settings, state: bundle.state }).ideas?.items ?? []).map((i) => i.number);
const rowOf = (bundle, role) => bundle.raw.projects.find((p) => p.role === role);

test('R70 after a sort with settings.ideas the redirected load shows the idea gone and under its project though GitHub\'s item lists still run behind', async () => {
  const s = liveWorld();
  const before = await s.loader.load();
  assert.equal(before.ok, true);
  assert.ok(rowOf(before.bundle, 'ideas').items.some((i) => i.number === 41), 'the Ideas Project holds 41 before the sort');
  assert.deepEqual(ideaNumbers(before.bundle), [41], 'and 41 is an idea');

  const res = await s.h.action('sort', postReq('sort'), { token: s.guard.formToken('sort', '41'), number: '41', target: 'house' });
  assert.equal(res.status, 303);
  assert.deepEqual(s.sent.map((c) => c[0]), ['add', 'delete'], 'the sort wrote an add and a removal');

  const after = await s.loader.load();
  assert.equal(after.ok, true);
  assert.equal(rowOf(after.bundle, 'ideas').items.some((i) => i.number === 41), false, 'the Ideas Project no longer holds 41');
  assert.deepEqual(ideaNumbers(after.bundle), [], 'the idea is gone from the ideas list');
  const house = after.bundle.raw.projects.find((p) => p.number === 3);
  assert.ok(house.items.some((i) => i.number === 41), '41 is under House');
});
