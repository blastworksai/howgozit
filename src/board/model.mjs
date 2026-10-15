// model: prepare, then every stage, then the cross-stage fills (contract R5). Pure; never throws for objects.
import { EMPTY, prepare } from './prepare.mjs';
import { isHexColor } from './shape-settings.mjs';
import meta from './stages/meta.mjs';
import projects from './stages/projects.mjs';
import timeline from './stages/timeline.mjs';
import focus from './stages/focus.mjs';
import next from './stages/next.mjs';
import ideas from './stages/ideas.mjs';
import habits from './stages/habits.mjs';
import extras from './stages/extras.mjs';
import panels from './stages/panels.mjs';

export { EMPTY };

const STAGES = [
  ['meta', meta], ['projects', projects], ['timeline', timeline], ['focus', focus], ['next', next],
  ['ideas', ideas], ['habits', habits], ['extras', extras], ['panels', panels],
];
const PANEL_IDS = ['brief', 'calendar', 'inbox', 'log'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fallbackCtx() {
  const counts = {};
  return {
    now: '1970-01-01T00:00:00Z', today: '1970-01-01', tz: 'UTC',
    settings: { weekStart: 'monday' }, theme: {}, state: {}, run: { stale: null, readOnly: false, warnings: [] },
    raw: {}, warnCounts: counts,
    warn: (code, n = 1) => { counts[code] = (counts[code] || 0) + n; },
  };
}

export function buildBoard(input = {}) {
  let ctx;
  let prepFailed = false;
  try {
    ctx = prepare(isObj(input) ? input : {});
  } catch {
    ctx = fallbackCtx();
    prepFailed = true;
    ctx.warn('part-failed');
  }

  const board = {};
  for (const [name, stage] of STAGES) {
    let out;
    try {
      if (prepFailed) throw new Error('no context');
      out = stage(ctx);
      if (!isObj(out)) throw new Error('bad stage result');
    } catch {
      if (!prepFailed) ctx.warn('part-failed');
      out = EMPTY[name](ctx);
    }
    Object.assign(board, out);
  }

  try {
    const hs = Array.isArray(board.habits) ? board.habits : [];
    if (Array.isArray(board.projects)) {
      board.projects = board.projects.map((p) => ({
        ...p,
        habits: hs.filter((h) => h?.project?.key === p.key).map((h) => ({ id: h.id, title: h.title, streak: h.streak })),
      }));
    }
  } catch {
    ctx.warn('part-failed');
    board.projects = [];
  }

  // R132, R76: the top-level modes, only when the settings name them; a bad colour falls back and is counted.
  if (!prepFailed && Array.isArray(ctx.modeList)) {
    try {
      const colors = isObj(ctx.raw?.labelColors) ? ctx.raw.labelColors : {};
      const fallback = ctx.theme?.colors?.muted;
      board.modes = ctx.modeList.map((md) => {
        const v = Object.prototype.hasOwnProperty.call(colors, md.key) ? colors[md.key] : undefined;
        let color = fallback;
        if (v !== undefined && v !== null) {
          if (isHexColor(v)) color = v;
          else ctx.warn('color-invalid');
        }
        return { n: md.n, name: md.name, color };
      });
    } catch {
      ctx.warn('part-failed');
    }
  }

  const m = board.meta;
  const run = ctx.run ?? {};
  const sources = [{
    id: ctx.raw?.source === 'notion' ? 'notion' : 'github',
    state: run.stale ? 'stale' : 'ok',
    at: typeof ctx.raw?.fetchedAt === 'string' ? ctx.raw.fetchedAt : null,
  }];
  const pn = isObj(board.panels) ? board.panels : {};
  for (const id of PANEL_IDS) {
    const p = pn[id];
    if (p === null || p === undefined) continue;
    sources.push({ id, state: p.error ? 'error' : p.stale ? 'stale' : 'ok', at: null });
  }
  m.sources = sources;

  const merged = { ...ctx.warnCounts };
  const mergedNames = {}; // R125: the six Google codes and project-owner-unreadable only
  if (Array.isArray(run.warnings)) {
    for (const w of run.warnings) {
      if (isObj(w) && typeof w.code === 'string' && Number.isInteger(w.count) && w.count > 0) {
        merged[w.code] = (merged[w.code] || 0) + w.count;
        if ((/^calendar-google-/.test(w.code) || w.code === 'project-owner-unreadable') && Array.isArray(w.names)) {
          const have = mergedNames[w.code] || (mergedNames[w.code] = []);
          for (const n of w.names) if (typeof n === 'string' && !have.includes(n)) have.push(n);
        }
      }
    }
  }
  m.warnings = Object.keys(merged).sort().filter((c) => merged[c] > 0)
    .map((code) => (mergedNames[code] ? { code, count: merged[code], names: mergedNames[code] } : { code, count: merged[code] }));
  return board;
}
