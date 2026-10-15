// Takes away exactly what setup-undo.json lists (S7). Usage: node scripts/undo.mjs [--record <file>] [--yes] [--force]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHttp } from '../board/github/http.mjs';

const DEFAULT_RECORD = 'setup-undo.json';
const DONE_RECORD = 'setup-undo.done.json';

const isGone = (e) => Boolean(e) && e.kind === 'not-found';
const quote = (t) => `"${t}"`;
const SETTINGS = 'board.config.json';
const NAME_PART = /^[A-Za-z0-9._-]+$/;

// A record's repo must be owner/name; nothing is requested for anything else.
function repoProblem(record) {
  const parts = String(record.repo).split('/');
  const fine = parts.length === 2 && parts.every((x) => NAME_PART.test(x) && !/^\.+$/.test(x));
  return fine ? null : `The record's repo "${record.repo}" is not written owner/name, so nothing was changed.`;
}

// Only the settings file is ever read or deleted; any other file entry is left alone.
const isSettings = (f) => f && f.name === SETTINGS;

// An entry may name its own repo (a home repo): same shape as the record's, same owner (case-insensitive).
function entryRepo(record, c) {
  if (!c || c.repo === undefined || c.repo === null) return record.repo;
  const parts = String(c.repo).split('/');
  const fine = typeof c.repo === 'string' && parts.length === 2 && parts.every((x) => NAME_PART.test(x) && !/^\.+$/.test(x));
  if (!fine) return null;
  const owner = String(record.repo).split('/')[0];
  return parts[0].toLowerCase() === owner.toLowerCase() ? c.repo : null;
}

// Entries of a type that can be acted on; ones whose repo is not in the record's account are left out.
function listed(record, type) {
  return (record.created || []).filter((c) => c && c.type === type && entryRepo(record, c) !== null);
}

const REPO_TYPES = new Set(['label', 'milestone', 'issue', 'link']);
function skippedEntries(record) {
  return (record.created || []).filter((c) => c && REPO_TYPES.has(c.type) && entryRepo(record, c) === null);
}
const keyOf = (r) => String(r).toLowerCase();
const inRepo = (record, c) => (c.repo === undefined || c.repo === null ? '' : ` in ${entryRepo(record, c) ?? c.repo}`);

// Everything the record lists and everything inside it that the record does not list, decided from reads only.
async function plan(http, record) {
  const repo = record.repo;
  const gh = await http.get(`/repos/${repo}`);
  const info = gh.json || {};
  const answered = info.full_name || (info.owner && info.name ? `${info.owner.login}/${info.name}` : null);
  if (answered && answered.toLowerCase() !== String(repo).toLowerCase()) {
    return { mismatch: answered };
  }
  const ownerKind = info.owner && String(info.owner.type).toLowerCase() === 'organization' ? 'orgs' : 'users';
  const owner = (info.owner && info.owner.login) || String(repo).split('/')[0];
  const mine = new Set(listed(record, 'issue').map((i) => `${keyOf(entryRepo(record, i))}#${Number(i.number)}`));
  const isMine = (r, n) => mine.has(`${keyOf(r)}#${Number(n)}`);
  const extras = [];
  const unread = [];

  for (const m of listed(record, 'milestone')) {
    const mrepo = entryRepo(record, m);
    // GitHub answers the filtered issue list of a missing milestone with 422, so ask for the milestone itself first.
    try {
      await http.get(`/repos/${mrepo}/milestones/${m.number}`);
    } catch (e) {
      if (isGone(e)) continue;
      throw e;
    }
    // The milestone was found, so any failure reading what it holds stops undo.
    const page = await http.paged(`/repos/${mrepo}/issues?state=all&per_page=100&milestone=${m.number}`, { maxPages: 10 });
    const items = page.items;
    if (page.partial) unread.push(`milestone ${quote(m.name)}`);
    for (const i of items) {
      if (!i.pull_request && isMine(mrepo, i.number)) continue;
      extras.push({ number: i.number, title: i.title, holder: `milestone ${quote(m.name)}` });
    }
  }

  const projects = [];
  for (const p of listed(record, 'project')) {
    const itemsPath = `/${ownerKind}/${owner}/projectsV2/${p.number}/items?per_page=100`;
    // Only the first request answering not found means the Project is gone.
    try {
      await http.get(itemsPath);
    } catch (e) {
      if (isGone(e)) { projects.push({ entry: p, gone: true }); continue; }
      throw e;
    }
    const page = await http.paged(itemsPath, { maxPages: 20 });
    const items = page.items;
    if (page.partial) unread.push(`Project ${quote(p.name)}`);
    projects.push({ entry: p });
    for (const it of items) {
      const c = it.content || null;
      const where = c && c.repository && c.repository.full_name ? c.repository.full_name : repo;
      if (c && isMine(where, c.number)) continue;
      extras.push({ number: c ? c.number : null, title: c ? c.title : (it.title || 'an item'), holder: `Project ${quote(p.name)}` });
    }
  }
  const changed = [];
  for (const f of listed(record, 'file')) {
    if (!isSettings(f) || !f.id) continue;
    try {
      const cur = await http.get(`/repos/${repo}/contents/${SETTINGS}`);
      if (cur.json && cur.json.sha !== f.id) changed.push(SETTINGS);
    } catch (e) {
      if (!isGone(e)) throw e;
    }
  }
  return { repo, ownerKind, owner, extras, unread, changed, skipped: skippedEntries(record), gone: projects.filter((x) => x.gone).map((x) => x.entry) };
}

