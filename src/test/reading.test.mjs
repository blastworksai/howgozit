// Contract rules R1 to R5: reading the input. Every test goes through buildBoard (via board()) only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  board, settings, project, milestone, task, idea, pr, checkin, raw, resetNumbers,
} from '../fixtures/build.mjs';
import { checkBoard } from '../board/shape-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures');
const readJson = (rel) => JSON.parse(readFileSync(path.join(FIX, rel), 'utf8'));

// ---- helpers ---------------------------------------------------------------------------------------------------
const warning = (b, code) => {
  const list = Array.isArray(b?.meta?.warnings) ? b.meta.warnings : [];
  return list.find((w) => w.code === code)?.count ?? 0;
};

function row(b, key) {
  assert.ok(Array.isArray(b.projects), 'board.projects is a list');
  const r = b.projects.find((p) => p.key === key);
  assert.ok(r, `project row ${key} exists`);
  return r;
}

function habit(b, id) {
  assert.ok(Array.isArray(b.habits), 'board.habits is a list');
  const h = b.habits.find((x) => x.id === id);
  assert.ok(h, `habit ${id} exists`);
  return h;
}

const dayOf = (b, date) => {
  const days = (b.heatmap?.weeks ?? []).flat();
  const d = days.find((x) => x.date === date);
  assert.ok(d, `heatmap has ${date}`);
  return d;
};

// True when the value holds the number n anywhere, or a string with /pull/n or /issues/n.
function holds(value, n) {
  if (typeof value === 'number') return value === n;
  if (typeof value === 'string') return value.includes(`/pull/${n}`) || value.includes(`/issues/${n}`);
  if (Array.isArray(value)) return value.some((v) => holds(v, n));
  if (value && typeof value === 'object') return Object.values(value).some((v) => holds(v, n));
  return false;
}

// checkin() allocates its own number; this pins one so nothing collides with explicit task numbers.
const ci = (n, ...args) => ({ ...checkin(...args), number: n });

const HOUSE = [{ key: 'house', number: 3 }];
const MOVE = [{ id: 'move', title: 'Move', start: '2026-10-10' }];

// ---- R1 --------------------------------------------------------------------------------------------------------
function r1Input(withPr, prAsTask = false) {
  resetNumbers();
  const issues = [
    task({ number: 1, milestone: 1 }),
    task({ number: 2, milestone: 1, state: 'closed' }),
    idea({ number: 3 }),
    task({ number: 4, state: 'closed', closed_at: '2026-10-12T05:00:00Z' }),
  ];
  const items = [1, 2, 4];
  if (withPr) {
    issues.push(pr({ number: 7001, milestone: 1, labels: ['idea'], is_pr: !prAsTask }));
    items.push(7001);
  }
  return {
    raw: raw({
      issues,
      milestones: [milestone(1, 'House · Walls', '2026-10-20')],
      projects: [project(3, 'House', items)],
    }),
    settings: settings({ projects: HOUSE }),
  };
}

test('R1 a pull request changes nothing on the board and its number appears nowhere', () => {
  const without = board(r1Input(false));
  const withPr = board(r1Input(true));
  // non-empty: tasks 1, 2 and 4 are in House, so total 3; one idea.
  assert.equal(row(without, 'house').total, 3);
  assert.equal(without.ideas.count, 1);
  assert.deepEqual(withPr, without);
  assert.equal(holds(withPr, 7001), false);
});

test('R1 the same issue that is not a pull request does show up (presence twin)', () => {
  const b = board(r1Input(true, true));
  // it carries the idea label, so by R2 it is an idea, not a task: the backlog grows from 1 to 2
  // and House's total stays 3 (an idea counts in no progress, R33).
  assert.equal(b.ideas.count, 2);
  assert.equal(row(b, 'house').total, 3);
  assert.equal(holds(b, 7001), true);
});

test('R1 a pull request closed today adds nothing to the 12-week map', () => {
  const input = r1Input(true);
  input.raw.issues.find((i) => i.number === 7001).state = 'closed';
  input.raw.issues.find((i) => i.number === 7001).closed_at = '2026-10-12T05:30:00Z';
  const b = board(input);
  // only task 4 was closed on 2026-10-12 (07:00 local); the pull request would make it 2.
  assert.equal(dayOf(b, '2026-10-12').count, 1);
  assert.equal(holds(b, 7001), false);
});

// ---- R2 --------------------------------------------------------------------------------------------------------
test('R2 an issue with both a habit label and the idea label is a check-in only', () => {
  resetNumbers();
  const issues = [
    task({ number: 1 }),
    task({ number: 5, title: 'Move · 2026-10-12', labels: ['habit:move', 'idea'], state: 'closed', closed_at: '2026-10-12T05:00:00Z' }),
    task({ number: 6, title: 'Move · 2026-10-11', labels: ['habit:move', 'idea'] }),
    idea({ number: 7 }),
  ];
  const b = board({
    raw: raw({ issues, projects: [project(3, 'House', [1, 5, 6])] }),
    settings: settings({ projects: HOUSE, habits: MOVE }),
  });
  // idea twin: only the plain idea 7 is an idea.
  assert.equal(b.ideas.count, 1);
  assert.deepEqual(b.ideas.items.map((i) => i.number), [7]);
  // not a task: House holds only task 1.
  assert.equal(row(b, 'house').total, 1);
  assert.equal(b.standalone.count, 0);
  // it is a check-in: the 12th is done.
  const h = habit(b, 'move');
  assert.equal(h.doneToday, true);
  assert.equal(h.recent.at(-1).status, 'done');
});

