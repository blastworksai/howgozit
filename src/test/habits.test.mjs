// Habit rules R36 to R46, written from references/contract.md before the code exists.
// Every test builds its given with fixtures/build.mjs and goes through board() only.
// Fixed clock: NOW = 2026-10-12T06:10:00Z, which is 2026-10-12 08:10 in Europe/Brussels (UTC+2).
// So today is 2026-10-12, yesterday is 2026-10-11, and `recent` runs 2026-09-29 .. 2026-10-12
// (index 0 = 09-29, index 13 = today 10-12, index 12 = yesterday 10-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NOW, settings, project, raw, checkin, board, resetNumbers } from '../fixtures/build.mjs';

const TODAY = '2026-10-12';
const YESTERDAY = '2026-10-11';

// ---------- local helpers ----------

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// One closed check-in per D in the pattern, one day per character, starting at `start`.
// A dot is a day with no check-in at all.
function days(id, start, pattern) {
  const out = [];
  [...pattern].forEach((ch, i) => {
    if (ch === 'D') out.push(checkin(id, addDays(start, i)));
  });
  return out;
}

// Start date so that the last character of the pattern is `last`.
function startFor(pattern, last) {
  return addDays(last, -(pattern.length - 1));
}

function warn(b, code) {
  const w = (b.meta?.warnings ?? []).find((x) => x.code === code);
  return w ? w.count : 0;
}

function habitOf(b, id) {
  const h = (b.habits ?? []).find((x) => x.id === id);
  assert.ok(h, `habit ${id} is on the board`);
  return h;
}

function statuses(h, from, to) {
  return h.recent.slice(from, to).map((e) => e.status);
}

function rep(status, n) {
  return Array(n).fill(status);
}

// One habit `move`, started so the pattern's last day is `last` (default yesterday).
// `extra` check-ins are added to the issues; `over` overrides settings keys.
function run(pattern, { last = YESTERDAY, extra = [], over = {}, now = NOW, id = 'move' } = {}) {
  const start = startFor(pattern, last);
  const b = board({
    raw: raw({ issues: [...days(id, start, pattern), ...extra] }),
    settings: settings({ habits: [{ id, title: 'Move', start }], ...over }),
    now,
  });
  return { b, h: habitOf(b, id) };
}

// Same, with explicit habit definitions and issues.
function runWith(habits, issues, { over = {}, now = NOW, projects = [], rawProjects = [] } = {}) {
  return board({
    raw: raw({ issues, projects: rawProjects }),
    settings: settings({ habits, projects, ...over }),
    now,
  });
}

const doneToday = () => checkin('move', TODAY, { closedAt: '2026-10-12T05:00:00Z' });

// ---------- R36 ----------

test('R36 habits are the ones in settings, in settings order, each with its own days', () => {
  resetNumbers();
  // Settings order: read, then move. Check-ins also exist for a third habit, ghost.
  const issues = [
    checkin('move', '2026-10-09'),
    checkin('move', '2026-10-10'),
    checkin('move', '2026-10-11'),
    checkin('read', '2026-10-11'),
    checkin('ghost', '2026-10-10'),
    checkin('ghost', '2026-10-11'),
  ];
  const habits = [
    { id: 'read', title: 'Read', start: '2026-10-09' },
    { id: 'move', title: 'Move', start: '2026-10-09' },
  ];
  const b = runWith(habits, issues);
  assert.deepEqual(
    (b.habits ?? []).map((h) => h.id),
    ['read', 'move'],
  );
  const read = habitOf(b, 'read');
  const move = habitOf(b, 'move');
  assert.equal(read.title, 'Read');
  assert.equal(move.title, 'Move');
  // read: 10-09 missed, 10-10 missed, 10-11 done. move: all three done.
  assert.deepEqual(statuses(read, 10, 13), ['missed', 'missed', 'done']);
  assert.deepEqual(statuses(move, 10, 13), ['done', 'done', 'done']);
  assert.equal(read.streak, 1);
  assert.equal(move.streak, 3);
});

