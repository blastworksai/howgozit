// Review follow-ups: read-only Sort box, seat without a project, event past midnight,
// unreadable idea times, dot-only owner and repo names, script takes over style rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { layoutDay } from '../board/render/cal-layout.mjs';
import { validateProposal } from '../scripts/lib/apply.mjs';
import { board, raw, idea } from '../fixtures/build.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const FULL = JSON.parse(readFileSync(here('../fixtures/board/page.board.json'), 'utf8'));
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const render = (b) => renderPage(b, THEME, OPTS);
const copy = (b) => JSON.parse(JSON.stringify(b));

function proposal() {
  return {
    owner: 'sam-life',
    repo: 'life',
    name: 'Sam',
    timezone: 'Europe/Brussels',
    projects: [{ key: 'house', title: 'House', tasks: [{ title: 'Pick a colour' }] }],
    standalone: [{ title: 'Renew passport' }],
    habits: [{ id: 'read', title: 'Read' }],
    focus: ['house'],
  };
}

test('R63 a read-only page has no Sort box at all', () => {
  const b = copy(FULL);
  assert.ok(b.ideas.items.length > 0 && b.sortTargets.length > 0, 'fixture has ideas and sort targets');
  b.meta.readOnly = true;
  const html = render(b);
  assert.ok(!/<details\b[^>]*\bsort\b/.test(html), 'no details element of class sort');
  assert.ok(!html.includes('<details class="ac-i sort"'));
});

test('R63 the same board not read-only has a Sort box with a form inside', () => {
  const b = copy(FULL);
  b.meta.readOnly = false;
  const html = render(b);
  const i = html.indexOf('<details class="ac-i sort"');
  assert.ok(i >= 0, 'sort box present as <details class="ac-i sort"> (E2)');
  const end = html.indexOf('</details>', i);
  const box = html.slice(i, end);
  assert.match(box, /<form\b/);
  assert.ok(box.includes('<summary class="b sm"><span class="b-f"><span class="b-n"></span><i class="ac-m"></i>Sort</span></summary><div class="ac-p sort__form">'), 'the summary is a small key (part map D14, E2)');
});

test('U a seat without a project does not break the page', () => {
  const b = copy(FULL);
  b.meta.readOnly = false;
  b.next[0].project = null;
  let html;
  assert.doesNotThrow(() => { html = render(b); });
  assert.ok(html.includes(b.next[0].title.replace(/&/g, '&amp;')), 'seat title on the page');
});

test('U a seat with its project carries the pc-<key> class', () => {
  const b = copy(FULL);
  const key = b.next[0].project.key;
  const html = render(b);
  assert.match(html, new RegExp('<li class="ls-r seat [^"]*\\bpc-' + key + '\\b'));
});

test('U an event that ends after midnight runs to the end of the day', () => {
  const late = layoutDay([{ start: '23:00', end: '01:00' }]);
  const ref = layoutDay([{ start: '23:00', end: '24:00' }]);
  assert.equal(late.endHour, 24);
  assert.equal(ref.endHour, 24);
  assert.equal(late.items[0].height, ref.items[0].height);
  assert.equal(late.items[0].short, false);
  assert.equal(ref.items[0].short, false);
});

test('U an event with equal start and end keeps the 30-minute minimum box', () => {
  const r = layoutDay([{ start: '10:00', end: '10:00' }]);
  const span = (r.endHour - r.startHour) * 60;
  assert.equal(r.items[0].height, Math.round((30 / span) * 1000) / 10);
  assert.equal(r.items[0].short, true);
});

test('R32 ideas with an unreadable creation time count as oldest, ties by higher number', () => {
  const issues = [
    idea({ number: 5, created_at: '2026-10-01T10:00:00Z' }),
    idea({ number: 7, created_at: 'not a date' }),
    idea({ number: 9, created_at: 'not a date' }),
  ];
  const b = board({ raw: raw({ issues }) });
  assert.equal(b.ideas.count, 3);
  assert.deepEqual(b.ideas.items.map((i) => i.number), [5, 9, 7]);
});

test('U an owner made only of dots is refused and named', () => {
  const p = proposal();
  p.owner = '..';
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('owner')), v.errors.join(' | '));
});

test('U a repo made only of dots is refused and named', () => {
  const p = proposal();
  p.repo = '.';
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('repo')), v.errors.join(' | '));
});

