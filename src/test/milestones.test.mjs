// Tests for R14-R22 and R93: milestones, the timeline, and a task's date.
// Written from references/contract.md. Today is 2026-10-12 (board timezone Europe/Brussels).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { board, settings, project, milestone, task, idea, pr, raw, resetNumbers } from '../fixtures/build.mjs';

const BUILD_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'build.mjs'),
).href;

// ---------- helpers ----------

// Calendar date n days from 2026-10-12 (pure UTC arithmetic on the test side).
function day(n) {
  return new Date(Date.UTC(2026, 9, 12 + n)).toISOString().slice(0, 10);
}
function warn(b, code) {
  const w = (b?.meta?.warnings ?? []).find((x) => x.code === code);
  return w ? w.count : 0;
}
function lane(b, key) {
  return (b?.timeline?.lanes ?? []).find((l) => l.project?.key === key);
}
function projectRow(b, key) {
  return (b?.projects ?? []).find((p) => p.key === key);
}
// Every milestone entry anywhere on the timeline, with where it was found.
function allEntries(b) {
  const out = [];
  for (const l of b?.timeline?.lanes ?? []) {
    for (const m of l.milestones ?? []) out.push({ where: 'milestones', key: l.project?.key, m });
    for (const m of l.undated ?? []) out.push({ where: 'undated', key: l.project?.key, m });
  }
  for (const m of b?.timeline?.other ?? []) out.push({ where: 'other', key: null, m });
  return out;
}
function entry(b, number) {
  return allEntries(b).find((e) => e.m.number === number);
}
function seat(b, number) {
  return (b?.next ?? []).find((n) => n.number === number);
}
// Settings listing the given [key, number] pairs, optionally with focus.
function cfg(pairs, focus = []) {
  return settings({ projects: pairs.map(([key, number]) => ({ key, number })), focus });
}

// ---------- R14 ----------

test('R14 a milestone belongs to a project through the left part of its title', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'house · Hallway', day(5)),
        milestone(2, 'House · A · B', day(6)),
        milestone(3, 'Hallway', day(7)),
        milestone(4, 'Garden · Beds', day(8)),
      ],
    }),
  });
  const l = lane(b, 'house');
  assert.ok(l, 'lane for house exists');
  assert.deepEqual(l.milestones.map((m) => [m.number, m.shortTitle]), [
    [1, 'Hallway'],
    [2, 'A · B'],
  ]);
  const other = b.timeline.other;
  assert.equal(other.length, 2);
  assert.deepEqual(
    other.map((m) => [m.number, m.shortTitle]).sort((x, y) => x[0] - y[0]),
    [
      [3, 'Hallway'],
      [4, 'Garden · Beds'],
    ],
  );
  assert.equal(warn(b, 'milestone-unmatched'), 2);
});

test('R14 the left part is trimmed and Unicode-normalised before the comparison', () => {
  resetNumbers();
  // 'Cafe' + combining acute (decomposed) must equal the project title 'Café' (composed).
  const b = board({
    settings: cfg([['cafe', 3]]),
    raw: raw({
      projects: [project(3, 'Café', [])],
      milestones: [
        milestone(1, 'Café · Menu', day(5)),
        milestone(2, '  Café  · Till', day(6)),
        milestone(3, 'Bakery · Oven', day(7)),
      ],
    }),
  });
  const l = lane(b, 'cafe');
  assert.ok(l, 'lane for cafe exists');
  assert.deepEqual(l.milestones.map((m) => [m.number, m.shortTitle]), [
    [1, 'Menu'],
    [2, 'Till'],
  ]);
  assert.deepEqual(b.timeline.other.map((m) => m.number), [3]);
  assert.equal(warn(b, 'milestone-unmatched'), 1);
});

test('R14 a milestone titled for a project that was renamed lands in other and is flagged', () => {
  resetNumbers();
  // GitHub now calls the project "Home"; the milestone still says "House".
  const b = board({
    settings: cfg([['home', 3]]),
    raw: raw({
      projects: [project(3, 'Home', [])],
      milestones: [milestone(1, 'House · Hallway', day(5)), milestone(2, 'Home · Roof', day(6))],
    }),
  });
  const l = lane(b, 'home');
  assert.ok(l, 'lane for home exists');
  assert.deepEqual(l.milestones.map((m) => m.number), [2]);
  assert.deepEqual(b.timeline.other.map((m) => [m.number, m.shortTitle]), [[1, 'House · Hallway']]);
  assert.equal(warn(b, 'milestone-unmatched'), 1);
});

