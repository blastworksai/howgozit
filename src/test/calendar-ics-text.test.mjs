import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEvents, cleanTitle } from '../board/calendar/ics-text.mjs';

const CRLF = '\r\n';
const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join(CRLF) + CRLF;
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

test('U one event: shape of the result, names upper case, params and raw value', () => {
  const text = cal(...ev(
    'UID:abc-1',
    'summary:Standup',
    'DTSTART;tzid=Europe/Brussels;VALUE=DATE-TIME:20261012T103000',
  ));
  const events = readEvents(text);
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 1);
  const e = events[0];
  assert.deepEqual(Object.keys(e).sort(), ['DTSTART', 'SUMMARY', 'UID']);
  assert.ok(Array.isArray(e.UID));
  assert.equal(e.UID.length, 1);
  assert.deepEqual({ ...e.UID[0] }, { params: {}, value: 'abc-1' });
  assert.deepEqual({ ...e.SUMMARY[0].params }, {});
  assert.equal(e.SUMMARY[0].value, 'Standup');
  assert.equal(e.DTSTART.length, 1);
  assert.deepEqual({ ...e.DTSTART[0].params }, { TZID: 'Europe/Brussels', VALUE: 'DATE-TIME' });
  assert.equal(e.DTSTART[0].value, '20261012T103000');
});

test('U two events come back in document order', () => {
  const text = cal(...ev('UID:first', 'SUMMARY:One'), ...ev('UID:second', 'SUMMARY:Two'));
  const events = readEvents(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].UID[0].value, 'first');
  assert.equal(events[1].UID[0].value, 'second');
  assert.equal(events[0].SUMMARY[0].value, 'One');
  assert.equal(events[1].SUMMARY[0].value, 'Two');
});

test('U a calendar with no VEVENT and an empty string give an empty list', () => {
  assert.deepEqual(readEvents(cal('PRODID:-//Sample//EN')), []);
  assert.deepEqual(readEvents(''), []);
  // twin: the same text with an event is not empty
  assert.equal(readEvents(cal(...ev('UID:x'))).length, 1);
});

test('U bad input gives null: number, undefined, object', () => {
  assert.equal(readEvents(42), null);
  assert.equal(readEvents(undefined), null);
  assert.equal(readEvents({}), null);
});

test('U a text of 2,000,001 characters gives null, 2,000,000 does not', () => {
  const head = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:big\r\nX-PAD:';
  const tail = '\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const fill = (n) => head + 'a'.repeat(n - head.length - tail.length) + tail;
  const over = fill(2_000_001);
  assert.equal(over.length, 2_000_001);
  assert.equal(readEvents(over), null);
  const exact = fill(2_000_000);
  assert.equal(exact.length, 2_000_000);
  const r = readEvents(exact);
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 1);
});

test('U 2,001 events give null and exactly 2,000 give a real result', () => {
  const many = (n) => cal(...Array.from({ length: n }, (_, i) => ev(`UID:e${i}`).join(CRLF)));
  assert.equal(readEvents(many(2001)), null);
  const r = readEvents(many(2000));
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 2000);
  assert.equal(r[1999].UID[0].value, 'e1999');
});

test('U a SUMMARY folded with CRLF plus a space is rejoined without the fold character', () => {
  const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Quarterly plan', ' ning meeting', 'END:VEVENT', 'END:VCALENDAR'].join(CRLF);
  const r = readEvents(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].SUMMARY[0].value, 'Quarterly planning meeting');
});

test('U a SUMMARY folded with CRLF plus a tab is rejoined without the fold character', () => {
  const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Quarterly plan', '\tning meeting', 'END:VEVENT', 'END:VCALENDAR'].join(CRLF);
  const r = readEvents(text);
  assert.equal(r[0].SUMMARY[0].value, 'Quarterly planning meeting');
});

test('U a fold keeps any further spaces after the dropped one', () => {
  const text = ['BEGIN:VEVENT', 'SUMMARY:one', '  two', 'END:VEVENT'].join(CRLF);
  const r = readEvents(text);
  assert.equal(r[0].SUMMARY[0].value, 'one two');
});

test('U LF-only line ends read the same as CRLF', () => {
  const lines = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:lf-1', 'SUMMARY:Quarterly plan', ' ning', 'DTSTART;TZID=Europe/Brussels:20261012T103000', 'END:VEVENT', 'END:VCALENDAR'];
  const withCrlf = readEvents(lines.join('\r\n') + '\r\n');
  const withLf = readEvents(lines.join('\n') + '\n');
  assert.equal(withLf.length, 1);
  assert.equal(withLf[0].SUMMARY[0].value, 'Quarterly planning');
  assert.deepEqual(withLf, withCrlf);
});

