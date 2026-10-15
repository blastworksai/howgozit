// Rework (cp8-interface.md section 10): F1, F2, F4, F5, F6, F7, F9, F11 live here.
// Applies a migration plan: creates targets, labels, goals, copies, items, ideas, then comments on the originals.
// Built to reference/mapping-redesign/cp8-interface.md section 4. The record is saved after every write; a re-run resumes (section 4.3).
//
// ctx (defined here, J2 builds it):
//   map, plan        the migration map and a FRESH buildPlan result (its non-enumerable body/description texts are used and never stored)
//   world            optional, the readWorld result (old Project numbers, the source settings)
//   owners           { default, forOwner(login) } clients: { get, paged, send, graphql }
//   clock            { now(), sleep(ms) }   record  the loaded record or {}   save(record) async
//   say(line)        optional   outDir        where board.config.next.json goes   writeNext(obj) optional override
//   pace()           optional async; when absent a local pacer over clock is used (1000 ms apart, under 80 per 60 s)
// Returns { ok, message?, writes }. An expected stop returns ok:false with one plain sentence; anything else is thrown.
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { checkSettings } from '../../board/shape-settings.mjs';
import { commentKind } from './migrate-plan.mjs';

const SEP = ' · ';
const MODES = [['DO', '0E8A16'], ['THINK', '5319E7'], ['REVIEW', 'FBCA04'], ['LAUNCH', 'D93F0B']];
const lower = (s) => String(s).toLowerCase();
const ownerOf = (repo) => String(repo).split('/')[0];
const nameOf = (repo) => String(repo).split('/')[1];
const clone = (x) => JSON.parse(JSON.stringify(x));
const lastLine = (t) => String(t ?? '').trimEnd().split('\n').pop().trim();
const textOf = (v) => (typeof v === 'string' ? v : v && typeof v.name === 'string' ? v.name : v && v.name && typeof v.name.raw === 'string' ? v.name.raw : '');

class Stop extends Error {}

function localPacer(clock) {
  const times = [];
  let last = null;
  return async () => {
    for (;;) {
      const now = clock.now();
      while (times.length && times[0] <= now - 60000) times.shift();
      let wait = last === null ? 0 : last + 1000 - now;
      if (times.length >= 80) wait = Math.max(wait, times[0] + 60000 - now);
      if (wait <= 0) break;
      await clock.sleep(wait);
    }
    last = clock.now();
    times.push(last);
  };
}

export async function runApply(ctx) {
  try {
    return await walk(ctx);
  } catch (e) {
    if (e instanceof Stop) return { ok: false, message: e.message, writes: e.writes ?? 0 };
    if (e && e.name === 'GitHubError') {
      if (e.kind === 'rate-limit') return { ok: false, message: 'GitHub is limiting writes; run apply again later.' };
      return { ok: false, message: e.message };
    }
    throw e;
  }
}

