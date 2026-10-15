// Tests of createCalendarSource (board/calendar/icloud.mjs), written from the contract (R97, R100 to R103)
// and the pinned design, against the invented iCloud in fixtures/fake-caldav.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarSource } from '../board/calendar/icloud.mjs';
import { fakeCalDav } from '../fixtures/fake-caldav.mjs';
import { vevent, vcalendar } from '../fixtures/ics.mjs';

const USER = 'Zed.Sentinel@example.com';
const PASS = 'pw-Sentinel-4417';
const WRONG = 'wrong-Sentinel-0001';
const LOGIN = { user: USER, password: PASS };
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const TZ = 'Europe/Brussels';
const NOW = '2026-10-12T06:10:00.000Z';
const TODAY = '2026-10-12';
const MIN = 60 * 1000;

// ---- helpers ----

const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const two = (n) => String(n).padStart(2, '0');
// Minutes after 00:00 UTC on 12 October 2026, written as an iCalendar UTC time.
const z = (min) => `20261012T${two(Math.floor(min / 60))}${two(min % 60)}00Z`;
// The same minute as HH:MM on the Brussels wall clock (UTC+2 on that day).
const bx = (min) => `${two(Math.floor((min + 120) / 60))}:${two((min + 120) % 60)}`;
const ev = (title, startMin, endMin, extra) =>
  vevent({ summary: title, start: z(startMin), end: z(endMin), extra });
const cal = (name, ...events) => ({ name, ics: [vcalendar(...events)] });
const set = (name, kind) => (kind === undefined ? { name } : { name, kind });

// Home, Work and Family in that order: the fake gives them cal-1, cal-2 and cal-3.
function threeCalendars() {
  return [
    cal('Home', ev('Dentist', 480, 540)),
    cal('Work', ev('Standup', 420, 450)),
    cal('Family', ev('Picnic', 600, 660)),
  ];
}

function setup(calendars = threeCalendars(), { login = LOGIN, opts = {} } = {}) {
  const fake = fakeCalDav({ user: USER, password: PASS, calendars });
  const source = createCalendarSource({ fetch: fake.fetch, login, ...opts });
  return { fake, source };
}

const ask = (source, calendars, now = NOW, tz = TZ) => source.read({ calendars, tz, now });
const ofMethod = (fake, method, from = 0) => fake.calls.slice(from).filter((c) => c.method === method);
const pathOf = (call) => new URL(call.url).pathname;
const hostOf = (call) => new URL(call.url).hostname;
const hit = (calls, part) => calls.filter((c) => c.url.includes(part));
const warn = (code, count = 1) => [{ code, count }];

// An abort timer alone does not keep the event loop alive, so hold the process open.
async function holdOpen(fn) {
  const keep = setInterval(() => {}, 1000);
  try {
    return await fn();
  } finally {
    clearInterval(keep);
  }
}

// The four read paths of R103: a first read, a reuse, a new search, a failure.
async function everyPath() {
  const { fake, source } = setup();
  const named = [set('Home', 'personal'), set('Gym')];
  await ask(source, named, NOW);
  await ask(source, named, plus(NOW, MIN));
  await ask(source, named, plus(NOW, 7 * MIN));
  fake.state.fail = { step: 'report', status: 500 };
  await ask(source, named, plus(NOW, 14 * MIN));
  return { fake, source };
}

// ---- R97 ----

test('R97 reads only the calendars the settings name, with their kinds', async () => {
  const { fake, source } = setup();
  const out = await ask(source, [set(' home ', 'personal'), set('Work')]);
  assert.deepEqual(out.value, {
    date: TODAY,
    events: [
      { title: 'Standup', start: bx(420), end: bx(450), kind: 'meeting' },
      { title: 'Dentist', start: bx(480), end: bx(540), kind: 'personal' },
    ],
  });
  assert.deepEqual(out.warnings, []);
  const reports = ofMethod(fake, 'REPORT');
  assert.equal(reports.length, 2);
  assert.equal(hit(reports, '/cal-1/').length, 1); // Home: a REPORT was sent
  assert.equal(hit(reports, '/cal-2/').length, 1); // Work
  assert.equal(hit(reports, '/cal-3/').length, 0); // Family: none
});

