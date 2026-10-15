// R56, R57, R59, R61 and R140 on a Notion board: the five actions through the real handlers, a real guard (signed form tokens),
// a real loader and the real Notion adapter, over the stand-in Notion (fixtures/fake-notion.mjs).
// Written from the rule text (references/contract.md) and reference/mapping-redesign/cp9-interface.md sections 0, 4 and 5,
// never from write.mjs or adapter.mjs. A card and an idea are BOTH numbered 1 on purpose: each action must find its own row.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { createGuard } from '../board/guard.mjs';
import { createHandlers } from '../board/handlers.mjs';
import { createLoader } from '../board/load.mjs';
import { NOW, settings } from '../fixtures/build.mjs';

const TOKEN = 'ntn_SENTINEL_token_4711';
const FORM_KEY = 'f'.repeat(16) + 'ORM-KEY-SENTINEL-' + 'z'.repeat(8);
const HOST = 'localhost:8787';
const CONFIG = '/srv/board-config';
const TODAY = '2026-10-12'; // NOW is 06:10 UTC, 08:10 in Brussels
const YESTERDAY = '2026-10-11';

const PROJECTS = '1000000000000000000000000000000a';
const CARDS = '1000000000000000000000000000000b';
const GOALS = '1000000000000000000000000000000c';
const IDEAS = '1000000000000000000000000000000d';
const HABITS = '1000000000000000000000000000000e';

const dashed = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const pid = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P_HOUSE = pid(1);
const G_HALL = pid(2);
const C_PAINT = pid(10); // card 1
const C_BUY = pid(11); // card 2
const C_SAND = pid(12); // card 3, done
const I_SHELVES = pid(20); // idea 1 (same number as card 1)
const I_HOOKS = pid(21); // idea 5, no card 5
const H_YESTERDAY = pid(30); // habit log row 1, yesterday

const SCHEMA = {
  [PROJECTS]: { properties: { Name: { type: 'title' }, ID: { type: 'unique_id' } } },
  [CARDS]: {
    properties: {
      Name: { type: 'title' },
      ID: { type: 'unique_id' },
      Status: {
        type: 'status',
        options: [{ name: 'Not started' }, { name: 'In progress' }, { name: 'Done' }],
        groups: [
          { name: 'To-do', option_ids: ['Not started'] },
          { name: 'In progress', option_ids: ['In progress'] },
          { name: 'Complete', option_ids: ['Done'] },
        ],
      },
      Project: { type: 'relation', data_source_id: PROJECTS },
      Goal: { type: 'relation', data_source_id: GOALS },
      'Blocked by': { type: 'relation', data_source_id: CARDS },
      Mode: { type: 'select', options: [{ name: 'DO', color: 'green' }] },
      Due: { type: 'date' },
    },
  },
  [GOALS]: {
    properties: {
      Name: { type: 'title' }, ID: { type: 'unique_id' }, Project: { type: 'relation', data_source_id: PROJECTS }, Due: { type: 'date' }, Done: { type: 'checkbox' },
    },
  },
  [IDEAS]: { properties: { Name: { type: 'title' }, ID: { type: 'unique_id' }, Filed: { type: 'checkbox' } } },
  [HABITS]: {
    properties: {
      Name: { type: 'title' },
      ID: { type: 'unique_id' },
      Habit: { type: 'select', options: [{ name: 'move' }, { name: 'mood' }] },
      Date: { type: 'date' },
      Done: { type: 'checkbox' },
      Score: { type: 'number' },
    },
  },
};

const HABIT_LIST = [
  { id: 'move', title: 'Move', start: '2026-10-01' },
  { id: 'mood', title: 'Mood', start: '2026-10-01', score: { min: 1, max: 10 } },
];

const SETTINGS = settings({
  projects: [{ key: 'house', number: 3 }],
  habits: HABIT_LIST,
  habitsProject: { owner: 'notion', number: 1 },
  notion: { projects: PROJECTS, cards: CARDS, goals: GOALS, ideas: IDEAS, habitLog: HABITS },
});

