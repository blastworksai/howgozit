// Top sections of the page: brief, season, focus, timeline.
// Pure: each export is (board, ui) -> string, '' when the section is left out (R86).
// Every outside string goes through ui.esc (R73); a link exists only through ui.href (R74, R53).

import { addMonths, diffDays, isDate, monthStart } from '../days.mjs';
import { STALE_BADGE as staleBadge, emp, frame, panelError } from './parts.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const join = (...parts) => parts.filter((p) => typeof p === 'string' && p !== '').join(' ');

// '2026-10-12' -> '12 Oct'; anything unreadable is returned as given (escaped by the caller).
function shortDate(date) {
  if (!isDate(date)) return String(date ?? '');
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

function pctOf(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v * 10) / 10));
}


// ---------------------------------------------------------------------------------------------
// brief

export function brief(board, ui) {
  const panel = board?.panels?.brief;
  if (panel === null || panel === undefined) return '';
  const tag = String(board?.meta?.agentName ?? 'Agent');
  const src = ui.src(tag);
  // The pad is lit only when the panel is fresh and readable (D3); off when stale or unreadable.
  const head = (label, stale, off) =>
    `<div class="card__head">`
    + `<p class="card__label lab"><span class="${join('pad', off ? 'off' : '')}"></span>${label}</p>`
    + `<span class="card__meta">${stale ? staleBadge : ''}${src}</span>`
    + `</div>`;

  if (isObj(panel) && panel.error) {
    return frame('card card--agent card--wide', 'brief', '',
      head('Morning brief', false, true)
      + panelError('This file could not be read. Check state/brief.json in the data repo.'));
  }
  const stale = panel.stale === true;
  const lines = list(panel.lines);
  const label = `Morning brief${panel.generated ? ` · ${ui.esc(panel.generated)}` : ''}`;
  // Lines are written as the agent wrote them; the stylesheet shows them in capitals (R177).
  const body = lines.length === 0
    ? emp("Nothing in today's brief.")
    : `<ol class="brief__lines">${lines.map((l) =>
      `<li class="brief__line"><span class="brief__tag lab">${ui.esc(l?.src ?? '')}</span>`
      + `<span class="brief__text">${ui.esc(l?.text ?? '')}</span></li>`).join('')}</ol>`;
  return frame('card card--agent card--wide', 'brief', stale ? ' data-stale="true"' : '',
    head(label, stale, stale) + body);
}

// ---------------------------------------------------------------------------------------------
// season

export function season(board, ui) {
  const s = board?.season;
  if (!isObj(s)) return '';
  const name = ui.esc(s.name ?? '');
  const phase = s.phase;
  let big;
  if (phase === 'before') {
    big = `<span class="season__label lab">Starts ${ui.esc(shortDate(s.start))}</span>`;
  } else if (phase === 'after') {
    big = `<span class="season__label lab">Ended ${ui.esc(shortDate(s.end))}</span>`;
  } else {
    big = `<output class="season__days">${ui.esc(s.daysLeft ?? 0)}</output>`
      + `<span class="season__label lab">days left in <strong>${name}</strong></span>`;
  }
  const goals = list(s.goals).map((g) => {
    const title = ui.esc(g?.title ?? '');
    if (g?.pct === null || g?.pct === undefined || !Number.isFinite(Number(g.pct))) {
      return `<li class="goal"><div class="goal__row"><span class="goal__title">${title}</span>`
        + `<span class="goal__pct lab">no project</span></div></li>`;
    }
    const p = pctOf(g.pct);
    return `<li class="goal"><div class="goal__row"><span class="goal__title">${title}</span>`
      + `<span class="goal__pct lab">${p}%</span></div>`
      + `<div class="bar"><i class="${ui.w(p)}"></i></div></li>`;
  });
  return frame('card', 'season', '',
    `<div class="card__head"><p class="card__label lab">Season · ${name}</p>`
    + `<span class="card__note lab">${ui.esc(shortDate(s.start))} <span class="arrow">→</span> ${ui.esc(shortDate(s.end))}</span></div>`
    + `<div class="season__big bn bn--m">${big}</div>`
    + (goals.length ? `<ul class="goals">${goals.join('')}</ul>` : ''));
}

