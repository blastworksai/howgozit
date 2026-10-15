// Rules R32 to R35: the idea backlog, ideas never being active, and the agent's suggestions.
// Every expected value is worked out by hand from references/contract.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, settings, project, milestone, task, idea, raw, state, board, resetNumbers } from '../fixtures/build.mjs';

const pad = (n) => String(n).padStart(2, '0');
const items = (b) => b.ideas?.items ?? [];
const byNumber = (b, n) => items(b).find((i) => i.number === n);
const numbers = (b) => items(b).map((i) => i.number);

// Settings with the two projects used by the suggestion tests.
const twoProjects = () =>
  settings({ projects: [{ key: 'house', number: 3 }, { key: 'garden', number: 4 }] });
// Raw data for the suggestion tests: House (3) and Garden (4), milestones 5 (House, open),
// 7 (Garden, open), 8 (House, closed on GitHub).
const suggestionRaw = (issues) =>
  raw({
    issues,
    projects: [project(3, 'House'), project(4, 'Garden')],
    milestones: [
      milestone(5, 'House · Hallway', '2026-10-20'),
      milestone(7, 'Garden · Beds', '2026-11-02'),
      milestone(8, 'House · Old', '2026-09-01', { state: 'closed', closed_at: '2026-09-02T10:00:00Z' }),
    ],
  });
const FRESH = '2026-10-12T04:10:00Z'; // 2 hours before NOW
const STALE = '2026-10-11T00:10:00Z'; // 30 hours before NOW
const proposals = (updated, ideas) => state({ proposals: { updated, focus: null, ideas } });
const sug = (number, over = {}) => ({ number, project: 'house', milestone: 5, newProject: null, why: 'Same room', ...over });

test('R32 the backlog counts all open ideas, shows 20, newest first, and leaves closed ones out', () => {
  resetNumbers();
  const issues = [];
  // 23 open ideas numbered 100..122; the higher the number the later the creation minute.
  for (let i = 0; i < 23; i++) {
    issues.push(idea({ number: 100 + i, created_at: `2026-09-01T10:${pad(i)}:00Z` }));
  }
  // 2 closed ideas created later than all open ones: they must not appear.
  issues.push(idea({ number: 200, state: 'closed', created_at: '2026-09-02T10:00:00Z' }));
  issues.push(idea({ number: 201, state: 'closed', created_at: '2026-09-02T10:01:00Z' }));
  const b = board({ raw: raw({ issues }) });
  assert.equal(b.ideas?.count, 23);
  assert.equal(b.ideas?.shown, 20);
  assert.equal(items(b).length, 20);
  // newest first: 122, 121, ... 103
  assert.deepEqual(numbers(b), Array.from({ length: 20 }, (_, k) => 122 - k));
  assert.ok(!numbers(b).includes(200) && !numbers(b).includes(201));
});

test('R32 ideas created at the same instant are ordered by higher number first', () => {
  resetNumbers();
  const issues = [
    idea({ number: 7, created_at: '2026-09-01T10:00:00Z' }), // oldest
    idea({ number: 5, created_at: '2026-09-02T10:00:00Z' }),
    idea({ number: 9, created_at: '2026-09-02T10:00:00Z' }), // ties with 5, higher number goes first
  ];
  const b = board({ raw: raw({ issues }) });
  assert.equal(b.ideas?.count, 3);
  assert.deepEqual(numbers(b), [9, 5, 7]);
});

test('R32 with fewer than 20 open ideas shown equals the length of items', () => {
  resetNumbers();
  const b = board({ raw: raw({ issues: [idea({ number: 1 }), idea({ number: 2 }), task({ number: 3 })] }) });
  assert.equal(b.ideas?.count, 2);
  assert.equal(b.ideas?.shown, 2);
  assert.equal(items(b).length, 2);
});

// Walk every value of a board, outside the top-level key `ideas`, looking for a number.
function trace(value, needle, path, hits) {
  if (typeof value === 'number' && value === needle) hits.push(path);
  else if (typeof value === 'string' && value.includes(`/issues/${needle}`)) hits.push(path);
  else if (Array.isArray(value)) value.forEach((v, i) => trace(v, needle, `${path}[${i}]`, hits));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) trace(v, needle, `${path}.${k}`, hits);
  }
}

