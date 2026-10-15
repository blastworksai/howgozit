// Habits (contract R36 to R45). Pure: reads ctx only.
import { addDays, dateIn, diffDays, isDate } from '../days.mjs';
import { flames, simulate } from '../streaks.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export default function habits(ctx) {
  const cfg = Array.isArray(ctx.settings?.habits) ? ctx.settings.habits : [];
  const tokenEvery = ctx.settings?.streak?.tokenEvery;
  const tiers = ctx.settings?.streak?.flameTiers;
  const shown = Array.isArray(ctx.shown) ? ctx.shown : [];
  const checkins = Array.isArray(ctx.checkins) ? ctx.checkins : [];
  const today = ctx.today;
  const out = [];

  for (const h of cfg) {
    if (!isObj(h) || typeof h.id !== 'string') continue;
    const mine = checkins.filter((c) => c.habitId === h.id);

    let start = isDate(h.start) ? h.start : null;
    if (start === null) {
      for (const c of mine) if (start === null || c.date < start) start = c.date;
    }
    if (start === null) start = today;

    const scored = isObj(h.score) && typeof ctx.scoreOf === 'function';
    const doneDays = new Set();
    const dayScore = new Map(); // R137: the score of the done check-in updated last (ties: higher number)
    const best = new Map();
    for (const c of mine) {
      const iss = c.issue;
      if (scored && iss) ctx.scoreOf(iss); // counts an unreadable score once per check-in (R136)
      if (!iss || iss.state !== 'closed' || typeof iss.closed_at !== 'string') continue;
      if (dateIn(ctx.tz, iss.closed_at) !== c.date) continue;
      doneDays.add(c.date);
      if (!scored) continue;
      const at = typeof iss.updated_at === 'string' ? iss.updated_at : '';
      const prev = best.get(c.date);
      if (prev === undefined || at > prev.at || (at === prev.at && iss.number > prev.number)) {
        best.set(c.date, { at, number: iss.number });
        dayScore.set(c.date, ctx.scoreOf(iss));
      }
    }

    const n = diffDays(start, today);
    const started = n !== null && n >= 0;
    const walk = [];
    if (started) for (let i = 0; i < n; i++) walk.push(doneDays.has(addDays(start, i)));
    const doneToday = started && doneDays.has(today);
    const sim = simulate({ days: walk, todayDone: doneToday, tokenEvery });
    const f = flames(sim.streak, tiers);

    const recent = [];
    for (let k = 13; k >= 0; k--) {
      const date = addDays(today, -k);
      const idx = diffDays(start, date);
      let status = 'before';
      if (idx !== null && idx >= 0) status = sim.statuses[idx] ?? 'before';
      if (scored) recent.push({ date, status, score: doneDays.has(date) ? dayScore.get(date) ?? null : null });
      else recent.push({ date, status });
    }

    let project = null;
    if (typeof h.project === 'string') {
      const p = shown.find((s) => s && s.key === h.project);
      if (p) project = { key: p.key, color: p.color };
      else ctx.warn('habit-project-unknown');
    }

    out.push({
      id: h.id,
      title: typeof h.title === 'string' ? h.title : h.id,
      project,
      streak: sim.streak,
      best: sim.best,
      tokens: sim.tokens,
      toNextToken: (Number.isInteger(tokenEvery) ? tokenEvery : 6) - sim.counter,
      flamesLit: f.lit,
      flames: f.flames,
      toNextFlame: f.toNext,
      recent,
      doneToday,
      ...(scored ? { score: { min: h.score.min, max: h.score.max, today: doneDays.has(today) ? dayScore.get(today) ?? null : null } } : {}),
    });
  }
  return { habits: out };
}
