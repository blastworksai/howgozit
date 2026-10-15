// The only file that talks to Google Calendar. It reads a person's calendars from their secret iCal
// addresses, so nothing here keeps an address, an error message or a response body anywhere but in
// the one request that needs it, and nothing logs. Every caught error becomes one of six codes and
// nothing else. Pinned in references/contract.md; rules R118 to R126 and references/google-ical-seam.md.
import { eventsOn } from './ics.mjs';
import { todayIn } from '../days.mjs';

const MAX_BYTES = 10_000_000;
const MAX_EVENTS_IN_FEED = 20_000;
const REUSE_MS = 300_000;
const REST_MS = 60_000;
const MAX_HOPS = 3;
const MAX_ADDRESS = 2000;
const MAX_EVENTS = 30;
const MAX_ALL_DAY = 10;
const HOST = 'calendar.google.com';
const PREFIX = '/calendar/ical/';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const NO_ADDRESS = 'calendar-google-no-address';
const REFUSED = 'calendar-google-address-refused';
const REJECTED = 'calendar-google-address-rejected';
const UNREACHABLE = 'calendar-google-unreachable';
const NOT_A_CALENDAR = 'calendar-google-not-a-calendar';
const TOO_LARGE = 'calendar-google-too-large';
const SIX = [NO_ADDRESS, REFUSED, REJECTED, UNREACHABLE, NOT_A_CALENDAR, TOO_LARGE];
const FAILURES = new Set([REJECTED, UNREACHABLE, NOT_A_CALENDAR]);

// The only thing thrown inside this file; it carries a code and nothing else.
class Fail {
  constructor(code) {
    this.code = code;
  }
}

// R120: one test, used before every request, for the environment's address and every redirect target.
// Returns the normalised href, or null when the address is not one of Google's calendar feeds.
function acceptedAddress(raw) {
  try {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ADDRESS) return null;
    if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
    if (/(?:^|[/\\])(?:\.|%2e){1,2}(?=[/\\?#]|$)/i.test(raw)) return null;
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== HOST || u.port !== '') return null;
    if (u.username !== '' || u.password !== '') return null;
    if (u.href.includes('?') || u.href.includes('#')) return null;
    const path = u.pathname;
    if (!path.startsWith(PREFIX) || !path.endsWith('.ics')) return null;
    if (path.length < PREFIX.length + '.ics'.length + 1) return null;
    if (u.href.length > MAX_ADDRESS) return null;
    return u.href;
  } catch {
    return null;
  }
}

// Rejects with a Fail when the signal aborts first; a late answer's body is cancelled.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Fail(UNREACHABLE));
    if (signal.aborted) {
      promise.then((res) => res?.body?.cancel?.().catch(() => {}), () => {});
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', stop);
        reject(new Fail(UNREACHABLE));
      },
    );
  });
}

