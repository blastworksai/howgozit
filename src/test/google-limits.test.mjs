// Tests of the limits and the failure behaviour of the Google calendar source: R122 (what is read, and the
// limits), R123 (asked at the same time, reused, limits on time, the rest after a failure) and R124 (what is kept
// when a calendar cannot be read), written from the contract before the code exists, against the invented Google
// of fixtures/fake-google-ical.mjs. board/calendar/google.mjs does not exist yet and is reached lazily inside a
// helper, so each test fails by itself.
//
// Time: the rules' seconds are the defaults (12000 and 8000 ms). The timing tests pass budgetMs 120 and requestMs 80
// and scale the rule's ratios. The five-minute and one-minute rules are driven by the `now` handed to each read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { settings } from '../fixtures/build.mjs';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { fakeGoogleIcal, icsFeed, padTo } from '../fixtures/fake-google-ical.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const AT = '2026-10-12T06:10:00.900Z';
const TZ = 'Europe/Brussels';
const OTHER_TZ = 'America/New_York';
const MIN = 60 * 1000;
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const GOOGLE_SENTENCE = 'The calendar could not be read from Google. See the note at the foot of the page.';

const addressFor = (name) => `https://calendar.google.com/calendar/ical/${name}%40example.invalid/private-0123456789abcdef/basic.ics`;
const HOME = addressFor('home');
const WORK = addressFor('work');
const BUDGET = 1000; // the stand-in for twelve seconds (whole read)
const REQUEST = 400; // the stand-in for eight seconds (one request)
// Only one-sided, generous bounds on elapsed time are asserted: jitter on a loaded host is small beside these.

// ---- lazy reach into what does not exist yet ----

async function googleModule() {
  const mod = await import('../board/calendar/google.mjs');
  assert.equal(typeof mod.createGoogleSource, 'function', 'board/calendar/google.mjs does not export createGoogleSource');
  return mod;
}

// ---- givens ----

const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const two = (n) => String(n).padStart(2, '0');
// Minutes after 00:00 UTC on 12 October 2026 (Brussels is UTC+2), as an iCalendar UTC time.
const z = (min) => `20261012T${two(Math.floor(min / 60))}${two(min % 60)}00Z`;
const ev = (title, startMin, endMin, more = {}) => ({ title, start: z(startMin), end: z(endMin), ...more });
const feedOf = (title, startMin, endMin, more) => icsFeed([ev(title, startMin, endMin, more)]);
const entry = (name, place, kind = 'meeting') => ({ name, kind, place });
const row = (title, start, end, kind = 'meeting') => ({ title, start, end, kind });
const warn = (code, names) => ({ code, count: names.length, names });
const warnings = (out, code) => out.warnings.filter((w) => w.code === code);
const titles = (out) => out.value.events.map((e) => e.title);
const dayOf = (offset) => new Date(Date.UTC(2026, 0, 1) + offset * 86400000).toISOString().slice(0, 10).replaceAll('-', '');

const DENTIST = row('Dentist', '10:00', '11:00', 'personal');
const STANDUP = row('Standup', '09:00', '09:30', 'focus');
const HOME_E = entry('Home', 1, 'personal');
const WORK_E = entry('Work', 2, 'focus');
const BOTH = [HOME_E, WORK_E];

// A source over a stand-in. `fetch` is a wrapper that records the order of starts and answers, and the signals.
async function rig(feeds, addresses, opts = {}) {
  const { createGoogleSource } = await googleModule();
  const fake = fakeGoogleIcal({ feeds });
  const log = [];
  const signals = [];
  const wrapped = (input, init) => {
    log.push('start');
    signals.push({ url: String(input), signal: init?.signal });
    return Promise.resolve(fake(input, init)).then(
      (r) => { log.push('answer'); return r; },
      (e) => { log.push('answer'); throw e; },
    );
  };
  const source = createGoogleSource({ fetch: wrapped, addresses, budgetMs: 800, requestMs: 400, ...opts });
  const ask = (calendars = [HOME_E], now = AT, tz = TZ) => source.read({ calendars, tz, now });
  return { fake, source, ask, log, signals };
}
const timed = { budgetMs: BUDGET, requestMs: REQUEST };
const LOOSE = 3 * BUDGET; // 'ended before three times the budget'
const calls = (fake, url) => fake.calls.filter((c) => c.url === url).length;

// ---- the big feeds, built once per file ----

const TODAY_EVENT = vevent({ uid: 'today-one', summary: 'Today one', start: z(480), end: z(540) });
const otherDay = (i) => vevent({ uid: `o${i}@example.invalid`, summary: `Other ${i}`, start: '20261013T100000Z', end: '20261013T110000Z' });
const OTHERS = Array.from({ length: 20000 }, (_, i) => otherDay(i));
const withOthers = (n) => vcalendar(TODAY_EVENT, ...OTHERS.slice(0, n));
const FEED_2001 = withOthers(2000);
const FEED_20000 = withOthers(19999);
const FEED_20001 = withOthers(20000);
const countEvents = (text) => text.split('BEGIN:VEVENT').length - 1;

// A repeating series with N-1 changed occurrences: N events in all, each changed occurrence on another day.
function seriesWithChanges(total) {
  const parts = [vevent({ uid: 'series', summary: 'Series', start: '20260101T080000Z', end: '20260101T083000Z', rrule: 'FREQ=DAILY' })];
  for (let i = 0; i < total - 1; i += 1) {
    const day = dayOf(300 + i);
    parts.push(vevent({ uid: 'series', summary: `Moved ${i}`, start: `${day}T090000Z`, end: `${day}T093000Z`, recurrenceId: `${day}T080000Z` }));
  }
  return vcalendar(...parts);
}

const ONE_TODAY = feedOf('Edge', 480, 540);
const BYTES_OK = padTo(ONE_TODAY, 10_000_000);
const BYTES_OVER = padTo(ONE_TODAY, 10_000_001);
const MULTIBYTE = ONE_TODAY.replace('END:VCALENDAR', `X-PAD:${'é'.repeat(5_100_000)}\r\nEND:VCALENDAR`); // 5.1 million characters, 10.2 million bytes