// ---------------------------------------------------------------------------------------------
// focus

export function focus(board, ui) {
  const f = board?.focus;
  const projects = list(f?.projects);
  const all = list(board?.projects);
  const urlOf = (key) => all.find((p) => p?.key === key)?.url;
  const titleOf = (key) => all.find((p) => p?.key === key)?.title
    ?? projects.find((p) => p?.key === key)?.title ?? key;

  let body;
  if (projects.length === 0) {
    body = emp('No focus set', 'focus__empty');
  } else {
    body = `<div class="focus__chips">${projects.map((p) => {
      const inner = `<span class="bdg chip__name"><span class="pad"></span>`
        + `<span class="chip__label">${ui.esc(p?.title ?? '')}</span></span>`;
      const href = ui.href(urlOf(p?.key));
      return href
        ? `<a class="chip" data-focus="true" href="${href}">${inner}</a>`
        : `<span class="chip" data-focus="true">${inner}</span>`;
    }).join('')}</div>`;
  }

  let proposal = '';
  const pr = f?.proposal;
  if (isObj(pr)) {
    const agent = ui.esc(board?.meta?.agentName ?? 'Agent');
    const names = (keys) => list(keys).map((k) => ui.esc(titleOf(k))).join(', ');
    const parts = [];
    if (list(pr.add).length) parts.push(`Add ${names(pr.add)}.`);
    if (list(pr.remove).length) parts.push(`Remove ${names(pr.remove)}.`);
    proposal = `<div class="focus__proposal">`
      + `<p class="card__label lab">${agent} suggests${pr.stale === true ? ` · ${staleBadge}` : ''}</p>`
      + (parts.length ? `<p>${parts.join(' ')}</p>` : '')
      + (pr.why ? `<p class="focus__why">${ui.esc(pr.why)}</p>` : '')
      + `</div>`;
  }

  return frame('card', 'focus', '',
    `<div class="card__head"><h2 class="card__title cap">Focus</h2>`
    + `<span class="card__note lab">${projects.length} of ${all.length} projects</span></div>`
    + body
    + proposal);
}

// ---------------------------------------------------------------------------------------------
// timeline