// seed(fake) fills the world; `habitRows` are extra Habit log rows { id, habit, date, done, score? }.
function seed(fake, { habitRows = [] } = {}) {
  fake.addPage(PROJECTS, { Name: 'House', ID: 3 }, { id: P_HOUSE });
  fake.addPage(GOALS, { Name: 'Hallway', ID: 1, Project: [P_HOUSE], Due: '2026-10-20' }, { id: G_HALL });
  fake.addPage(CARDS, { Name: 'Paint the hallway', ID: 1, Status: 'Not started', Project: [P_HOUSE], Goal: [G_HALL] }, { id: C_PAINT });
  fake.addPage(CARDS, { Name: 'Buy paint', ID: 2, Status: 'In progress', Project: [P_HOUSE], Goal: [G_HALL] }, { id: C_BUY });
  fake.addPage(CARDS, { Name: 'Sand the door', ID: 3, Status: 'Done', Project: [P_HOUSE], Goal: [G_HALL] }, { id: C_SAND, edited: '2026-10-05T09:00:00Z' });
  fake.addPage(IDEAS, { Name: 'Shelves for the hall', ID: 1, Filed: false }, { id: I_SHELVES });
  fake.addPage(IDEAS, { Name: 'Hooks by the door', ID: 5, Filed: false }, { id: I_HOOKS });
  fake.addPage(HABITS, { Name: `Move · ${YESTERDAY}`, ID: 1, Habit: 'move', Date: YESTERDAY, Done: true }, { id: H_YESTERDAY });
  let n = 40;
  for (const r of habitRows) {
    fake.addPage(HABITS, {
      Name: `${r.habit === 'mood' ? 'Mood' : 'Move'} · ${r.date}`, ID: r.id, Habit: r.habit, Date: r.date, Done: r.done, ...(r.score === undefined ? {} : { Score: r.score }),
    }, { id: pid(n++) });
  }
}

function setup(opts = {}) {
  const fake = createFakeNotion({ token: TOKEN, dataSources: SCHEMA });
  seed(fake, opts);
  const http = createNotionHttp({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  const files = { 'board.config.json': JSON.stringify(SETTINGS) };
  const readFile = async (p) => {
    const prefix = path.join(CONFIG, 'x').slice(0, -1); // portable: the product joins with path.join, so a Windows path uses backslashes
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
  return { fake, h, guard, loader };
}

const req = (url) => ({
  method: 'POST',
  url,
  headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
});
const post = (s, name, form) => s.h.action(name, req(`/actions/${name}`), form);

// The forms the page would post, each with a token signed for its target (the same targets the page uses).
const forms = {
  idea: (s, title) => ({ token: s.guard.formToken('idea', 'new'), title }),
  habit: (s, id, on, date = TODAY) => ({ token: s.guard.formToken('habit', `${id}:${date}:${on === '1' ? 'on' : 'off'}`), id, date, on }),
  score: (s, id, score, date = TODAY) => ({ token: s.guard.formToken('score', `${id}:${date}:score`), id, date, score }),
  sort: (s, number, target) => ({ token: s.guard.formToken('sort', number), number, target }),
  close: (s, number) => ({ token: s.guard.formToken('close', number), number }),
};

// ---- reading the stand-in's world ----
const ds = (s, id) => s.fake.state.dataSources[dashed(id)];
const pageOf = (s, dsId, pageId) => ds(s, dsId).pages.find((p) => p.id === pageId);
const live = (s, dsId) => ds(s, dsId).pages.filter((p) => !p.trashed);
const optionName = (s, dsId, prop, optionId) => {
  const o = ds(s, dsId).properties[prop].options.find((x) => x.id === optionId);
  return o ? o.name : null;
};
const status = (s, pageId) => optionName(s, CARDS, 'Status', pageOf(s, CARDS, pageId).values.Status);
const isWrite = (c) => c.method === 'PATCH' || (c.method === 'POST' && c.path === '/v1/pages');
function track(s) {
  const from = s.fake.calls.length;
  return () => s.fake.calls.slice(from).filter(isWrite);
}
const habitRowsOf = (s) => live(s, HABITS).map((p) => ({
  id: p.id, name: p.values.Name, habit: optionName(s, HABITS, 'Habit', p.values.Habit), date: p.values.Date && p.values.Date.start, done: p.values.Done === true, score: p.values.Score ?? null,
}));
const todays = (s, habit) => habitRowsOf(s).filter((r) => r.habit === habit && r.date === TODAY);

function assertRefusal(res, status = 400) {
  assert.equal(res.status, status);
  assert.ok(typeof res.body === 'string' && res.body.length > 0);
}
const assertDone = (res) => {
  assert.equal(res.status, 303, 'the action redirects');
  assert.equal(res.headers.location, '/');
};

// ---------- R56 ----------

test('R56 logging an idea on a Notion board creates one idea row with the cleaned title, and leaves the numbered rows alone', async () => {
  const s = setup();
  const writes = track(s);
  const res = await post(s, 'idea', forms.idea(s, '  Shelves\n for   the hall  '));
  assertDone(res);
  const w = writes();
  assert.equal(w.length, 1, 'one write');
  assert.equal(w[0].method, 'POST');
  assert.equal(w[0].path, '/v1/pages');
  assert.equal(live(s, IDEAS).length, 3);
  const made = live(s, IDEAS).find((p) => !p.id.startsWith('20000000'));
  assert.equal(made.values.Name, 'Shelves for the hall');
  assert.ok(!made.values.Filed, 'an open idea');
  assert.equal(live(s, CARDS).length, 3, 'no card was made');
  assert.equal(pageOf(s, IDEAS, I_SHELVES).values.Filed, false, 'idea 1 is untouched');
});

test('R56 a logged idea shows on the page after the redirect', async () => {
  const s = setup();
  assertDone(await post(s, 'idea', forms.idea(s, 'Put up a coat rack')));
  const page = await s.h.page();
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('Put up a coat rack'));
});

test('R56 spaces only, and 201 characters, are refused with a plain message and nothing is created', async () => {
  const s = setup();
  const writes = track(s);
  assertRefusal(await post(s, 'idea', forms.idea(s, '   \n  ')));
  assertRefusal(await post(s, 'idea', forms.idea(s, 'x'.repeat(201))));
  assert.deepEqual(writes(), []);
  assert.equal(live(s, IDEAS).length, 2);
});

test('R56 a title of exactly 200 characters is accepted', async () => {
  const s = setup();
  assertDone(await post(s, 'idea', forms.idea(s, 'y'.repeat(200))));
  assert.equal(live(s, IDEAS).length, 3);
});

// ---------- R57 ----------

test('R57 with no check-in today, one is created for the habit and done; yesterday is left alone', async () => {
  const s = setup();
  const writes = track(s);
  assertDone(await post(s, 'habit', forms.habit(s, 'move', '1')));
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].path, '/v1/pages');
  const t = todays(s, 'move');
  assert.equal(t.length, 1);
  assert.equal(t[0].name, `Move · ${TODAY}`);
  assert.equal(t[0].done, true);
  const y = habitRowsOf(s).find((r) => r.id === H_YESTERDAY);
  assert.equal(y.date, YESTERDAY);
  assert.equal(y.done, true);
  assert.equal(habitRowsOf(s).length, 2);
});