async function walk(ctx) {
  const { map, plan, owners, clock } = ctx;
  const say = ctx.say || (() => {});
  const source = map.source;
  if (!plan || plan.ok === false) throw new Stop('The plan is not in order, so nothing was written.');
  const pace = typeof ctx.pace === 'function' ? ctx.pace : localPacer(clock);
  const record = ctx.record && typeof ctx.record === 'object' ? ctx.record : {};
  for (const [k, v] of Object.entries({ version: 1, source, planDigests: [], startedAt: null, lastApplyAt: null, done: false, targets: [], milestones: [], issues: [], ideas: [], deletions: [] })) {
    if (record[k] === undefined) record[k] = v;
  }
  if (!record.startedAt) record.startedAt = new Date(Number.isFinite(clock.now()) ? clock.now() : 0).toISOString();
  if (plan.digest && !record.planDigests.includes(plan.digest)) record.planDigests.push(plan.digest);
  const wasDone = record.done === true;
  let writes = 0;
  const saveFn = ctx.save || ctx.saveRecord || (async () => {});
  // F6: `pending` names the creating write about to be made; it is cleared by the first save after the thing is recorded.
  let live = null;
  const save = async () => {
    if (live && record.pending === live) { delete record.pending; live = null; }
    return saveFn(clone(record));
  };
  const markPending = async (kind, key) => {
    live = { kind, key };
    record.pending = live;
    await saveFn(clone(record));
  };
  const wasPending = (kind, key) => Boolean(record.pending && record.pending !== live && record.pending.kind === kind && lower(record.pending.key) === lower(key));
  // A pending entry with no hit: list again up to 3 more times, 5000 ms apart, before creating.
  const retryFind = async (kind, key, find) => {
    if (!wasPending(kind, key)) return null;
    for (let i = 0; i < 3; i += 1) {
      await clock.sleep(5000);
      const hit = await find();
      if (hit) return hit;
    }
    return null;
  };
  const is422 = (e) => e && (e.kind === 'invalid' || e.status === 422);
  // every GitHub write passes here
  const W = async (fn) => {
    await pace();
    writes += 1;
    if (record.done) record.done = false;
    return fn();
  };

  const defaultClient = owners.default;
  // F4: every repo apply created or recorded, and every repo it is about to create, is read and written with the default client.
  // R2-4: only repos apply created (ours: true, incl. a 422-adopted one) use the default client; a pre-existing repo keeps its owner's client.
  const ownRepos = new Set([...record.targets.filter((t) => t.kind === 'repo' && t.ours === true).map((t) => lower(t.repo)), ...plan.targets.filter((t) => t.kind === 'repo' && !t.exists).map((t) => lower(t.repo))]);
  const repoClient = (repo) => (ownRepos.has(lower(repo)) ? defaultClient : owners.forOwner(ownerOf(repo)));
  const projClient = (owner) => owners.forOwner(owner);
  // R2-5: 404 and 410 count as gone by STATUS (the real client classes 410 as 'invalid').
  const isGone = (e) => e && (e.status === 404 || e.status === 410 || e.kind === 'not-found');

  // ----- repository and owner facts -----
  const repoCache = new Map();
  const getRepo = async (repo) => {
    const k = lower(repo);
    if (repoCache.has(k) && repoCache.get(k)) return repoCache.get(k);
    try {
      const j = (await repoClient(repo).get(`/repos/${repo}`)).json;
      repoCache.set(k, j);
      return j;
    } catch (e) {
      if (isGone(e)) return null;
      throw e;
    }
  };
  const homes = [];
  for (const i of plan.issues) if (i.moves) homes.push(i.target.repo);
  for (const m of plan.milestones) if (m.moves) for (const c of m.copies) homes.push(c.repo);
  const created = plan.targets.filter((t) => t.kind === 'repo').map((t) => t.repo);
  const candidates = [source, ...Object.values(map.projects).map((p) => p.home), ...homes, ...created];
  const ownerFacts = new Map();
  const ownerInfo = async (owner) => {
    const k = lower(owner);
    if (ownerFacts.has(k)) return ownerFacts.get(k);
    let facts = null;
    for (const r of candidates) {
      if (lower(ownerOf(r)) !== k) continue;
      const j = await getRepo(r);
      if (j && j.owner) { facts = { type: j.owner.type, nodeId: j.owner.node_id }; break; }
    }
    if (!facts) {
      try {
        const j = (await projClient(owner).get(`/users/${owner}`)).json;
        facts = { type: j.type, nodeId: j.node_id };
      } catch (e) {
        if (!isGone(e)) throw e;
        throw new Stop(`GitHub could not find the owner ${owner}, or the token cannot see it.`);
      }
    }
    ownerFacts.set(k, facts);
    return facts;
  };
  const baseOf = async (owner) => `${(await ownerInfo(owner)).type === 'Organization' ? '/orgs/' : '/users/'}${owner}`;

  // ----- 0. checks before any write -----
  const moving = plan.issues.filter((i) => i.moves).sort((a, b) => a.old.number - b.old.number);
  // F1: a recorded copy in another repo than the fresh plan's target is never acted on.
  for (const e of moving) {
    const had = record.issues.find((x) => x.old === e.old.ref);
    if (had) {
      const where = String(had.copy).split('#')[0];
      if (lower(where) !== lower(e.target.repo)) throw new Stop(`${e.old.ref} was copied to ${where} but the plan now sends it to ${e.target.repo}; move or remove the copy by hand first.`);
    }
  }
  // F2: the old Projects of the moving keys, from the plan's world, before the first write.
  if (!Array.isArray(record.oldProjects) && ctx.world && ctx.world.oldProjects) {
    const keys = new Set();
    for (const t of plan.targets) if (t.kind === 'project') for (const k of t.keys || []) keys.add(k);
    const olds = [];
    for (const k of keys) {
      const o = ctx.world.oldProjects[k];
      if (o && o.exists) olds.push({ key: k, owner: o.owner, number: o.number, nodeId: o.nodeId ?? null, title: o.title });
    }
    record.oldProjects = olds;
    await save();
  }

  // ----- 1. repositories -----
  for (const t of plan.targets.filter((x) => x.kind === 'repo')) {
    let rec = record.targets.find((x) => x.kind === 'repo' && lower(x.repo) === lower(t.repo));
    if (!rec) {
      let found = await getRepo(t.repo);
      if (!found) {
        found = await retryFind('repo', t.repo, async () => { repoCache.delete(lower(t.repo)); return getRepo(t.repo); });
      }
      if (found) {
        rec = { kind: 'repo', owner: ownerOf(t.repo), repo: t.repo, adopted: true, ours: !t.exists };
        if (rec.ours) ownRepos.add(lower(t.repo));
      } else {
        const info = await ownerInfo(ownerOf(t.repo));
        const path = info.type === 'Organization' ? `/orgs/${ownerOf(t.repo)}/repos` : '/user/repos';
        await markPending('repo', t.repo);
        try {
          const made = await W(() => defaultClient.send('POST', path, { name: nameOf(t.repo), private: true }));
          repoCache.set(lower(t.repo), made);
          rec = { kind: 'repo', owner: ownerOf(t.repo), repo: t.repo, adopted: false, ours: true };
        } catch (e) {
          if (!is422(e)) throw e;
          // F4: the name is taken (or the answer was lost): read it with the default client; adopt only a private one.
          ownRepos.add(lower(t.repo));
          repoCache.delete(lower(t.repo));
          const j = await getRepo(t.repo);
          if (!j) throw new Stop(`GitHub refused to create ${t.repo} and the token cannot see a repository of that name.`);
          if (j.private !== true) throw new Stop(`${t.repo} already exists and is not private, so apply did not use it.`);
          rec = { kind: 'repo', owner: ownerOf(t.repo), repo: t.repo, adopted: true, ours: true };
        }
      }
      record.targets.push(rec);
      await save();
      say(`Repository ${t.repo}: ${rec.adopted ? 'already there' : 'created'}.`);
    }
    if (rec.ours === true) ownRepos.add(lower(t.repo));
  }

  // ----- 1b. Projects, their fields and links -----
  const oldNumbers = new Set(Object.values((ctx.world && ctx.world.oldProjects) || {}).map((o) => `${lower(o.owner)}|${o.number}`));
  const listCache = new Map();
  const listProjects = async (owner) => {
    const k = lower(owner);
    if (!listCache.has(k)) listCache.set(k, (await projClient(owner).paged(`${await baseOf(owner)}/projectsV2?per_page=100`, { maxPages: 10 })).items);
    return listCache.get(k);
  };
  const projects = new Map();
  const byKey = new Map();
  const pkey = (owner, title) => `${lower(owner)}|${title}`;
  const fieldsOf = async (P) => (await projClient(P.owner).paged(`${await baseOf(P.owner)}/projectsV2/${P.number}/fields?per_page=100`, { maxPages: 5 })).items;
  for (const t of plan.targets.filter((x) => x.kind === 'project')) {
    let rec = record.targets.find((x) => x.kind === 'project' && lower(x.owner) === lower(t.owner) && x.title === t.title);
    if (!rec) {
      const findProject = async () => {
        const list = await listProjects(t.owner);
        let h = t.exists && t.number ? list.find((p) => p.number === t.number) : null;
        if (!h) h = list.find((p) => p.title === t.title && !oldNumbers.has(`${lower(t.owner)}|${p.number}`));
        return h;
      };
      const pkeyStr = pkey(t.owner, t.title);
      let hit = await findProject();
      let lost = false;
      if (!hit) {
        hit = await retryFind('project', pkeyStr, async () => { listCache.delete(lower(t.owner)); return findProject(); });
        lost = Boolean(hit);
      }
      if (hit) rec = { kind: 'project', owner: t.owner, title: t.title, number: hit.number, nodeId: hit.node_id, adopted: !lost };
      else {
        const ownerId = (await ownerInfo(t.owner)).nodeId;
        await markPending('project', pkeyStr);
        const data = await W(() => projClient(t.owner).graphql('mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}', { ownerId, title: t.title }));
        const made = data.createProjectV2.projectV2;
        rec = { kind: 'project', owner: t.owner, title: t.title, number: made.number, nodeId: made.id, adopted: false };
      }
      record.targets.push(rec);
      await save();
      say(`Project ${rec.owner}#${rec.number}: ${rec.adopted ? 'already there' : 'created'}.`);
    }
    const P = { owner: t.owner, title: t.title, number: rec.number, nodeId: rec.nodeId, dueField: null, fields: null };
    projects.set(pkey(t.owner, t.title), P);
    for (const k of t.keys || []) byKey.set(k, P);
    P.role = t.role;
    P.scoreName = t.scoreField;

    const wantField = t.role === 'project' ? { name: 'Due', type: 'DATE' } : t.role === 'habits' ? { name: map.habits.scoreField, type: 'NUMBER' } : null;
    if (wantField) {
      const ftitle = `${t.title}${SEP}${wantField.name}`;
      let frec = record.targets.find((x) => x.kind === 'field' && lower(x.owner) === lower(t.owner) && x.title === ftitle);
      if (!frec) {
        const findField = async () => (await fieldsOf(P)).find((f) => lower(f.name) === lower(wantField.name));
        let hit = await findField();
        let lostField = false;
        if (!hit) {
          hit = await retryFind('field', pkey(t.owner, ftitle), findField);
          lostField = Boolean(hit);
        }
        if (hit) frec = { kind: 'field', owner: t.owner, title: ftitle, number: rec.number, nodeId: hit.node_id, adopted: !lostField };
        else {
          await markPending('field', pkey(t.owner, ftitle));
          const q = wantField.type === 'DATE'
            ? 'mutation($projectId:ID!,$name:String!){createProjectV2Field(input:{projectId:$projectId,dataType:DATE,name:$name}){projectV2Field{... on ProjectV2Field{id name}}}}'
            : 'mutation($projectId:ID!,$name:String!){createProjectV2Field(input:{projectId:$projectId,dataType:NUMBER,name:$name}){projectV2Field{... on ProjectV2Field{id name}}}}';
          const data = await W(() => projClient(t.owner).graphql(q, { projectId: rec.nodeId, name: wantField.name }));
          frec = { kind: 'field', owner: t.owner, title: ftitle, number: rec.number, nodeId: data.createProjectV2Field.projectV2Field.id, adopted: false };
        }
        record.targets.push(frec);
        await save();
      }
      if (wantField.name === 'Due') P.dueField = frec.nodeId;
    }
    for (const h of t.links || []) {
      if (record.targets.some((x) => x.kind === 'link' && lower(x.owner) === lower(t.owner) && x.title === t.title && lower(x.repo) === lower(h))) continue;
      const home = await getRepo(h);
      if (!home) throw new Stop(`GitHub could not find ${h}, or the token cannot see it.`);
      await W(() => projClient(t.owner).graphql('mutation($projectId:ID!,$repositoryId:ID!){linkProjectV2ToRepository(input:{projectId:$projectId,repositoryId:$repositoryId}){repository{id}}}', { projectId: rec.nodeId, repositoryId: home.node_id }));
      record.targets.push({ kind: 'link', owner: t.owner, repo: h, title: t.title, number: rec.number, nodeId: home.node_id, adopted: false });
      await save();
    }
  }

  // ----- 2. labels -----
  const labelPlan = new Map();
  const wantLabel = (repo, l) => {
    const k = lower(repo);
    if (!labelPlan.has(k)) labelPlan.set(k, { repo, labels: new Map() });
    const m = labelPlan.get(k).labels;
    if (!m.has(lower(l.name))) m.set(lower(l.name), l);
  };
  for (const i of moving) {
    for (const l of i.labels) wantLabel(i.target.repo, l);
  }
  for (const i of moving) for (const [name, color] of MODES) wantLabel(i.target.repo, { name, color, description: null });
  for (const { repo, labels } of labelPlan.values()) {
    const pending = [...labels.values()].filter((l) => !record.targets.some((x) => x.kind === 'label' && lower(x.repo) === lower(repo) && lower(x.title) === lower(l.name)));
    if (!pending.length) continue;
    const fetchHave = async () => new Set((await repoClient(repo).paged(`/repos/${repo}/labels?per_page=100`, { maxPages: 10 })).items.map((l) => lower(l.name)));
    let have = await fetchHave();
    for (const l of pending) {
      let adopted = have.has(lower(l.name));
      if (!adopted) {
        const lk = `${repo}|${l.name}`;
        if (await retryFind('label', lk, async () => { have = await fetchHave(); return have.has(lower(l.name)); })) {
          record.targets.push({ kind: 'label', owner: ownerOf(repo), repo, title: l.name, adopted: false });
          await save();
          continue;
        }
        await markPending('label', lk);
        const body = { name: l.name };
        if (l.color) body.color = l.color;
        if (l.description) body.description = l.description;
        await W(() => repoClient(repo).send('POST', `/repos/${repo}/labels`, body));
      }
      record.targets.push({ kind: 'label', owner: ownerOf(repo), repo, title: l.name, adopted });
      await save();
    }
  }

  // ----- 3. goals -----
  const msLists = new Map();
  const listMilestones = async (repo) => {
    const k = lower(repo);
    if (!msLists.has(k)) msLists.set(k, (await repoClient(repo).paged(`/repos/${repo}/milestones?state=all&per_page=100`, { maxPages: 10 })).items);
    return msLists.get(k);
  };
  const msMarker = (n) => `<!-- howgozit-migrated-from: ${source} milestone ${n} -->`;
  for (const m of plan.milestones.filter((x) => x.moves)) {
    let rec = record.milestones.find((x) => x.old.number === m.old.number);
    if (!rec) { rec = { old: { number: m.old.number, title: m.old.title }, copies: [] }; record.milestones.push(rec); }
    for (const c of m.copies) {
      let copy = rec.copies.find((x) => lower(x.repo) === lower(c.repo));
      if (!copy) {
        const findMs = async () => {
          const list = await listMilestones(c.repo);
          const byMarker = list.find((x) => lastLine(x.description) === msMarker(m.old.number));
          if (byMarker) return { hit: byMarker, adopted: false };
          const byTitle = list.find((x) => lower(x.title) === lower(c.title));
          if (!byTitle) return null;
          // R2-2: a title match is adopted only when it carries no howgozit marker at all.
          if (/<!--\s*howgozit-migrated-from:/.test(String(byTitle.description ?? ''))) throw new Stop(`${c.repo} already holds goal "${c.title}" from another original; rename one of them first.`);
          return { hit: byTitle, adopted: true };
        };
        let found = await findMs();
        if (!found) found = await retryFind('milestone', `${c.repo}|${m.old.number}`, async () => { msLists.delete(lower(c.repo)); return findMs(); });
        let hit = found ? found.hit : null;
        let adopted = found ? found.adopted : false;
        if (!hit) {
          await markPending('milestone', `${c.repo}|${m.old.number}`);
          const desc = m.description ?? null;
          const body = { title: c.title, description: desc ? `${desc}\n\n${msMarker(m.old.number)}` : msMarker(m.old.number) };
          if (m.dueOn) body.due_on = `${m.dueOn.slice(0, 10)}T12:00:00Z`;
          hit = await W(() => repoClient(c.repo).send('POST', `/repos/${c.repo}/milestones`, body));
          (await listMilestones(c.repo)).push(hit);
        }
        copy = { repo: c.repo, number: hit.number, title: c.title };
        if (adopted) copy.adopted = true;
        if (hit.state === 'closed') copy.closed = true;
        rec.copies.push(copy);
        await save();
      }
      // F9: a milestone adopted without our marker is never changed.
      if (m.state === 'closed' && !copy.closed && !copy.adopted) {
        await W(() => repoClient(c.repo).send('PATCH', `/repos/${c.repo}/milestones/${copy.number}`, { state: 'closed' }));
        copy.closed = true;
        await save();
      }
    }
  }

  // ----- 4. copies, their comments, items, Status and Due -----
  const issueLists = new Map();
  const listIssues = async (repo) => {
    const k = lower(repo);
    if (!issueLists.has(k)) issueLists.set(k, (await repoClient(repo).paged(`/repos/${repo}/issues?state=all&per_page=100`, { maxPages: 100 })).items.filter((i) => !i.pull_request));
    return issueLists.get(k);
  };
  const srcClient = owners.forOwner(ownerOf(source));
  let srcComments = null;
  const sourceCommentText = async (n, id) => {
    if (!srcComments) srcComments = new Map();
    if (!srcComments.has(n)) srcComments.set(n, (await srcClient.paged(`/repos/${source}/issues/${n}/comments?per_page=100`, { maxPages: 100 })).items);
    const hit = srcComments.get(n).find((c) => c.id === id);
    return hit ? hit.body ?? '' : '';
  };
  const bodyOf = async (e) => {
    if (e.body !== undefined) return e.body;
    return (await srcClient.get(`/repos/${source}/issues/${e.old.number}`)).json.body ?? null;
  };
  const statusInfo = async (P) => {
    if (!P.fields) {
      const rows = await fieldsOf(P);
      const st = rows.find((f) => lower(f.name) === 'status');
      P.fields = {
        statusId: st ? st.node_id : null,
        options: st ? (st.options || []).map((o) => ({ id: o.id, name: textOf(o) })) : [],
        dueId: P.dueField || (rows.find((f) => lower(f.name) === 'due') || {}).node_id || null,
        statusNum: st ? st.id : null,
        dueNum: (rows.find((f) => f.node_id === (P.dueField || (rows.find((x) => lower(x.name) === 'due') || {}).node_id)) || {}).id ?? null,
      };
    }
    return P.fields;
  };
  // R2-7: the live Status name and Due date of one item (null when empty), read through the items list.
  const liveValues = async (P, itemId) => {
    const f = await statusInfo(P);
    const ids = [f.statusNum, f.dueNum].filter((x) => x !== null && x !== undefined);
    if (!ids.length) return { status: null, due: null };
    // R3-3: the items LIST lags on a new Project; the single item reads back at once.
    let it;
    try {
      it = (await projClient(P.owner).get(`${await baseOf(P.owner)}/projectsV2/${P.number}/items/${itemId}?fields=${ids.join(',')}`)).json;
    } catch (e) {
      if (isGone(e)) throw new Stop('The new item is not listed yet; run apply again in a few minutes.');
      throw e;
    }
    if (!it) throw new Stop('The new item is not listed yet; run apply again in a few minutes.');
    const val = (num) => { const fv = (it.fields || []).find((x) => x.id === num); return fv ? fv.value ?? null : null; };
    const st = f.statusNum !== null && f.statusNum !== undefined ? textOf(val(f.statusNum)) : '';
    const dueRaw = f.dueNum !== null && f.dueNum !== undefined ? val(f.dueNum) : null;
    return { status: st || null, due: dueRaw ? String(dueRaw).slice(0, 10) : null };
  };
  const clearField = (P, item, fieldId) => W(() => projClient(P.owner).graphql('mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!){clearProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId}){projectV2Item{id}}}', { projectId: P.nodeId, itemId: item.itemNodeId, fieldId }));
  const addItem = async (P, repo, number) => {
    const path = `${await baseOf(P.owner)}/projectsV2/${P.number}/items`;
    try {
      const res = await W(() => projClient(P.owner).send('POST', path, { type: 'Issue', owner: ownerOf(repo), repo: nameOf(repo), number }));
      return { itemId: res && res.id, itemNodeId: res && res.node_id };
    } catch (e) {
      if (!is422(e)) throw e;
      const items = (await projClient(P.owner).paged(`${path}?per_page=100`, { maxPages: 50 })).items;
      const hit = items.find((it) => it.content && it.content.number === number && lower((it.content.repository && it.content.repository.full_name) || repo) === lower(repo));
      if (!hit) throw new Stop('The new item is not listed yet; run apply again in a few minutes.');
      return { itemId: hit.id, itemNodeId: hit.node_id };
    }
  };

  // F7: each board's own Due from its entry; the issue-level value only when the entry has none.
  const dueFor = (tp, e) => (tp.due !== undefined ? tp.due : e.due) || null;
  const irec = new Map();
  for (const e of moving) {
    const ref = e.old.ref;
    const repo = e.target.repo;
    let rec = record.issues.find((x) => x.old === ref);
    if (!rec) {
      let list = await listIssues(repo);
      const marker = `<!-- howgozit-migrated-from: ${source}#${e.old.number} -->`;
      let hits = list.filter((i) => lastLine(i.body) === marker);
      if (hits.length === 0) {
        const again = await retryFind('issue', ref, async () => {
          issueLists.delete(lower(repo));
          list = await listIssues(repo);
          hits = list.filter((i) => lastLine(i.body) === marker);
          return hits.length > 0;
        });
        if (!again) hits = [];
      }
      if (hits.length > 1) throw new Stop(`${repo} holds two copies of ${ref} (#${hits[0].number} and #${hits[1].number}); remove one by hand, then run apply again.`);
      let hit = hits[0];
      if (!hit) {
        const body = await bodyOf(e);
        const ms = e.milestone ? (record.milestones.find((x) => x.old.number === e.milestone.oldNumber) || { copies: [] }).copies.find((c) => lower(c.repo) === lower(repo)) : null;
        const payload = { title: e.title, body: body ? `${body}\n\n${marker}` : marker, labels: e.labels.map((l) => l.name) };
        if (ms) payload.milestone = ms.number;
        await markPending('issue', ref);
        hit = await W(() => repoClient(repo).send('POST', `/repos/${repo}/issues`, payload));
        list.push(hit);
      }
      rec = { old: ref, oldNodeId: e.old.nodeId ?? null, copy: `${repo}#${hit.number}`, copyNodeId: hit.node_id ?? null, comments: [], linkComment: false, items: [], originalComment: false };
      record.issues.push(rec);
      await save();
      say(`${ref} copied to ${rec.copy}.`);
    }
    irec.set(ref, rec);
    const copyNumber = Number(rec.copy.split('#')[1]);

    // comments, then the link comment
    const needComments = e.comments.some((c) => !rec.comments.includes(c.id)) || !rec.linkComment;
    if (needComments) {
      const fetchHave = async () => (await repoClient(repo).paged(`/repos/${repo}/issues/${copyNumber}/comments?per_page=100`, { maxPages: 100 })).items.map((c) => String(c.body ?? ''));
      let have = await fetchHave();
      const isOurs = (b, kind, mk) => commentKind(b) === kind && lastLine(b) === mk;
      // F6: a creating comment is recorded as pending first; on resume with no hit the list is read again before posting.
      const missing = async (key, kind, mk) => {
        if (have.some((b) => isOurs(b, kind, mk))) return false;
        const again = await retryFind('comment', key, async () => { have = await fetchHave(); return have.some((b) => isOurs(b, kind, mk)); });
        return !again;
      };
      const post = async (key, body) => {
        await markPending('comment', key);
        return W(() => repoClient(repo).send('POST', `/repos/${repo}/issues/${copyNumber}/comments`, { body }));
      };
      for (const c of e.comments) {
        if (rec.comments.includes(c.id)) continue;
        const mk = `<!-- howgozit-comment: ${c.id} -->`;
        if (await missing(`${rec.copy}|${c.id}`, 'copied', mk)) {
          const text = c.body !== undefined ? c.body : await sourceCommentText(e.old.number, c.id);
          const date = new Date(c.createdAt).toISOString().slice(0, 10);
          await post(`${rec.copy}|${c.id}`, `${c.login || 'ghost'} wrote on ${date}:\n\n${text}\n\n${mk}`);
        }
        rec.comments.push(c.id);
        await save();
      }
      if (!rec.linkComment) {
        const mk = '<!-- howgozit-link-to-original -->';
        if (await missing(`${rec.copy}|link`, 'link', mk)) await post(`${rec.copy}|link`, `Copied from https://github.com/${source}/issues/${e.old.number}.\n\n${mk}`);
        rec.linkComment = true;
        await save();
      }
    }

    // items, Status, Due
    for (const tp of e.target.projects) {
      const P = byKey.get(tp.key) || projects.get(pkey(tp.owner, tp.title));
      if (!P) throw new Stop(`The new Project for ${tp.key} is not known, so nothing further was written.`);
      let item = rec.items.find((x) => lower(x.owner) === lower(P.owner) && x.number === P.number);
      if (!item) {
        const got = await addItem(P, repo, copyNumber);
        item = { owner: P.owner, number: P.number, itemId: got.itemId, itemNodeId: got.itemNodeId };
        rec.items.push(item);
        await save();
      }
      if (item.status === undefined || item.due === undefined) {
        const f = await statusInfo(P);
        const wantDue = dueFor(tp, e);
        const opt = tp.status && f.statusId ? f.options.find((o) => lower(o.name) === lower(tp.status)) : null;
        let live = await liveValues(P, item.itemId);
        if (item.status === undefined) {
          {
            const want = opt ? opt.name : null;
            if (lower(live.status ?? '') !== lower(want ?? '')) {
              if (opt) await W(() => projClient(P.owner).graphql('mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}', { projectId: P.nodeId, itemId: item.itemNodeId, fieldId: f.statusId, optionId: opt.id }));
              else if (f.statusId) await clearField(P, item, f.statusId);
              live = await liveValues(P, item.itemId);
              if (lower(live.status ?? '') !== lower(want ?? '')) throw new Stop(`The Status of ${rec.copy} did not take on ${tp.key}; run apply again.`);
            }
            item.status = want;
          }
          await save();
        }
        if (item.due === undefined) {
          if (!f.dueId) item.due = null;
          else {
            if ((live.due ?? null) !== (wantDue ?? null)) {
              if (wantDue) await W(() => projClient(P.owner).graphql('mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$date:Date!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{date:$date}}){projectV2Item{id}}}', { projectId: P.nodeId, itemId: item.itemNodeId, fieldId: f.dueId, date: wantDue }));
              else await clearField(P, item, f.dueId);
              live = await liveValues(P, item.itemId);
              if ((live.due ?? null) !== (wantDue ?? null)) throw new Stop(`The Due of ${rec.copy} did not take on ${tp.key}; run apply again.`);
            }
            item.due = wantDue ?? null;
          }
          await save();
        }
      }
    }
  }

  // ----- 5. ideas -----
  const ideasP = [...projects.values()].find((p) => p.role === 'ideas');
  for (const idea of plan.ideas) {
    if (idea.already || record.ideas.some((x) => x.ref === idea.ref)) continue;
    if (!ideasP) throw new Stop('The Ideas Project is not known, so nothing further was written.');
    const got = await addItem(ideasP, source, idea.number);
    record.ideas.push({ ref: idea.ref, itemId: got.itemId ?? null });
    await save();
  }

  // ----- 6. comments on the originals -----
  for (const e of moving) {
    const rec = irec.get(e.old.ref);
    if (rec.originalComment) continue;
    const mk = `<!-- howgozit-copied-to: ${rec.copy} -->`;
    const fetchOrig = async () => (await srcClient.paged(`/repos/${source}/issues/${e.old.number}/comments?per_page=100`, { maxPages: 100 })).items;
    const ourCopiedTo = (list) => list.some((c) => commentKind(c.body) === 'copied-to' && lastLine(c.body) === mk);
    const okey = `${e.old.ref}|copied-to`;
    let have = await fetchOrig();
    if (!ourCopiedTo(have)) await retryFind('comment', okey, async () => { have = await fetchOrig(); return ourCopiedTo(have); });
    if (!ourCopiedTo(have)) {
      const n = rec.copy.split('#')[1];
      await markPending('comment', okey);
      await W(() => srcClient.send('POST', `/repos/${source}/issues/${e.old.number}/comments`, { body: `Moved to https://github.com/${e.target.repo}/issues/${n}.\n\n${mk}` }));
    }
    rec.originalComment = true;
    await save();
  }

  // ----- 7. the next settings, then done -----
  let settings = ctx.world && ctx.world.settings ? clone(ctx.world.settings) : null;
  if (!settings) {
    const f = (await srcClient.get(`/repos/${source}/contents/board.config.json`)).json;
    try { settings = JSON.parse(Buffer.from(String(f.content || ''), 'base64').toString('utf8')); } catch { settings = null; }
    if (!settings) throw new Stop(`board.config.json in ${source} could not be read, so no next settings were written.`);
  }
  const next = clone(settings);
  if (!Array.isArray(next.projects)) next.projects = [];
  next.projects = next.projects.map((p) => {
    const P = p && byKey.get(p.key);
    return P ? { ...p, owner: P.owner, number: P.number, home: map.projects[p.key].home } : p;
  });
  if (next.modes === undefined) next.modes = MODES.map(([n]) => n);
  const ideasRef = ideasP || null;
  const habitsP = [...projects.values()].find((p) => p.role === 'habits');
  if (ideasRef) next.ideas = { owner: ideasRef.owner, number: ideasRef.number };
  if (habitsP) next.habitsProject = { owner: habitsP.owner, number: habitsP.number };
  if (Array.isArray(next.habits)) next.habits = next.habits.map((h) => (map.habits.scored.includes(h.id) ? { ...h, score: { min: 1, max: 10 } } : h));
  const check = checkSettings(next);
  if (!check.ok) throw new Stop(`The next settings would not be valid (${check.errors[0]}); nothing was written to them.`);
  if (typeof ctx.writeNext === 'function') await ctx.writeNext(next);
  else {
    await mkdir(ctx.outDir, { recursive: true });
    const file = join(ctx.outDir, 'board.config.next.json');
    await writeFile(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
  }
  delete record.pending;
  record.done = true;
  if (writes > 0 || !wasDone) record.lastApplyAt = new Date(Number.isFinite(clock.now()) ? clock.now() : 0).toISOString();
  await save();
  say(`Apply finished: ${writes} write${writes === 1 ? '' : 's'} this run.`);
  return { ok: true, writes };
}
