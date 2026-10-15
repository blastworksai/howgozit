import test from 'node:test';
import assert from 'node:assert/strict';
import { instantOf, dateIn, timeIn } from '../board/days.mjs';

const BXL = 'Europe/Brussels';
const NY = 'America/New_York';

test('U instantOf reads a Brussels morning', () => {
  assert.equal(instantOf(BXL, '2026-10-12', '10:30'), '2026-10-12T08:30:00.000Z');
});

test('U instantOf fixed points of the spec', () => {
  assert.equal(instantOf(BXL, '2026-10-25', '02:30'), '2026-10-25T00:30:00.000Z');
  assert.equal(instantOf('UTC', '2026-10-12', '00:00'), '2026-10-12T00:00:00.000Z');
  assert.equal(instantOf('America/Adak', '2026-10-12', '00:00'), '2026-10-12T09:00:00.000Z');
  assert.equal(instantOf('Pacific/Kiritimati', '2026-10-12', '00:00'), '2026-10-11T10:00:00.000Z');
});

test('U instantOf reads seconds', () => {
  assert.equal(instantOf(BXL, '2026-10-12', '10:30:45'), '2026-10-12T08:30:45.000Z');
  assert.equal(instantOf('UTC', '2026-10-12', '23:59:59'), '2026-10-12T23:59:59.000Z');
});

test('U instantOf 24:00 is the next midnight', () => {
  assert.equal(instantOf('UTC', '2026-10-12', '24:00'), '2026-10-13T00:00:00.000Z');
  assert.equal(instantOf('UTC', '2026-10-12', '24:00:00'), '2026-10-13T00:00:00.000Z');
  assert.equal(instantOf('UTC', '2026-12-31', '24:00'), '2027-01-01T00:00:00.000Z');
  assert.equal(instantOf(BXL, '2026-10-12', '24:00'), '2026-10-12T22:00:00.000Z');
});

test('U instantOf Brussels repeated hour gives the earlier instant', () => {
  assert.equal(instantOf(BXL, '2026-10-25', '02:00'), '2026-10-25T00:00:00.000Z');
  assert.equal(instantOf(BXL, '2026-10-25', '02:59'), '2026-10-25T00:59:00.000Z');
  assert.equal(instantOf(BXL, '2026-10-25', '01:59'), '2026-10-24T23:59:00.000Z');
  assert.equal(instantOf(BXL, '2026-10-25', '03:00'), '2026-10-25T02:00:00.000Z');
});

test('U instantOf Brussels missing hour moves forward by the gap', () => {
  assert.equal(instantOf(BXL, '2026-03-29', '02:30'), '2026-03-29T01:30:00.000Z');
  assert.equal(instantOf(BXL, '2026-03-29', '02:00'), '2026-03-29T01:00:00.000Z');
  assert.equal(instantOf(BXL, '2026-03-29', '01:59'), '2026-03-29T00:59:00.000Z');
  assert.equal(instantOf(BXL, '2026-03-29', '03:00'), '2026-03-29T01:00:00.000Z');
});

test('U instantOf New York repeated hour gives the earlier instant', () => {
  assert.equal(instantOf(NY, '2026-11-01', '01:30'), '2026-11-01T05:30:00.000Z');
  assert.equal(instantOf(NY, '2026-11-01', '02:00'), '2026-11-01T07:00:00.000Z');
  assert.equal(instantOf(NY, '2026-11-01', '00:59'), '2026-11-01T04:59:00.000Z');
});

test('U instantOf New York missing hour moves forward by the gap', () => {
  assert.equal(instantOf(NY, '2026-03-08', '02:30'), '2026-03-08T07:30:00.000Z');
  assert.equal(instantOf(NY, '2026-03-08', '01:59'), '2026-03-08T06:59:00.000Z');
  assert.equal(instantOf(NY, '2026-03-08', '03:00'), '2026-03-08T07:00:00.000Z');
});

test('U instantOf handles a half-hour offset zone', () => {
  assert.equal(instantOf('Asia/Kolkata', '2026-10-12', '10:30'), '2026-10-12T05:00:00.000Z');
  assert.equal(instantOf('Asia/Kolkata', '2026-10-12', '00:00'), '2026-10-11T18:30:00.000Z');
});

test('U instantOf round trips whole-minute instants', () => {
  const instants = [
    '2026-10-12T08:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z',
    '2026-03-29T00:59:00.000Z', '2026-03-29T01:00:00.000Z', '2026-11-01T05:30:00.000Z',
    '2026-11-01T06:30:00.000Z', '2026-03-08T07:00:00.000Z', '2026-12-31T23:59:00.000Z',
  ];
  for (const tz of [BXL, NY, 'Asia/Kolkata', 'UTC', 'Pacific/Kiritimati', 'America/Adak']) {
    for (const x of instants) {
      const got = instantOf(tz, dateIn(tz, x), timeIn(tz, x));
      // The repeated hour reads the same twice; the later one comes back as the earlier one.
      const repeated = (tz === BXL && x === '2026-10-25T01:30:00.000Z') || (tz === NY && x === '2026-11-01T06:30:00.000Z');
      if (repeated) assert.equal(got, new Date(Date.parse(x) - 3600000).toISOString(), `${tz} ${x}`);
      else assert.equal(got, x, `${tz} ${x}`);
    }
  }
});

test('U instantOf gives null for an unknown zone', () => {
  for (const tz of ['Mars/Olympus', '', '  ', null, undefined, 5]) {
    assert.equal(instantOf(tz, '2026-10-12', '10:30'), null);
  }
});

test('U instantOf gives null for a date that is not real', () => {
  for (const d of ['2026-02-30', '2026-13-01', '2026-10-12T00:00', '2026-1-2', '', null, undefined, 20261012]) {
    assert.equal(instantOf(BXL, d, '10:30'), null);
  }
});

test('U instantOf gives null for a bad time', () => {
  for (const t of ['25:00', '12:60', '12:30:60', 'noon', '', '1:30', '10:30:5', '24:01', '24:00:01', '24:30', '10', '10:30:00:00', null, undefined, 1030]) {
    assert.equal(instantOf(BXL, '2026-10-12', t), null, String(t));
  }
});

test('U instantOf never throws on odd input', () => {
  assert.doesNotThrow(() => instantOf({}, [], Symbol.iterator));
  assert.equal(instantOf('UTC', '9999-12-31', '24:00'), null);
});
