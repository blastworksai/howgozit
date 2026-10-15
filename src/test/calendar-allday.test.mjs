// Tests of the all-day line and the now-line, written from the contract (R51, R98, R105, R106)
// and the last section of the calendar spec, not from any implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { board, state } from '../fixtures/build.mjs';
import { checkState, checkBoard } from '../board/shape-data.mjs';
import { createCalendarSource } from '../board/calendar/icloud.mjs';
import { fakeCalDav } from '../fixtures/fake-caldav.mjs';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const loadJson = (rel) => JSON.parse(readFileSync(here(rel), 'utf8'));

const ELLIPSIS = '…';
const TODAY = '2026-10-12';
const HOSTILE = '"><script>alert(1)</script>&\'';
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const render = (b) => renderPage(b, THEME, OPTS);
const copy = (v) => JSON.parse(JSON.stringify(v));
const count = (s, re) => (s.match(re) || []).length;
const withoutStyle = (html) => html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
const hrefs = (html) => [...html.matchAll(/\shref\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);

const TIMED = [
  { title: 'Standup', start: '08:30', end: '08:45', kind: 'meeting' },
  { title: 'Deep work', start: '09:00', end: '11:00', kind: 'focus' },
];
const good = () => loadJson('../fixtures/state/good/calendar.json');
const panelOf = (b) => b.panels?.calendar;
const calState = (extra) => state({ calendar: { date: TODAY, events: copy(TIMED), ...extra } });
const entries = (n) => Array.from({ length: n }, (_, i) => ({ title: 'Day ' + String(i + 1).padStart(2, '0') }));

// The calendar section of a page, from its opening tag to the next section (or the end).
function calendarSection(html) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ name: m[1], start: html.lastIndexOf('<', m.index) }));
  const i = marks.findIndex((m) => m.name === 'calendar');
  assert.ok(i >= 0, 'the page has no calendar section');
  return html.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].start : html.length);
}

// The element that carries data-allday: its tag name and inner html.
function alldayElement(section) {
  const m = section.match(/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\sdata-allday(?=[\s=>\/])[^>]*>([\s\S]*?)<\/\1>/);
  assert.ok(m, 'no element with data-allday');
  return { tag: m[1], inner: m[2], text: m[2].replace(/<[^>]*>/g, '') };
}

// A page board: the page fixture with its calendar panel replaced.
function pageBoard(panel) {
  const b = copy(loadJson('../fixtures/board/page.board.json'));
  b.panels.calendar = panel;
  return b;
}
const panelWith = (extra, events = TIMED) => ({ stale: false, date: TODAY, now: '08:10', events: copy(events), ...extra });

// ---- R51: the panel ----

test('R51 14 all-day entries are cut to 10 and a 300-character title to 200 ending with an ellipsis', () => {
  const all = entries(14);
  all[2] = { title: 'L'.repeat(300) };
  const b = board({ state: calState({ allDay: all }) });
  const p = panelOf(b);
  assert.equal(p.error, undefined);
  assert.equal(p.allDay.length, 10);
  assert.equal(p.allDay[2].title.length, 200);
  assert.ok(p.allDay[2].title.endsWith(ELLIPSIS), 'the cut title ends with an ellipsis');
  assert.equal(p.allDay[2].title, 'L'.repeat(199) + ELLIPSIS);
  assert.deepEqual(p.allDay.filter((_, i) => i !== 2), entries(14).slice(0, 10).filter((_, i) => i !== 2));
  assert.deepEqual(p.events, TIMED);
});

test('R51 an all-day list of 10 or fewer keeps every entry', () => {
  const p = panelOf(board({ state: calState({ allDay: entries(10) }) }));
  assert.deepEqual(p.allDay, entries(10));
  const q = panelOf(board({ state: calState({ allDay: entries(1) }) }));
  assert.deepEqual(q.allDay, entries(1));
});

test('R51 a calendar without allDay, and one with allDay: [], has no allDay key on the panel', () => {
  const none = panelOf(board({ state: calState({}) }));
  assert.equal(Object.hasOwn(none, 'allDay'), false);
  const empty = panelOf(board({ state: calState({ allDay: [] }) }));
  assert.equal(Object.hasOwn(empty, 'allDay'), false);
  assert.equal(empty.error, undefined);
  assert.deepEqual(empty.events, TIMED);
  // the twin: with an entry the key is there
  assert.equal(Object.hasOwn(panelOf(board({ state: calState({ allDay: entries(1) }) })), 'allDay'), true);
});

