// Rules R32 to R35: the idea backlog and the agent's suggestions beside it.
import { dateIn } from '../days.mjs';
import { proposalsStale } from './panels.mjs';

const MAX_ITEMS = 20;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => Number.isInteger(v);

function entriesOf(ctx) {
  const p = ctx?.state?.proposals;
  if (!isObj(p) || !Array.isArray(p.ideas)) return new Map();
  const out = new Map();
  for (const e of p.ideas) {
    if (!isObj(e) || !isNum(e.number)) continue;
    if (!out.has(e.number)) out.set(e.number, e);
  }
  return out;
}

export default function ideas(ctx) {
  const open = (Array.isArray(ctx.ideas) ? ctx.ideas : []).filter((i) => i.state === 'open');
  const sorted = open.slice().sort((a, b) => {
    const pa = Date.parse(a.created_at);
    const pb = Date.parse(b.created_at);
    const ta = Number.isNaN(pa) ? -Infinity : pa;
    const tb = Number.isNaN(pb) ? -Infinity : pb;
    if (ta !== tb) return ta < tb ? 1 : -1;
    return b.number - a.number;
  });
  const entries = entriesOf(ctx);
  const stale = proposalsStale(ctx);
  const shownProjects = Array.isArray(ctx.shown) ? ctx.shown : [];
  const milestones = Array.isArray(ctx.milestones) ? ctx.milestones : [];

  const suggestionFor = (number) => {
    const e = entries.get(number);
    if (!e) return null;
    const project = typeof e.project === 'string' ? e.project : null;
    const milestone = isNum(e.milestone) ? e.milestone : null;
    const newProject = typeof e.newProject === 'string' ? e.newProject : null;
    const proj = project === null ? null : shownProjects.find((s) => s.key === project) || null;
    // an idea is filed in the data repo, so its goal is a data-repo goal (CP6 owns sorting into a home repo)
    // CP6: a project with a home takes its goals from the home repo (the idea moves there when sorted)
    const home = proj && typeof ctx.homeOf === 'function' ? ctx.homeOf(proj.key) : null;
    const goalRepo = typeof home === 'string' && home !== '' ? home.toLowerCase()
      : typeof ctx.raw?.repo === 'string' ? ctx.raw.repo.toLowerCase() : '';
    const ms = milestone === null ? null
      : milestones.find((m) => m.number === milestone && (typeof ctx.goalRepoOf !== 'function' || String(ctx.goalRepoOf(m)).toLowerCase() === goalRepo)) || null;
    const msOk = milestone === null || (ms !== null && Array.isArray(ms.projectKeys) && ms.projectKeys.includes(project) && ms.closed !== true);
    return {
      project,
      projectTitle: proj ? proj.title : null,
      milestone,
      milestoneTitle: ms ? ms.shortTitle ?? null : null,
      newProject,
      why: typeof e.why === 'string' ? e.why : '',
      stale,
      acceptable: !stale && proj !== null && msOk && newProject === null,
    };
  };

  // B5 (CP6): a numbered proposal attaches to a data-repo idea only.
  const dataRepo = typeof ctx.raw?.repo === 'string' ? ctx.raw.repo.toLowerCase() : '';
  const ownedByData = (i) => dataRepo === '' || typeof i.repo !== 'string' || i.repo === '' || i.repo.toLowerCase() === dataRepo;
  const shortOf = (i) => (typeof ctx.shortRef === 'function' ? ctx.shortRef(i) : String(i.number));
  const items = sorted.slice(0, MAX_ITEMS).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    createdAt: dateIn(ctx.tz, i.created_at) ?? '',
    ...(shortOf(i) !== String(i.number) ? { ref: shortOf(i) } : {}),
    suggestion: ownedByData(i) ? suggestionFor(i.number) : null,
  }));
  return { ideas: { count: open.length, shown: items.length, items } };
}