test('R57 an open check-in is closed: one update, no new row', async () => {
  const s = setup({ habitRows: [{ id: 2, habit: 'move', date: TODAY, done: false }] });
  const writes = track(s);
  assertDone(await post(s, 'habit', forms.habit(s, 'move', '1')));
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].method, 'PATCH');
  assert.equal(habitRowsOf(s).length, 2, 'no row was added (yesterday and today)');
  assert.equal(todays(s, 'move')[0].done, true);
});

test('R57 a check-in already done today is left alone: no request that writes', async () => {
  const s = setup({ habitRows: [{ id: 2, habit: 'move', date: TODAY, done: true }] });
  const writes = track(s);
  assertDone(await post(s, 'habit', forms.habit(s, 'move', '1')));
  assert.deepEqual(writes(), []);
  assert.equal(todays(s, 'move').length, 1);
});

test('R57 unticking reopens the done check-in of today and nothing else', async () => {
  const s = setup({ habitRows: [{ id: 2, habit: 'move', date: TODAY, done: true }] });
  const writes = track(s);
  assertDone(await post(s, 'habit', forms.habit(s, 'move', '0')));
  assert.equal(writes().length, 1);
  assert.equal(todays(s, 'move')[0].done, false);
  assert.equal(habitRowsOf(s).find((r) => r.id === H_YESTERDAY).done, true, 'yesterday stays done');
});

test('R57 an unknown habit, a date that is not today and a habit that takes a score are refused with no write', async () => {
  const s = setup();
  const writes = track(s);
  assertRefusal(await post(s, 'habit', forms.habit(s, 'nope', '1')));
  assertRefusal(await post(s, 'habit', forms.habit(s, 'move', '1', YESTERDAY)));
  assertRefusal(await post(s, 'habit', forms.habit(s, 'mood', '1')));
  assert.deepEqual(writes(), []);
});

