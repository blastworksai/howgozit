// Tests of board/calendar/recur.mjs (parseRule, occursOn), written from
// the pinned design alone. Every expected value was worked out on a calendar.
// Anchors: 1 Oct 2026 Thu, 12 Oct 2026 Mon, 25 Oct 2026 Sun, 13 Nov 2026 Fri.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, occursOn } from '../board/calendar/recur.mjs';

const plain = (r) => (r === null ? null : { ...r, byDay: r.byDay.map((e) => ({ ...e })) });
const occ = (text, start, d) => occursOn(parseRule(text), start, d);
const MO = { day: 'MO', nth: null };
const WE = { day: 'WE', nth: null };

function parsed(text) {
  const r = parseRule(text);
  assert.notEqual(r, null, `parseRule(${JSON.stringify(text)}) returned null`);
  return r;
}

// ---------- parseRule: fields ----------

test('U parseRule returns every field for a full rule', () => {
  assert.deepEqual(plain(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T225959Z')), {
    freq: 'WEEKLY',
    interval: 2,
    count: null,
    until: '20261231T225959Z',
    byDay: [MO, WE],
    byMonthDay: [],
    byMonth: [],
    wkst: 'MO',
    unsupported: false,
  });
});

test('U parseRule reads count, month lists, month days and wkst', () => {
  assert.deepEqual(plain(parseRule('FREQ=MONTHLY;INTERVAL=3;COUNT=5;BYMONTH=1,6;BYMONTHDAY=1,-1;WKST=SU')), {
    freq: 'MONTHLY',
    interval: 3,
    count: 5,
    until: null,
    byDay: [],
    byMonthDay: [1, -1],
    byMonth: [1, 6],
    wkst: 'SU',
    unsupported: false,
  });
});

test('U parseRule reads numbered BYDAY entries with their nth', () => {
  assert.deepEqual(parsed('FREQ=MONTHLY;BYDAY=2TU').byDay.map((e) => ({ ...e })), [{ day: 'TU', nth: 2 }]);
  assert.deepEqual(parsed('FREQ=MONTHLY;BYDAY=-1FR').byDay.map((e) => ({ ...e })), [{ day: 'FR', nth: -1 }]);
  assert.deepEqual(parsed('FREQ=MONTHLY;BYDAY=1MO,3MO,SU').byDay.map((e) => ({ ...e })), [
    { day: 'MO', nth: 1 },
    { day: 'MO', nth: 3 },
    { day: 'SU', nth: null },
  ]);
});

test('U parseRule defaults: interval 1, wkst MO, empty lists, count and until null', () => {
  assert.deepEqual(plain(parseRule('FREQ=DAILY')), {
    freq: 'DAILY',
    interval: 1,
    count: null,
    until: null,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    wkst: 'MO',
    unsupported: false,
  });
});

test('U parseRule reads lower-case names and values and upper-cases them', () => {
  assert.deepEqual(plain(parseRule('freq=weekly;interval=2;byday=mo,we;wkst=su;until=20261231t225959z')), {
    freq: 'WEEKLY',
    interval: 2,
    count: null,
    until: '20261231T225959Z',
    byDay: [MO, WE],
    byMonthDay: [],
    byMonth: [],
    wkst: 'SU',
    unsupported: false,
  });
});

test('U parseRule accepts the parts in any order', () => {
  const a = plain(parseRule('FREQ=WEEKLY;INTERVAL=3;BYDAY=TU'));
  const b = plain(parseRule('BYDAY=TU;INTERVAL=3;FREQ=WEEKLY'));
  assert.deepEqual(a, b);
  assert.equal(a.freq, 'WEEKLY');
  assert.equal(a.interval, 3);
  assert.deepEqual(a.byDay, [{ day: 'TU', nth: null }]);
});

test('U parseRule keeps UNTIL exactly as written', () => {
  assert.equal(parsed('FREQ=DAILY;UNTIL=20261231').until, '20261231');
  assert.equal(parsed('FREQ=DAILY;UNTIL=20261231T100000').until, '20261231T100000');
  assert.equal(parsed('FREQ=DAILY;UNTIL=20261231T225959Z').until, '20261231T225959Z');
});

// ---------- parseRule: null ----------

