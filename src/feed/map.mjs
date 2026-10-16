// The Glitch feed's mapping core (R157, R158): turns the parsed triage answer of each mailbox into the board's
// inbox document. Pure: no clock, no file, no network. Only five fields of an item are ever read, and every
// string that travels is cleaned and scrubbed so no address and no link reaches the board.
import { accountWord } from '../board/stages/panels.mjs';

const MAX_TEXT = 200;
const MAX_THREADS = 30;
const MAX_BYTES = 256 * 1024;

// A run of characters that are not space, bracket or quote; one holding an @ is an address (R157).
const ADDRESS = /[^\s<>()[\]"']*@[^\s<>()[\]"']*/g;
const LINK = /(?:https?:\/\/|www\.)\S*|\S*:\/\/\S*/gi;
const EMPTY_PAIRS = /<\s*>|\(\s*\)|\[\s*\]|"\s*"|'\s*'/g;
const STRAY_ENDS = /^[\s<>"']+|[\s<>"']+$/g;

// R157 clean: control characters become spaces, whitespace is collapsed, the text is trimmed; not text gives ''.
export function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Whatever still looks like an address or a link after the cap is removed run by run.
const LEFTOVER = /\S*(?:@|:\/\/|http|www\.)\S*/gi;
const SCRUB_ROUNDS = 8;

// R157 scrub: addresses, empty pairs and links out, repeated until the text stops changing, because a removal can
// join the pieces around it into a new address or link (htt<x@y.test>ps://...); then stray <>"' at both ends.
export function scrubText(s) {
  let out = cleanText(s);
  let settled = false;
  for (let i = 0; i < SCRUB_ROUNDS && !settled; i++) {
    const next = out.replace(ADDRESS, '').replace(EMPTY_PAIRS, '').replace(LINK, '').replace(/\s+/g, ' ').trim();
    settled = next === out;
    out = next;
  }
  if (!settled) out = out.replace(LEFTOVER, '').replace(/\s+/g, ' ').trim();
  return out.replace(STRAY_ENDS, '');
}

// Cut at 200 characters (code points, like the board), then drop the space a cut may leave.
function cut(s) {
  return Array.from(s).slice(0, MAX_TEXT).join('').trimEnd();
}

const RULE_WORDS = new Map([
  ['watch_important', 'You marked this sender important'],
  ['live_issue', 'You marked this as a live issue'],
  ['allow', 'You allow this sender'],
]);

// R158 why: exact names get fixed sentences; anything else is quoted as a scrubbed rule.
function whyOf(disposition) {
  if (typeof disposition !== 'string' || disposition.trim() === '') return 'No rule for this sender yet';
  const named = RULE_WORDS.get(disposition);
  if (named !== undefined) return named;
  return cut(scrubText('Rule: ' + cleanText(disposition.replace(/_/g, ' '))));
}

const ISO = /^(\d{4}-\d\d-\d\d)(?:[T ](\d\d:\d\d)(?::(\d\d)(?:[.,](\d+))?)?(Z|[+-]\d\d(?::?\d\d)?)?)?$/i;

// R158 date: ISO 8601, no offset reads as UTC, anything else sorts as 1970-01-01T00:00Z.
function instant(raw) {
  if (typeof raw !== 'string') return 0;
  const m = ISO.exec(raw.trim());
  if (m === null) return 0;
  const [, day, hm, sec = '00', frac = '0', zone = 'Z'] = m;
  let z = zone.toUpperCase();
  if (z !== 'Z') {
    const d = z.slice(1).replace(':', '');
    z = z[0] + d.slice(0, 2) + ':' + (d.slice(2) || '00');
  }
  const t = Date.parse(`${day}T${hm ?? '00:00'}:${sec}.${frac.slice(0, 3).padEnd(3, '0')}${z}`);
  return Number.isNaN(t) ? 0 : t;
}

function thread(item, account) {
  const out = {
    bucket: item.automated === true ? 'fyi' : 'reply',
    from: cut(scrubText(item.display_name)) || '(unknown sender)',
    subject: cut(scrubText(item.subject)) || '(no subject)',
    why: whyOf(item.disposition),
  };
  if (account !== null) out.account = account;
  return out;
}

// The wall-clock parts of `now` in an IANA zone, and that zone's offset at that instant, in minutes.
function zoned(now, timeZone = 'UTC') {
  const parts = {};
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const p of f.formatToParts(now)) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return { parts, offset: Math.round((asUtc - Math.floor(now.getTime() / 1000) * 1000) / 60000) };
}

// R158 updated: ISO 8601 with seconds and the zone's offset, no milliseconds.
function stamp(now, timeZone) {
  const { parts: p, offset } = zoned(now, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

// R157, R158: accounts are in config order; only an answer with status ok contributes.
export function buildInbox(now, accounts, opts = {}) {
  const ranked = [];
  for (const acct of Array.isArray(accounts) ? accounts : []) {
    const triage = acct?.triage;
    if (triage === null || typeof triage !== 'object' || triage.status !== 'ok' || !Array.isArray(triage.surface)) continue;
    const account = accountWord(acct.label);
    for (const item of triage.surface) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      ranked.push({ at: instant(item.date), order: ranked.length, t: thread(item, account) });
    }
  }
  ranked.sort((a, b) => b.at - a.at || a.order - b.order);
  const threads = ranked.slice(0, MAX_THREADS).map((r) => r.t);
  const counts = { reply: 0, decide: 0, fyi: 0 };
  for (const t of threads) counts[t.bucket] += 1;
  return { updated: stamp(now, opts?.timeZone), counts, threads };
}

// R158: JSON indented by 2 plus one newline; 256 KB (UTF-8 bytes) or more is refused.
export function dump(doc) {
  const text = JSON.stringify(doc, null, 2) + '\n';
  if (Buffer.byteLength(text, 'utf8') >= MAX_BYTES) throw new RangeError('the inbox document is 256 KB or more');
  return text;
}

// The log line the writer adds when the inbox changed.
export function logEntry(now, threadCount, opts = {}) {
  const { parts } = zoned(now, opts?.timeZone);
  return { t: `${parts.hour}:${parts.minute}`, agent: 'Glitch', what: `Updated inbox (${threadCount} threads)` };
}
