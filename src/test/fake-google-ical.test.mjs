// Tests of the stand-in itself (fixtures/fake-google-ical.mjs). They prove no contract rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeGoogleIcal, icsFeed, padTo } from '../fixtures/fake-google-ical.mjs';

const ADDR = 'https://calendar.google.com/calendar/ical/home%40example.invalid/private-0123456789abcdef/basic.ics';
const OTHER = 'https://calendar.google.com/calendar/ical/work%40example.invalid/private-fedcba9876543210/basic.ics';
const ASKED = { method: 'GET', headers: { Accept: 'text/calendar', 'User-Agent': 'board' }, redirect: 'manual' };

const CAL = icsFeed([{ title: 'Standup', start: '20261012T070000Z', end: '20261012T073000Z' }]);

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

test('U a string feed answers 200 with that text as a calendar', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: CAL } });
  const res = await fake(ADDR, ASKED);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), CAL);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
});

test('U the stand-in is also reachable as .fetch', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: CAL } });
  assert.equal(fake.fetch, fake);
  assert.equal((await fake.fetch(ADDR, ASKED)).status, 200);
});

test('U a { status, headers, body } feed answers as written', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { status: 503, headers: { 'x-a': 'b' }, body: 'down' } } });
  const res = await fake(ADDR, ASKED);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('x-a'), 'b');
  assert.equal(await res.text(), 'down');
});

test('U a 204 feed answers with no body', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { status: 204 } } });
  const res = await fake(ADDR, ASKED);
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
});

test('U a { redirect } feed answers 302 with the Location as written', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { redirect: 'https://accounts.google.com/ServiceLogin' } } });
  const res = await fake(ADDR, ASKED);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://accounts.google.com/ServiceLogin');
});

test('U a { redirect, status } feed uses that status, and a null redirect sends no Location', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { redirect: OTHER, status: 301 }, [OTHER]: { redirect: null, status: 307 } } });
  const first = await fake(ADDR, ASKED);
  assert.equal(first.status, 301);
  assert.equal(first.headers.get('location'), OTHER);
  const second = await fake(OTHER, ASKED);
  assert.equal(second.status, 307);
  assert.equal(second.headers.get('location'), null);
});

test('U a redirect chain can be followed by asking the next address', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { redirect: OTHER, status: 301 }, [OTHER]: CAL } });
  const first = await fake(ADDR, ASKED);
  const next = await fake(first.headers.get('location'), ASKED);
  assert.equal(await next.text(), CAL);
});

test('U a { never } feed does not answer until the signal aborts, then rejects with an abort error', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { never: true } } });
  const controller = new AbortController();
  const pending = rejection(fake(ADDR, { ...ASKED, signal: controller.signal }));
  const timer = setTimeout(() => controller.abort(), 20);
  const err = await pending;
  clearTimeout(timer);
  assert.ok(err, 'the call should reject');
  assert.equal(err.name, 'AbortError');
});

test('U a signal that is already aborted rejects at once, and the call is still recorded', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: CAL } });
  const controller = new AbortController();
  controller.abort();
  const err = await rejection(fake(ADDR, { ...ASKED, signal: controller.signal }));
  assert.equal(err?.name, 'AbortError');
  assert.equal(fake.calls.length, 1);
});

test('U delayMs holds the answer back, and an abort during the delay rejects', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { delayMs: 60, body: CAL } } });
  const t0 = Date.now();
  const res = await fake(ADDR, ASKED);
  assert.ok(Date.now() - t0 >= 50, 'answered too early');
  assert.equal(await res.text(), CAL);

  const controller = new AbortController();
  const pending = rejection(fake(ADDR, { ...ASKED, signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  assert.equal((await pending)?.name, 'AbortError');
});

test('U delayMs combines with a string-free redirect and a stream', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { delayMs: 20, redirect: OTHER }, [OTHER]: { delayMs: 20, stream: 1000 } } });
  assert.equal((await fake(ADDR, ASKED)).status, 302);
  const res = await fake(OTHER, ASKED);
  assert.equal((await res.arrayBuffer()).byteLength, 1000);
});

test('U a { stream: n } feed sends exactly n bytes, starts as a calendar and has no Content-Length', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { stream: 200000 } } });
  const res = await fake(ADDR, ASKED);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), null);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes.length, 200000);
  assert.ok(Buffer.from(bytes.subarray(0, 15)).toString().startsWith('BEGIN:VCALENDAR'));
  assert.equal(fake.streams.length, 1);
  assert.equal(fake.streams[0].sent, 200000);
  assert.equal(fake.streams[0].cancelled, false);
});

