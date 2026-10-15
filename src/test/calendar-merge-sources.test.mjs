// Tests of R112, R113 and R114, written from the contract before the code exists: the words that say where
// an event came from, either source failing without hiding the other, and the note for a file from an earlier day.
// Level: the real loader, the real iCloud reader against the invented iCloud of fixtures/fake-caldav.mjs, a fake
// GitHub holding the settings and state/calendar.json, then the board model and the rendered page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../board/load.mjs';
import { createCalendarSource } from '../board/calendar/icloud.mjs';
import { buildBoard } from '../board/model.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { fakeCalDav } from '../fixtures/fake-caldav.mjs';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { settings } from '../fixtures/build.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const USER = 'merge.sentinel@example.com';
const PASS = 'pw-merge-sentinel-0042';
const LOGIN = { user: USER, password: PASS };
const AT = '2026-10-12T06:10:00.900Z';
const TODAY = '2026-10-12';
const BLOCK = { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }] };
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const FILE_UNREADABLE_TEXT = 'The calendar file from the agent could not be read, so its events are not shown.';
const FROM_ICLOUD = { error: 'unreadable', from: 'icloud' };
const HOSTILE = '"><script>alert(1)</script>&\'';
const MIN = 60 * 1000;

// ---------------------------------------------------------------- the givens

const two = (n) => String(n).padStart(2, '0');
// Minutes after 00:00 UTC, as an iCalendar UTC time (Brussels is UTC+2 on both days used here).
const zt = (min, day = '20261012') => `${day}T${two(Math.floor(min / 60))}${two(min % 60)}00Z`;
const iceEvent = (title, startMin, endMin, day) => vevent({ summary: title, start: zt(startMin, day), end: zt(endMin, day) });
const iceAllDay = (title, day = '20261012', next = '20261013') => vevent({ summary: title, start: day, end: next, allDay: true });

// iCloud: Dentist 10:30 to 11:00 on the Brussels clock.
const dentist = (day) => iceEvent('Dentist', 8 * 60 + 30, 9 * 60, day);
// The file: Standup 09:00 to 09:30 and Review notes 14:00 to 14:30, board clock.
const fileEvents = () => [
  { title: 'Standup', start: '09:00', end: '09:30', kind: 'meeting' },
  { title: 'Review notes', start: '14:00', end: '14:30', kind: 'focus' },
];
const goodFile = (extra = {}) => ({ date: TODAY, events: fileEvents(), ...extra });

function notFound(p) {
  return new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
}

function makeHttp(files) {
  const answer = (p) => {
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p.startsWith(R + '/contents/')) {
      const f = p.slice((R + '/contents/').length);
      if (!Object.hasOwn(files, f) || files[f] === null) throw notFound(p);
      return { content: Buffer.from(files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?') || p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    if (p === '/orgs/' + OWNER + '/projectsV2?per_page=100') return { items: [], partial: false };
    throw notFound(p);
  };
  return {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
}

// ---------------------------------------------------------------- reading the page

const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const strip = (s) => s.replace(/<[^>]*>/g, '');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (s, re) => (s.match(re) || []).length;
const hrefs = (html) => [...html.matchAll(/\shref\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);

// The calendar section of a page, from its opening tag to the next section (or the end).
function calendarSection(html) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ name: m[1], start: html.lastIndexOf('<', m.index) }));
  const i = marks.findIndex((m) => m.name === 'calendar');
  assert.ok(i >= 0, 'the page has no calendar section');
  return html.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].start : html.length);
}