test('R2 labels are compared trimmed and case-insensitively', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [
        task({ number: 1, title: 'Shelves', labels: ['IDEA '] }),
        task({ number: 2, title: 'Move · 2026-10-12', labels: [' Habit:move '], state: 'closed', closed_at: '2026-10-12T05:00:00Z' }),
      ],
    }),
    settings: settings({ projects: HOUSE, habits: MOVE }),
  });
  assert.equal(b.ideas.count, 1);
  assert.deepEqual(b.ideas.items.map((i) => i.number), [1]);
  assert.equal(b.standalone.count, 0);
  assert.equal(habit(b, 'move').doneToday, true);
});

test('R2 an ignored issue appears in no list and no count', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [
        task({ number: 1 }),
        task({ number: 2, labels: ['weekly-review'] }),
        task({ number: 3, labels: ['Weekly-Review '] }),
        task({ number: 4, labels: ['weekly-review'] }),
      ],
      projects: [project(3, 'House', [1, 2, 3])],
    }),
    settings: settings({ projects: HOUSE }),
  });
  // twin: the plain task 1 is there; 2 and 3 are items of House but ignored; 4 is not an item and is not standalone.
  assert.equal(row(b, 'house').total, 1);
  assert.deepEqual(b.next.map((n) => n.number), [1]);
  assert.equal(b.standalone.count, 0);
  assert.equal(b.ideas.count, 0);
});

test('R2 an ignored issue still shows in the 12-week map once closed', () => {
  resetNumbers();
  const closedToday = (extra) => task({ state: 'closed', closed_at: '2026-10-12T05:00:00Z', ...extra });
  const b = board({
    raw: raw({ issues: [closedToday({ number: 1, labels: ['weekly-review'] }), closedToday({ number: 2 })] }),
    settings: settings({ projects: HOUSE }),
  });
  // both closed on 2026-10-12 (07:00 local): the ignored one counts here, so 2.
  assert.equal(dayOf(b, '2026-10-12').count, 2);
});

test('R2 ignored outranks check-in, so an ignored check-in does not tick the habit', () => {
  const make = (labels) => {
    resetNumbers();
    return board({
      raw: raw({
        issues: [task({ number: 1, title: 'Move · 2026-10-12', labels, state: 'closed', closed_at: '2026-10-12T05:00:00Z' })],
      }),
      settings: settings({ projects: HOUSE, habits: MOVE }),
    });
  };
  assert.equal(habit(make(['habit:move']), 'move').doneToday, true);
  assert.equal(habit(make(['weekly-review', 'habit:move']), 'move').doneToday, false);
});

// ---- R3 --------------------------------------------------------------------------------------------------------
test('R3 an unreadable check-in is ignored with one warning and a retired habit with none', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [
        task({ number: 1 }),
        ci(11, 'ghost', '2026-10-10'),
        ci(12, 'ghost', '2026-10-09', { closed: false }),
        ci(13, 'move', '2026-10-10', { title: 'Move · 2026-02-30' }),
        ci(14, 'move', '2026-10-09', { title: 'Move · 2026-02-30', closed: false }),
        ci(15, 'move', '2026-10-11'),
      ],
      projects: [project(3, 'House', [1, 11, 12, 13, 14, 15])],
    }),
    settings: settings({ projects: HOUSE, habits: MOVE }),
  });
  // two issues carry the impossible date 2026-02-30, so the warning is 2; the ghosts add nothing.
  assert.equal(warning(b, 'checkin-unreadable'), 2);
  // none became tasks (House holds only issue 1), ideas or standalone tasks.
  assert.equal(row(b, 'house').total, 1);
  assert.equal(b.ideas.count, 0);
  assert.equal(b.standalone.count, 0);
  // habit days: the valid one on the 11th is done; the 10th (closed, impossible date) is not.
  const days = habit(b, 'move').recent;
  assert.equal(days.find((d) => d.date === '2026-10-11')?.status, 'done');
  assert.notEqual(days.find((d) => d.date === '2026-10-10')?.status, 'done');
});

test('R3 exactly one unreadable check-in adds exactly one, and a retired habit adds none', () => {
  resetNumbers();
  const make = (issues) => board({ raw: raw({ issues }), settings: settings({ projects: HOUSE, habits: MOVE }) });
  const one = make([ci(21, 'ghost', '2026-10-10'), ci(22, 'move', '2026-10-10', { title: 'Move · 2026-02-30' })]);
  assert.equal(warning(one, 'checkin-unreadable'), 1);
  const none = make([ci(23, 'ghost', '2026-10-10'), ci(24, 'move', '2026-10-10')]);
  assert.equal(warning(none, 'checkin-unreadable'), 0);
  assert.equal(habit(none, 'move').recent.find((d) => d.date === '2026-10-10')?.status, 'done');
});