test('R97 a name that matches nothing adds one calendar-not-found and the others are still read', async () => {
  const { fake, source } = setup();
  const out = await ask(source, [set(' home ', 'personal'), set('Work'), set('Gym')]);
  assert.deepEqual(out.value, {
    date: TODAY,
    events: [
      { title: 'Standup', start: bx(420), end: bx(450), kind: 'meeting' },
      { title: 'Dentist', start: bx(480), end: bx(540), kind: 'personal' },
    ],
  });
  assert.deepEqual(out.warnings, warn('calendar-not-found'));
  assert.equal(hit(ofMethod(fake, 'REPORT'), '/cal-3/').length, 0);
});

test('R97 a task list is never matched', async () => {
  const { fake, source } = setup();
  const out = await ask(source, [set('Reminders')]);
  assert.deepEqual(out.value, { date: TODAY, events: [] });
  assert.deepEqual(out.warnings, warn('calendar-not-found'));
  assert.equal(ofMethod(fake, 'REPORT').length, 0);
  assert.equal(hit(fake.calls, '/reminders/').length, 0);
});

test('R97 an inbox is never matched', async () => {
  const { fake, source } = setup();
  const out = await ask(source, [set('inbox')]);
  assert.deepEqual(out.warnings, warn('calendar-not-found'));
  assert.equal(ofMethod(fake, 'REPORT').length, 0);
  assert.equal(hit(fake.calls, '/inbox/').length, 0);
});

test('R97 two iCloud calendars with the same name are both read', async () => {
  const calendars = [cal('Home', ev('First', 480, 540)), cal('Home', ev('Second', 600, 660))];
  const { fake, source } = setup(calendars);
  const out = await ask(source, [set('Home', 'personal')]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['First', 'Second']);
  assert.deepEqual(out.value.events.map((e) => e.kind), ['personal', 'personal']);
  assert.equal(ofMethod(fake, 'REPORT').length, 2);
  assert.deepEqual(out.warnings, []);
});

test('R97 events from several calendars are sorted by start, then end, then title', async () => {
  const calendars = [
    cal('Alpha', ev('B title', 480, 540), ev('A title', 480, 540)),
    cal('Beta', ev('Short', 480, 510), ev('Early', 360, 420)),
  ];
  const { source } = setup(calendars);
  const out = await ask(source, [set('Beta'), set('Alpha')]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Early', 'Short', 'A title', 'B title']);
  assert.deepEqual(out.value.events.map((e) => [e.start, e.end]), [
    [bx(360), bx(420)],
    [bx(480), bx(510)],
    [bx(480), bx(540)],
    [bx(480), bx(540)],
  ]);
});

test('R97 more than 30 events are cut to the first 30', async () => {
  const many = [];
  for (let i = 0; i < 35; i += 1) many.push(ev(`E${two(i)}`, 420 + 10 * i, 425 + 10 * i));
  const { source } = setup([cal('Home', ...many)]);
  const out = await ask(source, [set('Home')]);
  assert.equal(out.value.events.length, 30);
  assert.deepEqual(
    out.value.events.map((e) => e.title),
    Array.from({ length: 30 }, (_, i) => `E${two(i)}`),
  );
});

test('R97 an event in a calendar of fewer than 30 stays whole (twin of the cut)', async () => {
  const some = [];
  for (let i = 0; i < 30; i += 1) some.push(ev(`E${two(i)}`, 420 + 10 * i, 425 + 10 * i));
  const { source } = setup([cal('Home', ...some)]);
  const out = await ask(source, [set('Home')]);
  assert.equal(out.value.events.length, 30);
  assert.equal(out.value.events[29].title, 'E29');
});

// ---- R100 ----

test('R100 two reads one minute apart send requests for the first only and answer alike', async () => {
  const { fake, source } = setup();
  const named = [set('Home', 'personal')];
  const first = await ask(source, named, NOW);
  const after = fake.calls.length;
  assert.equal(after, 4); // three searches and one report
  const second = await ask(source, named, plus(NOW, MIN));
  assert.equal(fake.calls.length, after);
  assert.deepEqual(second, first);
  assert.deepEqual(first.value.events.map((e) => e.title), ['Dentist']);
});

test('R100 a read six minutes after the first asks for events again but not for the calendar list', async () => {
  const { fake, source } = setup();
  const named = [set('Home', 'personal')];
  const first = await ask(source, named, NOW);
  await ask(source, named, plus(NOW, MIN));
  const before = fake.calls.length;
  const third = await ask(source, named, plus(NOW, 6 * MIN));
  const fresh = fake.calls.slice(before);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].method, 'REPORT');
  assert.equal(ofMethod(fake, 'PROPFIND').length, 3);
  assert.deepEqual(third, first);
});

