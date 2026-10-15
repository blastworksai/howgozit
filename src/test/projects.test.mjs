// Contract rules R6 to R13: projects, progress, doing and standalone tasks. Tests go through buildBoard only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  board, settings, project, milestone, task, idea, checkin, raw, resetNumbers,
} from '../fixtures/build.mjs';

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

const keys = (list) => list.map((p) => p.key);
const HOUSE = [{ key: 'house', number: 3 }];

// ---- R6 --------------------------------------------------------------------------------------------------------
test('R6 listed numbers GitHub did not return or returned closed are left out with a warning each', () => {
  resetNumbers();
  const closed = project(4, 'Side project', [], { closed: true });
  const b = board({
    raw: raw({ projects: [project(3, 'House', []), closed] }),
    settings: settings({ projects: [{ key: 'house', number: 3 }, { key: 'side', number: 4 }, { key: 'gone', number: 99 }] }),
  });
  assert.deepEqual(keys(b.projects), ['house']);
  assert.equal(warning(b, 'project-missing'), 1);
  assert.equal(warning(b, 'project-closed'), 1);
});

test('R6 when every listed project is open and returned there is no project warning', () => {
  resetNumbers();
  const b = board({
    raw: raw({ projects: [project(3, 'House', []), project(4, 'Side project', [])] }),
    settings: settings({ projects: [{ key: 'house', number: 3 }, { key: 'side', number: 4 }] }),
  });
  assert.deepEqual(keys(b.projects), ['house', 'side']);
  assert.equal(warning(b, 'project-missing'), 0);
  assert.equal(warning(b, 'project-closed'), 0);
});

// ---- R7 --------------------------------------------------------------------------------------------------------
test('R7 a project that settings do not list does not exist for the board', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [task({ number: 1 }), task({ number: 2 })],
      milestones: [milestone(1, 'House · Walls', '2026-10-20'), milestone(2, 'Garden · Beds', '2026-10-25')],
      projects: [project(3, 'House', [2]), project(7, 'Garden', [1])],
    }),
    settings: settings({ projects: HOUSE }),
  });
  // task 2 is in listed House; task 1 is only an item of unlisted project 7.
  assert.deepEqual(keys(b.projects), ['house']);
  assert.equal(b.projects.some((p) => p.number === 7), false);
  assert.deepEqual(b.timeline.lanes.map((l) => l.project.key), ['house']);
  assert.deepEqual(keys(b.sortTargets), ['house']);
  assert.equal(b.standalone.count, 1);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [1]);
  // the same task as an item of the listed project is not standalone (presence twin).
  assert.equal(row(b, 'house').total, 1);
});

// ---- R8 --------------------------------------------------------------------------------------------------------
test('R8 focus projects come first, each group in the order of settings, in rows, lanes and sort targets', () => {
  resetNumbers();
  const letters = [['a', 'Alpha'], ['b', 'Bravo'], ['c', 'Charlie'], ['d', 'Delta']];
  const b = board({
    raw: raw({
      milestones: letters.map(([, title], i) => milestone(i + 1, `${title} · Step`, '2026-10-20')),
      projects: letters.map(([, title], i) => project(i + 1, title, [])),
    }),
    // focus is listed d then c on purpose: the order inside a group is the order of projects, not of focus.
    settings: settings({ projects: letters.map(([key], i) => ({ key, number: i + 1 })), focus: ['d', 'c'] }),
  });
  const want = ['c', 'd', 'a', 'b'];
  assert.deepEqual(keys(b.projects), want);
  assert.deepEqual(b.timeline.lanes.map((l) => l.project.key), want);
  assert.deepEqual(keys(b.sortTargets), want);
});

// ---- R9 --------------------------------------------------------------------------------------------------------
const THREE = [{ key: 'house', number: 3 }, { key: 'side', number: 4 }, { key: 'health', number: 5 }];
const threeRaw = () => raw({
  projects: [project(3, 'House renovation', []), project(4, 'Side project', []), project(5, 'Health', [])],
});

