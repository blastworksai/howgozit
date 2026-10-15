// CP6 (SKILLS-78) job D1, ideas half: the Ideas Project (R2, R32, R135), the reader's role rows and ideas cards (CP6 2a, 2c),
// and the sort targets of a home project (R59, CP6 3e). Written from references/contract.md and
// reference/mapping-redesign/cp6-interface.md, from hand-made raw and a fake `http` only.
// Today is 2026-10-12 (board timezone Europe/Brussels); the data repo is sam-life/life.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, project, milestone, task, idea, raw, resetNumbers, board } from '../fixtures/build.mjs';
import { readAll } from '../board/github/read.mjs';
import { GitHubError } from '../board/github/http.mjs';

const OWNER = 'sam-life';
const DATA = 'sam-life/life';
const HOME = 'sam-life/house';
const OTHER = 'sam-life/garden';
const IDEAS = { owner: OWNER, number: 8 };

const warn = (b, code) => (b?.meta?.warnings ?? []).find((w) => w.code === code)?.count ?? 0;
const ideaNumbers = (b) => (b.ideas?.items ?? []).map((i) => i.number);
const ideasRow = (items) => project(8, 'Ideas box', [], { role: 'ideas', owner: OWNER, items });
const iitem = (repo, number, extra = {}) => ({ type: 'Issue', repo, number, status: null, due: null, ...extra });
function card(repo, number, extra = {}) {
  return task({ number, repo, ref: `${repo}#${number}`, html_url: `https://github.com/${repo}/issues/${number}`, ...extra });
}
const withIdeas = (extra = {}) => settings({ ideas: IDEAS, ...extra });

// ---------- R2 ----------

test('R2 with settings.ideas, an issue without the idea label that is an item of the Ideas Project is an idea', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas(),
    raw: raw({ issues: [task({ number: 7, title: 'Learn pottery' })], projects: [ideasRow([iitem(DATA, 7)])] }),
  });
  assert.deepEqual(ideaNumbers(b), [7]);
  assert.equal(b.ideas.count, 1);
  assert.equal(b.standalone.count, 0, 'not a task');
});

test('R2 with settings.ideas, an issue labelled idea that is not an item of the Ideas Project is a task', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas(),
    raw: raw({ issues: [idea({ number: 7 })], projects: [ideasRow([])] }),
  });
  assert.deepEqual(ideaNumbers(b), []);
  assert.equal(b.ideas.count, 0);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [7], 'it is a task now');
});

test('R2 the two together in one board: the member of the Ideas Project is the idea, the labelled outsider a task', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas(),
    raw: raw({ issues: [task({ number: 1 }), idea({ number: 2 })], projects: [ideasRow([iitem(DATA, 1)])] }),
  });
  assert.deepEqual(ideaNumbers(b), [1]);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [2]);
});

test('R2 a closed issue that is an item of the Ideas Project is an idea too (it is in no task list), though not in the backlog', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas(),
    raw: raw({
      issues: [task({ number: 1, state: 'closed' }), task({ number: 2 })],
      projects: [ideasRow([iitem(DATA, 1), iitem(DATA, 2)])],
    }),
  });
  assert.deepEqual(ideaNumbers(b), [2]);
  assert.equal(b.ideas.count, 1);
  assert.ok(!JSON.stringify({ n: b.next, s: b.standalone }).includes('"number":1,'), 'the closed idea is not a task');
});

test('R2 a check-in or an ignored issue stays what it was even when it is an item of the Ideas Project', () => {
  resetNumbers();
  const c = task({ number: 1, labels: ['habit:move'], title: 'Move · 2026-10-10' });
  const ig = task({ number: 2, labels: ['weekly-review'] });
  const b = board({
    settings: withIdeas({ habits: [{ id: 'move', title: 'Move', start: '2026-10-09' }] }),
    raw: raw({ issues: [c, ig], projects: [ideasRow([iitem(DATA, 1), iitem(DATA, 2)])] }),
  });
  assert.deepEqual(ideaNumbers(b), []);
});

test('R2 with settings.ideas present but no ideas Project in the read, nothing is an idea and there is no warning', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas(),
    raw: raw({ issues: [idea({ number: 3 }), task({ number: 4 })], projects: [] }),
  });
  assert.deepEqual(ideaNumbers(b), []);
  assert.equal(b.ideas.count, 0);
  assert.equal((b.meta.warnings ?? []).length, 0);
});

