// Which events of one iCalendar text fall on the board's day (pure).
// No clock, no file, no network; never throws. Instants are whole milliseconds since the epoch;
// no Date local part is ever read, so the answer does not depend on the machine's timezone.

import { readEvents, cleanTitle } from './ics-text.mjs';
import { parseRule, occursOn } from './recur.mjs';
import { instantOf, dateIn, timeIn, addDays, diffDays, isDate, isZone } from '../days.mjs';

const MINUTE = 60000;
const DAY = 86400000;
const MAX_SPAN_DAYS = 31;


// Zone arithmetic lives in days.mjs (the one home of the clock-change rules).
// The instant (ms) at which the wall clock in `zone` reads `date` and `time` (HH:MM:SS), or null.
function wallToMs(zone, date, time) {
  const iso = instantOf(zone, date, time);
  return iso === null ? null : Date.parse(iso);
}
const dateAt = (zone, ms) => dateIn(zone, new Date(ms));
const timeAt = (zone, ms) => timeIn(zone, new Date(ms));

const first = (ev, name) => (ev[name] && ev[name].length > 0 ? ev[name][0] : null);
const compact = (date) => date.replaceAll('-', '');
const dashed = (c) => `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`;

// Resolves a TZID: as written, then with leading parts removed one '/' at a time.
// Returns the zone name, or null when nothing fits.
function findZone(tzid, cache) {
  if (cache.has(tzid)) return cache.get(tzid);
  let found = null;
  let s = tzid.trim();
  while (s !== '') {
    if (isZone(s)) { found = s; break; }
    const i = s.indexOf('/');
    if (i < 0) break;
    s = s.slice(i + 1);
  }
  cache.set(tzid, found);
  return found;
}

// A DTSTART-like property: { kind: 'date', date } | { kind: 'time', ms, zone, known, wallDate, wallTime } | null.
function readTime(prop, tz, cache) {
  if (!prop || typeof prop.value !== 'string') return null;
  const v = prop.value.trim();
  const params = prop.params || {};
  const valueType = typeof params.VALUE === 'string' ? params.VALUE.toUpperCase() : '';
  if (valueType === 'DATE' || /^\d{8}$/.test(v)) {
    if (!/^\d{8}$/.test(v)) return null;
    const date = dashed(v);
    return isDate(date) ? { kind: 'date', date } : null;
  }
  const m = /^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(v);
  if (!m) return null;
  const date = dashed(m[1]);
  const h = Number(m[2]);
  const mi = Number(m[3]);
  const s = Number(m[4]);
  if (!isDate(date) || h > 23 || mi > 59 || s > 59) return null;
  const wallTime = `${m[2]}:${m[3]}:${m[4]}`;
  if (m[5] !== '') {
    const ms = Date.UTC(Number(m[1].slice(0, 4)), Number(m[1].slice(4, 6)) - 1, Number(m[1].slice(6, 8)), h, mi, s);
    if (Number.isNaN(ms)) return null;
    return { kind: 'time', ms, zone: 'UTC', known: true, wallDate: date, wallTime };
  }
  let zone = tz;
  let known = true;
  if (typeof params.TZID === 'string' && params.TZID.trim() !== '') {
    const z = findZone(params.TZID, cache);
    if (z === null) known = false;
    else zone = z;
  }
  const ms = wallToMs(zone, date, wallTime);
  if (ms === null) return null;
  return { kind: 'time', ms, zone, known, wallDate: date, wallTime };
}

