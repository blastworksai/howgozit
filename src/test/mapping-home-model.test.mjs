// CP4 (SKILLS-76), model level: home repos and goals by card membership.
// Written from references/contract.md (R4, R7, R9, R13, R14, R17, R19, R21, R22, R47, R93, R129) and
// reference/mapping-redesign/cp4-interface.md, from hand-made raw and settings only.
// Today is 2026-10-12 (board timezone Europe/Brussels); the data repo is sam-life/life.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, project, milestone, task, raw, resetNumbers, board } from '../fixtures/build.mjs';

const DATA = 'sam-life/life';
const HOME = 'sam-life/house';

// ---------- helpers ----------

function day(n) {
  return new Date(Date.UTC(2026, 9, 12 + n)).toISOString().slice(0, 10);
}
const warn = (b, code) => (b?.meta?.warnings ?? []).find((w) => w.code === code)?.count ?? 0;
const projectRow = (b, key) => (b?.projects ?? []).find((p) => p.key === key);
const lane = (b, key) => (b?.timeline?.lanes ?? []).find((l) => l.project?.key === key);
const laneEntries = (l) => [...(l?.milestones ?? []), ...(l?.undated ?? [])];
function allEntries(b) {
  const out = [];
  for (const l of b?.timeline?.lanes ?? []) {
    for (const m of l.milestones ?? []) out.push({ where: 'milestones', key: l.project?.key, m });
    for (const m of l.undated ?? []) out.push({ where: 'undated', key: l.project?.key, m });
  }
  for (const m of b?.timeline?.other ?? []) out.push({ where: 'other', key: null, m });
  return out;
}
const byTitle = (b, shortTitle) => allEntries(b).filter((e) => e.m.shortTitle === shortTitle);
const nextRow = (b, ref) => (b?.next ?? []).find((n) => (n.ref ?? String(n.number)) === ref);
const heat = (b, date) => (b?.heatmap?.weeks ?? []).flat().find((d) => d.date === date);

// A card of a repo other than the data repo: a task row carrying `repo` and `ref`.
function card(repo, number, extra = {}) {
  return task({
    number,
    repo,
    ref: `${repo}#${number}`,
    html_url: `https://github.com/${repo}/issues/${number}`,
    ...extra,
  });
}
// A project item pointing at an issue of `repo`.
const item = (repo, number, extra = {}) => ({ type: 'Issue', repo, number, status: null, due: null, ...extra });
const homeCfg = (pairs, extra = {}) =>
  settings({ projects: pairs.map(([key, number, home]) => (home ? { key, number, home } : { key, number })), ...extra });

// ---------- R4 ----------

test('R4 a shown project with a home counts an Issue item of that home repo, with its card built from the item issue', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)])],
      issues: [card(HOME, 5, { title: 'Paint the hallway' })],
    }),
  });
  assert.equal(projectRow(b, 'house')?.total, 1);
  const row = nextRow(b, `${HOME}#5`);
  assert.ok(row, 'the home card takes a seat in What\'s next');
  assert.equal(row.title, 'Paint the hallway');
  assert.equal(row.ref, `${HOME}#5`);
});

test('R4 the same item in a project with no home is not a data-repo item and does not count', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)])],
      issues: [card(HOME, 5)],
    }),
  });
  assert.equal(projectRow(b, 'house')?.total, 0);
  assert.equal((b.next ?? []).length, 0);
});

test('R4 two cards are the same only when their refs are equal: a/x#5 and a/y#5 are two cards', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, 'a/x']]),
    raw: raw({
      projects: [project(3, 'House', [item('a/x', 5), item('a/y', 5)])],
      issues: [card('a/x', 5, { title: 'X five' }), card('a/y', 5, { title: 'Y five' })],
    }),
  });
  assert.equal(projectRow(b, 'house')?.total, 2);
  assert.deepEqual(
    (b.next ?? []).map((n) => n.ref).sort(),
    ['a/x#5', 'a/y#5'],
  );
});

