// The only file that talks to Apple. It reads a person's iCloud calendars over CalDAV and holds
// their sign-in, so nothing here puts an address, a status text or an error message into a
// returned value, and nothing logs. Pinned in references/contract.md; rules R97 and R100 to R103.
import {
  ROOT,
  principalBody,
  homeBody,
  calendarsBody,
  reportBody,
  parseMultistatus,
  allowedUrl,
  resolveHref,
} from './dav.mjs';
import { eventsOn } from './ics.mjs';
import { todayIn, instantOf, addDays } from '../days.mjs';

const MAX_BODY = 2_000_000;
const REUSE_MS = 300_000;
const REST_MS = 60_000;
const MAX_EVENTS = 30;
const MAX_ALL_DAY = 10;

// The only thing thrown inside this file; it carries a status number and nothing else.
class Failure {
  constructor(status) {
    this.status = Number.isInteger(status) ? status : 0;
  }
}

const norm = (name) => String(name ?? '').trim().toLowerCase();

// Reads a body from its stream and gives up as soon as more than MAX_BODY bytes have arrived.
async function readCapped(res, signal) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const aborted = new Promise((_, reject) => {
    const stop = () => reject(new Failure(0));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  aborted.catch(() => {});
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) throw new Failure(0);
      chunks.push(value);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err instanceof Failure ? err : new Failure(0);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createCalendarSource({ fetch, login, budgetMs = 8000, requestMs = 5000 }) {
  const authorization = `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}`;
  const self = String(login.user).toLowerCase();

  let found = null; // { date, list } the calendars found, kept in memory
  let lastFailed = false;
  let kept = null; // { key, at, value, warnings } the last good answer
  let failure = null; // { at, code } the last failure
  const inflight = new Map();

  // Runs `work(request)` with one budget for the whole read; every timer is cleared at the end.
  async function withBudget(work) {
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), budgetMs);
    async function request(method, url, depth, body) {
      if (!allowedUrl(url)) throw new Failure(0);
      const own = new AbortController();
      const timer = setTimeout(() => own.abort(), requestMs);
      const signal = AbortSignal.any([own.signal, budget.signal]);
      try {
        let res;
        try {
          res = await fetch(url, {
            method,
            headers: {
              Authorization: authorization,
              'Content-Type': 'application/xml; charset=utf-8',
              'User-Agent': 'board',
              Depth: depth,
            },
            body,
            redirect: 'manual',
            signal,
          });
        } catch {
          throw new Failure(0);
        }
        if (res.status !== 207) {
          res.body?.cancel().catch(() => {});
          throw new Failure(res.status);
        }
        return { status: res.status, text: await readCapped(res, signal) };
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      return await work(request);
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  async function propfind(request, url, depth, body) {
    const { text } = await request('PROPFIND', url, depth, body);
    const responses = parseMultistatus(text);
    if (!responses) throw new Failure(0);
    return responses;
  }

  async function search(request) {
    const principals = await propfind(request, ROOT, '0', principalBody());
    const principal = principals[0]?.props?.principal ? resolveHref(ROOT, principals[0].props.principal) : null;
    if (!principal) throw new Failure(0);
    const homes = await propfind(request, principal, '0', homeBody());
    const home = homes[0]?.props?.home ? resolveHref(principal, homes[0].props.home) : null;
    if (!home) throw new Failure(0);
    const rows = await propfind(request, home, '1', calendarsBody());
    const list = [];
    for (const row of rows) {
      const p = row.props ?? {};
      if (!p.isCalendar) continue;
      if (p.components !== null && p.components !== undefined && !p.components.includes('VEVENT')) continue;
      const url = resolveHref(home, row.href);
      if (!url) throw new Failure(0);
      list.push({ name: p.displayName ?? '', url });
    }
    return list;
  }

  // Finds the calendars, searching again only when the rules say so and at most once per read.
  function finder(request, date) {
    let searched = false;
    const again = async () => {
      searched = true;
      found = { date, list: await search(request) };
      lastFailed = false;
    };
    return async (names) => {
      if (!found || found.date !== date || lastFailed) await again();
      let matches = names.map((n) => found.list.filter((c) => norm(c.name) === norm(n)));
      if (!searched && matches.some((m) => m.length === 0)) {
        await again();
        matches = names.map((n) => found.list.filter((c) => norm(c.name) === norm(n)));
      }
      return matches;
    };
  }

  async function reportOn(request, calendar, date, tz) {
    const start = instantOf(tz, date, '00:00');
    const end = instantOf(tz, addDays(date, 1), '00:00');
    if (!start || !end) throw new Failure(0);
    const responses = await reportRequest(request, calendar.url, reportBody({ start, end }));
    const sum = { events: [], allDay: [], skipped: 0, unknownZones: 0 };
    for (const row of responses) {
      const data = row.props?.calendarData;
      if (!data) continue;
      const r = eventsOn(data, { date, tz, self });
      sum.events.push(...r.events);
      sum.allDay.push(...r.allDay);
      sum.skipped += r.skipped;
      sum.unknownZones += r.unknownZones;
    }
    return sum;
  }

  async function reportRequest(request, url, body) {
    const { text } = await request('REPORT', url, '1', body);
    const responses = parseMultistatus(text);
    if (!responses) throw new Failure(0);
    return responses;
  }

  const warningList = (notFound, skipped, zones) =>
    [
      ['calendar-not-found', notFound],
      ['calendar-event-skipped', skipped],
      ['calendar-zone-unknown', zones],
    ]
      .filter(([, count]) => count > 0)
      .map(([code, count]) => ({ code, count }));

  const failAnswer = (code, key) => {
    const warnings = [{ code, count: 1 }];
    if (kept && kept.key === key) {
      return { value: { ...structuredClone(kept.value), stale: true }, warnings };
    }
    return { value: { error: 'unreadable' }, warnings };
  };

  const codeOf = (err) =>
    err instanceof Failure && (err.status === 401 || err.status === 403)
      ? 'calendar-login-refused'
      : 'calendar-unreachable';

  async function fetchDay(calendars, tz, date) {
    return withBudget(async (request) => {
      const find = finder(request, date);
      const matches = await find(calendars.map((c) => c.name));
      const events = [];
      const allDay = [];
      let notFound = 0;
      let skipped = 0;
      let zones = 0;
      for (let i = 0; i < calendars.length; i += 1) {
        if (matches[i].length === 0) notFound += 1;
        for (const calendar of matches[i]) {
          const r = await reportOn(request, calendar, date, tz);
          skipped += r.skipped;
          zones += r.unknownZones;
          for (const a of r.allDay) allDay.push({ title: a.title });
          for (const e of r.events) {
            events.push({ title: e.title, start: e.start, end: e.end, kind: calendars[i].kind ?? 'meeting' });
          }
        }
      }
      events.sort(
        (a, b) =>
          (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) ||
          (a.end < b.end ? -1 : a.end > b.end ? 1 : 0) ||
          (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
      );
      const value = { date, events: events.slice(0, MAX_EVENTS) };
      allDay.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
      if (allDay.length > 0) value.allDay = allDay.slice(0, MAX_ALL_DAY);
      return { value, warnings: warningList(notFound, skipped, zones) };
    });
  }

  async function doRead({ calendars, tz, now }) {
    const nowMs = Date.parse(now);
    let key = null;
    try {
      const date = todayIn(tz, now);
      if (!date) throw new Failure(0);
      key = JSON.stringify([date, tz, calendars]);
      const age = nowMs - (kept ? kept.at : NaN);
      if (kept && kept.key === key && age >= 0 && age < REUSE_MS) {
        return { value: structuredClone(kept.value), warnings: structuredClone(kept.warnings) };
      }
      const rest = nowMs - (failure ? failure.at : NaN);
      if (failure && rest >= 0 && rest < REST_MS) return failAnswer(failure.code, key);
      const answer = await fetchDay(calendars, tz, date);
      kept = { key, at: nowMs, value: answer.value, warnings: answer.warnings };
      failure = null;
      return { value: structuredClone(answer.value), warnings: structuredClone(answer.warnings) };
    } catch (err) {
      const code = codeOf(err);
      failure = { at: nowMs, code };
      lastFailed = true;
      return failAnswer(code, key);
    }
  }

  function read(args) {
    if (!args || typeof args !== 'object') {
      return Promise.resolve({ value: { error: 'unreadable' }, warnings: [{ code: 'calendar-unreachable', count: 1 }] });
    }
    let key = null;
    try {
      const date = todayIn(args.tz, args.now);
      if (date) key = JSON.stringify([date, args.tz, args.calendars]);
    } catch {
      key = null;
    }
    if (key === null) return doRead(args);
    if (inflight.has(key)) return inflight.get(key);
    const p = doRead(args).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  }

  async function inspect(args) {
    if (!args || typeof args !== 'object' || !Array.isArray(args.names)) {
      return { ok: false, code: 'calendar-unreachable' };
    }
    const { names, tz, now } = args;
    try {
      let skipped = 0;
      let zones = 0;
      const date = todayIn(tz, now);
      if (!date) throw new Failure(0);
      return await withBudget(async (request) => {
        const list = await search(request);
        const rows = [];
        for (const name of names) {
          const hits = list.filter((c) => norm(c.name) === norm(name));
          let timed = 0;
          let allDay = 0;
          for (const calendar of hits) {
            const r = await reportOn(request, calendar, date, tz);
            timed += r.events.length;
            allDay += r.allDay.length;
            skipped += r.skipped;
            zones += r.unknownZones;
          }
          rows.push({ name, found: hits.length > 0, timed, allDay });
        }
        return { ok: true, found: list.map((c) => c.name), rows, warnings: warningList(0, skipped, zones) };
      });
    } catch (err) {
      return { ok: false, code: codeOf(err) };
    }
  }

  return { read, inspect };
}
