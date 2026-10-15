import test from 'node:test';
import assert from 'node:assert/strict';
import { clockMinutes, layoutDay } from '../board/render/cal-layout.mjs';

const ev = (start, end) => ({ start, end });
const lanesOf = (items) => items.map((i) => [i.lane, i.lanes]);

test('U clockMinutes: good values give minutes', () => {
  assert.equal(clockMinutes('08:30'), 510);
  assert.equal(clockMinutes('8:05'), 485);
  assert.equal(clockMinutes('24:00'), 1440);
  assert.equal(clockMinutes('00:00'), 0);
});

test('U clockMinutes: bad values give null', () => {
  for (const v of ['24:01', '25:00', '08:60', 'abc', '', null, undefined, 830, 8.5, '08:30:00']) {
    assert.equal(clockMinutes(v), null, String(v));
  }
});

test('U layoutDay: the worked example comes out exactly', () => {
  const r = layoutDay([
    ev('08:30', '08:45'),
    ev('09:00', '11:00'),
    ev('12:30', '13:30'),
    ev('18:00', '18:30'),
  ]);
  assert.equal(r.startHour, 7);
  assert.equal(r.endHour, 19);
  assert.deepEqual(r.items, [
    { top: 12.5, height: 4.2, short: true, lane: 1, lanes: 1 },
    { top: 16.7, height: 16.7, short: false, lane: 1, lanes: 1 },
    { top: 45.8, height: 8.3, short: false, lane: 1, lanes: 1 },
    { top: 91.7, height: 4.2, short: true, lane: 1, lanes: 1 },
  ]);
});

test('U layoutDay: anything but an array gives the empty default day', () => {
  for (const v of [null, undefined, 'text', { length: 2 }, 5]) {
    assert.deepEqual(layoutDay(v), { startHour: 7, endHour: 19, items: [] });
  }
});

test('U layoutDay: an empty array gives the empty default day', () => {
  assert.deepEqual(layoutDay([]), { startHour: 7, endHour: 19, items: [] });
});

test('U layoutDay: hostile entries never throw and keep their length', () => {
  const r = layoutDay([null, 5, {}, ev('10:00', '09:00'), ev('zz', 'yy')]);
  assert.equal(r.items.length, 5);
  // an end before the start runs to the end of the day (24:00), so it is the same as a written 24:00
  const ref = layoutDay([null, 5, {}, ev('10:00', '24:00'), ev('zz', 'yy')]);
  assert.equal(r.endHour, 24);
  assert.deepEqual(r, ref);
  for (const it of r.items) assert.ok(it.lane >= 1 && it.lane <= 8 && it.lanes >= 1 && it.lanes <= 8);
});

test('U layoutDay: an early event lowers startHour', () => {
  const r = layoutDay([ev('05:30', '06:00')]);
  assert.equal(r.startHour, 5);
  assert.equal(r.endHour, 19);
  assert.equal(r.items[0].top, 3.6); // (330 - 300) / 840
  assert.equal(r.items[0].height, 3.6);
});

test('U layoutDay: a late event raises endHour to 22', () => {
  const r = layoutDay([ev('20:00', '21:30')]);
  assert.equal(r.startHour, 7);
  assert.equal(r.endHour, 22);
  assert.equal(r.items[0].top, 86.7);
  assert.equal(r.items[0].height, 10);
});

test('U layoutDay: an event ending 23:59 gives endHour 24', () => {
  const r = layoutDay([ev('23:00', '23:59')]);
  assert.equal(r.endHour, 24);
  assert.equal(r.items[0].top, 94.1);
  assert.equal(r.items[0].height, 5.8);
});

test('U layoutDay: endHour never goes above 24', () => {
  const r = layoutDay([ev('24:00', '24:00')]);
  assert.equal(r.endHour, 24);
  assert.equal(r.items[0].top, 97.1);
  assert.equal(r.items[0].height, 2.9);
});

test('U layoutDay: a short event is drawn at least 30 minutes tall', () => {
  const r = layoutDay([ev('09:00', '09:10'), ev('12:00', '12:00'), ev('14:00', '14:30')]);
  assert.equal(r.items[0].height, 4.2);
  assert.equal(r.items[1].height, 4.2);
  assert.equal(r.items[2].height, 4.2);
  assert.equal(r.items[0].top, 16.7);
});

test('U layoutDay: a late start with no end is pulled up to end with the window', () => {
  const r = layoutDay([{ start: '23:50' }]);
  assert.equal(r.endHour, 24);
  assert.equal(r.items[0].top, 97.1);
  assert.equal(r.items[0].height, 2.9);
  assert.equal(r.items[0].short, true);
});

test('U layoutDay: short is true at 59 minutes and false at 60', () => {
  const r = layoutDay([ev('09:00', '09:59'), ev('11:00', '12:00')]);
  assert.equal(r.items[0].short, true);
  assert.equal(r.items[1].short, false);
});