// ---------- R15 ----------

test('R15 a milestone counts its own tasks only: two closed, one open, an idea and a pull request', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [{ number: 1 }])], // only task 1 is a project item
      milestones: [milestone(5, 'House · Hallway', day(10))],
      issues: [
        task({ number: 1, state: 'closed', milestone: 5 }),
        task({ number: 2, state: 'closed', milestone: 5 }), // not an item of any project: still counts
        task({ number: 3, milestone: 5 }),
        idea({ number: 4, milestone: 5 }),
        pr({ number: 5, milestone: 5 }),
      ],
    }),
  });
  const e = entry(b, 5);
  assert.ok(e, 'milestone 5 is on the timeline');
  // done 2, total 3, pct floor(100*2/3) = 66
  assert.equal(e.m.done, 2);
  assert.equal(e.m.total, 3);
  assert.equal(e.m.pct, 66);
});

test('R15 closed as not planned counts as done, and a milestone with no tasks reads 0 of 0', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [milestone(5, 'House · Hallway', day(10)), milestone(6, 'House · Roof', day(11))],
      issues: [
        task({ number: 1, state: 'closed', state_reason: 'not_planned', milestone: 5 }),
        task({ number: 2, milestone: 5 }),
      ],
    }),
  });
  const a = entry(b, 5);
  const c = entry(b, 6);
  assert.ok(a && c, 'both milestones are on the timeline');
  assert.deepEqual([a.m.done, a.m.total, a.m.pct], [1, 2, 50]);
  assert.deepEqual([c.m.done, c.m.total, c.m.pct], [0, 0, 0]);
});

// ---------- R16 ----------

const R16_SCRIPT = `
import { board, settings, project, milestone, raw, resetNumbers } from ${JSON.stringify(BUILD_URL)};
resetNumbers();
const b = board({
  settings: settings({ projects: [{ key: 'house', number: 3 }] }),
  raw: raw({
    projects: [project(3, 'House', [])],
    milestones: [
      milestone(1, 'House · A', null, { due_on: '2026-10-20T07:00:00Z' }),
      milestone(2, 'House · B', null, { due_on: '2026-10-20T23:59:59Z' }),
      milestone(3, 'House · C', null, { due_on: null }),
    ],
  }),
});
const l = (b.timeline?.lanes ?? []).find((x) => x.project?.key === 'house');
console.log(JSON.stringify({
  dated: (l?.milestones ?? []).map((m) => [m.number, m.due]),
  undated: (l?.undated ?? []).map((m) => [m.number, m.due]),
}));
`;
const R16_EXPECT = {
  dated: [
    [1, '2026-10-20'],
    [2, '2026-10-20'],
  ],
  undated: [[3, null]],
};

test('R16 the date is the UTC calendar date of due_on (in process)', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · A', null, { due_on: '2026-10-20T07:00:00Z' }),
        milestone(2, 'House · B', null, { due_on: '2026-10-20T23:59:59Z' }),
        milestone(3, 'House · C', null, { due_on: null }),
      ],
    }),
  });
  const l = lane(b, 'house');
  assert.ok(l, 'lane for house exists');
  assert.deepEqual(l.milestones.map((m) => [m.number, m.due]), R16_EXPECT.dated);
  assert.deepEqual(l.undated.map((m) => [m.number, m.due]), R16_EXPECT.undated);
});

function r16InZone(tz) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', R16_SCRIPT], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `child exited ${r.status}: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout.trim()), R16_EXPECT);
}

test('R16 the date does not move with the process timezone Pacific/Kiritimati', () => {
  r16InZone('Pacific/Kiritimati');
});

test('R16 the date does not move with the process timezone America/Adak', () => {
  r16InZone('America/Adak');
});

// ---------- R17 ----------

