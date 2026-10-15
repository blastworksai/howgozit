// extras: the 12-week map (R47) and the season (R48).
// Pure: no clock, no file, no network, no environment. Never mutates its inputs; never throws for odd data.
import { addDays, dateIn, diffDays, isDate, weekStart } from '../days.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function levelOf(n) {
  if (n >= 6) return 4;
  if (n >= 4) return 3;
  if (n >= 2) return 2;
  return n >= 1 ? 1 : 0;
}

function buildHeatmap(ctx) {
  const first = weekStart(ctx.today, ctx.settings?.weekStart === 'sunday' ? 'sunday' : 'monday');
  const counts = new Map();
  for (const issue of Array.isArray(ctx.issues) ? ctx.issues : []) {
    if (!isObj(issue) || issue.state !== 'closed' || typeof issue.closed_at !== 'string') continue;
    const date = dateIn(ctx.tz, issue.closed_at);
    if (date === null) continue;
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  const weeks = [];
  for (let w = 0; w < 12; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(first, (w - 11) * 7 + d);
      if (date > ctx.today) {
        week.push({ date, count: null, level: null });
      } else {
        const count = counts.get(date) || 0;
        week.push({ date, count, level: levelOf(count) });
      }
    }
    weeks.push(week);
  }
  return { weeks };
}

function buildSeason(ctx) {
  const s = ctx.settings?.season;
  if (!isObj(s)) return null;
  const start = typeof s.start === 'string' ? s.start : '';
  const end = typeof s.end === 'string' ? s.end : '';
  const left = isDate(end) ? diffDays(ctx.today, end) : null;
  const daysLeft = left === null ? 0 : Math.max(0, left);
  let phase = 'running';
  if (isDate(end) && end < ctx.today) phase = 'after';
  else if (isDate(start) && start > ctx.today) phase = 'before';

  const shown = new Set((Array.isArray(ctx.shown) ? ctx.shown : []).map((p) => p.key));
  const goals = [];
  for (const g of Array.isArray(s.goals) ? s.goals : []) {
    if (!isObj(g)) continue;
    const title = typeof g.title === 'string' ? g.title : '';
    let pct = null;
    if (typeof g.project === 'string' && g.project !== '') {
      if (shown.has(g.project) && typeof ctx.progress === 'function') {
        const p = ctx.progress(g.project)?.pct;
        pct = Number.isInteger(p) ? p : null;
      } else {
        ctx.warn('goal-project-unknown');
      }
    }
    goals.push({ title, pct });
  }
  return { name: typeof s.name === 'string' ? s.name : '', start, end, daysLeft, phase, goals };
}

export default function extras(ctx) {
  return { heatmap: buildHeatmap(ctx), season: buildSeason(ctx) };
}