test('U DTSTART;TZID gives params.TZID and the raw value', () => {
  const r = readEvents(cal(...ev('DTSTART;TZID=Europe/Brussels:20261012T103000')));
  assert.equal(r[0].DTSTART[0].params.TZID, 'Europe/Brussels');
  assert.equal(r[0].DTSTART[0].value, '20261012T103000');
});

test('U lower-case property and parameter names are read as upper case', () => {
  const r = readEvents(cal(...ev('dtstart;tzid=Europe/Brussels:20261012T103000', 'Summary:Mixed')));
  assert.deepEqual(Object.keys(r[0]).sort(), ['DTSTART', 'SUMMARY']);
  assert.equal(r[0].DTSTART[0].params.TZID, 'Europe/Brussels');
  assert.equal(r[0].DTSTART[0].params.tzid, undefined);
  assert.equal(r[0].SUMMARY[0].value, 'Mixed');
});

test('U a quoted parameter value may hold a colon and a semicolon', () => {
  const r = readEvents(cal(...ev('ATTENDEE;CN="Doe: Sam; Jr";PARTSTAT=DECLINED:mailto:sam@example.com')));
  const a = r[0].ATTENDEE;
  assert.equal(a.length, 1);
  assert.deepEqual({ ...a[0].params }, { CN: 'Doe: Sam; Jr', PARTSTAT: 'DECLINED' });
  assert.equal(a[0].value, 'mailto:sam@example.com');
});

test('U the value keeps later colons', () => {
  const r = readEvents(cal(...ev('URL:https://example.com/a:b')));
  assert.equal(r[0].URL[0].value, 'https://example.com/a:b');
  assert.deepEqual({ ...r[0].URL[0].params }, {});
});

test('U a property that repeats gives a list of two, in order', () => {
  const r = readEvents(cal(...ev('EXDATE:20261013T083000Z', 'EXDATE;TZID=Europe/Brussels:20261014T103000')));
  const x = r[0].EXDATE;
  assert.equal(x.length, 2);
  assert.equal(x[0].value, '20261013T083000Z');
  assert.deepEqual({ ...x[0].params }, {});
  assert.equal(x[1].value, '20261014T103000');
  assert.equal(x[1].params.TZID, 'Europe/Brussels');
});

test('U a VALARM inside the event adds no keys and the event own DESCRIPTION stays', () => {
  const r = readEvents(cal(
    'BEGIN:VEVENT',
    'UID:alarm-1',
    'DESCRIPTION:Own description',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'DESCRIPTION:Alarm text',
    'END:VALARM',
    'SUMMARY:After the alarm',
    'END:VEVENT',
  ));
  assert.equal(r.length, 1);
  assert.deepEqual(Object.keys(r[0]).sort(), ['DESCRIPTION', 'SUMMARY', 'UID']);
  assert.equal(r[0].DESCRIPTION.length, 1);
  assert.equal(r[0].DESCRIPTION[0].value, 'Own description');
  assert.equal(r[0].ACTION, undefined);
  assert.equal(r[0].TRIGGER, undefined);
  assert.equal(r[0].SUMMARY[0].value, 'After the alarm');
});

test('U a VTIMEZONE before the events does not leak its DTSTART lines', () => {
  const r = readEvents(cal(
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Brussels',
    'BEGIN:STANDARD',
    'DTSTART:19701025T030000',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19700329T020000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    ...ev('UID:tz-1', 'DTSTART;TZID=Europe/Brussels:20261012T103000'),
  ));
  assert.equal(r.length, 1);
  assert.equal(r[0].DTSTART.length, 1);
  assert.equal(r[0].DTSTART[0].value, '20261012T103000');
  assert.equal(r[0].TZOFFSETFROM, undefined);
  assert.equal(r[0].TZID, undefined);
});

test('U a VTODO is not an event, a VEVENT beside it is', () => {
  const r = readEvents(cal(
    'BEGIN:VTODO',
    'UID:todo-1',
    'SUMMARY:Buy milk',
    'END:VTODO',
    ...ev('UID:ev-1', 'SUMMARY:Real event'),
  ));
  assert.equal(r.length, 1);
  assert.equal(r[0].UID[0].value, 'ev-1');
  assert.equal(readEvents(cal('BEGIN:VTODO', 'UID:todo-2', 'END:VTODO')).length, 0);
});

test('U a VEVENT that is never closed is dropped, a complete one before it is kept', () => {
  const text = cal(
    ...ev('UID:done-1', 'SUMMARY:Complete'),
    'BEGIN:VEVENT',
    'UID:open-1',
    'SUMMARY:Never closed',
  );
  const r = readEvents(text);
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 1);
  assert.equal(r[0].UID[0].value, 'done-1');
});

