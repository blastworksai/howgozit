// CP6 (SKILLS-78) job D1, scores half: the habit score (R36, R136 to R139, R57, R58, R91) and its settings.
// Written from references/contract.md and reference/mapping-redesign/cp6-interface.md sections 1, 3b, 3c, 3g, from hand-made
// raw and settings only. Today is 2026-10-12 (board timezone Europe/Brussels); `recent` runs 2026-09-29 .. 2026-10-12.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, project, raw, checkin, resetNumbers, board } from '../fixtures/build.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const REPO = 'sam-life/life';
const OWNER = 'sam-life';
const TODAY = '2026-10-12';
const PROJ = { owner: OWNER, number: 9 };

const warn = (b, code) => (b?.meta?.warnings ?? []).find((w) => w.code === code)?.count ?? 0;
const habitOf = (b, id) => {
  const h = (b.habits ?? []).find((x) => x.id === id);
  assert.ok(h, `habit ${id} is on the board`);
  return h;
};
const dayOf = (h, date) => {
  const d = h.recent.find((e) => e.date === date);
  assert.ok(d, `recent has ${date}`);
  return d;
};

// A closed check-in for `date`, closed on its own day, with the given updated time (default: its close time).
function ci(date, { id = 'move', updated, closedAt } = {}) {
  const c = checkin(id, date, closedAt ? { closedAt } : {});
  if (updated) c.updated_at = updated;
  return c;
}
// A Habits Project item for a check-in; score may be any value (number, null, string).
const hitem = (c, score) => ({ type: 'Issue', repo: REPO, number: c.number, status: null, due: null, score });
const habitsRow = (items) => project(9, 'Habits log', [], { role: 'habits', owner: OWNER, items });

