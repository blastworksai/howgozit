// meta stage: real. model.mjs fills sources and warnings afterwards.
import { isoWeek, timeIn } from '../days.mjs';

export default function meta(ctx) {
  const hour = Number((timeIn(ctx.tz, ctx.now) ?? '00:00').slice(0, 2)); // R94
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const s = ctx.settings;
  const run = ctx.run ?? {};
  const repo = typeof ctx.raw?.repo === 'string' ? ctx.raw.repo : '';
  const stale = run.stale && typeof run.stale === 'object' ? run.stale : null;
  return {
    meta: {
      generatedAt: ctx.now,
      today: ctx.today,
      timezone: ctx.tz,
      name: typeof s.name === 'string' ? s.name : '',
      greeting,
      weekNumber: isoWeek(ctx.today) ?? 1,
      agentName: s.agentName,
      repoUrl: ctx.raw?.source === 'notion' ? 'https://www.notion.so/' : `https://github.com/${repo}`,
      stale,
      readOnly: run.readOnly === true,
      sources: [],
      warnings: [],
    },
  };
}
