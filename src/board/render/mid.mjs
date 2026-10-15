// Middle row sections: calendar, inbox, next, habits. Pure: (board, ui) -> string.

import { layoutDay, clockMinutes } from './cal-layout.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const FLAME_PATH = 'M12 2.5c.6 3.2 3.4 4.9 4.9 7.6 1.6 2.9 1.2 6.6-1.3 8.8-2.1 1.9-5.4 2.1-7.6.5-2.6-1.8-3.4-5.4-1.9-8.2.5 1.4 1.4 2.4 2.6 2.7-.9-3.9.6-8.6 3.3-11.4z';

const STALE_BADGE = '<span class="badge badge--stale">Out of date</span>';

function shortDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return String(d || '');
  return String(Number(m[3])) + ' ' + (MONTHS[Number(m[2]) - 1] || m[2]);
}

function pct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function errorCard(ui, name, title, tag, file, from) {
  return '<section class="card" data-section="' + name + '">'
    + '<div class="card__head"><h2 class="card__title">' + title + '</h2>'
    + '<span class="card__meta">' + ui.src(tag) + '</span></div>'
    + '<p class="panel-error">' + (from === 'icloud' || from === 'google'
      ? 'The calendar could not be read from ' + (from === 'google' ? 'Google' : 'iCloud') + '. See the note at the foot of the page.'
      : 'This file could not be read. Check state/' + file + '.json in the data repo.') + '</p>'
    + '</section>';
}

// R112: the word that says where an entry came from, only on a merged panel; escaped, never a link.
function sourceTag(ui, x) {
  return x && typeof x.source === 'string' ? '<span class="cal-source" data-source>' + ui.esc(x.source) + '</span>' : '';
}

export function calendar(board, ui) {
  const p = board && board.panels ? board.panels.calendar : null;
  if (!p) return '';
  if (p.error) return errorCard(ui, 'calendar', 'Today', 'CAL', 'calendar', p.from);
  const events = Array.isArray(p.events) ? p.events : [];
  const stale = p.stale === true;
  const allDay = Array.isArray(p.allDay) ? p.allDay : [];
  const allDayLine = allDay.length
    ? '<p class="cal-allday" data-allday><span class="cal-allday-label">All day</span> '
      + allDay.map((a) => ui.esc(a && a.title) + sourceTag(ui, a)).join(' \u00b7 ') + '</p>'
    : '';
  let body;
  if (events.length === 0) {
    body = '<p class="empty">No events today.</p>';
  } else {
    const lay = layoutDay(events);
    const base = lay.startHour * 60;
    const span = (lay.endHour - lay.startHour) * 60;
    let hours = '';
    for (let h = lay.startHour; h < lay.endHour; h++) hours += '<span>' + String(h).padStart(2, '0') + '</span>';
    let evs = '';
    events.forEach((e, i) => {
      const it = lay.items[i];
      const kind = ['meeting', 'focus', 'personal', 'habit'].includes(e.kind) ? e.kind : 'meeting';
      const cls = 'cal-event cal-event--' + kind
        + (it.short ? ' cal-event--short' : '')
        + (it.lanes > 1 ? ' cal-lane-' + it.lane + 'of' + it.lanes : '');
      evs += '<div class="' + cls + ' ' + ui.x(pct(it.top)) + ' ' + ui.w(pct(it.height)) + '">'
        + '<span class="cal-event__title">' + ui.esc(e.title) + '</span>' + sourceTag(ui, e)
        + '<span class="cal-event__time">' + ui.esc(e.start) + '–' + ui.esc(e.end) + '</span></div>';
    });
    let now = '';
    const nm = clockMinutes(p.now);
    if (!stale && p.date === board.meta.today && nm !== null && nm >= base && nm <= base + span) {
      now = '<div class="cal-now ' + ui.x(pct((nm - base) / span * 100)) + '" role="img" aria-label="Now, ' + ui.esc(p.now) + '"></div>';
    }
    body = '<div class="cal"><div class="cal-hours" aria-hidden="true">' + hours + '</div>'
      + '<div class="cal-body">' + evs + now + '</div></div>';
  }
  // R114: a file from an earlier day says so.
  const fileNote = typeof p.fileDate === 'string'
    ? '<p class="cal-filedate" data-filedate>' + ui.esc((typeof p.fileSource === 'string' ? p.fileSource : 'File') + ' events are from ' + p.fileDate + '.') + '</p>'
    : '';
  return '<section class="card" data-section="calendar"' + (stale ? ' data-stale="true"' : '') + '>'
    + '<div class="card__head"><h2 class="card__title">Today</h2>'
    + '<span class="card__meta">' + (stale ? STALE_BADGE : '') + ui.src('CAL')
    + '<span class="card__note">' + events.length + ' ' + plural(events.length, 'event', 'events') + '</span></span></div>'
    + fileNote + allDayLine + body + '</section>';
}