test('U an owner and repo with dots inside are fine', () => {
  const p = proposal();
  p.owner = 'my.org';
  p.repo = 'board-data.v2';
  assert.deepEqual(validateProposal(p), { ok: true, errors: [] });
});

test('R95 the script copies the fetched head style block into the page own', () => {
  const src = readFileSync(here('../board/static/board.js'), 'utf8');
  const hits = src.match(/querySelector\(\s*['"]head style['"]\s*\)/g) || [];
  assert.ok(hits.length >= 1, 'the page own head style block is read, found ' + hits.length);
  assert.match(src, /\.textContent\s*=/);
  assert.match(src, /\/<style/, 'the fetched text has its style block taken out by a regular expression');
});

test('U calendar card: four overlapping events carry the classes cal-lane-1of4 to cal-lane-4of4', () => {
  const b = copy(FULL);
  b.panels.calendar.events = Array.from({ length: 4 }, (_, i) => ({ title: 'Block ' + (i + 1), start: '10:00', end: '11:00', kind: 'meeting' }));
  const html = render(b);
  const count = (s, re) => (s.match(re) || []).length;
  const style = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i)[1];
  const body = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/i, '');
  // exactly one element carries each lane class (counted in class attributes outside the style block) ...
  const classAttrs = [...body.matchAll(/\sclass="([^"]*)"/g)].map((m) => m[1].split(/\s+/));
  for (let n = 1; n <= 4; n++) {
    assert.equal(classAttrs.filter((c) => c.includes('cal-lane-' + n + 'of4')).length, 1, 'one element with cal-lane-' + n + 'of4');
    // ... and the nonce block holds exactly one rule for it
    assert.equal(count(style, new RegExp('\\.cal-event\\.cal-lane-' + n + 'of4\\{', 'g')), 1, 'one rule for cal-lane-' + n + 'of4');
  }
  assert.equal(count(body, /cal-lane-/g), 4, 'no other lane class outside the style block');
  assert.equal(count(html, /cal-lane-3of3/g), 0);
});

test('R178 the stylesheet holds no lane rule: the lane rules live in the page\'s nonce block', () => {
  const css = readFileSync(here('../board/static/board.css'), 'utf8');
  assert.equal((css.match(/\.cal-lane-\d+of\d+/g) || []).length, 0, 'no .cal-lane-<i>of<n> in board.css');
});

const nonce = (html) => html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i)?.[1] ?? '';
const laneRulesOf = (html) => nonce(html).match(/\.cal-event\.cal-lane-\d+of\d+\{[^}]*\}/g) || [];
const eventsAt = (n, start = '10:00', end = '11:00') => Array.from({ length: n }, (_, i) => ({ title: 'Block ' + (i + 1), start, end, kind: 'meeting' }));
function calPage(events) {
  const b = copy(FULL);
  b.panels.calendar.events = events;
  return render(b);
}
const laneClasses = (html) => [...new Set(html.match(/cal-lane-\d+of\d+/g) || [])].sort();

test('R178 five simultaneous events: five classes and exactly the five rules, first lane left:0', () => {
  const html = calPage(eventsAt(5));
  assert.deepEqual(laneClasses(html), ['cal-lane-1of5', 'cal-lane-2of5', 'cal-lane-3of5', 'cal-lane-4of5', 'cal-lane-5of5']);
  assert.deepEqual(laneRulesOf(html), [
    '.cal-event.cal-lane-1of5{left:0;width:20%}',
    '.cal-event.cal-lane-2of5{left:20%;width:20%}',
    '.cal-event.cal-lane-3of5{left:40%;width:20%}',
    '.cal-event.cal-lane-4of5{left:60%;width:20%}',
    '.cal-event.cal-lane-5of5{left:80%;width:20%}',
  ]);
});

test('R178 three events: lanes 2 and 3 are left:33.333% and left:66.667% with width:33.333%', () => {
  const rules = laneRulesOf(calPage(eventsAt(3)));
  assert.ok(rules.includes('.cal-event.cal-lane-1of3{left:0;width:33.333%}'));
  assert.ok(rules.includes('.cal-event.cal-lane-2of3{left:33.333%;width:33.333%}'));
  assert.ok(rules.includes('.cal-event.cal-lane-3of3{left:66.667%;width:33.333%}'));
  assert.equal(rules.length, 3);
});