test('R9 title and link come from GitHub, the key from settings, and the colour falls back by position', () => {
  const b = board({ raw: threeRaw(), settings: settings({ projects: THREE, focus: ['side'] }) });
  // focus moves side to first place; its colour is still the second theme colour (position 1 in settings).
  assert.deepEqual(keys(b.projects), ['side', 'house', 'health']);
  assert.equal(row(b, 'side').color, '#FFC94D');
  assert.equal(row(b, 'house').color, '#7FE7D3');
  assert.equal(row(b, 'health').color, '#C9B6FF');
  assert.equal(row(b, 'house').title, 'House renovation');
  assert.equal(row(b, 'house').url, 'https://github.com/orgs/sam-life/projects/3');
  assert.equal(b.focus.projects[0].color, '#FFC94D');
});

test('R9 a colour in settings that is a valid hex colour is used', () => {
  const list = [{ key: 'house', number: 3, color: '#123456' }, { key: 'side', number: 4 }, { key: 'health', number: 5 }];
  const b = board({ raw: threeRaw(), settings: settings({ projects: list }) });
  assert.equal(row(b, 'house').color, '#123456');
  assert.equal(row(b, 'side').color, '#FFC94D');
  assert.equal(warning(b, 'color-invalid'), 0);
});

test('R9 a colour that is not hex falls back to the theme colour by position and is flagged once', () => {
  const list = [{ key: 'house', number: 3 }, { key: 'side', number: 4, color: 'red' }, { key: 'health', number: 5 }];
  const b = board({ raw: threeRaw(), settings: settings({ projects: list, focus: ['side'] }) });
  assert.equal(row(b, 'side').color, '#FFC94D');
  assert.equal(warning(b, 'color-invalid'), 1);
});

test('R9 the fallback wraps around the theme list: position 2 of 2 colours is the first colour', () => {
  const b = board({
    raw: threeRaw(),
    settings: settings({ projects: THREE }),
    theme: { projectColors: ['#111111', '#222222'] },
  });
  // positions 0, 1, 2 give indexes 0, 1, 2 mod 2 = 0, 1, 0.
  assert.equal(row(b, 'house').color, '#111111');
  assert.equal(row(b, 'side').color, '#222222');
  assert.equal(row(b, 'health').color, '#111111');
});

// ---- R10 -------------------------------------------------------------------------------------------------------
test('R10 a task of two shown projects counts in both and takes its seat under the first in order', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [task({ number: 1 }), task({ number: 2 }), task({ number: 3 })],
      projects: [project(3, 'Alpha', [1, 2]), project(4, 'Gamma', [1, 3])],
    }),
    // a is listed first and not in focus; c is in focus so it comes first in the order of R8.
    settings: settings({ projects: [{ key: 'a', number: 3 }, { key: 'c', number: 4 }], focus: ['c'] }),
  });
  assert.equal(row(b, 'a').total, 2);
  assert.equal(row(b, 'c').total, 2);
  assert.equal(b.next.filter((n) => n.number === 1).length, 1);
  assert.equal(b.next.find((n) => n.number === 1)?.project.key, 'c');
  // focus c deals 1 then 3 (tie goes to the lower number); then leftover seats go to a, whose only unseated task is 2.
  assert.deepEqual(b.next.map((n) => n.number), [1, 3, 2]);
});

test('R10 a closed task of two projects is done in both', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [task({ number: 1, state: 'closed' }), task({ number: 2 })],
      projects: [project(3, 'Alpha', [1, 2]), project(4, 'Gamma', [1])],
    }),
    settings: settings({ projects: [{ key: 'a', number: 3 }, { key: 'c', number: 4 }] }),
  });
  assert.equal(row(b, 'a').done, 1);
  assert.equal(row(b, 'a').total, 2);
  assert.equal(row(b, 'c').done, 1);
  assert.equal(row(b, 'c').total, 1);
});

// ---- R11 -------------------------------------------------------------------------------------------------------
test('R11 progress is closed tasks over all tasks, whatever the close reason', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [
        task({ number: 1, state: 'closed', state_reason: 'completed' }),
        task({ number: 2, state: 'closed', state_reason: 'not_planned' }),
        task({ number: 3 }),
        idea({ number: 4 }),
        { ...checkin('move', '2026-10-11'), number: 5 },
        task({ number: 6, labels: ['weekly-review'] }),
      ],
      projects: [project(3, 'House', [1, 2, 3, 4, 5, 6])],
    }),
    settings: settings({ projects: HOUSE, habits: [{ id: 'move', title: 'Move', start: '2026-10-10' }] }),
  });
  // issue 5 is the check-in; done 2 of 3, floor(200 / 3) = 66.
  const h = row(b, 'house');
  assert.equal(h.done, 2);
  assert.equal(h.total, 3);
  assert.equal(h.pct, 66);
  assert.equal(h.empty, false);
});