test('R36 swapping the settings order swaps the habits, and a habit with no days still appears', () => {
  resetNumbers();
  const habits = [
    { id: 'move', title: 'Move', start: '2026-10-09' },
    { id: 'read', title: 'Read', start: '2026-10-09' },
  ];
  const b = runWith(habits, [checkin('move', '2026-10-11')]);
  assert.deepEqual(
    (b.habits ?? []).map((h) => h.id),
    ['move', 'read'],
  );
  assert.equal(habitOf(b, 'read').streak, 0);
  assert.equal(habitOf(b, 'move').streak, 1);
});

// ---------- R37 ----------

test('R37 a check-in counts for the day in its title, never another day', () => {
  resetNumbers();
  // Titled for 10-10, created on 10-09 and closed on 10-10: only 10-10 is done.
  const c = checkin('move', '2026-10-10', { title: 'Move · 2026-10-10' });
  c.created_at = '2026-10-09T08:00:00Z';
  const { h } = (() => {
    const b = runWith([{ id: 'move', title: 'Move', start: '2026-10-08' }], [c]);
    return { h: habitOf(b, 'move') };
  })();
  // index 9 = 10-08, 10 = 10-09, 11 = 10-10, 12 = 10-11
  assert.deepEqual(statuses(h, 9, 13), ['missed', 'missed', 'done', 'missed']);
});

test('R37 the day is the date after the LAST separator of the title', () => {
  resetNumbers();
  const c = checkin('move', '2026-10-10', { title: 'Deep · work · 2026-10-10' });
  const b = runWith([{ id: 'move', title: 'Move', start: '2026-10-09' }], [c]);
  const h = habitOf(b, 'move');
  // 10-09 missed, 10-10 done, 10-11 missed
  assert.deepEqual(statuses(h, 10, 13), ['missed', 'done', 'missed']);
});

// ---------- R38 ----------

// Europe/Brussels is UTC+2 on 2026-10-10: its day runs 2026-10-09T22:00:00Z to 2026-10-10T22:00:00Z.
const start1010 = [{ id: 'move', title: 'Move', start: '2026-10-10' }];

test('R38 closed at 21:59Z on its own day (Brussels) is done', () => {
  resetNumbers();
  const issues = [
    checkin('move', '2026-10-10', { closedAt: '2026-10-10T21:59:00Z' }),
    checkin('move', '2026-10-11'),
  ];
  const h = habitOf(runWith(start1010, issues), 'move');
  // 10-10 done (idx 11), 10-11 done (idx 12): streak 2.
  assert.deepEqual(statuses(h, 11, 13), ['done', 'done']);
  assert.equal(h.streak, 2);
});

test('R38 closed at 22:01Z, already the 11th in Brussels, is not done', () => {
  resetNumbers();
  const issues = [
    checkin('move', '2026-10-10', { closedAt: '2026-10-10T22:01:00Z' }),
    checkin('move', '2026-10-11'),
  ];
  const h = habitOf(runWith(start1010, issues), 'move');
  // 10-10 missed (no token held), 10-11 done: streak 1.
  assert.deepEqual(statuses(h, 11, 13), ['missed', 'done']);
  assert.equal(h.streak, 1);
});

test('R38 closed on the next day in the board timezone, or a UTC day later, is not done', () => {
  resetNumbers();
  // Closed 2026-10-10T23:30Z is still the 10th in UTC but 01:30 on the 11th in Brussels.
  const issues = [
    checkin('move', '2026-10-10', { closedAt: '2026-10-10T23:30:00Z' }),
    checkin('move', '2026-10-11', { closedAt: '2026-10-12T05:00:00Z' }),
  ];
  const h = habitOf(runWith(start1010, issues), 'move');
  assert.deepEqual(statuses(h, 11, 13), ['missed', 'missed']);
  assert.equal(h.streak, 0);
});