const ATTR = (name) => new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\s${name}(?=[\\s=>/])[^>]*>([\\s\\S]*?)</\\1>`, 'g');

// Every element with the attribute: its inner html as written, and its text with tags removed and escapes undone.
function elementsWith(html, name) {
  return [...html.matchAll(ATTR(name))].map((m) => ({ inner: m[2], text: unesc(strip(m[2])) }));
}

// A section as one line of text in which every data-source element shows as ⟦word⟧, so "right after the title" is checkable.
function marked(sectionHtml) {
  const withMarks = sectionHtml.replace(ATTR('data-source'), (all, tag, inner) => '⟦' + strip(inner) + '⟧');
  return unesc(strip(withMarks)).replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------- one session: loader, board, page

function session({
  block = BLOCK, includeFile = true, file, login = LOGIN, loginPass = PASS, iceText = [dentist()], at = AT, tz = 'Europe/Brussels',
} = {}) {
  const fake = fakeCalDav({ user: USER, password: PASS, calendars: [{ name: 'Home', ics: [vcalendar(...iceText)] }] });
  const source = login ? createCalendarSource({ fetch: fake.fetch, login: { user: login.user, password: loginPass } }) : undefined;
  const fileText = file === undefined ? null : typeof file === 'string' ? file : JSON.stringify(file);
  const calendar = includeFile === null ? { ...block } : { ...block, includeFile };
  const files = {
    'board.config.json': JSON.stringify(settings({ timezone: tz, calendar })),
    'theme.json': null,
    'state/brief.json': null,
    'state/calendar.json': fileText,
    'state/inbox.json': null,
    'state/log.json': null,
    'state/proposals.json': null,
  };
  const cache = { async readLastGood() { return null; }, async writeLastGood() {}, etags: { get() {}, set() {} } };
  const clock = { t: Date.parse(at), now() { return clock.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-TOKEN-123' };
  const loader = createLoader({ http: makeHttp(files), env, cache, clock, ...(source ? { calendar: source } : {}) });
  const s = { fake, source, files, clock, loader };
  s.load = async () => {
    const out = await loader.load();
    assert.equal(out.ok, true, 'the board did not load (the harness is wrong, not the rule)');
    const b = out.bundle;
    const board = buildBoard({ ...b, now: new Date(clock.t).toISOString() });
    const html = renderPage(board, THEME, OPTS);
    const panel = board.panels.calendar;
    const calSource = (board.meta.sources || []).find((x) => x.id === 'calendar');
    const calWarnings = (board.meta.warnings || []).filter((w) => w.code.startsWith('calendar-'));
    return { out, board, html, panel, calSource, calWarnings };
  };
  return s;
}

const run = async (opts) => session(opts).load();

// [start, title, word] of the timed events, in panel order.
const timed = (panel) => panel.events.map((e) => [e.start, e.title, e.source]);

// The panel and page of a merged board whose panel is a list of events.
function assertEventsPanel(v, expected, why) {
  assert.equal(v.panel && v.panel.error, undefined, `${why}: the panel is the broken one`);
  assert.deepEqual(timed(v.panel), expected, `${why}: the events and their words`);
}

// ---------------------------------------------------------------- the harness itself

test('U the harness reads a board with no file merge: the iCloud event, no merge keys, and the page readers see a planted word', async () => {
  const v = await run({ includeFile: null, file: goodFile() });
  assert.equal(v.panel.error, undefined);
  assert.deepEqual(v.panel.events.map((e) => e.title), ['Dentist']);
  assert.equal('merged' in v.panel, false);
  assert.ok(v.calSource, 'the calendar source is missing from meta.sources');
  assert.equal(v.html.includes('data-source'), false);
  const planted = '<section data-section="calendar"><p>Dentist<span class="w" data-source>iCloud</span></p></section>';
  assert.equal(marked(calendarSection(planted)), 'Dentist⟦iCloud⟧');
  assert.deepEqual(elementsWith(planted, 'data-source').map((e) => e.text), ['iCloud']);
});

// ---------------------------------------------------------------- R112

const THIRTY = 'abcdefghijklmnopqrstuvwxyzabcd';
const LABELS = [
  ['absent', undefined, 'File'],
  ['Work diary', 'Work diary', 'Work diary'],
  ['whitespace and a line break around and inside', '  Work\n   diary  ', 'Work diary'],
  ['30 letters cut to the first 20, no ellipsis', THIRTY, THIRTY.slice(0, 20)],
  ['the script payload cut to 20 characters', HOSTILE, Array.from(HOSTILE).slice(0, 20).join('')],
  ['empty text', '', 'File'],
  ['a number, not text', 7, 'File'],
];

for (const [name, label, word] of LABELS) {
  test(`R112 file label ${name}: the file's events say ${JSON.stringify(word)} and the iCloud event says iCloud, in the panel and on the page`, async () => {
    const file = goodFile();
    if (label !== undefined) file.source = label;
    const v = await run({ file });
    assertEventsPanel(v, [
      ['09:00', 'Standup', word],
      ['10:30', 'Dentist', 'iCloud'],
      ['14:00', 'Review notes', word],
    ], 'label ' + name);
    assert.equal(v.panel.merged, true);
    const cal = calendarSection(v.html);
    const words = elementsWith(cal, 'data-source');
    assert.deepEqual(words.map((w) => w.text), [word, 'iCloud', word], 'the data-source elements, in page order');
    for (const w of words) assert.ok(!/[<>]/.test(w.inner), 'a data-source element holds markup, so the word is not escaped: ' + w.inner);
    assert.equal(marked(cal).includes(`Standup⟦${word}⟧`), true, 'the word does not sit right after the title Standup');
    assert.equal(marked(cal).includes('Dentist⟦iCloud⟧'), true, 'the word does not sit right after the title Dentist');
    assert.equal(marked(cal).includes(`Review notes⟦${word}⟧`), true, 'the word does not sit right after the title Review notes');
  });
}