test('R11 a project with no tasks is empty with pct 0, and a lone open task is not empty', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [task({ number: 1 }), idea({ number: 2 })],
      projects: [project(3, 'House', [2]), project(4, 'Side project', [1])],
    }),
    settings: settings({ projects: [{ key: 'house', number: 3 }, { key: 'side', number: 4 }] }),
  });
  // House holds only an idea, which never counts.
  const h = row(b, 'house');
  assert.equal(h.total, 0);
  assert.equal(h.done, 0);
  assert.equal(h.pct, 0);
  assert.equal(h.empty, true);
  const s = row(b, 'side');
  assert.equal(s.total, 1);
  assert.equal(s.pct, 0);
  assert.equal(s.empty, false);
});

test('R11 the percentage is rounded down and ignores the milestone counters', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [task({ number: 1, state: 'closed' }), task({ number: 2 }), task({ number: 3 }), task({ number: 4 })],
      milestones: [milestone(1, 'House · Walls', '2026-10-20', { open_issues: 9, closed_issues: 0 })],
      projects: [project(3, 'House', [1, 2, 3, 4])],
    }),
    settings: settings({ projects: HOUSE }),
  });
  // 1 of 4 is 25; 2 of 3 elsewhere gave 66; here floor(100 / 4) = 25.
  assert.equal(row(b, 'house').pct, 25);
  assert.equal(row(b, 'house').total, 4);
});

// ---- R12 -------------------------------------------------------------------------------------------------------
test('R12 doing counts open tasks with status In Progress or Doing, case-insensitively', () => {
  resetNumbers();
  const item = (number, status) => ({ number, status });
  const b = board({
    raw: raw({
      issues: [
        task({ number: 1 }), task({ number: 2 }), task({ number: 3 }), task({ number: 4 }),
        task({ number: 5, state: 'closed' }),
      ],
      projects: [project(3, 'House', [item(1, 'in progress'), item(2, 'Doing'), item(3, 'Todo'), item(4, null), item(5, 'Doing')])],
    }),
    settings: settings({ projects: HOUSE }),
  });
  // statuses in progress and Doing on open tasks give 2; the closed task with status Doing is not counted.
  assert.equal(row(b, 'house').total, 5);
  assert.equal(row(b, 'house').doing, 2);
});

// ---- R13 -------------------------------------------------------------------------------------------------------
test('R13 standalone holds the count of open standalone tasks and the first 20 by number', () => {
  resetNumbers();
  const open = [];
  for (let n = 122; n >= 100; n--) open.push(task({ number: n })); // 23 open, created highest first
  const b = board({
    raw: raw({
      issues: [...open, task({ number: 1, state: 'closed' }), task({ number: 2, state: 'closed' }), task({ number: 50 })],
      projects: [project(3, 'House', [50])],
    }),
    settings: settings({ projects: HOUSE }),
  });
  assert.equal(b.standalone.count, 23);
  assert.equal(b.standalone.items.length, 20);
  // lowest number first: 100 to 119; the closed 1 and 2 are not there.
  assert.deepEqual(b.standalone.items.map((i) => i.number), Array.from({ length: 20 }, (_, i) => 100 + i));
  assert.deepEqual(Object.keys(b.standalone.items[0]).sort(), ['due', 'number', 'title', 'url']);
  assert.equal(b.standalone.items[0].url, 'https://github.com/sam-life/life/issues/100');
  assert.equal(b.standalone.items[0].due, null);
});

test('R13 standalone tasks are in no project progress and never take a seat in next', () => {
  resetNumbers();
  const b = board({
    raw: raw({
      issues: [task({ number: 1 }), task({ number: 2 }), task({ number: 50 })],
      projects: [project(3, 'House', [50])],
    }),
    settings: settings({ projects: HOUSE }),
  });
  // task 50 is the only candidate: House has total 1, next holds only it, standalone holds 1 and 2.
  assert.equal(row(b, 'house').total, 1);
  assert.deepEqual(b.next.map((n) => n.number), [50]);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [1, 2]);
  assert.equal(b.standalone.count, 2);
});
