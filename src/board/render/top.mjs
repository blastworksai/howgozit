// Top sections of the page: brief, season, focus, timeline.
// Pure: each export is (board, ui) -> string, '' when the section is left out (R86).
// Every outside string goes through ui.esc (R73); a link exists only through ui.href (R74, R53).

import { addMonths, diffDays, isDate, monthStart } from '../days.mjs';

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

const staleBadge = '<span class="badge badge--stale">Out of date</span>';

// ---------------------------------------------------------------------------------------------
// brief

export function brief(board, ui) {
  const panel = board?.panels?.brief;
  if (panel === null || panel === undefined) return '';
  const tag = String(board?.meta?.agentName ?? 'Agent');
  const src = ui.src(tag);
  const head = (label, stale) =>
    `<div class="card__head">`
    + `<p class="card__label"><span class="dot dot--agent"></span>${label}</p>`
    + `<span class="card__meta">${stale ? staleBadge : ''}${src}</span>`
    + `</div>`;

  if (isObj(panel) && panel.error) {
    return `<section class="card card--agent card--wide" data-section="brief">`
      + head('Morning brief', false)
      + `<p class="panel-error">This file could not be read. Check state/brief.json in the data repo.</p>`
      + `</section>`;
  }
  const stale = panel.stale === true;
  const lines = list(panel.lines);
  const label = `Morning brief${panel.generated ? ` · ${ui.esc(panel.generated)}` : ''}`;
  const body = lines.length === 0
    ? `<p class="empty">Nothing in today's brief.</p>`
    : `<ol class="brief__lines">${lines.map((l) =>
      `<li class="brief__line"><span class="brief__tag">${ui.esc(l?.src ?? '')}</span>`
      + `<span class="brief__text">${ui.esc(l?.text ?? '')}</span></li>`).join('')}</ol>`;
  return `<section class="card card--agent card--wide" data-section="brief"${stale ? ' data-stale="true"' : ''}>`
    + head(label, stale)
    + body
    + `</section>`;
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
    big = `<span class="season__label">Starts ${ui.esc(shortDate(s.start))}</span>`;
  } else if (phase === 'after') {
    big = `<span class="season__label">Ended ${ui.esc(shortDate(s.end))}</span>`;
  } else {
    big = `<span class="season__days">${ui.esc(s.daysLeft ?? 0)}</span>`
      + `<span class="season__label">days left in <strong>${name}</strong></span>`;
  }
  const goals = list(s.goals).map((g) => {
    const title = ui.esc(g?.title ?? '');
    if (g?.pct === null || g?.pct === undefined || !Number.isFinite(Number(g.pct))) {
      return `<li class="goal"><div class="goal__row"><span class="goal__title">${title}</span>`
        + `<span class="goal__pct">no project</span></div></li>`;
    }
    const p = pctOf(g.pct);
    return `<li class="goal"><div class="goal__row"><span class="goal__title">${title}</span>`
      + `<span class="goal__pct">${p}%</span></div>`
      + `<div class="bar"><span class="${join('bar__fill', 'bar__fill--ink', ui.w(p))}"></span></div></li>`;
  });
  return `<section class="card" data-section="season">`
    + `<div class="card__head"><p class="card__label">Season · ${name}</p>`
    + `<span class="card__note">${ui.esc(shortDate(s.start))} → ${ui.esc(shortDate(s.end))}</span></div>`
    + `<div class="season__big">${big}</div>`
    + (goals.length ? `<ul class="goals">${goals.join('')}</ul>` : '')
    + `</section>`;
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
    body = `<p class="focus__empty">No focus set</p>`;
  } else {
    body = `<div class="focus__chips">${projects.map((p) => {
      const inner = `<span class="chip__name">${ui.esc(p?.title ?? '')}</span>`;
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
      + `<p class="card__label">${agent} suggests${pr.stale === true ? ` · ${staleBadge}` : ''}</p>`
      + (parts.length ? `<p>${parts.join(' ')}</p>` : '')
      + (pr.why ? `<p class="focus__why">${ui.esc(pr.why)}</p>` : '')
      + `</div>`;
  }

  return `<section class="card" data-section="focus">`
    + `<div class="card__head"><h2 class="card__title">Focus</h2>`
    + `<span class="card__note">${projects.length} of ${all.length} projects</span></div>`
    + body
    + proposal
    + `</section>`;
}

// ---------------------------------------------------------------------------------------------
// timeline

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

  const dot = (ms) => {
    const p = posOf(ms?.due);
    if (p === null) return '';
    const state = ms.state === 'done' || ms.state === 'overdue' ? ms.state : 'open';
    const cls = join('tl-dot', `tl-dot--${state}`, p > 80 ? 'tl-dot--left' : '', ui.x(p));
    const label = `${ms.shortTitle ?? ''} ${pctOf(ms.pct)}%`;
    const title = `${ms.shortTitle ?? ''} · ${ms.due} · ${ms.done ?? 0}/${ms.total ?? 0}`;
    const inner = `<span class="tl-dot__label">${ui.esc(label)}</span>`;
    const href = ui.href(ms.url);
    return href
      ? `<a class="${cls}" href="${href}" title="${ui.esc(title)}">${inner}</a>`
      : `<span class="${cls}" title="${ui.esc(title)}">${inner}</span>`;
  };

  const row = (nameHtml, dots) =>
    `<div class="tl-row"><div class="tl-name">${nameHtml}</div>`
    + `<div class="tl-plot"><div class="tl-track">${tickMarks}${todayMark}${dots}</div></div></div>`;

  const axis = `<div class="tl-row tl-axis"><div class="tl-name"></div>`
    + `<div class="tl-plot"><div class="tl-track">`
    + ticks.map((k) => `<span class="${join('tl-tick', ui.x(k.p))}">${ui.esc(k.label)}</span>`).join('')
    + (todayP === null ? '' : `<span class="${join('tl-today', ui.x(todayP))}"><span class="tl-today__label">Today</span></span>`)
    + `</div></div></div>`;

  const laneHtml = lanes.map((lane) => {
    const proj = lane?.project ?? {};
    const focusAttr = proj.focus === true ? ' data-focus="true"' : '';
    const dots = list(lane.milestones).map(dot).join('');
    const undated = list(lane.undated).map((u) =>
      `<span class="tl-undated"><span class="badge">${ui.esc(`Undated: ${u?.shortTitle ?? ''} ${pctOf(u?.pct)}%`)}</span></span>`).join('');
    const notes = [];
    if (Number(lane.beforeWindow) > 0) notes.push(`${Number(lane.beforeWindow)} earlier`);
    if (Number(lane.beyondWindow) > 0) notes.push(`${Number(lane.beyondWindow)} later`);
    const sub = undated || notes.length
      ? `<div class="tl-sub">${undated}${notes.length ? `<span class="tl-note">${notes.join(' · ')}</span>` : ''}</div>`
      : '';
    return `<div class="${join('tl-lane', ui.pc(proj.key))}"${focusAttr}>`
      + row(`<span class="swatch"></span><span>${ui.esc(proj.title ?? '')}</span>`, dots)
      + sub
      + `</div>`;
  }).join('');

  const otherHtml = other.length === 0 ? '' :
    `<div class="tl-lane tl-lane--other">`
    + row('<span>Other</span>', other.map(dot).join(''))
    + `</div>`;

  const legend = `<p class="tl-legend">`
    + `<span><i class="tl-dot tl-dot--open"></i>Open</span>`
    + `<span><i class="tl-dot tl-dot--overdue"></i>Overdue</span>`
    + `<span><i class="tl-dot tl-dot--done"></i>Done</span></p>`;

  const note = `${ui.esc(shortMonth(t.start))} to ${ui.esc(shortMonth(t.end))}`;
  return `<section class="card" data-section="timeline">`
    + `<div class="card__head"><h2 class="card__title">Timeline</h2>`
    + `<span class="card__meta">${ui.src(ui.tag)}<span class="card__note">${note}</span></span></div>`
    + `<div class="tl">${axis}${laneHtml}${otherHtml}${legend}</div>`
    + `</section>`;
}

function shortMonth(date) {
  return isDate(date) ? MONTHS[Number(date.slice(5, 7)) - 1] : '';
}