test('R17 done means closed on GitHub, or at least one task and none open', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · ClosedWithOpen', day(10), { state: 'closed', closed_at: '2026-10-05T09:00:00Z' }),
        milestone(2, 'House · AllClosed', day(10)),
        milestone(3, 'House · NoTasks', day(10)),
        milestone(4, 'House · OneOpen', day(10)),
      ],
      issues: [
        task({ number: 1, milestone: 1 }), // open task inside the closed milestone
        task({ number: 2, milestone: 2, state: 'closed' }),
        task({ number: 3, milestone: 2, state: 'closed' }),
        task({ number: 4, milestone: 4 }),
      ],
    }),
  });
  const states = [1, 2, 3, 4].map((n) => entry(b, n)?.m.state);
  // closed -> done, open + two closed tasks -> done, open + no tasks -> not done, open + one open -> not done
  assert.deepEqual(states, ['done', 'done', 'open', 'open']);
});

test('R17 one open task keeps a milestone open, and all tasks closed make it done', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [milestone(1, 'House · Mixed', day(10)), milestone(2, 'House · Clear', day(10))],
      issues: [
        task({ number: 1, milestone: 1, state: 'closed' }),
        task({ number: 2, milestone: 1 }),
        task({ number: 3, milestone: 2, state: 'closed' }),
      ],
    }),
  });
  assert.equal(entry(b, 1)?.m.state, 'open'); // one task still open
  assert.equal(entry(b, 2)?.m.state, 'done'); // twin: every task closed
});

// ---------- R18 ----------

test('R18 overdue is a date before today; due today and undated are open', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · Yesterday', day(-1)),
        milestone(2, 'House · Today', day(0)),
        milestone(3, 'House · Never', null),
      ],
      issues: [
        task({ number: 1, milestone: 1 }),
        task({ number: 2, milestone: 2 }),
        task({ number: 3, milestone: 3 }),
      ],
    }),
  });
  const states = [1, 2, 3].map((n) => entry(b, n)?.m.state);
  assert.deepEqual(states, ['overdue', 'open', 'open']);
  assert.equal(entry(b, 2)?.m.due, '2026-10-12');
});

test('R18 a done milestone with a past date is done, not overdue', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · Late', day(-3)),
        milestone(2, 'House · LateButClosed', day(-3), { state: 'closed', closed_at: '2026-10-05T09:00:00Z' }),
      ],
      issues: [task({ number: 1, milestone: 1 })],
    }),
  });
  assert.equal(entry(b, 1)?.m.state, 'overdue');
  assert.equal(entry(b, 2)?.m.state, 'done');
});

// ---------- R19 ----------

test('R19 a done milestone shows for 30 days after it was finished, an open one always', () => {
  resetNumbers();
  // Boundary reading: 10 days ago is in, 45 days ago is out. Exactly 30 days is not tested
  // because the contract does not settle whether the 30th day itself is in.
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · Finished10', day(-60), { state: 'closed', closed_at: '2026-10-02T09:00:00Z' }),
        milestone(2, 'House · Finished45', day(-50), { state: 'closed', closed_at: '2026-08-28T09:00:00Z' }),
        milestone(3, 'House · OpenNoDate', null),
        milestone(4, 'House · DoneYesterday', null, { state: 'closed', closed_at: '2026-10-11T09:00:00Z' }),
      ],
    }),
  });
  const l = lane(b, 'house');
  assert.ok(l, 'lane for house exists');
  assert.deepEqual(l.milestones.map((m) => m.number), [1]);
  assert.deepEqual(l.undated.map((m) => m.number), [3, 4]); // ordered by number
  assert.equal(entry(b, 2), undefined, 'milestone finished 45 days ago is nowhere on the timeline');
});