test('U the big feeds hold the counts and the sizes the tests claim', () => {
  assert.equal(countEvents(FEED_2001), 2001);
  assert.equal(countEvents(FEED_20000), 20000);
  assert.equal(countEvents(FEED_20001), 20001);
  assert.ok(Buffer.byteLength(FEED_20001) < 3_000_000, 'the 20,001-event feed must stay cheap');
  assert.equal(Buffer.byteLength(BYTES_OK), 10_000_000);
  assert.equal(Buffer.byteLength(BYTES_OVER), 10_000_001);
  assert.ok(MULTIBYTE.length < 10_000_000 && Buffer.byteLength(MULTIBYTE) > 10_000_000, 'characters under the limit, bytes over it');
  assert.equal(countEvents(seriesWithChanges(20000)), 20000);
  assert.equal(countEvents(seriesWithChanges(20001)), 20001);
});

// ======================= R122: what is read, and the limits =======================

test('R122 one event today and 2,000 events on other days: only today\'s is shown, no warning', async () => {
  const { ask } = await rig({ [HOME]: FEED_2001 }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.value.events, [row('Today one', '10:00', '11:00', 'personal')], 'expected only the event of today (12 October, Brussels), with the kind of its calendar entry (personal)');
  assert.equal(!!out.value.stale, false);
  assert.deepEqual(out.warnings, []);
});

