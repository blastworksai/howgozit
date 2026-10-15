import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRaw, checkState, checkBoard } from '../board/shape-data.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));

function rawExample() {
  return {
    fetchedAt: '2026-10-12T06:10:00Z',
    partial: { issues: false, items: false },
    repo: 'sam-life/life',
    repoPrivate: true,
    ownerType: 'organization',
    issues: [
      {
        number: 12, title: 'Paint the hallway', state: 'open', state_reason: null,
        is_pr: false, labels: ['home'], milestone: 5,
        created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
        html_url: 'https://github.com/sam-life/life/issues/12',
      },
    ],
    milestones: [
      {
        number: 5, title: 'House · Hallway', state: 'open',
        due_on: '2026-10-20T07:00:00Z', closed_at: null,
        html_url: 'https://github.com/sam-life/life/milestone/5',
      },
    ],
    projects: [
      {
        number: 3, title: 'House', closed: false,
        url: 'https://github.com/orgs/sam-life/projects/3',
        items: [{ type: 'Issue', repo: 'sam-life/life', number: 12, status: 'In Progress', due: '2026-10-18' }],
      },
    ],
  };
}

function stateExample() {
  return {
    brief: { generated: '2026-10-12T06:00:00+02:00', lines: [{ src: 'CAL', text: '4 events today.' }] },
    calendar: { date: '2026-10-12', events: [{ title: 'Standup', start: '08:30', end: '08:45', kind: 'meeting' }] },
    inbox: {
      updated: '2026-10-12T07:45:00+02:00',
      counts: { reply: 4, decide: 2, fyi: 11 },
      threads: [{ bucket: 'reply', from: 'Accountant', subject: 'Q3 documents', why: 'Asked a direct question', draft: true }],
    },
    log: [{ t: '06:00', agent: 'brief-agent', what: "Wrote this morning's brief" }],
    proposals: {
      updated: '2026-10-12T06:00:00+02:00',
      focus: { add: ['side'], remove: [], why: 'Two milestones fall due this week' },
      ideas: [{ number: 41, project: 'house', milestone: 5, newProject: null, why: 'Same room as the hallway work' }],
    },
  };
}

