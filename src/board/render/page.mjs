// The page frame: head, nonce style block, header, capture, footer, and the order of the sections (R86).
// Pure: no clock, no file, no network, no environment. Every outside string is escaped where it is written (R73).
import { esc, githubHref, notionHref } from '../html.mjs';
import { themeCss } from '../theme.mjs';
import { brief, season, focus, timeline } from './top.mjs';
import { calendar, inbox, next, habits } from './mid.mjs';
import { heatmap, projects, log, ideas, standalone } from './low.mjs';

const KEY_RE = /^[a-z0-9-]{1,30}$/;
const HEX_RE = new RegExp('^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$');
const isHex = (v) => typeof v === 'string' && HEX_RE.test(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM-DD' -> 'Mon 12 Oct' (calendar arithmetic only, no clock).
function dateLine(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!m) return String(date || '');
  const wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return `${DAYS[wd]} ${+m[3]} ${MONTHS[+m[2] - 1] || ''}`;
}

// An instant -> 'HH:MM' in the zone; falls back to the instant's own UTC time.
function clock(iso, tz) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  } catch {
    return typeof iso === 'string' ? iso.slice(11, 16) : '';
  }
}

// An instant -> '12 Oct HH:MM' in the zone.
function stamp(iso, tz) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'numeric' }).formatToParts(d);
    const day = p.find((x) => x.type === 'day')?.value;
    const mon = Number(p.find((x) => x.type === 'month')?.value);
    return `${day} ${MONTHS[mon - 1] || ''} ${clock(iso, tz)}`;
  } catch {
    return String(iso || '');
  }
}

const pctNum = (pct) => {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
};

const WARNINGS = {
  'checkin-unreadable': (n) => `${n} habit check-in${n === 1 ? ' has' : 's have'} a title that could not be read and ${n === 1 ? 'was' : 'were'} not counted.`,
  'score-invalid': (n) => `${n} habit score${n === 1 ? '' : 's'} could not be read and ${n === 1 ? 'was' : 'were'} left out.`,
  'items-hidden': (n) => `${n} project item${n === 1 ? ' is' : 's are'} hidden from this token and ${n === 1 ? 'was' : 'were'} not counted.`,
  'row-skipped': (n) => `${n} row${n === 1 ? '' : 's'} of data could not be read and ${n === 1 ? 'was' : 'were'} skipped.`,
  'part-failed': (n) => `${n} part${n === 1 ? '' : 's'} of the board could not be built and ${n === 1 ? 'is' : 'are'} left empty.`,
  'project-missing': (n) => `${n} listed project${n === 1 ? ' was' : 's were'} not found on GitHub.`,
  'project-closed': (n) => `${n} listed project${n === 1 ? ' is' : 's are'} closed and left out.`,
  'milestone-unmatched': (n) => `${n} milestone${n === 1 ? ' does' : 's do'} not match a project title and ${n === 1 ? 'sits' : 'sit'} under Other.`,
  'milestone-crosses-project': (n) => `${n} task${n === 1 ? ' sits' : 's sit'} in a milestone that belongs to another project.`,
  'focus-unknown': (n) => `${n} focus key${n === 1 ? ' does' : 's do'} not match a shown project and ${n === 1 ? 'was' : 'were'} ignored.`,
  'color-invalid': (n) => `${n} colour${n === 1 ? ' was' : 's were'} not a valid hex colour and the default is used.`,
  'setting-invalid': (n) => `${n} setting${n === 1 ? ' was' : 's were'} not valid and the default is used.`,
  'font-invalid': (n) => `${n} font name${n === 1 ? ' was' : 's were'} not valid and the default is used.`,
  'theme-unreadable': () => 'The theme file could not be read and the default look is used.',
  'habit-project-unknown': (n) => `${n} habit${n === 1 ? ' names' : 's name'} a project that is not shown.`,
  'goal-project-unknown': (n) => `${n} season goal${n === 1 ? ' names' : 's name'} a project that is not shown.`,
  'too-much-data': () => 'There was too much data to read in one go, so part of it is missing.',
  'calendar-file-unreadable': () => 'The calendar file from the agent could not be read, so its events are not shown.',
  'calendar-no-login': () => 'The settings name iCloud calendars, but this board was started without an iCloud sign-in, so the calendar is not shown.',
  'calendar-login-refused': () => 'iCloud did not accept the sign-in, so the calendar could not be read. The app-specific password may have been removed.',
  'calendar-unreachable': () => 'iCloud did not answer, so the calendar may be out of date.',
  'calendar-not-found': (n) => (n === 1 ? '1 calendar named in the settings was not found in iCloud.' : `${n} calendars named in the settings were not found in iCloud.`),
  'calendar-event-skipped': (n) => (n === 1 ? '1 calendar event could not be read and is not shown.' : `${n} calendar events could not be read and are not shown.`),
  'calendar-zone-unknown': (n) => (n === 1 ? '1 calendar event names a time zone this board does not know, so its time may be off.' : `${n} calendar events name a time zone this board does not know, so their times may be off.`),
};