// Label placement (R176). All distances are pixels on a 772px plot, turned into percent of the plot,
// so the guarantee holds on any wider plot; the stylesheet hides every label below 962px of timeline.
// The geometry below is also written in board/static/board.css (`.tl-dot`, `.tl-dot__label`, `.tl-dot--left`):
// a dot is 14px wide (DOT_HALF each side of its centre), the nearest edge of its label is LABEL_FROM from the
// dot's centre (CSS `calc(50% + 22px)`), a label is at most LABEL_MAX wide with 4px padding each side, and the
// Today line is 2px wide, boxed TODAY_HALF each side. Change both files together (contract R176).
const TRACK_W = 772;
const DOT_HALF = 7;
const LABEL_FROM = 22;
const LABEL_MAX = 150;
const TODAY_HALF = 5;
const px = (n) => (n / TRACK_W) * 100;
// Two boxes clash when each starts before the other ends plus the margin (pixels).
const hit = (a, b, margin = 3) => a[0] < b[1] + px(margin) && b[0] < a[1] + px(margin);
// UTF-16 code unit order, never the locale's.
const byUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function place(items, todayP) {
  const todayI = todayP === null ? null : [todayP - px(TODAY_HALF), todayP + px(TODAY_HALF)];
  const bands = [0, 1, 2, 3].map(() => ({ dots: [], labels: [] }));
  let top = 0;
  const ordered = [...items].sort((x, y) => (x.p - y.p)
    || byUnits(String(x.ms.due), String(y.ms.due)) || byUnits(x.text, y.text));
  const placed = ordered.map((it, idx) => {
    const dotI = [it.p - px(DOT_HALF), it.p + px(DOT_HALF)];
    const w = Math.min(LABEL_MAX, 8 * it.text.length + 8);
    const later = ordered.slice(idx + 1).map((o) => [o.p - px(DOT_HALF), o.p + px(DOT_HALF)]);
    let got = null;
    for (let n = 0; n < 4 && !(got && got.blocks === 0); n += 1) {
      const B = bands[n];
      if (B.dots.some((x) => hit(x, dotI)) || B.labels.some((x) => hit(x, dotI))) continue;
      for (const side of ['r', 'l']) {
        const li = side === 'r' ? [it.p + px(LABEL_FROM), it.p + px(LABEL_FROM + w)] : [it.p - px(LABEL_FROM + w), it.p - px(LABEL_FROM)];
        if (li[0] < 0 || li[1] > 100) continue;
        if (B.labels.some((x) => hit(x, li)) || B.dots.some((x) => hit(x, li))) continue;
        if (todayI && hit(todayI, li, 0)) continue;
        const cand = { n, side, li, blocks: later.filter((x) => hit(x, li)).length };
        if (!got || (got.blocks > 0 && cand.blocks === 0)) got = cand;
      }
    }
    if (!got) {
      // The dot alone: the first of bands 0 to 2 where it clashes with nothing, else band 3.
      let n = 0;
      while (n < 3 && (bands[n].dots.some((x) => hit(x, dotI)) || bands[n].labels.some((x) => hit(x, dotI)))) n += 1;
      got = { n, side: null, li: null };
    }
    bands[got.n].dots.push(dotI);
    if (got.li) bands[got.n].labels.push(got.li);
    top = Math.max(top, got.n);
    return { ...it, n: got.n, side: got.side };
  });
  return { placed, count: top + 1 };
}

