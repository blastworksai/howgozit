// core-milestones: milestones, their progress and state, and a task's date (contract R14 to R19, R22, R93).
// Pure: no clock, no file, no network, no environment. Never mutates its inputs; never throws for odd data.
import { dateIn, utcDate } from './days.mjs';
import { goalKey, sameRepo } from './model/snapshot.mjs';

const SEP = ' · ';
const key = (s) => String(s).normalize('NFC').trim().toLowerCase();

export function addMilestones(ctx, raw) {
  void raw;
  const shown = Array.isArray(ctx.shown) ? ctx.shown : [];
  const tasks = Array.isArray(ctx.tasks) ? ctx.tasks : [];
  const rows = Array.isArray(ctx.rawMilestones) ? ctx.rawMilestones : [];

  const dataRepo = typeof ctx.raw?.repo === 'string' ? ctx.raw.repo : '';
  const goalOf = (t) => goalKey(typeof t.repo === 'string' ? t.repo : dataRepo, t.milestone);

  const byTitle = new Map();
  for (const p of shown) {
    const k = key(p.title);
    if (!byTitle.has(k)) byTitle.set(k, p.key);
  }

  const tasksOfMs = new Map();
  for (const t of tasks) {
    if (t.milestone === null || t.milestone === undefined) continue;
    const list = tasksOfMs.get(goalOf(t)) || [];
    list.push(t);
    tasksOfMs.set(goalOf(t), list);
  }

  const shownKeys = shown.map((p) => p.key);
  const repoOfGoal = new WeakMap(); // entry -> its repo, kept beside the entry so the entry's shape is unchanged
  const homePath = new Set(); // goal keys of milestones read from a home repo (R14, R22)
  const seen = new Set();
  const byGoal = new Map();
  const out = [];
  for (const row of rows) {
    const gk = goalKey(typeof row.repo === 'string' ? row.repo : dataRepo, row.number);
    if (seen.has(gk)) continue;
    seen.add(gk);
    const mine = tasksOfMs.get(gk) || [];
    // R14: a goal of the data repo belongs to a project through its title; a goal of a home repo belongs to the
    // shown projects (R8 order) whose tasks sit in it, keeps its whole title, and is never unmatched.
    const isHome = typeof row.repo === 'string' && row.repo !== '' && dataRepo !== '' && !sameRepo(row.repo, dataRepo);
    let projectKey = null;
    let shortTitle = row.title;
    let projectKeys;
    if (isHome) {
      homePath.add(gk);
      const have = new Set();
      for (const t of mine) for (const k of ctx.projectsOf(ctx.refOf(t))) have.add(k);
      projectKeys = shownKeys.filter((k) => have.has(k));
      projectKey = projectKeys[0] ?? null;
    } else {
      const at = row.title.indexOf(SEP);
      if (at >= 0) {
        const k = byTitle.get(key(row.title.slice(0, at)));
        if (k !== undefined) {
          projectKey = k;
          shortTitle = row.title.slice(at + SEP.length);
        }
      }
      if (projectKey === null) ctx.warn('milestone-unmatched');
      projectKeys = projectKey === null ? [] : [projectKey];
    }


    const total = mine.length;
    const done = mine.filter((t) => t.state === 'closed').length;
    const pct = total === 0 ? 0 : Math.floor((100 * done) / total);
    const closed = row.state === 'closed';
    const isDone = closed || (total > 0 && done === total);
    const due = row.due_on === null ? null : utcDate(row.due_on);

    let finishedOn = null;
    if (isDone) {
      if (closed && row.closed_at !== null) finishedOn = dateIn(ctx.tz, row.closed_at);
      if (finishedOn === null) {
        for (const t of mine) {
          if (t.state !== 'closed' || typeof t.closed_at !== 'string') continue;
          const d = dateIn(ctx.tz, t.closed_at);
          if (d !== null && (finishedOn === null || d > finishedOn)) finishedOn = d;
        }
      }
    }
    const state = isDone ? 'done' : due !== null && due < ctx.today ? 'overdue' : 'open';
    const entry = {
      number: row.number, title: row.title, shortTitle, projectKey, projectKeys, url: row.html_url,
      due, closed, finishedOn, done, total, pct, state,
    };
    repoOfGoal.set(entry, typeof row.repo === 'string' && row.repo !== '' ? row.repo : dataRepo);
    byGoal.set(gk, entry);
    out.push(entry);
  }

  // x: a ref string or a bare number (the data repo's card); the goal is looked up in the card's own repo.
  const milestoneOf = (x) => {
    const t = ctx.issueByNumber ? ctx.issueByNumber(x) : null;
    if (!t || t.milestone === null || t.milestone === undefined) return null;
    return byGoal.get(goalOf(t)) || null;
  };

  // R22
  for (const t of tasks) {
    const ref = ctx.refOf(t);
    const m = milestoneOf(ref);
    if (!m || m.projectKey === null) continue;
    if (homePath.has(goalOf(t))) continue; // R22: a crossing is raised only on the title path
    const mine = ctx.projectsOf(ref);
    if (mine.length > 0 && !mine.includes(m.projectKey)) ctx.warn('milestone-crosses-project');
  }

  // R93
  const dueOf = (x) => {
    for (const k of ctx.projectsOf(x)) {
      const it = ctx.itemOf(k, x);
      if (it && typeof it.due === 'string' && it.due !== '') return it.due;
    }
    const m = milestoneOf(x);
    return m && m.state !== 'done' ? m.due : null;
  };

  ctx.milestones = out;
  ctx.milestoneOf = milestoneOf;
  ctx.goalRepoOf = (m) => repoOfGoal.get(m) ?? dataRepo;
  ctx.dueOf = dueOf;

  // R59 (CP6, lead): the goals an idea can be sorted into. Without a home: the project's goals, as before.
  // With a home: its goals in the home repo, plus the home repo's goals no card has claimed yet, when no other
  // shown project shares that home (a shared repo's empty goal belongs to nobody in particular).
  ctx.sortGoalsOf = (key) => {
    const keysOf = (m) => (Array.isArray(m.projectKeys) ? m.projectKeys : m.projectKey === null || m.projectKey === undefined ? [] : [m.projectKey]);
    const home = typeof ctx.homeOf === 'function' ? ctx.homeOf(key) : null;
    if (typeof home !== 'string' || home === '') return out.filter((m) => keysOf(m).includes(key));
    const h = home.toLowerCase();
    const shared = ctx.shown.some((p) => p.key !== key && String(ctx.homeOf(p.key) ?? '').toLowerCase() === h);
    return out.filter((m) => String(ctx.goalRepoOf(m)).toLowerCase() === h
      && (keysOf(m).includes(key) || (!shared && keysOf(m).length === 0)));
  };
}