// The one place a plan becomes "go" (null) or a refusal message.
function refusal(p, force) {
  if (force) return null;
  const parts = [];
  if (p.extras.length) parts.push(`Other things sit inside what setup created: ${describeExtras(p.extras)}. Undo would take them along.`);
  if (p.unread.length) parts.push(`Undo could not check everything inside ${p.unread.join(' and ')}; it holds more than undo can read.`);
  if (p.changed.length) parts.push(`${SETTINGS} was changed since setup wrote it, and undo would delete it.`);
  if (!parts.length) return null;
  return `Nothing was changed. ${parts.join(' ')} Run it again with --force to go ahead anyway.`;
}

function describeExtras(extras) {
  return extras.map((x) => `${x.number != null ? `#${x.number} ` : ''}${quote(x.title || 'untitled')} (in ${x.holder})`).join(', ');
}

function summary(record) {
  const out = [];
  for (const c of record.created || []) {
    if (!c || c.type === 'field') continue;
    if (c.type === 'file' && !isSettings(c)) continue;
    if (REPO_TYPES.has(c.type) && c.repo !== undefined && c.repo !== null) {
      const ok = entryRepo(record, c) !== null;
      out.push({ type: c.type, name: c.name, repo: c.repo, ...(ok ? {} : { skipped: true }) });
    } else out.push({ type: c.type, name: c.name });
  }
  return out;
}

const goneOf = (plan_, p) => (plan_.gone || []).some((g) => Number(g.number) === Number(p.number));

async function projectNodeId(http, plan_, entry) {
  if (entry.id) return entry.id;
  const { items } = await http.paged(`/${plan_.ownerKind}/${plan_.owner}/projectsV2?per_page=100`, { maxPages: 10 });
  const hit = items.find((p) => Number(p.number) === Number(entry.number));
  return hit ? hit.node_id : null;
}

async function execute(http, record, plan_, { force, say }) {
  const repo = record.repo;
  const removed = [];
  const kept = [];
  const ids = new Map();
  const links = listed(record, 'link');
  if (links.length) {
    for (const p of listed(record, 'project')) {
      if (goneOf(plan_, p)) continue;
      const id = await projectNodeId(http, plan_, p);
      if (id) ids.set(id, p);
    }
  }
  const goneNumbers = new Set((plan_.gone || []).map((g) => Number(g.number)));
  const done = (type, name, line) => { removed.push({ type, name }); say(line); };
  for (const c of plan_.skipped || []) {
    kept.push({ type: c.type, name: c.name });
    say(`Left ${quote(c.name)} alone: its repo ${c.repo} is not in the record's account.`);
  }
  const attempt = async (fn) => {
    try { await fn(); return true; } catch (e) { if (isGone(e)) return true; throw e; }
  };
  try {
    for (const i of listed(record, 'issue')) {
      await attempt(() => http.send('PATCH', `/repos/${entryRepo(record, i)}/issues/${i.number}`, { state: 'closed', state_reason: 'not_planned' }));
      done('issue', i.name, `Closed issue #${i.number} ${quote(i.name)}${inRepo(record, i)} as not planned.`);
    }
    for (const m of listed(record, 'milestone')) {
      await attempt(() => http.send('DELETE', `/repos/${entryRepo(record, m)}/milestones/${m.number}`));
      done('milestone', m.name, `Deleted milestone ${quote(m.name)}${inRepo(record, m)}.`);
    }
    for (const l of links) {
      if (ids.has(l.project)) {
        done('link', l.name, `Link ${quote(l.name)} goes with its Project.`);
        continue;
      }
      await attempt(() => http.graphql('mutation($projectId:ID!,$repositoryId:ID!){unlinkProjectV2FromRepository(input:{projectId:$projectId,repositoryId:$repositoryId}){repository{id}}}', { projectId: l.project, repositoryId: l.id }));
      done('link', l.name, `Unlinked ${quote(l.name)} from ${l.repo}.`);
    }
    for (const p of listed(record, 'project')) {
      const id = goneNumbers.has(Number(p.number)) ? null : await projectNodeId(http, plan_, p);
      if (id) {
        await attempt(() => http.graphql('mutation($projectId:ID!){deleteProjectV2(input:{projectId:$projectId}){projectV2{id}}}', { projectId: id }));
      }
      done('project', p.name, `Deleted Project ${quote(p.name)}.`);
    }
    for (const l of listed(record, 'label')) {
      await attempt(() => http.send('DELETE', `/repos/${entryRepo(record, l)}/labels/${encodeURIComponent(l.name)}`));
      done('label', l.name, `Deleted label ${quote(l.name)}${inRepo(record, l)}.`);
    }
    for (const f of listed(record, 'file')) {
      if (!isSettings(f)) {
        kept.push({ type: 'file', name: f.name });
        say(`Left ${f.name} alone: undo only deletes ${SETTINGS}.`);
        continue;
      }
      const file = f.name;
      const where = file.split('/').map(encodeURIComponent).join('/');
      let sha = null;
      try {
        sha = (await http.get(`/repos/${repo}/contents/${where}`)).json.sha;
      } catch (e) {
        if (!isGone(e)) throw e;
      }
      if (sha !== null) {
        if (!force && f.id && sha !== f.id) {
          return { ok: false, removed, kept, message: `Stopped before deleting ${file}: it was changed since setup wrote it, so it was left in place. Removed so far: ${removed.length}. Run undo again with --force to delete it anyway.` };
        }
        await attempt(() => http.send('DELETE', `/repos/${repo}/contents/${where}`, { message: 'Remove board settings', sha }));
      }
      done('file', file, `Deleted file ${file}.`);
    }
  } catch (e) {
    return { ok: false, removed, kept, message: `Stopped partway: ${e.message || 'GitHub did not answer.'} Removed so far: ${removed.length}. Run undo again to finish; what is already gone counts as removed.` };
  }
  let message = `Removed ${removed.length} thing${removed.length === 1 ? '' : 's'} that setup created.`;
  if (force && plan_.extras.length) message += ` Also went with them: ${describeExtras(plan_.extras)}.`;
  return { ok: true, removed, kept, message };
}

export async function undoRecord(http, record, { force = false, say = () => {} } = {}) {
  const isObj = record !== null && typeof record === 'object' && !Array.isArray(record);
  if (!isObj || record.version !== 1 || typeof record.repo !== 'string' || !Array.isArray(record.created)) {
    return { ok: false, removed: [], kept: [], message: 'The undo record cannot be read, so nothing was changed.' };
  }
  const bad = repoProblem(record);
  if (bad) return { ok: false, removed: [], kept: [], message: bad };
  let p;
  try {
    p = await plan(http, record);
  } catch (e) {
    const why = e && e.name === 'GitHubError' && e.kind === 'not-found'
      ? `GitHub has no repo ${record.repo} that this token can see`
      : (e && e.name === 'GitHubError' && e.message ? e.message.replace(/\.$/, '') : 'GitHub could not be read');
    return { ok: false, removed: [], kept: summary(record), message: `${why}, so nothing was changed.` };
  }
  if (p.mismatch) {
    return { ok: false, removed: [], kept: summary(record), message: `The record is for ${record.repo}, but GitHub answers for ${p.mismatch}. Nothing was changed.` };
  }
  const no = refusal(p, force);
  if (no) return { ok: false, removed: [], kept: summary(record), message: no };
  return execute(http, record, p, { force, say });
}

function parseArgs(argv) {
  const o = { record: null, yes: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') o.yes = true;
    else if (a === '--force') o.force = true;
    else if (a === '--record' && argv[i + 1]) o.record = argv[++i];
    else return { error: `I did not understand "${a}". Use: undo.mjs [--record <file>] [--yes] [--force].` };
  }
  return o;
}

function defaultReadLine() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    let got = false;
    rl.once('line', (l) => { got = true; rl.close(); resolve(l); });
    rl.once('close', () => { if (!got) resolve(''); });
  });
}

