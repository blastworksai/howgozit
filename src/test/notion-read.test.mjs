// R144, R145, R146: how the Notion reader numbers rows, merges changes and reads long relations.
// Built to cp9-interface.md §1 and §2 on the fake Notion; no clock, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { seedHowgozit } from '../fixtures/notion-howgozit.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createStore, readNotion } from '../board/notion/read.mjs';
import { settings as baseSettings } from '../fixtures/build.mjs';

// The four data source ids, set by world() from seedHowgozit (tests in a file run one after another).
let PROJECTS, TASKS, GOALS, HABITS; // dashed, as the fake hands them out; flat() is the 32-hex form
const TOKEN = 'ntn_fake_token';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-12T06:10:00Z');
const iso = (ms) => new Date(ms).toISOString();

async function world() {
  const fake = createFakeNotion({ token: TOKEN });
  ({ projects: PROJECTS, tasks: TASKS, goals: GOALS, habitLog: HABITS } = await seedHowgozit(fake, { habits: ['mood'] }));
  const http = createNotionHttp({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  const settings = baseSettings({ notion: { projects: PROJECTS, tasks: TASKS, goals: GOALS, habitLog: HABITS } });
  return { fake, http, settings, store: createStore() };
}

// The pages of a data source as the fake holds them (live state), for tests that need a shape the API cannot write.
const pagesOf = (fake, ds) => fake.state.dataSources[ds].pages;

// Requests to one data source's query route made after call index `from`.
const flat = (id) => id.replace(/-/g, '');
const queriesOf = (fake, ds, from = 0) => fake.calls.slice(from).filter((c) => c.method === 'POST' && c.path.replace(/-/g, '').startsWith('/v1/data_sources/' + flat(ds) + '/query'));

// Finds the last_edited_time timestamp filter anywhere in a (possibly `and`-wrapped) filter.
function timestampFilter(filter) {
  if (!filter || typeof filter !== 'object') return null;
  if (filter.timestamp === 'last_edited_time') return filter;
  if (Array.isArray(filter.and)) for (const f of filter.and) { const hit = timestampFilter(f); if (hit) return hit; }
  return null;
}

test('R144 a card is numbered by its ID property and its ref is notion:<page id>; a card without an ID is skipped and counted', async () => {
  const w = await world();
  const seven = w.fake.addPage(TASKS, { 'Task name': 'Seven', ID: 7, Status: 'Not started' }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb07', created: '2026-10-01T08:00:00Z', edited: '2026-10-01T08:00:00Z' });
  const none = w.fake.addPage(TASKS, { 'Task name': 'No number', Status: 'Not started' }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb08', created: '2026-10-01T08:00:00Z', edited: '2026-10-01T08:00:00Z' });
  // The fake assigns an ID on create; Notion can hold a row with none, so take it away in the live world.
  pagesOf(w.fake, TASKS).find((p) => p.id === none.id).values.ID = null;

  const { raw, warnings } = await readNotion(w.http, w.store, { settings: w.settings, full: true, now: iso(T0) });

  const cards = raw.issues.filter((i) => i.repo === 'notion');
  assert.equal(cards.length, 1, JSON.stringify(cards.map((c) => c.title)));
  assert.equal(cards[0].title, 'Seven');
  assert.equal(cards[0].number, 7);
  assert.equal(cards[0].ref, 'notion:' + seven.id);
  assert.equal(raw.issues.some((i) => i.title === 'No number'), false);
  const skipped = warnings.filter((x) => x.code === 'row-skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].count, 1);
});

test('R144 a goal is numbered by its ID property too, and a goal without one is skipped and counted', async () => {
  const w = await world();
  w.fake.addPage(GOALS, { 'Goal name': 'Hallway', ID: 2 }, { id: 'cccccccccccccccccccccccccccccc02', created: '2026-10-01T08:00:00Z', edited: '2026-10-01T08:00:00Z' });
  const none = w.fake.addPage(GOALS, { 'Goal name': 'Nameless number' }, { id: 'cccccccccccccccccccccccccccccc03', created: '2026-10-01T08:00:00Z', edited: '2026-10-01T08:00:00Z' });
  pagesOf(w.fake, GOALS).find((p) => p.id === none.id).values.ID = null;

  const { raw, warnings } = await readNotion(w.http, w.store, { settings: w.settings, full: true, now: iso(T0) });

  assert.equal(raw.milestones.length, 1, JSON.stringify(raw.milestones));
  assert.equal(raw.milestones[0].number, 2);
  assert.match(raw.milestones[0].title, /Hallway$/);
  const skipped = warnings.filter((x) => x.code === 'row-skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].count, 1);
});

// A world with a full read behind it: card A is older than the delta window, card B sits inside it.
async function afterFirstRead() {
  const w = await world();
  const a = w.fake.addPage(TASKS, { 'Task name': 'Old card', ID: 1, Status: 'Not started' }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01', created: '2026-10-01T08:00:00Z', edited: '2026-10-12T06:00:00Z' });
  const b = w.fake.addPage(TASKS, { 'Task name': 'Busy card', ID: 2, Status: 'Not started' }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02', created: '2026-10-01T08:00:00Z', edited: '2026-10-12T06:08:00Z' });
  const first = await readNotion(w.http, w.store, { settings: w.settings, full: true, now: iso(T0) });
  return { w, a, b, first };
}

const titlesOf = (raw) => raw.issues.filter((i) => i.repo === 'notion').map((i) => i.title).sort();

test('R145 a delta read merges a row that changed since the last read and keeps the rest', async () => {
  const { w, first } = await afterFirstRead();
  assert.deepEqual(titlesOf(first.raw), ['Busy card', 'Old card']);

  // Notion stamps this edit later than every time seen so far, inside the window of the next read.
  await w.http.request('PATCH', '/v1/pages/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb02', { properties: { title: { title: [{ type: 'text', text: { content: 'Busy card, renamed' } }] } } });

  const second = await readNotion(w.http, w.store, { settings: w.settings, full: false, now: iso(T0 + 10 * MIN) });

  assert.deepEqual(titlesOf(second.raw), ['Busy card, renamed', 'Old card']);
  const numbers = second.raw.issues.filter((i) => i.repo === 'notion').map((i) => i.number).sort();
  assert.deepEqual(numbers, [1, 2], 'merged by ref, not added twice');
});

test('R145 the delta query filters on last_edited_time after the last read minus five minutes; the full read does not', async () => {
  const { w } = await afterFirstRead();
  const firstQueries = queriesOf(w.fake, TASKS);
  assert.ok(firstQueries.length >= 1);
  for (const q of firstQueries) assert.equal(timestampFilter(q.body && q.body.filter), null, 'a full read asks for every row');

  const before = w.fake.calls.length;
  const nowMs = T0 + 10 * MIN;
  await readNotion(w.http, w.store, { settings: w.settings, full: false, now: iso(nowMs) });

  for (const ds of [PROJECTS, TASKS, GOALS, HABITS]) {
    const qs = queriesOf(w.fake, ds, before);
    assert.ok(qs.length >= 1, 'a delta read queries ' + ds);
    for (const q of qs) {
      const f = timestampFilter(q.body && q.body.filter);
      assert.ok(f, 'the delta query of ' + ds + ' carries the last_edited_time filter');
      // The window starts at the adapter's own last read (the first read, T0), minus five minutes.
      assert.equal(Date.parse(f.last_edited_time.on_or_after), T0 - 5 * MIN);
    }
  }
});

test('R145 a deleted row is still there after a delta read and gone after the next full read', async () => {
  const { w } = await afterFirstRead();
  w.fake.trash('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01');

  const delta = await readNotion(w.http, w.store, { settings: w.settings, full: false, now: iso(T0 + 10 * MIN) });
  assert.ok(titlesOf(delta.raw).includes('Old card'), 'a delta read drops nothing');
  assert.ok(titlesOf(delta.raw).includes('Busy card'));

  const full = await readNotion(w.http, w.store, { settings: w.settings, full: true, now: iso(T0 + 20 * MIN) });
  assert.deepEqual(titlesOf(full.raw), ['Busy card']);
});

test('R145 a failed delta read changes nothing that was held', async () => {
  const { w } = await afterFirstRead();
  w.fake.fail((c) => c.method === 'POST' && c.path.replace(/-/g, '').includes(flat(GOALS)), 500);
  await assert.rejects(readNotion(w.http, w.store, { settings: w.settings, full: false, now: iso(T0 + 10 * MIN) }));
  // the store still answers as before: a later successful delta read finds both cards
  const again = await readNotion(w.http, w.store, { settings: w.settings, full: false, now: iso(T0 + 11 * MIN) });
  assert.deepEqual(titlesOf(again.raw), ['Busy card', 'Old card']);
});

const waitingOf = (raw, title) => {
  const hit = raw.issues.find((i) => i.title === title);
  assert.ok(hit, 'card ' + title);
  return hit.waitingOn || [];
};

test('R146 a relation of 60 values is read whole, not cut at 25', async () => {
  const w = await world();
  const ids = [];
  for (let i = 1; i <= 60; i += 1) {
    const id = 'dddddddddddddddddddddddddddd' + String(i).padStart(4, '0');
    ids.push(id);
    w.fake.addPage(TASKS, { 'Task name': 'Blocker ' + i, Status: 'Not started' }, { id, created: '2026-10-01T08:00:00Z', edited: '2026-10-01T08:00:00Z' });
  }
  w.fake.addPage(TASKS, { 'Task name': 'Blocked card', Status: 'Not started', 'Blocked by': ids }, { id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', created: '2026-10-01T08:00:00Z', edited: '2026-10-01T08:00:00Z' });

  const { raw, warnings } = await readNotion(w.http, w.store, { settings: w.settings, full: true, now: iso(T0) });

  const waiting = waitingOf(raw, 'Blocked card');
  assert.equal(new Set(waiting.map((x) => x.ref)).size, 60, 'all 60 blockers read');
  assert.equal(warnings.some((x) => x.code === 'too-much-data'), false);
  assert.equal(raw.partial.items, false);
  const propertyReads = w.fake.calls.filter((c) => c.method === 'GET' && /^\/v1\/pages\/[^/]+\/properties\//.test(c.path));
  assert.ok(propertyReads.length >= 2 && propertyReads.length <= 3, 'the property item was paged: ' + propertyReads.length);
});

test('R146 a relation that needs more than 20 pages stops with partial and too-much-data', async () => {
  const w = await world();
  const target = w.fake.addPage(TASKS, { 'Task name': 'Huge relation', Status: 'Not started' }, { id: 'ffffffffffffffffffffffffffffffff', created: '2026-10-01T08:00:00Z', edited: '2026-10-01T08:00:00Z' });
  // 700 values is 28 pages of 25. The write route refuses more than 100, so set them in the live world.
  const many = [];
  for (let i = 1; i <= 700; i += 1) many.push('00000000-0000-4000-9000-' + i.toString(16).padStart(12, '0'));
  pagesOf(w.fake, TASKS).find((p) => p.id === target.id).values['Blocked by'] = many;

  const { raw, warnings } = await readNotion(w.http, w.store, { settings: w.settings, full: true, now: iso(T0) });

  assert.equal(raw.partial.items, true);
  assert.ok(warnings.some((x) => x.code === 'too-much-data'), JSON.stringify(warnings));
  assert.ok(raw.issues.some((i) => i.title === 'Huge relation'), 'what was read is kept');
  const propertyReads = w.fake.calls.filter((c) => c.method === 'GET' && /^\/v1\/pages\/[^/]+\/properties\//.test(c.path));
  assert.ok(propertyReads.length >= 1 && propertyReads.length <= 20, 'at most 20 pages: ' + propertyReads.length);
});

test('R143 a Habits number that a listed project already uses is ignored and counted as setting-invalid', async () => {
  const w = await world();
  w.fake.addPage(PROJECTS, { 'Project name': 'House', ID: 3 }, { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03', created: '2026-10-01T08:00:00Z', edited: '2026-10-01T08:00:00Z' });
  w.settings = { ...w.settings, projects: [{ key: 'house', number: 3, owner: 'notion' }], habitsProject: { owner: 'notion', number: 3 } };

  const { raw, warnings } = await readNotion(w.http, w.store, { settings: w.settings, full: true, now: iso(T0) });

  assert.equal(raw.projects.some((p) => p.role === 'habits'), false, 'no Habits role row');
  assert.equal(raw.projects.filter((p) => p.number === 3).length, 1, 'the listed project stays');
  assert.deepEqual(warnings.filter((x) => x.code === 'setting-invalid'), [{ code: 'setting-invalid', count: 1 }]);

  const ok = await world();
  ok.settings = { ...ok.settings, habitsProject: { owner: 'notion', number: 999 } };
  const again = await readNotion(ok.http, ok.store, { settings: ok.settings, full: true, now: iso(T0) });
  assert.equal(again.raw.projects.some((p) => p.role === 'habits'), true);
  assert.equal(again.warnings.some((x) => x.code === 'setting-invalid'), false);
});
