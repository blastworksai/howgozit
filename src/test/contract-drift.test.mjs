// R149: the same world on both back-ends gives the same board.
// The scenario is cp9-interface.md §8, built once on the fake GitHub and once on the fake Notion,
// read through the real loader and the real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { seedHowgozit } from '../fixtures/notion-howgozit.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { renderPage } from '../board/render/page.mjs';
import { settings as baseSettings, NOW } from '../fixtures/build.mjs';

const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const EARLY = '2026-10-01T08:00:00Z';
const SAND_CLOSED = '2026-10-05T09:00:00Z';
const MOOD_CLOSED = '2026-10-12T10:00:00Z';
const MOOD_CREATED = '2026-10-12T08:00:00Z';

const common = {
  name: 'Sam',
  timezone: 'Europe/Brussels',
  projects: [{ key: 'house', number: 3 }],
  modes: ['DO'],
  habits: [{ id: 'mood', title: 'Mood', score: { min: 1, max: 10 } }],
};

function fakeCache() {
  const c = {
    stored: null,
    async readLastGood() { return c.stored; },
    async writeLastGood(b) { c.stored = structuredClone(b); },
    etags: { get() {}, set() {} },
  };
  return c;
}
const clock = { now: () => Date.parse(NOW) };

// ---- GitHub side ----
function addProject(fake, number, title, { score = false } = {}) {
  const fields = [
    { id: 100 + number * 10 + 1, node_id: 'F_' + number + '_t', name: 'Title', data_type: 'title' },
    { id: 100 + number * 10 + 2, node_id: 'F_' + number + '_s', name: 'Status', data_type: 'single_select' },
    { id: 100 + number * 10 + 3, node_id: 'F_' + number + '_d', name: 'Due', data_type: 'date' },
  ];
  if (score) fields.push({ id: 100 + number * 10 + 4, node_id: 'F_' + number + '_n', name: 'Score', data_type: 'number' });
  const project = { id: 9000 + number, node_id: 'P_' + number, number, title, state: 'open', fields, items: [], repositories: [] };
  fake.state.projects.push(project);
  return project;
}
let itemSeq = 0;
function addItem(project, issue, { status, due = null, score } = {}) {
  itemSeq += 1;
  const item = {
    id: 5000 + itemSeq, node_id: 'PI_' + itemSeq, content_type: 'Issue',
    content: { number: issue.number, title: issue.title, repository: { full_name: REPO } },
    fields: [], status, due, nums: {},
  };
  if (score !== undefined) item.nums[project.fields.find((f) => f.name === 'Score').id] = score;
  project.items.push(item);
}

async function githubWorld() {
  const s = baseSettings({ ...common, habitsProject: { owner: 'sam-life', number: 21 } });
  const fake = createFakeGitHub({ repo: REPO, files: { 'board.config.json': JSON.stringify(s) } });
  const send = (m, p, b) => fake.http.send(m, R + p, b);
  await send('POST', '/labels', { name: 'DO', color: 'b60205' });
  await send('POST', '/labels', { name: 'idea', color: 'ededed' });
  await send('POST', '/labels', { name: 'habit:mood', color: 'ededed' });
  await send('POST', '/milestones', { title: 'House · Hallway', due_on: '2026-10-20T00:00:00Z' });
  await send('POST', '/issues', { title: 'Paint the hallway', labels: ['DO'], milestone: 1 });
  await send('POST', '/issues', { title: 'Buy paint', milestone: 1 });
  await send('POST', '/issues', { title: 'Sand the door', milestone: 1 });
  await send('POST', '/issues', { title: 'Paint the shed', labels: ['idea'] });
  await send('POST', '/issues', { title: 'Mood · 2026-10-12', labels: ['habit:mood'] });
  fake.seedBlockedBy(REPO, 1, [2]);
  await send('PATCH', '/issues/3', { state: 'closed', state_reason: 'completed' });
  await send('PATCH', '/issues/5', { state: 'closed', state_reason: 'completed' });
  // The fake stamps from a counter; the scenario's times are fixed, so set them in the live world.
  for (const i of fake.state.issues) {
    i.created_at = i.number === 5 ? MOOD_CREATED : EARLY;
    i.updated_at = i.number === 3 ? SAND_CLOSED : i.number === 5 ? MOOD_CLOSED : EARLY;
    if (i.number === 3) i.closed_at = SAND_CLOSED;
    if (i.number === 5) i.closed_at = MOOD_CLOSED;
  }
  const house = addProject(fake, 3, 'House');
  const byNo = (n) => fake.state.issues.find((i) => i.number === n);
  addItem(house, byNo(1), { status: 'Todo', due: '2026-10-18' });
  addItem(house, byNo(2), { status: 'In Progress' });
  addItem(house, byNo(3), { status: 'Done' });
  const habits = addProject(fake, 21, 'Habits', { score: true });
  addItem(habits, byNo(5), { status: null, score: 7 });
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'ghp_fake_token' };
  const loader = createLoader({ http: fake.http, env, cache: fakeCache(), clock });
  return { fake, loader };
}

// ---- Notion side ----
const PAGE = (n) => 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0' + String(n).padStart(4, '0');