test('R4 an item of another type, or a DraftIssue, in a home project is still ignored', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5), item(HOME, 6, { type: 'PullRequest' }), { type: 'DraftIssue', repo: null, number: null, status: null, due: null }])],
      issues: [card(HOME, 5)],
    }),
  });
  assert.equal(projectRow(b, 'house')?.total, 1);
});

// ---------- R129 ----------

test('R129 two home repos each holding an open task #5 on two shown projects give two seats with different refs', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, 'sam-life/house'], ['garden', 4, 'sam-life/garden']]),
    raw: raw({
      projects: [project(3, 'House', [item('sam-life/house', 5)]), project(4, 'Garden', [item('sam-life/garden', 5)])],
      issues: [card('sam-life/house', 5, { title: 'House five' }), card('sam-life/garden', 5, { title: 'Garden five' })],
    }),
  });
  assert.equal(b.next.length, 2);
  assert.deepEqual(b.next.map((n) => n.ref).sort(), ['sam-life/garden#5', 'sam-life/house#5']);
  assert.notEqual(b.next[0].ref, b.next[1].ref);
});

test('R129 a data-repo task keeps the bare number as its short ref and carries no ref key', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME], ['garden', 4]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)]), project(4, 'Garden', [5])],
      issues: [card(HOME, 5, { title: 'Home five' }), task({ number: 5, title: 'Data five' })],
    }),
  });
  assert.equal(b.next.length, 2);
  const data = b.next.find((n) => n.title === 'Data five');
  const home = b.next.find((n) => n.title === 'Home five');
  assert.ok(data && home);
  assert.equal(data.number, 5);
  assert.equal('ref' in data, false, 'a data-repo seat carries no ref');
  assert.equal(home.ref, `${HOME}#5`);
});

// ---------- R7 ----------

test('R7 the Ideas and Habits Projects, when settings name them, are never shown projects', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3]], { ideas: { owner: 'sam-life', number: 8 }, habitsProject: { owner: 'sam-life', number: 9 } }),
    raw: raw({
      projects: [
        project(3, 'House', []),
        project(8, 'Ideas box', [], { role: 'ideas', owner: 'sam-life' }),
        project(9, 'Habits log', [], { role: 'habits', owner: 'sam-life' }),
      ],
    }),
  });
  assert.deepEqual(b.projects.map((p) => p.key), ['house']);
  const text = JSON.stringify({ p: b.projects, t: b.timeline, s: b.sortTargets });
  assert.ok(!text.includes('Ideas box'), 'no Ideas Project anywhere');
  assert.ok(!text.includes('Habits log'), 'no Habits Project anywhere');
  assert.deepEqual((b.sortTargets ?? []).map((s) => s.key), ['house']);
});

test('R7 a task that is only an item of a role Project gives the task no project and it is standalone', () => {
  resetNumbers();
  const b = board({
    // CP6 (lead): the Habits role Project, since an item of the Ideas Project is an idea by R2/R135
    settings: homeCfg([['house', 3]], { habitsProject: { owner: 'sam-life', number: 9 } }),
    raw: raw({
      projects: [project(3, 'House', []), project(9, 'Habits log', [7], { role: 'habits', owner: 'sam-life' })],
      issues: [task({ number: 7 })],
    }),
  });
  assert.equal(projectRow(b, 'house')?.total, 0);
  assert.equal(b.standalone.count, 1);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [7]);
});

test('R7 a raw project row with a role is never matched to a listed entry, even with the same number', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3]]),
    raw: raw({
      projects: [
        project(3, 'Imposter', [], { role: 'ideas', owner: 'sam-life' }),
        project(3, 'House', []),
      ],
    }),
  });
  assert.equal(b.projects.length, 1);
  assert.equal(b.projects[0].title, 'House');
});

// ---------- R9 ----------

