// Rules R23 to R31: focus and What's next. Written from references/contract.md; every test goes through buildBoard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { board, settings, project, milestone, task, idea, checkin, raw, state, resetNumbers } from '../fixtures/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Today on the board is 2026-10-12 (NOW is 06:10Z, board timezone Europe/Brussels).
const KEYS = ['a', 'b', 'c', 'd'];
const TITLES = { a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta' };
const COLORS = { a: '#111111', b: '#222222', c: '#333333', d: '#444444' };

function warnCount(b, code) {
  const list = b?.meta?.warnings;
  if (!Array.isArray(list)) return 0;
  const hit = list.find((w) => w.code === code);
  return hit ? hit.count : 0;
}

function nums(b) {
  return Array.isArray(b?.next) ? b.next.map((x) => x.number) : [];
}

// spec: { a: [{ n, due?, milestone?, state? }, ...] } in the order the items are listed in the Project.
// A task number used under two keys becomes one issue that is an item of both Projects.
function world({ focus = [], count = 5, spec = {}, milestones = [], keys = KEYS }) {
  resetNumbers();
  const issues = new Map();
  const projects = keys.map((key, i) => {
    const items = (spec[key] ?? []).map((t) => {
      if (!issues.has(t.n)) {
        const extra = { number: t.n };
        if (t.milestone !== undefined) extra.milestone = t.milestone;
        if (t.state) extra.state = t.state;
        issues.set(t.n, task(extra));
      }
      return { number: t.n, due: t.due ?? null };
    });
    return project(i + 1, TITLES[key], items);
  });
  const s = settings({
    projects: keys.map((key, i) => ({ key, number: i + 1, color: COLORS[key] })),
    focus,
    next: { count },
  });
  const r = raw({ issues: [...issues.values()], milestones, projects });
  return { r, s, b: board({ raw: r, settings: s }) };
}

// ---------- R23 ----------

function sweepSettings() {
  return settings({
    projects: [
      { key: 'house', number: 3, color: '#111111' },
      { key: 'side', number: 4, color: '#222222' },
      { key: 'third', number: 5, color: '#333333' },
      { key: 'fourth', number: 6, color: '#444444' },
    ],
    focus: ['fourth', 'side'], // listed order is house, side, third, fourth, so R8 gives side then fourth
  });
}

function sweepProjects(itemsFor) {
  return [
    project(3, 'House', itemsFor(3)),
    project(4, 'Side project', itemsFor(4)),
    project(5, 'Third', itemsFor(5)),
    project(6, 'Fourth', itemsFor(6)),
  ];
}

const SWEEP_EXPECTED = [
  { key: 'side', title: 'Side project', color: '#222222' },
  { key: 'fourth', title: 'Fourth', color: '#444444' },
];

function sweepInputs() {
  resetNumbers();
  const overdueTasks = [task({ number: 11 }), task({ number: 12 }), task({ number: 13 }), task({ number: 14 })];
  const overdue = raw({
    issues: overdueTasks,
    projects: sweepProjects((n) => [{ number: 10 + (n - 2), due: '2026-09-01' }]),
  });
  const closedTasks = [11, 12, 13, 14].map((n) => task({ number: n, state: 'closed' }));
  const closed = raw({
    issues: closedTasks,
    projects: sweepProjects((n) => [{ number: 10 + (n - 2), due: null }]),
  });
  const empty = raw({ projects: sweepProjects(() => []) });
  const ideas = raw({
    issues: [idea({ number: 21 }), idea({ number: 22 })],
    projects: sweepProjects((n) => [{ number: 21 + (n % 2), due: null }]),
  });
  const brokenRaw = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'raw', 'broken.json'), 'utf8'));
  brokenRaw.projects = [
    ...brokenRaw.projects.filter((p) => p.number === 3 || p.number === 4),
    project(5, 'Third', []),
    project(6, 'Fourth', []),
  ];
  return { overdue, closed, empty, ideas, broken: brokenRaw };
}