// R125: the six Google sentences; `<names>` is each name in straight double quotes, joined by ", ".
const GOOGLE_WARNINGS = {
  'calendar-google-no-address': (s) => `No secret address was set for these Google calendars, so they are not shown: ${s}. Copy the address from Google Calendar and set it where the board starts.`,
  'calendar-google-address-refused': (s) => `The secret address set for these Google calendars is not one the board will use, so they are not shown: ${s}. Copy the address from Google Calendar again.`,
  'calendar-google-address-rejected': (s) => `Google did not accept the secret address for these calendars, so they could not be read: ${s}. The address may have been reset. Copy it from Google Calendar again.`,
  'calendar-google-unreachable': (s) => `Google did not answer for these calendars, so they may be out of date: ${s}.`,
  'calendar-google-not-a-calendar': (s) => `Google sent something that is not a calendar for these calendars, so they could not be read: ${s}. Copy the secret address from Google Calendar again.`,
  'calendar-google-too-large': (s) => `These Google calendars are too large for the board to read, so they are not shown: ${s}.`,
};

// R6: the unreadable-owner sentence; singular for one name, plural for several.
function ownerText(n, s, many) {
  return `${n} listed project${n === 1 ? '' : 's'} of ${s} could not be read with the GitHub token${many ? 's' : ''} for ${many ? 'those owners' : 'that owner'}, so ${n === 1 ? 'it is' : 'they are'} left out.`;
}

export function warningText(w) {
  const code = isObj(w) ? w.code : '';
  if (isObj(w) && code === 'project-owner-unreadable' && Array.isArray(w.names)) {
    const names = w.names.filter((x) => typeof x === 'string');
    const n = Number.isFinite(Number(w.count)) ? Number(w.count) : 1;
    return ownerText(n, names.map((x) => `"${x}"`).join(', '), names.length > 1);
  }
  if (isObj(w) && typeof code === 'string' && Object.hasOwn(GOOGLE_WARNINGS, code) && Array.isArray(w.names)) {
    return GOOGLE_WARNINGS[code](w.names.filter((x) => typeof x === 'string').map((x) => `"${x}"`).join(', '));
  }
  const n = isObj(w) && Number.isFinite(Number(w.count)) ? Number(w.count) : 1;
  const f = typeof code === 'string' && Object.hasOwn(WARNINGS, code) ? WARNINGS[code] : null;
  return f ? f(n) : `Something unexpected was noticed ${n} time${n === 1 ? '' : 's'} while reading the data.`;
}

const SOURCE_NAMES = { github: 'GitHub', notion: 'Notion', calendar: 'Calendar', inbox: 'Email' };