test('R2 off path: without settings.ideas the idea label decides, and a role row of ideas in the raw changes nothing', () => {
  resetNumbers();
  const b = board({
    settings: settings(),
    raw: raw({ issues: [idea({ number: 1 }), task({ number: 2 }), idea({ number: 3, labels: ['IDEA '] })] }),
  });
  assert.deepEqual(ideaNumbers(b).sort(), [1, 3]);
  resetNumbers();
  const c = board({
    settings: settings(),
    raw: raw({ issues: [task({ number: 2 })], projects: [ideasRow([iitem(DATA, 2)])] }),
  });
  assert.deepEqual(ideaNumbers(c), [], 'with no setting, membership makes no idea');
});

// ---------- R135 ----------

test('R135 the Ideas Project is never a shown project, nor a sort target', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas({ projects: [{ key: 'house', number: 3 }] }),
    raw: raw({ issues: [task({ number: 1 })], projects: [project(3, 'House', []), ideasRow([iitem(DATA, 1)])] }),
  });
  assert.deepEqual(b.projects.map((p) => p.key), ['house']);
  assert.deepEqual(b.sortTargets.map((s) => s.key), ['house']);
  assert.ok(!JSON.stringify(b.projects).includes('Ideas box'));
});

test('R135 an idea of another repo (an item of the Ideas Project) is an idea carrying its ref; a data-repo idea carries none', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas(),
    raw: raw({
      issues: [task({ number: 7, title: 'Data idea' }), card(OTHER, 7, { title: 'Garden idea' })],
      projects: [ideasRow([iitem(DATA, 7), iitem(OTHER, 7)])],
    }),
  });
  assert.equal(b.ideas.count, 2, 'a/x#7 and a/y#7 are two ideas');
  const data = b.ideas.items.find((i) => i.title === 'Data idea');
  const garden = b.ideas.items.find((i) => i.title === 'Garden idea');
  assert.ok(data && garden);
  assert.equal(Object.hasOwn(data, 'ref'), false, 'the bare number is the short ref of a data-repo idea');
  assert.equal(garden.ref, `${OTHER}#7`);
});

test('R135 an idea is never active (R33): not in a project total, a milestone or What\'s next, even as an item of a shown project', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas({ projects: [{ key: 'house', number: 3 }] }),
    raw: raw({
      issues: [task({ number: 1, milestone: 1 })],
      milestones: [milestone(1, 'House · Hallway', '2026-10-30')],
      projects: [project(3, 'House', [1]), ideasRow([iitem(DATA, 1)])],
    }),
  });
  assert.deepEqual(ideaNumbers(b), [1]);
  assert.equal((b.next ?? []).length, 0);
  assert.equal(b.projects[0].total, 0);
});

// ---------- R32 ----------

test('R32 with settings.ideas, count is the open cards of the Ideas Project, newest first, closed excluded', () => {
  resetNumbers();
  const b = board({
    settings: withIdeas(),
    raw: raw({
      issues: [
        task({ number: 1, created_at: '2026-09-01T08:00:00Z' }),
        task({ number: 2, created_at: '2026-09-20T08:00:00Z' }),
        task({ number: 3, created_at: '2026-09-10T08:00:00Z', state: 'closed' }),
      ],
      projects: [ideasRow([iitem(DATA, 1), iitem(DATA, 2), iitem(DATA, 3)])],
    }),
  });
  assert.equal(b.ideas.count, 2);
  assert.equal(b.ideas.shown, 2);
  assert.deepEqual(ideaNumbers(b), [2, 1]);
});

test('R32 with settings.ideas, 23 open cards and 2 closed: count 23, shown 20, newest first, ties by higher number', () => {
  resetNumbers();
  const issues = [];
  const items = [];
  for (let n = 1; n <= 25; n++) {
    issues.push(task({ number: n, created_at: `2026-09-${String(n <= 23 ? n : 1).padStart(2, '0')}T08:00:00Z`, state: n > 23 ? 'closed' : 'open' }));
    items.push(iitem(DATA, n));
  }
  // numbers 22 and 23 share a creation time: the higher number comes first
  issues[21].created_at = '2026-09-23T08:00:00Z';
  const b = board({ settings: withIdeas(), raw: raw({ issues, projects: [ideasRow(items)] }) });
  assert.equal(b.ideas.count, 23);
  assert.equal(b.ideas.shown, 20);
  assert.equal(b.ideas.items.length, 20);
  assert.deepEqual(ideaNumbers(b).slice(0, 3), [23, 22, 21]);
  assert.ok(!ideaNumbers(b).includes(24) && !ideaNumbers(b).includes(25), 'no closed idea');
});