test('R100 a read after the date changed makes new requests including the search', async () => {
  const { fake, source } = setup();
  const named = [set('Home', 'personal')];
  const late = '2026-10-12T21:58:00.000Z'; // 23:58 in Brussels
  const soon = '2026-10-12T22:01:00.000Z'; // 00:01 on the 13th, three minutes later
  const first = await ask(source, named, late);
  assert.equal(first.value.date, '2026-10-12');
  const before = fake.calls.length;
  const second = await ask(source, named, soon);
  const fresh = fake.calls.slice(before);
  assert.equal(second.value.date, '2026-10-13');
  assert.equal(ofMethod(fake, 'PROPFIND', before).length, 3);
  assert.equal(ofMethod(fake, 'REPORT', before).length, 1);
  assert.ok(fresh[fresh.length - 1].body.includes('start="20261012T220000Z"'));
  assert.ok(fresh[fresh.length - 1].body.includes('end="20261013T220000Z"'));
});

test('R100 a changed calendars list within five minutes is a fresh read', async () => {
  const { fake, source } = setup();
  await ask(source, [set('Home')], NOW);
  const before = fake.calls.length;
  const out = await ask(source, [set('Home'), set('Work')], plus(NOW, MIN));
  const fresh = fake.calls.slice(before);
  assert.ok(hit(fresh.filter((c) => c.method === 'REPORT'), '/cal-2/').length === 1);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Standup', 'Dentist']);
});

test('R100 a changed kind within five minutes is a fresh read', async () => {
  const { fake, source } = setup();
  await ask(source, [set('Home', 'personal')], NOW);
  const before = fake.calls.length;
  const out = await ask(source, [set('Home', 'focus')], plus(NOW, MIN));
  assert.ok(fake.calls.length > before);
  assert.equal(out.value.events[0].kind, 'focus');
});

test('R100 a different timezone within five minutes is a fresh read', async () => {
  const { fake, source } = setup();
  const named = [set('Home')];
  await ask(source, named, NOW, TZ);
  const before = fake.calls.length;
  const out = await ask(source, named, plus(NOW, MIN), 'America/New_York');
  const reports = ofMethod(fake, 'REPORT', before);
  assert.equal(reports.length, 1);
  assert.ok(reports[0].body.includes('start="20261012T040000Z"'));
  assert.ok(reports[0].body.includes('end="20261013T040000Z"'));
  assert.equal(out.value.date, TODAY);
});

test('R100 a setting naming a missing calendar searches again on each real read, once per read', async () => {
  const { fake, source } = setup();
  const named = [set('Home'), set('Gym')];
  await ask(source, named, NOW);
  assert.equal(ofMethod(fake, 'PROPFIND').length, 3);
  await ask(source, named, plus(NOW, 6 * MIN));
  assert.equal(ofMethod(fake, 'PROPFIND').length, 6);
  await ask(source, named, plus(NOW, 7 * MIN)); // reused: no request at all
  assert.equal(ofMethod(fake, 'PROPFIND').length, 6);
});

test('R100 an iCloud that never answers ends the read within its limit as a failure', async () => {
  const { fake, source } = setup(undefined, { opts: { budgetMs: 60, requestMs: 30 } });
  fake.state.fail = { step: 'principal', status: 'hang' };
  const started = Date.now();
  const out = await holdOpen(() => ask(source, [set('Home')]));
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(out.value, { error: 'unreadable' });
  assert.deepEqual(out.warnings, warn('calendar-unreachable'));
});

// ---- R101 ----