test('U parseRule gives null for text with no FREQ', () => {
  assert.equal(parseRule('INTERVAL=2;BYDAY=MO'), null);
  assert.equal(parseRule(''), null);
  assert.notEqual(parseRule('FREQ=DAILY'), null);
});

test('U parseRule gives null for a part without an equals sign', () => {
  assert.equal(parseRule('FREQ=DAILY;INTERVAL'), null);
  assert.equal(parseRule('FREQ=DAILY;BYDAY'), null);
  assert.notEqual(parseRule('FREQ=DAILY;INTERVAL=2'), null);
});

test('U parseRule gives null for a number that is not a whole number', () => {
  assert.equal(parseRule('FREQ=DAILY;INTERVAL=two'), null);
  assert.equal(parseRule('FREQ=DAILY;INTERVAL=1.5'), null);
  assert.equal(parseRule('FREQ=DAILY;COUNT=x'), null);
  assert.notEqual(parseRule('FREQ=DAILY;INTERVAL=2;COUNT=3'), null);
});

test('U parseRule gives null for a non-string', () => {
  for (const junk of [null, undefined, 42, {}, ['FREQ=DAILY'], true, () => 'FREQ=DAILY']) {
    assert.equal(parseRule(junk), null);
  }
  assert.notEqual(parseRule('FREQ=DAILY'), null);
});

// ---------- parseRule: unsupported ----------

function unsupportedTrue(text) {
  assert.equal(parsed(text).unsupported, true, `${text} should be unsupported`);
}
function unsupportedFalse(text) {
  assert.equal(parsed(text).unsupported, false, `${text} should be supported`);
}