export function inbox(board, ui) {
  const p = board && board.panels ? board.panels.inbox : null;
  if (!p) return '';
  if (p.error) return errorCard(ui, 'inbox', 'Inbox', 'MAIL', 'inbox');
  const stale = p.stale === true;
  const threads = Array.isArray(p.threads) ? p.threads : [];
  const c = p.counts || {};
  let body = '<div class="counts">'
    + '<span class="count count--reply"><span>Reply</span><span class="count__n">' + ui.esc(String(c.reply ?? 0)) + '</span></span>'
    + '<span class="count"><span>Decide</span><span class="count__n">' + ui.esc(String(c.decide ?? 0)) + '</span></span>'
    + '<span class="count"><span>FYI</span><span class="count__n">' + ui.esc(String(c.fyi ?? 0)) + '</span></span>'
    + '</div>';
  if (threads.length === 0) {
    body += '<p class="empty">Nothing waiting.</p>';
  } else {
    for (const [bucket, label] of [['reply', 'Reply'], ['decide', 'Decide'], ['fyi', 'FYI']]) {
      const list = threads.filter((t) => t.bucket === bucket);
      if (list.length === 0) continue;
      body += '<div class="inbox__group"><p class="group-title"><span>' + label + '</span><span>' + list.length + '</span></p><ul>';
      for (const t of list) {
        body += '<li class="thread"><span class="thread__from">' + ui.esc(t.from) + '</span>'
          + '<span class="thread__subject">' + ui.esc(t.subject) + '</span>'
          + '<div class="thread__foot">'
          + (typeof t.account === 'string' && t.account !== '' ? '<span class="thread__account" data-account>' + ui.esc(t.account) + '</span>' : '')
          + '<span class="thread__why">' + ui.esc(t.why) + '</span>'
          + (t.draft === true ? '<span class="badge badge--accent">Draft ready</span>' : '')
          + '</div></li>';
      }
      body += '</ul></div>';
    }
  }
  return '<section class="card" data-section="inbox"' + (stale ? ' data-stale="true"' : '') + '>'
    + '<div class="card__head"><h2 class="card__title">Inbox</h2>'
    + '<span class="card__meta">' + (stale ? STALE_BADGE : '') + ui.src('MAIL') + '</span></div>'
    + body + '</section>';
}

export function next(board, ui) {
  const seats = Array.isArray(board && board.next) ? board.next : [];
  let body;
  if (seats.length === 0) {
    body = '<p class="empty">Nothing to do next. Add tasks to a project and they appear here.</p>';
  } else {
    body = '<ul class="seats">';
    for (const s of seats) {
      const href = ui.href(s.url);
      const title = href
        ? '<a class="seat__title" href="' + href + '">' + ui.esc(s.title) + '</a>'
        : '<span class="seat__title">' + ui.esc(s.title) + '</span>';
      const chipList = Array.isArray(s.modes)
        ? s.modes.filter((m) => m && Number.isInteger(m.n) && m.n >= 1 && m.n <= 8)
          .map((m) => '<span class="mode-chip mode-' + m.n + '">' + ui.esc(m.name) + '</span>').join('')
        : '';
      let meta = '<span>' + ui.esc(s.project && s.project.title) + '</span>';
      if (s.milestone && s.milestone.shortTitle) meta += '<span>' + ui.esc(s.milestone.shortTitle) + '</span>';
      if (s.urgency === 'overdue') {
        const n = Number(s.overdueDays) || 0;
        meta += '<span class="seat__due seat__due--overdue">overdue ' + n + ' ' + plural(n, 'day', 'days') + '</span>';
      } else if (s.urgency === 'dated' && s.due) {
        meta += '<span class="seat__due">due ' + ui.esc(shortDate(s.due)) + '</span>';
      }
      const form = ui.form('close', s.ref ?? s.number, {}, 'Close');
      body += '<li class="seat ' + ui.pc(s.project && s.project.key) + '"><div class="seat__body">' + (chipList ? '<span class="seat__line">' + title + chipList + '</span>' : title)
        + '<span class="seat__meta">' + meta + '</span></div>'
        + (form ? '<div class="seat__close">' + form + '</div>' : '') + '</li>';
    }
    body += '</ul>';
  }
  return '<section class="card" data-section="next">'
    + '<div class="card__head"><h2 class="card__title">What\'s next</h2>'
    + '<span class="card__meta">' + ui.src(ui.tag) + '<span class="card__note">' + seats.length + ' '
    + plural(seats.length, 'seat', 'seats') + '</span></span></div>' + body + '</section>';
}