function boardExample() {
  const ms = (number, short, due, state) => ({
    number, shortTitle: short, url: `https://github.com/sam-life/life/milestone/${number}`,
    due, state, done: 1, total: 3, pct: 33,
  });
  const days = [];
  for (let i = 0; i < 14; i++) {
    days.push({ date: `2026-09-${String(29 - 13 + i + 1).padStart(2, '0')}`, status: i < 5 ? 'before' : 'done' });
  }
  const weeks = [];
  for (let w = 0; w < 12; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const future = w === 11 && d > 1;
      week.push({ date: `2026-07-${String(w + d + 1).padStart(2, '0')}`, count: future ? null : 2, level: future ? null : 2 });
    }
    weeks.push(week);
  }
  return {
    meta: {
      generatedAt: '2026-10-12T06:10:05Z', today: '2026-10-12', timezone: 'Europe/Brussels',
      name: 'Sam', greeting: 'Good morning', weekNumber: 42, agentName: 'Agent',
      repoUrl: 'https://github.com/sam-life/life',
      stale: null, readOnly: false,
      sources: [{ id: 'github', state: 'ok', at: '2026-10-12T06:10:00Z' }],
      warnings: [{ code: 'milestone-unmatched', count: 1 }],
    },
    focus: {
      projects: [{ key: 'house', title: 'House', color: '#7FE7D3' }],
      proposal: { add: ['side'], remove: [], why: 'Two milestones fall due this week', stale: false },
    },
    next: [
      {
        number: 12, title: 'Paint the hallway', url: 'https://github.com/sam-life/life/issues/12',
        project: { key: 'house', title: 'House', color: '#7FE7D3' },
        milestone: { shortTitle: 'Hallway' },
        due: '2026-10-18', urgency: 'dated', overdueDays: 0,
      },
    ],
    timeline: {
      start: '2026-09-01', end: '2026-11-30', today: '2026-10-12',
      lanes: [
        {
          project: { key: 'house', title: 'House', color: '#7FE7D3', focus: true },
          milestones: [ms(5, 'Hallway', '2026-10-20', 'open')],
          undated: [ms(8, 'Someday', null, 'open')],
          beforeWindow: 0, beyondWindow: 0,
        },
      ],
      other: [ms(9, 'Garden · Beds', '2026-11-02', 'open')],
    },
    projects: [
      {
        key: 'house', number: 3, title: 'House', url: 'https://github.com/orgs/sam-life/projects/3',
        color: '#7FE7D3', focus: true, done: 1, total: 3, pct: 33, empty: false, doing: 1,
        overdueMilestones: 0, nextMilestone: { shortTitle: 'Hallway', due: '2026-10-20' },
        habits: [{ id: 'move', title: 'Move', streak: 9 }],
      },
    ],
    habits: [
      {
        id: 'move', title: 'Move', project: { key: 'house', color: '#7FE7D3' },
        streak: 9, best: 12, tokens: 1, toNextToken: 3,
        flamesLit: 3, flames: [true, true, true, false, false], toNextFlame: 5,
        recent: days, doneToday: false,
      },
    ],
    ideas: {
      count: 12, shown: 1,
      items: [
        {
          number: 41, title: 'Shelves for the hallway', url: 'https://github.com/sam-life/life/issues/41',
          createdAt: '2026-10-11',
          suggestion: {
            project: 'house', projectTitle: 'House', milestone: 5, milestoneTitle: 'Hallway',
            newProject: null, why: 'Same room as the hallway work', stale: false, acceptable: true,
          },
        },
      ],
    },
    sortTargets: [{ key: 'house', title: 'House', milestones: [{ number: 5, shortTitle: 'Hallway' }] }],
    heatmap: { weeks },
    season: {
      name: 'Autumn', start: '2026-10-12', end: '2026-12-31', daysLeft: 80, phase: 'running',
      goals: [{ title: 'Finish the kitchen', pct: 33 }],
    },
    standalone: {
      count: 1,
      items: [{ number: 30, title: 'Renew passport', url: 'https://github.com/sam-life/life/issues/30', due: null }],
    },
    panels: {
      brief: { stale: false, generated: '06:00', lines: [{ src: 'CAL', text: '4 events today.' }] },
      calendar: {
        stale: false, date: '2026-10-12', now: '08:10',
        events: [{ title: 'Standup', start: '08:30', end: '08:45', kind: 'meeting' }],
      },
      inbox: {
        stale: false, counts: { reply: 4, decide: 2, fyi: 11 },
        threads: [{ bucket: 'reply', from: 'Accountant', subject: 'Q3 documents', why: 'Asked a direct question', draft: true }],
      },
      log: { stale: false, entries: [{ t: '06:00', agent: 'brief-agent', what: "Wrote this morning's brief" }] },
    },
  };
}

function emptyBoard() {
  const b = boardExample();
  b.focus = { projects: [], proposal: null };
  b.next = [];
  b.timeline.lanes = [];
  b.timeline.other = [];
  b.projects = [];
  b.habits = [];
  b.ideas = { count: 0, shown: 0, items: [] };
  b.sortTargets = [];
  b.season = null;
  b.standalone = { count: 0, items: [] };
  b.panels = { brief: null, calendar: null, inbox: null, log: null };
  b.meta.warnings = [];
  return b;
}

const BAD = [null, 'text', 42, true, [], undefined];

test('U raw example passes', () => {
  const r = checkRaw(rawExample());
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('U raw with null item fields, user owner and empty lists passes', () => {
  const x = rawExample();
  x.ownerType = 'user';
  x.issues[0].milestone = null;
  x.issues[0].state_reason = null;
  x.milestones[0].due_on = null;
  x.projects[0].items = [
    { type: 'DraftIssue', repo: null, number: null, status: null, due: null },
    { type: 'REDACTED', repo: null, number: null, status: null, due: null },
    { type: 'PullRequest', repo: 'sam-life/life', number: 7, status: 'Todo', due: null },
  ];
  assert.equal(checkRaw(x).ok, true);
  assert.equal(checkRaw({ ...x, issues: [], milestones: [], projects: [] }).ok, true);
});

test('U raw with a bad issue row fails and names the row', () => {
  const x = rawExample();
  x.issues[0].number = 'twelve';
  const r = checkRaw(x);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.startsWith('issues[0].number')), r.errors.join('|'));
});

test('U raw with a bad milestone row fails', () => {
  const x = rawExample();
  x.milestones[0].state = 'half';
  const r = checkRaw(x);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.startsWith('milestones[0].state')));
});