test('R38 an open check-in does not count; open plus one closed for the same day is done', () => {
  resetNumbers();
  // Open alone: yesterday not done.
  const alone = habitOf(
    runWith([{ id: 'move', title: 'Move', start: YESTERDAY }], [checkin('move', YESTERDAY, { closed: false })]),
    'move',
  );
  assert.equal(statuses(alone, 12, 13)[0], 'missed');
  assert.equal(alone.streak, 0);
  // Open and closed for the same day: done.
  const both = habitOf(
    runWith(
      [{ id: 'move', title: 'Move', start: YESTERDAY }],
      [checkin('move', YESTERDAY, { closed: false }), checkin('move', YESTERDAY)],
    ),
    'move',
  );
  assert.equal(statuses(both, 12, 13)[0], 'done');
  assert.equal(both.streak, 1);
});

test('R38 two closed check-ins for one day count once', () => {
  resetNumbers();
  const h = habitOf(
    runWith(
      [{ id: 'move', title: 'Move', start: YESTERDAY }],
      [checkin('move', YESTERDAY), checkin('move', YESTERDAY, { closedAt: '2026-10-11T12:00:00Z' })],
    ),
    'move',
  );
  // One day done: streak 1, run counter 1, toNextToken 6 - 1 = 5.
  assert.equal(h.streak, 1);
  assert.equal(h.tokens, 0);
  assert.equal(h.toNextToken, 5);
});

test('R38 a check-in closed one minute after midnight counts for the new day only', () => {
  resetNumbers();
  // 2026-10-11T22:01Z is 00:01 on 2026-10-12 in Brussels.
  // Titled for the 11th it is closed on another day: not done.
  const late = habitOf(
    runWith(
      [{ id: 'move', title: 'Move', start: YESTERDAY }],
      [checkin('move', YESTERDAY, { closedAt: '2026-10-11T22:01:00Z' })],
    ),
    'move',
  );
  assert.equal(statuses(late, 12, 13)[0], 'missed');
  // Titled for the 12th it is closed on its own day: today is done.
  const fresh = habitOf(
    runWith(
      [{ id: 'move', title: 'Move', start: YESTERDAY }],
      [checkin('move', TODAY, { closedAt: '2026-10-11T22:01:00Z' })],
    ),
    'move',
  );
  assert.equal(fresh.doneToday, true);
  assert.equal(statuses(fresh, 13, 14)[0], 'done');
  // Titled for the 12th and closed one minute before midnight, 21:59Z on the 11th (23:59 on the 11th): not done.
  const early = habitOf(
    runWith(
      [{ id: 'move', title: 'Move', start: YESTERDAY }],
      [checkin('move', TODAY, { closedAt: '2026-10-11T21:59:00Z' })],
    ),
    'move',
  );
  assert.equal(early.doneToday, false);
  assert.equal(statuses(early, 13, 14)[0], 'pending');
});

// ---------- R39 ----------

test('R39 no start: days start at the earliest check-in, earlier ones are before', () => {
  resetNumbers();
  // First check-in four days ago (10-08); done 10-08 .. 10-11.
  const issues = days('move', '2026-10-08', 'DDDD');
  const b = runWith([{ id: 'move', title: 'Move' }], issues);
  const h = habitOf(b, 'move');
  assert.equal(h.recent.length, 14);
  // idx 9 = 10-08. Nine earliest are before, then four done, then today pending.
  assert.deepEqual(statuses(h, 0, 9), rep('before', 9));
  assert.deepEqual(statuses(h, 9, 13), rep('done', 4));
  assert.equal(statuses(h, 13, 14)[0], 'pending');
  assert.equal(h.streak, 4);
});

test('R39 a start in settings earlier than the first check-in makes the gap missed, not before', () => {
  resetNumbers();
  // start 10-05 (idx 6). 10-05, 06, 07 have no check-in: missed. 10-08 .. 10-11 done.
  const issues = days('move', '2026-10-08', 'DDDD');
  const b = runWith([{ id: 'move', title: 'Move', start: '2026-10-05' }], issues);
  const h = habitOf(b, 'move');
  assert.deepEqual(statuses(h, 0, 6), rep('before', 6));
  assert.deepEqual(statuses(h, 6, 9), rep('missed', 3));
  assert.deepEqual(statuses(h, 9, 13), rep('done', 4));
  assert.equal(h.streak, 4);
});

