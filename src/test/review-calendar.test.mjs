// Review tests for rules R99 (repeating events: RDATE, titleless changed occurrence)
// and R100 (a read under way is shared only by callers asking for the same thing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { eventsOn } from '../board/calendar/ics.mjs';
import { createCalendarSource } from '../board/calendar/icloud.mjs';
import { fakeCalDav } from '../fixtures/fake-caldav.mjs';

const TODAY = '2026-10-12';
const BRUSSELS = 'Europe/Brussels';

function run(...events) {
  return eventsOn(vcalendar(...events), { date: TODAY, tz: BRUSSELS, self: null });
}
const shown = (r) => r.events.map((e) => `${e.title} ${e.start}-${e.end}`);

// ---------------------------------------------------------------- R99

const dailyDesign = (extra = {}) => vevent({
  uid: 'design', summary: 'Design review', start: '20261001T090000', end: '20261001T100000',
  rrule: 'FREQ=DAILY', ...extra,
});

test('R99 a changed occurrence with no title of its own shows the title of its series', () => {
  const moved = vevent({
    uid: 'design', start: '20261012T160000', end: '20261012T170000', recurrenceId: '20261012T090000',
  });
  const r = run(dailyDesign(), moved);
  assert.deepEqual(shown(r), ['Design review 16:00-17:00']);
  assert.equal(r.skipped, 0);
});

test('R99 a changed occurrence with a title of its own keeps its own title', () => {
  const moved = vevent({
    uid: 'design', summary: 'Design review (moved)', start: '20261012T160000', end: '20261012T170000',
    recurrenceId: '20261012T090000',
  });
  const r = run(dailyDesign(), moved);
  assert.deepEqual(shown(r), ['Design review (moved) 16:00-17:00']);
});

test('R99 a weekly series with an RDATE line shows its rule day and adds one to skipped', () => {
  const weekly = vevent({
    uid: 'weekly', summary: 'Weekly sync', start: '20261005T090000', end: '20261005T100000',
    rrule: 'FREQ=WEEKLY;BYDAY=MO', rdate: '20261020T090000',
  });
  const r = run(weekly);
  assert.deepEqual(shown(r), ['Weekly sync 09:00-10:00']);
  assert.equal(r.skipped, 1);
});

test('R99 a single event with an RDATE line shows at its own start and adds one to skipped', () => {
  const single = vevent({
    uid: 'one', summary: 'One-off', start: '20261012T100000', end: '20261012T110000', rdate: '20261020T100000',
  });
  const r = run(single);
  assert.deepEqual(shown(r), ['One-off 10:00-11:00']);
  assert.equal(r.skipped, 1);
});

test('R99 a single event without an RDATE line adds nothing to skipped', () => {
  const single = vevent({
    uid: 'one', summary: 'One-off', start: '20261012T100000', end: '20261012T110000',
  });
  const r = run(single);
  assert.deepEqual(shown(r), ['One-off 10:00-11:00']);
  assert.equal(r.skipped, 0);
});

// ---------------------------------------------------------------- R100

const USER = 'Zed.Sentinel@example.com';
const PASS = 'pw-Sentinel-4417';
const NOW = '2026-10-12T06:10:00.000Z';
// 12:00Z: 14:00 on 12 October in Brussels, 02:00 on 13 October in Kiritimati (UTC+14).
const NOW_SPLIT = '2026-10-12T12:00:00.000Z';

const cal = (name, summary) => ({
  name,
  ics: [vcalendar(vevent({ summary, start: '20261012T080000Z', end: '20261012T083000Z' }))],
});

function setup() {
  const fake = fakeCalDav({ user: USER, password: PASS, calendars: [cal('Work', 'Standup'), cal('Home', 'Dinner')] });
  const source = createCalendarSource({ fetch: fake.fetch, login: { user: USER, password: PASS } });
  return { fake, source };
}
const named = (...names) => names.map((name) => ({ name }));
const titles = (answer) => (answer.value.events || []).map((e) => e.title);

async function holdOpen(fn) {
  const keep = setInterval(() => {}, 1000);
  try { return await fn(); } finally { clearInterval(keep); }
}

test('R100 two reads started together for the same day, timezone and calendars share one set of requests', () => holdOpen(async () => {
  const solo = setup();
  await solo.source.read({ calendars: named('Work'), tz: BRUSSELS, now: NOW });
  const expected = solo.fake.calls.length;

  const { fake, source } = setup();
  const [a, b] = await Promise.all([
    source.read({ calendars: named('Work'), tz: BRUSSELS, now: NOW }),
    source.read({ calendars: named('Work'), tz: BRUSSELS, now: NOW }),
  ]);
  assert.equal(fake.calls.length, expected);
  assert.deepEqual(a, b);
  assert.deepEqual(titles(a), ['Standup']);
}));

test('R100 two reads started together for different named calendars each get their own events', () => holdOpen(async () => {
  const { source } = setup();
  const [a, b] = await Promise.all([
    source.read({ calendars: named('Work'), tz: BRUSSELS, now: NOW }),
    source.read({ calendars: named('Home'), tz: BRUSSELS, now: NOW }),
  ]);
  assert.deepEqual(titles(a), ['Standup']);
  assert.deepEqual(titles(b), ['Dinner']);
}));

test('R100 two reads started together for different timezones each get their own day', () => holdOpen(async () => {
  const { source } = setup();
  const [a, b] = await Promise.all([
    source.read({ calendars: named('Work'), tz: BRUSSELS, now: NOW_SPLIT }),
    source.read({ calendars: named('Work'), tz: 'Pacific/Kiritimati', now: NOW_SPLIT }),
  ]);
  assert.equal(a.value.date, '2026-10-12');
  assert.equal(b.value.date, '2026-10-13');
}));