// ---------- R59 ----------

test('R59 sorting idea 1 by hand adds a card in the project with the goal, files idea 1 and leaves card 1 alone', async () => {
  const s = setup();
  const writes = track(s);
  assertDone(await post(s, 'sort', forms.sort(s, '1', 'house/1')));
  const cards = live(s, CARDS);
  assert.equal(cards.length, 4, 'one new card');
  const made = cards.find((p) => !p.id.startsWith('20000000'));
  assert.equal(made.values.Name, 'Shelves for the hall');
  assert.deepEqual(made.values.Project, [P_HOUSE]);
  assert.deepEqual(made.values.Goal, [G_HALL]);
  assert.equal(pageOf(s, IDEAS, I_SHELVES).values.Filed, true, 'idea 1 is filed');
  assert.ok(!pageOf(s, IDEAS, I_HOOKS).values.Filed, 'idea 5 is not');
  const card1 = pageOf(s, CARDS, C_PAINT);
  assert.equal(card1.values.Name, 'Paint the hallway');
  assert.equal(status(s, C_PAINT), 'Not started');
  assert.ok(!writes().some((c) => c.path === '/v1/pages/' + C_PAINT), 'card 1 was never written');
});

test('R59 a sort with no goal puts the card in the project with no goal', async () => {
  const s = setup();
  assertDone(await post(s, 'sort', forms.sort(s, '1', 'house')));
  const made = live(s, CARDS).find((p) => !p.id.startsWith('20000000'));
  assert.deepEqual(made.values.Project, [P_HOUSE]);
  assert.ok(!made.values.Goal || made.values.Goal.length === 0);
  assert.equal(pageOf(s, IDEAS, I_SHELVES).values.Filed, true);
});

test('R59 idea 5, which has no card of that number, is sorted by its own number', async () => {
  const s = setup();
  assertDone(await post(s, 'sort', forms.sort(s, '5', 'house')));
  assert.equal(pageOf(s, IDEAS, I_HOOKS).values.Filed, true);
  assert.ok(!pageOf(s, IDEAS, I_SHELVES).values.Filed);
  assert.equal(live(s, CARDS).find((p) => !p.id.startsWith('20000000')).values.Name, 'Hooks by the door');
});

test('R59 when marking the idea filed fails, the card stays, the answer names the step, and posting again finishes without a second card', async () => {
  const s = setup();
  s.fake.fail((c) => c.method === 'PATCH' && c.path === '/v1/pages/' + I_SHELVES, 500);
  const first = await post(s, 'sort', forms.sort(s, '1', 'house/1'));
  assertRefusal(first, 502);
  assert.match(first.body, /marking the idea filed/);
  assert.equal(live(s, CARDS).length, 4, 'the earlier step stays');
  assert.ok(!pageOf(s, IDEAS, I_SHELVES).values.Filed, 'the idea is still an idea');
  const second = await post(s, 'sort', forms.sort(s, '1', 'house/1'));
  assertDone(second);
  assert.equal(live(s, CARDS).length, 4, 'no second card');
  assert.equal(pageOf(s, IDEAS, I_SHELVES).values.Filed, true);
});

test('R59 a task number, an unknown number, an unknown project and a filed idea are refused with no write', async () => {
  const s = setup();
  const writes = track(s);
  assertRefusal(await post(s, 'sort', forms.sort(s, '2', 'house')));
  assertRefusal(await post(s, 'sort', forms.sort(s, '99', 'house')));
  assertRefusal(await post(s, 'sort', forms.sort(s, '1', 'nope')));
  assert.deepEqual(writes(), []);
  assertDone(await post(s, 'sort', forms.sort(s, '1', 'house')));
  const again = track(s);
  assertRefusal(await post(s, 'sort', forms.sort(s, '1', 'house')));
  assert.deepEqual(again(), [], 'a filed idea is not sorted twice');
});

// ---------- R61 ----------