test('R32 off path: 23 open labelled ideas and 2 closed give count 23, shown 20, the newest first, no closed idea', () => {
  resetNumbers();
  const issues = [];
  for (let n = 1; n <= 25; n++) {
    issues.push(idea({ number: n, created_at: `2026-09-${String(n <= 23 ? n : 1).padStart(2, '0')}T08:00:00Z`, state: n > 23 ? 'closed' : 'open' }));
  }
  const b = board({ settings: settings(), raw: raw({ issues }) });
  assert.equal(b.ideas.count, 23);
  assert.equal(b.ideas.shown, 20);
  assert.equal(ideaNumbers(b)[0], 23);
  assert.ok(!ideaNumbers(b).includes(24));
});

// ---------- R36 is in the score file; sort targets (R59) ----------

test('R59 a home project\'s sort targets offer its open home-repo goals, not closed ones and not data-repo milestones', () => {
  resetNumbers();
  const b = board({
    settings: settings({ projects: [{ key: 'house', number: 3, home: HOME }] }),
    raw: raw({
      projects: [project(3, 'House', [iitem(HOME, 5), iitem(HOME, 6), iitem(HOME, 7)])],
      issues: [
        card(HOME, 5, { milestone: 1 }),
        card(HOME, 6, { milestone: 2 }),
        card(HOME, 7, { milestone: 3 }),
        task({ number: 40, milestone: 4 }),
      ],
      milestones: [
        milestone(1, 'Hallway', '2026-10-30', { repo: HOME }),
        milestone(2, 'Kitchen', '2026-11-30', { repo: HOME }),
        milestone(3, 'Old job', '2026-09-01', { repo: HOME, state: 'closed', closed_at: '2026-09-02T08:00:00Z' }),
        milestone(4, 'House · Data goal', '2026-12-01'),
      ],
    }),
  });
  const t = b.sortTargets.find((s) => s.key === 'house');
  assert.ok(t);
  assert.deepEqual(t.milestones.map((m) => m.number), [1, 2], 'by due, home repo only, open only');
});

// Lead (CP6): an empty goal of a home repo is offered only when no other shown project shares that repo.
test('R59 an empty home goal is a sort target of its project when the home repo is not shared, and of nobody when it is', () => {
  resetNumbers();
  const lone = board({
    settings: settings({ projects: [{ key: 'house', number: 3, home: HOME }] }),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [milestone(1, 'Hallway', '2026-10-30', { repo: HOME })],
    }),
  });
  assert.deepEqual(lone.sortTargets.find((s) => s.key === 'house').milestones.map((m) => m.number), [1]);
  resetNumbers();
  const shared = board({
    settings: settings({ projects: [{ key: 'house', number: 3, home: HOME }, { key: 'shed', number: 4, home: HOME }] }),
    raw: raw({
      projects: [project(3, 'House', []), project(4, 'Shed', [])],
      milestones: [milestone(1, 'Hallway', '2026-10-30', { repo: HOME })],
    }),
  });
  for (const key of ['house', 'shed']) assert.deepEqual(shared.sortTargets.find((s) => s.key === key).milestones, []);
});

test('R59 a project without a home keeps the data repo\'s milestones as sort targets', () => {
  resetNumbers();
  const b = board({
    settings: settings({ projects: [{ key: 'house', number: 3 }] }),
    raw: raw({
      projects: [project(3, 'House', [1])],
      issues: [task({ number: 1, milestone: 4 })],
      milestones: [milestone(4, 'House · Data goal', '2026-12-01')],
    }),
  });
  const t = b.sortTargets.find((s) => s.key === 'house');
  assert.deepEqual(t.milestones.map((m) => m.number), [4]);
});

// ---------- the reader (CP6 2a, 2c) ----------

