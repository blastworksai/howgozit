// Compares the GitHub board with the Notion board, built with the same clock. Usage:
//   node scripts/compare-boards.mjs --github-config <dir|-> --notion-config <dir> [--out <file>]
// Built to reference/notion-native/interface.md, section 6.4. Reads only; GitHub gets nothing but GETs.
import { resolve } from 'node:path';
import { readFile as fsReadFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readEnv } from '../board/env.mjs';
import { createOwnerHttp } from '../board/github/owners.mjs';
import { createGithubAdapter } from '../board/github/adapter.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { createScrub, writeJsonAtomic } from './lib/migrate-io.mjs';
import { guardGithubFetch } from './copy-to-notion.mjs';

const USAGE = 'Use: compare-boards.mjs --github-config <dir|-> --notion-config <dir> [--out <file>].';
const NO_NOTION_TOKEN = 'Set BOARD_NOTION_TOKEN to a Notion token that can read your four data sources.';
const UNEXPECTED = 'The comparison stopped because of a problem it did not expect.';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// Differences that are not failures: the two back-ends do not share these.
const EXPECTED = [
  { field: 'urls', note: 'Cards, goals and projects link to GitHub on one board and to Notion on the other.' },
  { field: 'tag', note: 'The GH / NT back-end tag differs by design.' },
  { field: 'refs', note: 'Card refs read owner/repo#n on GitHub and a Notion ID on Notion.' },
  { field: 'timeline-map', note: 'The 12-week map differs: Notion holds no closed history.' },
  { field: 'goal-placement', note: 'A goal sits under its project on Notion by its Project relation; on GitHub a home-repo goal joins a project only through an open card in it (by design: Notion\'s way is kept).' },
];

function flatGoals(board) {
  const t = isObj(board.timeline) ? board.timeline : {};
  const out = [];
  const add = (m) => { if (isObj(m)) out.push(m); };
  for (const lane of list(t.lanes)) { list(lane.milestones).forEach(add); list(lane.undated).forEach(add); }
  list(t.other).forEach(add);
  return out;
}

// Every goal with the lane it sits in: the lane's project key (lane.project.key), or 'other'.
function placedGoals(board) {
  const t = isObj(board.timeline) ? board.timeline : {};
  const out = [];
  const add = (m, lane) => { if (isObj(m)) out.push({ name: `${m.shortTitle} / ${m.pct}%`, lane }); };
  for (const l of list(t.lanes)) {
    const lane = isObj(l) && isObj(l.project) && l.project.key !== undefined ? String(l.project.key) : 'lane';
    list(l && l.milestones).forEach((m) => add(m, lane));
    list(l && l.undated).forEach((m) => add(m, lane));
  }
  list(t.other).forEach((m) => add(m, 'other'));
  return out;
}

// The facts compared, each as { section: { key: value } }; a value is a string or a structured array (never a joined string).
export function summarise(board) {
  const b = isObj(board) ? board : {};
  const s = { projects: {}, next: {}, goals: {}, ideas: {}, habits: {} };
  for (const p of list(b.projects)) {
    if (!isObj(p)) continue;
    s.projects[String(p.key)] = `${p.title} / ${Number(p.total) - Number(p.done)} open`;
  }
  s.next.order = list(b.next).map((n) => (isObj(n) ? String(n.title) : '')); // ordered: What's next is a ranking
  s.goals.all = flatGoals(b).map((m) => `${m.shortTitle} / ${m.pct}%`).sort(); // order is not a fact
  s.ideas.titles = list(b.ideas && b.ideas.items).map((i) => (isObj(i) ? String(i.title) : '')).sort();
  for (const h of list(b.habits)) {
    if (!isObj(h)) continue;
    s.habits[String(h.id)] = `today ${h.doneToday === true ? 'done' : 'not done'} / streak ${h.streak}`;
  }
  return s;
}

// Per-element difference of two lists: what only GitHub has, what only Notion has (counted, so duplicates matter).
export function elementDiff(a, b) {
  const rest = [...b];
  const onlyGithub = [];
  for (const v of a) {
    const i = rest.indexOf(v);
    if (i === -1) onlyGithub.push(v); else rest.splice(i, 1);
  }
  return { onlyGithub, onlyNotion: rest };
}

// compareBoards(a, b): two board objects -> { same, differ, expected }. `a` is GitHub, `b` is Notion. Pure.
export function compareBoards(a, b) {
  const x = summarise(a);
  const y = summarise(b);
  const same = [];
  const differ = [];
  for (const section of Object.keys(x)) {
    const keys = [...new Set([...Object.keys(x[section]), ...Object.keys(y[section])])].sort();
    for (const key of keys) {
      const label = section === 'projects' || section === 'habits' ? `${section}:${key}` : `${section}`;
      const av = Object.prototype.hasOwnProperty.call(x[section], key) ? x[section][key] : null;
      const bv = Object.prototype.hasOwnProperty.call(y[section], key) ? y[section][key] : null;
      if (JSON.stringify(av) === JSON.stringify(bv)) same.push(label);
      else if (Array.isArray(av) && Array.isArray(bv)) {
        differ.push({ item: label, github: av, notion: bv, ...elementDiff(av, bv) });
      } else differ.push({ item: label, github: av, notion: bv });
    }
  }
  // Placement (ruled): only goals both boards hold the same number of times; a goal missing on one side is a real difference above.
  const pa = placedGoals(a && isObj(a) ? a : {});
  const pb = placedGoals(b && isObj(b) ? b : {});
  const count = (xs, n) => xs.filter((g) => g.name === n).length;
  const both = new Set(pa.map((g) => g.name).filter((n) => count(pa, n) === count(pb, n)));
  const fmt = (xs) => xs.filter((g) => both.has(g.name)).map((g) => `${g.name} @ ${g.lane}`).sort();
  const pd = elementDiff(fmt(pa), fmt(pb));
  const ruled = pd.onlyGithub.length === 0 && pd.onlyNotion.length === 0
    ? []
    : [{ item: 'goal-placement', ruling: EXPECTED.find((e) => e.field === 'goal-placement').note, count: Math.max(pd.onlyGithub.length, pd.onlyNotion.length), ...pd }];
  return { same, differ, ruled, expected: EXPECTED.map((e) => ({ ...e })) };
}

