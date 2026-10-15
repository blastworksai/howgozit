import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  todayIn, dateIn, timeIn, utcDate, isDate, isZone,
  addDays, addMonths, diffDays, monthStart, monthEnd, weekStart, isoWeek,
} from '../board/days.mjs';

const BXL = 'Europe/Brussels';
const NY = 'America/New_York';

test('U isDate accepts real dates only', () => {
  assert.equal(isDate('2026-10-12'), true);
  assert.equal(isDate('2028-02-29'), true);
  assert.equal(isDate('2026-02-30'), false);
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2100-02-29'), false);
  assert.equal(isDate('2000-02-29'), true);
  assert.equal(isDate('2026-13-01'), false);
  assert.equal(isDate('2026-00-10'), false);
  assert.equal(isDate('2026-04-31'), false);
});

test('U isDate rejects other shapes and types', () => {
  for (const s of ['2026-1-2', '2026-10-12 ', ' 2026-10-12', '2026-10-12T00:00:00Z', '20261012', '', 'nope']) {
    assert.equal(isDate(s), false, JSON.stringify(s));
  }
  for (const v of [null, undefined, 20261012, {}, [], new Date(0)]) assert.equal(isDate(v), false);
});

test('U isZone knows zones and never throws', () => {
  assert.equal(isZone(BXL), true);
  assert.equal(isZone('UTC'), true);
  assert.equal(isZone('Pacific/Kiritimati'), true);
  assert.equal(isZone('Mars/Olympus'), false);
  assert.equal(isZone(''), false);
  assert.equal(isZone('   '), false);
  for (const v of [null, undefined, 5, {}, []]) assert.equal(isZone(v), false);
});

test('U dateIn and todayIn follow the zone, not the machine', () => {
  const now = '2026-10-12T22:30:00Z';
  assert.equal(todayIn(BXL, now), '2026-10-13');
  assert.equal(todayIn(NY, now), '2026-10-12');
  assert.equal(dateIn(BXL, now), '2026-10-13');
  assert.equal(dateIn('Pacific/Kiritimati', '2026-10-12T10:30:00Z'), '2026-10-13');
  assert.equal(dateIn('America/Adak', '2026-10-12T03:00:00Z'), '2026-10-11');
  assert.equal(todayIn(BXL, new Date('2026-10-12T22:30:00Z')), '2026-10-13');
  assert.equal(dateIn(BXL, '2026-10-12T22:30:00+00:00'), '2026-10-13');
  assert.equal(dateIn(BXL, '2026-10-13T00:30:00+02:00'), '2026-10-13');
});

test('U the clock change of 2026-10-25 in Europe/Brussels moves no date', () => {
  assert.equal(dateIn(BXL, '2026-10-25T00:59:59Z'), '2026-10-25');
  assert.equal(dateIn(BXL, '2026-10-25T01:00:00Z'), '2026-10-25');
  assert.equal(dateIn(BXL, '2026-10-24T21:59:59Z'), '2026-10-24');
  assert.equal(dateIn(BXL, '2026-10-24T22:00:00Z'), '2026-10-25');
  assert.equal(dateIn(BXL, '2026-10-25T22:59:59Z'), '2026-10-25');
  assert.equal(dateIn(BXL, '2026-10-25T23:00:00Z'), '2026-10-26');
  assert.equal(timeIn(BXL, '2026-10-25T00:59:00Z'), '02:59');
  assert.equal(timeIn(BXL, '2026-10-25T01:00:00Z'), '02:00');
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(addDays('2026-10-24', 2), '2026-10-26');
  assert.equal(addDays('2026-10-26', -2), '2026-10-24');
  assert.equal(diffDays('2026-10-24', '2026-10-26'), 2);
  assert.equal(diffDays('2026-10-25', '2026-10-26'), 1);
  assert.equal(diffDays('2026-03-28', '2026-03-30'), 2);
});

test('U timeIn is 24-hour and midnight is 00:00', () => {
  assert.equal(timeIn(BXL, '2026-10-12T22:00:00Z'), '00:00');
  assert.equal(timeIn(BXL, '2026-10-12T22:30:00Z'), '00:30');
  assert.equal(timeIn('UTC', '2026-10-12T00:00:00Z'), '00:00');
  assert.equal(timeIn('UTC', '2026-10-12T23:59:00Z'), '23:59');
  assert.equal(timeIn(BXL, '2026-10-12T09:59:00Z'), '11:59');
  assert.equal(timeIn(NY, '2026-10-12T22:30:00Z'), '18:30');
  assert.equal(timeIn('Asia/Kolkata', '2026-10-12T00:00:00Z'), '05:30');
  assert.equal(timeIn(BXL, new Date('2026-10-12T10:00:00Z')), '12:00');
});