test('R39 a check-in before the start counts for nothing', () => {
  resetNumbers();
  // start 10-10; the 10-09 check-in is before it. 10-10 and 10-11 done: streak 2.
  const issues = [checkin('move', '2026-10-09'), checkin('move', '2026-10-10'), checkin('move', '2026-10-11')];
  const h = habitOf(runWith([{ id: 'move', title: 'Move', start: '2026-10-10' }], issues), 'move');
  assert.equal(statuses(h, 10, 11)[0], 'before');
  assert.deepEqual(statuses(h, 11, 13), ['done', 'done']);
  assert.equal(h.streak, 2);
  assert.equal(h.best, 2);
});

test('R39 cold start: no check-in and no start begins today', () => {
  resetNumbers();
  const h = habitOf(runWith([{ id: 'move', title: 'Move' }], []), 'move');
  assert.equal(h.recent.length, 14);
  assert.deepEqual(statuses(h, 0, 13), rep('before', 13));
  assert.equal(h.recent[13].status, 'pending');
  assert.equal(h.recent[13].date, TODAY);
  assert.equal(h.streak, 0);
  assert.equal(h.best, 0);
  assert.equal(h.tokens, 0);
  assert.equal(h.toNextToken, 6);
  assert.equal(h.doneToday, false);
});

test('R39 start today: 13 before entries, today pending, then done once ticked', () => {
  resetNumbers();
  const pending = habitOf(runWith([{ id: 'move', title: 'Move', start: TODAY }], []), 'move');
  assert.deepEqual(statuses(pending, 0, 13), rep('before', 13));
  assert.equal(pending.recent[13].status, 'pending');
  assert.equal(pending.streak, 0);
  const done = habitOf(runWith([{ id: 'move', title: 'Move', start: TODAY }], [doneToday()]), 'move');
  assert.deepEqual(statuses(done, 0, 13), rep('before', 13));
  assert.equal(done.recent[13].status, 'done');
  assert.equal(done.streak, 1);
  assert.equal(done.doneToday, true);
});

// ---------- R40 ----------

test('R40 six done, one not, three done, one not: statuses, then streak 0 and tokens 0', () => {
  resetNumbers();
  const { h } = run('DDDDDD.DDD.');
  // 11 days 10-01 .. 10-11 = idx 2 .. 12.
  // Walk: 6 done -> streak 6, counter 6 -> token 1, counter 0.
  // day 7 not done, token held -> token (tokens 0, streak 6).
  // 3 done -> streak 9, counter 3.
  // day 11 not done, no token -> missed, streak 0, counter 0.
  assert.deepEqual(statuses(h, 2, 14), [...rep('done', 6), 'token', ...rep('done', 3), 'missed', 'pending']);
  assert.deepEqual(statuses(h, 0, 2), ['before', 'before']);
  assert.equal(h.streak, 0);
  assert.equal(h.tokens, 0);
  assert.equal(h.toNextToken, 6);
});

test('R40 stopping one day earlier: streak 9, tokens 0, toNextToken 3', () => {
  resetNumbers();
  const { h } = run('DDDDDD.DDD');
  // Same walk, last day is yesterday: streak 9, counter 3, no token held.
  assert.deepEqual(statuses(h, 3, 14), [...rep('done', 6), 'token', ...rep('done', 3), 'pending']);
  assert.equal(h.streak, 9);
  assert.equal(h.tokens, 0);
  assert.equal(h.toNextToken, 3);
});

test('R40 a token earned on one day is spent on the next', () => {
  resetNumbers();
  const { h } = run('DDDDDD..');
  // Day 6 earns a token, day 7 spends it, day 8 has none: missed.
  assert.deepEqual(statuses(h, 5, 14), [...rep('done', 6), 'token', 'missed', 'pending']);
  assert.equal(h.streak, 0);
  assert.equal(h.tokens, 0);
  // Twin: stopping at the token day keeps the streak at 6 with no token left.
  const { h: held } = run('DDDDDD.');
  assert.equal(held.streak, 6);
  assert.equal(held.tokens, 0);
  assert.equal(held.recent[12].status, 'token');
});

