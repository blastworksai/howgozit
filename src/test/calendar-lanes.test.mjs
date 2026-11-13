// Tests of R178 (simultaneous calendar events share the width of the day, side by side),
// written from the contract text and PART-MAP D7 only, not from any implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const THEME = resolveTheme(null).theme;
const NONCE = 'lanesnonce';
const OPTS = { styleNonce: NONCE, formToken: (action, target) => 'tok-' + action + '-' + target };
const TODAY = '2026-10-12';
const copy = (v) => JSON.parse(JSON.stringify(v));

const ev = (title, start, end, kind = 'meeting') => ({ title, start, end, kind });
const same = (n, start = '09:00', end = '10:00') => Array.from({ length: n }, (_, i) => ev('Event ' + (i + 1), start, end));

function pageHtml(events) {
  const b = copy(JSON.parse(readFileSync(here('../fixtures/board/page.board.json'), 'utf8')));
  b.panels.calendar = { stale: false, date: TODAY, now: '08:10', events: copy(events) };
  return renderPage(b, THEME, OPTS);
}

// The calendar section of a page, from its opening tag to the next section (or the end).
function calendarSection(html) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ name: m[1], start: html.lastIndexOf('<', m.index) }));
  const i = marks.findIndex((m) => m.name === 'calendar');
  assert.ok(i >= 0, 'the page has no calendar section');
  return html.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].start : html.length);
}

// The class lists of the event elements of the calendar section, in page order.
function eventClasses(html) {
  return [...calendarSection(html).matchAll(/<div class="([^"]*\bcal-event\b[^"]*)"/g)].map((m) => m[1].split(/\s+/));
}
const laneClassOf = (classes) => classes.filter((c) => /^cal-lane-/.test(c));

// The text of every nonce style element of the page, joined.
function nonceBlock(html) {
  const re = new RegExp('<style\\b[^>]*\\bnonce="' + NONCE + '"[^>]*>([\\s\\S]*?)</style>', 'gi');
  return [...html.matchAll(re)].map((m) => m[1]).join('\n');
}

// Every lane rule of the nonce block, in the one form the contract writes:
// `.cal-event.cal-lane-<i>of<n>{left:<L>;width:<W>%}`. Any other rule that names a lane class fails the test.
function laneRules(html) {
  const out = [];
  for (const m of nonceBlock(html).matchAll(/([^{}]*\.cal-lane-[^{}]*)\{([^{}]*)\}/g)) {
    const whole = m[1].trim() + '{' + m[2] + '}';
    const f = whole.match(/^\.cal-event\.cal-lane-(\d+)of(\d+)\{left:([^;{}%]+%?);width:([^;{}%]+)%\}$/);
    assert.ok(f, 'a lane rule not in the contract form: ' + whole);
    out.push({ cls: 'cal-lane-' + f[1] + 'of' + f[2], i: Number(f[1]), n: Number(f[2]), left: f[3], width: f[4] });
  }
  return out;
}

// A number as the contract writes it: at most three decimals, no trailing zeros.
function plainNumber(s, what) {
  assert.match(s, /^\d+(?:\.\d{1,3})?$/, what + ' is not a plain number of at most three decimals: ' + s);
  assert.ok(!/\.\d*0$/.test(s), what + ' keeps a trailing zero: ' + s);
  return s;
}

// The rule for lane i of n: left and width as the plain numbers; the first lane's left is `0` with no percent sign, the others end in %.
function ruleFor(rules, i, n) {
  const found = rules.filter((r) => r.cls === 'cal-lane-' + i + 'of' + n);
  assert.equal(found.length, 1, 'expected exactly one rule for cal-lane-' + i + 'of' + n + ', found ' + found.length);
  const r = found[0];
  if (i === 1) assert.equal(r.left, '0', 'the first lane is left:0 without a percent sign: ' + r.left);
  else assert.ok(r.left.endsWith('%'), 'left of lane ' + i + ' has no percent sign: ' + r.left);
  return { left: plainNumber(r.left.replace(/%$/, ''), 'left of ' + r.cls), width: plainNumber(r.width, 'width of ' + r.cls) };
}

// The nonce block's height rules: [{ n, text }], and the day body classes of the calendar section.
const heightRules = (html) => [...nonceBlock(html).matchAll(/\.cal-h-(\d+)\s*\{([^{}]*)\}/g)].map((m) => ({ n: Number(m[1]), text: '.cal-h-' + m[1] + '{' + m[2] + '}' }));
const bodyClasses = (html) => [...calendarSection(html).matchAll(/<div class="(cal-body[^"]*)"/g)].map((m) => m[1]);

test('R178 five events at the same time carry cal-lane-1of5 to cal-lane-5of5, one each, in order', () => {
  const html = pageHtml(same(5));
  const lanes = eventClasses(html).map(laneClassOf);
  assert.deepEqual(lanes, [1, 2, 3, 4, 5].map((i) => ['cal-lane-' + i + 'of5']));
});