function parseArgs(argv) {
  const f = { github: null, notion: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const key = a === '--github-config' ? 'github' : a === '--notion-config' ? 'notion' : a === '--out' ? 'out' : null;
    if (!key) return { error: USAGE };
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('--') && v !== '-')) return { error: `${a} needs a value. ${USAGE}` };
    f[key] = v;
    i += 1;
  }
  if (!f.github || !f.notion) return { error: USAGE };
  return f;
}

async function boardFrom(adapter, env, now) {
  const loader = createLoader({ http: null, env, cache: null, clock: { now: () => Date.parse(now) }, adapter });
  const result = await loader.load({ full: true });
  if (!result.ok) throw new Error(result.notice.message);
  const { bundle } = result;
  if (bundle.run.stale) throw new Error(bundle.run.stale.reason);
  return buildBoard({ raw: bundle.raw, settings: bundle.settings, theme: bundle.theme, state: bundle.state, now, run: bundle.run });
}

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const clock = deps.clock ?? { now: () => Date.now() };
  const scrubBase = createScrub(env);
  const nt = typeof env.BOARD_NOTION_TOKEN === 'string' ? env.BOARD_NOTION_TOKEN : '';
  const scrub = (t) => { let s = scrubBase(t); if (nt.trim() !== '') s = s.split(nt.trim()).join('***'); return s.replace(/\b(?:secret|ntn)_[A-Za-z0-9]{20,}/g, '***'); };
  const out = (l) => (deps.out ?? ((m) => console.log(m)))(scrub(l));
  const err = (l) => (deps.err ?? ((m) => console.error(m)))(scrub(l));
  const fail = (l) => { err(l); return 1; };
  try {
    const args = parseArgs(argv);
    if (args.error) return fail(args.error);
    const token = nt.trim();
    if (!token) return fail(NO_NOTION_TOKEN);
    const { BOARD_BACKEND: dropped, ...githubEnv } = env; // eslint-disable-line no-unused-vars
    const e = readEnv(githubEnv);
    if (!e.ok) return fail(e.message);

    const readFile = deps.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    const guarded = guardGithubFetch(deps.fetch ?? globalThis.fetch);
    const now = new Date(clock.now()).toISOString();

    const owners = createOwnerHttp({ defaultToken: e.env.token, tokens: e.env.githubTokens, fetch: guarded });
    const ghConfig = args.github === '-' ? null : resolve(cwd, args.github);
    const ghAdapter = createGithubAdapter({ http: owners.default, httpFor: (o) => owners.forOwner(o), repo: e.env.repo, configDir: ghConfig, readFile, gh: null });
    const ntConfig = resolve(cwd, args.notion);
    const ntAdapter = createNotionAdapter({ http: createNotionHttp({ token, fetch: guarded }), configDir: ntConfig, readFile });

    const a = await boardFrom(ghAdapter, { repo: e.env.repo, backend: 'github', configDir: ghConfig, readOnly: true }, now);
    const b = await boardFrom(ntAdapter, { repo: 'notion', backend: 'notion', configDir: ntConfig, readOnly: true }, now);

    const result = { at: now, ...compareBoards(a, b) };
    out(`Boards compared: ${result.same.length} the same, ${result.differ.length} different, ${result.ruled.reduce((n, r) => n + r.count, 0)} goals placed differently (ruled, see below), ${result.expected.length} expected differences not counted.`);
    for (const d of result.differ.slice(0, 30)) out(`  ${d.item}: GitHub ${JSON.stringify(d.github)} / Notion ${JSON.stringify(d.notion)}`);
    for (const r of result.ruled) for (const g of r.onlyGithub) out(`  ruled ${r.item}: GitHub only ${JSON.stringify(g)}`);
    for (const r of result.ruled) for (const g of r.onlyNotion) out(`  ruled ${r.item}: Notion only ${JSON.stringify(g)}`);
    if (args.out) await writeJsonAtomic(resolve(cwd, args.out), result, scrub);
    return 0;
  } catch (x) {
    return fail(x && x.message && /^(Notion|GitHub|The board|The settings|No settings)/.test(x.message) ? `${x.message} ${UNEXPECTED}` : UNEXPECTED);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, fetch: globalThis.fetch, cwd: process.cwd(), out: (l) => console.log(l), err: (l) => console.error(l),
  });
}