// DURATION text to milliseconds (negative allowed), or null when it cannot be read.
function durationMs(text) {
  if (typeof text !== 'string') return null;
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(text.trim());
  if (!m) return null;
  if (m[2] === undefined && m[3] === undefined && m[4] === undefined && m[5] === undefined && m[6] === undefined) return null;
  const n = (x) => (x === undefined ? 0 : Number(x));
  const ms = (((n(m[2]) * 7 + n(m[3])) * 24 + n(m[4])) * 60 + n(m[5])) * MINUTE + n(m[6]) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function isCancelled(ev) {
  const s = first(ev, 'STATUS');
  return !!s && typeof s.value === 'string' && s.value.trim().toUpperCase() === 'CANCELLED';
}

function isDeclined(ev, self) {
  if (typeof self !== 'string' || self === '') return false;
  const me = `mailto:${self.toLowerCase()}`;
  for (const a of ev.ATTENDEE || []) {
    if (typeof a.value !== 'string' || a.value.trim().toLowerCase() !== me) continue;
    const ps = a.params && a.params.PARTSTAT;
    if (typeof ps === 'string' && ps.trim().toUpperCase() === 'DECLINED') return true;
  }
  return false;
}

// The start and end of a single VEVENT. Timed: { timed: true, startMs, endMs, start }; all-day: { timed: false, from, to, start }.
function occurrenceOf(ev, start, tz, cache) {
  const dtend = readTime(first(ev, 'DTEND'), tz, cache);
  const dur = first(ev, 'DURATION') ? durationMs(first(ev, 'DURATION').value) : null;
  if (start.kind === 'time') {
    let endMs = start.ms;
    if (dtend && dtend.kind === 'time') endMs = dtend.ms;
    else if (dur !== null) endMs = start.ms + dur;
    if (endMs < start.ms) endMs = start.ms;
    return { timed: true, startMs: start.ms, endMs, start };
  }
  let days = 1;
  if (dtend && dtend.kind === 'date') days = diffDays(start.date, dtend.date);
  else if (dur !== null) days = Math.ceil(dur / DAY);
  // An all-day event always covers at least its own day (the spec would read a zero length as covering none).
  if (!Number.isInteger(days) || days < 1) days = 1;
  return { timed: false, from: start.date, to: addDays(start.date, days), start };
}

// Clips a timed occurrence to the board day and formats it, or null when it is not in the day.
function clip(startMs, endMs, win, tz) {
  if (endMs > startMs) {
    if (!(startMs < win.end && endMs > win.start)) return null;
  } else if (!(startMs >= win.start && startMs < win.end)) {
    return null;
  }
  const s = timeAt(tz, Math.max(startMs, win.start));
  const e = endMs >= win.end ? '24:00' : timeAt(tz, endMs);
  return { start: s, end: e };
}

// Adds an occurrence to the output when it falls on the day. Returns true when it shows.
function show(occ, title, ctx, out) {
  if (occ.timed) {
    const c = clip(occ.startMs, occ.endMs, ctx.win, ctx.tz);
    if (!c) return false;
    out.events.push({ title, start: c.start, end: c.end });
    return true;
  }
  if (occ.from <= ctx.date && ctx.date < occ.to) {
    out.allDay.push({ title });
    return true;
  }
  return false;
}

// A UNTIL value: { date } | { ms } | null (unreadable).
function readUntil(text, zone, tz, cache) {
  if (text === null) return undefined;
  const v = text.trim().toUpperCase();
  if (/^\d{8}$/.test(v)) return isDate(dashed(v)) ? { date: v } : null;
  const t = readTime({ params: {}, value: v }, zone, cache);
  if (!t || t.kind !== 'time') return null;
  return { ms: t.ms };
}

// Reads one property list of dates/times (EXDATE, several values per line) into key sets.
function readSets(list, tz, cache) {
  const ms = new Set();
  const dates = new Set();
  const dateOnly = new Set();
  for (const prop of list || []) {
    if (typeof prop.value !== 'string') continue;
    for (const piece of prop.value.split(',')) {
      const t = readTime({ params: prop.params, value: piece }, tz, cache);
      if (!t) continue;
      if (t.kind === 'date') { dates.add(t.date); dateOnly.add(t.date); }
      else { ms.add(t.ms); dates.add(t.wallDate); }
    }
  }
  return { ms, dates, dateOnly };
}

// Occurrences of a worked-out series that touch the board day. Returns { occs, bad }.
function expandSeries(ev, start, rule, ctx, cache) {
  const occs = [];
  const tz = ctx.tz;
  const untilText = rule.until;
  const own = occurrenceOf(ev, start, tz, cache);
  const ex = readSets(ev.EXDATE, tz, cache);
  const rep = ctx.replaced;
  if (start.kind === 'time') {
    const zone = start.zone;
    const until = untilText === null ? undefined : readUntil(untilText, zone, tz, cache);
    if (until === null) return { occs, bad: true };
    const len = own.endMs - own.startMs;
    const back = Math.min(len, MAX_SPAN_DAYS * DAY);
    const firstDate = dateAt(zone, ctx.win.start - back);
    const lastDate = dateAt(zone, ctx.win.end);
    for (let c = firstDate, guard = 0; c !== null && c <= lastDate && guard < 80; c = addDays(c, 1), guard++) {
      const r = occursOn(rule, start.wallDate, c);
      if (r === null) return { occs: [], bad: true };
      if (r !== true) continue;
      const startMs = wallToMs(zone, c, start.wallTime);
      if (startMs === null) return { occs: [], bad: true };
      if (until && until.date !== undefined && compact(c) > until.date) continue;
      if (until && until.ms !== undefined && startMs > until.ms) continue;
      if (ex.ms.has(startMs) || ex.dateOnly.has(c)) continue;
      if (rep.ms.has(startMs) || rep.dateOnly.has(c)) continue;
      occs.push({ timed: true, startMs, endMs: startMs + len });
    }
    return { occs, bad: false };
  }
  const L = diffDays(own.from, own.to);
  const until = untilText === null ? undefined : readUntil(untilText, tz, tz, cache);
  if (until === null) return { occs, bad: true };
  const firstDate = addDays(ctx.date, -(Math.min(L, MAX_SPAN_DAYS) - 1));
  for (let c = firstDate; c !== null && c <= ctx.date; c = addDays(c, 1)) {
    const r = occursOn(rule, start.date, c);
    if (r === null) return { occs: [], bad: true };
    if (r !== true) continue;
    if (until && until.date !== undefined && compact(c) > until.date) continue;
    if (until && until.ms !== undefined) {
      const ms = wallToMs(tz, c, '00:00:00');
      if (ms !== null && ms > until.ms) continue;
    }
    if (ex.dateOnly.has(c) || ex.dates.has(c)) continue;
    if (rep.dates.has(c)) continue;
    occs.push({ timed: false, from: c, to: addDays(c, L) });
  }
  return { occs, bad: false };
}

// One UID group. Returns { events, allDay, skipped, unknownZones }.
function readGroup(group, ctx, cache) {
  const out = { events: [], allDay: [], skipped: 0, unknownZones: 0 };
  const tz = ctx.tz;
  const seriesEv = group.find((e) => !e['RECURRENCE-ID']) || null;
  const changed = group.filter((e) => e['RECURRENCE-ID']);
  const loose = group.filter((e) => e !== seriesEv && !e['RECURRENCE-ID']);
  const isSeries = !!seriesEv && !!seriesEv.RRULE;
  const ranged = changed.filter((e) => {
    const r = e['RECURRENCE-ID'][0].params && e['RECURRENCE-ID'][0].params.RANGE;
    return typeof r === 'string' && r.trim().toUpperCase() === 'THISANDFUTURE';
  });

  // What the changed occurrences replace.
  const replaced = { ms: new Set(), dates: new Set(), dateOnly: new Set() };
  if (isSeries) {
    for (const e of changed) {
      const t = readTime(e['RECURRENCE-ID'][0], tz, cache);
      if (!t) continue;
      if (t.kind === 'date') { replaced.dates.add(t.date); replaced.dateOnly.add(t.date); }
      else { replaced.ms.add(t.ms); replaced.dates.add(t.wallDate); }
    }
  }
  ctx = { ...ctx, replaced };

  // A single VEVENT (plain event, loose duplicate, or a changed occurrence).
  const single = (ev) => {
    if (isCancelled(ev) || isDeclined(ev, ctx.self)) return;
    let bad = false;
    if (ev.RDATE) bad = true;
    const start = readTime(first(ev, 'DTSTART'), tz, cache);
    if (!start) {
      out.skipped += 1;
      return;
    }
    const occ = occurrenceOf(ev, start, tz, cache);
    let sum = first(ev, 'SUMMARY');
    if (!sum && ev['RECURRENCE-ID'] && seriesEv) sum = first(seriesEv, 'SUMMARY');
    const title = cleanTitle(sum ? sum.value : undefined);
    const shown = show(occ, title, ctx, out);
    if (shown && start.kind === 'time' && !start.known) out.unknownZones += 1;
    if (bad) out.skipped += 1;
  };

  // The series itself.
  if (seriesEv && !isSeries) single(seriesEv);
  else if (isSeries && !isCancelled(seriesEv) && !isDeclined(seriesEv, ctx.self)) {
    let bad = false;
    if (seriesEv.RDATE) bad = true;
    const start = readTime(first(seriesEv, 'DTSTART'), tz, cache);
    const rule = seriesEv.RRULE.length === 1 ? parseRule(seriesEv.RRULE[0].value) : null;
    if (!start) {
      bad = true;
    } else if (!rule || rule.unsupported || ranged.length > 0) {
      bad = true;
    } else {
      const { occs, bad: failed } = expandSeries(seriesEv, start, rule, ctx, cache);
      if (failed) bad = true;
      else {
        const title = cleanTitle(first(seriesEv, 'SUMMARY') ? first(seriesEv, 'SUMMARY').value : undefined);
        let shown = false;
        for (const o of occs) if (show(o, title, ctx, out)) shown = true;
        if (shown && start.kind === 'time' && !start.known) out.unknownZones += 1;
      }
    }
    if (bad) out.skipped += 1;
  }
  for (const e of loose) single(e);

  // Changed occurrences.
  for (const e of changed) {
    if (ranged.includes(e)) {
      // With its series in the text the series carries the one count; alone it cannot be worked out.
      if (!isSeries && !isCancelled(e) && !isDeclined(e, ctx.self)) out.skipped += 1;
      continue;
    }
    single(e);
  }
  return out;
}

export function eventsOn(icsText, { date, tz, self = null, maxChars, maxEvents } = {}) {
  const result = { events: [], allDay: [], skipped: 0, unknownZones: 0 };
  try {
    const caps = {};
    if (maxChars !== undefined) caps.maxChars = maxChars;
    if (maxEvents !== undefined) caps.maxEvents = maxEvents;
    const events = readEvents(icsText, caps);
    if (events === null) {
      result.skipped = 1;
      return result;
    }
    if (events.length === 0) return result;
    const winStartIso = instantOf(tz, date, '00:00');
    const winEndIso = isDate(date) ? instantOf(tz, addDays(date, 1), '00:00') : null;
    if (winStartIso === null || winEndIso === null) return result;
    const ctx = {
      date, tz, self: typeof self === 'string' ? self : null,
      win: { start: Date.parse(winStartIso), end: Date.parse(winEndIso) },
    };
    const cache = new Map();
    const groups = new Map();
    const ordered = [];
    for (const ev of events) {
      const uid = first(ev, 'UID');
      const key = uid && typeof uid.value === 'string' && uid.value.trim() !== '' ? uid.value.trim() : null;
      if (key === null) { ordered.push([ev]); continue; }
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); ordered.push(g); }
      g.push(ev);
    }
    for (const group of ordered) {
      try {
        const r = readGroup(group, ctx, cache);
        for (const x of r.events) result.events.push(x);
        for (const x of r.allDay) result.allDay.push(x);
        result.skipped += r.skipped;
        result.unknownZones += r.unknownZones;
      } catch {
        result.skipped += 1;
      }
    }
    return result;
  } catch {
    return { events: [], allDay: [], skipped: 1, unknownZones: 0 };
  }
}