test('R112 the script payload as a label: no script beyond the board\'s own and no link from it', async () => {
  const baseline = await run({ file: goodFile({ source: 'Work diary' }) });
  const hostile = await run({ file: goodFile({ source: HOSTILE }) });
  assert.equal(hostile.panel.events.filter((e) => e.source !== 'iCloud').length, 2, 'the file events are not shown');
  assert.equal(count(hostile.html, /<script/gi), count(baseline.html, /<script/gi), 'a script element came from the label');
  assert.equal(hostile.html.includes('alert(1)</script>'), false);
  assert.deepEqual(hrefs(hostile.html), hrefs(baseline.html), 'the label added or changed a link');
  assert.equal(hostile.html.includes('<script>alert'), false);
  const sources = elementsWith(calendarSection(hostile.html), 'data-source');
  assert.equal(sources.length, 3);
  assert.equal(sources[0].text.length, 20);
});

test('R112 an event of the file with its own source of Elsewhere: the file\'s label is used and Elsewhere is nowhere', async () => {
  const file = goodFile({ source: 'Work diary' });
  file.events[0].source = 'Elsewhere';
  const v = await run({ file });
  assertEventsPanel(v, [
    ['09:00', 'Standup', 'Work diary'],
    ['10:30', 'Dentist', 'iCloud'],
    ['14:00', 'Review notes', 'Work diary'],
  ], 'event source ignored');
  assert.equal(v.html.includes('Elsewhere'), false);
});

test('R112 an event of the file with its own source and no label of the file: the word is File', async () => {
  const file = goodFile();
  file.events[1].source = 'Elsewhere';
  const v = await run({ file });
  assert.deepEqual(v.panel.events.map((e) => e.source), ['File', 'iCloud', 'File']);
  assert.equal(v.html.includes('Elsewhere'), false);
});

test('R112 the iCloud event says iCloud every time, whatever the label of the file', async () => {
  for (const label of [undefined, 'Work diary', '', 7, 'iCloud']) {
    const file = goodFile();
    if (label !== undefined) file.source = label;
    const v = await run({ file });
    const ice = v.panel.events.filter((e) => e.title === 'Dentist');
    assert.deepEqual(ice.map((e) => e.source), ['iCloud'], 'label ' + JSON.stringify(label));
  }
});