test('R40 a token day leaves the run counter untouched', () => {
  resetNumbers();
  const { h } = run('DDDDDDDDDDD.D');
  // 13 days 09-29 .. 10-11 = idx 0 .. 12.
  // Days 1-6: streak 6, token 1, counter 0. Days 7-11: streak 11, counter 5.
  // Day 12 not done, token spent: streak 11, counter stays 5, tokens 0.
  // Day 13 done: streak 12, counter 6 -> token earned, counter 0.
  assert.deepEqual(statuses(h, 0, 13), [...rep('done', 11), 'token', 'done']);
  assert.equal(h.streak, 12);
  assert.equal(h.tokens, 1);
  assert.equal(h.toNextToken, 6);
});

test('R40 tokenEvery from settings is honoured', () => {
  resetNumbers();
  const { h } = run('DDD.D', { over: { streak: { tokenEvery: 3 } } });
  // tokenEvery 3: day 3 earns a token, day 4 spends it, day 5 done: streak 4, counter 1.
  assert.deepEqual(statuses(h, 8, 13), ['done', 'done', 'done', 'token', 'done']);
  assert.equal(h.streak, 4);
  assert.equal(h.tokens, 0);
  assert.equal(h.toNextToken, 2);
});

test('R40 the base fixture walks to the recorded streaks, tokens and next tokens', () => {
  resetNumbers();
  const fx = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
  const b = board({ raw: fx('../fixtures/raw/base.json'), settings: fx('../fixtures/settings/base.json') });
  // move: 22-28 Sep done (7), 29 Sep token (token earned on the 6th done day), 30 Sep .. 3 Oct done,
  // 4 and 5 Oct missed, 6-11 Oct done. Re-derived from the data by hand:
  // streak 6 (token earned on 11 Oct, counter 0), best 11, tokens 1, toNextToken 6.
  const move = habitOf(b, 'move');
  assert.equal(move.streak, 6);
  assert.equal(move.best, 11);
  assert.equal(move.tokens, 1);
  assert.equal(move.toNextToken, 6);
  // read: 22-25 Sep done, 26 Sep closed a day late (missed), 27 Sep .. 11 Oct done (15 days).
  // Tokens earned on 2 Oct and 8 Oct, counter 3 at the end: streak 15, best 15, tokens 2, toNextToken 3.
  const read = habitOf(b, 'read');
  assert.equal(read.streak, 15);
  assert.equal(read.best, 15);
  assert.equal(read.tokens, 2);
  assert.equal(read.toNextToken, 3);
  assert.equal(move.doneToday, false);
  assert.equal(read.doneToday, false);
});

// ---------- R41 ----------

test('R41 today not done is pending and changes nothing; today done adds one', () => {
  resetNumbers();
  const { h } = run('DDDD');
  assert.equal(h.streak, 4);
  assert.equal(h.doneToday, false);
  assert.equal(h.recent[13].status, 'pending');
  assert.equal(h.recent[13].date, TODAY);
  const { h: done } = run('DDDD', { extra: [doneToday()] });
  assert.equal(done.streak, 5);
  assert.equal(done.doneToday, true);
  assert.equal(done.recent[13].status, 'done');
});

test('R41 a pending today spends no token and resets nothing', () => {
  resetNumbers();
  // Six done days earn a token; today not done leaves streak 6, tokens 1, toNextToken 6.
  const { h } = run('DDDDDD');
  assert.equal(h.streak, 6);
  assert.equal(h.tokens, 1);
  assert.equal(h.toNextToken, 6);
  assert.equal(h.recent[13].status, 'pending');
  // Twin: a run with a miss and no token stays at 0, and pending does not change that.
  const { h: dead } = run('DD.');
  assert.equal(dead.streak, 0);
  assert.equal(dead.recent[13].status, 'pending');
});

test('R41 today done counts like any done day, including earning a token', () => {
  resetNumbers();
  // Five done days (counter 5) plus today done: counter 6 -> token earned, streak 6.
  const { h } = run('DDDDD', { extra: [doneToday()] });
  assert.equal(h.streak, 6);
  assert.equal(h.tokens, 1);
  assert.equal(h.toNextToken, 6);
  assert.equal(h.doneToday, true);
});

