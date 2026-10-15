// R143, R151 and R152 on the native four-table Notion schema (reference/notion-native/interface.md §2, §3).
// The world is built by seedHowgozit on the fake Notion; the reader is the real one. No clock, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { seedHowgozit } from '../fixtures/notion-howgozit.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createStore, readNotion } from '../board/notion/read.mjs';
import { settings as baseSettings } from '../fixtures/build.mjs';

const TOKEN = 'ntn_fake_token';
const NOW = '2026-10-12T06:10:00Z';
const SENTENCE = 'The settings need a notion block with the four data source ids (projects, tasks, goals, habitLog); see notion-setup.md.';
const MODES = ['DO', 'THINK', 'REVIEW', 'LAUNCH'];
const flat = (id) => id.replace(/-/g, '');

async function world(overrides = {}) {
  const fake = createFakeNotion({ token: TOKEN });
  const ids = await seedHowgozit(fake, { habits: ['mood'] });
  const http = createNotionHttp({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  const settings = baseSettings({
    modes: MODES,
    notion: { projects: ids.projects, tasks: ids.tasks, goals: ids.goals, habitLog: ids.habitLog },
    ideas: { owner: 'notion', number: 998 },
    ...overrides,
  });
  const read = () => readNotion(http, createStore(), { settings, full: true, now: NOW });
  return { fake, ids, http, settings, read };
}
const task = (w, name, extra = {}) => w.fake.addPage(w.ids.tasks, { 'Task name': name, Status: 'Not started', ...extra });
const project = (w, name, number) => w.fake.addPage(w.ids.projects, { 'Project name': name, ID: number });

// ---------- R143 ----------

test('R143 a board needs all four data source ids; each missing or malformed one is refused with the one sentence', async () => {
  const w = await world();
  const good = w.settings.notion;
  for (const k of ['projects', 'tasks', 'goals', 'habitLog']) {
    for (const bad of [undefined, 'not-an-id', '']) {
      const notion = { ...good };
      if (bad === undefined) delete notion[k]; else notion[k] = bad;
      await assert.rejects(
        readNotion(w.http, createStore(), { settings: { ...w.settings, notion }, full: true, now: NOW }),
        (err) => err.name === 'BackendError' && err.code === 'invalid' && err.message === SENTENCE,
        `${k} = ${String(bad)}`,
      );
    }
  }
});

test('R143 the old five-table key set (cards, ideas, no tasks) is refused: it names no tasks data source', async () => {
  const w = await world();
  const old = { projects: w.ids.projects, cards: w.ids.tasks, goals: w.ids.goals, ideas: w.ids.tasks, habitLog: w.ids.habitLog };
  await assert.rejects(
    readNotion(w.http, createStore(), { settings: { ...w.settings, notion: old }, full: true, now: NOW }),
    (err) => err.message === SENTENCE,
  );
});

test('R143 a settings block without tasks is refused before any request is made', async () => {
  const w = await world();
  const { tasks, ...rest } = w.settings.notion;
  void tasks;
  const before = w.fake.calls.length;
  await assert.rejects(readNotion(w.http, createStore(), { settings: { ...w.settings, notion: rest }, full: true, now: NOW }), (err) => err.message === SENTENCE);
  assert.equal(w.fake.calls.length, before, 'no request');
});

test('R143 the full read asks for the tasks, habit log and projects schemas and queries the four data sources', async () => {
  const w = await world();
  await w.read();
  const gets = w.fake.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v1/data_sources/')).map((c) => flat(c.path.split('/')[3]));
  assert.deepEqual(gets.sort(), [flat(w.ids.tasks), flat(w.ids.habitLog), flat(w.ids.projects)].sort());
  const queried = new Set(w.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/query')).map((c) => flat(c.path.split('/')[3])));
  assert.deepEqual([...queried].sort(), [w.ids.projects, w.ids.tasks, w.ids.goals, w.ids.habitLog].map(flat).sort());
});

test('R143 a project with owner notion and no home shows with its goals, titled <project> · <goal>', async () => {
  const w = await world({ projects: [{ key: 'house', owner: 'notion', number: 3 }] });
  const p = project(w, 'House', 3);
  w.fake.addPage(w.ids.goals, { 'Goal name': 'Hallway', ID: 1, Project: [p.id], Due: '2026-10-20' });
  w.fake.addPage(w.ids.goals, { 'Goal name': 'Garden', ID: 2, Project: [p.id] });
  task(w, 'Paint', { ID: 1, Project: [p.id] });
  const { raw } = await w.read();
  const row = raw.projects.find((x) => x.number === 3);
  assert.ok(row, 'the project is on the board');
  assert.equal(row.title, 'House');
  assert.equal(row.owner, 'notion');
  assert.equal(row.items.length, 1);
  assert.deepEqual(raw.milestones.map((m) => m.title), ['House · Hallway', 'House · Garden']);
});

// ---------- R151 ----------

test('R151 an Idea-tagged task with no Project is an idea on the Ideas row; its url is the tasks data source', async () => {
  const w = await world();
  const idea = task(w, 'Paint the shed', { ID: 4, Tags: ['Idea'] });
  const { raw } = await w.read();
  const row = raw.projects.find((p) => p.role === 'ideas');
  assert.ok(row, 'an Ideas row');
  assert.equal(row.url, 'https://www.notion.so/' + flat(w.ids.tasks));
  assert.deepEqual(row.items.map((i) => i.number), [4]);
  const issue = raw.issues.find((i) => i.ref === 'notion:' + idea.id);
  assert.deepEqual(issue.labels, ['idea']);
  assert.equal(issue.state, 'open');
  assert.equal(issue.milestone, null);
});

test('R151 an Idea-tagged task WITH a Project is a card without an Idea label, and is not on the Ideas row', async () => {
  const w = await world({ projects: [{ key: 'house', owner: 'notion', number: 3 }] });
  const p = project(w, 'House', 3);
  const t = task(w, 'Shelves', { ID: 5, Tags: ['Idea', 'DO'], Project: [p.id] });
  const { raw } = await w.read();
  const issue = raw.issues.find((i) => i.ref === 'notion:' + t.id);
  assert.deepEqual(issue.labels, ['DO'], 'the Idea tag is never a label');
  assert.deepEqual(raw.projects.find((x) => x.number === 3).items.map((i) => i.number), [5], 'it is a card of the project');
  assert.deepEqual(raw.projects.find((x) => x.role === 'ideas').items, []);
});

test('R151 an Idea-tagged task with no Project that is Done is neither an idea nor a card', async () => {
  const w = await world();
  const t = task(w, 'Old idea', { ID: 6, Tags: ['Idea'], Status: 'Done' });
  const { raw } = await w.read();
  assert.equal(raw.issues.some((i) => i.ref === 'notion:' + t.id), false);
  assert.deepEqual(raw.projects.find((x) => x.role === 'ideas').items, []);
});

test('R151 a task without the Idea tag and without a Project is a plain card, not an idea', async () => {
  const w = await world();
  const t = task(w, 'Loose task', { ID: 7 });
  const { raw } = await w.read();
  const issue = raw.issues.find((i) => i.ref === 'notion:' + t.id);
  assert.ok(issue);
  assert.deepEqual(issue.labels, []);
  assert.deepEqual(raw.projects.find((x) => x.role === 'ideas').items, []);
});

test('R151 the Idea tag is matched without regard to case and spaces', async () => {
  const w = await world();
  task(w, 'Quiet idea', { ID: 8, Tags: ['IDEA'] });
  const { raw } = await w.read();
  assert.deepEqual(raw.projects.find((x) => x.role === 'ideas').items.map((i) => i.number), [8]);
});

// ---------- R152 ----------

test('R152 a card tagged THINK and DO with modes DO, THINK, REVIEW, LAUNCH has the labels DO then THINK', async () => {
  const w = await world({ projects: [{ key: 'house', owner: 'notion', number: 3 }] });
  const p = project(w, 'House', 3);
  const t = task(w, 'Both', { ID: 1, Project: [p.id], Tags: ['THINK', 'DO'] });
  const { raw } = await w.read();
  assert.deepEqual(raw.issues.find((i) => i.ref === 'notion:' + t.id).labels, ['DO', 'THINK']);
});

test('R152 a card whose only tag is not a mode has no label', async () => {
  const w = await world({ projects: [{ key: 'house', owner: 'notion', number: 3 }] });
  const p = project(w, 'House', 3);
  const t = task(w, 'Urgent one', { ID: 2, Project: [p.id], Tags: ['Urgent'] });
  const { raw } = await w.read();
  assert.deepEqual(raw.issues.find((i) => i.ref === 'notion:' + t.id).labels, []);
});

test('R152 a mode tag in other case takes the settings\' spelling', async () => {
  const w = await world({ projects: [{ key: 'house', owner: 'notion', number: 3 }] });
  const p = project(w, 'House', 3);
  const t = task(w, 'Lower', { ID: 3, Project: [p.id], Tags: ['review'] });
  const { raw } = await w.read();
  assert.deepEqual(raw.issues.find((i) => i.ref === 'notion:' + t.id).labels, ['REVIEW']);
});

test('R152 a mode\'s colour is its tag option\'s colour through the palette; a tag that is not a mode has none', async () => {
  const w = await world();
  task(w, 'Urgent one', { ID: 2, Tags: ['Urgent'] });
  const { raw } = await w.read();
  assert.equal(raw.labelColors.do, '#b60205', 'DO is red in the workspace');
  assert.equal(raw.labelColors.think, '#5319e7');
  assert.equal('urgent' in raw.labelColors, false);
  assert.equal('idea' in raw.labelColors, false, 'Idea is not a mode');
});