test('R112 all-day entries: each title is followed by its own data-source inside the one data-allday element, separated by " · "', async () => {
  const file = goodFile({ source: 'Work diary', allDay: [{ title: 'Trip to the coast' }] });
  const v = await run({ file, iceText: [dentist(), iceAllDay('Day off')] });
  assert.ok(Array.isArray(v.panel.allDay), 'the panel has no allDay entries');
  assert.deepEqual(v.panel.allDay.map((a) => [a.title, a.source]), [['Day off', 'iCloud'], ['Trip to the coast', 'Work diary']]);
  const cal = calendarSection(v.html);
  const lines = elementsWith(cal, 'data-allday');
  assert.equal(lines.length, 1, 'expected one data-allday element');
  const text = marked(`<div>${lines[0].inner}</div>`);
  assert.match(text, /^\s*All day\s*Day off\s?⟦iCloud⟧ · Trip to the coast\s?⟦Work diary⟧\s*$/);
  assert.equal(elementsWith(lines[0].inner, 'data-source').length, 2);
  // the timed events keep theirs, outside the all-day line
  assert.equal(elementsWith(cal, 'data-source').length, 5);
});

test('R112 all-day entries of the file alone carry File, and the line holds one word for each title', async () => {
  const v = await run({ file: goodFile({ allDay: [{ title: 'Trip to the coast' }, { title: 'Day off' }] }) });
  assert.ok(Array.isArray(v.panel.allDay), 'the panel has no allDay entries');
  assert.deepEqual(v.panel.allDay.map((a) => [a.title, a.source]), [['Day off', 'File'], ['Trip to the coast', 'File']]);
  const line = elementsWith(calendarSection(v.html), 'data-allday')[0];
  assert.ok(line, 'no data-allday element');
  assert.match(marked(`<div>${line.inner}</div>`), /^\s*All day\s*Day off\s?⟦File⟧ · Trip to the coast\s?⟦File⟧\s*$/);
});

test('R112 the all-day words are escaped and never links', async () => {
  const baseline = await run({ file: goodFile({ source: 'Work diary', allDay: [{ title: 'Trip' }] }) });
  const v = await run({ file: goodFile({ source: HOSTILE, allDay: [{ title: 'Trip' }] }) });
  assert.equal(count(v.html, /<script/gi), count(baseline.html, /<script/gi));
  assert.deepEqual(hrefs(v.html), hrefs(baseline.html));
  const line = elementsWith(calendarSection(v.html), 'data-allday')[0];
  assert.ok(line, 'no data-allday element');
  assert.equal(elementsWith(line.inner, 'data-source')[0].text, Array.from(HOSTILE).slice(0, 20).join(''));
});

// ---------------------------------------------------------------- R113

const iceOnly = [['10:30', 'Dentist', 'iCloud']];
const fileOnly = [['09:00', 'Standup', 'File'], ['14:00', 'Review notes', 'File']];
const both = [['09:00', 'Standup', 'File'], ['10:30', 'Dentist', 'iCloud'], ['14:00', 'Review notes', 'File']];

function assertRaised(v, expectedWarnings, fileRaised) {
  assert.deepEqual(v.calWarnings, expectedWarnings, 'the calendar warnings and their counts');
  const times = count(v.html, new RegExp(escRe(FILE_UNREADABLE_TEXT), 'g'));
  assert.equal(times, fileRaised ? 1 : 0, fileRaised ? 'the page lacks the file sentence' : 'the page shows the file sentence without the warning');
}

const bad = [
  ['not valid JSON', '{ this is not json'],
  ['wrong shape (events is not a list)', { date: TODAY, events: 'nope' }],
  ['wrong shape (no date)', { events: fileEvents() }],
  ['larger than 256 KB', { date: TODAY, events: [{ title: 'x'.repeat(300000), start: '09:00', end: '09:30', kind: 'meeting' }] }],
];

