// R109, R110, R111 and R115: the agent's calendar file shown beside iCloud when calendar.includeFile is on.
// Written from the contract text. The path is the board's own: the loader reads a fake GitHub and a fake iCloud,
// buildBoard makes the board, renderPage makes the page. Every time and date is fixed; nothing depends on the machine zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { createCalendarSource } from '../board/calendar/icloud.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { fakeCalDav } from '../fixtures/fake-caldav.mjs';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { settings } from '../fixtures/build.mjs';

const USER = 'merge.sentinel@example.com';
const PASS = 'pw-merge-Sentinel-2210';
const LOGIN = { user: USER, password: PASS };
const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const AT = '2026-10-12T06:10:00.900Z'; // 08:10 on 12 October in Europe/Brussels (UTC+2)
const TODAY = '2026-10-12';
const BLOCK = { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }] };
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };

// ---- times: minutes after 00:00 Brussels on 12 October 2026 ----
const two = (n) => String(n).padStart(2, '0');
const hm = (min) => `${two(Math.floor(min / 60))}:${two(min % 60)}`; // as shown, Brussels wall clock
const utc = (min) => { const u = min - 120; return `20261012T${two(Math.floor(u / 60))}${two(u % 60)}00Z`; };
const iEv = (title, startMin, endMin) => vevent({ summary: title, start: utc(startMin), end: utc(endMin) });
const iDay = (title) => vevent({ summary: title, start: '20261012', end: '20261013', allDay: true });
const fEv = (title, startMin, endMin, kind = 'meeting') => ({ title, start: hm(startMin), end: hm(endMin), kind });

// ---- the fake GitHub world, as in calendar-load.test.mjs ----
function apiIssue(number) {
  return {
    id: number * 10, number, title: 'Task ' + number, state: 'open', state_reason: null,
    labels: [], milestone: null, comments: 0,
    created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
    html_url: 'https://github.com/' + REPO + '/issues/' + number,
  };
}
const notFound = (p) => new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');

