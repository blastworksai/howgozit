// Rules R54, R56 to R61: the four actions that write back to GitHub (log an idea, tick and untick a
// habit, sort an idea, close a task). Every expected value is worked out by hand from
// references/contract.md and reference/server-spec.md; a recording gh stands in for GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, settings, project, milestone, task, idea, pr, checkin, raw, state, resetNumbers } from '../fixtures/build.mjs';
import { logIdea, setHabit, sortIdea, closeTask } from '../board/actions.mjs';
import { verbsFromGh } from '../board/github/adapter.mjs';

const TODAY = '2026-10-12'; // NOW is 06:10 UTC, 08:10 in Brussels
const YESTERDAY = '2026-10-11';
const FRESH = '2026-10-12T04:10:00Z'; // 2 hours before NOW
const STALE = '2026-10-11T00:10:00Z'; // 30 hours before NOW
const CLOSE = { state: 'closed', state_reason: 'completed' };

function ghError() {
  return Object.assign(new Error('GitHub is not answering right now.'), { name: 'GitHubError', kind: 'server', status: 500 });
}

// A recording gh. failOn(entry, index) decides whether the call (already recorded) throws.
function recorder({ failOn = null, plainError = false } = {}) {
  const calls = [];
  let next = 900;
  const rec = (entry) => {
    calls.push(entry);
    if (failOn && failOn(entry, calls.length)) throw plainError ? new Error('socket hang up at 10.0.0.1') : ghError();
  };
  const gh = {
    async createIssue({ title, labels }) {
      rec(['create', { title, labels }]);
      return { number: next++, title, labels, state: 'open' };
    },
    async patchIssue(number, patch) {
      rec(['patch', number, patch]);
      return { number, ...patch };
    },
    async addProjectItem({ projectNumber, issueNumber }) {
      rec(['add', { projectNumber, issueNumber }]);
      return {};
    },
  };
  return { gh, calls };
}

const HABITS = [{ id: 'move', title: 'Move', start: '2026-10-01' }];
const SHOWN = [{ key: 'house', number: 3 }, { key: 'garden', number: 4 }];

// A world: House (3) and Garden (4) shown; milestones 5 (House, open), 7 (Garden, open), 8 (House, closed).
function world({ issues = [], projects = null, milestones = null, st = state(), settingsOver = {} } = {}) {
  return {
    raw: raw({
      issues,
      projects: projects ?? [project(3, 'House'), project(4, 'Garden')],
      milestones: milestones ?? [
        milestone(5, 'House · Hallway', '2026-10-20'),
        milestone(7, 'Garden · Beds', '2026-11-02'),
        milestone(8, 'House · Old', '2026-09-01', { state: 'closed', closed_at: '2026-09-02T10:00:00Z' }),
      ],
    }),
    settings: settings({ projects: SHOWN, habits: HABITS, ...settingsOver }),
    theme: undefined,
    state: st,
    run: { stale: null, readOnly: false, warnings: [] },
  };
}

const proposals = (updated, ideas) => state({ proposals: { updated, focus: null, ideas } });
const sug = (number, over = {}) => ({ number, project: 'house', milestone: 5, newProject: null, why: 'Same room', ...over });
const projectWith = (...numbers) => [project(3, 'House', numbers), project(4, 'Garden')];

function assertRefusal(res, label = '') {
  assert.equal(res.ok, false, `${label} refused`);
  assert.equal(res.status, 400, `${label} status`);
  assert.equal(typeof res.message, 'string');
  assert.ok(res.message.trim().length > 0, `${label} has a message`);
}

// ---------- R54 ----------

test('R54 the gh handed to the actions has only create, patch and add, and each action uses only those', async () => {
  resetNumbers();
  const { gh, calls } = recorder();
  assert.deepEqual(Object.keys(gh).sort(), ['addProjectItem', 'createIssue', 'patchIssue']);
  const b = world({
    issues: [idea({ number: 41, labels: ['idea', 'home'] }), task({ number: 50 })],
    projects: [project(3, 'House', [50]), project(4, 'Garden')],
  });
  const results = [
    await logIdea(b, { title: 'Shelves' }, verbsFromGh(gh), NOW),
    await setHabit(b, { id: 'move', date: TODAY, on: true }, verbsFromGh(gh), NOW),
    await sortIdea(b, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW),
    await closeTask(b, { number: '50' }, verbsFromGh(gh), NOW),
  ];
  for (const r of results) assert.equal(r.ok, true);
  assert.ok(calls.length >= 4);
  for (const c of calls) assert.ok(['create', 'patch', 'add'].includes(c[0]), `call kind ${c[0]}`);
  const text = JSON.stringify(calls);
  assert.ok(!/content|\.json|\.md|base64|sha/i.test(text), 'no call mentions file contents');
});