export function timeline(board, ui) {
  const t = board?.timeline;
  if (!isObj(t)) return '';
  const lanes = list(t.lanes);
  const other = list(t.other);
  const hasAny = lanes.some((l) => list(l?.milestones).length > 0 || list(l?.undated).length > 0);
  if (!hasAny && other.length === 0) return '';
  if (!isDate(t.start) || !isDate(t.end)) return '';

  const span = diffDays(t.start, t.end) + 1;
  const posOf = (date) => {
    if (!isDate(date)) return null;
    const d = diffDays(t.start, date);
    if (d === null || d < 0 || d >= span) return null;
    return pctOf((d / span) * 100);
  };

  // Month starts inside the window.
  const ticks = [];
  let m = monthStart(t.start);
  for (let i = 0; m && m <= t.end && i < 40; i += 1) {
    const p = posOf(m);
    if (p !== null) ticks.push({ p, label: MONTHS[Number(m.slice(5, 7)) - 1] });
    m = addMonths(m, 1);
  }
  const todayP = posOf(t.today);

  const tickMarks = ticks.map((k) => `<i class="${join('tl-tick', ui.x(k.p))}"></i>`).join('');
  const todayMark = todayP === null ? '' : `<i class="${join('tl-today', ui.x(todayP))}"></i>`;

  const dot = (it) => {
    const ms = it.ms;
    const state = ms.state === 'done' || ms.state === 'overdue' ? ms.state : 'open';
    const cls = join('tl-dot', `tl-dot--${state}`, it.n > 0 ? `tl-dot--b${it.n}` : '',
      it.side === 'l' ? 'tl-dot--left' : '', it.side === null ? 'tl-dot--bare' : '', ui.x(it.p));
    const title = `${ms.shortTitle ?? ''} · ${ms.due} · ${ms.done ?? 0}/${ms.total ?? 0}`;
    const aria = `${it.text}, due ${ms.due}`;
    // A bare dot has no label element: its text lives in title and aria-label.
    const inner = it.side === null ? '' : `<span class="tl-dot__label">${ui.esc(it.text)}</span>`;
    const href = ui.href(ms.url);
    return href
      ? `<a class="${cls}" href="${href}" title="${ui.esc(title)}" aria-label="${ui.esc(aria)}">${inner}</a>`
      : `<span class="${cls}" role="img" title="${ui.esc(title)}" aria-label="${ui.esc(aria)}">${inner}</span>`;
  };

  const row = (nameHtml, milestones) => {
    const items = list(milestones)
      .map((ms) => ({ ms, p: posOf(ms?.due), text: `${ms?.shortTitle ?? ''} ${pctOf(ms?.pct)}%` }))
      .filter((it) => it.p !== null);
    const { placed, count } = place(items, todayP);
    return `<div class="tl-row"><div class="tl-name">${nameHtml}</div>`
      + `<div class="${join('tl-plot', count > 1 ? `tl-bands-${count}` : '')}"><div class="tl-track">`
      + `${tickMarks}${todayMark}${placed.map(dot).join('')}</div></div></div>`;
  };

  const axis = `<div class="tl-row tl-axis"><div class="tl-name"></div>`
    + `<div class="tl-plot"><div class="tl-track">`
    + ticks.map((k) => `<span class="${join('tl-tick', todayP !== null && Math.abs(k.p - todayP) < 16 ? 'tl-tick--near' : '', ui.x(k.p))}">${ui.esc(k.label)}</span>`).join('')
    + (todayP === null ? '' : `<span class="${join('tl-today', ui.x(todayP))}"><span class="tl-today__label lab">Today</span></span>`)
    + `</div></div></div>`;

  const laneHtml = lanes.map((lane) => {
    const proj = lane?.project ?? {};
    const focusAttr = proj.focus === true ? ' data-focus="true"' : '';
    const undated = list(lane.undated).map((u) =>
      `<span class="tl-undated"><span class="tag tag--line">${ui.esc(`Undated: ${u?.shortTitle ?? ''} ${pctOf(u?.pct)}%`)}</span></span>`).join('');
    const notes = [];
    if (Number(lane.beforeWindow) > 0) notes.push(`${Number(lane.beforeWindow)} earlier`);
    if (Number(lane.beyondWindow) > 0) notes.push(`${Number(lane.beyondWindow)} later`);
    const sub = undated || notes.length
      ? `<div class="tl-sub">${undated}${notes.length ? `<span class="tl-note">${notes.join(' · ')}</span>` : ''}</div>`
      : '';
    return `<div class="${join('tl-lane', ui.pc(proj.key))}"${focusAttr}>`
      + row(`<span class="swatch"></span><span>${ui.esc(proj.title ?? '')}</span>`, lane.milestones)
      + sub
      + `</div>`;
  }).join('');

  const otherHtml = other.length === 0 ? '' :
    `<div class="tl-lane tl-lane--other">`
    + row('<span>Other</span>', other)
    + `</div>`;

  const legend = `<p class="tl-legend lab">`
    + `<span><i class="tl-dot tl-dot--open"></i>Open</span>`
    + `<span><i class="tl-dot tl-dot--overdue"></i>Overdue</span>`
    + `<span><i class="tl-dot tl-dot--done"></i>Done</span></p>`;

  const note = `${ui.esc(shortMonth(t.start))} to ${ui.esc(shortMonth(t.end))}`;
  return frame('card', 'timeline', '',
    `<div class="card__head"><h2 class="card__title cap">Timeline</h2>`
    + `<span class="card__meta">${ui.src(ui.tag)}<span class="card__note lab">${note}</span></span></div>`
    + `<div class="tl-wrap">${axis}${laneHtml}${otherHtml}${legend}</div>`);
}

function shortMonth(date) {
  return isDate(date) ? MONTHS[Number(date.slice(5, 7)) - 1] : '';
}