for (const [name, file] of bad) {
  test(`R113 good iCloud and a file ${name}: the iCloud events are on the panel, stale, source stale, calendar-file-unreadable once, nothing else`, async () => {
    const text = typeof file === 'string' ? file : JSON.stringify(file);
    if (name.includes('256')) assert.ok(Buffer.byteLength(text, 'utf8') > 262144, 'the fixture is not larger than 256 KB (harness)');
    const v = await run({ file: text });
    assertEventsPanel(v, iceOnly, 'iCloud alone must be shown');
    assert.equal(v.panel.stale, true);
    assert.equal(v.calSource.state, 'stale');
    assertRaised(v, [{ code: 'calendar-file-unreadable', count: 1 }], true);
    assert.equal(v.html.includes('Dentist'), true);
    assert.equal(calendarSection(v.html).includes('class="panel-error"'), false, 'the broken card is shown although iCloud answered');
    assert.equal(elementsWith(calendarSection(v.html), 'data-source').map((e) => e.text).join(), 'iCloud');
  });
}

test('R113 good iCloud and an unreadable file: the iCloud word is on the page right after the title, and no fileDate or file title appears', async () => {
  const v = await run({ file: '{ nope' });
  assert.equal(marked(calendarSection(v.html)).includes('Dentist⟦iCloud⟧'), true);
  assert.equal('fileDate' in v.panel, false);
  assert.equal(v.html.includes('data-filedate'), false);
});

test('R113 failing iCloud (no sign-in) and a good file: the file\'s events, stale, source stale, calendar-no-login once, no file warning', async () => {
  const s = session({ login: null, file: goodFile() });
  const v = await s.load();
  assertEventsPanel(v, fileOnly, 'the file alone must be shown');
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assertRaised(v, [{ code: 'calendar-no-login', count: 1 }], false);
  assert.equal(calendarSection(v.html).includes('class="panel-error"'), false, 'the broken card is shown although the file is good');
  assert.equal(v.html.includes('Standup'), true);
  assert.equal(s.fake.calls.length, 0, 'Apple was asked without a sign-in');
});

test('R113 iCloud refusing the sign-in and a good file: the file\'s events, stale, source stale, calendar-login-refused once only', async () => {
  const v = await run({ file: goodFile(), loginPass: 'wrong-merge-password-1' });
  assertEventsPanel(v, fileOnly, 'the file alone must be shown');
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assertRaised(v, [{ code: 'calendar-login-refused', count: 1 }], false);
});

test('R113 iCloud failing after a good read earlier today, and a good file: those events with iCloud and the file\'s, stale, calendar-unreachable once', async () => {
  const s = session({ file: goodFile() });
  const first = await s.load();
  assertEventsPanel(first, both, 'first read, both good');
  assert.equal(first.panel.stale, false);
  assert.deepEqual(first.calWarnings, []);
  s.fake.state.fail = { step: 'report', status: 500 };
  s.clock.t += 6 * MIN;
  const v = await s.load();
  assertEventsPanel(v, both, 'the kept iCloud events and the file');
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assertRaised(v, [{ code: 'calendar-unreachable', count: 1 }], false);
  assert.equal(calendarSection(v.html).includes('class="panel-error"'), false);
});

test('R113 iCloud failing after a good read and an unreadable file: the kept iCloud events are shown, both warnings once', async () => {
  const s = session({ file: goodFile() });
  await s.load();
  s.fake.state.fail = { step: 'report', status: 500 };
  s.files['state/calendar.json'] = '{ broken';
  s.clock.t += 6 * MIN;
  const v = await s.load();
  assertEventsPanel(v, iceOnly, 'the kept iCloud events count as shown');
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assertRaised(v, [{ code: 'calendar-file-unreadable', count: 1 }, { code: 'calendar-unreachable', count: 1 }], true);
});