test('R51 an allDay that is not a list gives the broken panel', () => {
  for (const bad of ['x', 5, { title: 'Day off' }, true]) {
    assert.deepEqual(panelOf(board({ state: calState({ allDay: bad }) })), { error: 'unreadable' }, JSON.stringify(bad));
  }
});

test('R51 an allDay entry without a string title gives the broken panel', () => {
  for (const bad of [[{}], [{ title: 5 }], [{ title: null }], [{ title: 'Day off' }, {}], [{ title: 'Day off' }, 'text']]) {
    assert.deepEqual(panelOf(board({ state: calState({ allDay: bad }) })), { error: 'unreadable' }, JSON.stringify(bad));
  }
});

// ---- U: the state and board validators ----

test('U checkState accepts a calendar with allDay, and one without', () => {
  const withAll = { ...good(), allDay: [{ title: 'Day off' }] };
  assert.deepEqual(checkState('calendar', withAll), { ok: true, errors: [] });
  assert.deepEqual(checkState('calendar', good()), { ok: true, errors: [] });
});

test('U checkState refuses allDay that is not a list or holds an entry without a title', () => {
  assert.equal(checkState('calendar', { ...good(), allDay: 'x' }).ok, false);
  assert.equal(checkState('calendar', { ...good(), allDay: [{}] }).ok, false);
  assert.equal(checkState('calendar', { ...good(), allDay: [{ title: 5 }] }).ok, false);
  assert.ok(checkState('calendar', { ...good(), allDay: 'x' }).errors.length > 0);
});

test('U checkBoard accepts a calendar panel with allDay, and one without', () => {
  assert.deepEqual(checkBoard(pageBoard(panelWith({}))), { ok: true, errors: [] });
  assert.deepEqual(checkBoard(pageBoard(panelWith({ allDay: [{ title: 'Day off' }] }))), { ok: true, errors: [] });
});

test('U checkBoard refuses an allDay that is not a list or holds an entry without a title', () => {
  assert.equal(checkBoard(pageBoard(panelWith({ allDay: 'x' }))).ok, false);
  assert.equal(checkBoard(pageBoard(panelWith({ allDay: [{}] }))).ok, false);
});

// ---- R98: the source ----

const USER = 'Sam.Sentinel@example.com';
const PASS = 'pw-Sentinel-2201';
const TZ = 'Europe/Brussels';
const NOW = '2026-10-12T06:10:00.000Z';
const MINUTE = 60 * 1000;
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const timed = (title) => vevent({ summary: title, start: '20261012T083000Z', end: '20261012T084500Z' });
const day = (title, date = '20261012', next = '20261013') => vevent({ summary: title, start: date, end: next, allDay: true });
const cal = (name, ...events) => ({ name, ics: [vcalendar(...events)] });

function setup(calendars) {
  const fake = fakeCalDav({ user: USER, password: PASS, calendars });
  const source = createCalendarSource({ fetch: fake.fetch, login: { user: USER, password: PASS } });
  return { fake, source };
}
const ask = (source, names, now = NOW) => source.read({ calendars: names.map((name) => ({ name })), tz: TZ, now });

test('R98 all-day events are listed apart, sorted by title, and not among the timed events', async () => {
  const { source } = setup([cal('Home', day('Trip to the coast'), timed('Standup'), day('Day off'))]);
  const out = await ask(source, ['Home']);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Standup']);
  assert.deepEqual(out.value.allDay, [{ title: 'Day off' }, { title: 'Trip to the coast' }]);
  assert.equal(out.value.date, TODAY);
  assert.deepEqual(out.warnings, []);
});