test('R101 a failing iCloud after a good read gives the same events marked stale', async () => {
  const { fake, source } = setup();
  const named = [set('Home', 'personal')];
  const good = await ask(source, named, NOW);
  assert.equal(good.value.stale, undefined);
  fake.state.fail = { step: 'report', status: 500 };
  const out = await ask(source, named, plus(NOW, 6 * MIN));
  assert.deepEqual(out.value, { ...good.value, stale: true });
  assert.equal(out.value.events.length, 1);
  assert.deepEqual(out.warnings, warn('calendar-unreachable'));
});

test('R101 a first read that fails gives unreadable and calendar-unreachable, for every kind at every step', async () => {
  for (const status of ['network', 500, 'garbage', 'hang']) {
    for (const step of ['principal', 'home', 'calendars', 'report']) {
      const opts = status === 'hang' ? { budgetMs: 60, requestMs: 30 } : {};
      const { fake, source } = setup(undefined, { opts });
      fake.state.fail = { step, status };
      const out = await holdOpen(() => ask(source, [set('Home')]));
      assert.deepEqual(out.value, { error: 'unreadable' }, `${status} at ${step}`);
      assert.deepEqual(out.warnings, warn('calendar-unreachable'), `${status} at ${step}`);
    }
  }
});

test('R101 a refused sign-in or a 403 gives calendar-login-refused', async () => {
  const wrong = setup(undefined, { login: { user: USER, password: WRONG } });
  const refused = await ask(wrong.source, [set('Home')]);
  assert.deepEqual(refused.value, { error: 'unreadable' });
  assert.deepEqual(refused.warnings, warn('calendar-login-refused'));
  for (const status of [401, 403]) {
    for (const step of ['principal', 'home', 'calendars', 'report']) {
      const { fake, source } = setup();
      fake.state.fail = { step, status };
      const out = await ask(source, [set('Home')]);
      assert.deepEqual(out.value, { error: 'unreadable' }, `${status} at ${step}`);
      assert.deepEqual(out.warnings, warn('calendar-login-refused'), `${status} at ${step}`);
    }
  }
});

test('R101 a refused sign-in after a good read still shows the kept events as stale', async () => {
  const { fake, source } = setup();
  const named = [set('Home')];
  const good = await ask(source, named, NOW);
  fake.state.fail = { step: 'report', status: 403 };
  const out = await ask(source, named, plus(NOW, 6 * MIN));
  assert.deepEqual(out.value, { ...good.value, stale: true });
  assert.deepEqual(out.warnings, warn('calendar-login-refused'));
});

test('R101 an answer that is not a multistatus on the report step is not an empty calendar', async () => {
  const { fake, source } = setup();
  fake.state.fail = { step: 'report', status: 'garbage' };
  const out = await ask(source, [set('Home')]);
  assert.deepEqual(out.value, { error: 'unreadable' });
  assert.equal('events' in out.value, false);
  assert.deepEqual(out.warnings, warn('calendar-unreachable'));
});

test('R101 a real empty calendar gives an empty day and no warning', async () => {
  const { source } = setup([{ name: 'Home', ics: [] }]);
  const out = await ask(source, [set('Home')]);
  assert.deepEqual(out.value, { date: TODAY, events: [] });
  assert.deepEqual(out.warnings, []);
});

test('R101 after a failure the same failure answer comes back for a minute with no request', async () => {
  const { fake, source } = setup();
  const named = [set('Home')];
  fake.state.fail = { step: 'principal', status: 500 };
  const failed = await ask(source, named, NOW);
  const before = fake.calls.length;
  assert.equal(before, 1);
  fake.state.fail = null;
  const again = await ask(source, named, plus(NOW, 30 * 1000));
  assert.deepEqual(again, failed);
  assert.equal(fake.calls.length, before);
});

test('R101 two minutes after a failure the next read tries again and shows fresh events', async () => {
  const { fake, source } = setup();
  const named = [set('Home')];
  fake.state.fail = { step: 'principal', status: 500 };
  await ask(source, named, NOW);
  fake.state.fail = null;
  const out = await ask(source, named, plus(NOW, 2 * MIN));
  assert.deepEqual(out.value.events.map((e) => e.title), ['Dentist']);
  assert.equal(out.value.stale, undefined);
  assert.deepEqual(out.warnings, []);
});