test('U utcDate is the UTC calendar date', () => {
  assert.equal(utcDate('2026-10-20T07:00:00Z'), '2026-10-20');
  assert.equal(utcDate('2026-10-20T23:59:59Z'), '2026-10-20');
  assert.equal(utcDate('2026-10-20T00:00:00Z'), '2026-10-20');
  assert.equal(utcDate('2026-10-20T01:00:00+02:00'), '2026-10-19');
  assert.equal(utcDate(new Date('2026-10-20T23:59:59Z')), '2026-10-20');
});

test('U bad instants and zones give null, never a throw', () => {
  for (const bad of ['', 'yesterday', '2026-02-30T10:00:00Z', '2026-10-12T10:00:00', 'Oct 12 2026', null, undefined, 5, {}, new Date('x')]) {
    assert.equal(utcDate(bad), null, String(bad));
    assert.equal(dateIn(BXL, bad), null, String(bad));
    assert.equal(todayIn(BXL, bad), null, String(bad));
    assert.equal(timeIn(BXL, bad), null, String(bad));
  }
  assert.equal(dateIn('Mars/Olympus', '2026-10-12T10:00:00Z'), null);
  assert.equal(timeIn(undefined, '2026-10-12T10:00:00Z'), null);
  assert.equal(todayIn(null, '2026-10-12T10:00:00Z'), null);
});

test('U addDays moves forward, backward, across months and years', () => {
  assert.equal(addDays('2026-10-12', 0), '2026-10-12');
  assert.equal(addDays('2026-10-12', 1), '2026-10-13');
  assert.equal(addDays('2026-10-12', -1), '2026-10-11');
  assert.equal(addDays('2026-10-12', -12), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2026-10-12', 365), '2027-10-12');
  assert.equal(addDays('2026-10-12', -400), '2025-09-07');
});

test('U addDays handles the leap day 2028-02-29', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2028-02-29', 365), '2029-02-28');
  assert.equal(addDays('2028-02-29', 366), '2029-03-01');
});

test('U addDays gives null for bad input', () => {
  assert.equal(addDays('2026-02-30', 1), null);
  assert.equal(addDays('nope', 1), null);
  assert.equal(addDays('2026-10-12', 1.5), null);
  assert.equal(addDays('2026-10-12', '1'), null);
  assert.equal(addDays('2026-10-12', NaN), null);
  assert.equal(addDays(null, 1), null);
  assert.equal(addDays('9999-12-31', 1), null);
});

test('U addMonths clamps to the last day of the month', () => {
  assert.equal(addMonths('2026-10-31', 1), '2026-11-30');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-10-12', 0), '2026-10-12');
  assert.equal(addMonths('2026-10-12', 1), '2026-11-12');
  assert.equal(addMonths('2028-02-29', 12), '2029-02-28');
  assert.equal(addMonths('2028-02-29', 48), '2032-02-29');
});

test('U addMonths handles negative n and year boundaries', () => {
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-10-12', -10), '2025-12-12');
  assert.equal(addMonths('2026-10-12', -22), '2024-12-12');
  assert.equal(addMonths('2026-10-12', 15), '2028-01-12');
  assert.equal(addMonths('2026-10-12', 11), '2027-09-12');
});

test('U addMonths gives null for bad input', () => {
  assert.equal(addMonths('2026-02-30', 1), null);
  assert.equal(addMonths('2026-10-12', 0.5), null);
  assert.equal(addMonths('x', 1), null);
  assert.equal(addMonths('0001-01-01', -1), null);
});

test('U diffDays is b minus a', () => {
  assert.equal(diffDays('2026-10-12', '2026-10-12'), 0);
  assert.equal(diffDays('2026-10-12', '2026-10-13'), 1);
  assert.equal(diffDays('2026-10-13', '2026-10-12'), -1);
  assert.equal(diffDays('2026-12-31', '2027-01-01'), 1);
  assert.equal(diffDays('2026-01-01', '2027-01-01'), 365);
  assert.equal(diffDays('2028-01-01', '2029-01-01'), 366);
  assert.equal(diffDays('2028-02-28', '2028-03-01'), 2);
  assert.equal(diffDays('2026-10-12', '2026-12-31'), 80);
  assert.equal(diffDays('2026-02-30', '2026-03-01'), null);
  assert.equal(diffDays('2026-03-01', 'x'), null);
});