test('U a { stream: true } feed never ends; cancelling the reader is recorded with the bytes sent', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: { stream: true } } });
  const res = await fake(ADDR, ASKED);
  const reader = res.body.getReader();
  let got = 0;
  while (got < 300000) got += (await reader.read()).value.length;
  await reader.cancel();
  assert.equal(fake.streams[0].cancelled, true);
  assert.ok(fake.streams[0].sent >= 300000 && fake.streams[0].sent < 300000 + 2 * 65536 + 1, `sent ${fake.streams[0].sent}`);
});

test('U every call is recorded as { url, method, headers (lower-case names), redirect }', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: CAL } });
  await fake(ADDR, ASKED);
  assert.deepEqual(fake.calls, [
    { url: ADDR, method: 'GET', headers: { accept: 'text/calendar', 'user-agent': 'board' }, redirect: 'manual' },
  ]);
});

test('U a call with no options is recorded as a GET with no headers and no redirect mode', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: CAL } });
  await fake(ADDR);
  assert.deepEqual(fake.calls, [{ url: ADDR, method: 'GET', headers: {}, redirect: undefined }]);
});

test('U an address the stand-in was not given is recorded and rejected like a network failure', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: CAL } });
  const err = await rejection(fake(OTHER, ASKED));
  assert.ok(err instanceof TypeError);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, OTHER);
});

test('U any host other than calendar.google.com is recorded and rejected, even with a feed under that address', async () => {
  const bad = [
    'https://accounts.google.com/ServiceLogin',
    'https://evil.example/calendar/ical/x/basic.ics',
    'http://calendar.google.com/calendar/ical/x/basic.ics',
    'https://calendar.google.com:8443/calendar/ical/x/basic.ics',
    'https://u:pw@calendar.google.com/calendar/ical/x/basic.ics',
  ];
  const feeds = Object.fromEntries(bad.map((a) => [a, CAL]));
  const fake = fakeGoogleIcal({ feeds });
  for (const address of bad) {
    const err = await rejection(fake(address, ASKED));
    assert.ok(err instanceof TypeError, address);
  }
  assert.deepEqual(fake.calls.map((c) => c.url), bad);
});

test('U an address with the host in capitals finds the feed given in lower case', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: CAL } });
  const res = await fake(ADDR.replace('calendar.google.com', 'CALENDAR.GOOGLE.COM'), ASKED);
  assert.equal(await res.text(), CAL);
});

test('U .feeds is the live map: changing it changes the next answer', async () => {
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: CAL } });
  assert.equal((await fake(ADDR, ASKED)).status, 200);
  fake.feeds[ADDR] = { status: 500 };
  assert.equal((await fake(ADDR, ASKED)).status, 500);
});

test('U a function feed is asked on every call', async () => {
  let n = 0;
  const fake = fakeGoogleIcal({ feeds: { [ADDR]: () => (++n === 1 ? CAL : { status: 503 }) } });
  assert.equal((await fake(ADDR, ASKED)).status, 200);
  assert.equal((await fake(ADDR, ASKED)).status, 503);
});

test('U no feeds at all rejects every call', async () => {
  const fake = fakeGoogleIcal();
  assert.ok(await rejection(fake(ADDR, ASKED)));
  assert.equal(fake.calls.length, 1);
});

test('U icsFeed writes a calendar with the events, a declined attendee, an all-day event and a repeat', () => {
  const text = icsFeed([
    { title: 'Dentist', start: '20261012T070000Z', end: '20261012T080000Z', declined: true },
    { title: 'Holiday', start: '20261012', end: '20261013', allDay: true },
    { title: 'Weekly', start: '20260928T090000', end: '20260928T100000', tzid: 'Europe/Brussels', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
  ]);
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(text.trimEnd().endsWith('END:VCALENDAR'));
  assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length, 3);
  assert.ok(text.includes('SUMMARY:Dentist'));
  assert.ok(text.includes('ATTENDEE;PARTSTAT=DECLINED:mailto:sam@example.invalid'));
  assert.ok(text.includes('DTSTART;VALUE=DATE:20261012'));
  assert.ok(text.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'));
  assert.ok(text.includes('DTSTART;TZID=Europe/Brussels:20260928T090000'));
});

test('U icsFeed with no events is a calendar with no VEVENT', () => {
  const text = icsFeed([]);
  assert.ok(text.includes('BEGIN:VCALENDAR') && text.includes('END:VCALENDAR'));
  assert.equal(text.includes('BEGIN:VEVENT'), false);
});

test('U padTo reaches the exact byte count and keeps the calendar whole', () => {
  const base = icsFeed([{ title: 'Standup', start: '20261012T070000Z', end: '20261012T073000Z' }]);
  const size = Buffer.byteLength(base);
  for (const target of [size, size + 6, size + 7, size + 77, size + 78, size + 1000, 10000000]) {
    const padded = padTo(base, target);
    assert.equal(Buffer.byteLength(padded), target, `target ${target}`);
    assert.ok(padded.trimEnd().endsWith('END:VCALENDAR'));
    assert.equal((padded.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  }
  assert.throws(() => padTo(base, size + 3), RangeError);
});
