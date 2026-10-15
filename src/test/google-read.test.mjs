// Tests of the reading side of the Google calendar source: R118 (the panel is the one iCloud gives, with four
// differences) and R121 (GET only, redirects are the board's own business, nothing leaves for another origin),
// written from the contract before the code exists, against the invented Google of fixtures/fake-google-ical.mjs.
// board/calendar/google.mjs, readGoogleIcal and the loader's googleCalendar option do not exist yet and are reached
// lazily, so each test fails by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { settings } from '../fixtures/build.mjs';
import { vevent } from '../fixtures/ics.mjs';
import { fakeGoogleIcal, icsFeed } from '../fixtures/fake-google-ical.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const AT = '2026-10-12T06:10:00.900Z';
const TODAY = '2026-10-12';
const TZ = 'Europe/Brussels';
const MIN = 60 * 1000;
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const GOOGLE_SENTENCE = 'The calendar could not be read from Google. See the note at the foot of the page.';
const ICLOUD_SENTENCE = 'The calendar could not be read from iCloud. See the note at the foot of the page.';

const addressFor = (name) => `https://calendar.google.com/calendar/ical/${name}%40example.invalid/private-0123456789abcdef/basic.ics`;
const HOME = addressFor('home');
const WORK = addressFor('work');

// ---- lazy reach into what does not exist yet ----