export function renderPage(board, theme, { styleNonce, formToken } = {}) {
  const b = isObj(board) ? board : {};
  const meta = isObj(b.meta) ? b.meta : {};
  const readOnly = meta.readOnly === true;
  const tz = typeof meta.timezone === 'string' ? meta.timezone : 'UTC';
  const projectList = Array.isArray(b.projects) ? b.projects : [];
  const projectByKey = new Map();
  for (const p of projectList) {
    if (isObj(p) && typeof p.key === 'string' && KEY_RE.test(p.key) && !projectByKey.has(p.key)) projectByKey.set(p.key, p);
  }

  const usedX = new Set();
  const usedW = new Set();
  const cls = (set, prefix, pct) => {
    const v = pctNum(pct);
    const name = prefix + '-' + String(v).replace('.', '_');
    set.add(v);
    return name;
  };

  const backend = Array.isArray(meta.sources) && isObj(meta.sources[0]) && meta.sources[0].id === 'notion' ? 'notion' : 'github';
  const href = (url) => {
    const h = githubHref(url) ?? (backend === 'notion' ? notionHref(url) : null);
    return h === null ? null : esc(h);
  };

  const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

  const form = (action, target, fields = {}, label = '', extra = '') => {
    if (readOnly) return '';
    const t = String(target);
    let derived = '';
    if (action === 'habit') {
      const [id = '', date = '', mode = ''] = t.split(':');
      derived = hidden('id', id) + hidden('date', date) + hidden('on', mode === 'on' ? '1' : '0');
    } else if (action === 'sort' || action === 'close') {
      derived = hidden('number', t);
    }
    const own = isObj(fields) ? Object.entries(fields).map(([k, v]) => hidden(k, v)).join('') : '';
    return `<form method="post" action="/actions/${esc(action)}">${hidden('token', formToken(action, t))}${derived}${own}${extra}<button type="submit">${esc(label)}</button></form>`;
  };

  const ui = {
    esc,
    href,
    tag: backend === 'notion' ? 'NT' : 'GH',
    src: (tag) => `<span class="src" data-src="${esc(tag)}">${esc(tag)}</span>`,
    form,
    pc: (key) => (typeof key === 'string' && KEY_RE.test(key) && projectByKey.has(key) ? 'pc-' + key : ''),
    x: (pct) => cls(usedX, 'x', pct),
    w: (pct) => cls(usedW, 'w', pct),
    readOnly,
  };

  // Sections run first so the style block knows every class they registered.
  const call = (fn) => {
    const s = fn(b, ui);
    return typeof s === 'string' ? s : '';
  };
  const row = (name, parts) => {
    const inner = parts.map(call).join('');
    return inner === '' ? '' : `<div class="row row-${name}">${inner}</div>\n`;
  };

  const withBreak = (s) => (s === '' ? '' : s + '\n');
  const body = [
    renderHeader(b, meta, tz),
    readOnly ? '' : renderCapture(ui),
    row('brief', [brief, season]),
    row('focus', [focus, timeline]),
    row('trio', [calendar, inbox, next]),
    // habits is a direct child of the page, no row wrapper
    withBreak(call(habits)),
  ];
  body.push(row('low', [heatmap, projects, log]));
  body.push(row('ideas', [ideas, standalone]));
  body.push(renderFooter(b, meta, tz, ui, readOnly));

  const css = themeCss(theme);
  const rules = [];
  rules.push(':root{' + Object.entries(css.vars).map(([k, v]) => `${k}:${v};`).join('') + '}');
  for (const [key, p] of projectByKey) {
    if (isHex(p.color)) rules.push(`.pc-${key}{--pc:${p.color}}`);
  }
  for (const m of Array.isArray(b.modes) ? b.modes : []) {
    if (isObj(m) && Number.isInteger(m.n) && m.n >= 1 && m.n <= 8 && isHex(m.color)) rules.push(`.mode-${m.n}{--mc:${m.color}}`);
  }
  for (const v of [...usedX].sort((a, c) => a - c)) rules.push(`.x-${String(v).replace('.', '_')}{--x:${v}%}`);
  for (const v of [...usedW].sort((a, c) => a - c)) rules.push(`.w-${String(v).replace('.', '_')}{--w:${v}%}`);

  const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : '';
  const title = name ? `${name} · Howgozit` : 'Howgozit';
  const fontLink = css.fontHref ? `<link rel="stylesheet" href="${esc(css.fontHref)}">\n` : '';

  return '<!doctype html>\n<html lang="en">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${esc(title)}</title>\n`
    + '<link rel="stylesheet" href="/static/board.css">\n'
    + fontLink
    + `<style nonce="${esc(styleNonce)}">\n${rules.join('\n')}\n</style>\n`
    + '</head>\n<body>\n<div class="page">\n'
    + body.join('')
    + '</div>\n<script src="/static/board.js"></script>\n</body>\n</html>\n';
}