test('R98 all-day events from two named calendars are merged and sorted by title', async () => {
  const { source } = setup([
    cal('Home', day('Trip to the coast'), timed('Standup')),
    cal('Work', day('Conference'), day('Day off')),
  ]);
  const out = await ask(source, ['Work', 'Home']);
  assert.deepEqual(out.value.allDay, [{ title: 'Conference' }, { title: 'Day off' }, { title: 'Trip to the coast' }]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Standup']);
});

test('R98 twelve all-day events are cut to ten, the first ten by title', async () => {
  const titles = entries(12).map((e) => e.title);
  const { source } = setup([cal('Home', ...[...titles].reverse().map((t) => day(t)))]);
  const out = await ask(source, ['Home']);
  assert.equal(out.value.allDay.length, 10);
  assert.deepEqual(out.value.allDay, titles.slice(0, 10).map((title) => ({ title })));
});

test('R98 a calendar with no all-day event gives a value with no allDay key', async () => {
  const { source } = setup([cal('Home', timed('Standup'))]);
  const out = await ask(source, ['Home']);
  assert.equal(Object.hasOwn(out.value, 'allDay'), false);
  assert.deepEqual(out.value, { date: TODAY, events: [{ title: 'Standup', start: '10:30', end: '10:45', kind: 'meeting' }] });
});

test('R98 an all-day event of tomorrow is not listed, and one of today beside it is', async () => {
  const { source } = setup([cal('Home', day('Tomorrow only', '20261013', '20261014'), day('Today only'))]);
  const out = await ask(source, ['Home']);
  assert.deepEqual(out.value.allDay, [{ title: 'Today only' }]);
  const { source: other } = setup([cal('Home', day('Tomorrow only', '20261013', '20261014'))]);
  const none = await ask(other, ['Home']);
  assert.deepEqual(none.value, { date: TODAY, events: [] });
});

test('R98 after a failed read six minutes later the stale answer carries the same allDay', async () => {
  const { fake, source } = setup([cal('Home', day('Trip to the coast'), day('Day off'), timed('Standup'))]);
  const first = await ask(source, ['Home']);
  assert.equal(first.value.allDay.length, 2);
  fake.state.fail = { step: 'report', status: 500 };
  const out = await ask(source, ['Home'], plus(NOW, 6 * MINUTE));
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.value.allDay, first.value.allDay);
  assert.deepEqual(out.value, { ...first.value, stale: true });
  assert.deepEqual(out.warnings, [{ code: 'calendar-unreachable', count: 1 }]);
});

// ---- R105: the card ----

test('R105 all-day events show as one line with the label and both titles; the head still counts timed events', () => {
  const html = render(pageBoard(panelWith({ allDay: [{ title: 'Day off' }, { title: 'Trip to the coast' }] })));
  const section = calendarSection(html);
  assert.equal(count(section, /data-allday/g), 1, 'exactly one data-allday inside the calendar section');
  const line = alldayElement(section);
  assert.ok(line.text.includes('All day'), line.text);
  assert.ok(line.text.includes('Day off') && line.text.includes('Trip to the coast'), line.text);
  assert.ok(line.text.includes(' · '), line.text);
  assert.ok(line.text.indexOf('Day off') < line.text.indexOf('Trip to the coast'), 'titles in the given order');
  assert.ok(/>\s*2 events\s*</.test(section), 'the head says 2 events');
  assert.ok(!/>\s*4 events\s*</.test(section));
  assert.equal(count(withoutStyle(html), /data-allday/g), 1, 'one on the whole page');
});

test('R105 one all-day title shows the label and the title and no separator', () => {
  const line = alldayElement(calendarSection(render(pageBoard(panelWith({ allDay: [{ title: 'Day off' }] })))));
  assert.ok(line.text.includes('All day') && line.text.includes('Day off'));
  assert.ok(!line.text.includes(' · '), 'no separator for one title');
});

test('R105 without allDay the whole page has no data-allday', () => {
  assert.equal(count(withoutStyle(render(pageBoard(panelWith({})))), /data-allday/g), 0);
  assert.equal(count(withoutStyle(render(pageBoard(panelWith({ allDay: [] })))), /data-allday/g), 0);
  // the twin: with a title it is there
  assert.equal(count(withoutStyle(render(pageBoard(panelWith({ allDay: [{ title: 'Day off' }] })))), /data-allday/g), 1);
});

test('R105 allDay and no timed event still shows the calendar section with the line', () => {
  const html = render(pageBoard(panelWith({ allDay: [{ title: 'Day off' }] }, [])));
  const section = calendarSection(html);
  assert.equal(count(section, /data-allday/g), 1);
  assert.ok(alldayElement(section).text.includes('Day off'));
  assert.ok(/>\s*0 events\s*</.test(section), 'the head says 0 events');
});

