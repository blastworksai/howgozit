// Low sections of the page: heatmap, projects, log, ideas, standalone.
// Pure: (board, ui) -> string. Every board string goes through ui.esc (R73);
// a link exists only through ui.href (R74); the log section never links (R53).

const clamp = (n) => Math.max(0, Math.min(100, Number.isFinite(n) ? Math.round(n * 10) / 10 : 0));

// A title that is a link when its address is a GitHub one, plain text otherwise.
function titled(ui, cls, text, url) {
  const href = typeof url === 'string' ? ui.href(url) : null;
  return href
    ? `<a class="${cls}" href="${href}">${ui.esc(text)}</a>`
    : `<span class="${cls}">${ui.esc(text)}</span>`;
}

function card(ui, name, title, tag, note, body, extra = {}) {
  const cls = extra.cls || 'card';
  const stale = extra.stale ? ' data-stale="true"' : '';
  const badge = extra.stale ? '<span class="badge badge--stale">Out of date</span>' : '';
  const noteHtml = note === '' ? '' : `<span class="card__note">${ui.esc(note)}</span>`;
  return `<section class="${cls}" data-section="${name}"${stale}>`
    + `<div class="card__head"><h2 class="card__title">${ui.esc(title)}</h2>`
    + `<span class="card__meta">${badge}${ui.src(tag)}${noteHtml}</span></div>`
    + body + '</section>';
}

export function heatmap(board, ui) {
  const weeks = (board.heatmap && board.heatmap.weeks) || [];
  const cell = (d) => {
    const date = ui.esc(String(d.date));
    if (d.level === null || d.level === undefined) {
      return `<span class="heat__cell heat__cell--none" title="${date}"></span>`;
    }
    const lvl = Math.max(0, Math.min(4, Math.round(Number(d.level)) || 0));
    return `<span class="heat__cell heat__cell--l${lvl}" title="${date} · ${ui.esc(String(d.count ?? 0))}"></span>`;
  };
  const cols = weeks.map((w) => `<div class="heat__week">${(w || []).map(cell).join('')}</div>`).join('');
  const legend = '<div class="heat__legend"><span>Less</span>'
    + [0, 1, 2, 3, 4].map((l) => `<span class="heat__cell heat__cell--l${l}"></span>`).join('')
    + '<span>More</span></div>';
  const body = `<div class="heat" role="img" aria-label="Items closed per day over the last 12 weeks">${cols}</div>${legend}`;
  return card(ui, 'heatmap', 'Last 12 weeks', ui.tag, 'issues closed / day', body);
}

function projectRow(p, ui) {
  const focus = p.focus ? ' data-focus="true"' : '';
  const pc = ui.pc(p.key);
  const count = p.empty
    ? 'No tasks yet'
    : `${p.done}/${p.total} · ${p.pct}%`;
  const bar = p.empty
    ? ''
    : `<div class="bar bar--thin"><span class="bar__fill ${ui.w(clamp(p.pct))}"></span></div>`;
  const stats = [`<span>${ui.esc(String(p.doing ?? 0))} in progress</span>`];
  if (p.overdueMilestones > 0) {
    const n = p.overdueMilestones;
    stats.push(`<span class="stat--hot">${ui.esc(String(n))} overdue milestone${n === 1 ? '' : 's'}</span>`);
  }
  if (p.nextMilestone) {
    const due = p.nextMilestone.due ? ` · ${ui.esc(p.nextMilestone.due)}` : '';
    stats.push(`<span>Next: ${ui.esc(p.nextMilestone.shortTitle)}${due}</span>`);
  }
  // R134: what a waiting task waits on, small grey words (`data-waiting`), at most three and then +n.
  if (p.waiting && Array.isArray(p.waiting.items)) {
    for (const label of p.waiting.items) {
      stats.push(`<span class="cal-source" data-waiting>waiting on: ${ui.esc(String(label))}</span>`);
    }
    if (p.waiting.more > 0) stats.push(`<span class="cal-source" data-waiting>+${ui.esc(String(p.waiting.more))}</span>`);
  }
  const habits = (p.habits || []).length
    ? '<div class="project__habits">'
      + p.habits.map((h) => `<span class="badge">${ui.esc(h.title)} · ${ui.esc(String(h.streak))}</span>`).join('')
      + '</div>'
    : '';
  return `<li class="project ${pc}"${focus}>`
    + `<div class="project__head">${titled(ui, 'project__title', p.title, p.url)}`
    + `<span class="project__count">${ui.esc(count)}</span></div>`
    + bar
    + `<div class="project__stats">${stats.join('')}</div>`
    + habits + '</li>';
}

