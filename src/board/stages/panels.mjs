// Panels (contract R49 to R52): the four agent-written panels, switched on by their state file.
// Pure: no clock, no file, no network, no environment. Dates and times only through ../days.mjs.
import { dateIn, timeIn, isDate } from '../days.mjs';
import { checkState } from '../shape-data.mjs';

const MAX_LINES = 5;
const MAX_TEXT = 200;
const MAX_EVENTS = 30;
const MAX_ALL_DAY = 10;
const MAX_THREADS = 30;
const MAX_LOG = 10;
const DAY_MS = 86400000;
const ELLIPSIS = '…';
const BUCKETS = ['reply', 'decide', 'fyi'];
// The known kinds of R51; any other kind reads as `meeting`.
const KINDS = ['meeting', 'focus', 'personal', 'habit'];

const UNREADABLE = () => ({ error: 'unreadable' });

function cut(text) {
  const chars = Array.from(text);
  if (chars.length <= MAX_TEXT) return text;
  return chars.slice(0, MAX_TEXT - 1).join('') + ELLIPSIS;
}

// One place for the 24-hour rule (R52): true when `updated` is more than 24 hours before `now`.
function olderThanDay(updated, now) {
  if (typeof updated !== 'string' || typeof now !== 'string') return false;
  const u = Date.parse(updated);
  const n = Date.parse(now);
  if (Number.isNaN(u) || Number.isNaN(n)) return false;
  return n - u > DAY_MS;
}

export function proposalsStale(ctx) {
  const p = ctx?.state?.proposals;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return false;
  return olderThanDay(p.updated, ctx.now);
}

function thread(t, colours) {
  const out = { bucket: t.bucket, from: t.from, subject: t.subject, why: t.why };
  if (t.draft !== undefined) out.draft = t.draft;
  const account = accountWord(t.account);
  if (account !== null) {
    out.account = account;
    if (Object.hasOwn(colours, account)) out.colour = colours[account];
  }
  return out;
}

const MBX_COLOURS = ['green', 'amber', 'orange', 'charcoal', 'blue', 'purple', 'red', 'grey'];

// R164: the settings map keyed by R117-cleaned label; unknown colours and unusable labels are left out.
function mailboxColours(m) {
  const out = Object.create(null);
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return out;
  for (const [k, v] of Object.entries(m)) {
    const key = accountWord(k);
    if (key !== null && typeof v === 'string' && MBX_COLOURS.includes(v) && !Object.hasOwn(out, key)) out[key] = v;
  }
  return out;
}

// The mailbox label of a thread (R117): cleaned, cut at 20 characters; absent, not text, empty or holding an @ is null.
export function accountWord(label) {
  if (typeof label !== 'string') return null;
  const out = cleanWord(label);
  if (out === '' || out.includes('@')) return null;
  return Array.from(out).slice(0, WORD_MAX).join('');
}

const BUILDERS = {
  brief(v, ctx) {
    const generated = timeIn(ctx.tz, v.generated);
    if (generated === null) return null;
    const day = dateIn(ctx.tz, v.generated);
    return {
      stale: day !== ctx.today,
      generated,
      lines: v.lines.slice(0, MAX_LINES).map((l) => ({ src: l.src, text: cut(l.text) })),
    };
  },
  calendar(v, ctx) {
    const now = timeIn(ctx.tz, ctx.now);
    if (now === null) return null;
    const panel = {
      stale: v.date !== ctx.today || v.stale === true,
      date: v.date,
      now,
      events: v.events.slice(0, MAX_EVENTS).map((e) => ({
        title: e.title, start: e.start, end: e.end, kind: KINDS.includes(e.kind) ? e.kind : 'meeting',
      })),
    };
    if (Array.isArray(v.allDay) && v.allDay.length > 0) {
      panel.allDay = v.allDay.slice(0, MAX_ALL_DAY).map((a) => ({ title: cut(a.title) }));
    }
    return panel;
  },
  inbox(v, ctx) {
    return {
      stale: olderThanDay(v.updated, ctx.now),
      counts: v.counts,
      threads: v.threads.filter((t) => BUCKETS.includes(t.bucket)).slice(0, MAX_THREADS).map((t) => thread(t, mailboxColours(ctx.settings?.mailboxes))),
    };
  },
  log(v) {
    return {
      stale: false,
      entries: v.slice(0, MAX_LOG).map((e) => ({ t: e.t, agent: e.agent, what: e.what })),
    };
  },
};