test('R61 closing task 1 sets that card Done and does not touch idea 1', async () => {
  const s = setup();
  const writes = track(s);
  assertDone(await post(s, 'close', forms.close(s, '1')));
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].method, 'PATCH');
  assert.equal(w[0].path, '/v1/pages/' + C_PAINT);
  assert.equal(status(s, C_PAINT), 'Done');
  assert.equal(status(s, C_BUY), 'In progress');
  assert.ok(!pageOf(s, IDEAS, I_SHELVES).values.Filed, 'idea 1 is untouched');
  assert.equal(live(s, IDEAS).length, 2);
});

test('R61 an idea, a closed task, an unknown number and a non-number are refused with no write', async () => {
  const s = setup();
  const writes = track(s);
  assertRefusal(await post(s, 'close', forms.close(s, '5')));
  assertRefusal(await post(s, 'close', forms.close(s, '3')));
  assertRefusal(await post(s, 'close', forms.close(s, '99')));
  assertRefusal(await post(s, 'close', forms.close(s, 'abc')));
  assert.deepEqual(writes(), []);
});

test('R61 closing another task closes that one, whatever number the idea has', async () => {
  const s = setup();
  assertDone(await post(s, 'close', forms.close(s, '2')));
  assert.equal(status(s, C_BUY), 'Done');
  assert.equal(status(s, C_PAINT), 'Not started');
});

// ---------- R140 ----------

test('R140 with no check-in today, a score creates the check-in done with its Score', async () => {
  const s = setup();
  const writes = track(s);
  assertDone(await post(s, 'score', forms.score(s, 'mood', '7')));
  assert.equal(writes().length, 1);
  const t = todays(s, 'mood');
  assert.equal(t.length, 1);
  assert.equal(t[0].name, `Mood · ${TODAY}`);
  assert.equal(t[0].done, true);
  assert.equal(t[0].score, 7);
  assert.equal(habitRowsOf(s).find((r) => r.id === H_YESTERDAY).score, null, 'the row numbered 1 is untouched');
});

test('R140 with an open check-in, the score closes it and sets Score on that one row', async () => {
  const s = setup({ habitRows: [{ id: 2, habit: 'mood', date: TODAY, done: false }] });
  assertDone(await post(s, 'score', forms.score(s, 'mood', '4')));
  const t = todays(s, 'mood');
  assert.equal(t.length, 1, 'no second row');
  assert.equal(t[0].done, true);
  assert.equal(t[0].score, 4);
});

test('R140 setting the score again on the same day only sets Score', async () => {
  const s = setup({ habitRows: [{ id: 2, habit: 'mood', date: TODAY, done: true, score: 7 }] });
  const writes = track(s);
  assertDone(await post(s, 'score', forms.score(s, 'mood', '9')));
  const w = writes();
  assert.equal(w.length, 1, 'one update');
  assert.equal(w[0].method, 'PATCH');
  assert.deepEqual(Object.keys(w[0].body.properties), ['Score']);
  assert.equal(todays(s, 'mood')[0].score, 9);
  assert.equal(todays(s, 'mood').length, 1);
});

test('R140 scoring twice in a row on an empty day makes one check-in, then only sets Score', async () => {
  const s = setup();
  assertDone(await post(s, 'score', forms.score(s, 'mood', '3')));
  assertDone(await post(s, 'score', forms.score(s, 'mood', '8')));
  const t = todays(s, 'mood');
  assert.equal(t.length, 1);
  assert.equal(t[0].score, 8);
  assert.equal(t[0].done, true);
});

test('R140 an unknown habit, a habit without a score, another date and a score out of range are refused with status 400 and no write', async () => {
  const s = setup();
  const writes = track(s);
  assertRefusal(await post(s, 'score', forms.score(s, 'nope', '5')));
  assertRefusal(await post(s, 'score', forms.score(s, 'move', '5')));
  assertRefusal(await post(s, 'score', forms.score(s, 'mood', '5', YESTERDAY)));
  assertRefusal(await post(s, 'score', forms.score(s, 'mood', '11')));
  assertRefusal(await post(s, 'score', forms.score(s, 'mood', '0')));
  assert.deepEqual(writes(), []);
});

// ---------- the tokens ----------

test('R57 a form with a token signed for another target is refused with status 403 and no write', async () => {
  const s = setup();
  const writes = track(s);
  const res = await post(s, 'close', { token: s.guard.formToken('close', '2'), number: '1' });
  assert.equal(res.status, 403);
  assert.deepEqual(writes(), []);
  assert.equal(status(s, C_PAINT), 'Not started');
});
