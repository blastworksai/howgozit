import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { applyProposal } from '../scripts/lib/apply.mjs';
import { readAll } from '../board/github/read.mjs';
import { buildBoard } from '../board/model.mjs';
import { checkSettings } from '../board/shape-settings.mjs';
import { checkRaw, checkBoard } from '../board/shape-data.mjs';
import { todayIn } from '../board/days.mjs';

const NOW = '2026-10-12T06:10:00Z';
const REPO = 'sam-life/life';

function proposal() {
  return {
    owner: 'sam-life', repo: 'life', name: 'Sam', timezone: 'Europe/Brussels',
    projects: [
      { key: 'house', title: 'House',
        milestones: [{ title: 'Hallway', due: '2026-11-20' }],
        tasks: [{ title: 'Paint the hallway', milestone: 'Hallway', due: '2026-11-10' }, { title: 'Pick a colour' }] },
      { key: 'side', title: 'Side',
        milestones: [{ title: 'Launch' }],
        tasks: [{ title: 'Write the page', milestone: 'Launch', due: '2026-12-01' }] },
      { key: 'health', title: 'Health', tasks: [{ title: 'Book a check-up' }] },
    ],
    standalone: [{ title: 'Renew passport' }, { title: 'Call the dentist' }],
    habits: [{ id: 'move', title: 'Move', project: 'health' }, { id: 'read', title: 'Read' }],
    focus: ['house'],
  };
}

function gardenProposal() {
  return { owner: 'sam-life', repo: 'life', projects: [{ key: 'garden', title: 'Garden', tasks: [{ title: 'Plant the beds' }] }] };
}

async function boardOf(fake) {
  const { raw, texts, warnings } = await readAll(fake.http, { repo: REPO, full: true, now: NOW });
  const settings = JSON.parse(texts.settings);
  const board = buildBoard({
    raw, settings, now: NOW,
    state: { brief: null, calendar: null, inbox: null, log: null, proposals: null },
    run: { stale: null, readOnly: false, warnings },
  });
  return { raw, settings, board, texts };
}

async function setUp(opts) {
  const fake = createFakeGitHub(opts);
  let record = null;
  const saveRecord = async (r) => { record = structuredClone(r); };
  const res = await applyProposal(fake.http, proposal(), { record, saveRecord });
  assert.equal(res.ok, true, res.message);
  return { fake, get record() { return record; }, res };
}

const counts = (fake) => ({
  labels: fake.state.labels.length, projects: fake.state.projects.length,
  milestones: fake.state.milestones.length, issues: fake.state.issues.length,
});
const writes = (fake) => fake.calls.filter((c) => c.method !== 'GET');
const shownKeys = (board) => board.projects.map((p) => p.key).sort();
const titlesOf = (list) => list.map((t) => t.title).sort();

test('S6 one apply leaves raw, settings and board that all pass their checks', async () => {
  const { fake } = await setUp();
  const { raw, settings, board } = await boardOf(fake);
  const r = checkRaw(raw);
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = checkSettings(settings);
  assert.equal(s.ok, true, JSON.stringify(s));
  const b = checkBoard(board);
  assert.equal(b.ok, true, JSON.stringify(b));
});

test('S6 every proposed project is on the board with its title and total of tasks', async () => {
  const { fake } = await setUp();
  const { board } = await boardOf(fake);
  assert.deepEqual(shownKeys(board), ['health', 'house', 'side']);
  const by = Object.fromEntries(board.projects.map((p) => [p.key, p]));
  assert.equal(by.house.title, 'House');
  assert.equal(by.side.title, 'Side');
  assert.equal(by.health.title, 'Health');
  assert.equal(by.house.total, 2);
  assert.equal(by.side.total, 1);
  assert.equal(by.health.total, 1);
});

test('S6 each project task shows under its project and not under standalone', async () => {
  const { fake } = await setUp();
  const { board } = await boardOf(fake);
  const projectTasks = ['Paint the hallway', 'Pick a colour', 'Write the page', 'Book a check-up'];
  const owner = { 'Paint the hallway': 'house', 'Pick a colour': 'house', 'Write the page': 'side', 'Book a check-up': 'health' };
  const standalone = titlesOf(board.standalone.items);
  const next = board.next;
  for (const t of projectTasks) {
    assert.ok(!standalone.includes(t), t + ' must not be standalone');
    const inNext = next.find((n) => n.title === t);
    if (inNext) assert.equal(inNext.project && inNext.project.key, owner[t], t);
  }
  assert.ok(next.some((n) => n.title === 'Paint the hallway'), 'a dated project task is in next');
  assert.equal(board.projects.reduce((a, p) => a + p.total, 0), projectTasks.length);
});

test('S6 the two standalone tasks are under standalone and under no project', async () => {
  const { fake } = await setUp();
  const { board } = await boardOf(fake);
  assert.equal(board.standalone.count, 2);
  assert.deepEqual(titlesOf(board.standalone.items), ['Call the dentist', 'Renew passport']);
  for (const n of board.next) {
    if (['Renew passport', 'Call the dentist'].includes(n.title)) assert.equal(n.project, null);
  }
  assert.equal(board.projects.reduce((a, p) => a + p.total, 0), 4);
});

test('S6 milestones sit in their own project lane with their short titles and none is in other', async () => {
  const { fake } = await setUp();
  const { board } = await boardOf(fake);
  assert.deepEqual(board.timeline.other, []);
  const lane = (key) => board.timeline.lanes.find((l) => l.project.key === key);
  const all = (key) => lane(key).milestones.concat(lane(key).undated).concat([]);
  assert.deepEqual(all('house').map((m) => m.shortTitle), ['Hallway']);
  assert.deepEqual(all('side').map((m) => m.shortTitle), ['Launch']);
  const health = lane('health');
  assert.deepEqual(health ? all('health') : [], []);
});

