// Live probe of the unknowns behind the Howgozit mapping redesign (plan CP0).
// Answers: (a) cross-repo blocked_by in one owner, (b) cross-owner blocked_by, (c) Project NUMBER field write,
// (d) milestone deleted under an issue, (e) the items `q` filter, (f) GraphQL deleteIssue credentials.
// Output is statuses, key lists, types, counts and yes/no only: never a token, a header, or response title/body text.
// Every object is created with the classic token (the fine-grained one is selected-repositories and may not reach new repos).
// Tokens come from the environment only: BOARD_GITHUB_TOKEN (classic), BOARD_GITHUB_TOKEN_1 (fine-grained), BOARD_GITHUB_OWNER_1.
// Usage: node scripts/probe-v2.mjs --org-repo o/r --org-repo-2 o/r2 --user-repo u/r [--step a|b|c|d|e|f|cleanup|all]

import { pathToFileURL } from 'node:url';
import { createHttp } from '../board/github/http.mjs';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STEPS = ['a', 'b', 'c', 'd', 'e', 'f', 'cleanup'];
const WRITE_GAP_MS = 1000;
const POLL_TRIES = 15;
const POLL_GAP_MS = 10_000;
const PROJECT_TITLE = 'howgozit-probe-v2';
const TOKEN_RE = /gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/g;

const Q = {
  viewer: 'query{viewer{id login}}',
  createProject: 'mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}',
  createNumber: 'mutation($projectId:ID!,$name:String!){createProjectV2Field(input:{projectId:$projectId,dataType:NUMBER,name:$name}){projectV2Field{... on ProjectV2Field{id name}}}}',
  setNumber: 'mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$n:Float!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{number:$n}}){projectV2Item{id}}}',
  deleteProject: 'mutation($projectId:ID!){deleteProjectV2(input:{projectId:$projectId}){projectV2{id}}}',
  deleteIssue: 'mutation($issueId:ID!){deleteIssue(input:{issueId:$issueId}){clientMutationId}}',
};

export function scrubText(text, max = 160) {
  return String(text ?? '').replace(TOKEN_RE, '***').replace(/[\r\n]+/g, ' ').slice(0, max);
}

export function parseArgs(argv) {
  const out = { step: 'all' };
  const map = { '--org-repo': 'orgRepo', '--org-repo-2': 'orgRepo2', '--user-repo': 'userRepo', '--step': 'step' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = map[argv[i]];
    if (key && argv[i + 1] !== undefined) out[key] = argv[i + 1];
  }
  return out;
}

const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') || '(none)' : '(not an object)');
const yn = (b) => (b ? 'yes' : 'no');