test('R23 the same two focus projects come out of five very different raw inputs', () => {
  const inputs = sweepInputs();
  for (const [name, r] of Object.entries(inputs)) {
    const b = board({ raw: r, settings: sweepSettings() });
    assert.equal(b.focus?.projects?.length, 2, `${name}: two focus projects`);
    assert.deepEqual(b.focus.projects, SWEEP_EXPECTED, `${name}: focus projects`);
  }
});

test('R23 the four projects are shown in every sweep input and exactly the focus ones carry the mark', () => {
  const inputs = sweepInputs();
  for (const [name, r] of Object.entries(inputs)) {
    const b = board({ raw: r, settings: sweepSettings() });
    assert.equal(b.projects?.length, 4, `${name}: four project rows`);
    const marked = b.projects.filter((p) => p.focus === true).map((p) => p.key);
    // R8: focus first (side, fourth), then the rest in the user's order (house, third)
    assert.deepEqual(b.projects.map((p) => p.key), ['side', 'fourth', 'house', 'third'], `${name}: row order`);
    assert.deepEqual(marked, ['side', 'fourth'], `${name}: marked rows`);
  }
});

// ---------- R24 ----------

function houseSide(focus) {
  resetNumbers();
  return board({
    raw: raw({
      issues: [task({ number: 1 })],
      projects: [project(3, 'House', [1]), project(4, 'Side project', [])],
    }),
    settings: settings({
      projects: [{ key: 'house', number: 3, color: '#111111' }, { key: 'side', number: 4, color: '#222222' }],
      focus,
    }),
  });
}

test('R24 an unknown focus key is ignored and counted once', () => {
  const b = houseSide(['house', 'nope']);
  assert.equal(b.focus?.projects?.length, 1);
  assert.equal(b.focus.projects[0].key, 'house');
  assert.equal(warnCount(b, 'focus-unknown'), 1);
});

test('R24 with only known focus keys there is no focus-unknown warning', () => {
  const b = houseSide(['house']);
  assert.equal(b.focus?.projects?.length, 1);
  assert.equal(b.focus.projects[0].key, 'house');
  assert.equal(warnCount(b, 'focus-unknown'), 0);
});

// ---------- R25 ----------

const R25_SPEC = {
  a: [{ n: 12, due: '2026-10-14' }, { n: 11, due: '2026-10-13' }],
  b: [{ n: 21, due: '2026-10-14' }, { n: 22, due: '2026-10-13' }],
  c: [{ n: 32, due: '2026-10-02' }, { n: 33, due: '2026-10-01' }], // overdue
  d: [{ n: 43, due: '2026-10-14' }, { n: 44, due: '2026-10-13' }],
};

test('R25 with no focus nothing is highlighted but four project rows exist', () => {
  const { b } = world({ focus: [], spec: R25_SPEC });
  assert.equal(b.projects?.length, 4);
  assert.deepEqual(b.projects.map((p) => p.key), ['a', 'b', 'c', 'd']);
  assert.ok(b.projects.every((p) => p.focus !== true));
  assert.deepEqual(b.focus?.projects, []);
});

test('R25 with no focus the seats are dealt across all projects in settings order', () => {
  const { b } = world({ focus: [], spec: R25_SPEC });
  // round 1: a1=11, b1=22, c1=33 (overdue), d1=44; round 2: a2=12. A global urgency sort would start with 33.
  assert.deepEqual(nums(b), [11, 22, 33, 44, 12]);
});

test('R25 twin: with a focus set the focus project is marked and the others are not', () => {
  const { b } = world({ focus: ['c'], spec: R25_SPEC });
  assert.equal(b.projects?.length, 4);
  assert.deepEqual(b.projects.filter((p) => p.focus === true).map((p) => p.key), ['c']);
  assert.deepEqual(b.focus?.projects?.map((p) => p.key), ['c']);
});

// ---------- R26 ----------

