// Rules R47 (12-week map), R48 (season) and R94 (greeting and week number).
// Every expected value is worked out by hand from references/contract.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, project, task, idea, pr, checkin, raw, board, resetNumbers } from '../fixtures/build.mjs';

const warn = (b, code) => (b.meta?.warnings ?? []).find((w) => w.code === code)?.count ?? 0;
const weeks = (b) => b.heatmap?.weeks ?? [];
const days = (b) => weeks(b).flat();
const day = (b, date) => days(b).find((d) => d.date === date);
// n closed tasks, all closed at 10:00Z on the given date (noon in Brussels in October, same date there).
const closedOn = (date, n) =>
  Array.from({ length: n }, () => task({ state: 'closed', closed_at: `${date}T10:00:00Z` }));
const NOW14 = '2026-10-14T10:00:00Z'; // a Wednesday; the week of 2026-10-12 with a Monday start

test('R47 closes count on their own day in the board timezone', () => {
  resetNumbers();
  // 21:30Z on the 12th is 23:30 in Brussels (UTC+2) on the 12th; 22:30Z is 00:30 on the 13th.
  const issues = [
    task({ state: 'closed', closed_at: '2026-10-12T21:30:00Z' }),
    task({ state: 'closed', closed_at: '2026-10-12T22:30:00Z' }),
  ];
  const b = board({ raw: raw({ issues }), now: NOW14 });
  assert.equal(weeks(b).length, 12);
  assert.equal(day(b, '2026-10-12')?.count, 1);
  assert.equal(day(b, '2026-10-13')?.count, 1);
  assert.equal(day(b, '2026-10-12')?.level, 1);
  assert.equal(day(b, '2026-10-14')?.count, 0); // today, nothing closed
  assert.equal(day(b, '2026-10-11')?.count, 0);
});

test('R47 counts 0, 1, 3, 5 and 6 give levels 0, 1, 2, 3 and 4', () => {
  resetNumbers();
  const issues = [
    ...closedOn('2026-10-06', 1), // 1 -> level 1
    ...closedOn('2026-10-07', 3), // 3 -> level 2
    ...closedOn('2026-10-08', 5), // 5 -> level 3
    ...closedOn('2026-10-09', 6), // 6 -> level 4
  ];
  const b = board({ raw: raw({ issues }), now: NOW14 });
  const got = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((d) => [
    day(b, d)?.count, day(b, d)?.level,
  ]);
  // 2026-10-05 has no closes: count 0, level 0
  assert.deepEqual(got, [[0, 0], [1, 1], [3, 2], [5, 3], [6, 4]]);
});

test('R47 the level boundaries: 2 is level 2, 4 is level 3, 7 is level 4', () => {
  resetNumbers();
  const issues = [...closedOn('2026-10-06', 2), ...closedOn('2026-10-07', 4), ...closedOn('2026-10-08', 7)];
  const b = board({ raw: raw({ issues }), now: NOW14 });
  const got = ['2026-10-06', '2026-10-07', '2026-10-08'].map((d) => [day(b, d)?.count, day(b, d)?.level]);
  assert.deepEqual(got, [[2, 2], [4, 3], [7, 4]]);
});

test('R47 twelve weeks of seven, starting 11 weeks before this week, null after today', () => {
  resetNumbers();
  const b = board({ raw: raw({ issues: closedOn('2026-10-13', 1) }), now: NOW14 });
  const w = weeks(b);
  assert.equal(w.length, 12);
  assert.ok(w.every((wk) => wk.length === 7));
  // Monday of the current week is 2026-10-12; 11 weeks (77 days) earlier is 2026-07-27.
  assert.equal(w[0]?.[0]?.date, '2026-07-27');
  assert.equal(w[11]?.[0]?.date, '2026-10-12');
  assert.equal(w[11]?.[6]?.date, '2026-10-18');
  // consecutive dates across the whole grid
  const all = days(b).map((d) => d.date);
  assert.equal(all.length, 84);
  assert.equal(new Set(all).size, 84);
  assert.deepEqual(all, [...all].sort());
  // every day after the 14th is null/null, every day up to and including it is a number
  for (const d of days(b)) {
    if (d.date > '2026-10-14') {
      assert.equal(d.count, null, d.date);
      assert.equal(d.level, null, d.date);
    } else {
      assert.equal(typeof d.count, 'number', d.date);
      assert.equal(typeof d.level, 'number', d.date);
    }
  }
  assert.equal(day(b, '2026-10-13')?.count, 1); // twin: the grid does see a close
  assert.equal(day(b, '2026-10-15')?.count, null);
  assert.equal(day(b, '2026-10-18')?.level, null);
});

