// CP3: compareBoards (interface.md section 6.4) on small hand-made boards. Pure, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBoards } from '../scripts/compare-boards.mjs';

const board = (over = {}) => ({
  projects: [{ key: 'garden', title: 'Road to a garden', total: 4, done: 1 }, { key: 'press', title: 'Press', total: 2, done: 0 }],
  next: [{ title: 'Plan the beds' }, { title: 'Buy the seeds' }],
  timeline: { lanes: [{ milestones: [{ shortTitle: 'First beds', pct: 50 }], undated: [{ shortTitle: 'Someday', pct: 0 }] }], other: [] },
  ideas: { items: [{ title: 'Learn to graft' }] },
  habits: [{ id: 'mood', doneToday: true, streak: 3 }],
  ...over,
});

test('U compareBoards reports two equal boards as the same and nothing as different', () => {
  const r = compareBoards(board(), board());
  assert.deepEqual(r.differ, []);
  assert.deepEqual(r.same, ['projects:garden', 'projects:press', 'next', 'goals', 'ideas', 'habits:mood']);
});

test('U compareBoards names each difference with both values', () => {
  const b = board({
    projects: [{ key: 'garden', title: 'Road to a garden', total: 4, done: 2 }, { key: 'press', title: 'Press', total: 2, done: 0 }],
    next: [{ title: 'Buy the seeds' }, { title: 'Plan the beds' }],
    habits: [{ id: 'mood', doneToday: false, streak: 0 }],
  });
  const r = compareBoards(board(), b);
  assert.deepEqual(r.differ, [
    { item: 'projects:garden', github: 'Road to a garden / 3 open', notion: 'Road to a garden / 2 open' },
    { item: 'next', github: ['Plan the beds', 'Buy the seeds'], notion: ['Buy the seeds', 'Plan the beds'], onlyGithub: [], onlyNotion: [] }, // C7: structured lists, order is the difference
    { item: 'habits:mood', github: 'today done / streak 3', notion: 'today not done / streak 0' },
  ]);
  assert.deepEqual(r.same, ['projects:press', 'goals', 'ideas']);
});

test('U compareBoards counts a project or habit on one side only as a difference with null on the other', () => {
  const r = compareBoards(board(), board({ projects: [{ key: 'garden', title: 'Road to a garden', total: 4, done: 1 }], habits: [] }));
  assert.deepEqual(r.differ.map((d) => [d.item, d.notion]), [['projects:press', null], ['habits:mood', null]]);
});

test('U compareBoards lists the differences the two back-ends are known to have, apart from the real ones', () => {
  const r = compareBoards(board(), board({ ideas: { items: [] } }));
  assert.deepEqual(r.expected.map((e) => e.field), ['urls', 'tag', 'refs', 'timeline-map', 'goal-placement']);
  assert.ok(r.expected.every((e) => typeof e.note === 'string' && e.note !== ''));
  assert.deepEqual(r.differ.map((d) => d.item), ['ideas']);
});

test('U compareBoards does not change either board and copes with an empty one', () => {
  const a = board();
  const before = JSON.stringify(a);
  const r = compareBoards(a, {});
  assert.equal(JSON.stringify(a), before);
  assert.ok(r.differ.length > 0);
  assert.deepEqual(compareBoards({}, {}).differ, []);
});