// ---------- R56 ----------

test('R56 the title is cleaned and one idea is created with the idea label', async () => {
  const { gh, calls } = recorder();
  const res = await logIdea(world(), { title: '  Shelves\n for   the hall  ' }, verbsFromGh(gh), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, [['create', { title: 'Shelves for the hall', labels: ['idea'] }]]);
});

test('R56 a title of spaces only is refused and nothing is created', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await logIdea(world(), { title: '   \n\t ' }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R56 a title of 201 characters is refused and exactly 200 is accepted', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await logIdea(world(), { title: 'a'.repeat(201) }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
  const ok = await logIdea(world(), { title: 'a'.repeat(200) }, verbsFromGh(gh), NOW);
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [['create', { title: 'a'.repeat(200), labels: ['idea'] }]]);
});

test('R56 control characters are removed from the title', async () => {
  const { gh, calls } = recorder();
  const res = await logIdea(world(), { title: 'Fix\u0000 the\u0007 door\u001b' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.equal(calls[0][1].title, 'Fix the door');
});

test('R56 a missing or empty title is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await logIdea(world(), { title: '' }, verbsFromGh(gh), NOW), 'empty');
  assertRefusal(await logIdea(world(), {}, verbsFromGh(gh), NOW), 'missing');
  assert.deepEqual(calls, []);
});

test('R56 a custom idea label from the settings is the label used', async () => {
  const { gh, calls } = recorder();
  const b = world({ settingsOver: { labels: { idea: 'spark' } } });
  const res = await logIdea(b, { title: 'Try a herb wall' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['create', { title: 'Try a herb wall', labels: ['spark'] }]]);
});

// ---------- R57 ----------

test('R57 ticking a habit with no check-in creates one and closes that new number', async () => {
  const { gh, calls } = recorder();
  const res = await setHabit(world(), { id: 'move', date: TODAY, on: true }, verbsFromGh(gh), NOW);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['create', { title: `Move · ${TODAY}`, labels: ['habit:move'] }]);
  assert.deepEqual(calls[1], ['patch', 900, CLOSE]);
});

test('R57 ticking a habit with an open check-in closes it and creates nothing', async () => {
  resetNumbers();
  const { gh, calls } = recorder();
  const b = world({ issues: [checkin('move', TODAY, { closed: false })] });
  const number = b.raw.issues[0].number;
  const res = await setHabit(b, { id: 'move', date: TODAY, on: true }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['patch', number, CLOSE]]);
});

test('R57 ticking a habit already closed today sends no request', async () => {
  const { gh, calls } = recorder();
  const b = world({ issues: [checkin('move', TODAY, { closed: true })] });
  const res = await setHabit(b, { id: 'move', date: TODAY, on: true }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, []);
});

test('R57 a check-in of yesterday does not count as today, so a tick creates a new one', async () => {
  const { gh, calls } = recorder();
  const b = world({ issues: [checkin('move', YESTERDAY, { closed: true })] });
  const res = await setHabit(b, { id: 'move', date: TODAY, on: true }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][1].title, `Move · ${TODAY}`);
  assert.equal(calls.length, 2);
});

test('R57 an unknown habit id is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await setHabit(world(), { id: 'ghost', date: TODAY, on: true }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R57 a date that is not today is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await setHabit(world(), { id: 'move', date: YESTERDAY, on: true }, verbsFromGh(gh), NOW), 'yesterday');
  assertRefusal(await setHabit(world(), { id: 'move', date: '2026-10-13', on: true }, verbsFromGh(gh), NOW), 'tomorrow');
  assertRefusal(await setHabit(world(), { id: 'move', date: 'soon', on: true }, verbsFromGh(gh), NOW), 'garbage');
  assert.deepEqual(calls, []);
});

// ---------- R58 ----------