test('R33 an idea inside a shown project and a milestone is under ideas and nowhere else', () => {
  resetNumbers();
  const IDEA = 4141;
  const TASK = 4142; // the comparable task: same project, same milestone
  const issues = [
    idea({ number: IDEA, milestone: 5 }),
    task({ number: TASK, milestone: 5 }),
  ];
  const projects = [project(3, 'House', [IDEA, TASK])];
  const b = board({
    raw: raw({ issues, projects, milestones: [milestone(5, 'House · Hallway', '2026-10-20')] }),
    settings: settings({ projects: [{ key: 'house', number: 3 }] }),
  });
  // presence twin: the idea IS in the backlog, the task IS counted
  assert.equal(b.ideas?.count, 1);
  assert.equal(byNumber(b, IDEA)?.number, IDEA);
  assert.match(byNumber(b, IDEA)?.url ?? '', /\/issues\/4141$/);
  assert.equal(b.projects?.length, 1);
  assert.equal(b.projects?.[0]?.total, 1); // the task only
  assert.equal(b.projects?.[0]?.done, 0);
  assert.equal(b.next?.length, 1);
  assert.equal(b.next?.[0]?.number, TASK);
  assert.equal(b.timeline?.lanes?.[0]?.milestones?.[0]?.total, 1); // the task only
  assert.equal(b.standalone?.count, 0);
  // the sweep: every part of the board except `ideas`
  const hits = [];
  for (const [k, v] of Object.entries(b)) {
    if (k !== 'ideas') trace(v, IDEA, k, hits);
  }
  assert.deepEqual(hits, []);
  // the comparable task really is found by the same sweep
  const taskHits = [];
  for (const [k, v] of Object.entries(b)) {
    if (k !== 'ideas') trace(v, TASK, k, taskHits);
  }
  assert.ok(taskHits.length > 0);
});

test('R33 an idea alone in a milestone leaves that milestone at zero tasks and is never standalone', () => {
  resetNumbers();
  const issues = [idea({ number: 4141, milestone: 6 }), idea({ number: 4143 })];
  const b = board({
    raw: raw({ issues, projects: [project(3, 'House', [4141])], milestones: [milestone(6, 'House · Garden', '2026-10-25')] }),
    settings: settings({ projects: [{ key: 'house', number: 3 }] }),
  });
  assert.equal(b.ideas?.count, 2);
  assert.equal(b.timeline?.lanes?.[0]?.milestones?.length, 1); // the milestone itself is there
  assert.equal(b.timeline?.lanes?.[0]?.milestones?.[0]?.total, 0);
  assert.equal(b.projects?.[0]?.empty, true);
  assert.equal(b.standalone?.count, 0);
  assert.deepEqual(b.next, []);
});

test('R34 a fresh suggestion is acceptable only for a shown project and a usable milestone', () => {
  resetNumbers();
  const issues = [idea({ number: 41 }), idea({ number: 42 }), idea({ number: 43 })];
  const st = proposals(FRESH, [
    sug(41), // shown project, milestone 5 of House, open
    sug(42, { project: 'nope', milestone: null }), // unknown project
    sug(43, { project: null, milestone: null, newProject: 'Garage' }), // new project
  ]);
  const b = board({ raw: suggestionRaw(issues), settings: twoProjects(), state: st });
  assert.equal(items(b).length, 3);
  const s41 = byNumber(b, 41)?.suggestion;
  assert.ok(s41, 'idea 41 has a suggestion');
  assert.equal(s41.acceptable, true);
  assert.equal(s41.stale, false);
  assert.equal(s41.project, 'house');
  assert.equal(s41.projectTitle, 'House');
  assert.equal(s41.milestone, 5);
  assert.equal(s41.milestoneTitle, 'Hallway');
  assert.equal(s41.why, 'Same room');
  const s42 = byNumber(b, 42)?.suggestion;
  assert.ok(s42, 'idea 42 has a suggestion');
  assert.equal(s42.acceptable, false);
  const s43 = byNumber(b, 43)?.suggestion;
  assert.ok(s43, 'idea 43 has a suggestion');
  assert.equal(s43.acceptable, false);
  assert.equal(s43.newProject, 'Garage');
});

test('R34 a suggestion with no milestone for a shown project is acceptable', () => {
  resetNumbers();
  const st = proposals(FRESH, [sug(41, { milestone: null })]);
  const b = board({ raw: suggestionRaw([idea({ number: 41 })]), settings: twoProjects(), state: st });
  const s = byNumber(b, 41)?.suggestion;
  assert.ok(s, 'idea 41 has a suggestion');
  assert.equal(s.acceptable, true);
  assert.equal(s.milestone, null);
});