async function googleModule() {
  const mod = await import('../board/calendar/google.mjs');
  assert.equal(typeof mod.createGoogleSource, 'function', 'board/calendar/google.mjs does not export createGoogleSource');
  return mod;
}
async function readGoogleIcal(vars) {
  const mod = await import('../board/env.mjs');
  assert.equal(typeof mod.readGoogleIcal, 'function', 'board/env.mjs does not export readGoogleIcal');
  return mod.readGoogleIcal(vars);
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

// A source over a stand-in, with small time limits so the file runs in seconds.
async function rig(feeds, addresses, opts = {}) {
  const { createGoogleSource } = await googleModule();
  const fake = fakeGoogleIcal({ feeds });
  const source = createGoogleSource({ fetch: fake, addresses, budgetMs: 800, requestMs: 400, ...opts });
  const ask = (calendars = [entry('Home', 1)], now = AT, tz = TZ) => source.read({ calendars, tz, now });
  return { fake, source, ask };
}

const urls = (fake) => fake.calls.map((c) => c.url);
const hostsOf = (fake) => fake.calls.map((c) => new URL(c.url).host);
const warnings = (out, code) => out.warnings.filter((w) => w.code === code);

// ---- a fake GitHub world and one loader session ----

function makeHttp(files, calls) {
  const answer = (method, p) => {
    calls.push({ method, path: p });
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
    async get(p) { return { status: 200, json: answer('get', p), notModified: false, link: null }; },
    async paged(p) { return answer('paged', p); },
  };
}

async function session({ calendar, vars = {}, feeds = {}, file = null, at = AT, withGoogle = true } = {}) {
  const fake = fakeGoogleIcal({ feeds });
  let googleCalendar;
  if (withGoogle) {
    const { createGoogleSource } = await googleModule();
    googleCalendar = createGoogleSource({ fetch: fake, addresses: (await readGoogleIcal(vars)) ?? {}, budgetMs: 800, requestMs: 400 });
  }
  const githubCalls = [];
  const files = {
    'board.config.json': JSON.stringify(settings({ timezone: TZ, ...(calendar === undefined ? {} : { calendar }) })),
    'theme.json': null,
    'state/brief.json': null,
    'state/calendar.json': file === null ? null : JSON.stringify(file),
    'state/inbox.json': null,
    'state/log.json': null,
    'state/proposals.json': null,
  };
  const cache = { async readLastGood() { return null; }, async writeLastGood() {}, etags: { get() {}, set() {} } };
  const clock = { t: Date.parse(at), now() { return clock.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-GH-TOKEN-1' };
  const loader = createLoader({ http: makeHttp(files, githubCalls), env, cache, clock, ...(googleCalendar ? { googleCalendar } : {}) });
  return {
    fake, githubCalls,
    async load() {
      const out = await loader.load();
      assert.equal(out.ok, true, 'the board did not load (the harness is wrong, not the rule)');
      const b = out.bundle;
      const board = buildBoard({ ...b, now: new Date(clock.t).toISOString() });
      const html = renderPage(board, THEME, OPTS);
      return {
        out, board, html, panel: board.panels.calendar,
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

const BLOCK = { source: 'google', calendars: [{ name: 'Home', kind: 'personal' }, { name: 'Work' }] };

// ======================= R118: the panel =======================

test('R118 two calendars with kinds: both events on the calendar section with kinds personal and meeting, and not the file\'s', async () => {
  const s = await session({
    calendar: BLOCK,
    vars: { BOARD_GOOGLE_ICAL_1: HOME, BOARD_GOOGLE_ICAL_2: WORK },
    feeds: { [HOME]: feedOf('Dentist', 480, 540), [WORK]: feedOf('Standup', 420, 450) },
    file: { date: TODAY, events: [row('From the file', '11:00', '11:30', 'focus')] },
  });
  const v = await s.load();
  assert.deepEqual(v.panel.events, [row('Standup', '09:00', '09:30', 'meeting'), row('Dentist', '10:00', '11:00', 'personal')]);
  assert.equal(v.panel.stale, false);
  assert.equal(Object.hasOwn(v.panel, 'merged'), false);
  const text = calendarText(v.html);
  assert.ok(text.includes('Standup') && text.includes('Dentist'));
  assert.equal(text.includes('From the file'), false);
  assert.equal(v.html.includes('data-source'), false);
  assert.equal(v.calSource.state, 'ok');
});

test('R118 createGoogleSource read gives { value: { date, events }, warnings: [] } for a good read, kinds from the entries', async () => {
  const { ask, fake } = await rig({ [HOME]: feedOf('Dentist', 480, 540), [WORK]: feedOf('Standup', 420, 450) }, { 1: HOME, 2: WORK });
  const out = await ask([entry('Home', 1, 'personal'), entry('Work', 2, 'focus')]);
  assert.deepEqual(out.value.events, [row('Standup', '09:00', '09:30', 'focus'), row('Dentist', '10:00', '11:00', 'personal')]);
  assert.equal(out.value.date, TODAY);
  assert.equal(!!out.value.stale, false);
  assert.deepEqual(out.warnings, []);
  assert.equal(fake.calls.length, 2);
});

test('R118 an event takes the kind of its own calendar\'s entry, whatever the place numbers say', async () => {
  const { ask } = await rig({ [HOME]: feedOf('Dentist', 480, 540), [WORK]: feedOf('Standup', 420, 450) }, { 3: HOME, 5: WORK });
  const out = await ask([entry('Home', 3, 'habit'), entry('Work', 5, 'personal')]);
  assert.deepEqual(out.value.events, [row('Standup', '09:00', '09:30', 'personal'), row('Dentist', '10:00', '11:00', 'habit')]);
});

test('R118 an invitation the person declined is shown like any other event, for any address', async () => {
  const feed = icsFeed([ev('Declined one', 480, 540, { declined: true }), ev('Kept one', 600, 660)]);
  const { ask } = await rig({ [HOME]: feed }, { 1: HOME });
  const out = await ask([entry('Home', 1, 'personal')]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Declined one', 'Kept one']);
  assert.deepEqual(out.warnings, []);
});

test('R118 a declined attendee line for any address shows the event on the page too', async () => {
  const feed = icsFeed([
    vevent({ summary: 'Declined by someone', start: z(480), end: z(540), extra: ['ATTENDEE;CN=Guest;PARTSTAT=DECLINED:mailto:anyone@example.invalid'] }),
  ]);
  const s = await session({ calendar: BLOCK, vars: { BOARD_GOOGLE_ICAL_1: HOME }, feeds: { [HOME]: feed } });
  const v = await s.load();
  assert.deepEqual(v.panel.events.map((e) => e.title), ['Declined by someone']);
  assert.ok(calendarText(v.html).includes('Declined by someone'));
});

test('R118 a repeating event, a cancelled event, an all-day event and an event crossing midnight are read as R98, R99 and R105 read them', async () => {
  const feed = icsFeed([
    // A weekly Monday series begun on 28 September: held today (Monday 12 October), board time.
    { uid: 'weekly', title: 'Weekly review', start: '20260928T090000', end: '20260928T100000', tzid: TZ, rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    // The same kind of series with today taken out.
    { uid: 'skipped', title: 'Skipped series', start: '20260928T110000', end: '20260928T120000', tzid: TZ, rrule: 'FREQ=WEEKLY;BYDAY=MO', exdate: '20261012T110000' },
    { title: 'Cancelled one', start: '20261012T120000', end: '20261012T130000', status: 'CANCELLED' },
    { title: 'Holiday', start: '20261012', end: '20261013', allDay: true },
    { title: 'Overnight in', start: '20261011T230000', end: '20261012T010000' },
    { title: 'Overnight out', start: '20261012T233000', end: '20261013T003000' },
    { title: 'Yesterday only', start: '20261011T090000', end: '20261011T100000' },
  ]);
  const { ask } = await rig({ [HOME]: feed }, { 1: HOME });
  const out = await ask([entry('Home', 1)]);
  assert.deepEqual(out.value.events, [
    row('Overnight in', '00:00', '01:00'),
    row('Weekly review', '09:00', '10:00'),
    row('Overnight out', '23:30', '24:00'),
  ]);
  assert.deepEqual(out.value.allDay, [{ title: 'Holiday' }]);
  assert.deepEqual(out.warnings, []);
});

test('R118 the same events reach the page: the all-day line above the hours and the timed events in order', async () => {
  const feed = icsFeed([
    { title: 'Holiday', start: '20261012', end: '20261013', allDay: true },
    { title: 'Weekly review', start: '20260928T090000', end: '20260928T100000', tzid: TZ, rrule: 'FREQ=WEEKLY;BYDAY=MO' },
  ]);
  const s = await session({ calendar: BLOCK, vars: { BOARD_GOOGLE_ICAL_1: HOME }, feeds: { [HOME]: feed } });
  const v = await s.load();
  assert.deepEqual(v.panel.allDay, [{ title: 'Holiday' }]);
  assert.deepEqual(v.panel.events.map((e) => [e.title, e.start, e.end]), [['Weekly review', '09:00', '10:00']]);
  assert.match(v.html, /data-allday/);
  assert.ok(calendarText(v.html).includes('Holiday'));
});

test('R118 no name is matched to anything: calendar-not-found is never raised, whatever the names say', async () => {
  const { ask } = await rig({ [HOME]: feedOf('Dentist', 480, 540) }, { 1: HOME });
  const out = await ask([entry('A label that matches nothing in Google', 1), entry('Reminders', 2)]);
  assert.deepEqual(warnings(out, 'calendar-not-found'), []);
});

test('R118 the iCloud warnings are never raised for this source', async () => {
  const { ask } = await rig({ [HOME]: { status: 503 } }, { 1: HOME });
  const out = await ask([entry('Home', 1)]);
  for (const code of ['calendar-no-login', 'calendar-login-refused', 'calendar-unreachable']) {
    assert.deepEqual(warnings(out, code), [], code);
  }
  assert.deepEqual(warnings(out, 'calendar-google-unreachable').map((w) => w.count), [1]);
});

test('R118 every address missing: the broken panel from google, the source error, and the Google sentence on the page', async () => {
  const s = await session({ calendar: BLOCK, vars: {} });
  const v = await s.load();
  assert.deepEqual(v.panel, { error: 'unreadable', from: 'google' });
  assert.equal(v.calSource.state, 'error');
  const text = calendarText(v.html);
  assert.ok(text.includes(GOOGLE_SENTENCE), text);
  assert.equal(text.includes('iCloud'), false);
  assert.deepEqual(v.warn('calendar-google-no-address'), { code: 'calendar-google-no-address', count: 2, names: ['Home', 'Work'] });
  assert.equal(s.fake.calls.length, 0);
});

test('R118 every address missing, with a state/calendar.json present: still the broken panel, the file is ignored', async () => {
  const s = await session({ calendar: BLOCK, vars: {}, file: { date: TODAY, events: [row('From the file', '11:00', '11:30')] } });
  const v = await s.load();
  assert.deepEqual(v.panel, { error: 'unreadable', from: 'google' });
  assert.equal(calendarText(v.html).includes('From the file'), false);
});

test('R118 source icloud and no iCloud sign-in: the iCloud sentence as before, and Google is not asked', async () => {
  const s = await session({
    calendar: { source: 'icloud', calendars: [{ name: 'Home' }] },
    vars: { BOARD_GOOGLE_ICAL_1: HOME },
    feeds: { [HOME]: feedOf('Never', 420, 450) },
  });
  const v = await s.load();
  assert.deepEqual(v.panel, { error: 'unreadable', from: 'icloud' });
  const text = calendarText(v.html);
  assert.ok(text.includes(ICLOUD_SENTENCE), text);
  assert.equal(text.includes(GOOGLE_SENTENCE), false);
  assert.equal(s.fake.calls.length, 0);
});

test('R118 a google block and no Google source handed to the loader: the broken panel from google, not from icloud', async () => {
  const s = await session({ calendar: BLOCK, vars: {}, withGoogle: false });
  const v = await s.load();
  assert.deepEqual(v.panel, { error: 'unreadable', from: 'google' });
  assert.ok(calendarText(v.html).includes(GOOGLE_SENTENCE));
});

test('R118 a google block reads through the Google source and never through the iCloud one', async () => {
  const { createGoogleSource } = await googleModule();
  const icloud = { calls: 0, async read() { icloud.calls += 1; return { value: { date: TODAY, events: [row('Apple', '08:00', '09:00')] }, warnings: [] }; } };
  const fake = fakeGoogleIcal({ feeds: { [HOME]: feedOf('Dentist', 480, 540) } });
  const googleCalendar = createGoogleSource({ fetch: fake, addresses: { 1: HOME }, budgetMs: 800, requestMs: 400 });
  const files = {
    'board.config.json': JSON.stringify(settings({ timezone: TZ, calendar: { source: 'google', calendars: [{ name: 'Home' }] } })),
    'theme.json': null, 'state/brief.json': null, 'state/calendar.json': null, 'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null,
  };
  const cache = { async readLastGood() { return null; }, async writeLastGood() {}, etags: { get() {}, set() {} } };
  const clock = { t: Date.parse(AT), now() { return clock.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-GH-TOKEN-1' };
  const loader = createLoader({ http: makeHttp(files, []), env, cache, clock, calendar: icloud, googleCalendar });
  const out = await loader.load();
  assert.equal(out.ok, true);
  assert.equal(icloud.calls, 0);
  assert.deepEqual(out.bundle.state.calendar.events.map((e) => e.title), ['Dentist']);
});

// ======================= R121 =======================

// Every read path once: a first read, a reuse, a later read, a failure, a followed redirect, a refused redirect.
async function everyPath() {
  const NEXT = addressFor('next');
  const fake = fakeGoogleIcal({
    feeds: {
      [HOME]: feedOf('Standup', 420, 450),
      [WORK]: { status: 503 },
      [addressFor('moved')]: { redirect: NEXT, status: 301 },
      [NEXT]: feedOf('Moved', 480, 540),
      [addressFor('login')]: { redirect: 'https://accounts.google.com/ServiceLogin' },
    },
  });
  const { createGoogleSource } = await googleModule();
  const make = (addresses) => createGoogleSource({ fetch: fake, addresses, budgetMs: 800, requestMs: 400 });
  const one = make({ 1: HOME });
  await one.read({ calendars: [entry('Home', 1)], tz: TZ, now: AT });
  const afterFirst = fake.calls.length;
  await one.read({ calendars: [entry('Home', 1)], tz: TZ, now: plus(AT, MIN) });
  assert.equal(fake.calls.length, afterFirst, 'a read one minute later is reused with no request (R123)');
  await one.read({ calendars: [entry('Home', 1)], tz: TZ, now: plus(AT, 6 * MIN) });
  await make({ 1: WORK }).read({ calendars: [entry('Work', 1)], tz: TZ, now: AT });
  await make({ 1: addressFor('moved') }).read({ calendars: [entry('Moved', 1)], tz: TZ, now: AT });
  await make({ 1: addressFor('login') }).read({ calendars: [entry('Login', 1)], tz: TZ, now: AT });
  return fake;
}

test('R121 every read path run once: every request is a GET to calendar.google.com with redirect manual, Accept text/calendar and User-Agent board', async () => {
  const fake = await everyPath();
  assert.equal(fake.calls.length, 6, `expected 6 requests, got ${fake.calls.length}`);
  for (const c of fake.calls) {
    assert.equal(c.method, 'GET', c.url);
    assert.equal(new URL(c.url).host, 'calendar.google.com', c.url);
    assert.equal(new URL(c.url).protocol, 'https:', c.url);
    assert.equal(c.redirect, 'manual', c.url);
    assert.equal(c.headers.accept, 'text/calendar', c.url);
    assert.equal(c.headers['user-agent'], 'board', c.url);
    for (const forbidden of ['authorization', 'cookie', 'referer', 'referrer']) assert.equal(Object.hasOwn(c.headers, forbidden), false, `${c.url} sent ${forbidden}`);
  }
});

test('R121 the first request is for the address from the environment, as given', async () => {
  const { ask, fake } = await rig({ [HOME]: feedOf('Standup', 420, 450) }, { 1: HOME });
  await ask();
  assert.equal(fake.calls[0].url, HOME);
});

test('R121 the board never reaches a global fetch: every request goes through the injected one', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { seen.push(String(args[0])); throw new TypeError('no network in tests'); };
  try {
    const { ask } = await rig({
      [HOME]: { redirect: 'https://evil.example/x' },
      [WORK]: { redirect: addressFor('next'), status: 301 },
      [addressFor('next')]: feedOf('Standup', 420, 450),
    }, { 1: HOME, 2: WORK, 3: 'https://evil.example/calendar/ical/x/basic.ics', 4: 'not an address' });
    await ask([entry('Home', 1), entry('Work', 2), entry('Evil', 3), entry('Junk', 4)]);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(seen, []);
});

const BAD_TARGETS = [
  ['a login page on accounts.google.com', 'https://accounts.google.com/ServiceLogin', 'accounts.google.com'],
  ['another host', 'https://evil.example/x', 'evil.example'],
  ['http: on the right host', 'http://calendar.google.com/calendar/ical/x/basic.ics', 'http://'],
  ['a page of Google that is not a feed (/calendar/render)', 'https://calendar.google.com/calendar/render', '/calendar/render'],
  ['the right host on another port', 'https://calendar.google.com:8443/calendar/ical/x/basic.ics', ':8443'],
  ['a query on the right host', 'https://calendar.google.com/calendar/ical/x/basic.ics?token=1', 'token=1'],
  ['a relative Location that leaves the feed path (/calendar/render)', '/calendar/render', '/calendar/render'],
  ['a protocol-relative Location to another host', '//evil.example/calendar/ical/x/basic.ics', 'evil.example'],
];

for (const [label, location, marker] of BAD_TARGETS) {
  test(`R121 a 302 to ${label}: no request to the target, the calendar not accepted, calendar-google-address-rejected at 1`, async () => {
    const feeds = { [HOME]: { redirect: location } };
    // Give the stand-in an answer for the target too, so a request to it would be seen as answered, not only recorded.
    for (const t of [location, new URL(location, HOME).href]) feeds[t] = feedOf('Never', 420, 450);
    const { ask, fake } = await rig(feeds, { 1: HOME });
    const out = await ask();
    assert.deepEqual(urls(fake), [HOME], `a request left for ${marker}`);
    assert.deepEqual(out.warnings, [{ code: 'calendar-google-address-rejected', count: 1, names: ['Home'] }]);
    assert.equal(out.value.error, 'unreadable');
  });
}

test('R121 a 301 to another address that passes R120: that address is asked next and its answer is used', async () => {
  const NEXT = addressFor('moved-to');
  const { ask, fake } = await rig({ [HOME]: { redirect: NEXT, status: 301 }, [NEXT]: feedOf('Moved here', 480, 540) }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(urls(fake), [HOME, NEXT]);
  assert.deepEqual(out.value.events, [row('Moved here', '10:00', '11:00')]);
  assert.deepEqual(out.warnings, []);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`R121 a ${status} is followed by the board itself, with another GET`, async () => {
    const NEXT = addressFor('moved-to');
    const { ask, fake } = await rig({ [HOME]: { redirect: NEXT, status }, [NEXT]: feedOf('Moved here', 480, 540) }, { 1: HOME });
    const out = await ask();
    assert.deepEqual(urls(fake), [HOME, NEXT]);
    assert.deepEqual(fake.calls.map((c) => c.method), ['GET', 'GET']);
    assert.deepEqual(out.value.events.map((e) => e.title), ['Moved here']);
  });
}

test('R121 a relative Location that passes R120 once resolved against the address just asked is followed', async () => {
  const NEXT = 'https://calendar.google.com/calendar/ical/other%40example.invalid/private-aaaa/basic.ics';
  const { ask, fake } = await rig({ [HOME]: { redirect: '/calendar/ical/other%40example.invalid/private-aaaa/basic.ics' }, [NEXT]: feedOf('Moved here', 480, 540) }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(urls(fake), [HOME, NEXT]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Moved here']);
});

test('R121 the request after a redirect carries the same headers and redirect mode, and none of the forbidden ones', async () => {
  const NEXT = addressFor('moved-to');
  const { ask, fake } = await rig({ [HOME]: { redirect: NEXT, status: 307 }, [NEXT]: feedOf('Moved here', 480, 540) }, { 1: HOME });
  await ask();
  assert.equal(fake.calls.length, 2);
  for (const c of fake.calls) {
    assert.equal(c.redirect, 'manual');
    assert.equal(c.headers.accept, 'text/calendar');
    assert.equal(c.headers['user-agent'], 'board');
    assert.deepEqual(Object.keys(c.headers).filter((k) => ['authorization', 'cookie', 'referer'].includes(k)), []);
  }
});

test('R121 three redirects in a row are followed and the fourth request\'s calendar is read', async () => {
  const [b, c, d] = ['b', 'c', 'd'].map(addressFor);
  const { ask, fake } = await rig({ [HOME]: { redirect: b, status: 301 }, [b]: { redirect: c }, [c]: { redirect: d, status: 307 }, [d]: feedOf('Third hop', 480, 540) }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(urls(fake), [HOME, b, c, d]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Third hop']);
  assert.deepEqual(out.warnings, []);
});

test('R121 four redirects in a row: a failed read and calendar-google-unreachable at 1, the fourth is not followed', async () => {
  const [b, c, d, e] = ['b', 'c', 'd', 'e'].map(addressFor);
  const { ask, fake } = await rig({
    [HOME]: { redirect: b, status: 301 }, [b]: { redirect: c }, [c]: { redirect: d }, [d]: { redirect: e }, [e]: feedOf('Fifth hop', 480, 540),
  }, { 1: HOME });
  const out = await ask();
  assert.deepEqual(urls(fake), [HOME, b, c, d]);
  assert.deepEqual(out.warnings, [{ code: 'calendar-google-unreachable', count: 1, names: ['Home'] }]);
  assert.equal(out.value.error, 'unreadable');
});

test('R121 a redirect that points back at the same address ends as a failed read, not a loop', async () => {
  const { ask, fake } = await rig({ [HOME]: { redirect: HOME } }, { 1: HOME });
  const out = await ask();
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(out.warnings, [{ code: 'calendar-google-unreachable', count: 1, names: ['Home'] }]);
});

test('R121 a redirect with no Location is a read Google did not answer: calendar-google-unreachable at 1', async () => {
  const { ask, fake } = await rig({ [HOME]: { redirect: null, status: 302 } }, { 1: HOME });
  const out = await ask();
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(out.warnings, [{ code: 'calendar-google-unreachable', count: 1, names: ['Home'] }]);
  assert.equal(out.value.error, 'unreadable');
});

test('R121 the redirect counts are per read: a second calendar\'s redirects start again from zero', async () => {
  const [b, c, d] = ['b', 'c', 'd'].map(addressFor);
  const [w2, w3, w4] = ['w2', 'w3', 'w4'].map(addressFor);
  const { ask } = await rig({
    [HOME]: { redirect: b }, [b]: { redirect: c }, [c]: { redirect: d }, [d]: feedOf('Home hop', 480, 540),
    [WORK]: { redirect: w2 }, [w2]: { redirect: w3 }, [w3]: { redirect: w4 }, [w4]: feedOf('Work hop', 600, 660),
  }, { 1: HOME, 2: WORK });
  const out = await ask([entry('Home', 1), entry('Work', 2)]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Home hop', 'Work hop']);
  assert.deepEqual(out.warnings, []);
});

for (const status of [401, 403, 404, 410]) {
  test(`R121 status ${status} is a read Google did not accept: calendar-google-address-rejected at 1 and one request`, async () => {
    const { ask, fake } = await rig({ [HOME]: { status, body: 'no' } }, { 1: HOME });
    const out = await ask();
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(out.warnings, [{ code: 'calendar-google-address-rejected', count: 1, names: ['Home'] }]);
    assert.equal(out.value.error, 'unreadable');
  });
}

for (const status of [429, 500, 502, 503, 418]) {
  test(`R121 status ${status} is a read Google did not answer: calendar-google-unreachable at 1`, async () => {
    const { ask } = await rig({ [HOME]: { status, body: 'no' } }, { 1: HOME });
    const out = await ask();
    assert.deepEqual(out.warnings, [{ code: 'calendar-google-unreachable', count: 1, names: ['Home'] }]);
    assert.equal(out.value.error, 'unreadable');
  });
}

test('R121 no connection at all is a read Google did not answer: calendar-google-unreachable at 1', async () => {
  const { ask, fake } = await rig({}, { 1: HOME });
  const out = await ask();
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(out.warnings, [{ code: 'calendar-google-unreachable', count: 1, names: ['Home'] }]);
});

test('R121 an answer that never comes is cut off by the time limit as a read Google did not answer', async () => {
  const keep = setInterval(() => {}, 1000);
  try {
    const { ask } = await rig({ [HOME]: { never: true } }, { 1: HOME }, { budgetMs: 600, requestMs: 150 });
    const t0 = Date.now();
    const out = await ask();
    assert.ok(Date.now() - t0 < 2000, 'the read should end within the limits');
    assert.deepEqual(out.warnings, [{ code: 'calendar-google-unreachable', count: 1, names: ['Home'] }]);
  } finally {
    clearInterval(keep);
  }
});

test('R121 a rejected redirect and a good calendar together: the good one is read and the rejected one is named', async () => {
  const { ask, fake } = await rig({
    [HOME]: { redirect: 'https://accounts.google.com/ServiceLogin' },
    [WORK]: feedOf('Standup', 420, 450),
    'https://accounts.google.com/ServiceLogin': feedOf('Never', 420, 450),
  }, { 1: HOME, 2: WORK });
  const out = await ask([entry('Home', 1), entry('Work', 2)]);
  assert.equal(urls(fake).includes('https://accounts.google.com/ServiceLogin'), false);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Standup']);
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.warnings, [{ code: 'calendar-google-address-rejected', count: 1, names: ['Home'] }]);
});

test('R121 no request ever leaves for an origin other than https://calendar.google.com, whatever addresses are handed in', async () => {
  const handed = {
    1: 'https://accounts.google.com/ServiceLogin',
    2: 'http://calendar.google.com/calendar/ical/x/basic.ics',
    3: 'https://evil.example/calendar/ical/x/basic.ics',
    4: 'ftp://calendar.google.com/calendar/ical/x/basic.ics',
    5: HOME,
  };
  const feeds = Object.fromEntries(Object.values(handed).map((a) => [a, { redirect: 'https://evil.example/x' }]));
  const { ask, fake } = await rig(feeds, handed);
  await ask([1, 2, 3, 4, 5].map((n) => entry(`Cal ${n}`, n)));
  assert.deepEqual(urls(fake), [HOME]);
  assert.deepEqual([...new Set(hostsOf(fake))], ['calendar.google.com']);
});
