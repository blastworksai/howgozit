// timeline stage: lanes of milestones in a window of whole months (contract R19, R20).
import { addDays, addMonths, diffDays, monthEnd, monthStart } from '../days.mjs';

const entry = (m, short) => ({
  number: m.number, shortTitle: short ?? m.shortTitle, url: m.url, due: m.due, state: m.state,
  done: m.done, total: m.total, pct: m.pct,
});
const byDateThenNumber = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.number - b.number);

// CP4 (R14): a milestone sits in every lane its projectKeys name; the title path has one at most.
const keysOf = (m) => (Array.isArray(m.projectKeys) ? m.projectKeys : m.projectKey ? [m.projectKey] : []);
const inKey = (m, key) => keysOf(m).includes(key);

export default function timeline(ctx) {
  const repoOf = (m) => (typeof ctx.goalRepoOf === 'function' ? String(ctx.goalRepoOf(m)).toLowerCase() : '');
  const byRepo = (a, b) => (repoOf(a) < repoOf(b) ? -1 : repoOf(a) > repoOf(b) ? 1 : 0);
  const today = ctx.today;
  const all = Array.isArray(ctx.milestones) ? ctx.milestones : [];
  // R19: not done, or done and finished within the last 30 days (a done one with no readable finish day stays).
  const visible = (m) => m.state !== 'done' || m.finishedOn === null || diffDays(m.finishedOn, today) <= 30;
  const shownMs = all.filter(visible);

  const lanes = [];
  for (const p of ctx.shown || []) {
    const mine = shownMs.filter((m) => inKey(m, p.key));
    if (mine.length === 0) continue;
    lanes.push({
      project: { key: p.key, title: p.title, color: p.color, focus: p.focus },
      dated: mine.filter((m) => m.due !== null).sort(byDateThenNumber),
      undated: mine.filter((m) => m.due === null).sort((a, b) => a.number - b.number).map((m) => entry(m)),
    });
  }

  // R20
  let lo = addDays(today, -14);
  let hi = addDays(today, 28);
  for (const l of lanes) {
    for (const m of l.dated) {
      if (m.due < lo) lo = m.due;
      if (m.due > hi) hi = m.due;
    }
  }
  const floor = monthStart(addMonths(monthStart(today), -3));
  const ceil = monthEnd(addMonths(monthStart(today), 11));
  let start = monthStart(lo);
  if (start < floor) start = floor;
  let end = monthEnd(hi);
  if (end > ceil) end = ceil;

  const outLanes = lanes.map((l) => ({
    project: l.project,
    milestones: l.dated.filter((m) => m.due >= start && m.due <= end).map((m) => entry(m)),
    undated: l.undated,
    beforeWindow: l.dated.filter((m) => m.due < start).length,
    beyondWindow: l.dated.filter((m) => m.due > end).length,
  }));

  const other = shownMs.filter((m) => keysOf(m).length === 0)
    .sort((a, b) => a.number - b.number || byRepo(a, b)).map((m) => entry(m, m.title));

  return { timeline: { start, end, today, lanes: outLanes, other } };
}
