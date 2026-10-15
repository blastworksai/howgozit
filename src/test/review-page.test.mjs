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
  assert.ok(!render(b).includes('<details class="sort"'));
});

test('R63 the same board not read-only has a Sort box with a form inside', () => {
  const b = copy(FULL);
  b.meta.readOnly = false;
  const html = render(b);
  const i = html.indexOf('<details class="sort"');
  assert.ok(i >= 0, 'sort box present');
  const end = html.indexOf('</details>', i);
  assert.match(html.slice(i, end), /<form\b/);
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
  assert.match(html, new RegExp('class="seat [^"]*\\bpc-' + key + '\\b'));
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
  const count = (re) => (html.match(re) || []).length;
  for (let n = 1; n <= 4; n++) assert.equal(count(new RegExp('cal-lane-' + n + 'of4(?![0-9])', 'g')), 1, 'cal-lane-' + n + 'of4');
  assert.equal(count(/cal-lane-3of3/g), 0);
});

test('U stylesheet: every calendar lane class up to eight columns has a rule', () => {
  const css = readFileSync(here('../board/static/board.css'), 'utf8');
  for (let m = 2; m <= 8; m++) {
    for (let n = 1; n <= m; n++) {
      assert.match(css, new RegExp('\\.cal-lane-' + n + 'of' + m + '\\s*\\{'), '.cal-lane-' + n + 'of' + m);
    }
  }
});

test('R95 the script has no eval and no innerHTML', () => {
  const src = readFileSync(here('../board/static/board.js'), 'utf8');
  assert.ok(!/\beval\s*\(/.test(src));
  assert.ok(!/innerHTML/.test(src));
});