test('S6 due dates on the board are the proposal dates', async () => {
  const { fake } = await setUp();
  const { board } = await boardOf(fake);
  const paint = board.next.find((n) => n.title === 'Paint the hallway');
  assert.ok(paint, 'Paint the hallway is in next');
  assert.equal(paint.due, '2026-11-10');
  const write = board.next.find((n) => n.title === 'Write the page');
  assert.ok(write, 'Write the page is in next');
  assert.equal(write.due, '2026-12-01');
  const hallway = board.timeline.lanes.find((l) => l.project.key === 'house').milestones.find((m) => m.shortTitle === 'Hallway');
  assert.equal(hallway.due, '2026-11-20');
  const launch = board.timeline.lanes.find((l) => l.project.key === 'side').undated.find((m) => m.shortTitle === 'Launch');
  assert.equal(launch.due, null);
});

test('S6 both habits are on the board and move is linked to Health', async () => {
  const { fake } = await setUp();
  const { board } = await boardOf(fake);
  assert.deepEqual(board.habits.map((h) => h.id), ['move', 'read']);
  const move = board.habits.find((h) => h.id === 'move');
  const read = board.habits.find((h) => h.id === 'read');
  assert.equal(move.project && move.project.key, 'health');
  assert.equal(read.project, null);
  const health = board.projects.find((p) => p.key === 'health');
  assert.deepEqual(health.habits.map((h) => h.id), ['move']);
});

test('S6 focus is House', async () => {
  const { fake } = await setUp();
  const { board } = await boardOf(fake);
  assert.deepEqual(board.focus.projects.map((p) => p.key), ['house']);
  assert.equal(board.projects.find((p) => p.key === 'house').focus, true);
  assert.equal(board.projects.find((p) => p.key === 'side').focus, false);
});

test('S6 the board has zero warnings after one apply', async () => {
  const { fake } = await setUp();
  const { board } = await boardOf(fake);
  assert.deepEqual(board.meta.warnings, []);
});

test('S8 a second apply with the saved record changes nothing on the board or on GitHub', async () => {
  const world = await setUp();
  const { fake } = world;
  const first = await boardOf(fake);
  const before = counts(fake);
  const callsBefore = fake.calls.length;
  const again = await applyProposal(fake.http, proposal(), { record: structuredClone(world.record), saveRecord: async () => {} });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.created, 0);
  assert.deepEqual(writes({ calls: fake.calls.slice(callsBefore) }), []);
  assert.deepEqual(counts(fake), before);
  assert.equal(before.labels, 3);
  assert.equal(before.projects, 3);
  assert.equal(before.milestones, 2);
  assert.equal(before.issues, 6);
  const second = await boardOf(fake);
  assert.deepEqual(second.board, first.board);
});

test('S6 a later apply of one new project adds it and leaves the first three as they were', async () => {
  const world = await setUp();
  const { fake } = world;
  const first = await boardOf(fake);
  const res = await applyProposal(fake.http, gardenProposal(), { record: structuredClone(world.record), saveRecord: async (r) => { world.rec2 = r; } });
  assert.equal(res.ok, true, res.message);
  const second = await boardOf(fake);
  assert.deepEqual(shownKeys(second.board), ['garden', 'health', 'house', 'side']);
  for (const key of ['house', 'side', 'health']) {
    assert.deepEqual(
      second.board.projects.find((p) => p.key === key),
      first.board.projects.find((p) => p.key === key), key);
  }
  assert.equal(second.board.projects.find((p) => p.key === 'garden').total, 1);
  assert.equal(checkSettings(second.settings).ok, true);
  assert.equal(second.settings.name, 'Sam');
  assert.equal(second.settings.timezone, 'Europe/Brussels');
  for (const p of first.settings.projects) assert.ok(second.settings.projects.some((q) => q.key === p.key && q.number === p.number));
  assert.deepEqual(second.settings.habits, first.settings.habits);
  assert.deepEqual(second.settings.focus, first.settings.focus);
  assert.deepEqual(second.board.meta.warnings, []);
});

test('S8 the same round trip on a user-owned world shows the three projects', async () => {
  const { fake } = await setUp({ ownerType: 'user' });
  const { board, raw } = await boardOf(fake);
  assert.equal(checkRaw(raw).ok, true);
  assert.deepEqual(shownKeys(board), ['health', 'house', 'side']);
  assert.deepEqual(board.projects.map((p) => p.total).sort(), [1, 1, 2]);
  assert.deepEqual(board.meta.warnings, []);
});

test('U the labels setup created are the labels the board reads for ideas and check-ins', async () => {
  const { fake } = await setUp();
  const today = todayIn('Europe/Brussels', NOW);
  await fake.http.send('POST', `/repos/${REPO}/issues`, { title: 'Shelves for the hallway', labels: ['idea'] });
  const made = await fake.http.send('POST', `/repos/${REPO}/issues`, { title: 'Move · ' + today, labels: ['habit:move'] });
  await fake.http.send('PATCH', `/repos/${REPO}/issues/${made.number}`, { state: 'closed' });
  // the fake stamps closed_at from its own counter (1 Oct), so put the close on the board's day
  fake.state.issues.find((i) => i.number === made.number).closed_at = '2026-10-12T05:30:00Z';
  const { board } = await boardOf(fake);
  assert.equal(board.ideas.count, 1);
  assert.equal(board.ideas.items[0].title, 'Shelves for the hallway');
  const move = board.habits.find((h) => h.id === 'move');
  assert.equal(move.doneToday, true);
  assert.equal(board.habits.find((h) => h.id === 'read').doneToday, false);
});