function renderHeader(b, meta, tz) {
  const wk = meta.weekNumber !== undefined && meta.weekNumber !== null ? ` · Week ${esc(meta.weekNumber)}` : '';
  const time = clock(meta.generatedAt, tz);
  const date = `${esc(dateLine(meta.today))}${wk}${time ? ' · ' + esc(time) : ''}`;
  const agent = typeof meta.agentName === 'string' && meta.agentName !== '' ? meta.agentName : 'Agent';

  const chips = (Array.isArray(meta.sources) ? meta.sources : []).filter(isObj).map((s) => {
    const id = String(s.id);
    const label = id === 'brief' ? agent : id === 'log' ? `${agent} log` : Object.hasOwn(SOURCE_NAMES, id) ? SOURCE_NAMES[id] : id;
    const state = s.state === 'ok' ? 'ok' : s.state === 'stale' ? 'stale' : 'error';
    const at = s.at ? clock(s.at, tz) : '';
    const text = state === 'ok' ? (at ? `synced ${at}` : 'synced') : state === 'stale' ? 'out of date' : 'error';
    return `<li class="chip"><span class="dot dot--${state}"></span><span class="chip__name">${esc(label)}</span><span class="chip__state">${esc(text)}</span></li>`;
  }).join('');

  let banner = '';
  if (isObj(meta.stale)) {
    banner = `<p class="banner" data-banner role="status"><span class="banner__title">Showing the last good read.</span> <span>${esc(String(meta.stale.reason).replace(/\.+$/, ''))}. Data from ${esc(stamp(meta.stale.since, tz))}.</span></p>`;
  }

  return '<header class="header" data-section="header">\n'
    + `<div class="header__main"><p class="header__date">${date}</p>`
    + `<h1 class="header__title">${esc(meta.greeting)}, <span class="hl">${esc(meta.name)}</span>.</h1></div>\n`
    + `<ul class="sources" aria-label="Sources">${chips}</ul>\n`
    + banner
    + '</header>\n';
}

function renderCapture(ui) {
  const extra = '<label class="sr-only" for="idea-title">Log an idea</label>'
    + `<input id="idea-title" type="text" name="title" maxlength="200" required placeholder="Log an idea. It becomes a ${ui.tag === 'NT' ? 'Notion row' : 'GitHub issue'}.">`;
  return '<section class="capture" data-section="capture">\n'
    + ui.form('idea', 'new', {}, 'Log idea', extra)
    + '\n<p data-message></p>\n</section>\n';
}

function renderFooter(b, meta, tz, ui, readOnly) {
  const warns = (Array.isArray(meta.warnings) ? meta.warnings : []).filter(isObj);
  const gh = (Array.isArray(meta.sources) ? meta.sources : []).find((s) => isObj(s) && (s.id === 'github' || s.id === 'notion'));
  const when = clock((gh && gh.at) || meta.generatedAt, tz);
  const link = ui.href(meta.repoUrl);
  const repoName = ui.tag === 'NT' ? 'Notion' : 'Data repo';
  const repo = link === null ? repoName : `<a href="${link}">${repoName}</a>`;
  return '<footer class="footer" data-section="footer">\n'
    + (readOnly ? '<p>Read-only: changes are switched off.</p>\n' : '')
    + (warns.length ? `<ul class="warnings">${warns.map((w) => `<li>${esc(warningText(w))}</li>`).join('')}</ul>\n` : '')
    + `<p class="footer__time">Data from ${esc(when)} · ${esc(tz)} · ${repo}</p>\n`
    + '</footer>\n';
}

export function renderNotice({ title, message, status } = {}) {
  void status;
  return '<!doctype html>\n<html lang="en">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${esc(title)}</title>\n`
    + '<link rel="stylesheet" href="/static/board.css">\n'
    + '</head>\n<body>\n'
    + `<main class="notice"><h1>${esc(title)}</h1><p>${esc(message)}</p></main>\n`
    + '</body>\n</html>\n';
}