test('R9 the same Project number listed under two owners gives two projects, each with its own title', () => {
  resetNumbers();
  const b = board({
    settings: settings({ projects: [{ key: 'alpha', number: 3, owner: 'a' }, { key: 'beta', number: 3, owner: 'b' }] }),
    raw: raw({
      projects: [
        project(3, 'Alpha board', [], { owner: 'a', url: 'https://github.com/orgs/a/projects/3' }),
        project(3, 'Beta board', [], { owner: 'b', url: 'https://github.com/orgs/b/projects/3' }),
      ],
    }),
  });
  assert.equal(b.projects.length, 2);
  assert.equal(projectRow(b, 'alpha')?.title, 'Alpha board');
  assert.equal(projectRow(b, 'beta')?.title, 'Beta board');
  assert.notEqual(projectRow(b, 'alpha')?.url, projectRow(b, 'beta')?.url);
});

test('R9 each of two same-number projects counts only its own items', () => {
  resetNumbers();
  const b = board({
    settings: settings({ projects: [{ key: 'alpha', number: 3, owner: 'a', home: 'a/x' }, { key: 'beta', number: 3, owner: 'b', home: 'b/y' }] }),
    raw: raw({
      projects: [
        project(3, 'Alpha board', [item('a/x', 1), item('a/x', 2)], { owner: 'a' }),
        project(3, 'Beta board', [item('b/y', 1)], { owner: 'b' }),
      ],
      issues: [card('a/x', 1), card('a/x', 2), card('b/y', 1)],
    }),
  });
  assert.equal(projectRow(b, 'alpha')?.total, 2);
  assert.equal(projectRow(b, 'beta')?.total, 1);
});

// ---------- R13 ----------

test('R13 a home-repo card that is an item of a shown project is in its total and not standalone', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)])],
      issues: [card(HOME, 5), task({ number: 20 })],
    }),
  });
  assert.equal(projectRow(b, 'house')?.total, 1);
  assert.equal(b.standalone.count, 1);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [20]);
});

test('R13 a card of another repo that is no project item is never standalone', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      issues: [card(HOME, 5), task({ number: 20 })],
    }),
  });
  assert.equal(b.standalone.count, 1);
  assert.deepEqual(b.standalone.items.map((i) => i.number), [20]);
  assert.equal((b.next ?? []).length, 0, 'and it takes no seat');
});

// ---------- R14 ----------

test('R14 a home-repo milestone holding a project task is in its lane with its whole title and no unmatched warning', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)])],
      issues: [card(HOME, 5, { milestone: 1 })],
      milestones: [milestone(1, 'Hallway · Paint', day(10), { repo: HOME })],
    }),
  });
  const entries = laneEntries(lane(b, 'house'));
  assert.deepEqual(entries.map((m) => m.shortTitle), ['Hallway · Paint']);
  assert.equal(warn(b, 'milestone-unmatched'), 0);
});

test('R14 a home-repo milestone needs no separator in its title to belong to the project', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)])],
      issues: [card(HOME, 5, { milestone: 2 })],
      milestones: [milestone(2, 'Paint', day(10), { repo: HOME })],
    }),
  });
  assert.deepEqual(laneEntries(lane(b, 'house')).map((m) => m.shortTitle), ['Paint']);
  assert.equal(b.timeline.other.length, 0);
});

test('R14 a home-repo milestone with no task goes to other without milestone-unmatched', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [milestone(4, 'Empty goal', day(10), { repo: HOME })],
    }),
  });
  assert.deepEqual(b.timeline.other.map((m) => m.shortTitle), ['Empty goal']);
  assert.equal(laneEntries(lane(b, 'house')).length, 0);
  assert.equal(warn(b, 'milestone-unmatched'), 0);
});

test('R14 a data-repo milestone keeps title matching on a board that also has a home project', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [])],
      milestones: [milestone(6, 'House · Hallway', day(10)), milestone(7, 'Hallway', day(11))],
    }),
  });
  assert.deepEqual(laneEntries(lane(b, 'house')).map((m) => m.shortTitle), ['Hallway']);
  assert.deepEqual(b.timeline.other.map((m) => m.shortTitle), ['Hallway']);
  assert.equal(warn(b, 'milestone-unmatched'), 1);
});

// ---------- R17 ----------