test('R122 20,000 events (19,999 on other days and one today) are read: the one event shows, no calendar-google-too-large', async () => {
  const { ask } = await rig({ [HOME]: FEED_20000 }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(titles(out), ['Today one'], 'expected the event at the limit (20,000) to be read');
  assert.deepEqual(warnings(out, 'calendar-google-too-large'), []);
});

test('R122 20,001 events: that calendar is not shown and calendar-google-too-large is raised at 1', async () => {
  const { ask } = await rig({ [HOME]: FEED_20001 }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.value, { error: 'unreadable' }, 'expected the only calendar, 20,001 events, to be absent (nothing read, nothing kept)');
  assert.deepEqual(out.warnings, [warn('calendar-google-too-large', ['Home'])]);
});

test('R122 a changed occurrence of a repeating event counts as one event: 20,000 in all are read, 20,001 are too large', async () => {
  const ok = await rig({ [HOME]: seriesWithChanges(20000) }, { 1: HOME });
  const read = await ok.ask();
  assert.deepEqual(titles(read), ['Series'], 'expected 20,000 BEGIN:VEVENT (one series, 19,999 changes) to be read');
  assert.deepEqual(warnings(read, 'calendar-google-too-large'), []);
  const big = await rig({ [HOME]: seriesWithChanges(20001) }, { 1: HOME });
  const over = await big.ask();
  assert.deepEqual(over.warnings.filter((w) => w.code === 'calendar-google-too-large'), [warn('calendar-google-too-large', ['Home'])], 'expected 20,001 BEGIN:VEVENT, changed occurrences included, to be too large');
  assert.deepEqual(over.value, { error: 'unreadable' });
});

test('R122 an answer of exactly 10,000,000 bytes that is a calendar with one event today is read', async () => {
  const { ask } = await rig({ [HOME]: BYTES_OK }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(titles(out), ['Edge'], 'expected the 10,000,000-byte answer to be read');
  assert.deepEqual(out.warnings, []);
});

test('R122 an answer of 10,000,001 bytes is too large and that calendar is absent', async () => {
  const { ask } = await rig({ [HOME]: BYTES_OVER }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-too-large', ['Home'])]);
  assert.deepEqual(out.value, { error: 'unreadable' });
});

test('R122 bytes are counted, not characters: 5.1 million two-byte characters are over the limit', async () => {
  const { ask } = await rig({ [HOME]: MULTIBYTE }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-too-large', ['Home'])], 'expected 10.2 million bytes (under 10 million characters) to be too large');
});

test('R122 a Content-Length that says small does not let a 10,000,001-byte answer through', async () => {
  const { ask } = await rig({ [HOME]: { status: 200, headers: { 'content-length': '1000', 'content-type': 'text/calendar' }, body: BYTES_OVER } }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-too-large', ['Home'])], 'expected the bytes that arrive to be counted, whatever Content-Length says');
});

test('R122 a Content-Length that says large does not refuse a small calendar: only the bytes that arrive are counted', async () => {
  const { ask } = await rig({ [HOME]: { status: 200, headers: { 'content-length': '99999999', 'content-type': 'text/calendar' }, body: ONE_TODAY } }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(titles(out), ['Edge'], 'expected a small calendar claiming 99,999,999 bytes to be read');
  assert.deepEqual(out.warnings, []);
});

test('R122 an endless stream with no Content-Length is too large and the stream is cancelled soon after 10,000,000 bytes', async () => {
  const { ask, fake } = await rig({ [HOME]: { stream: true } }, { 1: HOME }, { budgetMs: 8000, requestMs: 6000 });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-too-large', ['Home'])], 'expected calendar-google-too-large for an endless stream');
  assert.equal(fake.streams.length, 1);
  const s = fake.streams[0];
  assert.equal(s.cancelled, true, 'expected the stream to be cancelled');
  assert.ok(s.sent >= 10_000_000, `expected the cut-off only after 10,000,000 bytes had been sent, sent ${s.sent}`);
  assert.ok(s.sent <= 10_000_000 + 1_048_576, `expected the stream to be cancelled soon after 10,000,000 bytes, sent ${s.sent}`);
});

test('R122 an endless stream with a small Content-Length is cut off all the same', async () => {
  const { ask, fake } = await rig({ [HOME]: { stream: true, headers: { 'content-length': '500' } } }, { 1: HOME }, { budgetMs: 8000, requestMs: 6000 });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-too-large', ['Home'])]);
  assert.equal(fake.streams[0].cancelled, true);
  assert.ok(fake.streams[0].sent <= 10_000_000 + 1_048_576, `sent ${fake.streams[0].sent}`);
});

test('R122 status 200 with Content-Type text/calendar and an HTML body is not a calendar', async () => {
  const html = '<!doctype html><html><head><title>Sign in</title></head><body>Sign in to continue</body></html>';
  const { ask } = await rig({ [HOME]: { status: 200, headers: { 'content-type': 'text/calendar' }, body: html } }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-not-a-calendar', ['Home'])]);
  assert.deepEqual(out.value, { error: 'unreadable' });
});

test('R122 status 200 with Content-Type text/html and a calendar body is read: the type is not consulted', async () => {
  const { ask } = await rig({ [HOME]: { status: 200, headers: { 'content-type': 'text/html' }, body: feedOf('Typed wrong', 480, 540) } }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(titles(out), ['Typed wrong'], 'expected a calendar body to be read whatever its Content-Type says');
  assert.deepEqual(out.warnings, []);
});

test('R122 an answer that starts right but stops before END:VCALENDAR is not a calendar', async () => {
  const cut = feedOf('Cut', 480, 540).replace(/END:VCALENDAR\r\n$/, '');
  const { ask } = await rig({ [HOME]: cut }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-not-a-calendar', ['Home'])]);
  assert.deepEqual(out.value, { error: 'unreadable' });
});

test('R122 a 204 with no body is not a calendar', async () => {
  const { ask } = await rig({ [HOME]: { status: 204 } }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-not-a-calendar', ['Home'])]);
});

test('R122 any other 2xx status is not a calendar, even with a calendar body', async () => {
  for (const status of [201, 202, 203, 206]) {
    const { ask } = await rig({ [HOME]: { status, body: feedOf('Wrong status', 480, 540) } }, { 1: HOME });
    const out = await ask();
    assert.deepEqual(out.warnings, [warn('calendar-google-not-a-calendar', ['Home'])], `expected status ${status} to be not a calendar`);
    assert.deepEqual(out.value, { error: 'unreadable' }, String(status));
  }
});

test('R122 an empty body with status 200 is not a calendar and not an empty day', async () => {
  const { ask } = await rig({ [HOME]: { status: 200, body: '' } }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-not-a-calendar', ['Home'])]);
  assert.deepEqual(out.value, { error: 'unreadable' });
});

test('R122 a byte-order mark and whitespace before BEGIN:VCALENDAR are allowed', async () => {
  for (const lead of ['﻿', '﻿\r\n  \t\n', '\r\n\r\n ']) {
    const { ask } = await rig({ [HOME]: { status: 200, body: lead + feedOf('Lead', 480, 540) } }, { 1: HOME });
    const out = await ask();
    assert.deepEqual(titles(out), ['Lead'], `expected the lead ${JSON.stringify(lead)} to be skipped`);
    assert.deepEqual(out.warnings, []);
  }
});

test('R122 anything else before BEGIN:VCALENDAR makes it not a calendar', async () => {
  for (const lead of ['<!-- -->\r\n', 'x', '​']) {
    const { ask } = await rig({ [HOME]: { status: 200, body: lead + feedOf('Lead', 480, 540) } }, { 1: HOME });
    const out = await ask();
    assert.deepEqual(out.warnings, [warn('calendar-google-not-a-calendar', ['Home'])], `expected the lead ${JSON.stringify(lead)} to refuse the answer`);
  }
});

test('R122 BEGIN:VCALENDAR is read without regard to letter case', async () => {
  const lower = feedOf('Lower', 480, 540).replace('BEGIN:VCALENDAR', 'begin:vcalendar');
  const { ask } = await rig({ [HOME]: lower }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(titles(out), ['Lower'], 'expected a lower-case first line to be accepted');
});

test('R122 END:VCALENDAR must be a line: the words inside another line do not count', async () => {
  const noEnd = feedOf('Fake end', 480, 540).replace(/END:VCALENDAR\r\n$/, 'X-NOTE:END:VCALENDAR\r\n');
  const { ask } = await rig({ [HOME]: noEnd }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.warnings, [warn('calendar-google-not-a-calendar', ['Home'])], 'expected END:VCALENDAR inside another line not to count');
});

test('R122 a calendar with no VEVENT is an empty day: stale false, no warning, and not a failure', async () => {
  const { ask } = await rig({ [HOME]: vcalendar() }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.value.events, []);
  assert.equal(out.value.date, '2026-10-12');
  assert.equal(!!out.value.stale, false);
  assert.deepEqual(out.warnings, []);
});

test('R122 the whole feed is read and only today is kept (yesterday, tomorrow and a series held today)', async () => {
  const feed = icsFeed([
    { title: 'Yesterday', start: '20261011T090000Z', end: '20261011T100000Z' },
    ev('Today', 480, 540),
    { title: 'Tomorrow', start: '20261013T090000Z', end: '20261013T100000Z' },
    { title: 'Weekly review', start: '20260928T090000', end: '20260928T100000', tzid: TZ, rrule: 'FREQ=WEEKLY;BYDAY=MO' },
  ]);
  const { ask } = await rig({ [HOME]: feed }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(out.value.events.map((e) => [e.title, e.start]), [['Weekly review', '09:00'], ['Today', '10:00']]);
  assert.deepEqual(out.warnings, []);
});

test('R122 calendar-event-skipped and calendar-zone-unknown are raised as in R98 and R99 and summed over the calendars', async () => {
  const hourly = (title, at) => ({ title, start: z(at), end: z(at + 30), rrule: 'FREQ=HOURLY' });
  const odd = (title) => ({ title, start: '20261012T100000', end: '20261012T110000', tzid: 'Mars/Olympus' });
  const { ask } = await rig(
    { [HOME]: icsFeed([hourly('Hourly one', 420), odd('Odd one')]), [WORK]: icsFeed([hourly('Hourly two', 480), odd('Odd two')]) },
    { 1: HOME, 2: WORK },
  );
  const out = await ask(BOTH);
  assert.deepEqual(warnings(out, 'calendar-event-skipped'), [{ code: 'calendar-event-skipped', count: 2 }], 'expected the skipped events summed over both calendars');
  assert.deepEqual(warnings(out, 'calendar-zone-unknown'), [{ code: 'calendar-zone-unknown', count: 2 }], 'expected the unknown zones summed over both calendars');
  assert.equal(Object.hasOwn(warnings(out, 'calendar-event-skipped')[0], 'names'), false, 'only the six calendar-google warnings carry names');
});

test('R122 two calendars where one is over the limit: the other is shown, stale is true, calendar-google-too-large at 1', async () => {
  const { ask } = await rig({ [HOME]: FEED_20001, [WORK]: feedOf('Standup', 420, 450) }, { 1: HOME, 2: WORK });
  const out = await ask(BOTH);
  assert.deepEqual(out.value.events, [STANDUP], 'expected the other calendar\'s events to be shown');
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.warnings, [warn('calendar-google-too-large', ['Home'])]);
});

test('R122 two calendars where one is not a calendar: the other is shown, stale is true, calendar-google-not-a-calendar at 1', async () => {
  const { ask } = await rig({ [HOME]: { status: 200, body: '<html></html>' }, [WORK]: feedOf('Standup', 420, 450) }, { 1: HOME, 2: WORK });
  const out = await ask(BOTH);
  assert.deepEqual(out.value.events, [STANDUP]);
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.warnings, [warn('calendar-google-not-a-calendar', ['Home'])]);
});

// ======================= R123: asked together, reused, limited =======================

const FIVE = ['one', 'two', 'three', 'four', 'five'].map((n, i) => ({ name: `Cal ${n}`, address: addressFor(n), entry: entry(`Cal ${n}`, i + 1) }));
const fiveAddresses = Object.fromEntries(FIVE.map((c, i) => [i + 1, c.address]));
const fiveEntries = FIVE.map((c) => c.entry);
const fiveFeeds = (make) => Object.fromEntries(FIVE.map((c, i) => [c.address, make(c, i)]));

test('R123 five calendars are asked at the same time: all five requests start before the first is answered', async () => {
  const { ask, log, fake } = await rig(fiveFeeds((c, i) => ({ delayMs: 300, status: 200, body: feedOf(`Event ${i}`, 420 + i * 60, 450 + i * 60) })), fiveAddresses, { budgetMs: 2000, requestMs: 1500 });
  const t0 = Date.now();
  const out = await ask(fiveEntries);
  const elapsed = Date.now() - t0;
  assert.equal(fake.calls.length, 5);
  assert.deepEqual(log.slice(0, 5), ['start', 'start', 'start', 'start', 'start'], `expected five starts before any answer, saw ${log.join(',')}`);
  assert.equal(out.value.events.length, 5);
  assert.deepEqual(out.warnings, []);
  // The order of starts above is the proof. A loose second check: five 300 ms answers one after another would take 1500 ms or more.
  assert.ok(elapsed < 1200, `expected five 300 ms calendars asked together to end well before 1500 ms, took ${elapsed} ms`);
});

test('R123 two reads started together for the same day, timezone and calendars share one request per calendar and answer alike', async () => {
  const { ask, fake, log } = await rig({ [HOME]: { delayMs: 40, body: feedOf('Dentist', 480, 540), status: 200 }, [WORK]: { delayMs: 40, body: feedOf('Standup', 420, 450), status: 200 } }, { 1: HOME, 2: WORK });
  const [a, b] = await Promise.all([ask(BOTH), ask(BOTH)]);
  assert.equal(fake.calls.length, 2, `expected one request per calendar, saw ${fake.calls.length}`);
  assert.equal(log.filter((x) => x === 'start').length, 2);
  assert.deepEqual(a, b);
  assert.deepEqual(a.value.events, [STANDUP, DENTIST]);
});

test('R123 a read in flight is not shared with a caller asking for other calendars, another timezone or another day', async () => {
  const feeds = { [HOME]: { delayMs: 40, status: 200, body: feedOf('Dentist', 480, 540) }, [WORK]: { delayMs: 40, status: 200, body: feedOf('Standup', 420, 450) } };
  const addresses = { 1: HOME, 2: WORK };
  const cases = [
    ['other calendars', (ask) => ask([HOME_E], AT, TZ), 3],
    ['another timezone', (ask) => ask(BOTH, AT, OTHER_TZ), 4],
    ['another day', (ask) => ask(BOTH, plus(AT, 24 * 60 * MIN), TZ), 4],
  ];
  for (const [label, second, expected] of cases) {
    const { ask, fake } = await rig(feeds, addresses);
    await Promise.all([ask(BOTH), second(ask)]);
    assert.equal(fake.calls.length, expected, `${label}: expected ${expected} requests in all, saw ${fake.calls.length}`);
  }
});

test('R123 two reads one minute apart send requests for the first only and answer alike', async () => {
  const { ask, fake } = await rig({ [HOME]: feedOf('Dentist', 480, 540), [WORK]: feedOf('Standup', 420, 450) }, { 1: HOME, 2: WORK });
  const first = await ask(BOTH, AT);
  assert.equal(fake.calls.length, 2);
  fake.feeds[HOME] = feedOf('Changed', 480, 540);
  const second = await ask(BOTH, plus(AT, MIN));
  assert.equal(fake.calls.length, 2, 'expected no request at all for the read one minute later');
  assert.deepEqual(second, first);
});

test('R123 a read six minutes after the first asks again, for every calendar', async () => {
  const { ask, fake } = await rig({ [HOME]: feedOf('Dentist', 480, 540), [WORK]: feedOf('Standup', 420, 450) }, { 1: HOME, 2: WORK });
  await ask(BOTH, AT);
  fake.feeds[HOME] = feedOf('Changed', 480, 540);
  const later = await ask(BOTH, plus(AT, 6 * MIN));
  assert.equal(fake.calls.length, 4, `expected new requests after six minutes, saw ${fake.calls.length} in all`);
  assert.deepEqual(later.value.events.map((e) => e.title), ['Standup', 'Changed']);
});

test('R123 four minutes after the first the answer is still reused', async () => {
  const { ask, fake } = await rig({ [HOME]: feedOf('Dentist', 480, 540) }, { 1: HOME });
  await ask([HOME_E], AT);
  await ask([HOME_E], plus(AT, 4 * MIN));
  assert.equal(fake.calls.length, 1);
});

test('R123 a read after the date has changed asks again, even four minutes later', async () => {
  const { ask, fake } = await rig({ [HOME]: feedOf('Dentist', 480, 540) }, { 1: HOME });
  await ask([HOME_E], '2026-10-12T21:58:00.000Z'); // 23:58 in Brussels
  const next = await ask([HOME_E], '2026-10-12T22:02:00.000Z'); // 00:02 on the 13th in Brussels
  assert.equal(fake.calls.length, 2, 'expected new requests when the board date has changed');
  assert.equal(next.value.date, '2026-10-13');
});

test('R123 a changed timezone, calendars list, kind or place within five minutes is a fresh read', async () => {
  const feeds = { [HOME]: feedOf('Dentist', 480, 540), [WORK]: feedOf('Standup', 420, 450) };
  const addresses = { 1: HOME, 2: WORK };
  const variants = [
    ['timezone', [HOME_E], TZ, [HOME_E], OTHER_TZ, 2],
    ['calendars list', [HOME_E], TZ, BOTH, TZ, 3],
    ['kind', [HOME_E], TZ, [entry('Home', 1, 'habit')], TZ, 2],
    ['place', [HOME_E], TZ, [entry('Home', 2, 'personal')], TZ, 2],
  ];
  for (const [label, first, tz1, second, tz2, expected] of variants) {
    const { ask, fake } = await rig(feeds, addresses);
    await ask(first, AT, tz1);
    await ask(second, plus(AT, MIN), tz2);
    assert.equal(fake.calls.length, expected, `${label}: expected a fresh read (${expected} requests in all), saw ${fake.calls.length}`);
  }
});

test('R123 one calendar that never answers fails within its limit, the others are shown, and its request is aborted', async () => {
  const feeds = fiveFeeds((c, i) => (i === 2 ? { never: true } : feedOf(`Event ${i}`, 420 + i * 60, 450 + i * 60)));
  const { ask, signals } = await rig(feeds, fiveAddresses, timed);
  const t0 = Date.now();
  const out = await ask(fiveEntries);
  const elapsed = Date.now() - t0;
  assert.deepEqual(warnings(out, 'calendar-google-unreachable'), [warn('calendar-google-unreachable', ['Cal three'])]);
  assert.deepEqual(titles(out), ['Event 0', 'Event 1', 'Event 3', 'Event 4']);
  assert.equal(out.value.stale, true);
  // Rule: that calendar fails within 8 s, inside the whole read's 12 s. Scaled: about 80 ms, always under 120 ms.
  assert.ok(elapsed < LOOSE, `expected the read to end before ${LOOSE} ms, took ${elapsed} ms`);
  const silent = signals.find((s) => s.url === FIVE[2].address);
  assert.equal(silent.signal?.aborted, true, 'expected the request of the silent calendar to have been aborted');
});

test('R123 a calendar that answers after its limit is a read Google did not answer; one that answers before it is used', async () => {
  const { ask } = await rig({ [HOME]: { delayMs: REQUEST + 600, status: 200, body: feedOf('Late', 480, 540) }, [WORK]: { status: 200, body: feedOf('In time', 420, 450) } }, { 1: HOME, 2: WORK }, timed);
  const out = await ask(BOTH);
  assert.deepEqual(titles(out), ['In time']);
  assert.deepEqual(out.warnings, [warn('calendar-google-unreachable', ['Home'])]);
});

test('R123 all five never answering: the read ends within the whole-read limit, all five unreachable', async () => {
  const { ask } = await rig(fiveFeeds(() => ({ never: true })), fiveAddresses, timed);
  const t0 = Date.now();
  const out = await ask(fiveEntries);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < LOOSE, `expected the read to end before ${LOOSE} ms, took ${elapsed} ms`);
  assert.deepEqual(out.warnings, [warn('calendar-google-unreachable', fiveEntries.map((e) => e.name))]);
  assert.deepEqual(out.value, { error: 'unreadable' });
});

test('R123 the whole read gives up at its limit even when each request is within its own', async () => {
  const A = addressFor('a');
  const B = addressFor('b');
  const C = addressFor('c');
  // Three hops of 400 ms: each well under the 1000 ms request limit, together 1200 ms against an 800 ms whole-read limit.
  // Whether 'Slow' is shown tells if the whole-read limit held; elapsed time only has a loose upper bound.
  const feeds = { [A]: { redirect: B, status: 302, delayMs: 400 }, [B]: { redirect: C, status: 302, delayMs: 400 }, [C]: { delayMs: 400, status: 200, body: feedOf('Slow', 480, 540) } };
  const { ask } = await rig(feeds, { 1: A }, { budgetMs: 800, requestMs: 1000 });
  const t0 = Date.now();
  const out = await ask([HOME_E]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3 * 800, `expected the read to end before ${3 * 800} ms, took ${elapsed} ms`);
  assert.deepEqual(out.warnings, [warn('calendar-google-unreachable', ['Home'])]);
  assert.deepEqual(out.value, { error: 'unreadable' });
});

test('R123 after a failure, a read thirty seconds later gets the same answer with no request; two minutes later it is fresh', async () => {
  const { ask, fake } = await rig({ [HOME]: { status: 503 }, [WORK]: feedOf('Standup', 420, 450) }, { 1: HOME, 2: WORK });
  const first = await ask(BOTH, AT);
  assert.deepEqual(first.warnings, [warn('calendar-google-unreachable', ['Home'])]);
  assert.equal(fake.calls.length, 2);
  fake.feeds[HOME] = feedOf('Dentist', 480, 540);
  const rested = await ask(BOTH, plus(AT, 30 * 1000));
  assert.equal(fake.calls.length, 2, 'expected no request at all for any calendar within the minute after a failure');
  assert.deepEqual(rested, first);
  const fresh = await ask(BOTH, plus(AT, 2 * MIN));
  assert.equal(fake.calls.length, 4, 'expected a fresh read of all calendars two minutes later');
  assert.deepEqual(fresh.value.events, [STANDUP, DENTIST]);
  assert.equal(!!fresh.value.stale, false);
  assert.deepEqual(fresh.warnings, []);
});

test('R123 the rest of one minute follows each kind of failure: rejected, unreachable, not a calendar, a time limit', async () => {
  const bad = [
    ['401', { status: 401 }, 'calendar-google-address-rejected'],
    ['404', { status: 404 }, 'calendar-google-address-rejected'],
    ['429', { status: 429 }, 'calendar-google-unreachable'],
    ['500', { status: 500 }, 'calendar-google-unreachable'],
    ['html', { status: 200, body: '<html></html>' }, 'calendar-google-not-a-calendar'],
    ['a time limit', { never: true }, 'calendar-google-unreachable'],
  ];
  for (const [label, feed, code] of bad) {
    const { ask, fake } = await rig({ [HOME]: feed, [WORK]: feedOf('Standup', 420, 450) }, { 1: HOME, 2: WORK }, timed);
    const first = await ask(BOTH, AT);
    assert.deepEqual(first.warnings, [warn(code, ['Home'])], label);
    const before = fake.calls.length;
    const second = await ask(BOTH, plus(AT, 30 * 1000));
    assert.equal(fake.calls.length, before, `${label}: expected no request within the minute after the failure`);
    assert.deepEqual(second, first, label);
    await ask(BOTH, plus(AT, 2 * MIN));
    assert.equal(fake.calls.length, before + 2, `${label}: expected a fresh read of all calendars after the minute`);
  }
});

test('R123 a calendar too large is reused for five minutes like a good read: no rest, no request two minutes later, a fresh read at six', async () => {
  const { ask, fake } = await rig({ [HOME]: FEED_20001, [WORK]: feedOf('Standup', 420, 450) }, { 1: HOME, 2: WORK });
  const first = await ask(BOTH, AT);
  assert.deepEqual(first.warnings, [warn('calendar-google-too-large', ['Home'])]);
  assert.equal(fake.calls.length, 2);
  const again = await ask(BOTH, plus(AT, 2 * MIN));
  assert.equal(fake.calls.length, 2, 'expected the read with a too-large calendar to be reused for five minutes');
  assert.deepEqual(again, first);
  await ask(BOTH, plus(AT, 6 * MIN));
  assert.equal(fake.calls.length, 4, 'expected a fresh read after six minutes');
});

test('R123 a missing address and a good calendar: a second read two minutes later sends no new request', async () => {
  const { ask, fake } = await rig({ [WORK]: feedOf('Standup', 420, 450) }, { 2: WORK });
  const first = await ask(BOTH, AT);
  assert.deepEqual(first.warnings, [warn('calendar-google-no-address', ['Home'])]);
  assert.equal(fake.calls.length, 1, 'expected a request only for the calendar that has an address');
  const again = await ask(BOTH, plus(AT, 2 * MIN));
  assert.equal(fake.calls.length, 1, 'expected no new request two minutes later');
  assert.deepEqual(again, first);
});

test('R123 a refused address and a good calendar: a second read two minutes later sends no new request', async () => {
  const refused = 'http://calendar.google.com/calendar/ical/x%40example.invalid/private-0123456789abcdef/basic.ics';
  const { ask, fake } = await rig({ [WORK]: feedOf('Standup', 420, 450) }, { 1: refused, 2: WORK });
  const first = await ask(BOTH, AT);
  assert.deepEqual(first.warnings, [warn('calendar-google-address-refused', ['Home'])]);
  assert.equal(fake.calls.length, 1);
  const again = await ask(BOTH, plus(AT, 2 * MIN));
  assert.equal(fake.calls.length, 1, 'expected no new request two minutes later');
  assert.deepEqual(again, first);
});

test('R123 the default limits are not exposed by the source without a real wait', async () => {
  // The seam gives budgetMs 12000 and requestMs 8000 as defaults of the factory and exposes neither;
  // proving them needs a real 8 s and 12 s wait, which this file does not make. Here only the factory is checked to exist.
  const { createGoogleSource } = await googleModule();
  assert.equal(typeof createGoogleSource({ fetch: fakeGoogleIcal({ feeds: {} }), addresses: {} }).read, 'function');
});

// ======================= R124: what is kept, and the broken panel =======================

const GOOD_FEEDS = () => ({ [HOME]: feedOf('Dentist', 480, 540), [WORK]: feedOf('Standup', 420, 450) });

test('R124 two calendars read well, six minutes later one answers 503: both are shown (the failed one\'s from before), stale true', async () => {
  const { ask, fake } = await rig(GOOD_FEEDS(), { 1: HOME, 2: WORK });
  const good = await ask(BOTH, AT);
  assert.deepEqual(good.value.events, [STANDUP, DENTIST]);
  assert.equal(!!good.value.stale, false);
  fake.feeds[WORK] = { status: 503 };
  const out = await ask(BOTH, plus(AT, 6 * MIN));
  assert.deepEqual(out.value.events, [STANDUP, DENTIST], 'expected the failed calendar\'s events from the earlier read to be kept');
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.warnings, [warn('calendar-google-unreachable', ['Work'])], 'expected names to hold only the failed calendar');
});

test('R124 the kept events survive each kind of failure: rejected, unreachable, not a calendar and a time limit', async () => {
  const bad = [
    ['rejected (404)', { status: 404 }, 'calendar-google-address-rejected'],
    ['unreachable (503)', { status: 503 }, 'calendar-google-unreachable'],
    ['not a calendar', { status: 200, body: '<html>Sign in</html>' }, 'calendar-google-not-a-calendar'],
    ['a time limit', { never: true }, 'calendar-google-unreachable'],
  ];
  for (const [label, feed, code] of bad) {
    const { ask, fake } = await rig(GOOD_FEEDS(), { 1: HOME, 2: WORK }, timed);
    await ask(BOTH, AT);
    fake.feeds[HOME] = feed;
    const out = await ask(BOTH, plus(AT, 6 * MIN));
    assert.deepEqual(out.value.events, [STANDUP, DENTIST], `${label}: expected the kept events of the failed calendar`);
    assert.equal(out.value.stale, true, label);
    assert.deepEqual(out.warnings, [warn(code, ['Home'])], label);
  }
});

test('R124 a failure in the first read of one calendar: the other\'s events, stale true, calendar-google-address-rejected at 1', async () => {
  const { ask } = await rig({ [HOME]: feedOf('Dentist', 480, 540), [WORK]: { status: 404 } }, { 1: HOME, 2: WORK });
  const out = await ask(BOTH);
  assert.deepEqual(out.value.events, [DENTIST]);
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.warnings, [warn('calendar-google-address-rejected', ['Work'])]);
});

test('R124 a first read that fails for the only calendar is { error: "unreadable" } with the warning, for each of the three reasons', async () => {
  const bad = [
    [{ status: 404 }, 'calendar-google-address-rejected'],
    [{ status: 503 }, 'calendar-google-unreachable'],
    [{ status: 200, body: '<html></html>' }, 'calendar-google-not-a-calendar'],
  ];
  for (const [feed, code] of bad) {
    const { ask } = await rig({ [HOME]: feed }, { 1: HOME });
    const out = await ask();
    assert.deepEqual(out.value, { error: 'unreadable' }, code);
    assert.deepEqual(out.warnings, [warn(code, ['Home'])], code);
  }
});

test('R124 every listed calendar without an address: unreadable, and calendar-google-no-address with all the names', async () => {
  const { ask, fake } = await rig({}, {});
  const out = await ask(BOTH);
  assert.deepEqual(out.value, { error: 'unreadable' });
  assert.deepEqual(out.warnings, [warn('calendar-google-no-address', ['Home', 'Work'])]);
  assert.equal(fake.calls.length, 0);
});

test('R124 a calendar with no address, a refused address or one too large contributes nothing and makes the panel stale', async () => {
  const refused = 'http://calendar.google.com/calendar/ical/x%40example.invalid/private-0123456789abcdef/basic.ics';
  const bigAddress = addressFor('big');
  const names = [entry('Good', 1, 'personal'), entry('Missing', 2), entry('Refused', 3), entry('Big', 4)];
  const { ask } = await rig({ [HOME]: feedOf('Dentist', 480, 540), [bigAddress]: FEED_20001 }, { 1: HOME, 3: refused, 4: bigAddress });
  const out = await ask(names);
  assert.deepEqual(out.value.events, [DENTIST]);
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.warnings.map((w) => [w.code, w.count, w.names]).sort(), [
    ['calendar-google-address-refused', 1, ['Refused']],
    ['calendar-google-no-address', 1, ['Missing']],
    ['calendar-google-too-large', 1, ['Big']],
  ]);
});

test('R124 a calendar that was read earlier and is now too large contributes nothing: kept events are for failures only', async () => {
  const { ask, fake } = await rig(GOOD_FEEDS(), { 1: HOME, 2: WORK });
  await ask(BOTH, AT);
  fake.feeds[WORK] = FEED_20001;
  const out = await ask(BOTH, plus(AT, 6 * MIN));
  assert.deepEqual(out.value.events, [DENTIST], 'expected nothing from a calendar that is now too large');
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.warnings, [warn('calendar-google-too-large', ['Work'])]);
});

test('R124 a calendar that keeps failing keeps its earlier events; recovery gives fresh events, stale false and no warning', async () => {
  const { ask, fake } = await rig(GOOD_FEEDS(), { 1: HOME, 2: WORK });
  await ask(BOTH, AT);
  fake.feeds[WORK] = { status: 503 };
  const second = await ask(BOTH, plus(AT, 6 * MIN));
  const third = await ask(BOTH, plus(AT, 8 * MIN)); // a fresh read: the rest of a minute is over
  assert.equal(fake.calls.length, 6, 'expected a fresh read at eight minutes');
  assert.deepEqual(third.value.events, [STANDUP, DENTIST], 'expected the events of the first read to still be kept after a second failure');
  assert.equal(third.value.stale, true);
  assert.deepEqual(third.warnings, second.warnings);
  fake.feeds[WORK] = feedOf('Standup moved', 600, 630);
  const fourth = await ask(BOTH, plus(AT, 10 * MIN));
  assert.deepEqual(fourth.value.events.map((e) => e.title), ['Dentist', 'Standup moved']);
  assert.equal(!!fourth.value.stale, false);
  assert.deepEqual(fourth.warnings, []);
});

test('R124 nothing is kept across a day change: yesterday\'s events of a failed calendar are not shown', async () => {
  const daily = icsFeed([{ uid: 'daily', title: 'Daily', start: '20261001T080000Z', end: '20261001T083000Z', rrule: 'FREQ=DAILY' }]);
  const { ask, fake } = await rig({ [HOME]: daily, [WORK]: feedOf('Work yesterday', 420, 450) }, { 1: HOME, 2: WORK });
  const day1 = await ask(BOTH, AT);
  assert.deepEqual(titles(day1), ['Work yesterday', 'Daily']);
  fake.feeds[WORK] = { status: 503 };
  const day2 = await ask(BOTH, '2026-10-13T06:10:00.900Z');
  assert.deepEqual(day2.value.events.map((e) => e.title), ['Daily'], 'expected nothing from the failed calendar\'s read of the day before');
  assert.equal(day2.value.date, '2026-10-13');
  assert.equal(day2.value.stale, true);
  assert.deepEqual(day2.warnings, [warn('calendar-google-unreachable', ['Work'])]);
});

test('R124 a failure the day after a good read, for the only calendar, is unreadable', async () => {
  const { ask, fake } = await rig({ [WORK]: feedOf('Work yesterday', 420, 450) }, { 2: WORK });
  await ask([WORK_E], AT);
  fake.feeds[WORK] = { status: 503 };
  const out = await ask([WORK_E], '2026-10-13T06:10:00.900Z');
  assert.deepEqual(out.value, { error: 'unreadable' });
  assert.deepEqual(out.warnings, [warn('calendar-google-unreachable', ['Work'])]);
});

test('R124 nothing is kept for another timezone: a failure for it is unreadable even on the same date', async () => {
  const { ask, fake } = await rig({ [HOME]: feedOf('Dentist', 480, 540) }, { 1: HOME });
  await ask([HOME_E], AT, TZ);
  fake.feeds[HOME] = { status: 503 };
  const out = await ask([HOME_E], plus(AT, 6 * MIN), OTHER_TZ);
  assert.deepEqual(out.value, { error: 'unreadable' }, 'expected events kept for Europe/Brussels not to be shown for America/New_York');
  assert.deepEqual(out.warnings, [warn('calendar-google-unreachable', ['Home'])]);
});

test('R124 a failure within the minute gives the same failure answer with no request', async () => {
  const { ask, fake } = await rig({ [HOME]: { status: 503 } }, { 1: HOME });
  const first = await ask([HOME_E], AT);
  assert.deepEqual(first.value, { error: 'unreadable' });
  const again = await ask([HOME_E], plus(AT, 20 * 1000));
  assert.equal(fake.calls.length, 1, 'expected no request within the minute');
  assert.deepEqual(again, first);
});

test('R124 names hold the failed calendars in the order of the settings, one warning per reason', async () => {
  const feeds = fiveFeeds((c, i) => [{ status: 404 }, feedOf('Fine', 480, 540), { status: 503 }, { status: 404 }, { status: 500 }][i]);
  const { ask } = await rig(feeds, fiveAddresses);
  const out = await ask(fiveEntries);
  assert.deepEqual(warnings(out, 'calendar-google-address-rejected'), [warn('calendar-google-address-rejected', ['Cal one', 'Cal four'])]);
  assert.deepEqual(warnings(out, 'calendar-google-unreachable'), [warn('calendar-google-unreachable', ['Cal three', 'Cal five'])]);
  assert.deepEqual(titles(out), ['Fine']);
  assert.equal(out.value.stale, true);
});

// ---- through the loader: the page, the source state and the projects ----

function makeHttp(files) {
  const answer = (p) => {
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p.startsWith(R + '/contents/')) {
      const f = p.slice((R + '/contents/').length);
      if (!Object.hasOwn(files, f) || files[f] === null) throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
      return { content: Buffer.from(files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?') || p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    if (p === '/orgs/' + OWNER + '/projectsV2?per_page=100') return { items: [], partial: false };
    throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
  };
  return {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
}

async function loaderSession({ calendar, feeds, addresses }) {
  const { createGoogleSource } = await googleModule();
  const fake = fakeGoogleIcal({ feeds });
  const googleCalendar = createGoogleSource({ fetch: fake, addresses, budgetMs: 800, requestMs: 400 });
  const files = {
    'board.config.json': JSON.stringify(settings({ timezone: TZ, ...(calendar === undefined ? {} : { calendar }) })),
    'theme.json': null, 'state/brief.json': null, 'state/calendar.json': null, 'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null,
  };
  const cache = { async readLastGood() { return null; }, async writeLastGood() {}, etags: { get() {}, set() {} } };
  const clock = { t: Date.parse(AT), now() { return clock.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-GH-TOKEN-1' };
  const loader = createLoader({ http: makeHttp(files), env, cache, clock, googleCalendar });
  return {
    fake,
    async load(at = AT) {
      clock.t = Date.parse(at);
      const out = await loader.load();
      assert.equal(out.ok, true, 'the board did not load (the harness is wrong, not the rule)');
      const board = buildBoard({ ...out.bundle, now: new Date(clock.t).toISOString() });
      const html = renderPage(board, THEME, OPTS);
      return {
        board, html, panel: board.panels.calendar,
        calSource: (board.meta.sources || []).find((x) => x.id === 'calendar'),
        warn: (code) => (board.meta.warnings || []).find((w) => w.code === code),
      };
    },
  };
}

const strip = (s) => s.replace(/<[^>]*>/g, '');
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function calendarText(html) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ name: m[1], start: html.lastIndexOf('<', m.index) }));
  const i = marks.findIndex((m) => m.name === 'calendar');
  assert.ok(i >= 0, 'the page has no calendar section');
  return unesc(strip(html.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].start : html.length))).replace(/\s+/g, ' ');
}
const BLOCK = { source: 'google', calendars: [{ name: 'Home', kind: 'personal' }, { name: 'Work', kind: 'focus' }] };

test('R124 through the board: a calendar failing after a good read shows the kept events, the source stale and the warning with names', async () => {
  const s = await loaderSession({ calendar: BLOCK, feeds: GOOD_FEEDS(), addresses: { 1: HOME, 2: WORK } });
  const first = await s.load(AT);
  assert.deepEqual(first.panel.events, [STANDUP, DENTIST]);
  assert.equal(first.panel.stale, false);
  assert.equal(first.calSource.state, 'ok');
  s.fake.feeds[WORK] = { status: 503 };
  const v = await s.load(plus(AT, 6 * MIN));
  assert.deepEqual(v.panel.events, [STANDUP, DENTIST], 'expected the kept events on the page');
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assert.deepEqual(v.warn('calendar-google-unreachable'), warn('calendar-google-unreachable', ['Work']));
  assert.ok(calendarText(v.html).includes('Standup'));
  assert.equal(v.html.includes('private-0123456789abcdef'), false, 'the page must not show any part of the address');
});

test('R124 through the board: a first read that fails for the only calendar is the broken panel from google, the source error, and projects as without a calendar', async () => {
  const one = { source: 'google', calendars: [{ name: 'Home', kind: 'personal' }] };
  const s = await loaderSession({ calendar: one, feeds: { [HOME]: { status: 503 } }, addresses: { 1: HOME } });
  const v = await s.load();
  assert.deepEqual(v.panel, { error: 'unreadable', from: 'google' });
  assert.equal(v.calSource.state, 'error');
  assert.ok(calendarText(v.html).includes(GOOGLE_SENTENCE), calendarText(v.html));
  assert.deepEqual(v.warn('calendar-google-unreachable'), warn('calendar-google-unreachable', ['Home']));
  const without = await loaderSession({ calendar: undefined, feeds: {}, addresses: {} });
  const w = await without.load();
  assert.deepEqual(v.board.panels.projects, w.board.panels.projects, 'expected projects equal to the board built without a calendar');
});

test('R124 through the board: a day with no events on a good read is an empty day, not a failure', async () => {
  const one = { source: 'google', calendars: [{ name: 'Home', kind: 'personal' }] };
  const s = await loaderSession({ calendar: one, feeds: { [HOME]: vcalendar() }, addresses: { 1: HOME } });
  const v = await s.load();
  assert.deepEqual(v.panel.events, []);
  assert.equal(v.panel.stale, false);
  assert.equal(v.calSource.state, 'ok');
  assert.equal(v.warn('calendar-google-not-a-calendar'), undefined);
});