export async function main(argv, { env = {}, fetch = globalThis.fetch, cwd = process.cwd(), out = console.log, err = console.log, readLine = defaultReadLine } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err(args.error); return 1; }
  const token = env.BOARD_GITHUB_TOKEN;
  if (!token) { err('BOARD_GITHUB_TOKEN is not set, so nothing was changed.'); return 1; }
  const file = path.resolve(cwd, args.record || DEFAULT_RECORD);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    err(`There is no undo record at ${file}, so nothing was changed.`); return 1;
  }
  let record;
  try { record = JSON.parse(text); } catch { record = null; }
  if (!record || typeof record !== 'object' || record.version !== 1 || typeof record.repo !== 'string' || !Array.isArray(record.created)) {
    err('The undo record is not one this version understands, so nothing was changed.'); return 1;
  }
  const bad = repoProblem(record);
  if (bad) { err(bad); return 1; }
  const http = createHttp({ token, fetch });
  try {
    const p = await plan(http, record);
    if (p.mismatch) {
      err(`The record is for ${record.repo}, but GitHub answers for ${p.mismatch}. Nothing was changed.`); return 1;
    }
    out(`Undo will remove, in ${record.repo}:`);
    for (const s of summary(record)) out(`  ${s.type}: ${s.name}${s.repo ? ` (in ${s.repo}${s.skipped ? ", not in the record's account, skipped" : ''})` : ''}`);
    const no = refusal(p, args.force);
    if (no) { err(no); return 1; }
    if (p.extras.length) out(`With --force these also go: ${describeExtras(p.extras)}.`);
    if (!args.yes) {
      out('Type undo to go ahead.');
      const answer = await readLine();
      if (String(answer).trim() !== 'undo') { out('Nothing was changed.'); return 0; }
    }
    const res = await execute(http, record, p, { force: args.force, say: out });
    if (!res.ok) { err(res.message); return 1; }
    out(res.message);
    try {
      fs.renameSync(file, path.join(path.dirname(file), DONE_RECORD));
      out(`The record is now ${DONE_RECORD}.`);
    } catch {
      out(`Everything is removed, but the record could not be renamed to ${DONE_RECORD}.`);
    }
    return 0;
  } catch (e) {
    err(`${e.message || 'Something went wrong.'} Nothing more was changed.`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), { env: process.env, fetch: globalThis.fetch, cwd: process.cwd(), out: console.log, err: console.log });
}