test('R17 an open milestone 5 of a/x with two closed tasks and an open task of a/y with milestone 5 is done', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, 'a/x']]),
    raw: raw({
      projects: [project(3, 'House', [item('a/x', 1), item('a/x', 2), item('a/y', 1)])],
      issues: [
        card('a/x', 1, { milestone: 5, state: 'closed' }),
        card('a/x', 2, { milestone: 5, state: 'closed' }),
        card('a/y', 1, { milestone: 5 }),
      ],
      milestones: [milestone(5, 'Goal X', day(10), { repo: 'a/x' })],
    }),
  });
  const [e] = byTitle(b, 'Goal X');
  assert.ok(e, 'goal on the timeline');
  assert.equal(e.m.state, 'done');
  assert.equal(e.m.total, 2, 'only the two a/x tasks are its tasks');
});

test('R17 the twin: when the a/x task is the open one the milestone is not done', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, 'a/x']]),
    raw: raw({
      projects: [project(3, 'House', [item('a/x', 1), item('a/y', 1)])],
      issues: [card('a/x', 1, { milestone: 5 }), card('a/y', 1, { milestone: 5, state: 'closed' })],
      milestones: [milestone(5, 'Goal X', day(10), { repo: 'a/x' })],
    }),
  });
  assert.equal(byTitle(b, 'Goal X')[0]?.m.state, 'open');
});

// ---------- R19 ----------

test('R19 the finish day is taken from the tasks of the milestone pair alone: yesterday keeps it on the timeline', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, 'a/x']]),
    raw: raw({
      projects: [project(3, 'House', [item('a/x', 1), item('a/y', 1)])],
      issues: [
        card('a/x', 1, { milestone: 5, state: 'closed', closed_at: `${day(-1)}T10:00:00Z` }),
        card('a/y', 1, { milestone: 5, state: 'closed', closed_at: `${day(-40)}T10:00:00Z` }),
      ],
      milestones: [milestone(5, 'Goal X', null, { repo: 'a/x' })],
    }),
  });
  const l = lane(b, 'house');
  assert.deepEqual((l?.undated ?? []).map((m) => m.shortTitle), ['Goal X']);
});

test('R19 the twin: a close of the other repo yesterday does not rescue a milestone whose own task closed 45 days ago', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, 'a/x']]),
    raw: raw({
      projects: [project(3, 'House', [item('a/x', 1), item('a/y', 1)])],
      issues: [
        card('a/x', 1, { milestone: 5, state: 'closed', closed_at: `${day(-45)}T10:00:00Z` }),
        card('a/y', 1, { milestone: 5, state: 'closed', closed_at: `${day(-1)}T10:00:00Z` }),
      ],
      milestones: [milestone(5, 'Goal X', null, { repo: 'a/x' })],
    }),
  });
  assert.equal(byTitle(b, 'Goal X').length, 0, 'finished 45 days ago, so off the timeline');
});

// ---------- R21 ----------

test('R21 two milestones numbered 5 in a/x and a/y give each project row a next milestone from its own tasks only', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, 'a/x'], ['garden', 4, 'a/y']]),
    raw: raw({
      projects: [project(3, 'House', [item('a/x', 1)]), project(4, 'Garden', [item('a/y', 1)])],
      issues: [card('a/x', 1, { milestone: 5 }), card('a/y', 1, { milestone: 5, state: 'closed' })],
      milestones: [
        milestone(5, 'Ex goal', day(-2), { repo: 'a/x' }),
        milestone(5, 'Why goal', day(9), { repo: 'a/y' }),
      ],
    }),
  });
  assert.deepEqual(projectRow(b, 'house')?.nextMilestone, { shortTitle: 'Ex goal', due: day(-2) });
  assert.equal(projectRow(b, 'house')?.overdueMilestones, 1);
  assert.equal(projectRow(b, 'garden')?.nextMilestone, null, 'a/y goal 5 is done: its only task is closed');
  assert.equal(projectRow(b, 'garden')?.overdueMilestones, 0);
});

// ---------- R22 ----------