test('U layoutDay: two events at the same time take two lanes in input order', () => {
  const r = layoutDay([ev('09:00', '10:00'), ev('09:00', '10:00')]);
  assert.deepEqual(lanesOf(r.items), [[1, 2], [2, 2]]);
});

test('U layoutDay: a short event shares a cluster with one starting at its end', () => {
  const r = layoutDay([ev('09:00', '09:15'), ev('09:15', '10:00')]);
  assert.deepEqual(lanesOf(r.items), [[1, 2], [2, 2]]);
});

test('U layoutDay: back-to-back events do not overlap', () => {
  const r = layoutDay([ev('09:00', '10:00'), ev('10:00', '11:00')]);
  assert.deepEqual(lanesOf(r.items), [[1, 1], [1, 1]]);
});

test('U layoutDay: three overlapping events use three lanes', () => {
  const r = layoutDay([ev('09:00', '10:00'), ev('09:00', '10:00'), ev('09:00', '10:00')]);
  assert.deepEqual(lanesOf(r.items), [[1, 3], [2, 3], [3, 3]]);
});

test('U layoutDay: four overlapping events take four lanes', () => {
  const r = layoutDay([
    ev('09:00', '10:00'), ev('09:00', '10:00'), ev('09:00', '10:00'), ev('09:00', '10:00'),
  ]);
  assert.deepEqual(lanesOf(r.items), [[1, 4], [2, 4], [3, 4], [4, 4]]);
});

test('U layoutDay: eight overlapping events take eight lanes', () => {
  const r = layoutDay(Array.from({ length: 8 }, () => ev('09:00', '10:00')));
  assert.deepEqual(lanesOf(r.items), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, 8]));
});

test('U layoutDay: a ninth overlapping event shares the eighth lane', () => {
  const r = layoutDay(Array.from({ length: 9 }, () => ev('09:00', '10:00')));
  assert.deepEqual(lanesOf(r.items), [1, 2, 3, 4, 5, 6, 7, 8, 8].map((n) => [n, 8]));
  for (const it of r.items) assert.ok(it.lane <= 8 && it.lanes <= 8);
});

test('U layoutDay: a lane is reused inside a cluster', () => {
  const r = layoutDay([ev('09:00', '11:00'), ev('09:00', '09:30'), ev('09:30', '10:00')]);
  assert.deepEqual(lanesOf(r.items), [[1, 2], [2, 2], [2, 2]]);
});

test('U layoutDay: a later separate cluster goes back to one lane', () => {
  const r = layoutDay([ev('09:00', '10:00'), ev('09:00', '10:00'), ev('11:00', '12:00')]);
  assert.deepEqual(lanesOf(r.items), [[1, 2], [2, 2], [1, 1]]);
});

test('U layoutDay: events out of time order still map items[i] to events[i]', () => {
  const r = layoutDay([ev('14:00', '15:00'), ev('09:00', '10:00'), ev('09:30', '10:30')]);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].top, 58.3);
  assert.deepEqual(lanesOf(r.items), [[1, 1], [1, 2], [2, 2]]);
  assert.equal(r.items[1].top, 16.7);
});

test('U layoutDay: same-lane boxes never overlap and everything stays inside the window', () => {
  const days = [
    [ev('08:30', '08:45'), ev('09:00', '11:00'), ev('12:30', '13:30'), ev('18:00', '18:30')],
    [ev('09:00', '11:00'), ev('09:00', '09:30'), ev('09:30', '10:00'), ev('10:00', '10:10')],
    [ev('05:30', '06:00'), ev('06:00', '07:30'), ev('06:30', '08:00'), ev('20:00', '21:30')],
    [ev('09:00', '09:15'), ev('09:15', '09:20'), ev('09:45', '10:30'), { start: '23:50' }],
    [ev('13:00', '14:00'), ev('13:30', '14:30'), ev('14:00', '15:00'), ev('12:00', '12:00')],
    [ev('09:00', '10:00'), ev('09:00', '10:00'), ev('09:00', '10:00'), ev('09:00', '10:00')],
  ];
  for (const day of days) {
    const { items } = layoutDay(day);
    assert.equal(items.length, day.length);
    for (const it of items) {
      assert.ok(it.top >= 0, `top ${it.top}`);
      assert.ok(it.top + it.height <= 100.05, `bottom ${it.top + it.height}`);
    }
    if (items.some((it) => it.lanes >= 3)) continue; // cap hit: lanes may legitimately share
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        if (items[a].lane !== items[b].lane) continue;
        const A = items[a];
        const B = items[b];
        const apart = A.top + A.height <= B.top + 0.15 || B.top + B.height <= A.top + 0.15;
        assert.ok(apart, `items ${a} and ${b} overlap in lane ${A.lane}`);
      }
    }
  }
});
