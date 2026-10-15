// Sets up the data repository from a proposal file. Usage:
//   node scripts/setup.mjs check --repo owner/name
//   node scripts/setup.mjs plan <proposal.json>
//   node scripts/setup.mjs apply <proposal.json>
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttp } from '../board/github/http.mjs';
import { applyProposal, validateProposal } from './lib/apply.mjs';

const RECORD_FILE = 'setup-undo.json';
const USAGE = 'Use: setup.mjs check --repo owner/name, setup.mjs plan <proposal.json>, or setup.mjs apply <proposal.json>.';

async function readJson(path) {
  try {
    return { ok: true, json: JSON.parse(await readFile(path, 'utf8')) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, missing: false };
  }
}

async function check(http, slug, say) {
  let good = true;
  let repo = null;
  try {
    repo = (await http.get(`/repos/${slug}`)).json;
    say(`Repository ${slug} can be read.`);
  } catch (e) {
    say(e && e.kind === 'not-found' ? `GitHub could not find ${slug}, or the token cannot see it.` : String(e.message));
    return false;
  }
  if (repo.private === true) say('The repository is private.');
  else { say('The repository is not private; setup only works on a private one.'); good = false; }
  const owner = repo.owner || {};
  const base = `${owner.type === 'Organization' ? '/orgs/' : '/users/'}${slug.split('/')[0]}`;
  try {
    const r = await http.paged(`${base}/projectsV2?per_page=100`, { maxPages: 1 });
    say(`The owner's Projects can be listed (${r.items.length} found).`);
  } catch (e) {
    say(`The owner's Projects cannot be listed: ${e.message}`);
    good = false;
  }
  return good;
}

export async function main(argv, { env, fetch, cwd, out, err }) {
  const token = env && env.BOARD_GITHUB_TOKEN ? String(env.BOARD_GITHUB_TOKEN) : '';
  const clean = (s) => (token && String(s).includes(token) ? 'GitHub sent a message that cannot be shown here.' : String(s));
  const said = new Set();
  const say = (line) => { said.add(clean(line)); out(clean(line)); };
  const fail = (line) => { err(clean(line)); return 1; };
  try {
    const [command, ...rest] = argv;
    if (!['check', 'plan', 'apply'].includes(command)) return fail(USAGE);

    let slug = null;
    let proposal = null;
    if (command === 'check') {
      const i = rest.indexOf('--repo');
      slug = i >= 0 ? rest[i + 1] : null;
      if (!slug || !/^[^/\s]+\/[^/\s]+$/.test(slug)) return fail('check needs --repo owner/name.');
    } else {
      if (rest.length !== 1) return fail(USAGE);
      const read = await readJson(resolve(cwd, rest[0]));
      if (!read.ok) return fail(read.missing ? `The proposal file ${rest[0]} was not found.` : `The proposal file ${rest[0]} could not be read as JSON.`);
      const v = validateProposal(read.json);
      if (!v.ok) { v.errors.forEach((e) => err(clean(e))); return 1; }
      proposal = read.json;
    }
    if (!token) return fail('Set BOARD_GITHUB_TOKEN to a GitHub token first.');
    const http = createHttp({ token, fetch });

    if (command === 'check') {
      say(`A token is set (it is not shown).`);
      return (await check(http, slug, say)) ? 0 : 1;
    }

    const recordPath = resolve(cwd, RECORD_FILE);
    let record = null;
    const rec = await readJson(recordPath);
    if (rec.ok) record = rec.json;
    else if (!rec.missing) return fail(`${RECORD_FILE} exists but could not be read; move it away first.`);

    const dry = command === 'plan';
    const saveRecord = async (r) => {
      const tmp = `${recordPath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(r, null, 2)}\n`, 'utf8');
      await rename(tmp, recordPath);
    };
    const result = await applyProposal(http, proposal, { dry, record, saveRecord, say });
    if (!result.ok) return fail(result.message);

    const there = result.steps.filter((s) => s.action === 'exists').length;
    const todo = result.steps.length - there;
    say(dry ? `Plan: ${todo} to create or change, ${there} already there. Nothing was created.` : `Done: ${result.created} created or changed, ${there} already there.`);
    for (const line of result.byHand) say(`By hand: ${line}`);
    for (const line of result.notes || []) if (!said.has(clean(line))) say(line);
    if (!dry && result.created > 0) say(`The undo record is ${RECORD_FILE} in this folder.`);
    const kept = result.steps.find((s) => s.type === 'file' && s.action === 'update');
    if (kept) say(`${kept.name} already existed, so it was added to and is not in the undo record.`);
    return 0;
  } catch {
    return fail('Setup stopped because of a problem it did not expect; nothing more was done.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