test('R22 a home-repo milestone holding tasks of projects a and b is in both lanes with no crossing warning', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['alpha', 3, HOME], ['beta', 4, HOME]]),
    raw: raw({
      projects: [project(3, 'Alpha', [item(HOME, 1)]), project(4, 'Beta', [item(HOME, 2)])],
      issues: [card(HOME, 1, { milestone: 7 }), card(HOME, 2, { milestone: 7 })],
      milestones: [milestone(7, 'Shared goal', day(10), { repo: HOME })],
    }),
  });
  assert.deepEqual(laneEntries(lane(b, 'alpha')).map((m) => m.shortTitle), ['Shared goal']);
  assert.deepEqual(laneEntries(lane(b, 'beta')).map((m) => m.shortTitle), ['Shared goal']);
  assert.equal(b.timeline.other.length, 0);
  assert.equal(warn(b, 'milestone-crosses-project'), 0);
});

test('R22 the title path still flags a crossing on a board that also has a home project', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME], ['garden', 4], ['hall', 5]]),
    raw: raw({
      projects: [project(3, 'House', []), project(4, 'Garden', []), project(5, 'Hall', [1])],
      issues: [task({ number: 1, milestone: 7 })],
      milestones: [milestone(7, 'Garden · Beds', day(10))],
    }),
  });
  assert.equal(warn(b, 'milestone-crosses-project'), 1);
});

// ---------- R47 ----------

const NOW14 = '2026-10-14T10:00:00Z';

test('R47 closes on cards a/x#5 and a/y#5 on one day count as two', () => {
  resetNumbers();
  const closed = { state: 'closed', closed_at: '2026-10-13T10:00:00Z' };
  const b = board({
    settings: homeCfg([['house', 3, 'a/x']]),
    raw: raw({
      projects: [project(3, 'House', [item('a/x', 5), item('a/y', 5)])],
      issues: [card('a/x', 5, closed), card('a/y', 5, closed)],
    }),
    now: NOW14,
  });
  assert.equal(heat(b, '2026-10-13')?.count, 2);
});

test('R47 one card read twice is counted once and adds no row-skipped warning', () => {
  resetNumbers();
  const closed = { state: 'closed', closed_at: '2026-10-13T10:00:00Z' };
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)])],
      issues: [card(HOME, 5, closed), card(HOME, 5, closed)],
    }),
    now: NOW14,
  });
  assert.equal(heat(b, '2026-10-13')?.count, 1);
  assert.equal(warn(b, 'row-skipped'), 0);
});

test('R47 a data-repo close and a home-card close on the same day are both counted', () => {
  resetNumbers();
  const closed = { state: 'closed', closed_at: '2026-10-13T10:00:00Z' };
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)])],
      issues: [card(HOME, 5, closed), task({ number: 9, ...closed })],
    }),
    now: NOW14,
  });
  assert.equal(heat(b, '2026-10-13')?.count, 2);
});

// ---------- R93 ----------

test('R93 a home-repo task takes the date of the home-repo milestone, not the data-repo milestone with the same number', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME]]),
    raw: raw({
      projects: [project(3, 'House', [item(HOME, 5)])],
      issues: [card(HOME, 5, { milestone: 5 })],
      milestones: [
        milestone(5, 'House · Elsewhere', day(3)),
        milestone(5, 'Home goal', day(7), { repo: HOME }),
      ],
    }),
  });
  assert.equal(nextRow(b, `${HOME}#5`)?.due, day(7));
});

test('R93 the twin: the data-repo task with that milestone number takes the data-repo milestone date', () => {
  resetNumbers();
  const b = board({
    settings: homeCfg([['house', 3, HOME], ['data', 4]]),
    raw: raw({
      projects: [project(3, 'House', []), project(4, 'Data', [5])],
      issues: [task({ number: 5, milestone: 5 })],
      milestones: [
        milestone(5, 'Data · Elsewhere', day(3)),
        milestone(5, 'Home goal', day(7), { repo: HOME }),
      ],
    }),
  });
  assert.equal(nextRow(b, '5')?.due, day(3));
});