const R = '/repos/' + DATA;
const P = '/orgs/' + OWNER + '/projectsV2';
const NOW = '2026-10-12T06:10:00Z';
const FIELDS = [
  { id: 100, name: 'Title', data_type: 'title' },
  { id: 101, name: 'Status', data_type: 'single_select' },
  { id: 102, name: 'Due', data_type: 'date' },
  { id: 103, name: 'Labels', data_type: 'labels' },
];
const HABIT_FIELDS = [...FIELDS, { id: 104, name: 'Score', data_type: 'number' }];
const b64 = (text) => ({ name: 'file', type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });

function apiIssue(repoFull, number, extra = {}) {
  return {
    id: number * 10, number, title: 'Task ' + number, state: 'open', state_reason: null,
    labels: [], milestone: null, comments: 0,
    created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
    html_url: 'https://github.com/' + repoFull + '/issues/' + number,
    repository: { full_name: repoFull },
    ...extra,
  };
}
const scoreField = (value) => ({ id: 104, name: 'Score', data_type: 'number', value });
function issueItem(itemId, repoFull, number, fields = [], extra = {}) {
  return { id: itemId, content_type: 'Issue', content: apiIssue(repoFull, number, extra), fields };
}

function makeWorld(over = {}) {
  const w = {
    settings: { version: 1, timezone: 'UTC', projects: [{ number: 3 }], ideas: IDEAS, habitsProject: { owner: OWNER, number: 9 } },
    dataIssues: [apiIssue(DATA, 12, { title: 'Paint the hallway' })],
    items: { 3: [], 8: [], 9: [] },
    fields: { 3: FIELDS, 8: FIELDS, 9: HABIT_FIELDS },
    projectNumbers: [3, 8, 9],
    calls: [],
    ...over,
  };
  function answer(p) {
    w.calls.push(p);
    if (p === R) return { private: true, default_branch: 'main', owner: { login: OWNER, type: 'Organization' } };
    if (p === R + '/contents/board.config.json') return b64(JSON.stringify(w.settings));
    if (p.startsWith(R + '/contents/')) throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
    if (p.startsWith(R + '/issues?')) return { items: p.includes('&since=') ? [] : w.dataIssues, partial: false };
    if (p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    if (/^\/repos\/[^/]+\/[^/]+\/milestones\?/.test(p)) return { items: [], partial: false };
    if (p === P + '?per_page=100') return { items: w.projectNumbers.map((n) => ({ number: n, title: 'Project ' + n, state: 'open' })), partial: false };
    let m = /^\/orgs\/sam-life\/projectsV2\/(\d+)\/fields\?/.exec(p);
    if (m) return { items: w.fields[m[1]] || [], partial: false };
    m = /^\/orgs\/sam-life\/projectsV2\/(\d+)\/items\?/.exec(p);
    if (m) return { items: w.items[m[1]] || [], partial: false };
    throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
  }
  w.http = {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
  return w;
}
const read = (w) => readAll(w.http, { repo: DATA, full: true, now: NOW });
const roleRow = (raw, role) => raw.projects.find((p) => p.role === role);

test('R135 the reader gives the Ideas role row its owner, ownerType and each item\'s itemId', async () => {
  const w = makeWorld({ items: { 3: [], 8: [issueItem(501, DATA, 12), issueItem(502, OTHER, 5)], 9: [] } });
  const { raw } = await read(w);
  const row = roleRow(raw, 'ideas');
  assert.ok(row, 'an ideas role row');
  assert.equal(row.owner, OWNER);
  assert.equal(row.ownerType, 'organization');
  assert.equal(row.number, 8);
  assert.deepEqual(row.items.map((i) => [i.repo, i.number, i.itemId]), [[DATA, 12, 501], [OTHER, 5, 502]]);
});

test('R136 the reader gives the Habits role row its owner, ownerType, itemId, score and the Score field id as scoreField', async () => {
  const w = makeWorld({ items: { 3: [], 8: [], 9: [issueItem(601, DATA, 12, [scoreField(7)])] } });
  const { raw } = await read(w);
  const row = roleRow(raw, 'habits');
  assert.ok(row, 'a habits role row');
  assert.equal(row.owner, OWNER);
  assert.equal(row.ownerType, 'organization');
  assert.equal(row.scoreField, 104);
  assert.equal(row.items[0].itemId, 601);
  assert.equal(row.items[0].score, 7);
});

test('R136 an item whose Score is empty reads as score null', async () => {
  const w = makeWorld({ items: { 3: [], 8: [], 9: [issueItem(601, DATA, 12, [scoreField(null)])] } });
  const { raw } = await read(w);
  assert.equal(roleRow(raw, 'habits').items[0].score, null);
});

test('R136 an item id that is not a positive whole number gives the item no itemId key', async () => {
  const bad = issueItem(0, DATA, 12);
  const w = makeWorld({ items: { 3: [], 8: [bad, { ...issueItem(1, OTHER, 5), id: 'x' }], 9: [] } });
  const { raw } = await read(w);
  for (const it of roleRow(raw, 'ideas').items) assert.equal(Object.hasOwn(it, 'itemId'), false);
});

test('R136 without a Score field in the Habits Project the role row has no scoreField key', async () => {
  const w = makeWorld({ fields: { 3: FIELDS, 8: FIELDS, 9: FIELDS }, items: { 3: [], 8: [], 9: [issueItem(601, DATA, 12)] } });
  const { raw } = await read(w);
  assert.equal(Object.hasOwn(roleRow(raw, 'habits'), 'scoreField'), false);
});

test('R136 a listed (business) project row carries none of owner, itemId or scoreField when it is the data repo\'s own', async () => {
  const w = makeWorld({ items: { 3: [issueItem(701, DATA, 12)], 8: [], 9: [] } });
  const { raw } = await read(w);
  const biz = raw.projects.find((p) => p.role === undefined && p.number === 3);
  assert.ok(biz);
  assert.equal(Object.hasOwn(biz, 'scoreField'), false);
  for (const it of biz.items) assert.equal(Object.hasOwn(it, 'itemId'), false);
});

test('R135 an Issue item of another repo in the Ideas Project gives a card row in raw.issues, after the data issues, with its ref', async () => {
  const w = makeWorld({
    items: { 3: [], 8: [issueItem(501, OTHER, 5, [], { title: 'Plant a hedge', labels: [{ name: 'garden' }] })], 9: [] },
  });
  const { raw } = await read(w);
  const card = raw.issues.find((i) => i.ref === OTHER + '#5');
  assert.ok(card, 'a card with ref ' + OTHER + '#5');
  assert.equal(card.repo, OTHER);
  assert.equal(card.number, 5);
  assert.equal(card.title, 'Plant a hedge');
  assert.deepEqual(card.labels, ['garden']);
  assert.ok(raw.issues.findIndex((i) => i.number === 12 && !i.ref) < raw.issues.indexOf(card), 'data issues first');
});

test('R135 the same Ideas card listed twice, or also an item of the data repo, is one row and the data issue is not doubled', async () => {
  const w = makeWorld({
    items: { 3: [], 8: [issueItem(501, OTHER, 5), issueItem(502, 'Sam-Life/Garden', 5), issueItem(503, DATA, 12)], 9: [] },
  });
  const { raw } = await read(w);
  assert.equal(raw.issues.filter((i) => i.ref === OTHER + '#5').length, 1);
  assert.equal(raw.issues.filter((i) => i.number === 12).length, 1);
});

test('R135 Ideas cards add no repos and no milestones to the read, and no request leaves for the other repo\'s milestones', async () => {
  const w = makeWorld({ items: { 3: [], 8: [issueItem(501, OTHER, 5)], 9: [] } });
  const { raw } = await read(w);
  assert.equal(Object.hasOwn(raw, 'repos'), false);
  assert.equal(raw.milestones.length, 0);
  assert.equal(w.calls.filter((p) => p.startsWith('/repos/' + OTHER)).length, 0);
});

test('R135 the reader\'s Ideas card makes the board show an idea with its ref (read to model)', async () => {
  const w = makeWorld({ items: { 3: [], 8: [issueItem(501, OTHER, 5, [], { title: 'Plant a hedge' })], 9: [] } });
  const { raw } = await read(w);
  const b = board({ settings: settings({ ideas: IDEAS, projects: [{ key: 'house', number: 3 }] }), raw });
  const it = b.ideas.items.find((i) => i.title === 'Plant a hedge');
  assert.ok(it, 'the card is an idea');
  assert.equal(it.ref, OTHER + '#5');
});