test('R178 eight events: width:12.5% and left:87.5% for the last', () => {
  const rules = laneRulesOf(calPage(eventsAt(8)));
  assert.equal(rules.length, 8);
  assert.ok(rules.includes('.cal-event.cal-lane-8of8{left:87.5%;width:12.5%}'));
  assert.ok(rules.includes('.cal-event.cal-lane-1of8{left:0;width:12.5%}'));
});

test('R178 nine simultaneous events: lanes 1of8 to 8of8 and the ninth carries cal-lane-8of8', () => {
  const html = calPage(eventsAt(9));
  assert.deepEqual(laneClasses(html), [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 'cal-lane-' + i + 'of8'));
  assert.equal((html.match(/cal-lane-8of8(?![0-9])/g) || []).length, 3, 'two events share lane 8 (class on each, plus its one rule)');
  assert.equal(laneRulesOf(html).length, 8);
});

test('R178 n counts lanes, not events: A and B overlap, C overlaps only B but fits A\'s lane, so all three are of2', () => {
  const html = calPage([
    { title: 'A', start: '10:00', end: '11:00', kind: 'meeting' },
    { title: 'B', start: '10:30', end: '12:00', kind: 'meeting' },
    { title: 'C', start: '11:00', end: '12:30', kind: 'meeting' },
  ]);
  assert.deepEqual(laneClasses(html), ['cal-lane-1of2', 'cal-lane-2of2']);
  assert.equal((html.match(/class="cal-event [^"]*cal-lane-\d+of2/g) || []).length, 3);
  assert.equal(laneRulesOf(html).length, 2);
});

test('R178 events that only touch (one ends at 09:00, the next starts at 09:00) carry no lane class', () => {
  const html = calPage([
    { title: 'Early', start: '08:00', end: '09:00', kind: 'meeting' },
    { title: 'Later', start: '09:00', end: '10:00', kind: 'meeting' },
  ]);
  assert.equal(laneClasses(html).length, 0);
  assert.equal(laneRulesOf(html).length, 0);
});

test('R178 events that do not overlap carry no lane class and the nonce block holds no lane rule', () => {
  const html = calPage([
    { title: 'One', start: '09:00', end: '10:00', kind: 'meeting' },
    { title: 'Two', start: '11:00', end: '12:00', kind: 'meeting' },
  ]);
  assert.ok(html.includes('One') && html.includes('Two'));
  assert.equal((html.match(/cal-lane-/g) || []).length, 0);
});

test('R178 only the lane classes a page uses get a rule, once each', () => {
  const html = calPage(eventsAt(2));
  assert.deepEqual(laneRulesOf(html), ['.cal-event.cal-lane-1of2{left:0;width:50%}', '.cal-event.cal-lane-2of2{left:50%;width:50%}']);
});

test('R178 a window of 07:00 to 19:00 gives <div class="cal-body cal-h-12"> and exactly one .cal-h-12 rule', () => {
  const html = calPage([{ title: 'Standup', start: '09:00', end: '09:30', kind: 'meeting' }]);
  assert.equal((html.match(/<div class="cal-body cal-h-12">/g) || []).length, 1);
  const rule = '.cal-h-12{height:calc(var(--cal-hour) * 12)}';
  assert.equal(nonce(html).split(rule).length - 1, 1);
  assert.equal((nonce(html).match(/\.cal-h-\d+\{/g) || []).length, 1);
  assert.match(html, /<div class="cal-day"><div class="cal-hours" aria-hidden="true">/);
});

test('R178 an event at 21:00 widens the window to 07:00 to 22:00: cal-h-15 and its rule', () => {
  const html = calPage([{ title: 'Late', start: '21:00', end: '22:00', kind: 'meeting' }]);
  assert.ok(html.includes('<div class="cal-body cal-h-15">'));
  assert.ok(nonce(html).includes('.cal-h-15{height:calc(var(--cal-hour) * 15)}'));
  assert.ok(!html.includes('cal-h-12'));
});

test('R178 a calendar with no timed event has no day body, no cal-h- class and no .cal-h- rule', () => {
  const html = calPage([]);
  assert.ok(!html.includes('cal-body'));
  assert.ok(!html.includes('cal-h-'));
});

test('R95 the script has no eval and no innerHTML', () => {
  const src = readFileSync(here('../board/static/board.js'), 'utf8');
  assert.ok(!/\beval\s*\(/.test(src));
  assert.ok(!/innerHTML/.test(src));
});