test('R178 five events at the same time: the nonce block holds five rules, width 20% and left 0, 20, 40, 60, 80', () => {
  const html = pageHtml(same(5));
  const rules = laneRules(html);
  assert.equal(rules.length, 5, 'one rule for each lane class the page uses');
  const got = [1, 2, 3, 4, 5].map((i) => ruleFor(rules, i, 5));
  assert.deepEqual(got.map((r) => r.width), ['20', '20', '20', '20', '20']);
  assert.deepEqual(got.map((r) => r.left), ['0', '20', '40', '60', '80']);
});

test('R178 three events at the same time: lanes 1of3 to 3of3, width 33.333%, the second at left 33.333%', () => {
  const html = pageHtml(same(3));
  assert.deepEqual(eventClasses(html).map(laneClassOf), [1, 2, 3].map((i) => ['cal-lane-' + i + 'of3']));
  const rules = laneRules(html);
  assert.equal(rules.length, 3);
  const got = [1, 2, 3].map((i) => ruleFor(rules, i, 3));
  assert.deepEqual(got.map((r) => r.width), ['33.333', '33.333', '33.333']);
  assert.equal(got[1].left, '33.333');
  assert.deepEqual(got.map((r) => r.left), ['0', '33.333', '66.667']);
});

test('R178 two events at the same time split the width in halves', () => {
  const html = pageHtml(same(2));
  const rules = laneRules(html);
  assert.equal(rules.length, 2);
  assert.deepEqual([1, 2].map((i) => ruleFor(rules, i, 2)), [{ left: '0', width: '50' }, { left: '50', width: '50' }]);
});

test('R178 eight events at the same time: width 12.5% and left 0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5', () => {
  const html = pageHtml(same(8));
  assert.deepEqual(eventClasses(html).map(laneClassOf), [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ['cal-lane-' + i + 'of8']));
  const rules = laneRules(html);
  assert.equal(rules.length, 8);
  const got = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ruleFor(rules, i, 8));
  assert.ok(got.every((r) => r.width === '12.5'), JSON.stringify(got));
  assert.deepEqual(got.map((r) => r.left), ['0', '12.5', '25', '37.5', '50', '62.5', '75', '87.5']);
});

test('R178 nine simultaneous events take lanes 1of8 to 8of8 and the ninth carries cal-lane-8of8', () => {
  const html = pageHtml(same(9));
  const used = eventClasses(html).map(laneClassOf);
  assert.deepEqual(used, [1, 2, 3, 4, 5, 6, 7, 8, 8].map((i) => ['cal-lane-' + i + 'of8']));
  const rules = laneRules(html);
  assert.equal(rules.length, 8, 'one rule for each lane class used, none above 8');
  assert.equal(ruleFor(rules, 1, 8).width, '12.5');
  assert.equal(ruleFor(rules, 8, 8).left, '87.5');
});

test('R178 two overlapping events and a third that overlaps only one and can share the first lane: n is 2 for all three', () => {
  const html = pageHtml([ev('A', '09:00', '11:00'), ev('B', '09:00', '09:30'), ev('C', '09:30', '10:00')]);
  assert.deepEqual(eventClasses(html).map(laneClassOf), [['cal-lane-1of2'], ['cal-lane-2of2'], ['cal-lane-2of2']]);
  assert.equal(laneRules(html).length, 2);
});

test('R178 one event ending at 09:00 and another starting at 09:00 carry no lane class', () => {
  const html = pageHtml([ev('Before', '08:00', '09:00'), ev('After', '09:00', '10:00')]);
  assert.equal(eventClasses(html).length, 2);
  assert.equal(html.includes('cal-lane-'), false);
});

test('R178 events that do not overlap carry no cal-lane- class and the nonce block holds no lane rule', () => {
  const html = pageHtml([ev('Standup', '08:30', '08:45'), ev('Deep work', '09:00', '11:00'), ev('Review', '12:30', '13:30')]);
  assert.equal(eventClasses(html).length, 3, 'the three events are on the page');
  assert.equal(html.includes('cal-lane-'), false, 'no cal-lane- anywhere on the page');
  assert.equal(laneRules(html).length, 0);
});

test('R178 a single event has no lane class and no rule', () => {
  const html = pageHtml([ev('Alone', '09:00', '10:00')]);
  assert.equal(eventClasses(html).length, 1);
  assert.equal(html.includes('cal-lane-'), false);
  assert.equal(laneRules(html).length, 0);
});

test('R178 only the lane classes the page uses have a rule: three at once give 1of3 to 3of3 and nothing of 5', () => {
  const rules = laneRules(pageHtml(same(3)));
  assert.deepEqual(rules.map((r) => r.cls).sort(), ['cal-lane-1of3', 'cal-lane-2of3', 'cal-lane-3of3']);
});

test('R178 a day with a pair and a trio at different times: one rule for each class used, none repeated', () => {
  const events = [
    ...same(2, '08:00', '09:00'),
    ...same(3, '13:00', '14:00'),
    ev('Alone', '16:00', '17:00'),
  ];
  const html = pageHtml(events);
  const lanes = eventClasses(html).map(laneClassOf);
  assert.deepEqual(lanes, [['cal-lane-1of2'], ['cal-lane-2of2'], ['cal-lane-1of3'], ['cal-lane-2of3'], ['cal-lane-3of3'], []]);
  const rules = laneRules(html);
  assert.deepEqual(rules.map((r) => r.cls).sort(), ['cal-lane-1of2', 'cal-lane-1of3', 'cal-lane-2of2', 'cal-lane-2of3', 'cal-lane-3of3']);
});

