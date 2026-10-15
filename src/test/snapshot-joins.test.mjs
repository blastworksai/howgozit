// CP2 T2a: the model joins cards, items and goals by ref (seam.md section 2). Today's data (all in the data repo) is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, settings, project, milestone, task, raw, state, resetNumbers } from '../fixtures/build.mjs';
import { prepare } from '../board/prepare.mjs';
import { refKey } from '../board/model/snapshot.mjs';

const prep = (r, s) => prepare({ raw: r, settings: s, theme: undefined, state: state(), now: NOW });
const one = () => settings({ projects: [{ key: 'p', number: 1 }] });

test('U refKey lower-cases a ref and gives empty for a non-string', () => {
  assert.equal(refKey('A/X#5'), 'a/x#5');
  assert.equal(refKey(5), '');
});

test('R10 membership is by ref: a/x#5 and a/y#5 are two cards', () => {
  resetNumbers();
  const r = raw({
    repo: 'a/x',
    issues: [task({ number: 5 })],
    projects: [project(1, 'P', [
      { repo: 'a/y', number: 5 }, // another repo's card 5: not counted (R4 holds until CP4)
      { repo: 'a/x', number: 5 },
    ])],
  });
  const ctx = prep(r, one());
  assert.deepEqual(ctx.projectsOf('a/x#5'), ['p']);
  assert.deepEqual(ctx.projectsOf('a/y#5'), []);
  assert.equal(ctx.tasksOf('p').length, 1);
  assert.equal(ctx.progress('p').total, 1);
});

test('R10 an item of a/y#5 alone is not counted for the data repo card 5', () => {
  const r = raw({ repo: 'a/x', issues: [task({ number: 5 })], projects: [project(1, 'P', [{ repo: 'a/y', number: 5 }])] });
  const ctx = prep(r, one());
  assert.deepEqual(ctx.projectsOf(5), []);
  assert.equal(ctx.progress('p').total, 0);
});

test('R15 a task counts for a milestone only when (repo, milestone) matches', () => {
  const r = raw({
    repo: 'a/x',
    issues: [
      task({ number: 1, milestone: 3 }), // data repo goal 3
      task({ number: 2, milestone: 3, repo: 'a/y' }), // a/y goal 3
      task({ number: 4, milestone: 3, repo: 'a/z', state: 'closed' }), // a/z has no goal 3 row
    ],
    milestones: [milestone(3, 'G x'), milestone(3, 'G y', null, { repo: 'a/y' })],
  });
  const ctx = prep(r, settings());
  assert.equal(ctx.milestones.length, 2);
  const [gx, gy] = ctx.milestones;
  assert.equal(gx.total, 1);
  assert.equal(gy.total, 1);
  assert.equal(ctx.milestoneOf('a/x#1'), gx);
  assert.equal(ctx.milestoneOf('a/y#2'), gy);
  assert.equal(ctx.milestoneOf('a/z#4'), null);
  assert.equal('repo' in gx, false);
});

test('U the shim: a bare number and the data repo ref answer the same', () => {
  const r = raw({
    repo: 'a/x',
    issues: [task({ number: 7, milestone: 2 })],
    milestones: [milestone(2, 'P · G', '2026-11-01')],
    projects: [project(1, 'P', [{ repo: 'a/x', number: 7, due: '2026-10-20' }])],
  });
  const ctx = prep(r, one());
  assert.deepEqual(ctx.projectsOf(7), ctx.projectsOf('a/x#7'));
  assert.deepEqual(ctx.itemOf('p', 7), ctx.itemOf('p', 'a/x#7'));
  assert.equal(ctx.itemOf('p', 7).due, '2026-10-20');
  assert.equal(ctx.milestoneOf(7), ctx.milestoneOf('a/x#7'));
  assert.equal(ctx.milestoneOf(7).number, 2);
  assert.equal(ctx.dueOf(7), ctx.dueOf('a/x#7'));
  assert.equal(ctx.dueOf(7), '2026-10-20');
  assert.equal(ctx.issueByNumber(7), ctx.issueByRef.get('a/x#7'));
  assert.equal(ctx.issueByNumber(8), null);
});

test('U refs join case-insensitively and the helpers report the data repo spelling', () => {
  const r = raw({ repo: 'Sam/Life', issues: [task({ number: 3 })], projects: [project(1, 'P', [{ repo: 'sam/life', number: 3 }])] });
  const ctx = prep(r, one());
  assert.deepEqual(ctx.projectsOf('SAM/LIFE#3'), ['p']);
  assert.deepEqual(ctx.projectsOf(3), ['p']);
  const issue = ctx.issueByNumber(3);
  assert.equal(ctx.refOf(issue), 'Sam/Life#3');
  assert.equal(ctx.shortRef(issue), '3');
  assert.equal('ref' in issue, false);
});