// board with one scored habit `move` (1..10) and the Habits Project given; `entries` = [checkin, score] pairs.
function scoredBoard(entries, { habit = {}, extraIssues = [], extraSettings = {} } = {}) {
  return board({
    settings: settings({
      habitsProject: PROJ,
      habits: [{ id: 'move', title: 'Move', start: '2026-09-29', score: { min: 1, max: 10 }, ...habit }],
      ...extraSettings,
    }),
    raw: raw({
      issues: [...entries.map(([c]) => c), ...extraIssues],
      projects: [habitsRow(entries.map(([c, s]) => hitem(c, s)))],
    }),
  });
}
const render = (b) => renderPage(b, THEME, OPTS);
const forms = (html) => [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
const formTag = (f) => f.match(/^<form\b[^>]*>/i)[0];
const attr = (tag, name) => {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : null;
};

// ---------- R136 ----------

test('R136 a Score of 7 on the check-in item is the score of its day', () => {
  resetNumbers();
  const b = scoredBoard([[ci('2026-10-10'), 7]]);
  assert.equal(dayOf(habitOf(b, 'move'), '2026-10-10').score, 7);
  assert.equal(warn(b, 'score-invalid'), 0);
});

test('R136 a Score of 11 is ignored (day done, no score) and adds one to score-invalid', () => {
  resetNumbers();
  const b = scoredBoard([[ci('2026-10-10'), 11]]);
  const d = dayOf(habitOf(b, 'move'), '2026-10-10');
  assert.equal(d.status, 'done');
  assert.equal(d.score, null);
  assert.equal(warn(b, 'score-invalid'), 1);
});

test('R136 a Score of null gives no score and no score-invalid', () => {
  resetNumbers();
  const b = scoredBoard([[ci('2026-10-10'), null]]);
  assert.equal(dayOf(habitOf(b, 'move'), '2026-10-10').score, null);
  assert.equal(warn(b, 'score-invalid'), 0);
});

test('R136 scores 7, 11 and null together: 7, none with score-invalid at 1, and none', () => {
  resetNumbers();
  const b = scoredBoard([[ci('2026-10-08'), 7], [ci('2026-10-09'), 11], [ci('2026-10-10'), null]]);
  const h = habitOf(b, 'move');
  assert.equal(dayOf(h, '2026-10-08').score, 7);
  assert.equal(dayOf(h, '2026-10-09').score, null);
  assert.equal(dayOf(h, '2026-10-10').score, null);
  assert.equal(warn(b, 'score-invalid'), 1);
});

test('R136 a Score below min and a Score that is not a number are ignored; the second adds to score-invalid', () => {
  resetNumbers();
  const b = scoredBoard([[ci('2026-10-09'), 0], [ci('2026-10-10'), 'seven']], { habit: { score: { min: 1, max: 10 } } });
  const h = habitOf(b, 'move');
  assert.equal(dayOf(h, '2026-10-09').score, null);
  assert.equal(dayOf(h, '2026-10-10').score, null);
  assert.ok(warn(b, 'score-invalid') >= 1);
});

test('R136 a check-in that is not an item of the Habits Project has no score, without a warning', () => {
  resetNumbers();
  const c = ci('2026-10-10');
  const b = board({
    settings: settings({ habitsProject: PROJ, habits: [{ id: 'move', title: 'Move', start: '2026-09-29', score: { min: 1, max: 10 } }] }),
    raw: raw({ issues: [c], projects: [habitsRow([])] }),
  });
  const d = dayOf(habitOf(b, 'move'), '2026-10-10');
  assert.equal(d.status, 'done');
  assert.equal(d.score, null);
  assert.equal(warn(b, 'score-invalid'), 0);
});

test('R136 a scored habit with no Habits Project row in the read has done days with no score and no warning', () => {
  resetNumbers();
  const b = board({
    settings: settings({ habitsProject: PROJ, habits: [{ id: 'move', title: 'Move', start: '2026-09-29', score: { min: 1, max: 10 } }] }),
    raw: raw({ issues: [ci('2026-10-10')] }),
  });
  assert.equal(dayOf(habitOf(b, 'move'), '2026-10-10').score, null);
  assert.equal(warn(b, 'score-invalid'), 0);
});

test('R136 the Habits Project is never a shown project', () => {
  resetNumbers();
  const b = scoredBoard([[ci('2026-10-10'), 5]]);
  assert.equal(b.projects.length, 0);
  assert.ok(!JSON.stringify(b.sortTargets ?? []).includes('Habits log'));
});

// ---------- R137 ----------

test('R137 two closed check-ins for one day scored 6 then 8 (the later updated): the day is done with score 8', () => {
  resetNumbers();
  const a = ci('2026-10-10', { updated: '2026-10-10T09:00:00Z' });
  const c = ci('2026-10-10', { updated: '2026-10-10T12:00:00Z' });
  const b = scoredBoard([[a, 6], [c, 8]]);
  const d = dayOf(habitOf(b, 'move'), '2026-10-10');
  assert.equal(d.status, 'done');
  assert.equal(d.score, 8);
});

test('R137 the latest-updated wins by updated_at, not by order or number: swapped scores give 6', () => {
  resetNumbers();
  const a = ci('2026-10-10', { updated: '2026-10-10T09:00:00Z' });
  const c = ci('2026-10-10', { updated: '2026-10-10T12:00:00Z' });
  const b = scoredBoard([[c, 6], [a, 8]]);
  assert.equal(dayOf(habitOf(b, 'move'), '2026-10-10').score, 6);
});

test('R137 the later-updated check-in having no score gives the day no score, even if an earlier one has one', () => {
  resetNumbers();
  const a = ci('2026-10-10', { updated: '2026-10-10T09:00:00Z' });
  const c = ci('2026-10-10', { updated: '2026-10-10T12:00:00Z' });
  const b = scoredBoard([[a, 6], [c, null]]);
  assert.equal(dayOf(habitOf(b, 'move'), '2026-10-10').score, null);
});

test('R137 with equal updated times the higher number wins', () => {
  resetNumbers();
  const a = ci('2026-10-10', { updated: '2026-10-10T09:00:00Z' });
  const c = ci('2026-10-10', { updated: '2026-10-10T09:00:00Z' });
  assert.ok(c.number > a.number);
  const b = scoredBoard([[a, 3], [c, 9]]);
  assert.equal(dayOf(habitOf(b, 'move'), '2026-10-10').score, 9);
});

test('R137 an open check-in does not make the day done and carries no score into it', () => {
  resetNumbers();
  const open = checkin('move', '2026-10-10', { closed: false });
  const b = scoredBoard([[open, 9]]);
  const d = dayOf(habitOf(b, 'move'), '2026-10-10');
  assert.notEqual(d.status, 'done');
  assert.equal(d.score, null);
});

test('R137 the habit carries score { min, max, today }; today is today\'s score or null', () => {
  resetNumbers();
  const done = scoredBoard([[ci(TODAY, { closedAt: '2026-10-12T05:00:00Z' }), 8]]);
  assert.deepEqual(habitOf(done, 'move').score, { min: 1, max: 10, today: 8 });
  resetNumbers();
  const none = scoredBoard([[ci('2026-10-10'), 8]]);
  assert.deepEqual(habitOf(none, 'move').score, { min: 1, max: 10, today: null });
});

// ---------- R139 ----------

test('R139 every recent entry of a scored habit has a score key (a number or null); a tick habit has none', () => {
  resetNumbers();
  const c = ci('2026-10-10');
  const t = ci('2026-10-10', { id: 'read' });
  const b = board({
    settings: settings({
      habitsProject: PROJ,
      habits: [
        { id: 'move', title: 'Move', start: '2026-09-29', score: { min: 1, max: 10 } },
        { id: 'read', title: 'Read', start: '2026-09-29' },
      ],
    }),
    raw: raw({ issues: [c, t], projects: [habitsRow([hitem(c, 4)])] }),
  });
  const scored = habitOf(b, 'move');
  const tick = habitOf(b, 'read');
  assert.equal(scored.recent.length, 14);
  for (const e of scored.recent) {
    assert.ok(Object.hasOwn(e, 'score'), 'score key on ' + e.date);
    assert.ok(e.score === null || typeof e.score === 'number');
  }
  assert.equal(dayOf(scored, '2026-10-10').score, 4);
  assert.equal(dayOf(scored, '2026-10-11').score, null, 'a day that is not done has score null');
  for (const e of tick.recent) assert.equal(Object.hasOwn(e, 'score'), false, 'no score on tick ' + e.date);
  assert.equal(Object.hasOwn(tick, 'score'), false, 'a tick habit has no score key');
});

// ---------- R36 / settings ----------

test('R36 a habit with score and a habit without keep settings order; only the first has score', () => {
  resetNumbers();
  const b = board({
    settings: settings({
      habitsProject: PROJ,
      habits: [
        { id: 'read', title: 'Read', start: '2026-10-09' },
        { id: 'move', title: 'Move', start: '2026-10-09', score: { min: 2, max: 5 } },
      ],
    }),
    raw: raw({ issues: [], projects: [habitsRow([])] }),
  });
  assert.deepEqual(b.habits.map((h) => h.id), ['read', 'move']);
  assert.equal(Object.hasOwn(habitOf(b, 'read'), 'score'), false);
  assert.deepEqual(habitOf(b, 'move').score, { min: 2, max: 5, today: null });
  assert.equal(warn(b, 'setting-invalid'), 0);
});

for (const [label, bad] of [
  ['min 0', { min: 0, max: 5 }],
  ['min equal to max', { min: 5, max: 5 }],
  ['max 11', { min: 1, max: 11 }],
  ['min above max', { min: 6, max: 3 }],
  ['a fractional min', { min: 1.5, max: 4 }],
  ['a string', 'high'],
  ['no max', { min: 1 }],
]) {
  test(`R36 a bad habits[].score (${label}) makes a tick habit and adds one to setting-invalid`, () => {
    resetNumbers();
    const b = board({
      settings: settings({ habitsProject: PROJ, habits: [{ id: 'move', title: 'Move', start: '2026-10-09', score: bad }] }),
      raw: raw({ issues: [], projects: [habitsRow([])] }),
    });
    const h = habitOf(b, 'move');
    assert.equal(Object.hasOwn(h, 'score'), false, 'no score key on the habit');
    for (const e of h.recent) assert.equal(Object.hasOwn(e, 'score'), false);
    assert.equal(warn(b, 'setting-invalid'), 1);
  });
}

test('R36 a valid score without habitsProject makes a tick habit and adds one to setting-invalid', () => {
  resetNumbers();
  const b = board({
    settings: settings({ habits: [{ id: 'move', title: 'Move', start: '2026-10-09', score: { min: 1, max: 10 } }] }),
    raw: raw({ issues: [] }),
  });
  const h = habitOf(b, 'move');
  assert.equal(Object.hasOwn(h, 'score'), false);
  for (const e of h.recent) assert.equal(Object.hasOwn(e, 'score'), false);
  assert.equal(warn(b, 'setting-invalid'), 1);
});

test('R36 the boundary scores 1..2 and 9..10 are valid settings', () => {
  resetNumbers();
  for (const sc of [{ min: 1, max: 2 }, { min: 9, max: 10 }, { min: 1, max: 10 }]) {
    const b = board({
      settings: settings({ habitsProject: PROJ, habits: [{ id: 'move', title: 'Move', start: '2026-10-09', score: sc }] }),
      raw: raw({ issues: [], projects: [habitsRow([])] }),
    });
    assert.deepEqual(habitOf(b, 'move').score, { ...sc, today: null });
    assert.equal(warn(b, 'setting-invalid'), 0);
  }
});

// ---------- R138 ----------

test('R138 scores 2, 5, 7 and 9 give day--s1, day--s2, day--s3 and day--s4 on the page, with title, sr-only text and tabindex', () => {
  resetNumbers();
  const dates = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  const scores = [2, 5, 7, 9];
  const b = scoredBoard(dates.map((d, i) => [ci(d), scores[i]]));
  const html = render(b);
  const tags = [...html.matchAll(/<[a-z]+\b[^>]*\bday--s(\d)\b[^>]*>/g)];
  assert.equal(tags.length, 4, 'four shaded days');
  const levels = tags.map((m) => Number(m[1])).sort();
  assert.deepEqual(levels, [1, 2, 3, 4]);
  scores.forEach((s, i) => {
    const level = [1, 2, 3, 4][i];
    const tag = tags.find((m) => Number(m[1]) === level)[0];
    assert.match(tag, /\bday--done\b/, 'level ' + level + ' is a done day');
    assert.ok(tag.includes(`score ${s}`), `title carries "score ${s}": ${tag}`);
    assert.ok(tag.includes(dates[i]), 'title carries the date');
    assert.match(tag, /\btitle="/);
    assert.match(tag, /\btabindex="0"/);
    assert.ok(html.includes(`<span class="sr-only">score ${s}</span>`), `sr-only text for ${s}`);
  });
});

test('R138 the level boundaries: 1,3 -> s1; 4,5 -> s2; 6,7 -> s3; 8,10 -> s4', () => {
  resetNumbers();
  const table = [[1, 1], [3, 1], [4, 2], [5, 2], [6, 3], [7, 3], [8, 4], [10, 4]];
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
  const b = scoredBoard(dates.map((d, i) => [ci(d), table[i][0]]));
  const html = render(b);
  table.forEach(([s, level], i) => {
    const tag = [...html.matchAll(/<[a-z]+\b[^>]*\bday--s\d\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(dates[i]));
    assert.ok(tag, 'a shaded day for ' + dates[i]);
    assert.match(tag, new RegExp('\\bday--s' + level + '\\b'), `score ${s} -> level ${level}`);
  });
});

test('R138 a done day with no score, and a tick habit\'s done days, carry no day--s class', () => {
  resetNumbers();
  const unscored = scoredBoard([[ci('2026-10-10'), null]]);
  assert.ok(!/day--s\d/.test(render(unscored).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')));
  resetNumbers();
  const tick = board({
    settings: settings({ habits: [{ id: 'move', title: 'Move', start: '2026-09-29' }] }),
    raw: raw({ issues: [ci('2026-10-10')] }),
  });
  assert.ok(!/day--s\d/.test(render(tick).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')));
});

test('R138 the score is shown through title and hidden text only: no script on the page carries it', () => {
  resetNumbers();
  const b = scoredBoard([[ci('2026-10-10'), 7]]);
  const html = render(b);
  assert.ok(!/<script\b/i.test(html) || !/score 7/.test([...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]).join('')));
});

// ---------- R57 / R58 page part ----------

function twoHabitBoard() {
  resetNumbers();
  const c = ci('2026-10-10');
  return board({
    settings: settings({
      habitsProject: PROJ,
      habits: [
        { id: 'move', title: 'Move', start: '2026-09-29', score: { min: 1, max: 10 } },
        { id: 'read', title: 'Read', start: '2026-09-29' },
      ],
    }),
    raw: raw({ issues: [c], projects: [habitsRow([hitem(c, 6)])] }),
  });
}

test('R57 a scored habit has no tick form, while a tick habit beside it keeps its own', () => {
  const html = render(twoHabitBoard());
  const habitForms = forms(html).filter((f) => attr(formTag(f), 'action') === '/actions/habit');
  assert.ok(habitForms.some((f) => f.includes('tok-habit-read:' + TODAY)), 'the tick habit keeps its form');
  assert.ok(!habitForms.some((f) => f.includes('move:' + TODAY)), 'no tick or untick form for the scored habit');
});

test('R58 a scored habit that is done today shows no untick form either', () => {
  resetNumbers();
  const c = ci(TODAY, { closedAt: '2026-10-12T05:00:00Z' });
  const b = board({
    settings: settings({ habitsProject: PROJ, habits: [{ id: 'move', title: 'Move', start: '2026-09-29', score: { min: 1, max: 10 } }] }),
    raw: raw({ issues: [c], projects: [habitsRow([hitem(c, 6)])] }),
  });
  const html = render(b);
  assert.ok(!forms(html).some((f) => attr(formTag(f), 'action') === '/actions/habit'), 'no habit form at all');
  assert.ok(!/tok-habit-move:[^"]*:(on|off)/.test(html));
});

test('R57 a scored habit has a score form posting a score field to /actions/score, with the token for <id>:<today>:score', () => {
  const html = render(twoHabitBoard());
  const sf = forms(html).filter((f) => attr(formTag(f), 'action') === '/actions/score');
  assert.equal(sf.length, 1, 'one score form (for the one scored habit)');
  assert.equal((attr(formTag(sf[0]), 'method') || '').toLowerCase(), 'post');
  assert.match(sf[0], /\bname="score"/, 'posts a field named score');
  assert.ok(sf[0].includes('tok-score-move:' + TODAY + ':score'), 'token target is <id>:<date>:score');
  assert.ok(sf[0].includes('aria-label="Score for Move"'), 'the select is labelled');
  for (const n of [1, 5, 10]) assert.match(sf[0], new RegExp('<option[^>]*value="' + n + '"'));
  assert.ok(!/<option[^>]*value="11"/.test(sf[0]));
});

test('R57 the score form preselects today\'s score when the day is already scored', () => {
  resetNumbers();
  const c = ci(TODAY, { closedAt: '2026-10-12T05:00:00Z' });
  const b = board({
    settings: settings({ habitsProject: PROJ, habits: [{ id: 'move', title: 'Move', start: '2026-09-29', score: { min: 1, max: 10 } }] }),
    raw: raw({ issues: [c], projects: [habitsRow([hitem(c, 6)])] }),
  });
  const sf = forms(render(b)).find((f) => attr(formTag(f), 'action') === '/actions/score');
  assert.ok(sf);
  assert.match(sf, /<option[^>]*value="6"[^>]*selected/);
});

test('R57 a tick-habit-only board has no /actions/score form and no day--s class', () => {
  resetNumbers();
  const b = board({
    settings: settings({ habits: [{ id: 'move', title: 'Move', start: '2026-09-29' }] }),
    raw: raw({ issues: [ci('2026-10-10')] }),
  });
  const html = render(b);
  assert.ok(!html.includes('/actions/score'));
  assert.ok(forms(html).some((f) => attr(formTag(f), 'action') === '/actions/habit'));
});

// ---------- R91 ----------

test('R91 with a scored habit, every form on the page posts to one of the five action paths and the score form is among them', () => {
  const html = render(twoHabitBoard());
  const all = forms(html);
  assert.ok(all.length > 0);
  assert.equal(all.length, (html.match(/<form\b/gi) ?? []).length, 'every <form has a closing </form>');
  const PATHS = ['/actions/idea', '/actions/habit', '/actions/sort', '/actions/close', '/actions/score'];
  const seen = new Set();
  for (const f of all) {
    const tag = formTag(f);
    assert.equal((attr(tag, 'method') || '').toLowerCase(), 'post', tag);
    const action = attr(tag, 'action');
    assert.ok(PATHS.includes(action), 'action ' + action);
    seen.add(action);
  }
  assert.ok(seen.has('/actions/score'));
  assert.ok(seen.has('/actions/habit'));
});