function flameRow(h) {
  const flames = Array.isArray(h.flames) ? h.flames : [];
  let out = '<div class="flames" role="img" aria-label="' + (Number(h.flamesLit) || 0) + ' of 5 flames">';
  for (let i = 0; i < 5; i++) {
    out += '<span class="flame' + (flames[i] ? ' flame--lit' : '') + '" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="'
      + FLAME_PATH + '"/></svg></span>';
  }
  return out + '</div>';
}

export function habits(board, ui) {
  const list = Array.isArray(board && board.habits) ? board.habits : [];
  if (list.length === 0) return '';
  const today = board.meta.today;
  let cards = '';
  for (const h of list) {
    const done = h.doneToday === true;
    const sc = h.score && typeof h.score === 'object' ? h.score : null;
    let form;
    if (sc) {
      let opts = '';
      for (let n = sc.min; n <= sc.max; n++) {
        opts += '<option value="' + n + '"' + (sc.today === n ? ' selected' : '') + '>' + n + '</option>';
      }
      const select = '<select name="score" aria-label="Score for ' + ui.esc(h.title) + '">' + opts + '</select>';
      const f = ui.form('score', h.id + ':' + today + ':score', { id: h.id, date: today }, 'Set', select);
      form = f ? '<div class="score-form">' + f + '</div>' : '';
    } else {
      form = ui.form('habit', h.id + ':' + today + ':' + (done ? 'off' : 'on'), {}, done ? 'Done today' : 'Mark done');
    }
    let strip = sc ? '<div class="days">' : '<div class="days" aria-hidden="true">';
    for (const d of Array.isArray(h.recent) ? h.recent : []) {
      const n = sc && d.status === 'done' && Number.isInteger(d.score) ? d.score : null;
      if (n !== null) {
        const lvl = n <= 3 ? 1 : n <= 5 ? 2 : n <= 7 ? 3 : 4;
        strip += '<span class="day day--done day--s' + lvl + '" title="' + ui.esc(d.date + ' \u00b7 score ' + n)
          + '" tabindex="0"><span class="sr-only">score ' + n + '</span></span>';
      } else {
        strip += '<span class="day day--' + ui.esc(d.status) + '" title="' + ui.esc(d.date) + '"></span>';
      }
    }
    strip += '</div>';
    const tokens = Number(h.tokens) || 0;
    const toNext = Number(h.toNextToken) || 0;
    const pc = h.project ? ' ' + ui.pc(h.project.key) : '';
    cards += '<article class="card habit' + pc + '" data-done="' + (done ? 'true' : 'false') + '">'
      + '<div class="habit__top"><h3 class="habit__name">' + ui.esc(h.title) + '</h3>' + form + '</div>'
      + '<div class="habit__mid"><span class="habit__streak"><span class="habit__n">' + (Number(h.streak) || 0)
      + '</span><span class="habit__unit">days</span></span>' + flameRow(h) + '</div>'
      + strip
      + '<div class="habit__foot"><span>' + tokens + ' cheat ' + plural(tokens, 'token', 'tokens') + '</span>'
      + '<span>next in ' + toNext + ' ' + plural(toNext, 'day', 'days') + '</span></div>'
      + '</article>';
  }
  return '<section class="habit-section" data-section="habits">'
    + '<div class="section-head"><h2>Habits</h2><span class="card__meta">' + ui.src(ui.tag) + '</span></div>'
    + '<div class="habit-grid">' + cards + '</div></section>';
}