test('R19 a milestone is finished on the day of its latest task when it is not closed itself', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · RecentTasks', day(5)),
        milestone(2, 'House · OldTasks', day(5)),
        milestone(3, 'House · ClosedLongAgo', day(5), { state: 'closed', closed_at: '2026-08-28T09:00:00Z' }),
        milestone(4, 'House · StillOpen', day(5)),
      ],
      issues: [
        // milestone 1: latest close is 2026-10-02 (10 days ago), so it is in
        task({ number: 1, milestone: 1, state: 'closed', closed_at: '2026-10-02T09:00:00Z' }),
        task({ number: 2, milestone: 1, state: 'closed', closed_at: '2026-09-01T09:00:00Z' }),
        // milestone 2: only close is 2026-08-28 (45 days ago), so it is out
        task({ number: 3, milestone: 2, state: 'closed', closed_at: '2026-08-28T09:00:00Z' }),
        // milestone 3: closed itself 45 days ago; its own closed_at wins over a recent task close
        task({ number: 4, milestone: 3, state: 'closed', closed_at: '2026-10-02T09:00:00Z' }),
        // milestone 4: one open task, so not done, so always shown
        task({ number: 5, milestone: 4, state: 'closed', closed_at: '2026-08-01T09:00:00Z' }),
        task({ number: 6, milestone: 4 }),
      ],
    }),
  });
  const shown = lane(b, 'house')?.milestones.map((m) => m.number);
  assert.deepEqual(shown, [1, 4]);
  assert.equal(entry(b, 2), undefined);
  assert.equal(entry(b, 3), undefined);
});

// ---------- R20 ----------

test('R20 the window is clamped to three months back and eleven months ahead', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · Far past', '2025-06-10'),
        milestone(2, 'House · Near', '2026-09-20'),
        milestone(3, 'House · Far future', '2028-01-15'),
      ],
    }),
  });
  // start: earliest 2025-06-10 is before the clamp, first day of July 2026 (3 months before October)
  // end: latest 2028-01-15 is after the clamp, last day of September 2027 (11 months after October)
  assert.equal(b.timeline?.start, '2026-07-01');
  assert.equal(b.timeline?.end, '2027-09-30');
  const l = lane(b, 'house');
  assert.ok(l, 'lane for house exists');
  assert.equal(l.beforeWindow, 1);
  assert.equal(l.beyondWindow, 1);
  assert.ok(l.milestones.some((m) => m.due === '2026-09-20'), 'the milestone inside the window is drawn');
});

test('R20 a single milestone near today gives the default window', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [milestone(1, 'House · Hallway', '2026-10-20')],
    }),
  });
  // start: earlier of today-14 = 2026-09-28 and 2026-10-20 is 09-28, month of September -> 2026-09-01
  // end: later of today+28 = 2026-11-09 and 2026-10-20 is 11-09, month of November -> 2026-11-30
  assert.equal(b.timeline?.start, '2026-09-01');
  assert.equal(b.timeline?.end, '2026-11-30');
  const l = lane(b, 'house');
  assert.ok(l, 'lane for house exists');
  assert.equal(l.beforeWindow, 0);
  assert.equal(l.beyondWindow, 0);
  assert.deepEqual(l.milestones.map((m) => m.due), ['2026-10-20']);
});

test('R20 the window grows to hold milestones inside the clamp', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [milestone(1, 'House · Early', '2026-08-15'), milestone(2, 'House · Late', '2027-02-10')],
    }),
  });
  // start: 2026-08-15 is earlier than 09-28 and not before the clamp (07-01) -> 2026-08-01
  // end: 2027-02-10 is later than 11-09 and not after the clamp (2027-09-30) -> 2027-02-28 (2027 is no leap year)
  assert.equal(b.timeline?.start, '2026-08-01');
  assert.equal(b.timeline?.end, '2027-02-28');
  const l = lane(b, 'house');
  assert.ok(l, 'lane for house exists');
  assert.equal(l.beforeWindow, 0);
  assert.equal(l.beyondWindow, 0);
  assert.deepEqual(l.milestones.map((m) => m.due), ['2026-08-15', '2027-02-10']);
});

// ---------- R21 ----------

test('R21 the next milestone is the earliest not-done one, dated before undated, and overdue ones are counted', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · Someday', null), // undated, lowest number
        milestone(4, 'House · Past', day(-2)),
        milestone(5, 'House · Soon', day(3)),
        milestone(6, 'House · Later', day(9)),
      ],
    }),
  });
  const row = projectRow(b, 'house');
  assert.ok(row, 'project row exists');
  assert.deepEqual(row.nextMilestone, { shortTitle: 'Past', due: '2026-10-10' });
  assert.equal(row.overdueMilestones, 1);
});