// Reads the body as bytes counted as they arrive; cancels the stream the moment the total passes the cap.
async function readBytes(res, signal) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await abortable(res.arrayBuffer(), signal));
    if (buf.byteLength > MAX_BYTES) throw new Fail(TOO_LARGE);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Fail(TOO_LARGE);
      chunks.push(value);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err instanceof Fail ? err : new Fail(UNREACHABLE);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const byTime = (a, b) =>
  (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) ||
  (a.end < b.end ? -1 : a.end > b.end ? 1 : 0) ||
  (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
const byTitle = (a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

export function createGoogleSource({ fetch, addresses, budgetMs = 12000, requestMs = 8000 } = {}) {
  const book = addresses && typeof addresses === 'object' ? addresses : {};

  let last = null; // { key, at, failed, value, warnings } the last answer
  const keptByPlace = new Map(); // place -> { name, date, tz, events, allDay } read well today
  const inflight = new Map();

  // One calendar: the whole chain of requests, redirects included, under one limit. Returns the
  // read sums or throws a Fail; no error object leaves this function.
  async function readOne(address, budgetSignal, date, tz) {
    const own = new AbortController();
    const timer = setTimeout(() => own.abort(), requestMs);
    const signal = AbortSignal.any([own.signal, budgetSignal]);
    try {
      let current = acceptedAddress(address);
      if (current === null) throw new Fail(REFUSED);
      for (let hop = 0; ; hop += 1) {
        let res;
        try {
          res = await abortable(
            Promise.resolve().then(() =>
              fetch(current, {
                method: 'GET',
                headers: { Accept: 'text/calendar', 'User-Agent': 'board' },
                redirect: 'manual',
                signal,
              }),
            ),
            signal,
          );
        } catch {
          throw new Fail(UNREACHABLE);
        }
        const status = res?.status;
        if (REDIRECTS.has(status)) {
          res.body?.cancel?.().catch(() => {});
          if (hop >= MAX_HOPS) throw new Fail(UNREACHABLE);
          const location = res.headers?.get?.('location');
          if (typeof location !== 'string' || location.trim() === '') throw new Fail(UNREACHABLE);
          let target;
          try {
            target = new URL(location.trim(), current).href;
          } catch {
            throw new Fail(UNREACHABLE);
          }
          const next = acceptedAddress(target);
          if (next === null) throw new Fail(REJECTED);
          current = next;
          continue;
        }
        if (status !== 200) {
          res?.body?.cancel?.().catch(() => {});
          if (status === 401 || status === 403 || status === 404 || status === 410) throw new Fail(REJECTED);
          if (Number.isInteger(status) && status >= 200 && status < 300) throw new Fail(NOT_A_CALENDAR);
          throw new Fail(UNREACHABLE);
        }
        const bytes = await readBytes(res, signal);
        let text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        text = text.trimStart();
        if (!/^BEGIN:VCALENDAR/i.test(text) || !/^END:VCALENDAR[ \t]*\r?$/im.test(text)) throw new Fail(NOT_A_CALENDAR);
        let count = 0;
        const begin = /^BEGIN:VEVENT[ \t]*\r?$/gim;
        while (begin.exec(text) !== null) {
          count += 1;
          if (count > MAX_EVENTS_IN_FEED) throw new Fail(TOO_LARGE);
        }
        return eventsOn(text, { date, tz, self: null, maxChars: MAX_BYTES, maxEvents: MAX_EVENTS_IN_FEED });
      }
    } catch (err) {
      throw err instanceof Fail ? err : new Fail(UNREACHABLE);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchDay(calendars, tz, date) {
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), budgetMs);
    try {
      const results = await Promise.all(
        calendars.map(async (c) => {
          const raw = Object.hasOwn(book, c.place) ? book[c.place] : undefined;
          if (typeof raw !== 'string' || raw.trim() === '') return { code: NO_ADDRESS };
          try {
            return { sum: await readOne(raw.trim(), budget.signal, date, tz) };
          } catch (err) {
            return { code: err instanceof Fail ? err.code : UNREACHABLE };
          }
        }),
      );
      return results;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  function compose(calendars, results, tz, date) {
    const events = [];
    const allDay = [];
    const names = new Map(SIX.map((code) => [code, []]));
    let skipped = 0;
    let zones = 0;
    let anyRead = false;
    let anyKept = false;
    let notRead = false;
    let failed = false;
    calendars.forEach((c, i) => {
      const r = results[i];
      const kind = c.kind ?? 'meeting';
      if (r.sum) {
        anyRead = true;
        skipped += r.sum.skipped;
        zones += r.sum.unknownZones;
        const mine = r.sum.events.map((e) => ({ title: e.title, start: e.start, end: e.end }));
        const mineAllDay = r.sum.allDay.map((a) => ({ title: a.title }));
        keptByPlace.set(c.place, { name: c.name, date, tz, events: mine, allDay: mineAllDay });
        for (const e of mine) events.push({ ...e, kind });
        allDay.push(...mineAllDay);
        return;
      }
      notRead = true;
      names.get(r.code).push(c.name);
      if (FAILURES.has(r.code)) {
        failed = true;
        const k = keptByPlace.get(c.place);
        if (k && k.name === c.name && k.date === date && k.tz === tz) {
          anyKept = true;
          for (const e of k.events) events.push({ ...e, kind });
          allDay.push(...k.allDay);
        }
      } else {
        keptByPlace.delete(c.place);
      }
    });
    const warnings = [];
    for (const code of SIX) {
      const list = names.get(code);
      if (list.length > 0) warnings.push({ code, count: list.length, names: list });
    }
    if (skipped > 0) warnings.push({ code: 'calendar-event-skipped', count: skipped });
    if (zones > 0) warnings.push({ code: 'calendar-zone-unknown', count: zones });
    if (calendars.length > 0 && !anyRead && !anyKept) {
      return { failed, value: { error: 'unreadable' }, warnings };
    }
    events.sort(byTime);
    const value = { date, events: events.slice(0, MAX_EVENTS) };
    allDay.sort(byTitle);
    if (allDay.length > 0) value.allDay = allDay.slice(0, MAX_ALL_DAY);
    value.stale = notRead;
    return { failed, value, warnings };
  }

  const unreadable = () => ({ value: { error: 'unreadable' }, warnings: [{ code: UNREACHABLE, count: 1, names: [] }] });

  async function doRead({ calendars, tz, now }) {
    try {
      const nowMs = Date.parse(now);
      const date = todayIn(tz, now);
      if (!date || !Array.isArray(calendars)) return unreadable();
      const key = JSON.stringify([date, tz, calendars]);
      if (last && last.key === key) {
        const age = nowMs - last.at;
        if (age >= 0 && age < (last.failed ? REST_MS : REUSE_MS)) {
          return { value: structuredClone(last.value), warnings: structuredClone(last.warnings) };
        }
      }
      const results = await fetchDay(calendars, tz, date);
      const answer = compose(calendars, results, tz, date);
      last = { key, at: nowMs, failed: answer.failed, value: answer.value, warnings: answer.warnings };
      return { value: structuredClone(answer.value), warnings: structuredClone(answer.warnings) };
    } catch {
      return unreadable();
    }
  }

  function read(args) {
    if (!args || typeof args !== 'object') return Promise.resolve(unreadable());
    let key = null;
    try {
      const date = todayIn(args.tz, args.now);
      if (date) key = JSON.stringify([date, args.tz, args.calendars]);
    } catch {
      key = null;
    }
    if (key === null) return doRead(args);
    if (inflight.has(key)) return inflight.get(key).then((a) => structuredClone(a));
    const p = doRead(args).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  }

  return { read };
}