test('U monthStart and monthEnd', () => {
  assert.equal(monthStart('2026-10-12'), '2026-10-01');
  assert.equal(monthStart('2026-10-01'), '2026-10-01');
  assert.equal(monthEnd('2026-10-12'), '2026-10-31');
  assert.equal(monthEnd('2026-11-01'), '2026-11-30');
  assert.equal(monthEnd('2026-02-10'), '2026-02-28');
  assert.equal(monthEnd('2028-02-10'), '2028-02-29');
  assert.equal(monthEnd('2100-02-10'), '2100-02-28');
  assert.equal(monthEnd('2026-12-31'), '2026-12-31');
  assert.equal(monthStart('2026-02-30'), null);
  assert.equal(monthEnd('nope'), null);
});

test('U weekStart for monday weeks', () => {
  assert.equal(weekStart('2026-10-12', 'monday'), '2026-10-12');
  assert.equal(weekStart('2026-10-13', 'monday'), '2026-10-12');
  assert.equal(weekStart('2026-10-18', 'monday'), '2026-10-12');
  assert.equal(weekStart('2026-10-19', 'monday'), '2026-10-19');
  assert.equal(weekStart('2026-01-01', 'monday'), '2025-12-29');
});

test('U weekStart for sunday weeks', () => {
  assert.equal(weekStart('2026-10-18', 'sunday'), '2026-10-18');
  assert.equal(weekStart('2026-10-12', 'sunday'), '2026-10-11');
  assert.equal(weekStart('2026-10-17', 'sunday'), '2026-10-11');
  assert.equal(weekStart('2026-10-19', 'sunday'), '2026-10-18');
  assert.equal(weekStart('2026-01-01', 'sunday'), '2025-12-28');
});

test('U weekStart gives null for a bad setting or date', () => {
  assert.equal(weekStart('2026-10-12', 'friday'), null);
  assert.equal(weekStart('2026-10-12', undefined), null);
  assert.equal(weekStart('2026-02-30', 'monday'), null);
});

test('U isoWeek', () => {
  assert.equal(isoWeek('2026-10-12'), 42);
  assert.equal(isoWeek('2026-10-18'), 42);
  assert.equal(isoWeek('2026-10-19'), 43);
  assert.equal(isoWeek('2026-01-01'), 1);
  assert.equal(isoWeek('2026-01-04'), 1);
  assert.equal(isoWeek('2026-01-05'), 2);
  assert.equal(isoWeek('2026-12-31'), 53);
  assert.equal(isoWeek('2027-01-01'), 53);
  assert.equal(isoWeek('2027-01-03'), 53);
  assert.equal(isoWeek('2027-01-04'), 1);
  assert.equal(isoWeek('2024-12-30'), 1);
  assert.equal(isoWeek('2028-02-29'), 9);
  assert.equal(isoWeek('2026-02-30'), null);
});

// Strip comments, then look for anything that reads the clock or a Date's local parts.
function offences(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const found = [];
  if (/\.get(Date|Day|Hours|Minutes|Seconds|Milliseconds|Month|FullYear|Year|TimezoneOffset)\s*\(/.test(code)) found.push('local getter');
  if (/new\s+Date\s*\(\s*\)/.test(code)) found.push('argument-less new Date()');
  if (/Date\s*\.\s*now\b/.test(code)) found.push('Date.now');
  if (/\bprocess\b/.test(code)) found.push('process');
  return found;
}

test('U source scan: days.mjs reads no clock, no local part, no environment', () => {
  const src = readFileSync(new URL('../board/days.mjs', import.meta.url), 'utf8');
  assert.deepEqual(offences(src), []);
});

test('U source scan catches what it should (twin)', () => {
  assert.deepEqual(offences('const a = d.getDate();'), ['local getter']);
  assert.deepEqual(offences('const a = d.getHours ();'), ['local getter']);
  assert.deepEqual(offences('const a = new Date();'), ['argument-less new Date()']);
  assert.deepEqual(offences('const a = Date.now();'), ['Date.now']);
  assert.deepEqual(offences('const a = d.getUTCDate(); // Date.now in a comment'), []);
});