test('R101 a kept answer from yesterday is not shown stale today', async () => {
  const { fake, source } = setup();
  const named = [set('Home')];
  const good = await ask(source, named, NOW);
  assert.equal(good.value.events.length, 1);
  fake.state.fail = { step: 'principal', status: 'network' };
  const out = await ask(source, named, '2026-10-13T06:10:00.000Z');
  assert.deepEqual(out.value, { error: 'unreadable' });
  assert.deepEqual(out.warnings, warn('calendar-unreachable'));
});

// ---- R102 ----

test('R102 a home on a foreign host, or on a look-alike or plain http address, is never requested', async () => {
  const homes = [
    'https://evil.example/123456789/calendars/',
    'https://icloud.com.evil.example/123456789/calendars/',
    'http://p99-caldav.icloud.com/123456789/calendars/',
  ];
  for (const home of homes) {
    const { fake, source } = setup();
    fake.state.home = home;
    const out = await ask(source, [set('Home')]);
    assert.deepEqual(out.value, { error: 'unreadable' }, home);
    assert.deepEqual(out.warnings, warn('calendar-unreachable'), home);
    assert.ok(fake.calls.length > 0, home); // the earlier steps did go to Apple
    for (const call of fake.calls) {
      assert.equal(call.url.startsWith('https://caldav.icloud.com/'), true, `${home}: ${call.url}`);
    }
    assert.equal(hit(fake.calls, 'evil.example').length, 0, home);
  }
});

test('R102 a home on Apple itself is requested (twin of the refused homes)', async () => {
  const { fake, source } = setup();
  await ask(source, [set('Home')]);
  assert.ok(fake.calls.some((c) => hostOf(c) === 'p99-caldav.icloud.com'));
});

test('R102 a redirect is never followed, whether it points abroad or to another Apple host', async () => {
  for (const location of ['https://evil.example/', 'https://p99-caldav.icloud.com/somewhere/']) {
    const { fake, source } = setup();
    fake.state.redirect = { step: 'principal', location };
    const out = await ask(source, [set('Home')]);
    assert.deepEqual(out.value, { error: 'unreadable' }, location);
    assert.deepEqual(out.warnings, warn('calendar-unreachable'), location);
    assert.equal(fake.calls.length, 1, location);
    assert.equal(fake.calls[0].url, 'https://caldav.icloud.com/', location);
  }
});

test('R102 a redirect on a later step is not followed either', async () => {
  const { fake, source } = setup();
  fake.state.redirect = { step: 'report', location: 'https://evil.example/x' };
  const out = await ask(source, [set('Home')]);
  assert.deepEqual(out.value, { error: 'unreadable' });
  assert.equal(hit(fake.calls, 'evil.example').length, 0);
  assert.equal(ofMethod(fake, 'REPORT').length, 1);
});

test('R102 every request is https to caldav.icloud.com or a host ending .icloud.com and carries the sign-in', async () => {
  const { fake } = await everyPath();
  assert.ok(fake.calls.length > 0);
  for (const call of fake.calls) {
    const url = new URL(call.url);
    assert.equal(url.protocol, 'https:', call.url);
    assert.ok(url.hostname === 'caldav.icloud.com' || url.hostname.endsWith('.icloud.com'), call.url);
    assert.equal(call.headers.authorization, AUTH);
  }
});

test('R102 the sign-in appears in no returned value or warning', async () => {
  const outs = [];
  const good = setup();
  outs.push(await ask(good.source, [set('Home'), set('Gym')], NOW));
  good.fake.state.fail = { step: 'report', status: 500 };
  outs.push(await ask(good.source, [set('Home'), set('Gym')], plus(NOW, 6 * MIN)));
  for (const status of ['network', 500, 'garbage', 401, 403]) {
    const { fake, source } = setup();
    fake.state.fail = { step: 'calendars', status };
    outs.push(await ask(source, [set('Home')]));
  }
  const refused = setup(undefined, { login: { user: USER, password: WRONG } });
  outs.push(await ask(refused.source, [set('Home')]));
  outs.push(await refused.source.inspect({ names: ['Home'], tz: TZ, now: NOW }));
  const evil = setup();
  evil.fake.state.home = 'https://evil.example/123456789/calendars/';
  outs.push(await ask(evil.source, [set('Home')]));
  assert.equal(outs.length, 10);
  for (const out of outs) {
    const text = JSON.stringify(out).toLowerCase();
    for (const secret of [USER, PASS, WRONG]) {
      assert.equal(text.includes(secret.toLowerCase()), false, text);
    }
  }
});

