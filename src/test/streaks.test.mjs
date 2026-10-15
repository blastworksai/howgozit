import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, flames } from '../board/streaks.mjs';

const T = true;
const F = false;

test('U simulate walks done, token and missed days', () => {
  const r = simulate({ days: [T, T, T, T, T, T, F, T, T, T, F], todayDone: false, tokenEvery: 6 });
  assert.deepEqual(r.statuses, [...Array(6).fill('done'), 'token', 'done', 'done', 'done', 'missed', 'pending']);
  assert.equal(r.streak, 0);
  assert.equal(r.tokens, 0);
  assert.equal(r.best, 9);
});

test('U simulate stopping one day earlier keeps the streak', () => {
  const r = simulate({ days: [T, T, T, T, T, T, F, T, T, T], todayDone: false, tokenEvery: 6 });
  assert.equal(r.streak, 9);
  assert.equal(r.tokens, 0);
  assert.equal(r.counter, 3);
});

test('U simulate today done counts and pending changes nothing', () => {
  const a = simulate({ days: [T, T, T, T], todayDone: false, tokenEvery: 6 });
  assert.equal(a.streak, 4);
  assert.equal(a.statuses.at(-1), 'pending');
  const b = simulate({ days: [T, T, T, T], todayDone: true, tokenEvery: 6 });
  assert.equal(b.streak, 5);
  assert.equal(b.best, 5);
  assert.equal(b.statuses.at(-1), 'done');
});

test('U simulate best survives a reset', () => {
  const r = simulate({ days: [...Array(8).fill(T), F, T, T, T], todayDone: false, tokenEvery: 20 });
  assert.equal(r.best, 8);
  assert.equal(r.streak, 3);
});

test('U simulate handles odd input without throwing', () => {
  assert.deepEqual(simulate({}).statuses, ['pending']);
  assert.equal(simulate().streak, 0);
});

test('U flames lights tiers at or below the streak', () => {
  const tiers = [1, 3, 7, 14, 21];
  const got = [0, 1, 6, 7, 30].map((s) => flames(s, tiers));
  assert.deepEqual(got.map((g) => g.lit), [0, 1, 2, 3, 5]);
  assert.deepEqual(got.map((g) => g.toNext), [1, 2, 1, 7, null]);
  assert.deepEqual(got[2].flames, [true, true, false, false, false]);
  assert.equal(got[4].flames.length, 5);
});