export async function runProbeV2({ httpUser, httpOrg, args, emit, sleep, orgOwner, today }) {
  const say = (line) => emit(scrubText(line, 1500));
  const a = args || {};
  const missing = [];
  if (!httpUser) missing.push('BOARD_GITHUB_TOKEN');
  if (!httpOrg) missing.push('BOARD_GITHUB_TOKEN_1');
  if (!orgOwner) missing.push('BOARD_GITHUB_OWNER_1');
  for (const [k, flag] of [['orgRepo', '--org-repo'], ['orgRepo2', '--org-repo-2'], ['userRepo', '--user-repo']]) {
    if (!a[k] || !REPO_RE.test(a[k])) missing.push(flag);
  }
  const step = a.step || 'all';
  if (step !== 'all' && !STEPS.includes(step)) missing.push('--step (a|b|c|d|e|f|cleanup|all)');
  if (missing.length === 0 && (!a.orgRepo.startsWith(orgOwner + '/') || !a.orgRepo2.startsWith(orgOwner + '/'))) {
    missing.push('--org-repo/--org-repo-2 owned by BOARD_GITHUB_OWNER_1');
  }
  if (missing.length) { say(`probe-v2 not started, nothing sent. Missing or invalid: ${missing.join(', ')}`); return { code: 2 }; }

  const day = today || new Date().toISOString().slice(0, 10);
  let wrote = false;
  const gap = async () => { if (wrote) await sleep(WRITE_GAP_MS); wrote = true; };
  const fail = (e) => ({ ok: false, status: (e && e.status) || 0, msg: scrubText(e && e.message) });

  // REST: reads are free, writes are spaced.
  const rest = async (http, method, path, body) => {
    try {
      if (method === 'GET') return { ok: true, status: 200, json: (await http.get(path)).json };
      await gap();
      return { ok: true, status: 200, json: await http.send(method, path, body) };
    } catch (e) { return fail(e); }
  };
  const gql = async (http, query, variables, write = true) => {
    try {
      if (write) await gap();
      return { ok: true, data: await http.graphql(query, variables) };
    } catch (e) { return fail(e); }
  };
  const why = (r) => `HTTP ${r.status || 'none'} ${r.msg || ''}`.trim();

  const mk = async (http, repo, title, extra) => {
    const r = await rest(http, 'POST', `/repos/${repo}/issues`, { title, body: '', ...(extra || {}) });
    return r.ok && r.json && typeof r.json.id === 'number' && typeof r.json.number === 'number'
      ? { ok: true, id: r.json.id, number: r.json.number, node: r.json.node_id, repo }
      : { ok: false, r };
  };
  // Block `issue` on `blocker` (numeric id, never the number). Tries each credential in turn.
  const block = async (issue, blocker, creds) => {
    const tried = [];
    for (const [name, http] of creds) {
      const r = await rest(http, 'POST', `/repos/${issue.repo}/issues/${issue.number}/dependencies/blocked_by`, { issue_id: blocker.id });
      tried.push(r.ok ? `${name}=accepted` : `${name}=refused ${why(r)}`);
      if (r.ok) return { ok: true, by: name, tried };
    }
    return { ok: false, tried };
  };
  const readBack = async (http, issue) => {
    const r = await rest(http, 'GET', `/repos/${issue.repo}/issues/${issue.number}/dependencies/blocked_by`);
    if (!r.ok) return `readback=FAILED ${why(r)}`;
    const list = Array.isArray(r.json) ? r.json : [];
    const first = list[0];
    const repoExpr = first
      ? `repository_url=${yn(typeof first.repository_url === 'string')} repository.full_name=${yn(!!(first.repository && first.repository.full_name))} html_url=${yn(typeof first.html_url === 'string')}`
      : 'no item returned';
    return `readback count=${list.length} keys=[${keysOf(first)}] ${repoExpr}`;
  };

  // GitHub lists lag behind writes (R70, up to ~2 min for Project items): re-read every 10 s until wanted(json) holds.
  const poll = async (http, path, wanted) => {
    let waited = 0;
    let r;
    for (let tries = 1; tries <= POLL_TRIES; tries += 1) {
      r = await rest(http, 'GET', path);
      if (r.ok && wanted(r.json)) return { found: true, after: waited, r };
      if (!r.ok && tries === POLL_TRIES) break;
      if (tries < POLL_TRIES) { await sleep(POLL_GAP_MS); waited += POLL_GAP_MS / 1000; }
    }
    return { found: false, after: waited, r };
  };

  const ctx = {};
  const skip = (x, name, needs) => say(`STEP ${x} ${name}: SKIPPED (needs ${needs})`);

  async function stepA() {
    const A = await mk(httpUser, a.orgRepo, 'probe-v2 a-blocked');
    const B = await mk(httpUser, a.orgRepo2, 'probe-v2 a-blocker');
    if (A.ok) ctx.A = A;
    if (B.ok) ctx.B = B;
    if (!A.ok || !B.ok) { say(`STEP a create-issues: FAILED — A ${A.ok ? 'ok' : why(A.r)}; B ${B.ok ? 'ok' : why(B.r)}`); return; }
    const res = await block(A, B, [['fine-grained', httpOrg], ['classic', httpUser]]);
    say(`STEP a cross-repo-blocked_by: ${res.ok ? 'YES' : 'NO'} — worked_with=${res.by || 'neither'} issue_id_sent=numeric-id ${res.tried.join('; ')}`);
    if (!res.ok) return;
    say(`STEP a blocked_by-readback: ${await readBack(httpUser, A)}`);
    const got = await poll(httpUser, `/repos/${a.orgRepo}/issues?state=open&per_page=100`, (j) => Array.isArray(j) && j.some((i) => i && i.number === A.number));
    const list = got.r;
    if (!list.ok) { say(`STEP a list-summary: FAILED — ${why(list)}`); return; }
    const items = Array.isArray(list.json) ? list.json : [];
    const mine = items.find((i) => i && i.number === A.number);
    const sum = mine && mine.issue_dependencies_summary;
    say(`STEP a list-summary: ${sum ? 'PRESENT' : 'ABSENT'} — after=${got.after}s found_A_in_list=${yn(got.found)} items=${items.length} found_A=${yn(!!mine)} issue_dependencies_summary keys=[${keysOf(sum)}] blocked_by=${sum && typeof sum.blocked_by === 'number' ? sum.blocked_by : 'n/a'} types=${sum ? Object.values(sum).map((v) => typeof v).join(',') : 'n/a'}`);
  }

  async function stepB() {
    if (!ctx.B) return skip('b', 'cross-owner-blocked_by', 'B (step a)');
    const C = await mk(httpUser, a.userRepo, 'probe-v2 b-user-issue');
    if (!C.ok) return say(`STEP b create-C: FAILED — ${why(C.r)}`);
    ctx.C = C;
    const one = await block(C, ctx.B, [['classic', httpUser]]);
    say(`STEP b user-issue-blocked-by-org-issue: ${one.ok ? 'YES' : 'NO'} — ${one.tried.join('; ')}`);
    if (one.ok) say(`STEP b user-issue-readback: ${await readBack(httpUser, C)}`);
    const A2 = await mk(httpUser, a.orgRepo, 'probe-v2 b-org-issue');
    if (!A2.ok) return say(`STEP b create-A2: FAILED — ${why(A2.r)}`);
    const two = await block(A2, C, [['fine-grained', httpOrg], ['classic', httpUser]]);
    say(`STEP b org-issue-blocked-by-user-issue: ${two.ok ? 'YES' : 'NO'} — worked_with=${two.by || 'neither'} ${two.tried.join('; ')}`);
    if (two.ok) say(`STEP b org-issue-readback: ${await readBack(httpUser, A2)}`);
  }

  async function stepC() {
    if (!ctx.C) {
      const C = await mk(httpUser, a.userRepo, 'probe-v2 c-user-issue');
      if (!C.ok) return say(`STEP c create-C: FAILED — ${why(C.r)}`);
      ctx.C = C;
    }
    const v = await gql(httpUser, Q.viewer, {}, false);
    const viewer = v.ok && v.data && v.data.viewer;
    if (!viewer) return say(`STEP c viewer: FAILED — ${why(v)}`);
    ctx.login = viewer.login;
    const p = await gql(httpUser, Q.createProject, { ownerId: viewer.id, title: PROJECT_TITLE });
    const proj = p.ok && p.data && p.data.createProjectV2 && p.data.createProjectV2.projectV2;
    if (!proj) return say(`STEP c create-project: FAILED — ${why(p)}`);
    ctx.project = { id: proj.id, number: proj.number };
    const f = await gql(httpUser, Q.createNumber, { projectId: proj.id, name: 'Score' });
    const field = f.ok && f.data && f.data.createProjectV2Field && f.data.createProjectV2Field.projectV2Field;
    if (!field) return say(`STEP c create-number-field: FAILED — ${why(f)}`);
    const base = `/users/${viewer.login}/projectsV2/${proj.number}`;
    const fl = await rest(httpUser, 'GET', `${base}/fields`);
    const fields = fl.ok && Array.isArray(fl.json) ? fl.json : [];
    const restField = fields.find((x) => x && x.name === 'Score');
    say(`STEP c rest-field-list: ${restField ? 'FOUND' : 'NOT FOUND'} — fields=${fields.length} Score keys=[${keysOf(restField)}] data_type=${restField ? restField.data_type : 'n/a'}${fl.ok ? '' : ' ' + why(fl)}`);
    const fieldId = restField ? restField.id : null;
    const add = await rest(httpUser, 'POST', `${base}/items`, { type: 'Issue', owner: a.userRepo.split('/')[0], repo: a.userRepo.split('/')[1], number: ctx.C.number });
    if (!add.ok || !add.json) return say(`STEP c add-item: FAILED — ${why(add)}`);
    const item = add.json;
    ctx.cItem = item.id;
    let worked = null;
    const tried = [];
    if (fieldId !== null) {
      const w = await rest(httpUser, 'PATCH', `${base}/items/${item.id}`, { fields: [{ id: fieldId, value: 7 }] });
      tried.push(w.ok ? 'rest=accepted' : `rest=refused ${why(w)}`);
      if (w.ok) worked = 'rest';
    } else tried.push('rest=not tried (no REST field id)');
    if (!worked) {
      const g = await gql(httpUser, Q.setNumber, { projectId: proj.id, itemId: item.node_id, fieldId: field.id, n: 7 });
      tried.push(g.ok ? 'graphql=accepted' : `graphql=refused ${why(g)}`);
      if (g.ok) worked = 'graphql';
    }
    say(`STEP c write-number: ${worked ? 'YES' : 'NO'} — worked_with=${worked || 'neither'} ${tried.join('; ')}`);
    if (!worked) return;
    const got = await poll(httpUser, `${base}/items?fields=${fieldId ?? ''}`, (j) => Array.isArray(j) && j.some((i) => i && i.id === item.id));
    const rb = got.r;
    if (!rb.ok) return say(`STEP c readback: FAILED — ${why(rb)}`);
    const list = Array.isArray(rb.json) ? rb.json : [];
    const mine = list.find((i) => i && i.id === item.id) || list[0];
    const fv = mine && Array.isArray(mine.fields) ? mine.fields.find((x) => x && (x.id === fieldId || x.name === 'Score')) : undefined;
    say(`STEP c readback: ${fv ? 'FOUND' : 'NOT FOUND'} — after=${got.after}s item_listed=${yn(got.found)} item keys=[${keysOf(mine)}] fields_is_array=${yn(Array.isArray(mine && mine.fields))} Score value keys=[${keysOf(fv)}] value_type=${fv ? typeof fv.value : 'n/a'} value=${fv && ['number', 'boolean'].includes(typeof fv.value) ? fv.value : 'n/a'} value_is_7=${yn(!!fv && fv.value === 7)}`);
  }

  async function stepD() {
    const m = await rest(httpUser, 'POST', `/repos/${a.userRepo}/milestones`, { title: 'probe-v2 milestone' });
    if (!m.ok || !m.json) return say(`STEP d create-milestone: FAILED — ${why(m)}`);
    const D = await mk(httpUser, a.userRepo, 'probe-v2 d-issue', { milestone: m.json.number });
    if (!D.ok) return say(`STEP d create-issue: FAILED — ${why(D.r)}`);
    ctx.D = D;
    const del = await rest(httpUser, 'DELETE', `/repos/${a.userRepo}/milestones/${m.json.number}`);
    if (!del.ok) return say(`STEP d delete-milestone: FAILED — ${why(del)}`);
    const re = await rest(httpUser, 'GET', `/repos/${a.userRepo}/issues/${D.number}`);
    if (!re.ok) return say(`STEP d reread: FAILED — ${why(re)}`);
    say(`STEP d milestone-deleted-under-issue: ANSWERED — issue state=${re.json.state} milestone_is_null=${yn(re.json.milestone === null)}`);
  }

  async function stepE() {
    if (!ctx.project || !ctx.login) return skip('e', 'items-q-filter', 'the probe Project (step c)');
    if (!ctx.D) return skip('e', 'items-q-filter', 'D (step d)');
    const base = `/users/${ctx.login}/projectsV2/${ctx.project.number}`;
    const add = await rest(httpUser, 'POST', `${base}/items`, { type: 'Issue', owner: a.userRepo.split('/')[0], repo: a.userRepo.split('/')[1], number: ctx.D.number });
    if (!add.ok) return say(`STEP e add-item: FAILED — ${why(add)}`);
    ctx.dItem = add.json && add.json.id;
    const want = [ctx.cItem, ctx.dItem];
    const both = await poll(httpUser, `${base}/items?per_page=100`, (j) => Array.isArray(j) && want.every((id) => j.some((i) => i && i.id === id)));
    say(`STEP e unfiltered-list-lag: ${both.found ? 'BOTH ITEMS LISTED' : 'NOT LISTED IN TIME'} — after=${both.after}s`);
    const queries = [['none', ''], ['updated>=today', `updated:>=${day}`], ['updated<2000-01-01', 'updated:<2000-01-01'], ['is:open', 'is:open'], ['created>=today', `created:>=${day}`]];
    const parts = [];
    for (const [label, q] of queries) {
      const r = await rest(httpUser, 'GET', q ? `${base}/items?q=${encodeURIComponent(q)}&per_page=100` : `${base}/items?per_page=100`);
      parts.push(`q=${label}: status=${r.ok ? 200 : r.status || 'none'} items=${r.ok && Array.isArray(r.json) ? r.json.length : 'n/a'}${r.ok ? '' : ' ' + r.msg}`);
    }
    say(`STEP e items-q-filter: ANSWERED — ${parts.join(' | ')}`);
  }

  async function stepF() {
    const E = await mk(httpUser, a.userRepo, 'probe-v2 f-user-delete');
    if (!E.ok) say(`STEP f create-E: FAILED — ${why(E.r)}`);
    else {
      const g = await gql(httpUser, Q.deleteIssue, { issueId: E.node });
      const rb = await rest(httpUser, 'GET', `/repos/${a.userRepo}/issues/${E.number}`);
      say(`STEP f deleteIssue-user-repo: ${g.ok ? 'YES' : 'NO'} — worked_with=${g.ok ? 'classic' : 'neither'}${g.ok ? '' : ' classic=refused ' + why(g)} readback_status=${rb.ok ? 200 : rb.status || 'none'}`);
    }
    const F = await mk(httpUser, a.orgRepo, 'probe-v2 f-org-delete');
    if (!F.ok) return say(`STEP f create-F: FAILED — ${why(F.r)}`);
    const tried = [];
    let by = null;
    for (const [name, http] of [['fine-grained', httpOrg], ['classic', httpUser]]) {
      const g = await gql(http, Q.deleteIssue, { issueId: F.node });
      tried.push(g.ok ? `${name}=accepted` : `${name}=refused ${why(g)}`);
      if (g.ok) { by = name; break; }
    }
    const rb = await rest(httpUser, 'GET', `/repos/${a.orgRepo}/issues/${F.number}`);
    say(`STEP f deleteIssue-org-repo: ${by ? 'YES' : 'NO'} — worked_with=${by || 'neither'} ${tried.join('; ')} readback_status=${rb.ok ? 200 : rb.status || 'none'}`);
  }

  async function stepCleanup() {
    let ids = [];
    if (ctx.project) ids = [ctx.project.id];
    else {
      // A separate cleanup run has no memory: find the probe Project by its exact title on the user.
      const v = await gql(httpUser, Q.viewer, {}, false);
      const login = v.ok && v.data && v.data.viewer && v.data.viewer.login;
      if (!login) return skip('cleanup', 'delete-probe-project', 'the probe Project (step c) or a readable viewer');
      const l = await rest(httpUser, 'GET', `/users/${login}/projectsV2?per_page=100`);
      const list = l.ok && Array.isArray(l.json) ? l.json : [];
      ids = list.filter((p) => p && p.title === PROJECT_TITLE && typeof p.node_id === 'string').map((p) => p.node_id);
      if (!ids.length) return say(`STEP cleanup delete-probe-project: NOTHING TO DELETE — found=0${l.ok ? '' : ' ' + why(l)}`);
    }
    for (const id of ids) {
      const r = await gql(httpUser, Q.deleteProject, { projectId: id });
      say(`STEP cleanup delete-probe-project: ${r.ok ? 'DELETED' : 'FAILED'}${r.ok ? '' : ' — ' + why(r)}`);
    }
  }

  const table = { a: stepA, b: stepB, c: stepC, d: stepD, e: stepE, f: stepF, cleanup: stepCleanup };
  const reach = await rest(httpOrg, 'GET', `/repos/${a.orgRepo}`);
  say(`STEP 0 token-reach: fine-grained GET /repos/${a.orgRepo} → ${reach.ok ? 200 : reach.status || 'none'}`);
  const order = step === 'all' ? STEPS : [step];
  for (const x of order) {
    try { await table[x](); } catch (e) { say(`STEP ${x} crashed: FAILED — ${e && e.name ? e.name : 'error'} ${scrubText(e && e.message)}`); }
  }
  say('probe-v2 done. Issues and repos are left; delete the two probe repos by hand.');
  return { code: 0 };
}

async function main() {
  const classic = process.env.BOARD_GITHUB_TOKEN;
  const fine = process.env.BOARD_GITHUB_TOKEN_1;
  const args = parseArgs(process.argv.slice(2));
  const httpUser = classic ? createHttp({ token: classic, fetch: globalThis.fetch }) : null;
  const httpOrg = fine ? createHttp({ token: fine, fetch: globalThis.fetch }) : null;
  const { code } = await runProbeV2({
    httpUser, httpOrg, args, orgOwner: process.env.BOARD_GITHUB_OWNER_1,
    emit: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