async function notionWorld() {
  const fake = createFakeNotion({ token: 'ntn_fake_token' });
  const DS = await seedHowgozit(fake, { habits: ['mood'] });
  const s = baseSettings({ ...common, habitsProject: { owner: 'notion', number: 21 }, notion: { projects: DS.projects, tasks: DS.tasks, goals: DS.goals, habitLog: DS.habitLog } });
  const at = (n, edited = EARLY, created = EARLY) => ({ id: PAGE(n), created, edited });
  fake.addPage(DS.projects, { 'Project name': 'House', ID: 3 }, at(1));
  fake.addPage(DS.goals, { 'Goal name': 'Hallway', ID: 1, Project: [PAGE(1)], Due: '2026-10-20' }, at(2));
  fake.addPage(DS.tasks, { 'Task name': 'Paint the hallway', ID: 1, Status: 'Not started', Project: [PAGE(1)], Goal: [PAGE(2)], Tags: ['DO'], Due: '2026-10-18', 'Blocked by': [PAGE(4)] }, at(3));
  fake.addPage(DS.tasks, { 'Task name': 'Buy paint', ID: 2, Status: 'In progress', Project: [PAGE(1)], Goal: [PAGE(2)] }, at(4));
  fake.addPage(DS.tasks, { 'Task name': 'Sand the door', ID: 3, Status: 'Done', Project: [PAGE(1)], Goal: [PAGE(2)] }, at(5, SAND_CLOSED));
  fake.addPage(DS.tasks, { 'Task name': 'Paint the shed', ID: 4, Status: 'Not started', Tags: ['Idea'] }, at(6));
  fake.addPage(DS.habitLog, { Name: 'Mood · 2026-10-12', ID: 5, Habit: 'mood', Date: '2026-10-12', Done: true, Score: 7 }, at(7, MOOD_CLOSED, MOOD_CREATED));
  const http = createNotionHttp({ token: 'ntn_fake_token', fetch: fake.fetch, sleep: async () => {} });
  const readFile = async (p) => {
    if (String(p).endsWith('board.config.json')) return JSON.stringify(s);
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  };
  const adapter = createNotionAdapter({ http, configDir: '/fake-config', readFile });
  const env = { repo: 'notion', backend: 'notion', readOnly: false, configDir: '/fake-config', token: null };
  const loader = createLoader({ env, cache: fakeCache(), clock, adapter });
  return { fake, loader };
}

// ---- comparison ----
const DROP_KEYS = new Set(['url', 'repoUrl', 'ref']);
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!DROP_KEYS.has(k)) out[k] = strip(v);
    return out;
  }
  return value;
}
function comparable(board) {
  const b = strip(JSON.parse(JSON.stringify(board)));
  if (b.meta && Array.isArray(b.meta.sources) && b.meta.sources[0]) b.meta.sources[0].id = 'SOURCE';
  return b;
}
function comparablePage(html) {
  return html
    .replace(/https?:\/\/[^\s"'<>]*/g, 'URL')
    .replace(/data-src="(?:GH|NT)">(?:GH|NT)</g, 'data-src="TAG">TAG<')
    // the back-end's own name in a source chip and in the idea box's hint (R88, R148 name them per back-end)
    .replace(/<span class="chip__name">(?:GitHub|Notion)<\/span>/g, '<span class="chip__name">BACKEND</span>')
    .replace(/It becomes a (?:GitHub issue|Notion row)\./g, 'It becomes BACKEND.')
    // the footer link's text names the back-end (cp9-interface §5): "Data repo" on GitHub, "Notion" on Notion
    .replace(/(<p class="footer__time">[^]*?<a href="URL">)(?:Data repo|Notion)</g, '$1DATA<');
}

async function both() {
  const gh = await (await githubWorld()).loader.load();
  const nt = await (await notionWorld()).loader.load();
  assert.equal(gh.ok, true, JSON.stringify(gh));
  assert.equal(nt.ok, true, JSON.stringify(nt));
  const now = NOW;
  return {
    gh, nt,
    ghBoard: buildBoard({ ...gh.bundle, now }),
    ntBoard: buildBoard({ ...nt.bundle, now }),
  };
}

test('R149 the same world on the fake GitHub and the fake Notion gives the same board once urls, refs and the source tag are removed', async () => {
  const { ghBoard, ntBoard } = await both();
  const a = comparable(ghBoard);
  // not vacuous: the scenario really reached the board on the GitHub side
  const text = JSON.stringify(a);
  for (const needle of ['Buy paint', 'Hallway', 'Paint the shed']) assert.ok(text.includes(needle), needle);
  assert.deepEqual(comparable(ntBoard), a);
});

test('R149 both boards carry the scenario: the blocker, the idea, the goal and the scored check-in', async () => {
  const { ghBoard, ntBoard } = await both();
  for (const [name, board] of [['github', ghBoard], ['notion', ntBoard]]) {
    const text = JSON.stringify(strip(board));
    assert.ok(text.includes('Buy paint'), name + ' shows the blocker or its card');
    assert.ok(text.includes('Paint the shed'), name + ' shows the idea');
    assert.ok(text.includes('Hallway'), name + ' shows the goal');
    assert.ok(/"score":7|"7"|\b7\b/.test(text), name + ' carries the check-in score');
  }
});

test('R149 the two pages are the same once urls and the GH/NT tag are removed', async () => {
  const { gh, nt, ghBoard, ntBoard } = await both();
  const opts = { styleNonce: 'nonce', formToken: () => "token" };
  const a = comparablePage(renderPage(ghBoard, gh.bundle.theme, opts));
  const b = comparablePage(renderPage(ntBoard, nt.bundle.theme, opts));
  assert.ok(a.length > 1000);
  assert.equal(b, a);
});