function proposalBoard(proposal, updated = '2026-10-12T05:00:00Z') {
  resetNumbers();
  return board({
    raw: raw({
      issues: [task({ number: 1 })],
      projects: [project(3, 'House', [1]), project(4, 'Side project', [])],
    }),
    settings: settings({
      projects: [{ key: 'house', number: 3, color: '#111111' }, { key: 'side', number: 4, color: '#222222' }],
      focus: ['house'],
    }),
    state: state({ proposals: { updated, focus: proposal, ideas: [] } }),
  });
}

test('R26 a proposal is shown with unknown keys dropped and focus left unchanged', () => {
  const b = proposalBoard({ add: ['side', 'nope'], remove: [], why: 'Two milestones fall due this week' });
  assert.ok(b.focus?.proposal, 'a proposal is present');
  assert.deepEqual(b.focus.proposal.add, ['side']);
  assert.deepEqual(b.focus.proposal.remove, []);
  assert.equal(b.focus.proposal.why, 'Two milestones fall due this week');
  assert.equal(b.focus.proposal.stale, false); // updated 65 minutes before now
  assert.deepEqual(b.focus.projects.map((p) => p.key), ['house']);
});

test('R26 a proposal naming only an unknown key is null', () => {
  const b = proposalBoard({ add: ['nope'], remove: [], why: 'Nothing real' });
  assert.equal(b.focus?.proposal, null);
  assert.deepEqual(b.focus?.projects?.map((p) => p.key), ['house']);
});

test('R26 remove keys that are shown projects are kept and others dropped', () => {
  const b = proposalBoard({ add: [], remove: ['house', 'nope'], why: 'Rest' });
  assert.ok(b.focus?.proposal, 'a proposal is present');
  assert.deepEqual(b.focus.proposal.add, []);
  assert.deepEqual(b.focus.proposal.remove, ['house']);
  assert.deepEqual(b.focus.projects.map((p) => p.key), ['house']); // never applied
});

test('R26 a proposal from a 30-hour-old file is still shown, marked stale', () => {
  const b = proposalBoard({ add: ['side'], remove: [], why: 'Old' }, '2026-10-11T00:10:00Z');
  assert.ok(b.focus?.proposal, 'a proposal is present');
  assert.deepEqual(b.focus.proposal.add, ['side']);
  assert.equal(b.focus.proposal.stale, true);
});

test('R26 with no proposals file there is no proposal, and the focus is still there', () => {
  const b = houseSide(['house']);
  assert.equal(b.focus?.proposal, null);
  assert.deepEqual(b.focus?.projects?.map((p) => p.key), ['house']);
});

// ---------- R27 ----------

test('R27 only the open project task is a candidate', () => {
  resetNumbers();
  const issues = [
    task({ number: 1 }), // the one open project task
    idea({ number: 2 }), // an idea that is an item of the shown project and sits in a milestone
    { ...checkin('move', '2026-10-11', { closed: false }), number: 3 }, // an open check-in of a known habit
    task({ number: 4, labels: ['weekly-review'] }), // ignored
    task({ number: 5 }), // standalone
    task({ number: 6, state: 'closed' }), // closed project task
  ];
  const s = settings({
    projects: [{ key: 'house', number: 3, color: '#111111' }],
    habits: [{ id: 'move', title: 'Move' }],
  });
  const r = raw({
    issues: [{ ...issues[1], milestone: 7 }, issues[0], issues[2], issues[3], issues[4], issues[5]],
    milestones: [milestone(7, 'House · Hallway', '2026-10-20')],
    projects: [project(3, 'House', [1, 2, 3, 4, 6])],
  });
  const b = board({ raw: r, settings: s });
  assert.deepEqual(nums(b), [1]);
});

test('R27 twin: the same open tasks do appear when the project holds them', () => {
  const { b } = world({ focus: [], spec: { a: [{ n: 1 }, { n: 2 }] } });
  assert.deepEqual(nums(b), [1, 2]);
});