test('U unsupported: HOURLY', () => {
  unsupportedTrue('FREQ=HOURLY');
  assert.equal(parsed('freq=hourly').freq, 'HOURLY');
  unsupportedFalse('FREQ=DAILY');
});
test('U unsupported: MINUTELY', () => {
  unsupportedTrue('FREQ=MINUTELY');
  assert.equal(parsed('FREQ=MINUTELY').freq, 'MINUTELY');
  unsupportedFalse('FREQ=WEEKLY');
});
test('U unsupported: SECONDLY', () => {
  unsupportedTrue('FREQ=SECONDLY');
  assert.equal(parsed('FREQ=SECONDLY').freq, 'SECONDLY');
  unsupportedFalse('FREQ=MONTHLY');
});
test('U unsupported: any other freq text, kept in upper case', () => {
  unsupportedTrue('FREQ=fortnightly');
  assert.equal(parsed('FREQ=fortnightly').freq, 'FORTNIGHTLY');
});
test('U unsupported: BYSETPOS', () => {
  unsupportedTrue('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1');
  unsupportedFalse('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR');
});
test('U unsupported: BYWEEKNO', () => {
  unsupportedTrue('FREQ=YEARLY;BYWEEKNO=20');
  unsupportedFalse('FREQ=YEARLY');
});
test('U unsupported: BYYEARDAY', () => {
  unsupportedTrue('FREQ=YEARLY;BYYEARDAY=100');
  unsupportedFalse('FREQ=YEARLY;BYMONTH=4');
});
test('U unsupported: BYHOUR', () => {
  unsupportedTrue('FREQ=DAILY;BYHOUR=9');
  unsupportedFalse('FREQ=DAILY');
});
test('U unsupported: BYMINUTE', () => {
  unsupportedTrue('FREQ=DAILY;BYMINUTE=30');
  unsupportedFalse('FREQ=DAILY');
});
test('U unsupported: BYSECOND', () => {
  unsupportedTrue('FREQ=DAILY;BYSECOND=15');
  unsupportedFalse('FREQ=DAILY');
});
test('U unsupported: an unknown part name', () => {
  unsupportedTrue('FREQ=DAILY;X-FOO=1');
  unsupportedTrue('FREQ=DAILY;NOSUCHPART=1');
  unsupportedFalse('FREQ=DAILY;WKST=SU');
});
test('U unsupported: a numbered BYDAY under DAILY', () => {
  unsupportedTrue('FREQ=DAILY;BYDAY=2TU');
  unsupportedFalse('FREQ=DAILY;BYDAY=TU');
});
test('U unsupported: a numbered BYDAY under WEEKLY', () => {
  unsupportedTrue('FREQ=WEEKLY;BYDAY=-1FR');
  unsupportedFalse('FREQ=WEEKLY;BYDAY=FR');
});
test('U unsupported: BYMONTHDAY under DAILY', () => {
  unsupportedTrue('FREQ=DAILY;BYMONTHDAY=15');
  unsupportedFalse('FREQ=MONTHLY;BYMONTHDAY=15');
});
test('U unsupported: BYMONTHDAY under WEEKLY', () => {
  unsupportedTrue('FREQ=WEEKLY;BYMONTHDAY=15');
  unsupportedFalse('FREQ=MONTHLY;BYMONTHDAY=-1');
});
test('U unsupported: YEARLY with BYDAY and no BYMONTH', () => {
  unsupportedTrue('FREQ=YEARLY;BYDAY=-1SU');
  unsupportedTrue('FREQ=YEARLY;BYDAY=MO');
  unsupportedFalse('FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
});
test('U unsupported: YEARLY with BYMONTHDAY and no BYMONTH', () => {
  unsupportedTrue('FREQ=YEARLY;BYMONTHDAY=12');
  unsupportedFalse('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=12');
});
test('U unsupported: INTERVAL=0', () => {
  unsupportedTrue('FREQ=DAILY;INTERVAL=0');
  unsupportedFalse('FREQ=DAILY;INTERVAL=1');
});
test('U unsupported: BYMONTH=13', () => {
  unsupportedTrue('FREQ=YEARLY;BYMONTH=13');
  unsupportedFalse('FREQ=YEARLY;BYMONTH=12');
});
test('U unsupported: BYMONTHDAY=0', () => {
  unsupportedTrue('FREQ=MONTHLY;BYMONTHDAY=0');
  unsupportedFalse('FREQ=MONTHLY;BYMONTHDAY=1');
});
test('U unsupported: an nth of 0 or beyond 53', () => {
  unsupportedTrue('FREQ=MONTHLY;BYDAY=0MO');
  unsupportedTrue('FREQ=MONTHLY;BYDAY=54MO');
  unsupportedFalse('FREQ=MONTHLY;BYDAY=5MO');
});

test('U supported twins: MONTHLY;BYDAY=2TU, YEARLY;BYMONTH=10;BYDAY=-1SU, YEARLY;BYMONTH=10;BYMONTHDAY=12', () => {
  unsupportedFalse('FREQ=MONTHLY;BYDAY=2TU');
  unsupportedFalse('FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
  unsupportedFalse('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=12');
});

// ---------- occursOn: null and junk ----------

test('U occursOn gives null for a null rule', () => {
  assert.equal(occursOn(null, '2026-10-01', '2026-10-02'), null);
  assert.equal(occ('FREQ=DAILY', '2026-10-01', '2026-10-02'), true);
});

test('U occursOn gives null for an unsupported rule', () => {
  assert.equal(occ('FREQ=HOURLY', '2026-10-01', '2026-10-02'), null);
  assert.equal(occ('FREQ=DAILY;BYHOUR=9', '2026-10-01', '2026-10-02'), null);
  assert.equal(occ('FREQ=DAILY', '2026-10-01', '2026-10-02'), true);
});

test('U occursOn gives null when a date is not a real date', () => {
  const r = parseRule('FREQ=DAILY');
  assert.equal(occursOn(r, '2026-10-01', '2026-02-30'), null);
  assert.equal(occursOn(r, '2026-10-01', '2026-13-01'), null);
  assert.equal(occursOn(r, '2026-10-01', '2029-02-29'), null);
  assert.equal(occursOn(r, '2026-10-01', 'garbage'), null);
  assert.equal(occursOn(r, '2026-10-01', ''), null);
  assert.equal(occursOn(r, '2026-02-30', '2026-10-02'), null);
  assert.equal(occursOn(r, 'garbage', '2026-10-02'), null);
  assert.equal(occursOn(r, '2026-10-01', '2028-02-29'), true);
});

test('U occursOn never throws on junk arguments', () => {
  const r = parseRule('FREQ=DAILY');
  const junk = [undefined, null, 42, {}, [], true, () => 1, 'x', '2026-10-0', '20261001'];
  for (const j of junk) {
    assert.doesNotThrow(() => occursOn(j, '2026-10-01', '2026-10-02'));
    assert.doesNotThrow(() => occursOn(r, j, '2026-10-02'));
    assert.doesNotThrow(() => occursOn(r, '2026-10-01', j));
    assert.equal(occursOn(r, '2026-10-01', j), null);
    assert.equal(occursOn(r, j, '2026-10-02'), null);
  }
  assert.doesNotThrow(() => occursOn());
  assert.doesNotThrow(() => occursOn({ freq: 'DAILY' }, '2026-10-01', '2026-10-02'));
});

// ---------- occursOn: before / on the start ----------

test('U occursOn is false before the start date and true on it', () => {
  assert.equal(occ('FREQ=DAILY', '2026-10-12', '2026-10-11'), false);
  assert.equal(occ('FREQ=DAILY', '2026-10-12', '2025-10-12'), false);
  assert.equal(occ('FREQ=DAILY', '2026-10-12', '2026-10-12'), true);
});

test('U occursOn is true on the start date even when the weekday or day does not match', () => {
  // 1 Oct 2026 is a Thursday.
  assert.equal(occ('FREQ=WEEKLY;BYDAY=MO', '2026-10-01', '2026-10-01'), true);
  assert.equal(occ('FREQ=DAILY;BYDAY=MO', '2026-10-01', '2026-10-01'), true);
  assert.equal(occ('FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-01', '2026-10-01'), true);
  assert.equal(occ('FREQ=MONTHLY;BYDAY=2MO', '2026-10-01', '2026-10-01'), true);
  assert.equal(occ('FREQ=YEARLY;BYMONTH=3', '2026-10-01', '2026-10-01'), true);
  // and the twin: the next date that does not match is false
  assert.equal(occ('FREQ=WEEKLY;BYDAY=MO', '2026-10-01', '2026-10-02'), false);
  assert.equal(occ('FREQ=WEEKLY;BYDAY=MO', '2026-10-01', '2026-10-05'), true);
});

// ---------- DAILY ----------

test('U DAILY interval 1 matches every day', () => {
  assert.equal(occ('FREQ=DAILY', '2026-10-01', '2026-10-02'), true);
  assert.equal(occ('FREQ=DAILY', '2026-10-01', '2026-10-31'), true);
  assert.equal(occ('FREQ=DAILY', '2026-10-01', '2027-03-15'), true);
});

test('U DAILY interval 3 matches every third day across a month end', () => {
  const s = '2026-10-01';
  const r = 'FREQ=DAILY;INTERVAL=3';
  assert.equal(occ(r, s, '2026-10-04'), true);
  assert.equal(occ(r, s, '2026-10-07'), true);
  assert.equal(occ(r, s, '2026-10-02'), false);
  assert.equal(occ(r, s, '2026-10-03'), false);
  assert.equal(occ(r, s, '2026-10-05'), false);
  assert.equal(occ(r, s, '2026-10-31'), true); // 30 days
  assert.equal(occ(r, s, '2026-11-01'), false); // 31 days
  assert.equal(occ(r, s, '2026-11-03'), true); // 33 days
});

test('U DAILY with BYDAY weekdays only', () => {
  const r = 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR';
  const s = '2026-10-12'; // Monday
  assert.equal(occ(r, s, '2026-10-13'), true);
  assert.equal(occ(r, s, '2026-10-16'), true); // Friday
  assert.equal(occ(r, s, '2026-10-17'), false); // Saturday
  assert.equal(occ(r, s, '2026-10-18'), false); // Sunday
  assert.equal(occ(r, s, '2026-10-19'), true); // Monday
});

test('U DAILY with BYDAY: a Saturday start counts, the Sunday after does not', () => {
  const r = 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR';
  const s = '2026-10-17'; // Saturday
  assert.equal(occ(r, s, '2026-10-17'), true);
  assert.equal(occ(r, s, '2026-10-18'), false);
  assert.equal(occ(r, s, '2026-10-19'), true);
});

test('U DAILY with BYMONTH', () => {
  const r = 'FREQ=DAILY;BYMONTH=10';
  const s = '2026-10-30';
  assert.equal(occ(r, s, '2026-10-31'), true);
  assert.equal(occ(r, s, '2026-11-01'), false);
  assert.equal(occ(r, s, '2026-11-02'), false);
  assert.equal(occ(r, s, '2027-10-30'), true);
  assert.equal(occ(r, s, '2027-12-01'), false);
});

// ---------- WEEKLY ----------

test('U WEEKLY with no BYDAY uses the start date weekday', () => {
  const s = '2026-10-01'; // Thursday
  const r = 'FREQ=WEEKLY';
  assert.equal(occ(r, s, '2026-10-08'), true);
  assert.equal(occ(r, s, '2026-10-15'), true);
  assert.equal(occ(r, s, '2026-10-09'), false);
  assert.equal(occ(r, s, '2026-10-05'), false);
  assert.equal(occ(r, s, '2027-01-07'), true);
});

test('U WEEKLY BYDAY=MO,WE', () => {
  const s = '2026-10-12'; // Monday
  const r = 'FREQ=WEEKLY;BYDAY=MO,WE';
  assert.equal(occ(r, s, '2026-10-14'), true);
  assert.equal(occ(r, s, '2026-10-19'), true);
  assert.equal(occ(r, s, '2026-10-21'), true);
  assert.equal(occ(r, s, '2026-10-13'), false);
  assert.equal(occ(r, s, '2026-10-15'), false);
  assert.equal(occ(r, s, '2026-10-17'), false);
});

test('U WEEKLY INTERVAL=2 on-week and off-week', () => {
  const s = '2026-10-12'; // Monday
  const r = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO';
  assert.equal(occ(r, s, '2026-10-26'), true);
  assert.equal(occ(r, s, '2026-11-09'), true);
  assert.equal(occ(r, s, '2026-10-19'), false);
  assert.equal(occ(r, s, '2026-11-02'), false);
  assert.equal(occ(r, s, '2026-10-27'), false); // right week, wrong weekday
});

test('U WEEKLY INTERVAL=2 with WKST=SU differs from WKST=MO when BYDAY spans the week boundary', () => {
  // Start Sunday 4 Oct 2026; BYDAY=SU,TU; every second week.
  const s = '2026-10-04';
  const mo = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=MO';
  const su = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU';
  // WKST=MO: start week is Mon 28 Sep to Sun 4 Oct.
  assert.equal(occ(mo, s, '2026-10-06'), false); // Tue, week +1
  assert.equal(occ(mo, s, '2026-10-11'), false); // Sun, week +1
  assert.equal(occ(mo, s, '2026-10-13'), true); // Tue, week +2
  assert.equal(occ(mo, s, '2026-10-18'), true); // Sun, week +2
  assert.equal(occ(mo, s, '2026-10-20'), false); // Tue, week +3
  // WKST=SU: start week is Sun 4 Oct to Sat 10 Oct.
  assert.equal(occ(su, s, '2026-10-06'), true); // Tue, same week
  assert.equal(occ(su, s, '2026-10-11'), false); // Sun, week +1
  assert.equal(occ(su, s, '2026-10-13'), false); // Tue, week +1
  assert.equal(occ(su, s, '2026-10-18'), true); // Sun, week +2
  assert.equal(occ(su, s, '2026-10-20'), true); // Tue, week +2
});

test('U WEEKLY WKST defaults to MO', () => {
  const s = '2026-10-04';
  assert.equal(occ('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU', s, '2026-10-06'), false);
  assert.equal(occ('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU', s, '2026-10-13'), true);
});

test('U WEEKLY with BYMONTH', () => {
  const s = '2026-10-01'; // Thursday
  const r = 'FREQ=WEEKLY;BYMONTH=10';
  assert.equal(occ(r, s, '2026-10-29'), true);
  assert.equal(occ(r, s, '2026-11-05'), false); // right weekday, wrong month
});

// ---------- MONTHLY ----------

test('U MONTHLY on the same day of the month', () => {
  const s = '2026-10-12';
  const r = 'FREQ=MONTHLY';
  assert.equal(occ(r, s, '2026-11-12'), true);
  assert.equal(occ(r, s, '2026-12-12'), true);
  assert.equal(occ(r, s, '2026-11-11'), false);
  assert.equal(occ(r, s, '2026-11-13'), false);
  assert.equal(occ(r, s, '2027-10-12'), true);
});

test('U MONTHLY on the 31st skips short months', () => {
  const s = '2026-01-31';
  const r = 'FREQ=MONTHLY';
  assert.equal(occ(r, s, '2026-02-28'), false);
  assert.equal(occ(r, s, '2026-03-31'), true);
  assert.equal(occ(r, s, '2026-04-30'), false);
  assert.equal(occ(r, s, '2026-05-31'), true);
  assert.equal(occ(r, s, '2026-06-30'), false);
  assert.equal(occ(r, s, '2026-07-31'), true);
});

test('U MONTHLY BYMONTHDAY=15', () => {
  const r = 'FREQ=MONTHLY;BYMONTHDAY=15';
  assert.equal(occ(r, '2026-10-15', '2026-11-15'), true);
  assert.equal(occ(r, '2026-10-15', '2026-11-14'), false);
  assert.equal(occ(r, '2026-10-15', '2026-12-15'), true);
  assert.equal(occ(r, '2026-10-01', '2026-10-15'), true); // start on the 1st, first real hit is the 15th
  assert.equal(occ(r, '2026-10-01', '2026-10-16'), false);
  assert.equal(occ(r, '2026-10-01', '2026-11-01'), false);
});

test('U MONTHLY BYMONTHDAY=-1 is the last day of each month', () => {
  const r = 'FREQ=MONTHLY;BYMONTHDAY=-1';
  const s = '2026-10-31';
  assert.equal(occ(r, s, '2026-11-30'), true);
  assert.equal(occ(r, s, '2026-11-29'), false);
  assert.equal(occ(r, s, '2026-12-31'), true);
  assert.equal(occ(r, s, '2027-02-28'), true);
  assert.equal(occ(r, s, '2027-02-27'), false);
  assert.equal(occ(r, s, '2028-02-29'), true);
  assert.equal(occ(r, s, '2028-02-28'), false);
});

test('U MONTHLY BYDAY=2MO is the second Monday', () => {
  const r = 'FREQ=MONTHLY;BYDAY=2MO';
  const s = '2026-10-12'; // second Monday of Oct 2026 (5th is the first)
  assert.equal(occ(r, s, '2026-11-09'), true);
  assert.equal(occ(r, s, '2026-11-02'), false);
  assert.equal(occ(r, s, '2026-11-16'), false);
  assert.equal(occ(r, s, '2026-12-14'), true);
  assert.equal(occ(r, s, '2026-12-07'), false);
});

test('U MONTHLY BYDAY=-1FR is the last Friday', () => {
  const r = 'FREQ=MONTHLY;BYDAY=-1FR';
  const s = '2026-10-30';
  assert.equal(occ(r, s, '2026-11-27'), true);
  assert.equal(occ(r, s, '2026-11-20'), false);
  assert.equal(occ(r, s, '2026-12-25'), true);
  assert.equal(occ(r, s, '2027-01-29'), true);
  assert.equal(occ(r, s, '2027-02-26'), true);
  assert.equal(occ(r, s, '2027-02-19'), false);
});

test('U MONTHLY BYDAY=1MO,3MO matches either entry', () => {
  const r = 'FREQ=MONTHLY;BYDAY=1MO,3MO';
  const s = '2026-10-05';
  assert.equal(occ(r, s, '2026-11-02'), true); // first Monday
  assert.equal(occ(r, s, '2026-11-16'), true); // third Monday
  assert.equal(occ(r, s, '2026-11-09'), false); // second
  assert.equal(occ(r, s, '2026-11-23'), false); // fourth
  assert.equal(occ(r, s, '2026-11-30'), false); // fifth
  assert.equal(occ(r, s, '2026-10-19'), true); // third Monday of the start month
});

test('U MONTHLY BYDAY=MO with no number is every Monday of the month', () => {
  const r = 'FREQ=MONTHLY;BYDAY=MO';
  const s = '2026-10-05';
  assert.equal(occ(r, s, '2026-10-12'), true);
  assert.equal(occ(r, s, '2026-10-19'), true);
  assert.equal(occ(r, s, '2026-11-02'), true);
  assert.equal(occ(r, s, '2026-11-30'), true);
  assert.equal(occ(r, s, '2026-11-03'), false);
});

test('U MONTHLY with BYMONTHDAY and BYDAY both: Friday the 13th', () => {
  const r = 'FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR';
  const s = '2026-11-13'; // a Friday
  assert.equal(occ(r, s, '2026-11-06'), false); // before start
  assert.equal(occ(r, s, '2026-12-13'), false); // the 13th, a Sunday
  assert.equal(occ(r, s, '2026-12-11'), false); // a Friday, not the 13th
  assert.equal(occ(r, s, '2027-01-13'), false); // a Wednesday
  assert.equal(occ(r, s, '2027-02-13'), false); // a Saturday
  assert.equal(occ(r, s, '2027-08-13'), true); // next Friday the 13th
  assert.equal(occ(r, s, '2027-08-06'), false); // a Friday in that month, not the 13th
});

test('U MONTHLY INTERVAL=3', () => {
  const r = 'FREQ=MONTHLY;INTERVAL=3';
  const s = '2026-10-12';
  assert.equal(occ(r, s, '2027-01-12'), true);
  assert.equal(occ(r, s, '2027-04-12'), true);
  assert.equal(occ(r, s, '2026-11-12'), false);
  assert.equal(occ(r, s, '2026-12-12'), false);
  assert.equal(occ(r, s, '2027-02-12'), false);
  assert.equal(occ(r, s, '2027-01-13'), false);
});

test('U MONTHLY with BYMONTH', () => {
  const r = 'FREQ=MONTHLY;BYMONTH=10,12';
  const s = '2026-10-12';
  assert.equal(occ(r, s, '2026-12-12'), true);
  assert.equal(occ(r, s, '2026-11-12'), false);
  assert.equal(occ(r, s, '2027-10-12'), true);
  assert.equal(occ(r, s, '2027-01-12'), false);
});

// ---------- YEARLY ----------

test('U YEARLY on the same month and day', () => {
  const r = 'FREQ=YEARLY';
  const s = '2026-10-12';
  assert.equal(occ(r, s, '2027-10-12'), true);
  assert.equal(occ(r, s, '2028-10-12'), true);
  assert.equal(occ(r, s, '2027-10-13'), false);
  assert.equal(occ(r, s, '2027-11-12'), false);
  assert.equal(occ(r, s, '2027-09-12'), false);
});

test('U YEARLY on 29 February happens only in leap years', () => {
  const r = 'FREQ=YEARLY';
  const s = '2028-02-29';
  assert.equal(occ(r, s, '2029-02-28'), false);
  assert.equal(occ(r, s, '2029-03-01'), false);
  assert.equal(occ(r, s, '2030-02-28'), false);
  assert.equal(occ(r, s, '2031-03-01'), false);
  assert.equal(occ(r, s, '2032-02-29'), true);
  assert.equal(occ(r, s, '2032-02-28'), false);
});

test('U YEARLY BYMONTH=3,10 uses the start date day of the month', () => {
  const r = 'FREQ=YEARLY;BYMONTH=3,10';
  const s = '2026-10-12';
  assert.equal(occ(r, s, '2027-03-12'), true);
  assert.equal(occ(r, s, '2027-10-12'), true);
  assert.equal(occ(r, s, '2028-03-12'), true);
  assert.equal(occ(r, s, '2027-03-13'), false);
  assert.equal(occ(r, s, '2027-04-12'), false);
  assert.equal(occ(r, s, '2027-11-12'), false);
});

test('U YEARLY BYMONTH=10;BYDAY=-1SU is the last Sunday of October', () => {
  const r = 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU';
  const s = '2026-10-25';
  assert.equal(occ(r, s, '2026-10-25'), true);
  assert.equal(occ(r, s, '2027-10-31'), true);
  assert.equal(occ(r, s, '2027-10-24'), false);
  assert.equal(occ(r, s, '2027-10-25'), false);
  assert.equal(occ(r, s, '2028-10-29'), true);
  assert.equal(occ(r, s, '2028-10-22'), false);
  assert.equal(occ(r, s, '2027-11-28'), false); // last Sunday of November
});

test('U YEARLY BYMONTH=10;BYMONTHDAY=12', () => {
  const r = 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=12';
  const s = '2026-10-12';
  assert.equal(occ(r, s, '2027-10-12'), true);
  assert.equal(occ(r, s, '2027-10-13'), false);
  assert.equal(occ(r, s, '2027-11-12'), false);
});

test('U YEARLY INTERVAL=2', () => {
  const r = 'FREQ=YEARLY;INTERVAL=2';
  const s = '2026-10-12';
  assert.equal(occ(r, s, '2028-10-12'), true);
  assert.equal(occ(r, s, '2030-10-12'), true);
  assert.equal(occ(r, s, '2027-10-12'), false);
  assert.equal(occ(r, s, '2029-10-12'), false);
  assert.equal(occ(r, s, '2028-10-13'), false);
});

// ---------- COUNT ----------

test('U COUNT daily COUNT=3 from 1 Oct gives the 1st, 2nd and 3rd and not the 4th', () => {
  const r = 'FREQ=DAILY;COUNT=3';
  assert.equal(occ(r, '2026-10-01', '2026-10-01'), true);
  assert.equal(occ(r, '2026-10-01', '2026-10-02'), true);
  assert.equal(occ(r, '2026-10-01', '2026-10-03'), true);
  assert.equal(occ(r, '2026-10-01', '2026-10-04'), false);
  assert.equal(occ(r, '2026-10-01', '2026-11-01'), false);
});

test('U COUNT weekly BYDAY=MO,WE COUNT=4 counts the start as number 1', () => {
  const r = 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4';
  const s = '2026-10-12'; // Monday
  assert.equal(occ(r, s, '2026-10-12'), true); // 1
  assert.equal(occ(r, s, '2026-10-14'), true); // 2
  assert.equal(occ(r, s, '2026-10-19'), true); // 3
  assert.equal(occ(r, s, '2026-10-21'), true); // 4
  assert.equal(occ(r, s, '2026-10-26'), false); // would be 5
  assert.equal(occ(r, s, '2026-10-28'), false);
  assert.equal(occ(r, s, '2026-10-13'), false); // not a listed weekday
});

test('U COUNT a start date that does not match its own BYDAY still counts as number 1', () => {
  const r = 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2';
  const s = '2026-10-01'; // Thursday
  assert.equal(occ(r, s, '2026-10-01'), true); // 1, though a Thursday
  assert.equal(occ(r, s, '2026-10-05'), true); // 2, the Monday
  assert.equal(occ(r, s, '2026-10-07'), false); // would be 3
  assert.equal(occ(r, s, '2026-10-12'), false);
});

test('U COUNT: a date more than 3,700 days after the start gives null', () => {
  // 3,700 days after 2026-10-01 is 2036-11-17; 3,701 is 2036-11-18.
  const r = 'FREQ=DAILY;COUNT=5000';
  assert.equal(occ(r, '2026-10-01', '2036-11-17'), true);
  assert.equal(occ(r, '2026-10-01', '2036-11-18'), null);
  assert.equal(occ(r, '2026-10-01', '2040-01-01'), null);
  const w = 'FREQ=WEEKLY;COUNT=2';
  assert.equal(occ(w, '2026-10-01', '2040-01-04'), null);
});

test('U COUNT: the same far date without COUNT gives a real answer', () => {
  assert.equal(occ('FREQ=DAILY', '2026-10-01', '2036-11-18'), true);
  assert.equal(occ('FREQ=DAILY', '2026-10-01', '2040-01-01'), true);
  assert.equal(occ('FREQ=WEEKLY', '2026-10-01', '2040-01-04'), false); // 4 Jan 2040 is a Wednesday
  assert.equal(occ('FREQ=WEEKLY', '2026-10-01', '2040-01-05'), true); // Thursday, a whole number of weeks on
  assert.equal(occ('FREQ=YEARLY', '2026-10-01', '2040-10-01'), true);
});

test('U COUNT exhausted well within range is false, not null', () => {
  assert.equal(occ('FREQ=DAILY;COUNT=3', '2026-10-01', '2026-10-10'), false);
  assert.equal(occ('FREQ=DAILY;COUNT=3', '2026-10-01', '2026-10-03'), true);
});

// ---------- UNTIL ignored ----------

test('U occursOn ignores UNTIL', () => {
  const r = 'FREQ=DAILY;UNTIL=20261005T000000Z';
  assert.equal(occ(r, '2026-10-01', '2026-10-20'), true);
  assert.equal(occ('FREQ=WEEKLY;UNTIL=20261005', '2026-10-01', '2026-10-22'), true);
  assert.equal(occ('FREQ=WEEKLY;UNTIL=20261005', '2026-10-01', '2026-10-23'), false);
});

// ---------- speed ----------

test('U speed: 2,000 calls of a COUNT rule 3,000 days out finish within two seconds', () => {
  const rule = parseRule('FREQ=DAILY;COUNT=4000');
  const start = '2026-01-01';
  const far = '2034-03-20'; // 3,000 days after the start
  assert.equal(occursOn(rule, start, far), true);
  const t0 = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (occursOn(rule, start, far) === true) hits += 1;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(hits, 2000);
  assert.ok(ms < 2000, `2,000 calls took ${ms} ms`);
});
