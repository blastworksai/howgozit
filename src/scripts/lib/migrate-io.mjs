// The migration's shared plumbing: scrub, atomic records, the pacer, verify and delete.
// Built to reference/mapping-redesign/cp8-interface.md, section 5 (and 5.1 to 5.4).
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readWorld, buildPlan, commentKind } from './migrate-plan.mjs';

export const RECORD_FILE = 'migration-record.json';
export const VERIFY_FILE = 'verify-record.json';
export const PASS_FILE = 'cp10-pass.json';
export const PLAN_FILE = 'plan.json';

const lower = (s) => String(s ?? '').toLowerCase();
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// R2-5: gone by STATUS (404 or 410); the real client classes 410 as 'invalid', so the kind alone is not enough.
const notFound = (e) => Boolean(e) && (e.kind === 'not-found' || e.status === 404 || e.status === 410);

// ---------- scrub ----------

// Replaces every token value found in env (default and numbered) and anything shaped like a GitHub token with ***.
export function createScrub(env) {
  const values = new Set();
  for (const [k, v] of Object.entries(env && typeof env === 'object' ? env : {})) {
    if (/^BOARD_GITHUB_TOKEN(?:_\d+)?$/.test(k) && typeof v === 'string' && v !== '') {
      values.add(v);
      if (v.trim() !== '') values.add(v.trim());
    }
  }
  const list = [...values].sort((a, b) => b.length - a.length);
  const shapes = [/github_pat_[A-Za-z0-9_]+/g, /gh[pousr]_[A-Za-z0-9_]+/g];
  return (text) => {
    let s = String(text ?? '');
    for (const v of list) s = s.split(v).join('***');
    for (const re of shapes) s = s.replace(re, '***');
    return s;
  };
}

// ---------- files ----------

export async function readJsonFile(path) {
  try {
    return { ok: true, json: JSON.parse(await readFile(path, 'utf8')) };
  } catch (e) {
    return { ok: false, missing: Boolean(e) && e.code === 'ENOENT' };
  }
}

// Atomic tmp + rename; the text passes scrub before it reaches the disk.
export async function writeJsonAtomic(path, value, scrub = (s) => s) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, scrub(`${JSON.stringify(value, null, 2)}\n`), 'utf8');
  await rename(tmp, path);
}

// ---------- records (5.1) ----------

export function emptyRecord(source, startedAt) {
  return {
    version: 1, source, planDigests: [], startedAt, lastApplyAt: null, done: false,
    targets: [], milestones: [], issues: [], ideas: [], deletions: [],
  };
}

