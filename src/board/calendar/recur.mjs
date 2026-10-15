// Repeat rules (RRULE). Pure: no clock, no file, no network, no environment. Never throws on bad input.
// Day arithmetic runs on whole numbers (days since 1970-01-01), not on a Date per step.
import { isDate } from '../days.mjs';

const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const NOT_WORKED_OUT = ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'];
const KNOWN = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'];
const WHOLE_RE = /^[+-]?\d+$/;
const BYDAY_RE = /^([+-]?\d+)?([A-Z]{2})$/;
const COUNT_WALK_LIMIT = 3700;

// Days since 1970-01-01 of a proleptic Gregorian date.
function dayNumber(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// [year, month, day] of a day number.
function civil(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const mod = (a, b) => ((a % b) + b) % b;

// Weekday index, Monday = 0. 1970-01-01 was a Thursday.
const weekdayOf = (n) => mod(n + 3, 7);

function toDayNumber(date) {
  if (!isDate(date)) return null;
  const p = date.split('-');
  return dayNumber(Number(p[0]), Number(p[1]), Number(p[2]));
}

function whole(v) {
  return typeof v === 'string' && WHOLE_RE.test(v) ? Number(v) : null;
}

function list(v) {
  return v === '' ? [] : v.split(',');
}

export function parseRule(text) {
  try {
    if (typeof text !== 'string') return null;
    const rule = {
      freq: null,
      interval: 1,
      count: null,
      until: null,
      byDay: [],
      byMonthDay: [],
      byMonth: [],
      wkst: 'MO',
      unsupported: false,
    };
    for (const part of text.split(';')) {
      if (part.trim() === '') continue;
      const eq = part.indexOf('=');
      if (eq < 0) return null;
      const name = part.slice(0, eq).trim().toUpperCase();
      const value = part.slice(eq + 1).trim().toUpperCase();
      if (name === 'FREQ') {
        if (value === '') return null;
        rule.freq = value;
        if (!FREQS.includes(value)) rule.unsupported = true;
      } else if (name === 'INTERVAL') {
        const n = whole(value);
        if (n === null) return null;
        if (n < 1) rule.unsupported = true;
        else rule.interval = n;
      } else if (name === 'COUNT') {
        const n = whole(value);
        if (n === null) return null;
        if (n < 1) rule.unsupported = true;
        else rule.count = n;
      } else if (name === 'UNTIL') {
        if (value === '') return null;
        rule.until = value;
      } else if (name === 'WKST') {
        if (!DAYS.includes(value)) return null;
        rule.wkst = value;
      } else if (name === 'BYDAY') {
        rule.byDay = [];
        for (const item of list(value)) {
          const m = BYDAY_RE.exec(item.trim());
          if (!m || !DAYS.includes(m[2])) return null;
          let nth = null;
          if (m[1] !== undefined) {
            nth = whole(m[1]);
            if (nth === null) return null;
            if (nth === 0 || Math.abs(nth) > 53) rule.unsupported = true;
          }
          rule.byDay.push({ day: m[2], nth });
        }
      } else if (name === 'BYMONTHDAY') {
        rule.byMonthDay = [];
        for (const item of list(value)) {
          const n = whole(item.trim());
          if (n === null) return null;
          if (n === 0 || n < -31 || n > 31) rule.unsupported = true;
          else rule.byMonthDay.push(n);
        }
      } else if (name === 'BYMONTH') {
        rule.byMonth = [];
        for (const item of list(value)) {
          const n = whole(item.trim());
          if (n === null) return null;
          if (n < 1 || n > 12) rule.unsupported = true;
          else rule.byMonth.push(n);
        }
      } else if (NOT_WORKED_OUT.includes(name) || !KNOWN.includes(name)) {
        rule.unsupported = true;
      }
    }
    if (rule.freq === null) return null;
    const f = rule.freq;
    if ((f === 'DAILY' || f === 'WEEKLY') && (rule.byMonthDay.length > 0 || rule.byDay.some((e) => e.nth !== null))) {
      rule.unsupported = true;
    }
    if (f === 'YEARLY' && rule.byMonth.length === 0 && (rule.byDay.length > 0 || rule.byMonthDay.length > 0)) {
      rule.unsupported = true;
    }
    return rule;
  } catch {
    return null;
  }
}

// Does day number n match the pattern (ignoring count)? s holds the start's precomputed facts.
function matches(rule, s, n) {
  if (n < s.n) return false;
  if (n === s.n) return true;
  const wd = weekdayOf(n);
  const f = rule.freq;
  if (f === 'DAILY') {
    if ((n - s.n) % rule.interval !== 0) return false;
    if (rule.byDay.length > 0 && !rule.byDay.some((e) => e.day === DAYS[wd])) return false;
    if (rule.byMonth.length > 0 && !rule.byMonth.includes(civil(n)[1])) return false;
    return true;
  }
  if (f === 'WEEKLY') {
    const weekStart = n - mod(wd - s.wkst, 7);
    if (((weekStart - s.weekStart) / 7) % rule.interval !== 0) return false;
    if (rule.byDay.length > 0) {
      if (!rule.byDay.some((e) => e.day === DAYS[wd])) return false;
    } else if (wd !== s.wd) return false;
    if (rule.byMonth.length > 0 && !rule.byMonth.includes(civil(n)[1])) return false;
    return true;
  }
  // MONTHLY or YEARLY
  const [y, m, d] = civil(n);
  if (f === 'MONTHLY') {
    if ((y * 12 + m - (s.y * 12 + s.m)) % rule.interval !== 0) return false;
    if (rule.byMonth.length > 0 && !rule.byMonth.includes(m)) return false;
  } else {
    if ((y - s.y) % rule.interval !== 0) return false;
    if (rule.byMonth.length > 0 ? !rule.byMonth.includes(m) : m !== s.m) return false;
  }
  const dim = daysInMonth(y, m);
  if (rule.byMonthDay.length > 0 && !rule.byMonthDay.some((v) => (v > 0 ? v === d : dim + 1 + v === d))) return false;
  if (rule.byDay.length > 0) {
    const fromStart = Math.ceil(d / 7);
    const fromEnd = -Math.ceil((dim - d + 1) / 7);
    const ok = rule.byDay.some(
      (e) => e.day === DAYS[wd] && (e.nth === null || e.nth === fromStart || e.nth === fromEnd),
    );
    if (!ok) return false;
  }
  if (rule.byMonthDay.length === 0 && rule.byDay.length === 0 && d !== s.d) return false;
  return true;
}

export function occursOn(rule, startDate, date) {
  try {
    if (rule === null || typeof rule !== 'object' || rule.unsupported === true) return null;
    if (!FREQS.includes(rule.freq)) return null;
    if (!Number.isInteger(rule.interval) || rule.interval < 1) return null;
    if (!Array.isArray(rule.byDay) || !Array.isArray(rule.byMonthDay) || !Array.isArray(rule.byMonth)) return null;
    const sn = toDayNumber(startDate);
    const dn = toDayNumber(date);
    if (sn === null || dn === null) return null;
    if (dn < sn) return false;
    if (dn === sn) return true;
    const [y, m, d] = civil(sn);
    const wd = weekdayOf(sn);
    const wkstIdx = DAYS.indexOf(rule.wkst);
    const wkst = wkstIdx < 0 ? 0 : wkstIdx;
    const s = { n: sn, y, m, d, wd, wkst, weekStart: sn - mod(wd - wkst, 7) };
    const count = rule.count;
    if (count === null || count === undefined) return matches(rule, s, dn);
    if (!Number.isInteger(count) || count < 1) return null;
    if (dn - sn > COUNT_WALK_LIMIT) return null;
    let used = 1;
    if (used >= count) return false;
    for (let n = sn + 1; n <= dn; n++) {
      if (matches(rule, s, n)) {
        used++;
        if (n === dn) return used <= count;
        if (used >= count) return false;
      }
    }
    return false;
  } catch {
    return null;
  }
}