test('R47 closed issues of any kind count, a pull request never does', () => {
  resetNumbers();
  const D = '2026-10-08';
  const issues = [
    task({ state: 'closed', closed_at: `${D}T10:00:00Z` }), // task
    task({ state: 'closed', state_reason: 'not_planned', closed_at: `${D}T11:00:00Z` }), // closed as not planned
    idea({ state: 'closed', closed_at: `${D}T12:00:00Z` }), // idea
    checkin('move', D, { closedAt: `${D}T13:00:00Z` }), // check-in
    task({ labels: ['weekly-review'], state: 'closed', closed_at: `${D}T14:00:00Z` }), // ignored issue
    pr({ state: 'closed', closed_at: `${D}T15:00:00Z` }), // pull request: never
    task({ closed_at: null }), // open: never
  ];
  const b = board({
    raw: raw({ issues }),
    settings: settings({ habits: [{ id: 'move', title: 'Move', start: '2026-10-01' }] }),
    now: NOW14,
  });
  // 5 issues count (the pull request and the open task do not): level 3 (4 to 5)
  assert.equal(day(b, D)?.count, 5);
  assert.equal(day(b, D)?.level, 3);
});

test('R47 with weekStart sunday the weeks begin on a Sunday', () => {
  resetNumbers();
  // 2026-10-14 is a Wednesday; its Sunday is 2026-10-11; 77 days earlier is 2026-07-26.
  const issues = closedOn('2026-10-11', 1);
  const b = board({ raw: raw({ issues }), settings: settings({ weekStart: 'sunday' }), now: NOW14 });
  const w = weeks(b);
  assert.equal(w.length, 12);
  assert.ok(w.every((wk) => wk.length === 7));
  assert.equal(w[0]?.[0]?.date, '2026-07-26');
  assert.equal(w[11]?.[0]?.date, '2026-10-11');
  assert.equal(w[11]?.[6]?.date, '2026-10-17');
  assert.equal(day(b, '2026-10-11')?.count, 1); // the Sunday close counts in the last week
  assert.equal(day(b, '2026-10-14')?.count, 0);
  assert.equal(day(b, '2026-10-15')?.count, null);
  assert.equal(day(b, '2026-10-17')?.level, null);
});

// A House project (number 3) with three tasks, one closed: pct = floor(100 * 1 / 3) = 33.
const seasonInput = (season) => {
  const issues = [task({ number: 1, state: 'closed' }), task({ number: 2 }), task({ number: 3 })];
  return {
    raw: raw({ issues, projects: [project(3, 'House', [1, 2, 3])] }),
    settings: settings({ projects: [{ key: 'house', number: 3 }], ...(season ? { season } : {}) }),
  };
};

test('R48 the season counts down and borrows its goals progress', () => {
  resetNumbers();
  const b = board(seasonInput({
    name: 'Autumn', start: '2026-10-12', end: '2026-12-31',
    goals: [
      { title: 'Finish the kitchen', project: 'house' }, // linked
      { title: 'Learn the piano' }, // unlinked
      { title: 'Mislinked goal', project: 'nope' }, // mislinked
    ],
  }));
  assert.equal(b.projects?.[0]?.pct, 33); // the progress the goal borrows
  assert.ok(b.season, 'season is present');
  assert.equal(b.season.name, 'Autumn');
  assert.equal(b.season.start, '2026-10-12');
  assert.equal(b.season.end, '2026-12-31');
  // today 2026-10-12 to 2026-12-31: 19 days left in October + 30 + 31 = 80
  assert.equal(b.season.daysLeft, 80);
  assert.equal(b.season.phase, 'running');
  assert.equal(b.season.goals?.length, 3);
  assert.deepEqual(b.season.goals?.map((g) => g.pct), [33, null, null]);
  assert.deepEqual(b.season.goals?.map((g) => g.title), ['Finish the kitchen', 'Learn the piano', 'Mislinked goal']);
  assert.equal(warn(b, 'goal-project-unknown'), 1);
});