test("R34 a milestone of another project, or one closed on GitHub, is not acceptable", () => {
  resetNumbers();
  const issues = [idea({ number: 41 }), idea({ number: 42 }), idea({ number: 43 })];
  const st = proposals(FRESH, [
    sug(41), // twin: House milestone 5, acceptable
    sug(42, { milestone: 7 }), // milestone 7 is titled for Garden, the project is House
    sug(43, { milestone: 8 }), // milestone 8 belongs to House but is closed on GitHub
  ]);
  const b = board({ raw: suggestionRaw(issues), settings: twoProjects(), state: st });
  assert.equal(byNumber(b, 41)?.suggestion?.acceptable, true);
  assert.ok(byNumber(b, 42)?.suggestion, 'idea 42 has a suggestion');
  assert.equal(byNumber(b, 42).suggestion.acceptable, false);
  assert.ok(byNumber(b, 43)?.suggestion, 'idea 43 has a suggestion');
  assert.equal(byNumber(b, 43).suggestion.acceptable, false);
});

test('R34 a suggestion from a 30-hour-old file is stale and not acceptable', () => {
  resetNumbers();
  const st = proposals(STALE, [sug(41)]);
  const b = board({ raw: suggestionRaw([idea({ number: 41 })]), settings: twoProjects(), state: st });
  const s = byNumber(b, 41)?.suggestion;
  assert.ok(s, 'idea 41 has a suggestion');
  assert.equal(s.stale, true);
  assert.equal(s.acceptable, false);
});

test('R34 a proposals file just inside 24 hours is fresh and just outside is stale', () => {
  resetNumbers();
  // NOW is 2026-10-12T06:10:00Z; 23h59m before is 2026-10-11T06:11:00Z; 24h01m before is 06:09:00Z.
  const inside = board({
    raw: suggestionRaw([idea({ number: 41 })]), settings: twoProjects(),
    state: proposals('2026-10-11T06:11:00Z', [sug(41)]),
  });
  assert.equal(byNumber(inside, 41)?.suggestion?.stale, false);
  assert.equal(byNumber(inside, 41)?.suggestion?.acceptable, true);
  const outside = board({
    raw: suggestionRaw([idea({ number: 41 })]), settings: twoProjects(),
    state: proposals('2026-10-11T06:09:00Z', [sug(41)]),
  });
  assert.equal(byNumber(outside, 41)?.suggestion?.stale, true);
  assert.equal(byNumber(outside, 41)?.suggestion?.acceptable, false);
});

test('R34 an idea with no entry in the proposals has no suggestion', () => {
  resetNumbers();
  const st = proposals(FRESH, [sug(41)]);
  const b = board({ raw: suggestionRaw([idea({ number: 41 }), idea({ number: 44 })]), settings: twoProjects(), state: st });
  assert.equal(items(b).length, 2);
  assert.ok(byNumber(b, 41)?.suggestion, 'idea 41 has a suggestion');
  assert.equal(byNumber(b, 44)?.suggestion ?? null, null);
  assert.equal(byNumber(b, 44)?.number, 44);
});

test('R35 suggestions for a closed idea, a task and a missing number are dropped', () => {
  resetNumbers();
  const issues = [
    idea({ number: 51 }), // open idea
    idea({ number: 52, state: 'closed' }), // closed idea
    task({ number: 53 }), // a task (standalone)
  ];
  const st = proposals(FRESH, [sug(51), sug(52), sug(53), sug(999)]);
  const b = board({ raw: suggestionRaw(issues), settings: twoProjects(), state: st });
  // presence twin: the one valid suggestion is shown
  assert.equal(items(b).length, 1);
  assert.equal(byNumber(b, 51)?.number, 51);
  assert.equal(byNumber(b, 51)?.suggestion?.acceptable, true);
  const withSuggestion = items(b).filter((i) => i.suggestion);
  assert.equal(withSuggestion.length, 1);
  // no trace of the other three numbers under ideas
  const hits = [];
  for (const n of [52, 53, 999]) trace(b.ideas ?? {}, n, `ideas(${n})`, hits);
  assert.deepEqual(hits, []);
  assert.equal(b.ideas?.count, 1);
});
