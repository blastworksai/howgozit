// Rules R98 and R99: which events of an iCalendar text fall on the board's day (eventsOn).
// Every expected value is worked out by hand from references/contract.md and reference/calendar-spec.md.
// Board timezone Europe/Brussels, today 2026-10-12 (a Monday, summer time, UTC+2) unless a test says otherwise.
// Written before board/calendar/ics.mjs exists: the module is built against these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { eventsOn } from '../board/calendar/ics.mjs';

const TODAY = '2026-10-12';
const BRUSSELS = 'Europe/Brussels';
const SELF = 'sam@example.com';
const NONE = { events: [], allDay: [], skipped: 0, unknownZones: 0 };

function run(events, opts = {}) {
  return eventsOn(vcalendar(...events), { date: TODAY, tz: BRUSSELS, self: null, ...opts });
}

// Sorted by start, then end, then title; eventsOn itself returns them unsorted.
function sorted(result) {
  const rank = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...result.events].sort((a, b) => rank(a.start, b.start) || rank(a.end, b.end) || rank(a.title, b.title));
}
const ev = (title, start, end) => ({ title, start, end });
const timed = (summary, start, end, more = {}) => vevent({ summary, start, end, ...more });
const declinedBy = (address) => `ATTENDEE;CN=Guest;PARTSTAT=DECLINED:mailto:${address}`;

// A daily series that began on 1 October at 09:00 board time and lasts one hour.
const daily = (summary, more = {}) => vevent({
  uid: summary, summary, start: '20261001T090000', end: '20261001T100000', rrule: 'FREQ=DAILY', ...more,
});
// A single series by rule text, first held on `start` at 09:00 for one hour, board time.
const series = (summary, rrule, startDate, more = {}) => vevent({
  uid: summary, summary, start: `${startDate}T090000`, end: `${startDate}T100000`, rrule, ...more,
});
const NINE = (title) => ev(title, '09:00', '10:00');

// ---------------------------------------------------------------- R98