test('R105 a hostile all-day title is escaped and adds no script', () => {
  const plain = render(pageBoard(panelWith({ allDay: [{ title: 'Day off' }] })));
  const html = render(pageBoard(panelWith({ allDay: [{ title: HOSTILE }] })));
  assert.equal(count(html, /<script/gi), count(plain, /<script/gi), 'no script tag beyond the board\'s own');
  assert.ok(!html.includes(HOSTILE), 'the raw text is not in the page');
  assert.ok(!html.includes('"><script>alert(1)'), 'no raw script');
  const line = alldayElement(calendarSection(html));
  assert.ok(line.inner.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;'), line.inner);
});

test('R105 an all-day title that is an address is text and no href holds it', () => {
  const html = render(pageBoard(panelWith({ allDay: [{ title: 'https://evil.example/x' }] })));
  assert.ok(alldayElement(calendarSection(html)).text.includes('https://evil.example/x'), 'the text shows');
  assert.ok(!hrefs(html).some((h) => h.includes('evil.example')), 'no href holds evil.example');
  assert.equal(count(calendarSection(html), /\shref\s*=/gi), 0, 'the calendar section holds no link');
});

test('R105 the page with an all-day line has no style attribute', () => {
  const html = render(pageBoard(panelWith({ allDay: [{ title: 'Day off' }, { title: HOSTILE }] })));
  assert.equal(count(html, /style="/g), 0);
  assert.ok(count(withoutStyle(html), /data-allday/g) === 1, 'the line is on the page');
});

test('R105 a state file with allDay, as an agent would write it, reaches the page line', () => {
  const file = JSON.parse(JSON.stringify({
    date: TODAY,
    events: TIMED,
    allDay: [{ title: 'Trip to the coast' }, { title: 'Day off' }],
  }));
  assert.equal(checkState('calendar', file).ok, true);
  const html = render(board({ state: state({ calendar: file }) }));
  const section = calendarSection(html);
  assert.equal(count(section, /data-allday/g), 1);
  const line = alldayElement(section);
  assert.ok(line.text.includes('All day'));
  assert.ok(line.text.includes('Trip to the coast') && line.text.includes('Day off') && line.text.includes(' · '), line.text);
  assert.ok(/>\s*2 events\s*</.test(section));
  // the twin: the same file without allDay has no line
  const { allDay, ...bare } = file;
  assert.ok(Array.isArray(allDay));
  assert.equal(count(withoutStyle(render(board({ state: state({ calendar: bare }) }))), /data-allday/g), 0);
});

// ---- R106: the stylesheet ----

const CSS = readFileSync(here('../board/static/board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every block whose whole selector is exactly `selector`, merged: the last declaration of a property wins.
function ruleBlock(css, selector) {
  const re = new RegExp('(?:^|[{}])\\s*' + escapeRe(selector) + '\\s*\\{([^{}]*)\\}', 'g');
  const found = [...css.matchAll(re)].map((m) => m[1]);
  assert.ok(found.length > 0, 'board.css has no rule with the selector ' + selector);
  const decls = {};
  for (const body of found) {
    for (const d of body.split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).replace(/!important/i, '').trim();
    }
  }
  return decls;
}

test('R106 the now-line has a z-index that is a number lower than the event box', () => {
  const now = ruleBlock(CSS, '.cal-now');
  const box = ruleBlock(CSS, '.cal-event');
  assert.ok('z-index' in now, '.cal-now sets no z-index');
  assert.ok('z-index' in box, '.cal-event sets no z-index');
  assert.match(now['z-index'], /^-?\d+$/, '.cal-now z-index is a number: ' + now['z-index']);
  assert.match(box['z-index'], /^-?\d+$/, '.cal-event z-index is a number: ' + box['z-index']);
  assert.ok(Number(now['z-index']) < Number(box['z-index']), '.cal-now ' + now['z-index'] + ' is not lower than .cal-event ' + box['z-index']);
});

test('R106 every event box has a solid ground from a theme variable', () => {
  const base = ruleBlock(CSS, '.cal-event');
  for (const kind of ['meeting', 'focus', 'habit', 'personal']) {
    const own = ruleBlock(CSS, '.cal-event--' + kind);
    const ground = own.background ?? base.background;
    assert.ok(ground !== undefined, '.cal-event--' + kind + ' has no background of its own or from .cal-event');
    assert.ok(/^var\(--[\w-]+/.test(ground), '.cal-event--' + kind + ' background is not a theme variable: ' + ground);
    assert.ok(!/transparent|none/i.test(ground), '.cal-event--' + kind + ' background is not solid: ' + ground);
  }
});

test('R106 the helper fails with a clear message on a missing selector', () => {
  assert.throws(() => ruleBlock(CSS, '.cal-no-such-rule'), /no rule with the selector \.cal-no-such-rule/);
  assert.equal(ruleBlock('.a { z-index: 3; } .a { color: var(--x); }', '.a')['z-index'], '3');
});