test('R113 both sources failing: the broken panel from icloud, source error, both warnings once, both sentences on the page', async () => {
  const v = await run({ login: null, file: '{ nope' });
  assert.deepEqual(v.panel, FROM_ICLOUD);
  assert.equal(v.calSource.state, 'error');
  assertRaised(v, [{ code: 'calendar-file-unreadable', count: 1 }, { code: 'calendar-no-login', count: 1 }], true);
  const cal = calendarSection(v.html);
  assert.equal(cal.includes('class="panel-error"'), true);
  assert.equal(cal.includes('The calendar could not be read from iCloud. See the note at the foot of the page.'), true);
});

test('R113 both sources failing, iCloud unreachable and a file of wrong shape: the broken panel from icloud, calendar-unreachable and the file warning', async () => {
  const s = session({ file: { date: TODAY, events: 7 } });
  s.fake.state.fail = { step: 'principal', status: 'network' };
  const v = await s.load();
  assert.deepEqual(v.panel, FROM_ICLOUD);
  assert.equal(v.calSource.state, 'error');
  assertRaised(v, [{ code: 'calendar-file-unreadable', count: 1 }, { code: 'calendar-unreachable', count: 1 }], true);
});

test('R113 good iCloud and a file holding "events": [] is an empty source: iCloud events only, not stale, source ok, no warning', async () => {
  const v = await run({ file: { date: TODAY, events: [] } });
  assertEventsPanel(v, iceOnly, 'an empty file');
  assert.equal(v.panel.merged, true);
  assert.equal(v.panel.stale, false);
  assert.equal(v.calSource.state, 'ok');
  assertRaised(v, [], false);
});

test('R113 a file carrying "stale": true is ignored: both sources shown, not stale, source ok, no warning', async () => {
  const v = await run({ file: goodFile({ stale: true }) });
  assertEventsPanel(v, both, 'stale flag of the file ignored');
  assert.equal(v.panel.stale, false);
  assert.equal(v.calSource.state, 'ok');
  assertRaised(v, [], false);
});

test('R113 neither source failing: both shown, not stale, source ok, no calendar warning and no file sentence', async () => {
  const v = await run({ file: goodFile() });
  assertEventsPanel(v, both, 'both good');
  assert.equal(v.panel.stale, false);
  assert.equal(v.calSource.state, 'ok');
  assertRaised(v, [], false);
});

test('R113 an absent file with the block raises no file warning and shows iCloud alone (the file is not failing, it is absent)', async () => {
  const v = await run({});
  assert.deepEqual(v.panel.events.map((e) => e.title), ['Dentist']);
  assert.equal(v.html.includes(FILE_UNREADABLE_TEXT), false);
  assert.deepEqual(v.calWarnings, []);
});

// ---------------------------------------------------------------- R114

const dated = (date, extra = {}) => goodFile({ date, ...extra });
const NOTE = (word, date) => `${word} events are from ${date}.`;

test('R114 today 2026-10-12 and a file dated 2026-10-11 with no label: fileDate, one note "File events are from 2026-10-11.", file events shown, not stale', async () => {
  const v = await run({ file: dated('2026-10-11') });
  assert.equal(v.panel.fileDate, '2026-10-11');
  assert.equal(v.panel.merged, true);
  assertEventsPanel(v, both, 'an earlier file still shows its events');
  assert.equal(v.panel.stale, false);
  assert.equal(v.calSource.state, 'ok');
  assert.equal(count(v.html, /data-filedate/g), 1, 'expected exactly one data-filedate in the page');
  const notes = elementsWith(calendarSection(v.html), 'data-filedate');
  assert.equal(notes.length, 1, 'the data-filedate element is not inside the calendar section');
  assert.equal(notes[0].text, NOTE('File', '2026-10-11'));
  assert.deepEqual(v.calWarnings, []);
});

test('R114 the same with the label Work diary: "Work diary events are from 2026-10-11."', async () => {
  const v = await run({ file: dated('2026-10-11', { source: 'Work diary' }) });
  assert.equal(v.panel.fileDate, '2026-10-11');
  assertEventsPanel(v, [
    ['09:00', 'Standup', 'Work diary'], ['10:30', 'Dentist', 'iCloud'], ['14:00', 'Review notes', 'Work diary'],
  ], 'an earlier labelled file');
  assert.equal(v.panel.stale, false);
  const notes = elementsWith(calendarSection(v.html), 'data-filedate');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, NOTE('Work diary', '2026-10-11'));
});

