// Test material: a fetch stand-in that plays Google Calendar's "secret address in iCal format" feeds.
// Self-contained on purpose: it imports nothing from board/ (only the iCalendar text writer beside it).
// Nothing here was observed on a live account; it follows the pinned seam note (reference/google-ical-seam.md).
//
//   const fake = fakeGoogleIcal({ feeds: { [ADDRESS]: icsFeed([...]) } });
//   source = createGoogleSource({ fetch: fake, addresses: { 1: ADDRESS } });
//   fake.calls  // every call, as { url, method, headers, redirect }
//
// The returned value is itself a fetch function, and also carries `.fetch` (the same function),
// `.calls`, `.streams` and `.feeds` (the live map: a test may change an answer between two reads).

import { vevent, vcalendar } from './ics.mjs';

const HOST = 'calendar.google.com';
const CHUNK = 64 * 1024;
const PREFIX = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Stream//EN\r\n';
const FILL_LINE = `X-PAD:${'a'.repeat(58)}\r\n`; // 66 bytes, ASCII

// The answer for an address nobody gave the stand-in, and for any other host: the network fails.
const networkError = () => new TypeError('fetch failed');

function abortReason(signal) {
  return signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

// Resolves after `ms`, or rejects when the signal aborts first.
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let timer = null;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// An answer that never comes until the signal aborts. The timer keeps the process alive only while waiting.
function never(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
  });
}

// A body of `total` bytes (Infinity: no end), sent chunk by chunk as the reader pulls; `record` is kept up to date.
function streamBody(total, record) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK, total - sent);
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) {
        const at = sent + i;
        bytes[i] = at < PREFIX.length ? PREFIX.charCodeAt(at) : FILL_LINE.charCodeAt((at - PREFIX.length) % FILL_LINE.length);
      }
      sent += size;
      record.sent = sent;
      controller.enqueue(bytes);
    },
    cancel() {
      record.cancelled = true;
    },
  });
}

function sameAddress(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

export function fakeGoogleIcal({ feeds } = {}) {
  const calls = [];
  const streams = [];
  const live = feeds && typeof feeds === 'object' ? feeds : {};

  function lookup(url) {
    if (Object.hasOwn(live, url)) return { found: true, feed: live[url] };
    for (const key of Object.keys(live)) {
      if (sameAddress(key, url)) return { found: true, feed: live[key] };
    }
    return { found: false };
  }

  function respond(feed, url, signal) {
    // A function answers per call; a string is a calendar.
    if (typeof feed === 'function') return respond(feed({ url }), url, signal);
    if (typeof feed === 'string') {
      return new Response(feed, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' } });
    }
    const spec = feed ?? {};
    if (spec.never) return never(signal);
    if (Object.hasOwn(spec, 'redirect')) {
      const headers = { ...(spec.headers ?? {}) };
      if (typeof spec.redirect === 'string' && spec.redirect !== '') headers.location = spec.redirect;
      return new Response(null, { status: spec.status ?? 302, headers });
    }
    if (Object.hasOwn(spec, 'stream')) {
      const total = typeof spec.stream === 'number' ? spec.stream : Infinity;
      const record = { url, sent: 0, cancelled: false };
      streams.push(record);
      return new Response(streamBody(total, record), {
        status: spec.status ?? 200,
        headers: { 'content-type': 'text/calendar', ...(spec.headers ?? {}) },
      });
    }
    const status = spec.status ?? 200;
    const empty = status === 204 || status === 205 || status === 304;
    const body = empty ? null : (spec.body ?? '');
    return new Response(body, { status, headers: spec.headers ?? {} });
  }

  function standIn(input, init = {}) {
    const url = String(input instanceof URL ? input.href : (input?.url ?? input));
    const headers = {};
    for (const [name, value] of new Headers(init?.headers ?? {})) headers[name.toLowerCase()] = value;
    calls.push({
      url,
      method: String(init?.method ?? 'GET').toUpperCase(),
      headers,
      redirect: init?.redirect,
    });
    const signal = init?.signal;

    let u = null;
    try {
      u = new URL(url);
    } catch {
      return Promise.reject(networkError());
    }
    // Only the one Google host answers: another host, a port, a user name or a plain http: address fails like a network.
    if (u.protocol !== 'https:' || u.host !== HOST || u.username || u.password) return Promise.reject(networkError());
    const hit = lookup(url);
    if (!hit.found) return Promise.reject(networkError());

    const delayMs = hit.feed && typeof hit.feed === 'object' && typeof hit.feed.delayMs === 'number' ? hit.feed.delayMs : 0;
    if (delayMs > 0) {
      return wait(delayMs, signal).then(() => respond(hit.feed, url, signal));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return Promise.resolve(respond(hit.feed, url, signal));
  }

  standIn.fetch = standIn;
  standIn.calls = calls;
  standIn.streams = streams;
  standIn.feeds = live;
  return standIn;
}

// A calendar text from plain event descriptions:
//   { title, start, end, tzid, allDay, rrule, exdate, recurrenceId, status, uid, declined, extra }
// start and end are written as iCalendar values (`20261012T083000Z`, or `20261012` with allDay).
// `declined: true` adds an attendee line with PARTSTAT=DECLINED. A plain string is taken as a ready VEVENT text.
export function icsFeed(events = []) {
  const texts = events.map((e) => {
    if (typeof e === 'string') return e;
    const { title, declined, extra, ...rest } = e;
    const lines = [...(extra ?? [])];
    if (declined) lines.push('ATTENDEE;PARTSTAT=DECLINED:mailto:sam@example.invalid');
    return vevent({ ...rest, summary: title, extra: lines });
  });
  return vcalendar(...texts);
}

// The same text padded with X-PAD lines (ASCII) to exactly `bytes` bytes, placed before END:VCALENDAR.
export function padTo(text, bytes) {
  const marker = '\r\nEND:VCALENDAR';
  const at = text.lastIndexOf(marker);
  if (at < 0) throw new RangeError('padTo needs a calendar text');
  let need = bytes - Buffer.byteLength(text);
  if (need === 0) return text;
  if (need < 0 || need < 6) throw new RangeError('padTo cannot reach that size');
  let pad = '';
  while (need > 0) {
    const chunk = need > 72 ? (need - 72 >= 6 ? 72 : need - 6) : need;
    pad += `X-P:${'a'.repeat(chunk - 6)}\r\n`;
    need -= chunk;
  }
  return `${text.slice(0, at + 2)}${pad}${text.slice(at + 2)}`;
}
