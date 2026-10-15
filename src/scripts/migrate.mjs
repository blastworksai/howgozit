// Moves cards and goals out of the source repo into their home repos. Usage:
//   node scripts/migrate.mjs <plan|apply|verify|delete> [--map <path>] [--out <dir>] [--json] [--confirm]
// Built to reference/mapping-redesign/cp8-interface.md, section 5.
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOwnerHttp } from '../board/github/owners.mjs';
import { readEnv } from '../board/env.mjs';
import { validateMap, readWorld, buildPlan, planLines } from './lib/migrate-plan.mjs';
import {
  createScrub, createPacer, readJsonFile, writeJsonAtomic, loadRecord, emptyRecord, runVerify, runDelete, RECORD_FILE, PLAN_FILE,
} from './lib/migrate-io.mjs';

const USAGE = 'Use: migrate.mjs <plan|apply|verify|delete> [--map <path>] [--out <dir>] [--json] [--confirm].';
const UNEXPECTED = 'The migration stopped because of a problem it did not expect; the record holds everything done so far.';
const DEFAULT_MAP = fileURLToPath(new URL('../../reference/mapping-redesign/migration-map.json', import.meta.url));
const SENTENCES = {
  auth: 'GitHub did not accept the token.',
  'not-found': 'GitHub could not find that address.',
  network: 'GitHub could not be reached.',
  invalid: 'GitHub did not accept that request.',
  server: 'GitHub had a problem answering.',
};
const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['plan', 'apply', 'verify', 'delete'].includes(command)) return { error: USAGE };
  const f = { command, map: null, out: null, json: false, confirm: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--map' || a === '--out') {
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

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const clock = deps.clock ?? realClock;
  const scrub = createScrub(env);
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

    const mapPath = args.map ? resolve(cwd, args.map) : DEFAULT_MAP;
    const outDir = resolve(cwd, args.out || 'migration');
    const read = await readJsonFile(mapPath);
    if (!read.ok) return fail(read.missing ? `The migration map ${args.map || 'migration-map.json'} was not found.` : 'The migration map could not be read as JSON.');
    const valid = validateMap(read.json);
    if (!valid.ok) { valid.errors.forEach(err); return 1; }
    const map = read.json;

    const e = readEnv(env);
    if (!e.ok) return fail(e.message);
    const owners = deps.owners ?? createOwnerHttp({ defaultToken: e.env.token, tokens: e.env.githubTokens, fetch: deps.fetch ?? globalThis.fetch });
    const boardRepo = e.env.repo;
    const pacer = createPacer(clock);
    const base = { clients: owners, owners, map, outDir, say: out, err, clock, scrub, boardRepo, pacer, confirm: args.confirm };

    if (command === 'verify') return await runVerify(base);
    if (command === 'delete') return await runDelete(base);

    const early = await loadRecord(outDir);
    const defaultRepos = early.state === 'ok'
      ? early.record.targets.filter((t) => t && t.kind === 'repo' && t.repo && t.ours === true).map((t) => t.repo)
      : [];
    const world = await readWorld(owners, map, { boardRepo, defaultRepos });
    const plan = buildPlan(world, map);

    if (command === 'plan') {
      const shown = { ok: plan.ok, refusals: plan.refusals, issues: plan.issues, milestones: plan.milestones, targets: plan.targets, ideas: plan.ideas, notes: plan.notes, digest: plan.digest };
      if (!plan.ok) {
        if (args.json) out(JSON.stringify(shown, null, 2));
        else planLines(plan).forEach(err);
        return 1;
      }
      if (args.json) out(JSON.stringify(shown, null, 2));
      else planLines(plan).forEach(out);
      await writeJsonAtomic(join(outDir, PLAN_FILE), { ...shown, at: new Date(Date.now()).toISOString() }, scrub);
      return 0;
    }

    // apply
    if (!plan.ok) { plan.refusals.forEach(err); err(`Apply refused: ${plan.refusals.length} problem${plan.refusals.length === 1 ? '' : 's'}. Nothing was written.`); return 1; }
    const saved = await readJsonFile(join(outDir, PLAN_FILE));
    if (!saved.ok) return fail(saved.missing ? `There is no ${PLAN_FILE} in ${outDir}; run plan first.` : `${PLAN_FILE} could not be read; run plan again.`);
    if (!saved.json || saved.json.digest !== plan.digest) return fail('The board changed after the plan was made; run plan again.');
    const loaded = await loadRecord(outDir);
    if (loaded.state === 'bad') return fail(`${RECORD_FILE} exists but could not be read; move it away first.`);
    const record = loaded.state === 'ok' ? loaded.record : emptyRecord(map.source, new Date(clock.now()).toISOString());
    if (!record.planDigests.includes(plan.digest)) record.planDigests.push(plan.digest);
    const save = async (r) => writeJsonAtomic(join(outDir, RECORD_FILE), r ?? record, scrub);
    await save(record);
    const { runApply } = await import('./lib/migrate-apply.mjs');
    const result = await runApply({
      map, plan, world, owners, clock, record, outDir, say: out, save, pace: pacer.pace,
      writeNext: (obj) => writeJsonAtomic(join(outDir, 'board.config.next.json'), obj, scrub),
    });
    if (result && result.ok === false) return fail(result.message || UNEXPECTED);
    return 0;
  } catch (x) {
    if (x && (x.kind === 'rate-limit' || x.code === 'rate-limited')) return fail(`GitHub is limiting writes; run ${command || 'the command'} again later.`);
    if (x && x.name === 'GitHubError' && SENTENCES[x.kind]) return fail(`${SENTENCES[x.kind]} ${UNEXPECTED}`);
    return fail(UNEXPECTED);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, fetch: globalThis.fetch, cwd: process.cwd(), out: (l) => console.log(l), err: (l) => console.error(l),
  });
}
void readFile;