export async function loadRecord(outDir) {
  const r = await readJsonFile(join(outDir, RECORD_FILE));
  if (r.ok && isObj(r.json)) {
    const rec = r.json;
    for (const k of ['planDigests', 'targets', 'milestones', 'issues', 'ideas', 'deletions']) if (!Array.isArray(rec[k])) rec[k] = [];
    return { state: 'ok', record: rec };
  }
  return { state: r.ok || !r.missing ? 'bad' : 'missing', record: null };
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

// The hash verify stamps and delete re-checks. `deletions` is left out so a delete in progress does not invalidate it.
export function recordSha256(record) {
  const { deletions, ...rest } = record; // eslint-disable-line no-unused-vars
  return createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex');
}

// ---------- pacing (5.2) ----------

export function createPacer(clock) {
  let last = null;
  const times = [];
  async function pace() {
    for (;;) {
      const now = clock.now();
      let wait = 0;
      if (last !== null) wait = Math.max(wait, last + 1000 - now);
      const live = times.filter((t) => t > now - 60000);
      if (live.length >= 80) wait = Math.max(wait, live[live.length - 80] + 60000 - now);
      if (wait > 0) { await clock.sleep(Math.ceil(wait)); continue; }
      last = now;
      times.push(now);
      while (times.length && times[0] <= now - 60000) times.shift();
      return;
    }
  }
  return { pace, paced: async (fn) => { await pace(); return fn(); } };
}

// ---------- shared reading helpers ----------

const clientOf = (clients, owner) => (typeof clients.forOwner === 'function' ? clients.forOwner(owner) : clients.default);

// One routing rule (F4, R2-4): a repository apply CREATED (ours: true) is read and written with the DEFAULT client, whatever its owner.
const createdRepos = (record) => new Set(record.targets.filter((t) => t && t.kind === 'repo' && t.repo && t.ours === true).map((t) => lower(t.repo)));
const repoClientOf = (clients, defaults) => (repo) => (defaults.has(lower(repo)) ? clients.default : clientOf(clients, ownerOf(repo)));
const isOurs = (body) => commentKind(body) !== null;

async function all(http, path) {
  const r = await http.paged(path, { maxPages: 100 });
  if (r.partial) throw Object.assign(new Error('partial'), { kind: 'partial' });
  return r.items;
}

const refStr = (v) => (typeof v === 'string' ? v : (isObj(v) && v.repo && v.number != null ? `${v.repo}#${v.number}` : ''));
const parseRef = (s) => {
  const m = /^(.+)#(\d+)$/.exec(String(s));
  return m ? { repo: m[1], number: Number(m[2]) } : null;
};
const ownerOf = (repo) => String(repo).split('/')[0];

function textOf(v) {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return null;
  if (typeof v.name === 'string') return v.name;
  if (isObj(v.name) && typeof v.name.raw === 'string') return v.name.raw;
  return null;
}
function dateOf(v) {
  const s = typeof v === 'string' ? v : (isObj(v) && typeof v.raw === 'string' ? v.raw : null);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

const issueMarker = (source, n) => `<!-- howgozit-migrated-from: ${source}#${n} -->`;
const milestoneMarker = (source, n) => `<!-- howgozit-migrated-from: ${source} milestone ${n} -->`;
const withMarker = (body, marker) => (body ? `${body}\n\n${marker}` : marker);

// Project reads: which of /orgs and /users answers for an owner, and the items of one Project with Status and Due.
function projectReader(clients, world) {
  const bases = new Map();
  const cache = new Map();
  const sourceOwner = world.source && world.source.repo ? ownerOf(world.source.repo) : null;
  const baseOf = async (owner, number) => {
    const k = `${lower(owner)}|${number}`;
    if (bases.has(k)) return bases.get(k);
    const first = lower(owner) === lower(sourceOwner) && world.source.ownerType === 'User' ? ['users', 'orgs'] : ['orgs', 'users'];
    for (const b of first) {
      try {
        await clientOf(clients, owner).get(`/${b}/${owner}/projectsV2/${number}`);
        bases.set(k, b);
        return b;
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    }
    bases.set(k, null);
    return null;
  };
  const items = async (owner, number) => {
    const k = `${lower(owner)}|${number}`;
    if (cache.has(k)) return cache.get(k);
    const b = await baseOf(owner, number);
    if (!b) { cache.set(k, null); return null; }
    const http = clientOf(clients, owner);
    const fields = await all(http, `/${b}/${owner}/projectsV2/${number}/fields?per_page=100`);
    const statusId = (fields.find((f) => lower(f.name) === 'status') || {}).id;
    const dueId = (fields.find((f) => lower(f.name) === 'due') || {}).id;
    const ids = [statusId, dueId].filter((x) => x !== undefined);
    const raw = await all(http, `/${b}/${owner}/projectsV2/${number}/items?per_page=100${ids.length ? `&fields=${ids.join(',')}` : ''}`);
    const rows = [];
    for (const it of raw) {
      const c = it && it.content;
      if (!isObj(c) || !Number.isInteger(c.number)) continue;
      const row = { repo: (c.repository && (c.repository.full_name || c.repository.nameWithOwner)) || null, number: c.number, status: null, due: null };
      for (const f of it.fields || []) {
        if (f.id === statusId) row.status = textOf(f.value);
        else if (f.id === dueId) row.due = dateOf(f.value);
      }
      rows.push(row);
    }
    cache.set(k, rows);
    return rows;
  };
  const fieldCache = new Map();
  const fieldList = async (owner, number) => {
    const k = `${lower(owner)}|${number}`;
    if (fieldCache.has(k)) return fieldCache.get(k);
    const b = await baseOf(owner, number);
    const list = b ? await all(clientOf(clients, owner), `/${b}/${owner}/projectsV2/${number}/fields?per_page=100`) : null;
    fieldCache.set(k, list);
    return list;
  };
  const project = async (owner, number) => {
    const b = await baseOf(owner, number);
    return b ? getOrNull(clientOf(clients, owner), `/${b}/${owner}/projectsV2/${number}`) : null;
  };
  return { baseOf, items, fieldList, project };
}

async function getOrNull(http, path) {
  try {
    return (await http.get(path)).json;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

// Stamps on the verify and delete records are wall-clock time: the injected clock only paces writes, and a frozen
// fake clock would put them before any hand-written cp10-pass.json.
const stampOf = () => new Date(Date.now()).toISOString();

// ---------- verify (5.3) ----------

export async function runVerify(ctx) {
  const { clients, map, outDir, say, err, clock, scrub, boardRepo } = ctx;
  const loaded = await loadRecord(outDir);
  if (loaded.state === 'missing') { err(`There is no ${RECORD_FILE} in ${outDir}; run apply first.`); return 1; }
  if (loaded.state === 'bad') { err(`${RECORD_FILE} could not be read; nothing was compared.`); return 1; }
  const record = loaded.record;
  if (record.done !== true) { err(`${RECORD_FILE} says apply did not finish; run apply again first.`); return 1; }
  const source = map.source;

  const defaults = createdRepos(record);
  const repoHttp = repoClientOf(clients, defaults);
  const world = await readWorld(clients, map, { boardRepo, defaultRepos: [...defaults] });
  const plan = buildPlan(world, map);
  if (!plan.ok) {
    for (const r of plan.refusals) err(r);
    err('Verify cannot compare while the plan is refused.');
    return 1;
  }
  const srcHttp = clientOf(clients, ownerOf(source));
  const reader = projectReader(clients, world);
  const rows = [];
  const push = (label, differences, extra = {}) => {
    rows.push({ label, same: differences.length === 0, differences, ...extra });
  };

  const planByOld = new Map(plan.issues.filter((e) => e.moves).map((e) => [e.old.ref, e]));
  const recorded = new Map();
  for (const rec of record.issues) recorded.set(refStr(rec.old), rec);

  // issue pairs
  for (const rec of record.issues) {
    const oldRef = refStr(rec.old);
    const copyRef = refStr(rec.copy);
    const o = parseRef(oldRef);
    const c = parseRef(copyRef);
    const label = `${oldRef} → ${copyRef}`;
    if (!o || !c) { push(label, ['record'], { pair: true }); continue; }
    const e = planByOld.get(oldRef) || null;
    const oHttp = repoHttp(o.repo);
    const cHttp = repoHttp(c.repo);
    const origIssue = await getOrNull(oHttp, `/repos/${o.repo}/issues/${o.number}`);
    const copyIssue = await getOrNull(cHttp, `/repos/${c.repo}/issues/${c.number}`);
    if (!origIssue || !copyIssue) { push(label, ['missing'], { pair: true }); continue; }
    const diff = [];
    if (origIssue.state !== 'open') diff.push('original closed after the copy');
    if (copyIssue.state !== 'open') diff.push('copy closed');
    if (!e) diff.push('no longer planned to move'); // R2-6
    if (origIssue.title !== copyIssue.title) diff.push('title');
    const marker = issueMarker(source, o.number);
    const want = withMarker(origIssue.body ?? null, marker);
    if (copyIssue.body !== want && !(origIssue.body === '' && copyIssue.body === marker)) diff.push('body');
    const names = (x) => (x.labels || []).map((l) => lower(typeof l === 'string' ? l : l.name)).sort().join('\u0000');
    if (names(origIssue) !== names(copyIssue)) diff.push('labels');
    if (e) {
      const wantMs = e.milestone ? e.milestone.title : null;
      if ((copyIssue.milestone ? copyIssue.milestone.title : null) !== wantMs) diff.push('milestone');
      let inProjects = true;
      let statusOk = true;
      let dueOk = true;
      for (const p of e.target.projects) {
        const t = plan.targets.find((x) => x.kind === 'project' && x.role === 'project' && lower(x.owner) === lower(p.owner) && x.title === p.title);
        const rt = record.targets.find((x) => x && x.kind === 'project' && lower(x.owner) === lower(p.owner) && x.title === p.title && Number.isInteger(x.number));
        const num = rt ? rt.number : (t && t.exists ? t.number : null);
        const items = num != null ? await reader.items(p.owner, num) : null;
        const item = items ? items.find((x) => lower(x.repo) === lower(c.repo) && x.number === c.number) : null;
        if (!item) { inProjects = false; continue; }
        if (lower(item.status ?? '') !== lower(p.status ?? '')) statusOk = false;
        if ((item.due ?? null) !== (('due' in p ? p.due : e.due) ?? null)) dueOk = false;
      }
      if (!inProjects) diff.push('projects');
      if (!statusOk) diff.push('status');
      if (!dueOk) diff.push('due');
    }
    // comments
    const origComments = await all(oHttp, `/repos/${o.repo}/issues/${o.number}/comments?per_page=100`);
    const copyComments = await all(cHttp, `/repos/${c.repo}/issues/${c.number}/comments?per_page=100`);
    const plain = origComments.filter((x) => !isOurs(x.body));
    let commentsOk = copyComments.length === plain.length + 1;
    for (const oc of plain) {
      const login = (oc.user && oc.user.login) || 'ghost';
      const date = new Date(oc.created_at).toISOString().slice(0, 10);
      const wantBody = `${login} wrote on ${date}:\n\n${oc.body ?? ''}\n\n<!-- howgozit-comment: ${oc.id} -->`;
      if (!copyComments.some((x) => x.body === wantBody)) commentsOk = false;
    }
    if (!commentsOk) diff.push('comments');
    const link = `Copied from https://github.com/${source}/issues/${o.number}.\n\n<!-- howgozit-link-to-original -->`;
    if (!copyComments.some((x) => x.body === link)) diff.push('link');
    const movedMarker = `<!-- howgozit-copied-to: ${copyRef} -->`;
    if (!origComments.some((x) => String(x.body ?? '').includes(movedMarker))) diff.push('original comment');
    push(label, diff, { pair: true });
  }
  for (const [oldRef] of planByOld) {
    if (!recorded.has(oldRef)) push(`${oldRef} → (not copied)`, ['missing'], { pair: true });
  }

  // goals
  const planMs = new Map(plan.milestones.filter((m) => m.moves).map((m) => [m.old.number, m]));
  const seenMs = new Set();
  for (const m of record.milestones) {
    const n = isObj(m.old) ? m.old.number : null;
    seenMs.add(n);
    const pm = planMs.get(n) || null;
    const oldMs = await getOrNull(srcHttp, `/repos/${source}/milestones/${n}`);
    for (const copy of m.copies || []) {
      const label = `${source} milestone ${n} → ${copy.repo} milestone ${copy.number}`;
      const cHttp = repoHttp(copy.repo);
      const cm = await getOrNull(cHttp, `/repos/${copy.repo}/milestones/${copy.number}`);
      if (!oldMs || !cm) { push(label, ['missing']); continue; }
      const diff = [];
      const planned = pm ? pm.copies.find((x) => lower(x.repo) === lower(copy.repo)) : null;
      if (!pm) diff.push('no longer planned to move'); // R3-1
      if (pm && (!planned || cm.title !== planned.title)) diff.push('title');
      if (copy.adopted === true) { push(label, diff); continue; }
      const dayOf = (v) => (v ? String(v).slice(0, 10) : null); // a goal's date is the UTC calendar date of due_on
      if (dayOf(cm.due_on) !== dayOf(oldMs.due_on)) diff.push('due');
      if ((cm.description ?? null) !== withMarker(oldMs.description ?? null, milestoneMarker(source, n))) diff.push('description');
      if (cm.state !== oldMs.state) diff.push('state');
      push(label, diff);
    }
  }
  for (const [n, pm] of planMs) {
    if (!seenMs.has(n)) push(`${source} milestone ${n} → (not copied)`, ['missing']);
    else if (pm.copies.some((cp) => !(record.milestones.find((m) => m.old.number === n).copies || []).some((x) => lower(x.repo) === lower(cp.repo)))) push(`${source} milestone ${n} → (a repository is missing)`, ['missing']);
  }

  // targets and ideas
  for (const t of plan.targets) {
    if (t.kind === 'repo') {
      const r = world.repos[lower(t.repo)];
      push(`repository ${t.repo}`, r && r.exists && r.private ? [] : [r && r.exists ? 'private' : 'missing']);
      continue;
    }
    const diff = [];
    const rp = t.kind === 'project' ? record.targets.find((x) => x && x.kind === 'project' && lower(x.owner) === lower(t.owner) && x.title === t.title && Number.isInteger(x.number)) : null;
    if (rp && t.exists && t.number !== rp.number) diff.push('Project replaced since apply'); // R3-4
    if (!t.exists) diff.push('missing');
    else if (t.role === 'project' && t.needsDue) diff.push('Due field');
    else if (t.role === 'habits' && t.needsScore) diff.push(`${t.scoreField} field`);
    else if (t.role === 'project' || t.role === 'habits') {
      const wantName = t.role === 'project' ? 'due' : lower(t.scoreField);
      const wantType = t.role === 'project' ? 'date' : 'number';
      const fl = await reader.fieldList(t.owner, t.number);
      const f = fl ? fl.find((x) => lower(x.name) === wantName) : null;
      if (f && f.data_type && lower(f.data_type) !== wantType) diff.push(`${t.role === 'project' ? 'Due' : t.scoreField} field is not a ${wantType} field`);
    }
    for (const h of t.links || []) {
      if (!record.targets.some((x) => x && x.kind === 'link' && lower(x.owner) === lower(t.owner) && x.title === t.title && lower(x.repo) === lower(h))) diff.push(`link to ${h} not recorded`);
    }
    push(`Project "${t.title}" (${t.owner})`, diff);
  }
  for (const rt of record.targets) {
    if (!rt || rt.kind !== 'project' || !Number.isInteger(rt.number)) continue;
    const got = await reader.project(rt.owner, rt.number);
    push(`Project ${rt.number} "${rt.title}" (${rt.owner}) as recorded`, !got ? ['missing'] : got.title !== rt.title ? ['Project replaced since apply'] : []);
  }
  for (const i of plan.ideas) push(`Ideas holds ${i.ref}`, i.already ? [] : ['missing']);

  // One row per issue pair; goals, targets and ideas are checked too but only speak (and count) when they differ.
  const shown = rows.filter((r) => r.pair || !r.same);
  const anyLinks = plan.targets.some((t) => t.kind === 'project' && (t.links || []).length > 0);
  for (const r of shown) {
    const ref = r.label;
    say(r.same ? `${ref}  same` : `${ref}  DIFFERENT: ${r.differences.join(', ')}`);
  }
  const different = rows.filter((r) => !r.same).length;
  say(`Verify: ${shown.length} pairs, ${different} different.`);
  if (anyLinks) say('Links between Projects and repositories cannot be read back through REST; check them on the board.');
  let at = Date.now();
  const last = Date.parse(record.lastApplyAt);
  if (Number.isFinite(last) && at <= last) at = last + 1;
  await writeJsonAtomic(join(outDir, VERIFY_FILE), {
    at: new Date(at).toISOString(), pass: different === 0, recordSha256: recordSha256(record),
    rows: rows.map((r) => ({ row: r.label, same: r.same, differences: r.differences })),
  }, scrub);
  return different === 0 ? 0 : 1;
}

// ---------- delete (5.4) ----------

const DELETE_ISSUE = 'mutation($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { repository { id } } }';
const DELETE_PROJECT = 'mutation($projectId: ID!) { deleteProjectV2(input: { projectId: $projectId }) { projectV2 { id } } }';

async function gate(ctx, record) {
  const { outDir, source } = ctx;
  const refuse = (s) => ({ ok: false, message: s });
  if (record.done !== true) return refuse(`${RECORD_FILE} does not say apply finished; run apply first.`);
  const v = await readJsonFile(join(outDir, VERIFY_FILE));
  if (!v.ok || !isObj(v.json)) return refuse(`There is no ${VERIFY_FILE}; run verify first.`);
  if (v.json.pass !== true) return refuse(`${VERIFY_FILE} does not say pass; fix the differences and run verify again.`);
  const vAt = Date.parse(v.json.at);
  const applied = Date.parse(record.lastApplyAt);
  if (!Number.isFinite(vAt) || !Number.isFinite(applied) || !(vAt > applied)) return refuse(`${VERIFY_FILE} is not newer than the last apply; run verify again.`);
  if (v.json.recordSha256 !== recordSha256(record)) return refuse(`${RECORD_FILE} changed after verify; run verify again.`);
  const p = await readJsonFile(join(outDir, PASS_FILE));
  if (!p.ok || !isObj(p.json)) return refuse(`There is no ${PASS_FILE}; delete waits for CP10's proof.`);
  if (p.json.pass !== true) return refuse(`${PASS_FILE} does not say pass; delete waits for CP10's proof.`);
  const pAt = Date.parse(p.json.at);
  if (!Number.isFinite(pAt) || !(pAt > vAt)) return refuse(`${PASS_FILE} is not newer than ${VERIFY_FILE}; run verify again, then record CP10's proof.`);
  void source;
  return { ok: true };
}

export async function runDelete(ctx) {
  const { clients, map, outDir, say, err, clock, scrub, boardRepo, confirm, pacer } = ctx;
  let source = map.source;
  const loaded = await loadRecord(outDir);
  if (loaded.state === 'missing') { err(`There is no ${RECORD_FILE} in ${outDir}; nothing was deleted.`); return 1; }
  if (loaded.state === 'bad') { err(`${RECORD_FILE} could not be read; nothing was deleted.`); return 1; }
  const record = loaded.record;
  const g = await gate({ outDir, source }, record);
  if (!g.ok) { err(g.message); return 1; }
  if (lower(record.source) !== lower(source)) { err(`The map moves from ${source}, but ${RECORD_FILE} was made for ${record.source}; nothing was deleted.`); return 1; }
  source = record.source; // R2-1: delete acts only in the repository the record was made for.
  if (boardRepo !== undefined && lower(boardRepo) !== lower(record.source)) { err(`BOARD_REPO names ${boardRepo}, but ${RECORD_FILE} was made for ${record.source}; nothing was deleted.`); return 1; }

  const oldProjects = Array.isArray(record.oldProjects) ? record.oldProjects.filter(isObj) : [];
  if (oldProjects.length === 0) { err(`${RECORD_FILE} names no old Projects to delete; run apply again first.`); return 1; }

  const defaults = createdRepos(record);
  const repoHttp = repoClientOf(clients, defaults);
  const world = await readWorld(clients, map, { boardRepo, defaultRepos: [...defaults] });
  if (!world.source || world.source.exists === false) { err(`GitHub could not find ${source}, or the token cannot see it.`); return 1; }
  const srcOwner = ownerOf(source);
  const srcHttp = clientOf(clients, srcOwner);
  const defHttp = clients.default;
  const done = new Set(record.deletions.map((d) => `${d.kind}|${d.ref}`));
  const counts = { issue: 0, milestone: 0, project: 0, kept: 0 };

  const save = async () => writeJsonAtomic(join(outDir, RECORD_FILE), record, scrub);
  const finish = async (kind, ref, readBack) => {
    record.deletions.push({ kind, ref, at: stampOf(clock), readBack });
    await save();
  };

  // 1. originals
  const pending = new Set();
  for (const rec of record.issues) {
    const oldRef = refStr(rec.old);
    const copyRef = refStr(rec.copy);
    const o = parseRef(oldRef);
    const c = parseRef(copyRef);
    if (!o || !c || done.has(`issue|${oldRef}`)) continue;
    const oHttp = repoHttp(o.repo);
    const orig = await getOrNull(oHttp, `/repos/${o.repo}/issues/${o.number}`);
    if (!orig) {
      if (confirm) { say(`${oldRef} is already gone.`); await finish('issue', oldRef, 'already gone'); counts.issue += 1; }
      continue;
    }
    if (orig.state !== 'open') {
      say(`Keeping ${oldRef}: it is closed.`);
      counts.kept += 1;
      continue;
    }
    const copy = await getOrNull(repoHttp(c.repo), `/repos/${c.repo}/issues/${c.number}`);
    const comments = await all(oHttp, `/repos/${o.repo}/issues/${o.number}/comments?per_page=100`);
    const moved = comments.some((x) => commentKind(x.body) === 'copied-to' && String(x.body ?? '').includes(`<!-- howgozit-copied-to: ${copyRef} -->`));
    if (!copy || !moved) {
      say(`Keeping ${oldRef}: ${!copy ? `its copy ${copyRef} cannot be read` : 'it does not carry its "Moved to" comment'}.`);
      counts.kept += 1;
      continue;
    }
    if (!confirm) { say(`Would delete ${oldRef} (copied to ${copyRef})`); pending.add(o.number); counts.issue += 1; continue; }
    await pacer.pace();
    try {
      await defHttp.graphql(DELETE_ISSUE, { issueId: orig.node_id ?? rec.oldNodeId });
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    const back = await getOrNull(oHttp, `/repos/${o.repo}/issues/${o.number}`);
    if (back) { err(`${oldRef} is still there after the delete; stopping.`); return 1; }
    await finish('issue', oldRef, 'not found');
    say(`Deleted ${oldRef}.`);
    counts.issue += 1;
  }

  // 2. goals that hold no issue
  const sourceIssues = await all(srcHttp, `/repos/${source}/issues?state=all&per_page=100`);
  for (const m of record.milestones) {
    const n = isObj(m.old) ? m.old.number : null;
    const title = isObj(m.old) ? m.old.title : '';
    const ref = `${source} milestone ${n}`;
    if (n === null || done.has(`milestone|${ref}`)) continue;
    const ms = await getOrNull(srcHttp, `/repos/${source}/milestones/${n}`);
    if (!ms) {
      if (confirm) { say(`Goal "${title}" is already gone.`); await finish('milestone', ref, 'already gone'); counts.milestone += 1; }
      continue;
    }
    const holding = sourceIssues.filter((i) => !i.pull_request && i.milestone && i.milestone.number === n && !pending.has(i.number));
    if (holding.length > 0) {
      say(`Keeping goal "${title}": it still holds ${holding.length} issue${holding.length === 1 ? '' : 's'}.`);
      counts.kept += 1;
      continue;
    }
    if (!confirm) { say(`Would delete goal "${title}" (${ref})`); counts.milestone += 1; continue; }
    await pacer.pace();
    try {
      await srcHttp.send('DELETE', `/repos/${source}/milestones/${n}`);
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    if (await getOrNull(srcHttp, `/repos/${source}/milestones/${n}`)) { err(`Goal "${title}" is still there after the delete; stopping.`); return 1; }
    await finish('milestone', ref, 'not found');
    say(`Deleted goal "${title}".`);
    counts.milestone += 1;
  }

  // 3. old Projects of the projects that moved
  const reader = projectReader(clients, world);
  for (const old of oldProjects) {
    if (old.number === null || old.number === undefined || !old.owner) continue;
    const ref = `${old.owner}/projects/${old.number}`;
    if (done.has(`project|${ref}`)) continue;
    const exists = (await reader.baseOf(old.owner, old.number)) !== null;
    if (!exists) {
      if (confirm) { say(`Project ${old.number} of ${old.owner} is already gone.`); await finish('project', ref, 'already gone'); counts.project += 1; }
      continue;
    }
    if (record.targets.some((t) => t && t.kind === 'project' && lower(t.owner) === lower(old.owner) && Number(t.number) === Number(old.number))) {
      say(`Keeping Project "${old.title}": this migration created it.`);
      counts.kept += 1;
      continue;
    }
    if (!confirm) { say(`Would delete Project "${old.title}" (${ref})`); counts.project += 1; continue; }
    const nodeId = old.nodeId;
    await pacer.pace();
    try {
      await defHttp.graphql(DELETE_PROJECT, { projectId: nodeId });
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    let still = false;
    for (const b of ['users', 'orgs']) if (await getOrNull(clientOf(clients, old.owner), `/${b}/${old.owner}/projectsV2/${old.number}`)) still = true;
    if (still) { err(`Project "${old.title}" is still there after the delete; stopping.`); return 1; }
    await finish('project', ref, 'not found');
    say(`Deleted Project "${old.title}".`);
    counts.project += 1;
  }

  if (confirm) say(`Delete: ${counts.issue} originals, ${counts.milestone} goals and ${counts.project} Projects deleted, ${counts.kept} kept.`);
  else say(`Delete: ${counts.issue} originals, ${counts.milestone} goals and ${counts.project} Projects would be deleted, ${counts.kept} kept. Nothing was deleted; run again with --confirm to delete them.`);
  return 0;
}