test('R21 with no dated milestone the lowest-numbered undated one is next; overdue ones are not next once done', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(8, 'House · Eight', null),
        milestone(7, 'House · Seven', null),
        milestone(9, 'House · OldDone', day(-5), { state: 'closed', closed_at: '2026-10-05T09:00:00Z' }),
      ],
    }),
  });
  const row = projectRow(b, 'house');
  assert.ok(row, 'project row exists');
  assert.deepEqual(row.nextMilestone, { shortTitle: 'Seven', due: null });
  assert.equal(row.overdueMilestones, 0); // the past-dated one is done, so not overdue
});

test('R21 only done milestones give no next milestone and no overdue count', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(1, 'House · A', day(-4), { state: 'closed', closed_at: '2026-10-05T09:00:00Z' }),
        milestone(2, 'House · B', day(4), { state: 'closed', closed_at: '2026-10-05T09:00:00Z' }),
      ],
    }),
  });
  const row = projectRow(b, 'house');
  assert.ok(row, 'project row exists');
  assert.equal(row.nextMilestone, null);
  assert.equal(row.overdueMilestones, 0);
});

// ---------- R22 ----------

test('R22 a task whose milestone belongs to another project counts both ways and is flagged', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3], ['garden', 4]]),
    raw: raw({
      projects: [project(3, 'House', [{ number: 1 }]), project(4, 'Garden', [])],
      milestones: [milestone(7, 'Garden · Beds', day(10))],
      issues: [task({ number: 1, milestone: 7 })],
    }),
  });
  assert.equal(projectRow(b, 'house')?.total, 1);
  assert.equal(projectRow(b, 'garden')?.total, 0);
  const e = entry(b, 7);
  assert.ok(e, 'milestone 7 is on the timeline');
  assert.equal(e.key, 'garden');
  assert.equal(e.m.total, 1);
  assert.equal(warn(b, 'milestone-crosses-project'), 1);
});

test('R22 a task in its own project milestone is not flagged', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3], ['garden', 4]]),
    raw: raw({
      projects: [project(3, 'House', [{ number: 1 }, { number: 2 }]), project(4, 'Garden', [])],
      milestones: [milestone(5, 'House · Hallway', day(10)), milestone(7, 'Garden · Beds', day(11))],
      issues: [task({ number: 1, milestone: 5 }), task({ number: 2, milestone: 7 })],
    }),
  });
  // only task 2 crosses: it is a house item in a garden milestone
  assert.equal(warn(b, 'milestone-crosses-project'), 1);
  assert.equal(entry(b, 5)?.m.total, 1);
  assert.equal(entry(b, 7)?.m.total, 1);
  assert.equal(projectRow(b, 'house')?.total, 2);
});

// ---------- R93 ----------

// One focus project "house" so its task takes a seat in `next`.
function r93({ itemDue = null, ms = null, milestoneNumber = null }) {
  resetNumbers();
  const issues = [task({ number: 1, milestone: milestoneNumber })];
  return board({
    settings: cfg([['house', 3]], ['house']),
    raw: raw({
      projects: [project(3, 'House', [{ number: 1, due: itemDue }])],
      milestones: ms ? [ms] : [],
      issues,
    }),
  });
}

test('R93 the item date wins over a later milestone date', () => {
  const b = r93({ itemDue: '2026-10-18', ms: milestone(5, 'House · Hallway', '2026-10-20'), milestoneNumber: 5 });
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, '2026-10-18');
  assert.equal(s.urgency, 'dated');
  assert.equal(s.overdueDays, 0);
});

test('R93 the item date alone is the task date', () => {
  const b = r93({ itemDue: '2026-10-18' });
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, '2026-10-18');
});

test('R93 with no item date the open milestone date is the task date', () => {
  const b = r93({ ms: milestone(5, 'House · Hallway', '2026-10-20'), milestoneNumber: 5 });
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, '2026-10-20');
  assert.equal(s.urgency, 'dated');
});