// ---- the calendar from iCloud and the agent's file together (R109 to R115) ---------------------------------
const FILE_WORD = 'File';
const ICLOUD_WORD_DEFAULT = 'iCloud';
const GOOGLE_WORD = 'Google'; // R127: the word for the events the board read itself, when the source is Google
const WORD_MAX = 20;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A source that cannot be shown: broken, not an object, or out of shape (R50, R113).
function sourceFails(v) {
  if (!isObj(v) || Object.prototype.hasOwnProperty.call(v, 'error')) return true;
  return !checkState('calendar', v).ok;
}

// The file's label as one word (R112): escapes undone, control characters removed, whitespace collapsed, cut at 20.
function fileWord(file) {
  const label = file.source;
  if (typeof label !== 'string') return FILE_WORD;
  let out = '';
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    if (ch === '\\' && i + 1 < label.length) {
      const nx = label[i + 1];
      if (nx === 'n' || nx === 'N') { out += ' '; i++; continue; }
      if (nx === ',' || nx === ';' || nx === '\\') { out += nx; i++; continue; }
    }
    out += ch;
  }
  out = cleanWord(out);
  if (out === '') return FILE_WORD;
  return Array.from(out).slice(0, WORD_MAX).join('');
}

// Control characters removed, whitespace collapsed, trimmed (shared by R112 and R117).
function cleanWord(text) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
}

const eventOf = (e, source) => ({
  title: e.title, start: e.start, end: e.end, kind: KINDS.includes(e.kind) ? e.kind : 'meeting', source,
});

function isMerged(ctx) {
  const c = ctx.settings?.calendar;
  return isObj(c) && c.includeFile === true && Array.isArray(c.calendars) && c.calendars.length > 0
    && ctx.state?.calendarFile !== undefined && ctx.state.calendarFile !== null;
}

function mergedCalendar(ctx) {
  const now = timeIn(ctx.tz, ctx.now);
  if (now === null) return null;
  const ice = ctx.state.calendar;
  const file = ctx.state.calendarFile;
  const isGoogle = ctx.settings?.calendar?.source === 'google';
  const ICLOUD_WORD = isGoogle ? GOOGLE_WORD : ICLOUD_WORD_DEFAULT;
  const iceFails = sourceFails(ice);
  const fileFails = sourceFails(file);
  if (fileFails) ctx.warn('calendar-file-unreadable');
  if (iceFails && fileFails) return { error: 'unreadable', from: isGoogle ? 'google' : 'icloud' };

  const word = fileFails ? FILE_WORD : fileWord(file);
  let events = [];
  let allDay = [];
  if (!iceFails) {
    events = events.concat(ice.events.map((e) => eventOf(e, ICLOUD_WORD)));
    if (Array.isArray(ice.allDay)) allDay = allDay.concat(ice.allDay.map((a) => ({ title: cut(a.title), source: ICLOUD_WORD })));
  }
  if (!fileFails) {
    events = events.concat(file.events.slice(0, MAX_EVENTS).map((e) => eventOf(e, word)));
    if (Array.isArray(file.allDay)) allDay = allDay.concat(file.allDay.slice(0, MAX_ALL_DAY).map((a) => ({ title: cut(a.title), source: word })));
  }
  // Array.prototype.sort is stable: equal entries keep iCloud first, then their order in their own source (R111).
  events.sort((a, b) => byText(a.start, b.start) || byText(a.end, b.end) || byText(a.title, b.title));
  allDay.sort((a, b) => byText(a.title, b.title));

  const panel = {
    stale: iceFails || fileFails || ice.stale === true,
    date: ctx.today,
    now,
    events: events.slice(0, MAX_EVENTS),
    merged: true,
  };
  if (allDay.length > 0) panel.allDay = allDay.slice(0, MAX_ALL_DAY);
  if (!fileFails && isDate(file.date) && file.date < ctx.today) {
    panel.fileDate = file.date;
    panel.fileSource = word;
  }
  return panel;
}

function one(name, ctx) {
  if (name === 'calendar' && isMerged(ctx)) {
    try {
      return mergedCalendar(ctx) ?? UNREADABLE();
    } catch {
      return UNREADABLE();
    }
  }
  const value = ctx.state?.[name];
  if (value === null || value === undefined) return null; // R49
  try {
    if (typeof value === 'object' && !Array.isArray(value) && value.error === 'unreadable') {
      if (name === 'calendar' && (value.from === 'icloud' || value.from === 'google') && Object.keys(value).length === 2) return { error: 'unreadable', from: value.from };
      return UNREADABLE(); // R50
    }
    if (!checkState(name, value).ok) return UNREADABLE();
    return BUILDERS[name](value, ctx) ?? UNREADABLE();
  } catch {
    return UNREADABLE();
  }
}

export default function panels(ctx) {
  return {
    panels: {
      brief: one('brief', ctx),
      calendar: one('calendar', ctx),
      inbox: one('inbox', ctx),
      log: one('log', ctx),
    },
  };
}