test('R102 read never rejects, whatever the failure', async () => {
  const kinds = ['network', 500, 401, 403, 'garbage', 'hang'];
  for (const status of kinds) {
    const opts = status === 'hang' ? { budgetMs: 60, requestMs: 30 } : {};
    const { fake, source } = setup(undefined, { opts });
    fake.state.fail = { step: 'principal', status };
    const out = await holdOpen(() => ask(source, [set('Home')]));
    assert.equal(typeof out, 'object', String(status));
    assert.deepEqual(out.value, { error: 'unreadable' }, String(status));
    assert.equal(Array.isArray(out.warnings), true, String(status));
  }
});

// ---- R103 ----

test('R103 over every read path, every recorded request is a PROPFIND or a REPORT', async () => {
  const { fake } = await everyPath();
  assert.ok(ofMethod(fake, 'PROPFIND').length > 0);
  assert.ok(ofMethod(fake, 'REPORT').length > 0);
  for (const call of fake.calls) {
    assert.ok(call.method === 'PROPFIND' || call.method === 'REPORT', `${call.method} ${call.url}`);
  }
});

test('R103 the paths each really sent something (so the list above is not vacuous)', async () => {
  const { fake } = await everyPath();
  // first read 4, reuse 0, new search 4, failed read: Gym is still missing so it searches again, then the report fails
  assert.ok(fake.calls.length >= 9);
  assert.ok(ofMethod(fake, 'PROPFIND').length >= 6);
});

// ---- U: request details ----

test('U the four requests of a first read carry the right Depth, content type and body', async () => {
  const { fake, source } = setup();
  await ask(source, [set('Home')]);
  assert.deepEqual(fake.calls.map((c) => c.method), ['PROPFIND', 'PROPFIND', 'PROPFIND', 'REPORT']);
  assert.deepEqual(fake.calls.map((c) => c.headers.depth), ['0', '0', '1', '1']);
  for (const call of fake.calls) {
    assert.equal(call.headers['content-type'], 'application/xml; charset=utf-8');
    assert.equal(call.headers['user-agent'], 'board');
  }
  const report = fake.calls[3];
  assert.ok(report.body.includes('start="20261011T220000Z"'));
  assert.ok(report.body.includes('end="20261012T220000Z"'));
  assert.equal(pathOf(report), '/123456789/calendars/cal-1/');
});

test('U two reads started together share one set of requests', async () => {
  const { fake, source } = setup();
  const named = [set('Home', 'personal')];
  const [a, b] = await Promise.all([ask(source, named), ask(source, named)]);
  assert.deepEqual(a, b);
  assert.equal(fake.calls.length, 4);
  assert.equal(a.value.events.length, 1);
});