test('R58 unticking reopens every closed check-in of today', async () => {
  resetNumbers();
  const { gh, calls } = recorder();
  const a = checkin('move', TODAY, { closed: true });
  const c = checkin('move', TODAY, { closed: true, closedAt: '2026-10-12T05:00:00Z' });
  const b = world({ issues: [a, c] });
  const res = await setHabit(b, { id: 'move', date: TODAY, on: false }, verbsFromGh(gh), NOW);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((x) => x[0]), ['patch', 'patch']);
  assert.deepEqual(calls.map((x) => x[1]).sort(), [a.number, c.number].sort());
  for (const x of calls) assert.deepEqual(x[2], { state: 'open' });
});

test('R58 unticking with only a check-in of yesterday sends no request', async () => {
  const { gh, calls } = recorder();
  const b = world({ issues: [checkin('move', YESTERDAY, { closed: true })] });
  const res = await setHabit(b, { id: 'move', date: TODAY, on: false }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, []);
});

test('R58 unticking does not touch another habit or an open check-in', async () => {
  resetNumbers();
  const { gh, calls } = recorder();
  const other = checkin('read', TODAY, { closed: true });
  const open = checkin('move', TODAY, { closed: false });
  const b = world({
    issues: [other, open],
    settingsOver: { habits: [...HABITS, { id: 'read', title: 'Read', start: '2026-10-01' }] },
  });
  const res = await setHabit(b, { id: 'move', date: TODAY, on: false }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, []);
});

// ---------- R59 ----------

const sortWorld = (over = {}) =>
  world({ issues: [idea({ number: 41, labels: ['idea', 'home'] })], ...over });

test('R59 a valid sort adds the item, sets the milestone, then sets the labels without the idea label', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(sortWorld(), { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, [
    ['add', { projectNumber: 3, issueNumber: 41 }],
    ['patch', 41, { milestone: 5 }],
    ['patch', 41, { labels: ['home'] }],
  ]);
});

test('R59 numbers given as numbers work like strings', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(sortWorld(), { number: 41, project: 'house', milestone: 5 }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], ['patch', 41, { milestone: 5 }]);
});

test('R59 a sort without a milestone adds the item and sets the labels, with no milestone call', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(sortWorld(), { number: '41', project: 'house', milestone: '' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    ['add', { projectNumber: 3, issueNumber: 41 }],
    ['patch', 41, { labels: ['home'] }],
  ]);
  const { gh: gh2, calls: calls2 } = recorder();
  const res2 = await sortIdea(sortWorld(), { number: '41', project: 'house' }, verbsFromGh(gh2), NOW);
  assert.equal(res2.ok, true);
  assert.equal(calls2.length, 2);
});