test('R27 a standalone task never takes a seat even when seats are free', () => {
  resetNumbers();
  const r = raw({
    issues: [task({ number: 1 }), task({ number: 2 })],
    projects: [project(1, 'Alpha', [1])],
  });
  const s = settings({ projects: [{ key: 'a', number: 1, color: '#111111' }] });
  const b = board({ raw: r, settings: s });
  assert.deepEqual(nums(b), [1]);
  assert.equal(b.standalone?.count, 1); // task 2 is standalone, so it is somewhere else on the board
});

// ---------- R28 ----------

test('R28 overdue most overdue first, then dated soonest first, then undated by number', () => {
  const { b } = world({
    focus: ['a'],
    spec: {
      a: [
        { n: 40 },
        { n: 52, due: '2026-10-15' }, // in 3 days
        { n: 51, due: '2026-10-10' }, // 2 days ago
        { n: 12 },
        { n: 50, due: '2026-10-07' }, // 5 days ago
      ],
    },
  });
  assert.deepEqual(nums(b), [50, 51, 52, 12, 40]);
  assert.deepEqual(b.next.map((x) => x.urgency), ['overdue', 'overdue', 'dated', 'undated', 'undated']);
});

test('R28 a task dated today is dated, not overdue, and ranks after the overdue one', () => {
  const { b } = world({
    focus: ['a'],
    spec: { a: [{ n: 4 }, { n: 5, due: '2026-10-12' }, { n: 6, due: '2026-10-11' }] },
  });
  assert.deepEqual(nums(b), [6, 5, 4]);
  assert.deepEqual(b.next.map((x) => x.urgency), ['overdue', 'dated', 'undated']);
});

test('R28 ties on the same date go to the lower issue number', () => {
  const { b } = world({
    focus: ['a'],
    spec: {
      a: [
        { n: 9, due: '2026-10-10' },
        { n: 8, due: '2026-10-14' },
        { n: 3, due: '2026-10-10' },
        { n: 2, due: '2026-10-14' },
      ],
    },
  });
  assert.deepEqual(nums(b), [3, 9, 2, 8]);
});

test('R28 a milestone date orders a task that has no date of its own', () => {
  // task 7 has no item date; its open milestone is due 2026-10-14 (R93), so it ranks before the task dated 10-16
  const { b } = world({
    focus: ['a'],
    spec: { a: [{ n: 6, due: '2026-10-16' }, { n: 7, milestone: 5 }, { n: 1 }] },
    milestones: [milestone(5, 'Alpha · Step', '2026-10-14')],
  });
  assert.deepEqual(nums(b), [7, 6, 1]);
});

// ---------- R29 ----------

const R29_SPEC = {
  a: [
    { n: 201, due: '2026-10-16' },
    { n: 202, due: '2026-10-15' },
    { n: 203, due: '2026-10-14' },
    { n: 204, due: '2026-10-13' },
  ],
  b: [{ n: 401, due: '2026-09-01' }], // overdue, not in focus
  c: [{ n: 301 }], // undated
  d: [{ n: 501, due: '2026-09-02' }],
};

test('R29 every focus project gets a seat before any gets a second', () => {
  const { b } = world({ focus: ['a', 'c'], spec: R29_SPEC, count: 5 });
  // a1=204, c1=301, a2=203, a3=202, a4=201. Sorting everything by urgency would put 301 last.
  assert.deepEqual(nums(b), [204, 301, 203, 202, 201]);
});

test('R29 the round order is the order of R8, not the order of the focus list', () => {
  const { b } = world({ focus: ['c', 'a'], spec: R29_SPEC, count: 5 });
  assert.deepEqual(nums(b), [204, 301, 203, 202, 201]);
});

test('R29 the list has next.count seats', () => {
  const { b } = world({ focus: ['a', 'c'], spec: R29_SPEC, count: 3 });
  assert.deepEqual(nums(b), [204, 301, 203]);
});