// ---------- R42 ----------

test('R42 best is the longest streak ever reached', () => {
  resetNumbers();
  // tokenEvery 30 so no token interferes: 8 done, 1 missed (reset), 3 done.
  const { h } = run('DDDDDDDD.DDD', { over: { streak: { tokenEvery: 30 } } });
  assert.equal(h.streak, 3);
  assert.equal(h.best, 8);
});

test('R42 best follows a streak that is still running, today included', () => {
  resetNumbers();
  const { h } = run('DDD', { extra: [doneToday()] });
  assert.equal(h.streak, 4);
  assert.equal(h.best, 4);
  const { h: before } = run('DDD');
  assert.equal(before.streak, 3);
  assert.equal(before.best, 3);
});

test('R42 a token day does not end the run that best measures', () => {
  resetNumbers();
  // Default tokenEvery 6: 6 done (token), 1 token day, 2 done, 1 missed, then nothing: best 8.
  const { h } = run('DDDDDD.DD.');
  assert.deepEqual(statuses(h, 3, 14), [...rep('done', 6), 'token', 'done', 'done', 'missed', 'pending']);
  assert.equal(h.streak, 0);
  assert.equal(h.best, 8);
});

// ---------- R43 ----------

test('R43 flames follow the default tiers for streaks 0, 1, 6, 7 and 30', () => {
  resetNumbers();
  const cases = [
    // [pattern, streak, lit, toNextFlame]
    ['', 0, 0, 1],
    ['D', 1, 1, 2],
    ['DDDDDD', 6, 2, 1],
    ['DDDDDDD', 7, 3, 7],
    ['D'.repeat(30), 30, 5, null],
  ];
  for (const [pattern, streak, lit, next] of cases) {
    // The empty case has no start and no check-in, so it begins today with streak 0.
    const h = pattern === ''
      ? habitOf(runWith([{ id: 'move', title: 'Move' }], []), 'move')
      : run(pattern).h;
    assert.equal(h.streak, streak, `streak for ${streak}`);
    assert.equal(h.flamesLit, lit, `flamesLit for streak ${streak}`);
    assert.equal(h.toNextFlame, next, `toNextFlame for streak ${streak}`);
    assert.equal(h.flames.length, 5);
    assert.deepEqual(h.flames, [0, 1, 2, 3, 4].map((i) => i < lit));
  }
});

test('R43 custom tiers from settings change the lit count and the gap', () => {
  resetNumbers();
  // Tiers 2, 4, 6, 8, 10 and streak 4 (tokenEvery 30 to keep tokens out): 2 lit, next tier 6, gap 2.
  const { h } = run('DDDD', { over: { streak: { flameTiers: [2, 4, 6, 8, 10], tokenEvery: 30 } } });
  assert.equal(h.streak, 4);
  assert.equal(h.flamesLit, 2);
  assert.deepEqual(h.flames, [true, true, false, false, false]);
  assert.equal(h.toNextFlame, 2);
});

// ---------- R44 ----------

test('R44 recent has 14 entries, oldest first, ending today', () => {
  resetNumbers();
  const h = habitOf(runWith([{ id: 'move', title: 'Move', start: '2026-10-07' }], []), 'move');
  assert.equal(h.recent.length, 14);
  const expected = Array.from({ length: 14 }, (_, i) => addDays(TODAY, i - 13));
  assert.deepEqual(h.recent.map((e) => e.date), expected);
  assert.equal(h.recent[0].date, '2026-09-29');
  assert.equal(h.recent[13].date, TODAY);
});

test('R44 a habit started 5 days ago has the first 8 entries before', () => {
  resetNumbers();
  const h = habitOf(runWith([{ id: 'move', title: 'Move', start: '2026-10-07' }], [checkin('move', '2026-10-09')]), 'move');
  // 10-07 is 5 days before today, at idx 8.
  assert.deepEqual(statuses(h, 0, 8), rep('before', 8));
  assert.deepEqual(statuses(h, 8, 14), ['missed', 'missed', 'done', 'missed', 'missed', 'pending']);
});