export function projects(board, ui) {
  const list = board.projects || [];
  const body = list.length
    ? `<ul class="projects">${list.map((p) => projectRow(p, ui)).join('')}</ul>`
    : '<p class="empty">No projects yet. Run setup, or add one in board.config.json.</p>';
  return card(ui, 'projects', 'Projects', ui.tag, '', body);
}

export function log(board, ui) {
  const panel = board.panels && board.panels.log;
  if (panel === null || panel === undefined) return '';
  const agent = (board.meta && board.meta.agentName) || 'Agent';
  const cls = 'card card--agent';
  if (panel.error) {
    const body = '<p class="panel-error">This file could not be read. Check state/log.json in the data repo.</p>';
    return card(ui, 'log', `${agent} did`, agent, '', body, { cls });
  }
  const entries = panel.entries || [];
  const body = entries.length
    ? '<ol class="log">' + entries.map((e) => '<li class="log__item">'
      + `<span class="log__t">${ui.esc(e.t)}</span>`
      + `<span class="log__body"><span>${ui.esc(e.what)}</span><span class="log__agent">${ui.esc(e.agent)}</span></span>`
      + '</li>').join('') + '</ol>'
    : '<p class="empty">Nothing logged yet.</p>';
  return card(ui, 'log', `${agent} did`, agent, '', body, { cls, stale: !!panel.stale });
}

function suggestionHtml(item, board, ui) {
  const s = item.suggestion;
  if (!s) return '';
  const agent = (board.meta && board.meta.agentName) || 'Agent';
  let what;
  if (s.newProject && !s.projectTitle) {
    what = `new project ${s.newProject}`;
  } else {
    what = s.projectTitle || s.project || '';
    if (s.milestoneTitle) what += ` · ${s.milestoneTitle}`;
  }
  const why = `${s.why || ''}${s.stale ? ' · Out of date' : ''}`;
  const accept = s.acceptable ? ui.form('sort', item.ref ?? item.number, { accept: '1' }, 'Accept') : '';
  return '<div class="suggestion"><div class="suggestion__text">'
    + `<span>${ui.esc(agent)} suggests: ${ui.esc(what)}</span>`
    + `<span class="suggestion__why">${ui.esc(why)}</span></div>${accept}</div>`;
}

function sortSelect(targets, ui) {
  const opts = [];
  for (const t of targets) {
    opts.push(`<option value="${ui.esc(t.key)}">${ui.esc(t.title)}</option>`);
    for (const m of t.milestones || []) {
      opts.push(`<option value="${ui.esc(`${t.key}/${m.number}`)}">${ui.esc(`${t.title} · ${m.shortTitle}`)}</option>`);
    }
  }
  return `<select name="target" aria-label="Project and milestone">${opts.join('')}</select>`;
}

export function ideas(board, ui) {
  const data = board.ideas || { count: 0, shown: 0, items: [] };
  const items = data.items || [];
  const targets = board.sortTargets || [];
  const select = targets.length ? sortSelect(targets, ui) : '';
  const li = (item) => {
    const sortForm = targets.length ? ui.form('sort', item.ref ?? item.number, {}, 'Move', select) : '';
    const sort = sortForm
      ? '<div class="idea__actions"><details class="sort"><summary>Sort</summary>'
        + `<div class="sort__form">${sortForm}</div>`
        + '</details><p data-message></p></div>'
      : '';
    return '<li class="idea"><div class="idea__top">'
      + titled(ui, 'idea__title', item.title, item.url)
      + `<span class="idea__date">${ui.esc(item.createdAt || '')}</span></div>`
      + suggestionHtml(item, board, ui)
      + sort + '</li>';
  };
  const body = items.length
    ? `<ul class="ideas">${items.map(li).join('')}</ul>`
    : `<p class="empty">${ui.readOnly ? 'No ideas yet.' : 'No ideas yet. Log one above.'}</p>`;
  return card(ui, 'ideas', 'Ideas', ui.tag, `${data.shown ?? items.length} of ${data.count ?? items.length}`, body);
}

export function standalone(board, ui) {
  const data = board.standalone;
  if (!data || !data.count) return '';
  const items = data.items || [];
  const li = (t) => {
    const close = ui.form('close', t.number, {}, 'Close');
    return '<li class="solo"><div class="solo__top">'
      + titled(ui, 'solo__title', t.title, t.url)
      + (t.due ? `<span class="meta">due ${ui.esc(t.due)}</span>` : '')
      + (close ? `<div class="solo__close">${close}</div>` : '')
      + '</div></li>';
  };
  const more = data.count > items.length
    ? `<p class="meta">Showing ${ui.esc(String(items.length))} of ${ui.esc(String(data.count))}.</p>`
    : '';
  const body = `<ul class="standalone">${items.map(li).join('')}</ul>${more}`;
  return card(ui, 'standalone', 'Standalone', ui.tag, `${data.count} open`, body);
}