test('R29 a task in two projects, one in focus, takes its seat under the focus project and appears once', () => {
  const { b } = world({
    focus: ['c'],
    spec: {
      a: [{ n: 8 }, { n: 7 }], // 7 is also an item of c
      c: [{ n: 7, due: '2026-10-14' }],
    },
  });
  // R8 order is c, a: 7 belongs to c (it carries c's date); a still has task 8.
  assert.deepEqual(nums(b), [7, 8]);
  assert.equal(nums(b).filter((n) => n === 7).length, 1);
  assert.equal(b.next[0].project?.key, 'c');
  assert.equal(b.next[0].due, '2026-10-14');
  assert.equal(b.next[1].project?.key, 'a');
});

// ---------- R30 ----------

test('R30 other projects only fill leftover seats, dealt round by round', () => {
  const { b } = world({
    focus: ['a'],
    count: 5,
    spec: {
      a: [{ n: 103, due: '2026-10-20' }, { n: 104, due: '2026-10-13' }],
      b: [{ n: 202, due: '2026-10-16' }, { n: 203, due: '2026-10-15' }, { n: 204, due: '2026-10-14' }],
      c: [],
      d: [{ n: 302, due: '2026-10-03' }, { n: 303, due: '2026-10-02' }, { n: 304, due: '2026-10-01' }], // all overdue
    },
  });
  // a1=104, a2=103, then b1=204, d1=304, b2=203. A global urgency sort would give the overdue d tasks first.
  assert.deepEqual(nums(b), [104, 103, 204, 304, 203]);
});

test('R30 twin: with the focus project holding five tasks, no other project gets a seat', () => {
  const { b } = world({
    focus: ['a'],
    count: 5,
    spec: {
      a: [1, 2, 3, 4, 5].map((i) => ({ n: 100 + i, due: `2026-10-1${i}` })),
      b: [{ n: 201, due: '2026-09-01' }],
    },
  });
  assert.deepEqual(nums(b), [101, 102, 103, 104, 105]);
});

// ---------- R31 ----------

test('R31 a seat carries project, milestone short title, date, urgency and overdue days', () => {
  const { b } = world({
    focus: ['a'],
    spec: { a: [{ n: 9, due: '2026-10-10', milestone: 5 }] },
    milestones: [milestone(5, 'Alpha · Hallway', '2026-10-20')],
  });
  assert.equal(b.next?.length, 1);
  const item = b.next[0];
  assert.equal(item.number, 9);
  assert.deepEqual(
    { key: item.project?.key, title: item.project?.title, color: item.project?.color },
    { key: 'a', title: 'Alpha', color: '#111111' },
  );
  assert.deepEqual(item.milestone, { shortTitle: 'Hallway' });
  assert.equal(item.due, '2026-10-10');
  assert.equal(item.urgency, 'overdue');
  assert.equal(item.overdueDays, 2);
});

test('R31 a task with no date and no milestone has due null, no milestone and 0 overdue days', () => {
  const { b } = world({ focus: ['a'], spec: { a: [{ n: 9 }] } });
  assert.equal(b.next?.length, 1);
  const item = b.next[0];
  assert.equal(item.due, null);
  assert.equal(item.milestone, null);
  assert.equal(item.urgency, 'undated');
  assert.equal(item.overdueDays, 0);
});

test('R31 a task dated by its milestone shows that date and 0 overdue days', () => {
  const { b } = world({
    focus: ['a'],
    spec: { a: [{ n: 9, milestone: 5 }] },
    milestones: [milestone(5, 'Alpha · Hallway', '2026-10-20')],
  });
  assert.equal(b.next?.length, 1);
  const item = b.next[0];
  assert.equal(item.due, '2026-10-20');
  assert.equal(item.urgency, 'dated');
  assert.equal(item.overdueDays, 0);
  assert.deepEqual(item.milestone, { shortTitle: 'Hallway' });
});
