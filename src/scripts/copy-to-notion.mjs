// Copies the GitHub board into the four Notion tables. Usage:
//   node scripts/copy-to-notion.mjs <plan|apply|verify> --notion <file> [--out <dir>] [--json] [--confirm]
// Built to reference/notion-native/interface.md, section 6; contract R153. GitHub is only ever read.
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOwnerHttp } from '../board/github/owners.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { readEnv } from '../board/env.mjs';
import { BOUND } from './lib/copy-apply.mjs';
import { createScrub, createPacer, readJsonFile, writeJsonAtomic } from './lib/migrate-io.mjs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const RECORD_FILE = 'copy-record.json';
export const PLAN_FILE = 'plan.json';
export const VERIFY_FILE = 'copy-verify.json';
const USAGE = 'Use: copy-to-notion.mjs <plan|apply|verify> --notion <file> [--out <dir>] [--json] [--confirm].';
const NO_CONFIRM = 'Apply writes to Notion, so it needs --confirm; nothing was written.';
const NO_TOKEN = 'Set BOARD_NOTION_TOKEN to a Notion token that can write your four data sources.';
const UNEXPECTED = 'The copy stopped because of a problem it did not expect; the record holds everything done so far.';
const ID_KEYS = ['projects', 'tasks', 'goals', 'habitLog'];
const GITHUB_ORIGIN = 'https://api.github.com';
const SENTENCES = {
  auth: 'GitHub did not accept the token.',
  'not-found': 'GitHub could not find that address.',
  network: 'GitHub could not be reached.',
  invalid: 'GitHub did not accept that request.',
  server: 'GitHub had a problem answering.',
};
const NOTION_SENTENCES = {
  auth: 'Notion did not accept the token.',
  'not-found': 'Notion could not find that data source or page; check the ids and what the token can see.',
  conflict: 'Notion refused the change because the page changed at the same time.',
  'rate-limited': 'Notion is limiting requests right now; run the same command again later.',
  unavailable: 'Notion could not be reached.',
  invalid: 'Notion did not accept that request.',
};
const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['plan', 'apply', 'verify'].includes(command)) return { error: USAGE };
  const f = { command, notion: null, out: null, json: false, confirm: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--notion' || a === '--out') {
      const v = rest[i + 1];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value. ${USAGE}` };
      f[a.slice(2)] = v;
      i += 1;
    } else if (a === '--json') f.json = true;
    else if (a === '--confirm') f.confirm = true;
    else return { error: USAGE };
  }
  return f;
}

// The scrub of migrate-io plus the Notion token (and anything shaped like one).
function makeScrub(env) {
  const base = createScrub(env);
  const t = env && typeof env.BOARD_NOTION_TOKEN === 'string' ? env.BOARD_NOTION_TOKEN : '';
  const values = [...new Set([t, t.trim()].filter((v) => v !== ''))].sort((a, b) => b.length - a.length);
  const shapes = [/\bsecret_[A-Za-z0-9]{20,}/g, /\bntn_[A-Za-z0-9]{20,}/g];
  return (text) => {
    let s = base(text);
    for (const v of values) s = s.split(v).join('***');
    for (const re of shapes) s = s.replace(re, '***');
    return s;
  };
}

// R153: GitHub gets reads only. Any non-GET to api.github.com throws before the real fetch is called.
export function guardGithubFetch(realFetch) {
  return (input, init) => {
    let url = '';
    try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url ? input.url : ''; } catch { url = ''; }
    let origin = null;
    try { origin = new URL(url).origin; } catch { origin = null; }
    const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (origin === GITHUB_ORIGIN && method !== 'GET') throw new Error('The copier sends GitHub nothing but reads.');
    return realFetch(input, init);
  };
}

async function readNotionIds(path) {
  const r = await readJsonFile(path);
  if (!r.ok) return { error: r.missing ? 'The Notion ids file was not found.' : 'The Notion ids file could not be read as JSON.' };
  const j = r.json;
  const ok = j && typeof j === 'object' && !Array.isArray(j) && ID_KEYS.every((k) => typeof j[k] === 'string' && j[k].trim() !== '');
  if (!ok) return { error: 'The Notion ids file must hold the four data source ids: projects, tasks, goals and habitLog.' };
  return { ids: Object.fromEntries(ID_KEYS.map((k) => [k, j[k].trim()])) };
}

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const clock = deps.clock ?? realClock;
  const scrub = makeScrub(env);
  const rawOut = deps.out ?? ((l) => console.log(l));
  const rawErr = deps.err ?? ((l) => console.error(l));
  const out = (l) => rawOut(scrub(l));
  const err = (l) => rawErr(scrub(l));
  const fail = (l) => { err(l); return 1; };
  let command = null;
  try {
    const args = parseArgs(argv);
    if (args.error) return fail(args.error);
    command = args.command;
    if (command === 'apply' && !args.confirm) return fail(NO_CONFIRM);
    if (!args.notion) return fail(`--notion is required. ${USAGE}`);

    const notion = await readNotionIds(resolve(cwd, args.notion));
    if (notion.error) return fail(notion.error);
    const notionIds = notion.ids;
    const outDir = resolve(cwd, args.out || 'migration/notion-copy');

    const token = typeof env.BOARD_NOTION_TOKEN === 'string' ? env.BOARD_NOTION_TOKEN.trim() : '';
    if (!token) return fail(NO_TOKEN);
    // readEnv refuses a GitHub env with BOARD_BACKEND=notion; the copier reads GitHub, so it never sees that choice.
    const { BOARD_BACKEND: dropped, ...githubEnv } = env; // eslint-disable-line no-unused-vars
    const e = readEnv(githubEnv);
    if (!e.ok) return fail(e.message);

    const realFetch = deps.fetch ?? globalThis.fetch;
    const guarded = guardGithubFetch(realFetch);
    const owners = deps.owners ?? createOwnerHttp({ defaultToken: e.env.token, tokens: e.env.githubTokens, fetch: guarded });
    const http = createNotionHttp({ token, fetch: guarded, sleep: clock.sleep });
    const pacer = createPacer(clock);
    const now = new Date(clock.now()).toISOString();

    const { readSource, buildCopyPlan, planLines } = await import('./lib/copy-plan.mjs');
    const source = await readSource({ owners, repo: e.env.repo, now });
    const plan = buildCopyPlan(source, notionIds);

    if (command === 'verify') {
      const loaded = await readJsonFile(join(outDir, RECORD_FILE));
      if (!loaded.ok || !loaded.json || typeof loaded.json.rows !== 'object') {
        return fail(loaded.missing ? `There is no ${RECORD_FILE} in ${outDir}; run apply first.` : `${RECORD_FILE} could not be read.`);
      }
      const ours = loaded.json.notionIds;
      if (!ours || ID_KEYS.some((k) => ours[k] !== notionIds[k])) return fail(BOUND);
      if (!plan.ok) { plan.refusals.forEach(err); return fail('Verify refused: the plan built from GitHub has problems. Nothing was compared.'); }
      const { runCopyVerify } = await import('./lib/copy-verify.mjs');
      const result = await runCopyVerify({ plan, http, notionIds, record: loaded.json, say: out });
      await writeJsonAtomic(join(outDir, VERIFY_FILE), { at: new Date(clock.now()).toISOString(), pass: result.pass, rows: result.rows }, scrub);
      return result.pass ? 0 : 1;
    }

    if (command === 'plan') {
      if (args.json) out(JSON.stringify(plan, null, 2));
      else planLines(plan).forEach(plan.ok ? out : err);
      if (!plan.ok) return 1;
      await writeJsonAtomic(join(outDir, PLAN_FILE), { ...plan, at: new Date(clock.now()).toISOString() }, scrub);
      return 0;
    }

    // apply
    if (!plan.ok) { plan.refusals.forEach(err); err(`Apply refused: ${plan.refusals.length} problem${plan.refusals.length === 1 ? '' : 's'}. Nothing was written.`); return 1; }
    const saved = await readJsonFile(join(outDir, PLAN_FILE));
    if (!saved.ok) return fail(saved.missing ? `There is no ${PLAN_FILE} in ${outDir}; run plan first.` : `${PLAN_FILE} could not be read; run plan again.`);
    if (!saved.json || saved.json.digest !== plan.digest) return fail('GitHub changed after the plan was made; run plan again.');
    const { runCopy, emptyCopyRecord } = await import('./lib/copy-apply.mjs');
    const prior = await readJsonFile(join(outDir, RECORD_FILE));
    if (!prior.ok && !prior.missing) return fail(`${RECORD_FILE} exists but could not be read; move it away first.`);
    const record = prior.ok && prior.json && typeof prior.json === 'object' ? prior.json : emptyCopyRecord(new Date(clock.now()).toISOString(), notionIds);
    if (!record.rows || typeof record.rows !== 'object') record.rows = {};
    if (!Array.isArray(record.planDigests)) record.planDigests = [];
    const save = async (r) => writeJsonAtomic(join(outDir, RECORD_FILE), r ?? record, scrub);
    const writeConfig = async (name, text) => {
      const rel = String(name).replace(/\\/g, '/');
      if (isAbsolute(rel) || rel.split('/').includes('..') || rel === '') throw new Error('A config file name was not a plain relative path.');
      const target = join(outDir, rel.startsWith('config/') ? rel : `config/${rel}`);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      await writeFile(tmp, scrub(typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`), 'utf8');
      await rename(tmp, target);
    };
    const result = await runCopy({ plan, http, notionIds, record, save, say: out, pace: pacer.pace, outDir, writeConfig });
    if (result && result.ok === false) return fail(result.message || UNEXPECTED);
    return 0;
  } catch (x) {
    if (x && x.name === 'GitHubError' && SENTENCES[x.kind]) return fail(`${SENTENCES[x.kind]} ${UNEXPECTED}`);
    if (x && x.name === 'BackendError' && NOTION_SENTENCES[x.code]) return fail(`${NOTION_SENTENCES[x.code]} ${UNEXPECTED}`);
    return fail(UNEXPECTED);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, fetch: globalThis.fetch, cwd: process.cwd(), out: (l) => console.log(l), err: (l) => console.error(l),
  });
}