test('R93 a milestone closed on GitHub gives no date', () => {
  const b = r93({
    ms: milestone(5, 'House · Hallway', '2026-10-20', { state: 'closed', closed_at: '2026-10-05T09:00:00Z' }),
    milestoneNumber: 5,
  });
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, null);
  assert.equal(s.urgency, 'undated');
  assert.equal(s.overdueDays, 0);
});

test('R93 a date of yesterday is overdue by one day', () => {
  const b = r93({ itemDue: '2026-10-11' });
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, '2026-10-11');
  assert.equal(s.urgency, 'overdue');
  assert.equal(s.overdueDays, 1);
});

test('R93 a milestone date in the past makes the task overdue by the gap', () => {
  const b = r93({ ms: milestone(5, 'House · Hallway', '2026-10-09'), milestoneNumber: 5 });
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, '2026-10-09');
  assert.equal(s.urgency, 'overdue');
  assert.equal(s.overdueDays, 3); // 12 - 9
});

test('R93 a milestone due today is not overdue and neither is its task', () => {
  const b = r93({ ms: milestone(5, 'House · Hallway', '2026-10-12'), milestoneNumber: 5 });
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, '2026-10-12');
  assert.equal(s.urgency, 'dated');
  assert.equal(s.overdueDays, 0);
  assert.equal(entry(b, 5)?.m.state, 'open');
});

test('R93 a closed milestone with an open task gives that task no date', () => {
  // closed on GitHub means done (R17), so its date is not lent to the task
  const b = r93({
    ms: milestone(5, 'House · Hallway', '2026-10-20', { state: 'closed', closed_at: '2026-10-05T09:00:00Z' }),
    milestoneNumber: 5,
  });
  assert.equal(entry(b, 5)?.m.state, 'done');
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, null);
});

test('R93 the item date comes from the first project in R8 order that has one', () => {
  resetNumbers();
  const raw1 = raw({
    projects: [
      project(3, 'House', [{ number: 1, due: '2026-10-20' }]),
      project(4, 'Garden', [{ number: 1, due: '2026-10-15' }]),
    ],
    issues: [task({ number: 1 })],
  });
  // no focus: settings order house, garden -> house's date
  const plain = board({ settings: cfg([['house', 3], ['garden', 4]]), raw: raw1 });
  const s1 = seat(plain, 1);
  assert.ok(s1, 'the task has a seat in next');
  assert.equal(s1.due, '2026-10-20');
  // focus on garden moves it first -> garden's date
  resetNumbers();
  const focused = board({ settings: cfg([['house', 3], ['garden', 4]], ['garden']), raw: raw1 });
  const s2 = seat(focused, 1);
  assert.ok(s2, 'the task has a seat in next');
  assert.equal(s2.due, '2026-10-15');
});

test('R93 an earlier project without a date is skipped for a later one that has one', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3], ['garden', 4]]),
    raw: raw({
      projects: [
        project(3, 'House', [{ number: 1, due: null }]),
        project(4, 'Garden', [{ number: 1, due: '2026-10-15' }]),
      ],
      milestones: [milestone(5, 'House · Hallway', '2026-10-20')],
      issues: [task({ number: 1, milestone: 5 })],
    }),
  });
  const s = seat(b, 1);
  assert.ok(s, 'the task has a seat in next');
  assert.equal(s.due, '2026-10-15'); // an item date beats the milestone date
});

test('R93 a standalone task takes the date of its open milestone, and none from a closed one', () => {
  resetNumbers();
  const b = board({
    settings: cfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [
        milestone(5, 'Errands · Admin', '2026-10-20'),
        milestone(6, 'Errands · Old', '2026-10-22', { state: 'closed', closed_at: '2026-10-05T09:00:00Z' }),
      ],
      issues: [
        task({ number: 30, milestone: 5 }),
        task({ number: 31, milestone: 6 }),
        task({ number: 32 }),
      ],
    }),
  });
  const items = b.standalone?.items ?? [];
  assert.equal(items.length, 3);
  const due = (n) => items.find((i) => i.number === n)?.due;
  assert.equal(due(30), '2026-10-20');
  assert.equal(due(31), null);
  assert.equal(due(32), null);
});