test('U raw with a bad project item row fails', () => {
  const x = rawExample();
  x.projects[0].items[0].type = 'Epic';
  const r = checkRaw(x);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.startsWith('projects[0].items[0].type')));
  const y = rawExample();
  delete y.projects[0].items[0].status;
  assert.equal(checkRaw(y).ok, false);
});

test('U raw with a bad owner type or missing top-level key fails', () => {
  const x = rawExample();
  x.ownerType = 'team';
  assert.equal(checkRaw(x).ok, false);
  const y = rawExample();
  delete y.repoPrivate;
  const r = checkRaw(y);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.startsWith('repoPrivate')));
  const z = rawExample();
  z.issues = 'none';
  assert.equal(checkRaw(z).ok, false);
});

test('U state example passes for every key', () => {
  const s = stateExample();
  for (const name of ['brief', 'calendar', 'inbox', 'log', 'proposals']) {
    assert.deepEqual(checkState(name, s[name]), { ok: true, errors: [] }, name);
  }
});

test('U state optional fields: draft absent, proposals focus and ideas absent or null', () => {
  const s = stateExample();
  delete s.inbox.threads[0].draft;
  assert.equal(checkState('inbox', s.inbox).ok, true);
  assert.equal(checkState('proposals', { updated: 'x' }).ok, true);
  assert.equal(checkState('proposals', { updated: 'x', focus: null, ideas: null }).ok, true);
  s.proposals.ideas = [{ number: 2, project: null, milestone: null, newProject: 'Garage', why: 'New area' }];
  assert.equal(checkState('proposals', s.proposals).ok, true);
  assert.equal(checkState('log', []).ok, true);
});

test('U state broken variants fail naming the field', () => {
  const s = stateExample();
  s.brief.lines[0].text = 5;
  let r = checkState('brief', s.brief);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.startsWith('brief.lines[0].text')));
  s.calendar.events = {};
  assert.equal(checkState('calendar', s.calendar).ok, false);
  s.inbox.counts.reply = 'four';
  r = checkState('inbox', s.inbox);
  assert.ok(r.errors.some((m) => m.startsWith('inbox.counts.reply')));
  assert.equal(checkState('log', { t: 'x' }).ok, false);
  s.proposals.ideas[0].number = 0;
  r = checkState('proposals', s.proposals);
  assert.ok(r.errors.some((m) => m.startsWith('proposals.ideas[0].number')));
  assert.equal(checkState('proposals', { ...stateExample().proposals, focus: { add: 'side', remove: [], why: 'x' } }).ok, false);
});

test('U state unknown file name fails without throwing', () => {
  assert.equal(checkState('weather', {}).ok, false);
  assert.equal(checkState(undefined, {}).ok, false);
  assert.equal(checkState('constructor', {}).ok, false);
});