test('R114 the word of the note is the cleaned label cut at 20 characters', async () => {
  const v = await run({ file: dated('2026-10-11', { source: THIRTY }) });
  const notes = elementsWith(calendarSection(v.html), 'data-filedate');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, NOTE(THIRTY.slice(0, 20), '2026-10-11'));
});

test('R114 a hostile label in the note is escaped and makes no link', async () => {
  const baseline = await run({ file: dated('2026-10-11', { source: 'Work diary' }) });
  const v = await run({ file: dated('2026-10-11', { source: HOSTILE }) });
  assert.equal(v.panel.fileDate, '2026-10-11');
  assert.equal(count(v.html, /<script/gi), count(baseline.html, /<script/gi));
  assert.deepEqual(hrefs(v.html), hrefs(baseline.html));
  const notes = elementsWith(calendarSection(v.html), 'data-filedate');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, NOTE(Array.from(HOSTILE).slice(0, 20).join(''), '2026-10-11'));
});

for (const date of ['2026-10-12', '2026-10-13']) {
  test(`R114 a file dated ${date} (today or later): no fileDate, no data-filedate element, not stale, events shown`, async () => {
    const v = await run({ file: dated(date) });
    assertEventsPanel(v, both, 'a file of today or later');
    assert.equal('fileDate' in v.panel, false);
    assert.equal(v.html.includes('data-filedate'), false);
    assert.equal(v.panel.stale, false);
    assert.equal(v.calSource.state, 'ok');
  });
}

test('R114 board timezone Europe/Brussels at now 2026-10-12T22:30:00Z (already the 13th there) and a file dated 2026-10-12: the note', async () => {
  const v = await run({
    file: dated('2026-10-12'), at: '2026-10-12T22:30:00.000Z', tz: 'Europe/Brussels', iceText: [dentist('20261013')],
  });
  assert.equal(v.panel.fileDate, '2026-10-12');
  assert.equal(v.panel.stale, false);
  assert.deepEqual(v.panel.events.map((e) => e.source), ['File', 'iCloud', 'File']);
  const notes = elementsWith(calendarSection(v.html), 'data-filedate');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, NOTE('File', '2026-10-12'));
});

test('R114 twin: the same instant in America/New_York is still the 12th, so a file dated 2026-10-12 has no note', async () => {
  const v = await run({
    file: dated('2026-10-12'), at: '2026-10-12T22:30:00.000Z', tz: 'America/New_York', iceText: [iceEvent('Dentist', 14 * 60, 15 * 60)],
  });
  assert.equal('fileDate' in v.panel, false);
  assert.equal(v.html.includes('data-filedate'), false);
  assert.deepEqual(v.panel.events.map((e) => e.source).sort(), ['File', 'File', 'iCloud']);
});

test('R114 a file from an earlier day that fails its shape has no note: the rule needs the file not to fail', async () => {
  const v = await run({ file: { date: '2026-10-11', events: 'nope' } });
  assert.equal('fileDate' in v.panel, false);
  assert.equal(v.html.includes('data-filedate'), false);
  assertRaised(v, [{ code: 'calendar-file-unreadable', count: 1 }], true);
});

test('R114 a file from an earlier day with iCloud failing: the note is still there and the panel is stale for iCloud\'s reason (source stale)', async () => {
  const v = await run({ login: null, file: dated('2026-10-11') });
  assert.equal(v.panel.fileDate, '2026-10-11');
  assert.deepEqual(v.panel.events.map((e) => e.source), ['File', 'File']);
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assert.equal(elementsWith(calendarSection(v.html), 'data-filedate')[0].text, NOTE('File', '2026-10-11'));
});