test('U an event the signed-in address declined is absent; one declined by someone else is present', async () => {
  const mine = `ATTENDEE;PARTSTAT=DECLINED:mailto:${USER.toLowerCase()}`;
  const theirs = 'ATTENDEE;PARTSTAT=DECLINED:mailto:pat@example.com';
  const events = [
    vevent({ summary: 'Declined by me', start: z(420), end: z(450), extra: [mine] }),
    vevent({ summary: 'Kept', start: z(480), end: z(510) }),
    vevent({ summary: 'Declined by Pat', start: z(540), end: z(570), extra: [theirs] }),
  ];
  const { source } = setup([cal('Home', ...events)]);
  const out = await ask(source, [set('Home')]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Kept', 'Declined by Pat']);
  assert.deepEqual(out.warnings, []);
});

test('U calendar-event-skipped is summed across calendars', async () => {
  const hourly = (title, at) => vevent({ summary: title, start: z(at), end: z(at + 30), rrule: 'FREQ=HOURLY' });
  const { source } = setup([
    cal('Home', hourly('Hourly one', 420), ev('Plain', 600, 630)),
    cal('Work', hourly('Hourly two', 480)),
  ]);
  const out = await ask(source, [set('Home'), set('Work')]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Plain']);
  assert.deepEqual(out.warnings, warn('calendar-event-skipped', 2));
});

test('U calendar-zone-unknown is summed across calendars', async () => {
  const odd = (title) =>
    vevent({ summary: title, start: '20261012T100000', end: '20261012T110000', tzid: 'Mars/Olympus' });
  const { source } = setup([cal('Home', odd('Odd one')), cal('Work', odd('Odd two'))]);
  const out = await ask(source, [set('Home'), set('Work')]);
  assert.deepEqual(out.value.events.map((e) => [e.title, e.start, e.end]), [
    ['Odd one', '10:00', '11:00'],
    ['Odd two', '10:00', '11:00'],
  ]);
  assert.deepEqual(out.warnings, warn('calendar-zone-unknown', 2));
});

test('U all-day events are not in what read returns', async () => {
  const holiday = vevent({ summary: 'Holiday', start: '20261012', end: '20261013', allDay: true });
  const { source } = setup([cal('Home', holiday, ev('Timed', 480, 540))]);
  const out = await ask(source, [set('Home')]);
  assert.deepEqual(out.value.events.map((e) => e.title), ['Timed']);
  assert.deepEqual(out.warnings, []);
});

// ---- U: inspect ----

function inspectWorld() {
  const holiday = vevent({ summary: 'Holiday', start: '20261012', end: '20261013', allDay: true });
  return setup([
    cal('Home', ev('One', 420, 450), ev('Two', 480, 510), holiday),
    cal('Work'),
    cal('Family', ev('Three', 600, 630)),
  ]);
}

test('U inspect lists every event calendar and counts timed and all-day events per asked name', async () => {
  const { source } = inspectWorld();
  const out = await source.inspect({ names: ['Home', 'Gym'], tz: TZ, now: NOW });
  assert.equal(out.ok, true);
  assert.deepEqual([...out.found].sort(), ['Family', 'Home', 'Work']);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows[0], { name: 'Home', found: true, timed: 2, allDay: 1 });
  assert.equal(out.rows[1].name, 'Gym');
  assert.equal(out.rows[1].found, false);
  assert.deepEqual(out.warnings, []);
});

test('U inspect does not list the inbox or the task list', async () => {
  const { source } = inspectWorld();
  const out = await source.inspect({ names: [], tz: TZ, now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.found.includes('Reminders'), false);
  assert.equal(out.found.includes('inbox'), false);
  assert.equal(out.found.includes('Home'), true); // twin
  assert.deepEqual(out.rows, []);
});

test('U inspect with a refused sign-in gives calendar-login-refused', async () => {
  const { source } = setup(undefined, { login: { user: USER, password: WRONG } });
  const out = await source.inspect({ names: ['Home'], tz: TZ, now: NOW });
  assert.deepEqual(out, { ok: false, code: 'calendar-login-refused' });
});

test('U inspect with a dead service gives calendar-unreachable', async () => {
  const { fake, source } = setup();
  fake.state.fail = { step: 'principal', status: 'network' };
  const out = await source.inspect({ names: ['Home'], tz: TZ, now: NOW });
  assert.deepEqual(out, { ok: false, code: 'calendar-unreachable' });
});

test('U inspect keeps nothing and reuses nothing', async () => {
  const { fake, source } = inspectWorld();
  const args = { names: ['Home'], tz: TZ, now: NOW };
  await source.inspect(args);
  const afterFirst = fake.calls.length;
  assert.ok(afterFirst > 0);
  await source.inspect(args);
  assert.equal(fake.calls.length, 2 * afterFirst);
  const before = fake.calls.length;
  const out = await ask(source, [set('Home')], plus(NOW, 1000));
  assert.equal(ofMethod(fake, 'PROPFIND', before).length, 3);
  assert.equal(ofMethod(fake, 'REPORT', before).length, 1);
  assert.deepEqual(out.value.events.map((e) => e.title), ['One', 'Two']);
});
