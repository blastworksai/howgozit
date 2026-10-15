// R151 on the native four-table Notion schema, writer side (reference/notion-native/interface.md §4):
// an idea is a task tagged Idea; filing it is one PATCH on that same page; nothing is ever created by a filing.
// The writer is driven through the real Notion adapter over the fake Notion that seedHowgozit builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { seedHowgozit } from '../fixtures/notion-howgozit.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { settings as baseSettings } from '../fixtures/build.mjs';

const TOKEN = 'ntn_fake_token';
const NOW = '2026-10-12T06:10:00Z';
const TODAY = '2026-10-12';
const CONFIG = '/srv/board-config';
const flat = (id) => id.replace(/-/g, '');

async function world() {
  const fake = createFakeNotion({ token: TOKEN });
  const ids = await seedHowgozit(fake, { habits: ['mood'] });
  const settings = baseSettings({
    projects: [{ key: 'house', owner: 'notion', number: 3 }, { key: 'yard', owner: 'notion', number: 4 }],
    modes: ['DO', 'THINK', 'REVIEW', 'LAUNCH'],
    habits: [{ id: 'mood', title: 'Mood', start: '2026-10-01', score: { min: 1, max: 10 } }],
    ideas: { owner: 'notion', number: 998 },
    habitsProject: { owner: 'notion', number: 999 },
    notion: { projects: ids.projects, tasks: ids.tasks, goals: ids.goals, habitLog: ids.habitLog },
  });
  const http = createNotionHttp({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  const readFile = async (p) => {
    if (String(p).endsWith('board.config.json')) return JSON.stringify(settings);
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  };
  const adapter = createNotionAdapter({ http, configDir: CONFIG, readFile });
  const house = fake.addPage(ids.projects, { 'Project name': 'House', ID: 3 });
  const yard = fake.addPage(ids.projects, { 'Project name': 'Yard', ID: 4 });
  const hall = fake.addPage(ids.goals, { 'Goal name': 'Hallway', ID: 1, Project: [house.id] });
  const idea = fake.addPage(ids.tasks, { 'Task name': 'Shelves', ID: 1, Status: 'Not started', Tags: ['Idea', 'DO'] });
  const idea2 = fake.addPage(ids.tasks, { 'Task name': 'Hooks', ID: 2, Status: 'Not started', Tags: ['Idea'] });
  const card = fake.addPage(ids.tasks, { 'Task name': 'Paint', ID: 3, Status: 'Not started', Project: [house.id] });
  await adapter.read({ full: true, now: NOW });
  return { fake, ids, adapter, house, yard, hall, idea, idea2, card };
}

const dsPages = (w, kind) => w.fake.state.dataSources[w.ids[kind]].pages.filter((p) => !p.trashed);
const page = (w, kind, id) => dsPages(w, kind).find((p) => p.id === id);
const tagNames = (w, id) => (page(w, 'tasks', id).values.Tags || []).map((o) => w.fake.state.dataSources[w.ids.tasks].properties.Tags.options.find((x) => x.id === o).name);
const statusName = (w, id) => w.fake.state.dataSources[w.ids.tasks].properties.Status.options.find((x) => x.id === page(w, 'tasks', id).values.Status).name;
const callsFrom = (w, from) => w.fake.calls.slice(from);
const creates = (calls) => calls.filter((c) => c.method === 'POST' && c.path === '/v1/pages');
const sortPlan = (idea, project) => ({ plan: { idea: { ref: 'notion:' + idea.id, number: undefined }, project: { number: project } } });

test('R151 logging an idea creates exactly one task in the tasks data source tagged Idea, with no project', async () => {
  const w = await world();
  const from = w.fake.calls.length;
  await w.adapter.logIdea({ title: 'Put up a coat rack' });
  const made = creates(callsFrom(w, from));
  assert.equal(made.length, 1);
  assert.equal(flat(made[0].body.parent.data_source_id), flat(w.ids.tasks));
  const row = dsPages(w, 'tasks').find((p) => p.values['Task name'] === 'Put up a coat rack');
  assert.ok(row);
  assert.deepEqual(tagNames(w, row.id), ['Idea']);
  assert.deepEqual(row.values.Project || [], []);
  assert.equal(dsPages(w, 'tasks').length, 4);
});

test('R151 filing an idea tagged Idea and DO is one GET and one PATCH on that page: DO stays, Idea goes, Project is set, no page is created', async () => {
  const w = await world();
  const from = w.fake.calls.length;
  await w.adapter.fileIdea({ ...sortPlan(w.idea, 3), milestone: undefined });
  const calls = callsFrom(w, from);
  const onPage = calls.filter((c) => c.path === '/v1/pages/' + w.idea.id);
  assert.deepEqual(onPage.map((c) => c.method), ['GET', 'PATCH']);
  assert.equal(creates(calls).length, 0);
  assert.deepEqual(calls.filter((c) => c.method === 'PATCH').map((c) => c.path), ['/v1/pages/' + w.idea.id], 'one PATCH in all');
  assert.deepEqual(tagNames(w, w.idea.id), ['DO']);
  assert.deepEqual(page(w, 'tasks', w.idea.id).values.Project, [w.house.id]);
  assert.equal(dsPages(w, 'tasks').length, 3, 'no task was added');
});

test('R151 filing with a goal sets the Goal; filing without one leaves Goal empty', async () => {
  const w = await world();
  await w.adapter.fileIdea({ ...sortPlan(w.idea, 3), milestone: 1 });
  assert.deepEqual(page(w, 'tasks', w.idea.id).values.Goal, [w.hall.id]);
  await w.adapter.fileIdea({ ...sortPlan(w.idea2, 4) });
  assert.deepEqual(page(w, 'tasks', w.idea2.id).values.Project, [w.yard.id]);
  assert.deepEqual(page(w, 'tasks', w.idea2.id).values.Goal || [], []);
  assert.deepEqual(tagNames(w, w.idea2.id), [], 'Idea was its only tag');
});

test('R151 the same filing twice still creates no page; the second repeats the GET and PATCH on the same page', async () => {
  const w = await world();
  const from = w.fake.calls.length;
  await w.adapter.fileIdea({ ...sortPlan(w.idea, 3), milestone: 1 });
  await w.adapter.fileIdea({ ...sortPlan(w.idea, 3), milestone: 1 });
  const calls = callsFrom(w, from);
  assert.equal(creates(calls).length, 0);
  assert.deepEqual(calls.filter((c) => c.path === '/v1/pages/' + w.idea.id).map((c) => c.method), ['GET', 'PATCH', 'GET', 'PATCH']);
  assert.deepEqual(tagNames(w, w.idea.id), ['DO'], 'DO survives both');
  assert.equal(dsPages(w, 'tasks').length, 3);
});

test('R151 a filing whose PATCH fails creates nothing, and the retry then finishes on the same page', async () => {
  const w = await world();
  w.fake.fail((c) => c.method === 'PATCH' && c.path === '/v1/pages/' + w.idea.id, 500);
  await assert.rejects(w.adapter.fileIdea({ ...sortPlan(w.idea, 3) }));
  assert.equal(dsPages(w, 'tasks').length, 3);
  assert.deepEqual(tagNames(w, w.idea.id), ['Idea', 'DO'], 'untouched');
  const from = w.fake.calls.length;
  await w.adapter.fileIdea({ ...sortPlan(w.idea, 3) });
  assert.equal(creates(callsFrom(w, from)).length, 0);
  assert.deepEqual(tagNames(w, w.idea.id), ['DO']);
});

test('R151 closing a card sets that task Done in one PATCH', async () => {
  const w = await world();
  const from = w.fake.calls.length;
  await w.adapter.closeCard({ number: 3 });
  const writes = callsFrom(w, from).filter((c) => c.method !== 'GET' && !c.path.endsWith('/query'));
  assert.deepEqual(writes.map((c) => c.method + ' ' + c.path), ['PATCH /v1/pages/' + w.card.id]);
  assert.equal(statusName(w, w.card.id), 'Done');
  assert.equal(statusName(w, w.idea.id), 'Not started');
});

test('R151 ticking a check-in creates the Habit log row done; unticking sets it back to open', async () => {
  const w = await world();
  await w.adapter.setCheckin({ habitTitle: 'Mood', habitLabel: 'habit:mood', date: TODAY, on: true, existing: [] });
  const row = dsPages(w, 'habitLog')[0];
  assert.equal(row.values.Done, true);
  assert.equal(row.values.Name, `Mood · ${TODAY}`);
  await w.adapter.setCheckin({ habitTitle: 'Mood', habitLabel: 'habit:mood', date: TODAY, on: false, existing: [{ number: 1, state: 'closed' }] });
  assert.equal(page(w, 'habitLog', row.id).values.Done, false);
});

test('R151 scoring creates the check-in with its Score, and scoring again only sets Score', async () => {
  const w = await world();
  await w.adapter.setScore({ habitTitle: 'Mood', habitLabel: 'habit:mood', date: TODAY, score: 7, existing: [] });
  const row = dsPages(w, 'habitLog')[0];
  assert.equal(row.values.Score, 7);
  assert.equal(row.values.Done, true);
  const from = w.fake.calls.length;
  await w.adapter.setScore({ habitTitle: 'Mood', habitLabel: 'habit:mood', date: TODAY, score: 9, existing: [{ number: 1, state: 'closed' }], carrier: 1 });
  assert.equal(creates(callsFrom(w, from)).length, 0);
  assert.equal(page(w, 'habitLog', row.id).values.Score, 9);
  assert.equal(dsPages(w, 'habitLog').length, 1);
});

test('R151 filing with a goal that belongs to a different project is refused and nothing is written', async () => {
  const w = await world();
  const from = w.fake.calls.length;
  await assert.rejects(w.adapter.fileIdea({ ...sortPlan(w.idea, 4), milestone: 1 }), (e) => {
    assert.ok(!/ntn_|[0-9a-f]{32}/.test(String(e.message)), 'no ids or tokens in the refusal');
    return true;
  });
  assert.equal(callsFrom(w, from).filter((c) => c.method === 'PATCH').length, 0, 'no PATCH was sent');
  assert.deepEqual(tagNames(w, w.idea.id), ['Idea', 'DO']);
  assert.deepEqual(page(w, 'tasks', w.idea.id).values.Project || [], []);
  assert.deepEqual(page(w, 'tasks', w.idea.id).values.Goal || [], []);
});

test('R151 filing with a goal of the same project still works', async () => {
  const w = await world();
  await w.adapter.fileIdea({ ...sortPlan(w.idea, 3), milestone: 1 });
  assert.deepEqual(page(w, 'tasks', w.idea.id).values.Project, [w.house.id]);
  assert.deepEqual(page(w, 'tasks', w.idea.id).values.Goal, [w.hall.id]);
});