test('U board example passes', () => {
  const r = checkBoard(boardExample());
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('U board: one broken variant per top-level key fails and names that key', () => {
  const breakers = {
    meta: (b) => { b.meta.weekNumber = 'x'; },
    focus: (b) => { b.focus.projects = 'x'; },
    next: (b) => { b.next[0].urgency = 'soon'; },
    timeline: (b) => { b.timeline.lanes[0].milestones[0].state = 'late'; },
    projects: (b) => { b.projects[0].pct = 'x'; },
    habits: (b) => { b.habits[0].recent.pop(); },
    ideas: (b) => { b.ideas.items[0].suggestion.acceptable = 'yes'; },
    sortTargets: (b) => { b.sortTargets[0].milestones = null; },
    heatmap: (b) => { b.heatmap.weeks.pop(); },
    season: (b) => { b.season.phase = 'soon'; },
    standalone: (b) => { b.standalone.items[0].number = -1; },
    panels: (b) => { b.panels.log.stale = 'no'; },
  };
  for (const [key, brk] of Object.entries(breakers)) {
    const b = boardExample();
    brk(b);
    const r = checkBoard(b);
    assert.equal(r.ok, false, key);
    assert.ok(r.errors.some((m) => m.startsWith(key)), `${key}: ${r.errors.join('|')}`);
  }
});

test('U board: every top-level key is required', () => {
  for (const key of ['meta', 'focus', 'next', 'timeline', 'projects', 'habits', 'ideas', 'sortTargets', 'heatmap', 'season', 'standalone', 'panels']) {
    const b = boardExample();
    delete b[key];
    const r = checkBoard(b);
    assert.equal(r.ok, false, key);
    assert.ok(r.errors.some((m) => m.startsWith(key)), key);
  }
});

test('U board: fixed lengths are enforced', () => {
  let b = boardExample();
  b.habits[0].recent.push({ date: '2026-10-13', status: 'pending' });
  assert.equal(checkBoard(b).ok, false);
  b = boardExample();
  b.habits[0].flames.push(false);
  assert.equal(checkBoard(b).ok, false);
  b = boardExample();
  b.heatmap.weeks[3].pop();
  const r = checkBoard(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.startsWith('heatmap.weeks[3]')));
  b = boardExample();
  b.heatmap.weeks.push(b.heatmap.weeks[0]);
  assert.equal(checkBoard(b).ok, false);
});

test('U board: allowed values are enforced', () => {
  const cases = [
    (b) => { b.habits[0].recent[0].status = 'late'; },
    (b) => { b.timeline.other[0].state = 'closed'; },
    (b) => { b.meta.sources[0].state = 'down'; },
    (b) => { b.heatmap.weeks[0][0].level = 5; },
  ];
  for (const brk of cases) {
    const b = boardExample();
    brk(b);
    assert.equal(checkBoard(b).ok, false);
  }
  for (const phase of ['before', 'running', 'after']) {
    const b = boardExample();
    b.season.phase = phase;
    assert.equal(checkBoard(b).ok, true, phase);
  }
  for (const urgency of ['overdue', 'dated', 'undated']) {
    const b = boardExample();
    b.next[0].urgency = urgency;
    assert.equal(checkBoard(b).ok, true, urgency);
  }
});

test('U board: nullable fields accept null', () => {
  const b = boardExample();
  b.meta.stale = { since: '2026-10-12T05:00:00Z', reason: 'GitHub did not answer' };
  b.focus.proposal = null;
  b.ideas.items[0].suggestion = null;
  b.projects[0].nextMilestone = null;
  b.habits[0].toNextFlame = null;
  b.habits[0].project = null;
  b.next[0].milestone = null;
  b.next[0].due = null;
  b.timeline.lanes[0].milestones[0].due = null;
  b.season.goals[0].pct = null;
  b.standalone.items[0].due = null;
  b.heatmap.weeks[11][6] = { date: '2026-10-18', count: null, level: null };
  assert.deepEqual(checkBoard(b), { ok: true, errors: [] });
});

test('U board: panel is null, exactly the error object, or content with boolean stale', () => {
  const b = boardExample();
  b.panels.brief = { error: 'unreadable' };
  b.panels.calendar = null;
  assert.equal(checkBoard(b).ok, true);
  b.panels.inbox = { error: 'unreadable', extra: 1 };
  assert.equal(checkBoard(b).ok, false);
  b.panels.inbox = { error: 'other' };
  assert.equal(checkBoard(b).ok, false);
  const c = boardExample();
  delete c.panels.log.stale;
  assert.equal(checkBoard(c).ok, false);
  const d = boardExample();
  delete d.panels.log;
  assert.equal(checkBoard(d).ok, false);
});

test('U board: an all-empty board passes', () => {
  assert.deepEqual(checkBoard(emptyBoard()), { ok: true, errors: [] });
});

test('U non-object inputs return ok false without throwing', () => {
  for (const v of BAD) {
    for (const fn of [
      checkRaw,
      checkBoard,
      (x) => checkState('brief', x),
      (x) => checkState('calendar', x),
      (x) => checkState('inbox', x),
      (x) => checkState('proposals', x),
    ]) {
      const r = fn(v);
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    }
  }
  for (const v of [null, 'text', 42, true, {}, undefined]) {
    assert.equal(checkState('log', v).ok, false);
  }
});

test('U hostile values do not make the checkers throw', () => {
  const evil = { get number() { throw new Error('boom'); } };
  assert.equal(checkRaw({ issues: [evil] }).ok, false);
  assert.equal(checkBoard({ meta: evil }).ok, false);
  assert.equal(checkState('brief', evil).ok, false);
  const cyc = {};
  cyc.self = cyc;
  assert.equal(checkBoard(cyc).ok, false);
});

test('U inputs are not changed by checking', () => {
  const b = boardExample();
  const before = clone(b);
  checkBoard(b);
  assert.deepEqual(b, before);
});
