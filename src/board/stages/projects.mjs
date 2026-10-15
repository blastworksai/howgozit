// projects stage: one row per shown project, the standalone list and the sort targets (contract R8, R11, R12, R13).
const DOING = new Set(['in progress', 'doing']);

// Dated first by date then number, then undated by number.
function byDue(a, b) {
  const ad = typeof a.due === 'string' && a.due !== '';
  const bd = typeof b.due === 'string' && b.due !== '';
  if (ad !== bd) return ad ? -1 : 1;
  if (ad && a.due !== b.due) return a.due < b.due ? -1 : 1;
  return a.number - b.number;
}

function inDataRepo(ctx, t) {
  const data = typeof ctx.raw?.repo === 'string' ? ctx.raw.repo.toLowerCase() : '';
  return typeof t.repo !== 'string' || t.repo === '' || t.repo.toLowerCase() === data;
}


export default function projects(ctx) {
  const all = Array.isArray(ctx.milestones) ? ctx.milestones : [];
  const rows = [];
  const sortTargets = [];
  for (const p of ctx.shown) {
    const mine = all.filter((m) => m && (Array.isArray(m.projectKeys) ? m.projectKeys.includes(p.key) : m.projectKey === p.key));
    // CP6: a home project offers the goals ctx.sortGoalsOf gives (R59: the idea moves home first).
    const homed = typeof ctx.homeOf === 'function' && ctx.homeOf(p.key) !== null;
    const notDone = mine.filter((m) => m.state !== 'done').sort(byDue);
    const next = notDone[0];
    const prog = ctx.progress(p.key);
    let doing = 0;
    for (const t of ctx.tasksOf(p.key)) {
      if (t.state !== 'open') continue;
      const status = ctx.itemOf(p.key, ctx.refOf(t))?.status;
      if (typeof status === 'string' && DOING.has(status.trim().toLowerCase())) doing += 1;
    }
    // R134: the distinct open blockers of this project's open waiting tasks, task order then blocker order.
    const blockers = [];
    const seen = new Set();
    if (typeof ctx.waitingOn === 'function') {
      for (const t of ctx.tasksOf(p.key)) {
        if (t.state !== 'open') continue;
        for (const b of ctx.waitingOn(t)) {
          const k = b.ref.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          blockers.push(typeof b.title === 'string' && b.title !== '' ? b.title : b.ref);
        }
      }
    }
    rows.push({
      key: p.key, number: p.number, title: p.title, url: p.url, color: p.color, focus: p.focus,
      done: prog.done, total: prog.total, pct: prog.pct, empty: prog.empty, doing,
      overdueMilestones: mine.filter((m) => m.state === 'overdue').length,
      nextMilestone: next ? { shortTitle: next.shortTitle, due: next.due || null } : null,
      habits: [], // model.mjs fills this from the habits part.
      ...(blockers.length > 0 ? { waiting: { items: blockers.slice(0, 3), more: blockers.length - Math.min(3, blockers.length) } } : {}),
    });
    sortTargets.push({
      key: p.key,
      title: p.title,
      milestones: (homed ? ctx.sortGoalsOf(p.key) : mine).filter((m) => m.closed !== true).sort(byDue).map((m) => ({ number: m.number, shortTitle: m.shortTitle })),
    });
  }

  const open = ctx.tasks
    // R13: standalone means a task of the data repo only
    .filter((t) => t.state === 'open' && ctx.projectsOf(ctx.refOf(t)).length === 0 && inDataRepo(ctx, t))
    .sort((a, b) => a.number - b.number);
  const standalone = {
    count: open.length,
    items: open.slice(0, 20).map((t) => ({
      number: t.number, title: t.title, url: t.html_url, due: ctx.dueOf(ctx.refOf(t)) ?? null,
    })),
  };
  return { projects: rows, standalone, sortTargets };
}