// `file`: undefined/null = no state/calendar.json; an object = its JSON; a string = the raw text.
function makeHttp({ cfg, file }) {
  const files = {
    'board.config.json': JSON.stringify(cfg),
    'state/calendar.json': file === undefined || file === null ? null : (typeof file === 'string' ? file : JSON.stringify(file)),
  };
  function answer(p) {
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p.startsWith(R + '/contents/')) {
      const f = p.slice((R + '/contents/').length);
      if (!Object.hasOwn(files, f) || files[f] === null) throw notFound(p);
      return { content: Buffer.from(files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?')) return { items: [apiIssue(1), apiIssue(2)], partial: false };
    if (p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    if (p === '/orgs/' + OWNER + '/projectsV2?per_page=100') return { items: [], partial: false };
    throw notFound(p);
  }
  return {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
}

function fakeCache() {
  const c = {
    stored: null,
    async readLastGood() { return c.stored; },
    async writeLastGood(b) { c.stored = structuredClone(b); },
    etags: { get() {}, set() {} },
  };
  return c;
}

// One whole run. `block` is the settings' calendar block as written (includeFile inside it), or undefined for none.
// `icloud` holds the VEVENT texts of the one iCloud calendar `Home`.
async function run({ block, file, icloud = [] }) {
  const cfg = settings(block === undefined ? {} : { calendar: block });
  const fake = fakeCalDav({ user: USER, password: PASS, calendars: [{ name: 'Home', ics: [vcalendar(...icloud)] }] });
  const calendar = createCalendarSource({ fetch: fake.fetch, login: LOGIN });
  const clock = { t: Date.parse(AT), now() { return clock.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-TOKEN-123' };
  const loader = createLoader({ http: makeHttp({ cfg, file }), env, cache: fakeCache(), clock, calendar });
  const out = await loader.load();
  assert.equal(out.ok, true, 'the load itself failed');
  const board = buildBoard({ ...out.bundle, now: AT });
  const html = renderPage(board, THEME, OPTS);
  return { board, html, fake, requests: fake.calls.map((c) => c.method + ' ' + c.url), panel: board.panels.calendar };
}

// ---- reading the board and the page ----
const warningsOf = (b) => b.meta.warnings;
const countOf = (b, code) => (warningsOf(b).find((w) => w.code === code) || { count: 0 }).count;
const rows = (panel) => panel.events.map((e) => [e.title, e.source]);

function calendarSection(html) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ name: m[1], start: html.lastIndexOf('<', m.index) }));
  const i = marks.findIndex((m) => m.name === 'calendar');
  assert.ok(i >= 0, 'the page has no calendar section');
  return html.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].start : html.length);
}
const ALLDAY_EL = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\sdata-allday(?=[\s=>\/])[^>]*>([\s\S]*?)<\/\1>/;
const SOURCE_EL = /<[a-zA-Z][a-zA-Z0-9]*\b[^>]*\sdata-source(?=[\s=>\/])[^>]*>([^<]*)</g;
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The timed events of the page, in the order shown: [title, word].
function pageEvents(html) {
  const section = calendarSection(html).replace(ALLDAY_EL, '');
  const titles = [...section.matchAll(/class="cal-event__title">([^<]*)</g)].map((m) => unesc(m[1]));
  const words = [...section.matchAll(SOURCE_EL)].map((m) => unesc(m[1]));
  assert.equal(words.length, titles.length, 'every event of the page needs exactly one data-source element');
  return titles.map((t, i) => [t, words[i]]);
}
// The all-day entries of the page, in the order shown: [title, word].
function pageAllDay(html) {
  const m = calendarSection(html).match(ALLDAY_EL);
  assert.ok(m, 'no data-allday element');
  const inner = m[2].replace(/<span class="cal-allday-label">[^<]*<\/span>/, '');
  return inner.split(' · ').map((seg) => {
    const word = [...seg.matchAll(SOURCE_EL)].map((x) => unesc(x[1]));
    assert.equal(word.length, 1, 'each all-day title needs one data-source element: ' + seg);
    return [unesc(seg.replace(/<[^>]*>/g, '').trim().slice(0, -word[0].length).trim()), word[0]];
  });
}
const head = (html) => {
  const m = calendarSection(html).match(/card__note">(\d+) events?</);
  assert.ok(m, 'no event count in the head of the calendar card');
  return Number(m[1]);
};

const copy = (v) => JSON.parse(JSON.stringify(v));
const withoutWarnings = (b) => { const c = copy(b); delete c.meta.warnings; return c; };

// ---------------------------------------------------------------- R109

const ONE_EACH = () => ({
  icloud: [iEv('Dentist', 630, 660)],
  file: { date: TODAY, events: [fEv('Standup', 540, 570)] },
});

async function threeSettings() {
  const given = ONE_EACH();
  return {
    absent: await run({ block: { ...BLOCK }, ...given }),
    off: await run({ block: { ...BLOCK, includeFile: false }, ...given }),
    yes: await run({ block: { ...BLOCK, includeFile: 'yes' }, ...given }),
  };
}

test('R109 absent, false and "yes" all show the iCloud event only, with no merged, fileDate or source and no data-source or data-filedate', async () => {
  const r = await threeSettings();
  for (const [name, x] of Object.entries(r)) {
    assert.deepEqual(x.panel.events.map((e) => e.title), ['Dentist'], name + ': iCloud event only');
    assert.equal(JSON.stringify(x.panel).includes('Standup'), false, name + ': the file event must not be in the panel');
    for (const key of ['merged', 'fileDate', 'source']) assert.equal(Object.hasOwn(x.panel, key), false, `${name}: the panel has ${key}`);
    for (const e of x.panel.events) assert.equal(Object.hasOwn(e, 'source'), false, name + ': an event has a source');
    const section = calendarSection(x.html);
    assert.ok(section.includes('Dentist'), name + ': the page shows the iCloud event');
    assert.equal(section.includes('Standup'), false, name + ': the page shows the file event');
    assert.equal(x.html.includes('data-source'), false, name + ': data-source in the page');
    assert.equal(x.html.includes('data-filedate'), false, name + ': data-filedate in the page');
  }
});

test('R109 includeFile absent and false give equal boards, equal pages and the same requests to Apple, byte for byte', async () => {
  const { absent, off } = await threeSettings();
  assert.deepEqual(off.board, absent.board);
  assert.equal(off.html, absent.html);
  assert.ok(absent.requests.length > 0, 'iCloud was never asked, so the comparison proves nothing');
  assert.deepEqual(off.requests, absent.requests);
  assert.equal(JSON.stringify(off.board), JSON.stringify(absent.board));
  assert.deepEqual(warningsOf(off.board), warningsOf(absent.board));
});

test('R109 includeFile "yes" reads as false: the same board, page and requests, apart from setting-invalid at 1', async () => {
  const { absent, yes } = await threeSettings();
  assert.equal(countOf(absent.board, 'setting-invalid'), 0);
  assert.equal(countOf(yes.board, 'setting-invalid'), 1);
  const expected = [...warningsOf(absent.board), { code: 'setting-invalid', count: 1 }].sort((a, b) => (a.code < b.code ? -1 : 1));
  assert.deepEqual(warningsOf(yes.board), expected);
  assert.deepEqual(withoutWarnings(yes.board), withoutWarnings(absent.board));
  assert.deepEqual(yes.panel, absent.panel);
  assert.equal(calendarSection(yes.html), calendarSection(absent.html));
  assert.deepEqual(yes.requests, absent.requests);
});

test('R109 includeFile true on a block R104 drops as a whole: the file\'s panel as R96 gives it, no merged, no request to Apple', async () => {
  const given = ONE_EACH();
  const dropped = { source: 'yahoo', calendars: BLOCK.calendars };
  const withKey = await run({ block: { ...dropped, includeFile: true }, ...given });
  const withoutKey = await run({ block: { ...dropped }, ...given });
  assert.deepEqual(withKey.panel.events.map((e) => e.title), ['Standup']);
  assert.equal(Object.hasOwn(withKey.panel, 'merged'), false);
  assert.equal(Object.hasOwn(withKey.panel, 'fileDate'), false);
  assert.equal(withKey.html.includes('data-source'), false);
  assert.deepEqual(withKey.board, withoutKey.board);
  assert.equal(withKey.html, withoutKey.html);
  assert.equal(withKey.requests.length, 0);
});

test('R109 includeFile true on a block with a non-object value is likewise read as no block: the file\'s panel, no merged', async () => {
  const given = ONE_EACH();
  const none = await run({ block: undefined, ...given });
  const bad = await run({ block: 'icloud', ...given });
  assert.deepEqual(bad.panel.events.map((e) => e.title), ['Standup']);
  assert.equal(Object.hasOwn(bad.panel, 'merged'), false);
  assert.deepEqual(bad.panel, none.panel);
});

// ---------------------------------------------------------------- R110

const ON = () => ({ ...BLOCK, includeFile: true });

test('R110 includeFile true, a usable block and a present file: the panel carries merged true and shows both sources', async () => {
  const r = await run({ block: ON(), ...ONE_EACH() });
  assert.equal(r.panel.merged, true);
  assert.deepEqual(r.panel.events.map((e) => e.title), ['Standup', 'Dentist']);
  assert.equal(r.panel.events.length, 2);
  assert.equal(r.html.includes('data-source'), true);
});

test('R110 a present file that fails its shape still makes the panel merged (the file is present, healthy or not)', async () => {
  const r = await run({ block: ON(), icloud: [iEv('Dentist', 630, 660)], file: { date: TODAY, events: 'not a list' } });
  assert.equal(r.panel.merged, true);
  assert.deepEqual(r.panel.events.map((e) => e.title), ['Dentist']);
});

test('R110 a present file with unreadable JSON still makes the panel merged', async () => {
  const r = await run({ block: ON(), icloud: [iEv('Dentist', 630, 660)], file: '{broken' });
  assert.equal(r.panel.merged, true);
  assert.deepEqual(r.panel.events.map((e) => e.title), ['Dentist']);
});

test('R110 includeFile true with a usable block and no file equals the panel built with includeFile false, no merged and no warning for the missing file', async () => {
  const icloud = [iEv('Dentist', 630, 660)];
  const on = await run({ block: ON(), icloud, file: null });
  const off = await run({ block: { ...BLOCK, includeFile: false }, icloud, file: null });
  assert.equal(Object.hasOwn(on.panel, 'merged'), false);
  assert.deepEqual(on.panel, off.panel);
  assert.deepEqual(on.panel.events.map((e) => e.title), ['Dentist']);
  assert.deepEqual(on.board, off.board);
  assert.equal(on.html, off.html);
  assert.equal(countOf(on.board, 'calendar-file-unreadable'), 0);
  assert.deepEqual(warningsOf(on.board), warningsOf(off.board));
});

test('R110 includeFile true and a block whose only entry has no usable name: the file\'s events only, no merged', async () => {
  const given = ONE_EACH();
  const r = await run({ block: { source: 'icloud', calendars: [{ name: ' ' }], includeFile: true }, ...given });
  assert.deepEqual(r.panel.events.map((e) => e.title), ['Standup']);
  assert.equal(Object.hasOwn(r.panel, 'merged'), false);
  assert.equal(r.html.includes('data-source'), false);
  assert.equal(r.requests.length, 0, 'the connector is off, so nothing goes to Apple');
});

test('R110 includeFile true and a block with an empty list of calendars: the file\'s events only, no merged', async () => {
  const r = await run({ block: { source: 'icloud', calendars: [], includeFile: true }, ...ONE_EACH() });
  assert.deepEqual(r.panel.events.map((e) => e.title), ['Standup']);
  assert.equal(Object.hasOwn(r.panel, 'merged'), false);
});

test('R110 includeFile true and no block at all: the file alone, no merged', async () => {
  const r = await run({ block: undefined, ...ONE_EACH() });
  assert.deepEqual(r.panel.events.map((e) => e.title), ['Standup']);
  assert.equal(Object.hasOwn(r.panel, 'merged'), false);
});

// ---------------------------------------------------------------- R111

test('R111 timed events from both sources are one list in the order of start, end, title, an iCloud tie first: Y, Z, A, B (iCloud), B (file)', async () => {
  const r = await run({
    block: ON(),
    icloud: [iEv('B', 540, 600), iEv('Z', 480, 510)],
    file: { date: TODAY, events: [fEv('A', 540, 600), fEv('B', 540, 600), fEv('Y', 420, 435)] },
  });
  const want = [['Y', 'File'], ['Z', 'iCloud'], ['A', 'File'], ['B', 'iCloud'], ['B', 'File']];
  assert.equal(r.panel.merged, true);
  assert.deepEqual(rows(r.panel), want);
  assert.deepEqual(pageEvents(r.html), want);
  assert.equal(head(r.html), 5);
});

test('R111 20 timed events from each source: 30 shown, the first 30 in order, and the head says 30', async () => {
  const icloud = []; const events = [];
  for (let k = 0; k < 20; k++) {
    icloud.push(iEv('I' + two(k), 360 + 40 * k, 375 + 40 * k));
    events.push(fEv('F' + two(k), 380 + 40 * k, 395 + 40 * k));
  }
  const r = await run({ block: ON(), icloud, file: { date: TODAY, events } });
  const want = [];
  for (let k = 0; k < 15; k++) { want.push(['I' + two(k), 'iCloud']); want.push(['F' + two(k), 'File']); }
  assert.equal(r.panel.events.length, 30);
  assert.deepEqual(rows(r.panel), want);
  assert.deepEqual(pageEvents(r.html), want);
  assert.equal(head(r.html), 30);
});

test('R111 20 timed events from each source with the file all earlier: the cut keeps the file\'s 20 and iCloud\'s first 10', async () => {
  const icloud = []; const events = [];
  for (let k = 0; k < 20; k++) {
    events.push(fEv('F' + two(k), 360 + 20 * k, 370 + 20 * k));
    icloud.push(iEv('I' + two(k), 780 + 20 * k, 790 + 20 * k));
  }
  const r = await run({ block: ON(), icloud, file: { date: TODAY, events } });
  assert.equal(r.panel.events.length, 30);
  assert.deepEqual(r.panel.events.map((e) => e.title), [
    ...events.map((e) => e.title),
    ...Array.from({ length: 10 }, (_, k) => 'I' + two(k)),
  ]);
  assert.equal(head(r.html), 30);
});

test('R111 all-day entries from both sources are one list in order of title, an iCloud tie first: Day off, Trip (iCloud), Trip (file)', async () => {
  const r = await run({
    block: ON(),
    icloud: [iDay('Trip')],
    file: { date: TODAY, events: [], allDay: [{ title: 'Trip' }, { title: 'Day off' }] },
  });
  const want = [['Day off', 'File'], ['Trip', 'iCloud'], ['Trip', 'File']];
  assert.equal(r.panel.merged, true);
  assert.deepEqual(r.panel.allDay.map((a) => [a.title, a.source]), want);
  assert.deepEqual(pageAllDay(r.html), want);
});

test('R111 8 all-day entries from each source: 10 shown, the first 10 by title', async () => {
  const icloud = []; const allDay = [];
  for (let k = 1; k <= 16; k++) {
    const title = 'Day ' + two(k);
    if (k % 2 === 1) icloud.push(iDay(title)); else allDay.push({ title });
  }
  const r = await run({ block: ON(), icloud, file: { date: TODAY, events: [], allDay } });
  const want = Array.from({ length: 10 }, (_, k) => ['Day ' + two(k + 1), (k + 1) % 2 === 1 ? 'iCloud' : 'File']);
  assert.equal(r.panel.allDay.length, 10);
  assert.deepEqual(r.panel.allDay.map((a) => [a.title, a.source]), want);
  assert.deepEqual(pageAllDay(r.html), want);
});

test('R111 the all-day entries do not count in the head, which counts the timed events shown', async () => {
  const r = await run({
    block: ON(),
    icloud: [iEv('Dentist', 630, 660), iDay('Trip')],
    file: { date: TODAY, events: [fEv('Standup', 540, 570)], allDay: [{ title: 'Day off' }] },
  });
  assert.equal(r.panel.events.length, 2);
  assert.equal(head(r.html), 2);
});

// ---------------------------------------------------------------- R115

test('R115 the same event in both sources is listed twice, words iCloud and File, and the head counts both', async () => {
  const r = await run({
    block: ON(),
    icloud: [iEv('Review', 600, 660)],
    file: { date: TODAY, events: [fEv('Review', 600, 660)] },
  });
  const want = [['Review', 'iCloud'], ['Review', 'File']];
  assert.equal(r.panel.merged, true);
  assert.equal(r.panel.events.length, 2);
  assert.deepEqual(rows(r.panel), want);
  assert.deepEqual(pageEvents(r.html), want);
  assert.equal(head(r.html), 2);
});

test('R115 an event in both sources counts twice in the cap of 30: 16 shared events give 30 shown, iCloud first in each pair', async () => {
  const icloud = []; const events = [];
  for (let k = 0; k < 16; k++) {
    icloud.push(iEv('Shared ' + two(k), 360 + 40 * k, 375 + 40 * k));
    events.push(fEv('Shared ' + two(k), 360 + 40 * k, 375 + 40 * k));
  }
  const r = await run({ block: ON(), icloud, file: { date: TODAY, events } });
  const want = [];
  for (let k = 0; k < 15; k++) { want.push(['Shared ' + two(k), 'iCloud']); want.push(['Shared ' + two(k), 'File']); }
  assert.equal(r.panel.events.length, 30);
  assert.deepEqual(rows(r.panel), want);
  assert.equal(head(r.html), 30);
});

test('R115 the same all-day title in both sources is listed twice as well', async () => {
  const r = await run({
    block: ON(),
    icloud: [iDay('Holiday')],
    file: { date: TODAY, events: [], allDay: [{ title: 'Holiday' }] },
  });
  assert.deepEqual(r.panel.allDay.map((a) => [a.title, a.source]), [['Holiday', 'iCloud'], ['Holiday', 'File']]);
});

// ---------------------------------------------------------------- helper

test('U the harness reads the word of each timed event and all-day entry from a hand-written page', () => {
  const html = '<section data-section="calendar"><div class="card__head"><span class="card__note">2 events</span></div>'
    + '<p class="cal-allday" data-allday><span class="cal-allday-label">All day</span> Trip<span data-source>iCloud</span> · Trip<span data-source>File</span></p>'
    + '<div><span class="cal-event__title">A</span><span data-source>iCloud</span></div>'
    + '<div><span class="cal-event__title">A</span><span data-source>File</span></div></section>';
  assert.deepEqual(pageEvents(html), [['A', 'iCloud'], ['A', 'File']]);
  assert.deepEqual(pageAllDay(html), [['Trip', 'iCloud'], ['Trip', 'File']]);
  assert.equal(head(html), 2);
});

// ---------------------------------------------------------------- R109 at the model: the second guard

import { raw as rawFx, state as stateFx } from '../fixtures/build.mjs';

// A bundle whose state carries both an iCloud-shaped calendar and a healthy file value under calendarFile.
function modelBoard({ include, withFile }) {
  const block = { ...BLOCK };
  if (include !== undefined) block.includeFile = include;
  const st = stateFx({
    calendar: { date: TODAY, events: [{ title: 'Dentist', start: '10:30', end: '11:00', kind: 'personal' }] },
    ...(withFile ? { calendarFile: { date: TODAY, events: [{ title: 'Standup', start: '09:00', end: '09:30', kind: 'meeting' }], allDay: [{ title: 'Day off' }] } } : {}),
  });
  const board = buildBoard({ raw: rawFx(), settings: settings({ calendar: block }), state: st, now: AT });
  return { board, html: renderPage(board, THEME, OPTS) };
}

for (const [label, include] of [['absent', undefined], ['false', false], ['"yes"', 'yes']]) {
  test(`R109 model: with includeFile ${label} a calendarFile in the state changes nothing: iCloud events only, no merged, source, fileDate or fileSource`, () => {
    const a = modelBoard({ include, withFile: true });
    const b = modelBoard({ include, withFile: false });
    const p = a.board.panels.calendar;
    assert.deepEqual(p.events.map((e) => e.title), ['Dentist']);
    assert.equal(JSON.stringify(p).includes('Standup'), false);
    assert.equal(JSON.stringify(p).includes('Day off'), false);
    for (const key of ['merged', 'source', 'fileDate', 'fileSource']) assert.equal(Object.hasOwn(p, key), false, 'panel has ' + key);
    for (const e of p.events) assert.equal(Object.hasOwn(e, 'source'), false);
    assert.equal(a.html.includes('data-source'), false);
    assert.equal(a.html.includes('data-filedate'), false);
    assert.deepEqual(a.board, b.board);
    assert.equal(a.html, b.html);
  });
}
