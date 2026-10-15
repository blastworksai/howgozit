// Date helpers. Pure: no clock, no file, no network, no environment.
// A calendar date is a 'YYYY-MM-DD' string; an instant is an ISO string with Z or an offset (or a Date).
// Bad input never throws: every helper returns null (isDate and isZone return false).
// Day arithmetic runs on UTC noon; "which day or time is it there" runs through Intl with an explicit zone.

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

export function isDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function noon(date) {
  if (!isDate(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(2000, 0, 1, 12));
  t.setUTCFullYear(y, m - 1, d);
  return t;
}

function fromNoon(t) {
  const y = t.getUTCFullYear();
  if (!(y >= 1 && y <= 9999)) return null;
  return `${pad(y, 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// An instant as a Date, or null when it cannot be read.
function toInstant(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !INSTANT_RE.test(v)) return null;
  if (!isDate(v.slice(0, 10))) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

// Zone names are checked once: the answer is kept per name. Hostile input cannot grow the map without bound.
const ZONE_CACHE_MAX = 300;
const zoneAnswers = new Map();
export function isZone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  const kept = zoneAnswers.get(tz);
  if (kept !== undefined) return kept;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  if (zoneAnswers.size >= ZONE_CACHE_MAX) zoneAnswers.clear();
  zoneAnswers.set(tz, ok);
  return ok;
}

// One formatter per zone (bounded like zoneAnswers); only called for a name that passed isZone.
const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    if (formatters.size >= ZONE_CACHE_MAX) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

function partsOf(tz, t) {
  const p = {};
  for (const part of formatterFor(tz).formatToParts(t)) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return { year: p.year, month: p.month, day: p.day, hour, minute: p.minute };
}

function wallParts(tz, instant) {
  if (!isZone(tz)) return null;
  const t = toInstant(instant);
  if (!t) return null;
  return partsOf(tz, t);
}

export function dateIn(tz, iso) {
  const p = wallParts(tz, iso);
  return p ? `${pad(p.year, 4)}-${p.month}-${p.day}` : null;
}

export function todayIn(tz, now) {
  return dateIn(tz, now);
}

export function timeIn(tz, now) {
  const p = wallParts(tz, now);
  return p ? `${p.hour}:${p.minute}` : null;
}

export function utcDate(iso) {
  const t = toInstant(iso);
  return t ? fromNoon(t) : null;
}

export function addDays(date, n) {
  const t = noon(date);
  if (!t || !Number.isInteger(n)) return null;
  t.setUTCDate(t.getUTCDate() + n);
  return fromNoon(t);
}

// Clamps to the last day of the target month: addMonths('2026-10-31', 1) is '2026-11-30'.
export function addMonths(date, n) {
  if (!isDate(date) || !Number.isInteger(n)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12 + 12) % 12 + 1;
  if (ny < 1 || ny > 9999) return null;
  return `${pad(ny, 4)}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

// b minus a, in whole days.
export function diffDays(a, b) {
  const ta = noon(a);
  const tb = noon(b);
  if (!ta || !tb) return null;
  return Math.round((tb.getTime() - ta.getTime()) / DAY_MS);
}

export function monthStart(date) {
  return isDate(date) ? `${date.slice(0, 7)}-01` : null;
}

export function monthEnd(date) {
  if (!isDate(date)) return null;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return `${date.slice(0, 7)}-${pad(daysInMonth(y, m))}`;
}

// The date of the first day of the week holding `date`; `first` is 'monday' or 'sunday', anything else gives null.
export function weekStart(date, first) {
  const t = noon(date);
  if (!t || (first !== 'monday' && first !== 'sunday')) return null;
  const dow = t.getUTCDay();
  const back = first === 'monday' ? (dow + 6) % 7 : dow;
  return addDays(date, -back);
}

// ISO 8601 week number (weeks start on Monday; week 1 holds the year's first Thursday).
export function isoWeek(date) {
  const t = noon(date);
  if (!t) return null;
  const thursday = addDays(date, 3 - ((t.getUTCDay() + 6) % 7));
  if (!thursday) return null;
  const jan1 = `${thursday.slice(0, 4)}-01-01`;
  return Math.floor(diffDays(jan1, thursday) / 7) + 1;
}

const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

// Offset of zone `tz` at epoch ms `ms`, in ms (wall clock read as UTC, minus the instant), to the whole minute.
function offsetAt(tz, ms) {
  const m = Math.floor(ms / 60000) * 60000;
  const p = partsOf(tz, new Date(m));
  const wall = new Date(Date.UTC(2000, 0, 1, Number(p.hour), Number(p.minute)));
  wall.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
  return wall.getTime() - m;
}

// The instant at which the wall clock in `tz` reads `date` and `time` ('HH:MM' or 'HH:MM:SS'; 24:00 is the next midnight).
// Twice-happening wall time gives the earlier instant; a skipped one gives the instant that many minutes after the gap began.
// Pure; never throws; bad input gives null.
export function instantOf(tz, date, time) {
  try {
    if (!isZone(tz) || !isDate(date) || typeof time !== 'string') return null;
    const m = TIME_RE.exec(time);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    const s = m[3] === undefined ? 0 : Number(m[3]);
    if (mi > 59 || s > 59 || h > 24 || (h === 24 && (mi !== 0 || s !== 0))) return null;
    const base = noon(date);
    if (!base) return null;
    const wall = base.getTime() - 12 * 3600000 + ((h * 60 + mi) * 60 + s) * 1000;
    const before = offsetAt(tz, wall - DAY_MS);
    const after = offsetAt(tz, wall + DAY_MS);
    if (before === null || after === null) return null;
    let best = null;
    for (const o of new Set([before, after])) {
      const t = wall - o;
      if (offsetAt(tz, t) === o && (best === null || t < best)) best = t;
    }
    if (best === null) best = wall - before;
    const d = new Date(best);
    if (Number.isNaN(d.getTime())) return null;
    const iso = d.toISOString();
    return /^\d{4}-/.test(iso) ? iso : null;
  } catch {
    return null;
  }
}