test('R3 titles that do not end in a separator and a real date all count as unreadable', () => {
  resetNumbers();
  const titles = ['Move', 'Move · 2026-10-1', 'Move · 2026-13-01', 'Move 2026-10-10'];
  const b = board({
    raw: raw({ issues: titles.map((t, i) => ci(31 + i, 'move', '2026-10-10', { title: t, closed: i % 2 === 0 })) }),
    settings: settings({ projects: HOUSE, habits: MOVE }),
  });
  assert.equal(warning(b, 'checkin-unreadable'), 4);
});

// ---- R4 --------------------------------------------------------------------------------------------------------
test('R4 only issues of the data repo count as project items', () => {
  resetNumbers();
  const items = [
    1,
    2,
    { type: 'PullRequest', repo: 'sam-life/life', number: 4 },
    { type: 'DraftIssue', repo: null, number: null },
    { type: 'Issue', repo: 'other/place', number: 3 },
    { type: 'REDACTED', repo: null, number: null },
  ];
  const b = board({
    raw: raw({
      issues: [task({ number: 1 }), task({ number: 2 }), task({ number: 3 }), task({ number: 4 })],
      projects: [project(3, 'House', items)],
    }),
    settings: settings({ projects: HOUSE }),
  });
  // items 1 and 2 count; the pull-request item, the draft and the other-repo item do not: total 2.
  assert.equal(row(b, 'house').total, 2);
  assert.equal(warning(b, 'items-hidden'), 1);
  // issues 3 and 4 are items of no shown project (their items were ignored), so they are standalone.
  assert.equal(b.standalone.count, 2);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [3, 4]);
});

test('R4 two redacted items add two to items-hidden and without any it is absent', () => {
  resetNumbers();
  const make = (items) => board({
    raw: raw({ issues: [task({ number: 1 })], projects: [project(3, 'House', items)] }),
    settings: settings({ projects: HOUSE }),
  });
  const two = make([1, { type: 'REDACTED', repo: null, number: null }, { type: 'REDACTED', repo: null, number: null }]);
  assert.equal(warning(two, 'items-hidden'), 2);
  assert.equal(row(two, 'house').total, 1);
  const zero = make([1, { type: 'DraftIssue', repo: null, number: null }]);
  assert.equal(warning(zero, 'items-hidden'), 0);
  assert.equal(row(zero, 'house').total, 1);
});

// ---- R5 --------------------------------------------------------------------------------------------------------
test('R5 the broken fixture gives a valid board, nine skipped rows and the good rows counted', () => {
  const b = board({
    raw: readJson('raw/broken.json'),
    settings: settings({ projects: [{ key: 'house', number: 3 }, { key: 'side', number: 4 }], focus: ['house'] }),
  });
  const verdict = checkBoard(b);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  // 4 bad issues + 2 bad milestones + 3 bad project items = 9.
  assert.equal(warning(b, 'row-skipped'), 9);
  // good rows: House has tasks 1, 2, 3 (3 is closed): done 1, total 3, pct floor(100/3) = 33.
  const house = row(b, 'house');
  assert.equal(house.total, 3);
  assert.equal(house.done, 1);
  assert.equal(house.pct, 33);
  // Side project has tasks 4 and 5: total 2.
  assert.equal(row(b, 'side').total, 2);
  // skipped milestones are skipped, not unmatched: the two good ones match their projects.
  assert.equal(warning(b, 'milestone-unmatched'), 0);
  // issue 10 is an idea and issue 11 is standalone.
  assert.equal(b.ideas.count, 1);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [11]);
});

test('R5 rows that are not even objects are skipped, and the good row beside them counts', () => {
  resetNumbers();
  const good = task({ number: 1 });
  const b = board({
    raw: raw({ issues: [null, 'x', 42, good], projects: [project(3, 'House', [1])] }),
    settings: settings({ projects: HOUSE }),
  });
  assert.equal(warning(b, 'row-skipped'), 3);
  assert.equal(row(b, 'house').total, 1);
});

test('R5 the model never throws for input objects with missing or wrong parts', () => {
  const weird = [
    { raw: {}, settings: settings({ projects: HOUSE }) },
    { raw: raw({ issues: 'nope', milestones: 7, projects: {} }), settings: settings({ projects: HOUSE }) },
    { raw: raw({ projects: [{ number: 3, title: 'House', closed: false, url: 'https://github.com/orgs/sam-life/projects/3', items: 'x' }] }), settings: settings({ projects: HOUSE }) },
  ];
  for (const input of weird) {
    let b;
    assert.doesNotThrow(() => { b = board(input); });
    const verdict = checkBoard(b);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  }
  // presence twin: a clean input gives a House row, so a stub board cannot pass by being empty.
  const clean = board({ raw: raw({ issues: [task({ number: 1 })], projects: [project(3, 'House', [1])] }), settings: settings({ projects: HOUSE }) });
  assert.equal(row(clean, 'house').total, 1);
});