test('R48 with no season in settings the board has season null', () => {
  resetNumbers();
  const b = board(seasonInput(null));
  assert.equal(b.projects?.length, 1); // twin: the board itself is built
  assert.equal(b.season, null);
  assert.equal(warn(b, 'goal-project-unknown'), 0);
});

test('R48 a season that has not started has phase before and counts days to its end', () => {
  resetNumbers();
  const b = board(seasonInput({ name: 'Winter', start: '2026-11-01', end: '2026-12-31', goals: [] }));
  assert.ok(b.season, 'season is present');
  assert.equal(b.season.phase, 'before');
  assert.equal(b.season.daysLeft, 80); // days from today to the end, as in the running case
  assert.deepEqual(b.season.goals, []);
});

test('R48 a season that has ended has phase after and daysLeft 0, never negative', () => {
  resetNumbers();
  const b = board(seasonInput({
    name: 'Summer', start: '2026-09-01', end: '2026-10-01',
    goals: [{ title: 'Finish the kitchen', project: 'house' }],
  }));
  assert.ok(b.season, 'season is present');
  assert.equal(b.season.phase, 'after');
  assert.equal(b.season.daysLeft, 0);
  assert.equal(b.season.goals?.[0]?.pct, 33); // goals still borrow progress
});

const at = (now) => board({ now });

test('R94 the greeting follows the wall clock in the board timezone', () => {
  resetNumbers();
  // Europe/Brussels is UTC+2 on 2026-10-12: 09:59Z is 11:59, 10:00Z is 12:00, 16:00Z is 18:00.
  const morning = at('2026-10-12T09:59:00Z');
  const afternoon = at('2026-10-12T10:00:00Z');
  const evening = at('2026-10-12T16:00:00Z');
  assert.equal(morning.meta?.greeting, 'Good morning');
  assert.equal(afternoon.meta?.greeting, 'Good afternoon');
  assert.equal(evening.meta?.greeting, 'Good evening');
  for (const b of [morning, afternoon, evening]) {
    assert.equal(b.meta?.today, '2026-10-12');
    assert.equal(b.meta?.weekNumber, 42); // ISO week of Monday 2026-10-12
  }
});

test('R94 just before and just after midnight in the board timezone', () => {
  resetNumbers();
  // Midnight in Brussels on 12/13 October is 22:00Z.
  const before = at('2026-10-12T21:59:00Z'); // 23:59 on the 12th
  const after = at('2026-10-12T22:00:00Z'); // 00:00 on the 13th
  assert.equal(before.meta?.today, '2026-10-12');
  assert.equal(before.meta?.greeting, 'Good evening');
  assert.equal(after.meta?.today, '2026-10-13');
  assert.equal(after.meta?.greeting, 'Good morning');
  assert.equal(after.meta?.weekNumber, 42); // Tuesday of the same week
  // Sunday night into Monday changes the ISO week: 2026-10-18 is a Sunday (week 42), the 19th a Monday (week 43).
  const sunday = at('2026-10-18T21:59:00Z');
  const monday = at('2026-10-18T22:00:00Z');
  assert.equal(sunday.meta?.today, '2026-10-18');
  assert.equal(sunday.meta?.weekNumber, 42);
  assert.equal(monday.meta?.today, '2026-10-19');
  assert.equal(monday.meta?.weekNumber, 43);
});

test('R94 after the clock change of 25 October 2026 the greeting uses the new offset', () => {
  resetNumbers();
  // Brussels leaves summer time at 01:00Z on 2026-10-25, so afterwards it is UTC+1.
  // 10:59Z is 11:59 (morning; a stale +2 offset would say 12:59); 11:00Z is 12:00 (afternoon).
  const morning = at('2026-10-25T10:59:00Z');
  const afternoon = at('2026-10-25T11:00:00Z');
  assert.equal(morning.meta?.greeting, 'Good morning');
  assert.equal(afternoon.meta?.greeting, 'Good afternoon');
  assert.equal(morning.meta?.today, '2026-10-25');
  assert.equal(morning.meta?.weekNumber, 43); // Sunday of the week that began on the 19th
  // 22:59Z is 23:59 on the 25th; 23:00Z is 00:00 on the 26th (UTC+1)
  assert.equal(at('2026-10-25T22:59:00Z').meta?.today, '2026-10-25');
  assert.equal(at('2026-10-25T23:00:00Z').meta?.today, '2026-10-26');
  assert.equal(at('2026-10-25T23:00:00Z').meta?.weekNumber, 44);
});