test('R44 a habit older than 14 days still shows exactly 14 entries', () => {
  resetNumbers();
  const { h } = run('D'.repeat(20));
  assert.equal(h.recent.length, 14);
  assert.deepEqual(statuses(h, 0, 13), rep('done', 13));
  assert.equal(h.recent[13].status, 'pending');
  assert.equal(h.streak, 20);
});

// ---------- R45 ----------

test('R45 linked, unlinked and mislinked habits', () => {
  resetNumbers();
  const habits = [
    { id: 'aa', title: 'Aa', start: '2026-10-09', project: 'house' },
    { id: 'bb', title: 'Bb', start: '2026-10-09' },
    { id: 'cc', title: 'Cc', start: '2026-10-09', project: 'nope' },
  ];
  const issues = ['aa', 'bb', 'cc'].flatMap((id) => days(id, '2026-10-09', 'DDD'));
  const b = runWith(habits, issues, {
    projects: [
      { key: 'house', number: 3, color: '#123456' },
      { key: 'side', number: 4, color: '#654321' },
    ],
    rawProjects: [project(3, 'House'), project(4, 'Side')],
  });
  const aa = habitOf(b, 'aa');
  const bb = habitOf(b, 'bb');
  const cc = habitOf(b, 'cc');
  assert.deepEqual(aa.project, { key: 'house', color: '#123456' });
  assert.equal(bb.project, null);
  assert.equal(cc.project, null);
  // The streak rules are the same either way.
  assert.equal(aa.streak, 3);
  assert.equal(bb.streak, 3);
  assert.equal(cc.streak, 3);
  const house = (b.projects ?? []).find((p) => p.key === 'house');
  assert.ok(house, 'house project is shown');
  assert.equal(house.habits.length, 1);
  assert.equal(house.habits[0].id, 'aa');
  assert.equal(house.habits[0].title, 'Aa');
  assert.equal(house.habits[0].streak, 3);
  const side = (b.projects ?? []).find((p) => p.key === 'side');
  assert.ok(side, 'side project is shown');
  assert.equal(side.habits.length, 0);
  assert.equal(warn(b, 'habit-project-unknown'), 1);
});

test('R45 without a mislinked habit there is no habit-project-unknown warning', () => {
  resetNumbers();
  const habits = [
    { id: 'aa', title: 'Aa', start: '2026-10-09', project: 'house' },
    { id: 'bb', title: 'Bb', start: '2026-10-09' },
  ];
  const b = runWith(habits, days('aa', '2026-10-09', 'DDD'), {
    projects: [{ key: 'house', number: 3, color: '#123456' }],
    rawProjects: [project(3, 'House')],
  });
  habitOf(b, 'aa');
  assert.equal(warn(b, 'habit-project-unknown'), 0);
  assert.deepEqual(habitOf(b, 'aa').project, { key: 'house', color: '#123456' });
  const house = (b.projects ?? []).find((p) => p.key === 'house');
  assert.ok(house);
  assert.equal(house.habits.length, 1);
});

// ---------- R46 ----------