test('R178 two clusters of the same size share their rules: two pairs give two rules, not four', () => {
  const html = pageHtml([...same(2, '08:00', '09:00'), ...same(2, '14:00', '15:00')]);
  assert.deepEqual(eventClasses(html).map(laneClassOf), [['cal-lane-1of2'], ['cal-lane-2of2'], ['cal-lane-1of2'], ['cal-lane-2of2']]);
  assert.equal(laneRules(html).length, 2);
});

test('R178 the lanes of a cluster touch edge to edge: each left plus width is the next left, the last ends at 100%', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    const rules = laneRules(pageHtml(same(n)));
    const got = Array.from({ length: n }, (_, k) => ruleFor(rules, k + 1, n));
    for (let k = 0; k < n; k++) {
      const edge = Number(got[k].left) + Number(got[k].width);
      const next = k + 1 < n ? Number(got[k + 1].left) : 100;
      assert.ok(Math.abs(edge - next) <= 0.002, `n=${n} lane ${k + 1}: edge ${edge} against ${next}`);
    }
    assert.equal(Number(got[0].left), 0, 'n=' + n + ' the first lane starts at 0');
  }
});

test('R178 the stylesheet holds no lane rule: board.css has no cal-lane- text at all', () => {
  const css = readFileSync(here('../board/static/board.css'), 'utf8');
  assert.equal(/cal-lane-/.test(css), false);
});

test('R178 a page with lanes has no style attribute, and its lane rules sit in the nonce block, not in a second style element', () => {
  const html = pageHtml(same(4));
  assert.equal((html.match(/style="/g) || []).length, 0);
  assert.equal((html.match(/<style\b/gi) || []).length, 1, 'one style element on the page');
  assert.equal(laneRules(html).length, 4);
});

test('R178 the day body is cal-body cal-h-12 for a 07:00 to 19:00 window, with exactly one .cal-h-12 rule in the nonce block', () => {
  const html = pageHtml([ev('Standup', '08:30', '08:45'), ev('Deep work', '09:00', '11:00')]);
  assert.deepEqual(bodyClasses(html), ['cal-body cal-h-12']);
  assert.deepEqual(heightRules(html), [{ n: 12, text: '.cal-h-12{height:calc(var(--cal-hour) * 12)}' }]);
});

test('R178 an event at 21:00 widens the window to 07:00 to 22:00: cal-h-15 and its rule, and no cal-h-12', () => {
  const html = pageHtml([ev('Late', '21:00', '21:30')]);
  assert.deepEqual(bodyClasses(html), ['cal-body cal-h-15']);
  assert.deepEqual(heightRules(html), [{ n: 15, text: '.cal-h-15{height:calc(var(--cal-hour) * 15)}' }]);
  assert.equal(html.includes('cal-h-12'), false);
});

test('R178 a calendar with no timed event has no day body, no cal-h- class and no .cal-h- rule', () => {
  const html = pageHtml([]);
  assert.equal(bodyClasses(html).length, 0);
  assert.equal(calendarSection(html).includes('cal-h-'), false);
  assert.equal(heightRules(html).length, 0);
  assert.equal(html.includes('cal-h-'), false);
});

test('R178 the stylesheet holds no rule for a lane class and none that fixes a cal-h- height', () => {
  const css = readFileSync(here('../board/static/board.css'), 'utf8');
  assert.equal(/\.cal-h-\d/.test(css), false);
});

test('R178 the helpers see a rule when one is there and refuse any other form (negative control)', () => {
  const wrap = (s) => '<style nonce="' + NONCE + '">' + s + '</style>';
  const good = wrap('.cal-event.cal-lane-2of3{left:33.333%;width:33.333%}');
  assert.deepEqual(ruleFor(laneRules(good), 2, 3), { left: '33.333', width: '33.333' });
  assert.equal(laneRules(wrap('.x-5{--x:5%}')).length, 0);
  assert.deepEqual(heightRules(wrap('.cal-h-12{height:calc(var(--cal-hour) * 12)}')).map((r) => r.n), [12]);
  for (const bad of ['.cal-lane-2of3{left:33.333%;width:33.333%}', '.cal-event.cal-lane-2of3{width:33.333%;left:33.333%}',
    '.cal-event.cal-lane-1of3{left:0%;width:33.333%}', '.cal-event.cal-lane-2of3{left:33.3330%;width:33.333%}']) {
    const rules = (() => { try { return laneRules(wrap(bad)); } catch { return null; } })();
    let refused = rules === null;
    if (!refused) { try { ruleFor(rules, Number(bad.match(/lane-(\d)of/)[1]), 3); } catch { refused = true; } }
    assert.ok(refused, 'accepted: ' + bad);
  }
});