test('R59 a failure on set-milestone answers 502 naming the step and leaves the labels alone', async () => {
  const { gh, calls } = recorder({ failOn: (e) => e[0] === 'patch' && 'milestone' in e[2] });
  const res = await sortIdea(sortWorld(), { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.match(res.message, /setting the milestone/);
  assert.deepEqual(calls.map((c) => c[0]), ['add', 'patch']);
  assert.ok(!calls.some((c) => c[0] === 'patch' && 'labels' in c[2]), 'no label change');
});

test('R59 after a failed sort a second post sends the milestone and the labels only', async () => {
  const { gh, calls } = recorder();
  // GitHub now has the idea as an item of House, milestone still unset.
  const b = sortWorld({ projects: projectWith(41) });
  const res = await sortIdea(b, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    ['patch', 41, { milestone: 5 }],
    ['patch', 41, { labels: ['home'] }],
  ]);
});

test('R59 an idea already an item of the project gets no add call', async () => {
  const { gh, calls } = recorder();
  const res = await sortIdea(sortWorld({ projects: projectWith(41) }), { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.ok(!calls.some((c) => c[0] === 'add'));
});

test('R59 a milestone already set is skipped', async () => {
  const { gh, calls } = recorder();
  const b = sortWorld({ issues: [idea({ number: 41, labels: ['idea', 'home'], milestone: 5 })] });
  const res = await sortIdea(b, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    ['add', { projectNumber: 3, issueNumber: 41 }],
    ['patch', 41, { labels: ['home'] }],
  ]);
});

test('R59 a failure on adding the item answers 502 naming that step and sends nothing after it', async () => {
  const { gh, calls } = recorder({ failOn: (e) => e[0] === 'add' });
  const res = await sortIdea(sortWorld(), { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW);
  assert.equal(res.status, 502);
  assert.equal(res.ok, false);
  assert.match(res.message, /adding it to the project/);
  assert.deepEqual(calls.map((c) => c[0]), ['add']);
});

test('R59 a failure on the label change answers 502 naming that step', async () => {
  const { gh } = recorder({ failOn: (e) => e[0] === 'patch' && 'labels' in e[2] });
  const res = await sortIdea(sortWorld(), { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.match(res.message, /removing the idea label/);
});

test('R59 a milestone of another project is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(sortWorld(), { number: '41', project: 'house', milestone: '7' }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R59 a closed idea is refused with no request', async () => {
  const { gh, calls } = recorder();
  const b = world({ issues: [idea({ number: 41, state: 'closed' })] });
  assertRefusal(await sortIdea(b, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R59 a task is refused with no request', async () => {
  const { gh, calls } = recorder();
  const b = world({ issues: [task({ number: 41 })] });
  assertRefusal(await sortIdea(b, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R59 an unknown issue number is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(sortWorld(), { number: '999', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW), 'unknown');
  assertRefusal(await sortIdea(sortWorld(), { number: 'abc', project: 'house', milestone: '5' }, verbsFromGh(gh), NOW), 'not a number');
  assert.deepEqual(calls, []);
});

test('R59 an unknown project key is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(sortWorld(), { number: '41', project: 'nowhere', milestone: '' }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R59 a project that is not shown is refused with no request', async () => {
  const { gh, calls } = recorder();
  // Garden is listed in the settings but closed on GitHub, so it is not shown.
  const b = sortWorld({ projects: [project(3, 'House'), project(4, 'Garden', [], { closed: true })] });
  assertRefusal(await sortIdea(b, { number: '41', project: 'garden', milestone: '' }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R59 a milestone closed on GitHub is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(sortWorld(), { number: '41', project: 'house', milestone: '8' }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R59 a milestone number that does not exist is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(sortWorld(), { number: '41', project: 'house', milestone: '99' }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

// ---------- R60 ----------

const acceptWorld = (st, issues = [idea({ number: 41, labels: ['idea', 'home'] })]) => world({ issues, st });

test('R60 an acceptable suggestion sends the same three requests as a hand sort', async () => {
  const { gh, calls } = recorder();
  const b = acceptWorld(proposals(FRESH, [sug(41)]));
  const res = await sortIdea(b, { number: '41', accept: true }, verbsFromGh(gh), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, [
    ['add', { projectNumber: 3, issueNumber: 41 }],
    ['patch', 41, { milestone: 5 }],
    ['patch', 41, { labels: ['home'] }],
  ]);
});

test('R60 the suggestion wins over a project and milestone passed in the form', async () => {
  const { gh, calls } = recorder();
  const b = acceptWorld(proposals(FRESH, [sug(41)]));
  const res = await sortIdea(b, { number: '41', project: 'garden', milestone: '7', accept: true }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ['add', { projectNumber: 3, issueNumber: 41 }]);
  assert.deepEqual(calls[1], ['patch', 41, { milestone: 5 }]);
  assert.equal(calls.length, 3);
});

test('R60 an acceptable suggestion with no milestone sends no milestone call', async () => {
  const { gh, calls } = recorder();
  const b = acceptWorld(proposals(FRESH, [sug(41, { milestone: null })]));
  const res = await sortIdea(b, { number: '41', accept: true }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    ['add', { projectNumber: 3, issueNumber: 41 }],
    ['patch', 41, { labels: ['home'] }],
  ]);
});

test('R60 a suggestion from a stale proposals file is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(acceptWorld(proposals(STALE, [sug(41)])), { number: '41', accept: true }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R60 an idea with no suggestion is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(acceptWorld(proposals(FRESH, [])), { number: '41', accept: true }, verbsFromGh(gh), NOW), 'empty file');
  assertRefusal(await sortIdea(acceptWorld(proposals(FRESH, [sug(42)])), { number: '41', accept: true }, verbsFromGh(gh), NOW), 'other idea');
  assertRefusal(await sortIdea(acceptWorld(state()), { number: '41', accept: true }, verbsFromGh(gh), NOW), 'no file');
  assert.deepEqual(calls, []);
});

test('R60 a suggestion naming a new project is refused with no request', async () => {
  const { gh, calls } = recorder();
  const st = proposals(FRESH, [sug(41, { project: null, milestone: null, newProject: 'Garage' })]);
  assertRefusal(await sortIdea(acceptWorld(st), { number: '41', project: 'house', milestone: '5', accept: true }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R60 a suggestion naming an unknown project is refused with no request', async () => {
  const { gh, calls } = recorder();
  const st = proposals(FRESH, [sug(41, { project: 'nope', milestone: null })]);
  assertRefusal(await sortIdea(acceptWorld(st), { number: '41', accept: true }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

test('R60 a suggestion with a milestone closed on GitHub is refused with no request', async () => {
  const { gh, calls } = recorder();
  assertRefusal(await sortIdea(acceptWorld(proposals(FRESH, [sug(41, { milestone: 8 })])), { number: '41', accept: true }, verbsFromGh(gh), NOW));
  assert.deepEqual(calls, []);
});

// ---------- R61 ----------

test('R61 one post for each of the eight sorts closes two and refuses six', async () => {
  resetNumbers();
  const { gh, calls } = recorder();
  const habitCheckin = checkin('move', TODAY, { closed: false });
  const issues = [
    task({ number: 10 }), // open task, item of House
    task({ number: 11 }), // open standalone task
    idea({ number: 12 }), // idea
    habitCheckin, // check-in
    task({ number: 14, labels: ['weekly-review'] }), // ignored issue
    pr({ number: 15 }), // pull request
    task({ number: 16, state: 'closed' }), // closed task
  ];
  const b = world({ issues, projects: [project(3, 'House', [10]), project(4, 'Garden')] });
  const posts = [10, 11, 12, habitCheckin.number, 14, 15, 16, 999];
  const results = [];
  for (const n of posts) results.push(await closeTask(b, { number: String(n) }, verbsFromGh(gh), NOW));
  assert.deepEqual(results.map((r) => r.ok), [true, true, false, false, false, false, false, false]);
  for (const r of results.slice(2)) assertRefusal(r);
  assert.deepEqual(calls, [
    ['patch', 10, CLOSE],
    ['patch', 11, CLOSE],
  ]);
});

test('R61 closing a task given as a number works', async () => {
  const { gh, calls } = recorder();
  const res = await closeTask(world({ issues: [task({ number: 11 })] }), { number: 11 }, verbsFromGh(gh), NOW);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, [['patch', 11, CLOSE]]);
});

test('R61 a task that is an item of an unlisted project only is standalone and can be closed', async () => {
  const { gh, calls } = recorder();
  const b = world({
    issues: [task({ number: 11 })],
    projects: [project(3, 'House'), project(4, 'Garden'), project(7, 'Attic', [11])],
  });
  const res = await closeTask(b, { number: '11' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['patch', 11, CLOSE]]);
});

test('R61 a missing or non-numeric number is refused with no request', async () => {
  const { gh, calls } = recorder();
  const b = world({ issues: [task({ number: 11 })] });
  assertRefusal(await closeTask(b, {}, verbsFromGh(gh), NOW), 'missing');
  assertRefusal(await closeTask(b, { number: 'eleven' }, verbsFromGh(gh), NOW), 'text');
  assertRefusal(await closeTask(b, { number: '-3' }, verbsFromGh(gh), NOW), 'negative');
  assertRefusal(await closeTask(b, { number: '0' }, verbsFromGh(gh), NOW), 'zero');
  assert.deepEqual(calls, []);
});

// ---------- U ----------

test('U every refusal has status 400 and a one-sentence message, and sends no request', async () => {
  const { gh, calls } = recorder();
  const b = sortWorld();
  const refusals = [
    await logIdea(b, { title: ' ' }, verbsFromGh(gh), NOW),
    await setHabit(b, { id: 'ghost', date: TODAY, on: true }, verbsFromGh(gh), NOW),
    await setHabit(b, { id: 'move', date: YESTERDAY, on: false }, verbsFromGh(gh), NOW),
    await sortIdea(b, { number: '41', project: 'nowhere' }, verbsFromGh(gh), NOW),
    await sortIdea(b, { number: '41', accept: true }, verbsFromGh(gh), NOW),
    await closeTask(b, { number: '41' }, verbsFromGh(gh), NOW),
    await closeTask(b, { number: '999' }, verbsFromGh(gh), NOW),
  ];
  for (const r of refusals) {
    assertRefusal(r);
    assert.ok(!r.message.includes('\n'), 'one line');
    assert.ok(!r.message.includes('    at '), 'no stack line');
  }
  assert.deepEqual(calls, []);
});

test('U a GitHub failure gives 502 on each action and never rejects', async () => {
  const failing = () => recorder({ failOn: () => true });
  const b = world({
    issues: [idea({ number: 41, labels: ['idea', 'home'] }), task({ number: 50 })],
    projects: [project(3, 'House', [50]), project(4, 'Garden')],
  });
  const results = [
    await logIdea(b, { title: 'Shelves' }, verbsFromGh(failing().gh), NOW),
    await setHabit(b, { id: 'move', date: TODAY, on: true }, verbsFromGh(failing().gh), NOW),
    await sortIdea(b, { number: '41', project: 'house', milestone: '5' }, verbsFromGh(failing().gh), NOW),
    await closeTask(b, { number: '50' }, verbsFromGh(failing().gh), NOW),
  ];
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.status, 502);
    assert.ok(r.message.trim().length > 0);
    assert.ok(!r.message.includes('    at '), 'no stack line');
  }
  assert.match(results[0].message, /GitHub is not answering right now\./);
});

test('U an error that is not a GitHubError gives the fixed sentence, without its own text', async () => {
  const { gh } = recorder({ failOn: () => true, plainError: true });
  const res = await logIdea(world(), { title: 'Shelves' }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.equal(res.message, 'GitHub did not accept the change.');
  assert.ok(!res.message.includes('10.0.0.1'));
});

test('U a failure on the create of a tick answers 502 and sends no close', async () => {
  const { gh, calls } = recorder({ failOn: (e) => e[0] === 'create' });
  const res = await setHabit(world(), { id: 'move', date: TODAY, on: true }, verbsFromGh(gh), NOW);
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  assert.deepEqual(calls.map((c) => c[0]), ['create']);
});

test('U actions given garbage resolve to ok false rather than throwing', async () => {
  const { gh, calls } = recorder();
  const b = world();
  const cases = [
    () => logIdea(b, { title: null }, verbsFromGh(gh), NOW),
    () => logIdea(null, { title: 'x' }, verbsFromGh(gh), NOW),
    () => setHabit(b, { id: null, date: null, on: null }, verbsFromGh(gh), NOW),
    () => setHabit({}, { id: 'move', date: TODAY, on: true }, verbsFromGh(gh), NOW),
    () => sortIdea(b, { number: null, project: null, milestone: null }, verbsFromGh(gh), NOW),
    () => sortIdea({ raw: null, settings: null, state: null }, { number: '1', project: 'house' }, verbsFromGh(gh), NOW),
    () => closeTask(b, { number: null }, verbsFromGh(gh), NOW),
    () => closeTask({ settings: b.settings }, { number: '1' }, verbsFromGh(gh), NOW),
    () => closeTask(b, { number: '1' }, verbsFromGh(gh), 'not a time'),
  ];
  for (const run of cases) {
    const res = await run();
    assert.equal(res.ok, false);
    assert.ok([400, 502].includes(res.status));
    assert.equal(typeof res.message, 'string');
    assert.ok(res.message.length > 0);
    assert.ok(!res.message.includes('    at '));
  }
  assert.deepEqual(calls, []);
});

test('U an action given no input object at all resolves rather than rejecting', async () => {
  const { gh, calls } = recorder();
  const b = world();
  for (const run of [
    () => logIdea(b, null, verbsFromGh(gh), NOW),
    () => logIdea(b, undefined, verbsFromGh(gh), NOW),
    () => setHabit(b, null, verbsFromGh(gh), NOW),
    () => sortIdea(b, undefined, verbsFromGh(gh), NOW),
    () => closeTask(b, null, verbsFromGh(gh), NOW),
  ]) {
    const res = await run();
    assert.equal(res.ok, false);
    assert.ok([400, 502].includes(res.status));
    assert.ok(res.message.length > 0);
  }
  assert.deepEqual(calls, []);
});