function childBoard(tz) {
  const buildUrl = new URL('../fixtures/build.mjs', import.meta.url).href;
  const rawPath = fileURLToPath(new URL('../fixtures/raw/base.json', import.meta.url));
  const settingsPath = fileURLToPath(new URL('../fixtures/settings/base.json', import.meta.url));
  const script = `
    import { readFileSync } from 'node:fs';
    import { board, NOW } from ${JSON.stringify(buildUrl)};
    const raw = JSON.parse(readFileSync(${JSON.stringify(rawPath)}, 'utf8'));
    const settings = JSON.parse(readFileSync(${JSON.stringify(settingsPath)}, 'utf8'));
    process.stdout.write(JSON.stringify(board({ raw, settings, now: NOW })));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `child with TZ=${tz} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

test('R46 the board is identical under three process timezones', () => {
  resetNumbers();
  const zones = ['Pacific/Kiritimati', 'America/Adak', 'UTC'];
  const outs = zones.map(childBoard);
  assert.equal(outs[1], outs[0]);
  assert.equal(outs[2], outs[0]);
  // Non-trivial: the habits of the base fixture are in it.
  const parsed = JSON.parse(outs[0]);
  assert.ok(Array.isArray(parsed.habits) && parsed.habits.length === 2, 'two habits in the board');
  assert.equal(parsed.meta.today, TODAY);
});

test('R46 now at 22:30Z on the 12th is the 13th in Brussels and the 12th in New York', () => {
  resetNumbers();
  const now = '2026-10-12T22:30:00Z';
  const habits = [{ id: 'move', title: 'Move', start: '2026-10-10' }];
  const bru = board({ raw: raw(), settings: settings({ habits, timezone: 'Europe/Brussels' }), now });
  assert.equal(bru.meta.today, '2026-10-13');
  const bruH = habitOf(bru, 'move');
  assert.equal(bruH.recent[13].date, '2026-10-13');
  assert.equal(bruH.recent[13].status, 'pending');
  assert.equal(bruH.recent[12].date, '2026-10-12');
  assert.equal(bruH.recent[12].status, 'missed');
  const ny = board({ raw: raw(), settings: settings({ habits, timezone: 'America/New_York' }), now });
  assert.equal(ny.meta.today, TODAY);
  const nyH = habitOf(ny, 'move');
  assert.equal(nyH.recent[13].date, TODAY);
  assert.equal(nyH.recent[13].status, 'pending');
});

test('R46 just before and just after midnight in the board timezone', () => {
  resetNumbers();
  const habits = [{ id: 'move', title: 'Move', start: '2026-10-10' }];
  // 21:59Z is 23:59 on the 12th in Brussels; 22:00Z is 00:00 on the 13th.
  const before = board({ raw: raw(), settings: settings({ habits }), now: '2026-10-12T21:59:00Z' });
  assert.equal(before.meta.today, TODAY);
  assert.equal(habitOf(before, 'move').recent[13].date, TODAY);
  assert.equal(habitOf(before, 'move').recent[13].status, 'pending');
  const after = board({ raw: raw(), settings: settings({ habits }), now: '2026-10-12T22:00:00Z' });
  assert.equal(after.meta.today, '2026-10-13');
  const h = habitOf(after, 'move');
  assert.equal(h.recent[13].date, '2026-10-13');
  assert.equal(h.recent[12].date, TODAY);
  assert.equal(h.recent[12].status, 'missed');
});

test('R46 the clock change of 25 Oct 2026 does not skip, repeat or shift a day', () => {
  resetNumbers();
  // Brussels leaves summer time at 01:00Z on 2026-10-25: UTC+2 before, UTC+1 after.
  // now 2026-10-26T09:00Z is 10:00 on the 26th. recent runs 10-13 .. 10-26.
  const now = '2026-10-26T09:00:00Z';
  const issues = [
    // Local 23:30 on the 25th (UTC+1): closed on its own day, done.
    checkin('move', '2026-10-25', { closedAt: '2026-10-25T22:30:00Z' }),
    // Titled 10-24, closed at 22:30Z on the 24th = 00:30 on the 25th (UTC+2): another day, not done.
    checkin('move', '2026-10-24', { closedAt: '2026-10-24T22:30:00Z' }),
    // Titled 10-26, closed 2026-10-25T23:30Z = 00:30 on the 26th (UTC+1): its own day, so today is done.
    checkin('move', '2026-10-26', { closedAt: '2026-10-25T23:30:00Z' }),
  ];
  const b = board({
    raw: raw({ issues }),
    settings: settings({ habits: [{ id: 'move', title: 'Move', start: '2026-10-23' }] }),
    now,
  });
  const h = habitOf(b, 'move');
  assert.equal(b.meta.today, '2026-10-26');
  const expected = Array.from({ length: 14 }, (_, i) => addDays('2026-10-26', i - 13));
  assert.deepEqual(h.recent.map((e) => e.date), expected);
  // idx 10 = 10-23, 11 = 10-24, 12 = 10-25, 13 = 10-26.
  assert.deepEqual(statuses(h, 10, 14), ['missed', 'missed', 'done', 'done']);
  assert.equal(h.doneToday, true);
  assert.equal(h.streak, 2);
});