test('U a line with no colon is ignored', () => {
  const r = readEvents(cal(...ev('UID:nc-1', 'THIS LINE HAS NO COLON', 'SUMMARY;X=1', 'SUMMARY:Kept')));
  assert.deepEqual(Object.keys(r[0]).sort(), ['SUMMARY', 'UID']);
  assert.equal(r[0].SUMMARY.length, 1);
  assert.equal(r[0].SUMMARY[0].value, 'Kept');
});

test('U readEvents does not unescape values', () => {
  const r = readEvents(cal(...ev('SUMMARY:A\\, B\\nC\\\\D')));
  assert.equal(r[0].SUMMARY[0].value, 'A\\, B\\nC\\\\D');
});

test('U properties named __proto__ and constructor are ordinary keys', () => {
  const r = readEvents(cal(...ev('UID:p-1', '__proto__:one', 'constructor:two', 'CONSTRUCTOR;X=y:three')));
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 1);
  const e = r[0];
  assert.equal(Object.getPrototypeOf(e), null);
  assert.deepEqual(Object.keys(e).sort(), ['CONSTRUCTOR', 'UID', '__PROTO__']);
  assert.equal(e.__PROTO__[0].value, 'one');
  assert.equal(e.CONSTRUCTOR.length, 2);
  assert.equal(e.CONSTRUCTOR[0].value, 'two');
  assert.equal(e.CONSTRUCTOR[1].value, 'three');
  assert.equal(({}).polluted, undefined);
});

test('U 2,000,000 characters with no line break never throws and returns within a second', () => {
  const text = 'a'.repeat(2_000_000);
  const t0 = Date.now();
  const r = readEvents(text);
  const ms = Date.now() - t0;
  assert.ok(r === null || Array.isArray(r));
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test('U 2,000,000 characters of BEGIN:VEVENT repeated never throws and returns within a second', () => {
  const unit = 'BEGIN:VEVENT\r\n';
  const text = unit.repeat(Math.floor(2_000_000 / unit.length));
  assert.ok(text.length <= 2_000_000);
  const t0 = Date.now();
  const r = readEvents(text);
  const ms = Date.now() - t0;
  assert.ok(r === null || Array.isArray(r));
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test('U cleanTitle turns \\n and \\N into a space', () => {
  assert.equal(cleanTitle('a\\nb'), 'a b');
  assert.equal(cleanTitle('a\\Nb'), 'a b');
});

test('U cleanTitle undoes \\, and \\; and \\\\', () => {
  assert.equal(cleanTitle('A\\, B'), 'A, B');
  assert.equal(cleanTitle('A\\; B'), 'A; B');
  assert.equal(cleanTitle('C:\\\\dir'), 'C:\\dir');
});

test('U cleanTitle removes control characters', () => {
  assert.equal(cleanTitle('a\x07b'), 'ab');
  assert.equal(cleanTitle('a\x00b'), 'ab');
  assert.equal(cleanTitle('a \tb'), 'a b');
  assert.equal(cleanTitle('\tab\x07'), 'ab');
});

test('U cleanTitle collapses runs of whitespace and trims', () => {
  assert.equal(cleanTitle('  a   b \u00a0 c  '), 'a b c');
  assert.equal(cleanTitle('a\\n\\nb'), 'a b');
  assert.equal(cleanTitle('\\n a \\n'), 'a');
});

test('U cleanTitle gives (no title) for empty, whitespace only, undefined and a number', () => {
  assert.equal(cleanTitle(''), '(no title)');
  assert.equal(cleanTitle('   \t  '), '(no title)');
  assert.equal(cleanTitle('\\n'), '(no title)');
  assert.equal(cleanTitle(undefined), '(no title)');
  assert.equal(cleanTitle(42), '(no title)');
  // twin: a real title is kept
  assert.equal(cleanTitle('Standup'), 'Standup');
});

test('U cleanTitle keeps exactly 200 characters whole', () => {
  const s = 'x'.repeat(200);
  assert.equal(cleanTitle(s), s);
});

test('U cleanTitle cuts 201 characters to 199 plus an ellipsis', () => {
  const out = cleanTitle('x'.repeat(201));
  assert.equal(out, 'x'.repeat(199) + '\u2026');
  assert.equal(Array.from(out).length, 200);
});

test('U cleanTitle counts an emoji as one character at the cut', () => {
  const emoji = '\u{1F600}';
  const out = cleanTitle('a'.repeat(198) + emoji + 'bb');
  assert.equal(out, 'a'.repeat(198) + emoji + '\u2026');
  assert.equal(Array.from(out).length, 200);
  // twin: 200 characters ending in an emoji stay whole
  const whole = 'a'.repeat(199) + emoji;
  assert.equal(cleanTitle(whole), whole);
});