test('R98 shows a UTC event in board time', () => {
  const r = run([timed('Standup', '20261012T083000Z', '20261012T084500Z')]);
  assert.deepEqual(r, { events: [ev('Standup', '10:30', '10:45')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R98 shows an event in another zone in board time', () => {
  // 14:00 to 15:00 in New York (UTC-4 on 12 October) is 18:00Z to 19:00Z, 20:00 to 21:00 in Brussels.
  const r = run([timed('Call', '20261012T140000', '20261012T150000', { tzid: 'America/New_York' })]);
  assert.deepEqual(r, { events: [ev('Call', '20:00', '21:00')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R98 reads a time with no zone as board time', () => {
  const r = run([timed('Coffee', '20261012T090000', '20261012T093000')]);
  assert.deepEqual(r, { events: [ev('Coffee', '09:00', '09:30')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R98 an event that began yesterday starts at 00:00', () => {
  const r = run([timed('Late', '20261011T230000', '20261012T010000')]);
  assert.deepEqual(r.events, [ev('Late', '00:00', '01:00')]);
});

test('R98 an event that runs on past midnight ends at 24:00', () => {
  const r = run([timed('Night', '20261012T233000', '20261013T003000')]);
  assert.deepEqual(r.events, [ev('Night', '23:30', '24:00')]);
});

test('R98 an event covering the whole day and more shows 00:00 to 24:00', () => {
  const r = run([timed('Retreat', '20261011T200000', '20261013T020000')]);
  assert.deepEqual(r.events, [ev('Retreat', '00:00', '24:00')]);
});

test('R98 an event that ends exactly at midnight does not reach today, one minute later does', () => {
  assert.deepEqual(run([timed('Ends at midnight', '20261011T230000', '20261012T000000')]).events, []);
  assert.deepEqual(run([timed('Ends just after', '20261011T230000', '20261012T000100')]).events,
    [ev('Ends just after', '00:00', '00:01')]);
});

test('R98 an event that starts exactly at tomorrow midnight is not shown, one minute earlier is', () => {
  assert.deepEqual(run([timed('Starts tomorrow', '20261013T000000', '20261013T010000')]).events, []);
  assert.deepEqual(run([timed('Starts late', '20261012T235900', '20261013T010000')]).events,
    [ev('Starts late', '23:59', '24:00')]);
});

test('R98 leaves out a cancelled event and keeps the same event when it is not cancelled', () => {
  const gone = run([timed('Cancelled', '20261012T100000', '20261012T110000', { status: 'CANCELLED' })]);
  assert.deepEqual(gone, NONE);
  const kept = run([timed('Confirmed', '20261012T100000', '20261012T110000', { status: 'CONFIRMED' })]);
  assert.deepEqual(kept, { events: [ev('Confirmed', '10:00', '11:00')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R98 leaves out an invitation the signed-in address declined, whatever the letter case', () => {
  const declined = timed('Declined', '20261012T100000', '20261012T110000', { extra: [declinedBy('Sam@Example.COM')] });
  assert.deepEqual(run([declined], { self: SELF }), NONE);
});

test('R98 keeps the declined invitation when no address is signed in', () => {
  const declined = timed('Declined', '20261012T100000', '20261012T110000', { extra: [declinedBy(SELF)] });
  assert.deepEqual(run([declined], { self: null }).events, [ev('Declined', '10:00', '11:00')]);
});

test('R98 keeps an invitation that someone else declined', () => {
  const other = timed('Other declined', '20261012T100000', '20261012T110000', { extra: [declinedBy('alex@example.com')] });
  assert.deepEqual(run([other], { self: SELF }).events, [ev('Other declined', '10:00', '11:00')]);
});

test('R98 keeps an invitation the signed-in address accepted', () => {
  const accepted = timed('Accepted', '20261012T100000', '20261012T110000', {
    extra: [`ATTENDEE;CN=Sam;PARTSTAT=ACCEPTED:mailto:${SELF}`],
  });
  assert.deepEqual(run([accepted], { self: SELF }).events, [ev('Accepted', '10:00', '11:00')]);
});

test('R98 lists an all-day event in allDay and not in events', () => {
  const r = run([vevent({ summary: 'Holiday', start: '20261012', end: '20261013', allDay: true })]);
  assert.deepEqual(r, { events: [], allDay: [{ title: 'Holiday' }], skipped: 0, unknownZones: 0 });
});

test('R98 an all-day event with no end lasts one day', () => {
  const r = run([vevent({ summary: 'Day off', start: '20261012', allDay: true })]);
  assert.deepEqual(r.allDay, [{ title: 'Day off' }]);
  assert.deepEqual(run([vevent({ summary: 'Day off', start: '20261011', allDay: true })]).allDay, []);
});

test('R98 a multi-day all-day event lists every day it covers', () => {
  const r = run([vevent({ summary: 'Trip', start: '20261010', end: '20261014', allDay: true })]);
  assert.deepEqual(r.allDay, [{ title: 'Trip' }]);
  assert.deepEqual(r.events, []);
});

test('R98 an all-day event whose exclusive end is today is not listed, one ending tomorrow is', () => {
  const ends = run([vevent({ summary: 'Ended', start: '20261010', end: '20261012', allDay: true })]);
  assert.deepEqual(ends, NONE);
  const goes = run([vevent({ summary: 'Goes on', start: '20261010', end: '20261013', allDay: true })]);
  assert.deepEqual(goes.allDay, [{ title: 'Goes on' }]);
});

test('R98 an all-day event that starts tomorrow is not listed today', () => {
  assert.deepEqual(run([vevent({ summary: 'Tomorrow', start: '20261013', end: '20261014', allDay: true })]), NONE);
  assert.deepEqual(run([vevent({ summary: 'Tomorrow', start: '20261013', end: '20261014', allDay: true })], { date: '2026-10-13' }).allDay,
    [{ title: 'Tomorrow' }]);
});

test('R98 an all-day event with a duration covers that many days', () => {
  const r = run([vevent({ summary: 'Camp', start: '20261010', duration: 'P3D', allDay: true })]);
  assert.deepEqual(r.allDay, [{ title: 'Camp' }]);
  assert.deepEqual(run([vevent({ summary: 'Camp', start: '20261009', duration: 'P3D', allDay: true })]).allDay, []);
});

test('R98 leaves out an event on the 13th and shows the same event on the 12th', () => {
  assert.deepEqual(run([timed('Tomorrow', '20261013T100000', '20261013T110000')]), NONE);
  assert.deepEqual(run([timed('Today', '20261012T100000', '20261012T110000')]).events, [ev('Today', '10:00', '11:00')]);
});

test('R98 an event with no length inside the day shows equal start and end', () => {
  const r = run([timed('Ping', '20261012T101500')]);
  assert.deepEqual(r.events, [ev('Ping', '10:15', '10:15')]);
  assert.deepEqual(run([timed('Ping', '20261013T101500')]).events, []);
});

test('R98 reads the end from a DURATION of 45 minutes', () => {
  assert.deepEqual(run([timed('Short', '20261012T100000', undefined, { duration: 'PT45M' })]).events, [ev('Short', '10:00', '10:45')]);
});

test('R98 reads the end from a DURATION of an hour and a half', () => {
  assert.deepEqual(run([timed('Long', '20261012T100000', undefined, { duration: 'PT1H30M' })]).events, [ev('Long', '10:00', '11:30')]);
});

test('R98 reads the end from a DURATION of one day', () => {
  assert.deepEqual(run([timed('Whole', '20261012T100000', undefined, { duration: 'P1D' })]).events, [ev('Whole', '10:00', '24:00')]);
  assert.deepEqual(run([timed('Whole', '20261012T100000', undefined, { duration: 'P1D' })], { date: '2026-10-13' }).events,
    [ev('Whole', '00:00', '10:00')]);
});

test('R98 an end before the start is read as the start', () => {
  assert.deepEqual(run([timed('Backwards', '20261012T100000', '20261012T090000')]).events, [ev('Backwards', '10:00', '10:00')]);
});

test('R98 an unknown zone shows at the written time and counts once', () => {
  const r = run([timed('Mars call', '20261012T100000', '20261012T103000', { tzid: 'Mars/Olympus' })]);
  assert.deepEqual(r, { events: [ev('Mars call', '10:00', '10:30')], allDay: [], skipped: 0, unknownZones: 1 });
});

test('R98 an unknown zone is read in the board timezone, not in Brussels', () => {
  // Board timezone Tokyo (UTC+9): the written 10:00 stays 10:00; a real Brussels 10:00 would be 17:00.
  const unknown = run([timed('Mars call', '20261012T100000', '20261012T103000', { tzid: 'Mars/Olympus' })], { tz: 'Asia/Tokyo' });
  assert.deepEqual(unknown, { events: [ev('Mars call', '10:00', '10:30')], allDay: [], skipped: 0, unknownZones: 1 });
});

test('R98 a TZID with a path prefix is read as the real zone and is not unknown', () => {
  const prefixed = run([timed('Prefixed', '20261012T100000', '20261012T103000', { tzid: '/example.org/Europe/Brussels' })], { tz: 'Asia/Tokyo' });
  assert.deepEqual(prefixed, { events: [ev('Prefixed', '17:00', '17:30')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R98 a known zone adds nothing to unknownZones', () => {
  const known = run([timed('Known', '20261012T100000', '20261012T103000', { tzid: 'Europe/Brussels' })]);
  assert.equal(known.unknownZones, 0);
  assert.deepEqual(known.events, [ev('Known', '10:00', '10:30')]);
});

test('R98 an event with no start is left out and counted as skipped', () => {
  const r = run([timed('No start', undefined, undefined)]);
  assert.deepEqual(r, { events: [], allDay: [], skipped: 1, unknownZones: 0 });
});

test('R98 the same event with a start is shown and nothing is skipped', () => {
  const r = run([timed('Has start', '20261012T100000', '20261012T110000')]);
  assert.deepEqual(r, { events: [ev('Has start', '10:00', '11:00')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R98 an event with an unreadable start is counted as skipped, the others still show', () => {
  const r = run([timed('Broken', 'not-a-time', undefined), timed('Fine', '20261012T100000', '20261012T110000')]);
  assert.deepEqual(r.events, [ev('Fine', '10:00', '11:00')]);
  assert.equal(r.skipped, 1);
});

test('R98 text that is not a calendar gives four empty values', () => {
  assert.deepEqual(eventsOn('this is not a calendar', { date: TODAY, tz: BRUSSELS, self: null }), NONE);
  assert.deepEqual(eventsOn('', { date: TODAY, tz: BRUSSELS, self: null }), NONE);
});

test('R98 a calendar with no event gives four empty values', () => {
  assert.deepEqual(run([]), NONE);
});

test('R98 text that cannot be read at all is one skipped event', () => {
  const huge = 'x'.repeat(2000001);
  assert.deepEqual(eventsOn(huge, { date: TODAY, tz: BRUSSELS, self: null }), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(eventsOn(null, { date: TODAY, tz: BRUSSELS, self: null }), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
});

test('R98 cleans a title: escapes undone, whitespace collapsed', () => {
  const r = run([timed('  Team\\, sync\\nnotes\\; \\\\ done  ', '20261012T100000', '20261012T110000')]);
  assert.deepEqual(r.events, [ev('Team, sync notes; \\ done', '10:00', '11:00')]);
});

test('R98 an event with no title reads (no title)', () => {
  const r = run([timed(undefined, '20261012T100000', '20261012T110000')]);
  assert.deepEqual(r.events, [ev('(no title)', '10:00', '11:00')]);
});

test('R98 cuts a title of 201 characters to 199 and an ellipsis, and leaves 200 whole', () => {
  const cut = run([timed('x'.repeat(201), '20261012T100000', '20261012T110000')]);
  assert.equal(cut.events[0].title, `${'x'.repeat(199)}…`);
  const whole = run([timed('y'.repeat(200), '20261012T100000', '20261012T110000')]);
  assert.equal(whole.events[0].title, 'y'.repeat(200));
});

test('R98 an all-day title is cleaned too', () => {
  const r = run([vevent({ summary: 'Fair\\, big', start: '20261012', allDay: true })]);
  assert.deepEqual(r.allDay, [{ title: 'Fair, big' }]);
});

test('R98 an event inside a nested block or an unknown property does not change the result', () => {
  const r = run([timed('With alarm', '20261012T100000', '20261012T110000', {
    extra: ['X-CUSTOM:whatever', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM'],
  })]);
  assert.deepEqual(r, { events: [ev('With alarm', '10:00', '11:00')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R98 board timezone Pacific/Kiritimati puts the same UTC event on the right local date and time', () => {
  // Kiritimati is UTC+14. Today's window runs 2026-10-11T10:00Z to 2026-10-12T10:00Z.
  const opts = { tz: 'Pacific/Kiritimati' };
  const events = [
    timed('Evening', '20261012T083000Z', '20261012T093000Z'), // 22:30 to 23:30 on the 12th
    timed('Across', '20261012T093000Z', '20261012T103000Z'), // 23:30 on the 12th to 00:30 on the 13th
    timed('Next day', '20261012T103000Z', '20261012T110000Z'), // 00:30 to 01:00 on the 13th
    timed('Floating', '20261012T100000', '20261012T110000'), // no zone: board time
  ];
  assert.deepEqual(sorted(run(events, opts)), [
    ev('Floating', '10:00', '11:00'),
    ev('Evening', '22:30', '23:30'),
    ev('Across', '23:30', '24:00'),
  ]);
  assert.deepEqual(sorted(run(events, { ...opts, date: '2026-10-13' })), [
    ev('Across', '00:00', '00:30'),
    ev('Next day', '00:30', '01:00'),
  ]);
});

test('R98 board timezone America/Adak puts the same UTC event on the right local date and time', () => {
  // Adak is UTC-9 on 12 October (summer time). Today's window runs 2026-10-12T09:00Z to 2026-10-13T09:00Z.
  const events = [
    timed('Before', '20261012T083000Z', '20261012T093000Z'), // 23:30 on the 11th to 00:30 on the 12th
    timed('Midday', '20261012T200000Z', '20261012T210000Z'), // 11:00 to 12:00
    timed('After', '20261013T083000Z', '20261013T093000Z'), // 23:30 on the 12th to 00:30 on the 13th
    timed('Gone', '20261013T093000Z', '20261013T103000Z'), // on the 13th
  ];
  assert.deepEqual(sorted(run(events, { tz: 'America/Adak' })), [
    ev('Before', '00:00', '00:30'),
    ev('Midday', '11:00', '12:00'),
    ev('After', '23:30', '24:00'),
  ]);
});

test('R98 the all-day date is the written date whatever the board timezone', () => {
  const holiday = vevent({ summary: 'Holiday', start: '20261012', end: '20261013', allDay: true });
  assert.deepEqual(run([holiday], { tz: 'Pacific/Kiritimati' }).allDay, [{ title: 'Holiday' }]);
  assert.deepEqual(run([holiday], { tz: 'America/Adak' }).allDay, [{ title: 'Holiday' }]);
  assert.deepEqual(run([holiday], { tz: 'America/Adak', date: '2026-10-13' }).allDay, []);
});

test('R98 the clock change: a 25-hour day shows an event once at its Brussels time', () => {
  // 2026-10-25: summer time ends at 01:00Z. The day runs 2026-10-24T22:00Z to 2026-10-25T23:00Z.
  const opts = { date: '2026-10-25' };
  const r = run([timed('After change', '20261025T023000Z', '20261025T033000Z')], opts);
  assert.deepEqual(r, { events: [ev('After change', '03:30', '04:30')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R98 the clock change: two events an hour apart both read 02:30', () => {
  const opts = { date: '2026-10-25' };
  const r = run([
    timed('First pass', '20261025T003000Z', '20261025T004500Z'),
    timed('Second pass', '20261025T013000Z', '20261025T014500Z'),
  ], opts);
  assert.deepEqual(sorted(r), [ev('First pass', '02:30', '02:45'), ev('Second pass', '02:30', '02:45')]);
});

test('R98 the clock change: an event from 22:30Z the day before to 23:30Z shows 00:30 to 24:00', () => {
  const r = run([timed('Long', '20261024T223000Z', '20261025T233000Z')], { date: '2026-10-25' });
  assert.deepEqual(r.events, [ev('Long', '00:30', '24:00')]);
});

test('R98 the clock change: the day after the 25-hour day starts at its own midnight', () => {
  // 2026-10-25T23:30Z is 00:30 on the 26th: the same event begins on the 26th at 00:00.
  const r = run([timed('Long', '20261024T223000Z', '20261025T233000Z')], { date: '2026-10-26' });
  assert.deepEqual(r.events, [ev('Long', '00:00', '00:30')]);
});

test('R98 the nine events of the contract check give exactly five, in order', () => {
  const calendar = [
    timed('From UTC', '20261012T083000Z', '20261012T084500Z'),
    timed('From New York', '20261012T140000', '20261012T150000', { tzid: 'America/New_York' }),
    timed('No zone', '20261012T090000', '20261012T093000'),
    timed('Overnight in', '20261011T230000', '20261012T010000'),
    timed('Overnight out', '20261012T233000', '20261013T003000'),
    timed('Cancelled', '20261012T120000', '20261012T130000', { status: 'CANCELLED' }),
    timed('Declined', '20261012T130000', '20261012T140000', { extra: [declinedBy('Sam@Example.com')] }),
    vevent({ summary: 'All day', start: '20261012', end: '20261013', allDay: true }),
    timed('Tomorrow', '20261013T100000', '20261013T110000'),
  ];
  const r = run(calendar, { self: SELF });
  assert.equal(r.events.length, 5);
  assert.deepEqual(sorted(r).map((e) => [e.start, e.end]), [
    ['00:00', '01:00'],
    ['09:00', '09:30'],
    ['10:30', '10:45'],
    ['20:00', '21:00'],
    ['23:30', '24:00'],
  ]);
  assert.deepEqual(sorted(r).map((e) => e.title), ['Overnight in', 'No zone', 'From UTC', 'From New York', 'Overnight out']);
  assert.deepEqual(r.allDay, [{ title: 'All day' }]);
  assert.equal(r.skipped, 0);
  assert.equal(r.unknownZones, 0);
});

test('R98 the contract check line with the signed-in address unset keeps the declined event', () => {
  const calendar = [
    timed('Cancelled', '20261012T120000', '20261012T130000', { status: 'CANCELLED' }),
    timed('Declined', '20261012T130000', '20261012T140000', { extra: [declinedBy('Sam@Example.com')] }),
  ];
  assert.deepEqual(sorted(run(calendar, { self: null })), [ev('Declined', '13:00', '14:00')]);
});

// ---------------------------------------------------------------- R99

test('R99 a daily series shows every day with an interval of one', () => {
  assert.deepEqual(run([daily('Daily')]).events, [NINE('Daily')]);
  assert.deepEqual(run([daily('Daily')], { date: '2026-10-13' }).events, [NINE('Daily')]);
});

test('R99 a daily series before its first day shows nothing', () => {
  assert.deepEqual(run([daily('Daily')], { date: '2026-09-30' }), NONE);
  assert.deepEqual(run([daily('Daily')], { date: '2026-10-01' }).events, [NINE('Daily')]);
});

test('R99 a daily series every third day shows on its days and not between', () => {
  const s = daily('Third', { rrule: 'FREQ=DAILY;INTERVAL=3' });
  assert.deepEqual(run([s], { date: '2026-10-13' }).events, [NINE('Third')]); // day 12 from the 1st
  assert.deepEqual(run([s], { date: '2026-10-12' }), NONE);
  assert.deepEqual(run([s], { date: '2026-10-14' }), NONE);
});

test('R99 a daily series limited to weekdays shows on a listed weekday and not on another', () => {
  const s = daily('Mon and Tue', { rrule: 'FREQ=DAILY;BYDAY=MO,TU' });
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('Mon and Tue')]); // Monday
  assert.deepEqual(run([s], { date: '2026-10-13' }).events, [NINE('Mon and Tue')]); // Tuesday
  assert.deepEqual(run([s], { date: '2026-10-14' }), NONE); // Wednesday
});

test('R99 a daily series limited to a month shows in it and not in another', () => {
  const s = vevent({ uid: 'oct', summary: 'October only', start: '20260925T090000', end: '20260925T100000', rrule: 'FREQ=DAILY;BYMONTH=10' });
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('October only')]);
  assert.deepEqual(run([s], { date: '2026-11-02' }), NONE);
});

test('R99 a weekly series shows on the weekday it began on and not on another', () => {
  const s = series('Weekly', 'FREQ=WEEKLY', '20260928'); // a Monday
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('Weekly')]);
  assert.deepEqual(run([s], { date: '2026-10-13' }), NONE);
});

test('R99 a weekly series on listed weekdays shows on each and not on the others', () => {
  const s = series('Mon Wed', 'FREQ=WEEKLY;BYDAY=MO,WE', '20260928');
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('Mon Wed')]);
  assert.deepEqual(run([s], { date: '2026-10-14' }).events, [NINE('Mon Wed')]);
  assert.deepEqual(run([s], { date: '2026-10-13' }), NONE);
});

test('R99 a weekly series every second week shows in its week and not in the week between', () => {
  const s = series('Fortnight', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '20260928');
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('Fortnight')]);
  assert.deepEqual(run([s], { date: '2026-10-05' }), NONE);
  assert.deepEqual(run([s], { date: '2026-10-19' }), NONE);
  assert.deepEqual(run([s], { date: '2026-10-26' }).events, [NINE('Fortnight')]);
});

test('R99 a monthly series on a day of the month shows on it and not on the next day', () => {
  const s = series('Twelfth', 'FREQ=MONTHLY;BYMONTHDAY=12', '20260912');
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('Twelfth')]);
  assert.deepEqual(run([s], { date: '2026-10-13' }), NONE);
});

test('R99 a monthly series on the last day of the month counts from the end', () => {
  const s = series('Last day', 'FREQ=MONTHLY;BYMONTHDAY=-1', '20260930');
  assert.deepEqual(run([s], { date: '2026-10-31' }).events, [NINE('Last day')]);
  assert.deepEqual(run([s], { date: '2026-10-30' }), NONE);
});

test('R99 a monthly series on the second Monday shows on it and not on the first', () => {
  const s = series('Second Monday', 'FREQ=MONTHLY;BYDAY=2MO', '20260914');
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('Second Monday')]);
  assert.deepEqual(run([s], { date: '2026-10-05' }), NONE);
});

test('R99 a monthly series on the last Friday shows on it and not on the one before', () => {
  const s = series('Last Friday', 'FREQ=MONTHLY;BYDAY=-1FR', '20260925');
  assert.deepEqual(run([s], { date: '2026-10-30' }).events, [NINE('Last Friday')]);
  assert.deepEqual(run([s], { date: '2026-10-23' }), NONE);
});

test('R99 a monthly series with no day rule repeats on the same day of the month', () => {
  const s = series('Same day', 'FREQ=MONTHLY', '20260831');
  assert.deepEqual(run([s], { date: '2026-10-31' }).events, [NINE('Same day')]);
  assert.deepEqual(run([s], { date: '2026-09-30' }), NONE); // a series on the 31st skips short months
});

test('R99 a monthly series every second month shows in its months and not between', () => {
  const s = series('Bimonthly', 'FREQ=MONTHLY;INTERVAL=2', '20260812');
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('Bimonthly')]);
  assert.deepEqual(run([s], { date: '2026-11-12' }), NONE);
});

test('R99 a yearly series shows on its date and not on the next day', () => {
  const s = series('Yearly', 'FREQ=YEARLY', '20251012');
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('Yearly')]);
  assert.deepEqual(run([s], { date: '2026-10-13' }), NONE);
});

test('R99 a yearly series in a month on the second Monday shows on it and not on the first', () => {
  const s = series('October Monday', 'FREQ=YEARLY;BYMONTH=10;BYDAY=2MO', '20251013');
  assert.deepEqual(run([s], { date: '2026-10-12' }).events, [NINE('October Monday')]);
  assert.deepEqual(run([s], { date: '2026-10-05' }), NONE);
});

test('R99 a yearly series on 29 February skips the ordinary years', () => {
  const s = series('Leap day', 'FREQ=YEARLY', '20240229');
  assert.deepEqual(run([s], { date: '2028-02-29' }).events, [NINE('Leap day')]);
  assert.deepEqual(run([s], { date: '2026-02-28' }), NONE);
});

test('R99 UNTIL as a UTC time keeps the occurrence at that instant and drops a later one', () => {
  // 09:00 in Brussels on 12 October is 07:00Z.
  const keeps = daily('Until kept', { rrule: 'FREQ=DAILY;UNTIL=20261012T070000Z' });
  const drops = daily('Until dropped', { rrule: 'FREQ=DAILY;UNTIL=20261012T065900Z' });
  assert.deepEqual(run([keeps]).events, [NINE('Until kept')]);
  assert.deepEqual(run([drops]), NONE);
});

test('R99 UNTIL as a date keeps that day and drops the day after', () => {
  const keeps = daily('Date kept', { rrule: 'FREQ=DAILY;UNTIL=20261012' });
  const drops = daily('Date dropped', { rrule: 'FREQ=DAILY;UNTIL=20261011' });
  assert.deepEqual(run([keeps]).events, [NINE('Date kept')]);
  assert.deepEqual(run([drops]), NONE);
});

test('R99 UNTIL with no Z is a wall time in the series own zone', () => {
  // 09:00 in New York is 15:00 in Brussels; the until time is read in New York as well.
  const keeps = vevent({ uid: 'ny-kept', summary: 'NY kept', start: '20261001T090000', end: '20261001T100000', tzid: 'America/New_York', rrule: 'FREQ=DAILY;UNTIL=20261012T090000' });
  const drops = vevent({ uid: 'ny-drop', summary: 'NY dropped', start: '20261001T090000', end: '20261001T100000', tzid: 'America/New_York', rrule: 'FREQ=DAILY;UNTIL=20261012T085900' });
  assert.deepEqual(run([keeps]).events, [ev('NY kept', '15:00', '16:00')]);
  assert.deepEqual(run([drops]), NONE);
});

test('R99 COUNT includes the occurrence that uses it up and not the one after', () => {
  // From 1 October daily, 12 October is the 12th occurrence.
  assert.deepEqual(run([daily('Twelve', { rrule: 'FREQ=DAILY;COUNT=12' })]).events, [NINE('Twelve')]);
  assert.deepEqual(run([daily('Eleven', { rrule: 'FREQ=DAILY;COUNT=11' })]), NONE);
});

test('R99 COUNT on a weekly series counts weeks', () => {
  // 28 September, 5 October, 12 October.
  assert.deepEqual(run([series('Three weeks', 'FREQ=WEEKLY;COUNT=3', '20260928')]).events, [NINE('Three weeks')]);
  assert.deepEqual(run([series('Two weeks', 'FREQ=WEEKLY;COUNT=2', '20260928')]), NONE);
});

test('R99 EXDATE with a TZID removes that occurrence and not the others', () => {
  const removed = daily('Removed', { tzid: 'Europe/Brussels', exdate: '20261012T090000' });
  const other = daily('Other day removed', { tzid: 'Europe/Brussels', exdate: '20261011T090000' });
  assert.deepEqual(run([removed]), NONE);
  assert.deepEqual(run([other]).events, [NINE('Other day removed')]);
});

test('R99 EXDATE in UTC removes the occurrence at that instant and not another hour', () => {
  const removed = daily('Removed', { extra: ['EXDATE:20261012T070000Z'] });
  const wrongHour = daily('Wrong hour', { extra: ['EXDATE:20261012T080000Z'] });
  assert.deepEqual(run([removed]), NONE);
  assert.deepEqual(run([wrongHour]).events, [NINE('Wrong hour')]);
});

test('R99 EXDATE as a date removes the occurrence on that day and not on another', () => {
  const removed = daily('Removed', { extra: ['EXDATE;VALUE=DATE:20261012'] });
  const other = daily('Other day removed', { extra: ['EXDATE;VALUE=DATE:20261011'] });
  assert.deepEqual(run([removed]), NONE);
  assert.deepEqual(run([other]).events, [NINE('Other day removed')]);
});

test('R99 several EXDATE values on one line each remove their occurrence', () => {
  const list = 'EXDATE;TZID=Europe/Brussels:20261011T090000,20261012T090000,20261013T090000';
  const s = daily('Several', { extra: [list] });
  assert.deepEqual(run([s], { date: '2026-10-12' }), NONE);
  assert.deepEqual(run([s], { date: '2026-10-13' }), NONE);
  assert.deepEqual(run([s], { date: '2026-10-14' }).events, [NINE('Several')]);
});

test('R99 several EXDATE lines each remove their occurrence', () => {
  const s = daily('Lines', { tzid: 'Europe/Brussels', exdate: ['20261011T090000', '20261012T090000'] });
  assert.deepEqual(run([s], { date: '2026-10-12' }), NONE);
  assert.deepEqual(run([s], { date: '2026-10-13' }).events, [NINE('Lines')]);
});

test('R99 a moved occurrence shows once at the new time and not at the old one', () => {
  const s = daily('Standup', { uid: 'moved' });
  const moved = vevent({ uid: 'moved', summary: 'Standup moved', recurrenceId: '20261012T090000', start: '20261012T140000', end: '20261012T150000' });
  assert.deepEqual(run([s, moved]).events, [ev('Standup moved', '14:00', '15:00')]);
});

test('R99 a changed occurrence of another series does not move this one', () => {
  const s = daily('Standup', { uid: 'moved' });
  const stranger = vevent({ uid: 'someone-else', summary: 'Other', recurrenceId: '20261012T090000', start: '20261012T140000', end: '20261012T150000' });
  assert.deepEqual(sorted(run([s, stranger])), [NINE('Standup'), ev('Other', '14:00', '15:00')]);
});

test('R99 an occurrence moved from today to tomorrow shows nothing today', () => {
  const s = daily('Standup', { uid: 'tomorrow' });
  const moved = vevent({ uid: 'tomorrow', summary: 'Standup moved', recurrenceId: '20261012T090000', start: '20261013T150000', end: '20261013T160000' });
  assert.deepEqual(run([s, moved]), NONE);
  assert.deepEqual(sorted(run([s, moved], { date: '2026-10-13' })), [NINE('Standup'), ev('Standup moved', '15:00', '16:00')]);
});

test('R99 an occurrence moved from last week to today gives two events', () => {
  const weekly = series('Monday review', 'FREQ=WEEKLY;BYDAY=MO', '20260928', { uid: 'weekly' });
  const moved = vevent({ uid: 'weekly', summary: 'Monday review moved', recurrenceId: '20261005T090000', start: '20261012T110000', end: '20261012T120000' });
  assert.deepEqual(sorted(run([weekly, moved])), [NINE('Monday review'), ev('Monday review moved', '11:00', '12:00')]);
  assert.deepEqual(run([weekly, moved], { date: '2026-10-13' }), NONE);
});

test('R99 a cancelled occurrence shows nothing, a cancelled one of another day leaves today', () => {
  const s = daily('Standup', { uid: 'cancel' });
  const today = vevent({ uid: 'cancel', summary: 'Standup', recurrenceId: '20261012T090000', start: '20261012T090000', end: '20261012T100000', status: 'CANCELLED' });
  const yesterday = vevent({ uid: 'cancel', summary: 'Standup', recurrenceId: '20261011T090000', start: '20261011T090000', end: '20261011T100000', status: 'CANCELLED' });
  assert.deepEqual(run([s, today]), NONE);
  assert.deepEqual(run([s, yesterday]).events, [NINE('Standup')]);
});

test('R99 a changed occurrence declined by the signed-in address shows nothing', () => {
  const s = daily('Standup', { uid: 'decl' });
  const declined = vevent({ uid: 'decl', summary: 'Standup', recurrenceId: '20261012T090000', start: '20261012T090000', end: '20261012T100000', extra: [declinedBy(SELF)] });
  assert.deepEqual(run([s, declined], { self: SELF }), NONE);
  assert.deepEqual(run([s, declined], { self: null }).events, [NINE('Standup')]);
});

test('R99 a changed occurrence with no series in the text shows as a single event', () => {
  const changed = vevent({ uid: 'lonely', summary: 'Lonely', recurrenceId: '20261012T090000', start: '20261012T160000', end: '20261012T170000' });
  assert.deepEqual(run([changed]), { events: [ev('Lonely', '16:00', '17:00')], allDay: [], skipped: 0, unknownZones: 0 });
  const cancelled = vevent({ uid: 'lonely', summary: 'Lonely', recurrenceId: '20261012T090000', start: '20261012T160000', end: '20261012T170000', status: 'CANCELLED' });
  assert.deepEqual(run([cancelled]), NONE);
});

test('R99 a changed all-day occurrence is matched by its date', () => {
  const s = vevent({ uid: 'allday', summary: 'Plain', start: '20261001', end: '20261002', allDay: true, rrule: 'FREQ=DAILY' });
  const changed = vevent({ uid: 'allday', summary: 'Changed', recurrenceId: '20261012', start: '20261012', end: '20261013', allDay: true });
  assert.deepEqual(run([s, changed]).allDay, [{ title: 'Changed' }]);
  assert.deepEqual(run([s]).allDay, [{ title: 'Plain' }]);
});

test('R99 a series in another zone shows at the board time of its occurrence', () => {
  // 09:00 in New York is 13:00Z on 12 October, 15:00 in Brussels.
  const s = vevent({ uid: 'ny', summary: 'NY daily', start: '20261001T090000', end: '20261001T100000', tzid: 'America/New_York', rrule: 'FREQ=DAILY' });
  assert.deepEqual(run([s]), { events: [ev('NY daily', '15:00', '16:00')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R99 a series in another zone whose evening falls on the board next morning shows once', () => {
  // 20:00 in New York on the 11th is 00:00Z on the 12th, 02:00 in Brussels; the one on the 12th is 02:00 on the 13th.
  const s = vevent({ uid: 'ny-late', summary: 'NY late', start: '20261001T200000', end: '20261001T210000', tzid: 'America/New_York', rrule: 'FREQ=DAILY' });
  assert.deepEqual(run([s]).events, [ev('NY late', '02:00', '03:00')]);
});

test('R99 a daily series at 23:30 lasting one hour shows two pieces today', () => {
  const s = vevent({ uid: 'late', summary: 'Late', start: '20261001T233000', end: '20261002T003000', rrule: 'FREQ=DAILY' });
  assert.deepEqual(sorted(run([s])), [ev('Late', '00:00', '00:30'), ev('Late', '23:30', '24:00')]);
});

test('R99 the first day of a series at 23:30 shows only the evening piece', () => {
  const s = vevent({ uid: 'late', summary: 'Late', start: '20261001T233000', end: '20261002T003000', rrule: 'FREQ=DAILY' });
  assert.deepEqual(run([s], { date: '2026-10-01' }).events, [ev('Late', '23:30', '24:00')]);
});

test('R99 an all-day repeating event lands in allDay on its days only', () => {
  const s = vevent({ uid: 'ad', summary: 'Mon Wed', start: '20260928', end: '20260929', allDay: true, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' });
  const onMonday = run([s]);
  assert.deepEqual(onMonday, { events: [], allDay: [{ title: 'Mon Wed' }], skipped: 0, unknownZones: 0 });
  assert.deepEqual(run([s], { date: '2026-10-14' }).allDay, [{ title: 'Mon Wed' }]);
  assert.deepEqual(run([s], { date: '2026-10-13' }), NONE);
});

test('R99 a multi-day all-day repeating event is listed on each day of an occurrence', () => {
  // Saturday to Monday every week, first held 26 to 28 September: 10 to 12 October is the third.
  const s = vevent({ uid: 'wk', summary: 'Long weekend', start: '20260926', end: '20260929', allDay: true, rrule: 'FREQ=WEEKLY' });
  assert.deepEqual(run([s], { date: '2026-10-12' }).allDay, [{ title: 'Long weekend' }]);
  assert.deepEqual(run([s], { date: '2026-10-11' }).allDay, [{ title: 'Long weekend' }]);
  assert.deepEqual(run([s], { date: '2026-10-13' }), NONE);
});

test('R99 FREQ=HOURLY shows nothing and counts as skipped, DAILY shows', () => {
  assert.deepEqual(run([daily('Hourly', { rrule: 'FREQ=HOURLY' })]), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(run([daily('Daily')]), { events: [NINE('Daily')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R99 FREQ=DAILY;BYMONTHDAY=1 shows nothing and counts as skipped, MONTHLY on the 12th shows', () => {
  assert.deepEqual(run([daily('First', { rrule: 'FREQ=DAILY;BYMONTHDAY=1' })]), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(run([series('Twelfth', 'FREQ=MONTHLY;BYMONTHDAY=12', '20260912')]).events, [NINE('Twelfth')]);
});

test('R99 BYSETPOS shows nothing and counts as skipped, the nearest supported form shows', () => {
  const unsupported = series('Last weekday', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '20260914');
  assert.deepEqual(run([unsupported]), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(run([series('Second Monday', 'FREQ=MONTHLY;BYDAY=2MO', '20260914')]).events, [NINE('Second Monday')]);
});

test('R99 a numbered weekday under WEEKLY shows nothing and counts as skipped, under MONTHLY it shows', () => {
  assert.deepEqual(run([series('Odd', 'FREQ=WEEKLY;BYDAY=2MO', '20260928')]), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(run([series('Fine', 'FREQ=MONTHLY;BYDAY=2MO', '20260914')]).events, [NINE('Fine')]);
});

test('R99 a yearly weekday rule with no month shows nothing and counts as skipped, with a month it shows', () => {
  assert.deepEqual(run([series('Odd', 'FREQ=YEARLY;BYDAY=2MO', '20251013')]), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(run([series('Fine', 'FREQ=YEARLY;BYMONTH=10;BYDAY=2MO', '20251013')]).events, [NINE('Fine')]);
});

test('R99 two RRULE lines show nothing and count as skipped once, one line shows', () => {
  const two = daily('Two rules', { extra: ['RRULE:FREQ=WEEKLY'] });
  assert.deepEqual(run([two]), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(run([daily('One rule')]), { events: [NINE('One rule')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R99 a changed occurrence with RANGE=THISANDFUTURE stops the series, a plain one does not', () => {
  // The changed occurrence is placed on the 20th so that it cannot show today whichever way it is read.
  const s = daily('Standup', { uid: 'future' });
  const fromHere = vevent({
    uid: 'future', summary: 'Standup later', start: '20261020T150000', end: '20261020T160000',
    extra: ['RECURRENCE-ID;RANGE=THISANDFUTURE:20261012T090000'],
  });
  assert.deepEqual(run([s, fromHere]), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  const plain = vevent({ uid: 'future', summary: 'Standup later', recurrenceId: '20261012T090000', start: '20261020T150000', end: '20261020T160000' });
  assert.deepEqual(run([s, plain]), { events: [], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R99 a plain changed occurrence of another day leaves the series showing', () => {
  const s = daily('Standup', { uid: 'future' });
  const plain = vevent({ uid: 'future', summary: 'Standup later', recurrenceId: '20261011T090000', start: '20261020T150000', end: '20261020T160000' });
  assert.deepEqual(run([s, plain]), { events: [NINE('Standup')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R99 a changed occurrence still shows beside a series that is not worked out', () => {
  const s = daily('Hourly', { uid: 'hourly', rrule: 'FREQ=HOURLY' });
  const changed = vevent({ uid: 'hourly', summary: 'Hourly changed', recurrenceId: '20261012T090000', start: '20261012T110000', end: '20261012T120000' });
  assert.deepEqual(run([s, changed]), { events: [ev('Hourly changed', '11:00', '12:00')], allDay: [], skipped: 1, unknownZones: 0 });
});

test('R99 a COUNT series that began more than 3700 days ago shows nothing and counts as skipped', () => {
  // 2015-01-01 is 4302 days before 2026-10-12.
  const old = vevent({ uid: 'old', summary: 'Old', start: '20150101T090000', end: '20150101T100000', rrule: 'FREQ=DAILY;COUNT=100000' });
  assert.deepEqual(run([old]), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
});

test('R99 a COUNT series that began 2933 days ago is worked out and shows', () => {
  // 2018-10-01 is 2933 days before 2026-10-12.
  const recent = vevent({ uid: 'recent', summary: 'Recent', start: '20181001T090000', end: '20181001T100000', rrule: 'FREQ=DAILY;COUNT=100000' });
  assert.deepEqual(run([recent]), { events: [NINE('Recent')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R99 an old series with no COUNT is worked out and shows', () => {
  const old = vevent({ uid: 'old', summary: 'Old', start: '20150101T090000', end: '20150101T100000', rrule: 'FREQ=DAILY' });
  assert.deepEqual(run([old]), { events: [NINE('Old')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R99 an RDATE adds one to skipped while the rule still shows', () => {
  const s = daily('With rdate', { rdate: '20261020T150000' });
  assert.deepEqual(run([s]), { events: [NINE('With rdate')], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(run([daily('Without rdate')]), { events: [NINE('Without rdate')], allDay: [], skipped: 0, unknownZones: 0 });
});

test('R99 an RDATE with no rule is a single event at its start and adds one to skipped', () => {
  const lone = timed('Lone', '20261012T100000', '20261012T110000', { rdate: '20261020T100000' });
  assert.deepEqual(run([lone]), { events: [ev('Lone', '10:00', '11:00')], allDay: [], skipped: 1, unknownZones: 0 });
  assert.deepEqual(run([lone], { date: "2026-10-20" }), { events: [], allDay: [], skipped: 1, unknownZones: 0 });
});

test('R99 a series that is not worked out does not stop the others in the same calendar', () => {
  const r = run([daily('Hourly', { rrule: 'FREQ=HOURLY' }), daily('Fine')]);
  assert.deepEqual(r, { events: [NINE('Fine')], allDay: [], skipped: 1, unknownZones: 0 });
});

test('R99 the thirteen series of the contract check show exactly the expected events', () => {
  const calendar = [
    // 1 daily
    daily('S01 daily', { uid: 's01' }),
    // 2 weekly on Mondays and Wednesdays
    series('S02 weekly mon wed', 'FREQ=WEEKLY;BYDAY=MO,WE', '20260928'),
    // 3 weekly on Tuesdays
    series('S03 weekly tue', 'FREQ=WEEKLY;BYDAY=TU', '20260929'),
    // 4 every second week, this being its week
    series('S04 fortnight this week', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '20260928'),
    // 5 the same, a week off
    series('S05 fortnight other week', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '20261005'),
    // 6 monthly on the 12th
    series('S06 monthly twelfth', 'FREQ=MONTHLY;BYMONTHDAY=12', '20260912'),
    // 7 monthly on the second Monday
    series('S07 monthly second monday', 'FREQ=MONTHLY;BYDAY=2MO', '20260914'),
    // 8 yearly on 12 October
    series('S08 yearly', 'FREQ=YEARLY', '20251012'),
    // 9 daily, ended on the 11th (its last occurrence 09:00 on the 11th is 07:00Z)
    daily('S09 ended', { rrule: 'FREQ=DAILY;UNTIL=20261011T070000Z' }),
    // 10 daily, three times, began on the 1st
    daily('S10 three times', { rrule: 'FREQ=DAILY;COUNT=3' }),
    // 11 daily with today removed
    daily('S11 today removed', { tzid: 'Europe/Brussels', exdate: '20261012T090000' }),
    // 12 daily with today moved to 16:00
    daily('S12 daily moved', { uid: 's12' }),
    vevent({ uid: 's12', summary: 'S12 moved', recurrenceId: '20261012T090000', start: '20261012T160000', end: '20261012T170000' }),
    // 13 daily with today cancelled
    daily('S13 daily cancelled', { uid: 's13' }),
    vevent({ uid: 's13', summary: 'S13 cancelled', recurrenceId: '20261012T090000', start: '20261012T090000', end: '20261012T100000', status: 'CANCELLED' }),
  ];
  const r = run(calendar);
  assert.deepEqual(sorted(r), [
    NINE('S01 daily'),
    NINE('S02 weekly mon wed'),
    NINE('S04 fortnight this week'),
    NINE('S06 monthly twelfth'),
    NINE('S07 monthly second monday'),
    NINE('S08 yearly'),
    ev('S12 moved', '16:00', '17:00'),
  ]);
  assert.deepEqual(r.allDay, []);
  assert.equal(r.skipped, 0);
  assert.equal(r.unknownZones, 0);
});

test('R99 the contract check line: HOURLY and BYMONTHDAY=1 each give no event and one skipped', () => {
  const hourly = run([daily('Hourly', { rrule: 'FREQ=HOURLY' })]);
  assert.deepEqual(hourly, { events: [], allDay: [], skipped: 1, unknownZones: 0 });
  const monthDay = run([daily('First of month', { rrule: 'FREQ=DAILY;BYMONTHDAY=1' })]);
  assert.deepEqual(monthDay, { events: [], allDay: [], skipped: 1, unknownZones: 0 });
});

test('R99 the contract check line: a weekly Monday event with last week moved to 11:00 today gives two events', () => {
  const weekly = series('Monday', 'FREQ=WEEKLY;BYDAY=MO', '20260928', { uid: 'monday' });
  const moved = vevent({ uid: 'monday', summary: 'Monday moved', recurrenceId: '20261005T090000', start: '20261012T110000', end: '20261012T120000' });
  const r = run([weekly, moved]);
  assert.equal(r.events.length, 2);
  assert.deepEqual(sorted(r), [NINE('Monday'), ev('Monday moved', '11:00', '12:00')]);
});
