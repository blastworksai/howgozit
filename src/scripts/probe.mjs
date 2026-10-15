// Live check of the GitHub facts the board relies on (contract: "Proven against live GitHub").
// This file covers the REST lines V1/V2, V3, V6, V7 and V8.
// It also covers the GraphQL line V4 (scratch Project) and the saved samples V5; the Project half of V1/V2 and V8 is real.
// The GraphQL mutations for the Project, its date field and an item's date were observed to work with both token types (October 2026).
// Run for real only with a scratch private repo and a token in BOARD_GITHUB_TOKEN; --dry-run sends nothing.

import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const API = 'https://api.github.com';
export const API_VERSION = '2026-03-10';
const TIMEOUT_MS = 10_000;
const DUE_DATE = '2030-06-15';
const LABEL = 'probe-check';
const FILE_PATH = 'probe/check.json';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POLL_TRIES = 8;
const POLL_GAP_MS = 1500;
const V_ORDER = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'];

class ProbeError extends Error {}

function scrubber(token) {
  return (text) => {
    let s = String(text ?? '');
    if (token) s = s.split(token).join('***');
    return s;
  };
}

function utcDate(iso) {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}

// One request. Refuses anything that is not api.github.com, or not inside the named repo / owner Projects path.
async function send({ fetchFn, token, scope, scrub }, method, path, body, extraHeaders) {
  const inScope = scope.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
  if (!path.startsWith('/') || !inScope) throw new ProbeError('refused to send a request outside the named repository');
  const url = API + path;
  if (new URL(url).origin !== API) throw new ProbeError('refused to send a request to another host');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'board-probe',
    ...extraHeaders,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
    text = await res.text();
  } catch (e) {
    const why = e && e.name === 'AbortError' ? 'timed out after 10 seconds' : 'network error';
    throw new ProbeError(`no answer from GitHub (${why})`);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const message = json && typeof json.message === 'string' ? scrub(json.message).slice(0, 200) : '';
  return { status: res.status, etag: res.headers.get('etag'), json, message, text: scrub(text) };
}

// A GraphQL answer can be HTTP 200 and still carry an errors list.
function gqlError(r, scrub) {
  const errs = r.json && r.json.errors;
  if (Array.isArray(errs) && errs.length) {
    const m = errs[0] && errs[0].message;
    return scrub(typeof m === 'string' ? m : 'GraphQL answered with an error').slice(0, 200);
  }
  return null;
}

const Q = {
  createProject: 'mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}',
  createField: 'mutation($projectId:ID!,$name:String!){createProjectV2Field(input:{projectId:$projectId,dataType:DATE,name:$name}){projectV2Field{... on ProjectV2Field{id name}}}}',
  addItem: 'mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}',
  setDate: 'mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$date:Date!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{date:$date}}){projectV2Item{id}}}',
  deleteProject: 'mutation($projectId:ID!){deleteProjectV2(input:{projectId:$projectId}){projectV2{id}}}',
};

function describe(r) {
  return `HTTP ${r.status}${r.message ? ' ' + r.message : ''}`;
}

// The ordered list of steps. The dry run prints it and the real run executes it, so they cannot drift.
// A step: { v, method, path(c), body?(c), headers?(c), expect?, needs?, after?(res, c, created), final?, pass?(c) }.
// V4/V5 plug in here: add steps with v 'V4' / 'V5' (final: true on the last of each), using c.projectsPath
// (the owner's Projects REST path) and, for GraphQL, a POST /graphql step plus 'graphql' added to the scope list in runProbe.
export function buildSteps({ repo, owner, hand }) {
  const R = `/repos/${repo}`;
  const contents = `${R}/contents/${FILE_PATH}`;
  const issuesList = `${R}/issues?state=all&per_page=1`;
  const fail = (m) => { throw new ProbeError(m); };
  const steps = [];

  steps.push({
    v: 'V3', method: 'POST', path: () => `${R}/milestones`,
    body: () => ({ title: 'probe check', state: 'open', due_on: `${DUE_DATE}T12:00:00Z` }),
    after: (r, c, created) => { c.ms = r.json && r.json.number; created.milestone = c.ms; },
  });
  steps.push({
    v: 'V3', method: 'GET', path: (c) => `${R}/milestones/${c.ms}`, needs: ['ms'], final: true,
    after: (r) => {
      const got = r.json && r.json.due_on;
      if (utcDate(got) !== DUE_DATE) fail(`due_on read back as ${got}, expected the date ${DUE_DATE}`);
    },
    pass: (c) => `pass (due_on read back as ${c.dueOn})`,
    capture: (r, c) => { c.dueOn = r.json && r.json.due_on; },
  });

  if (hand) {
    steps.push({
      v: 'V6', method: 'GET', path: () => `${R}/milestones/${hand.number}`, final: true,
      after: (r, c) => {
        c.handDue = r.json && r.json.due_on;
        if (utcDate(c.handDue) !== hand.date) fail(`due_on read as ${c.handDue}, expected the date ${hand.date}`);
      },
      pass: (c) => `pass (raw due_on ${c.handDue})`,
    });
  }

  steps.push({
    v: 'V7', method: 'POST', path: () => `${R}/issues`, body: () => ({ title: 'probe check' }),
    after: (r, c, created) => {
      c.issue = r.json && r.json.number; created.issues.push(c.issue);
      c.issueNodeId = r.json && r.json.node_id;
    },
  });
  const title = repo.split('/')[1];
  const gqlStep = (name, op, extra) => ({ v: 'V4', name, gql: op, method: 'POST', path: () => '/graphql', ...extra });
  steps.push(gqlStep('create', 'createProjectV2', {
    needs: ['ownerId'],
    body: (c) => ({ query: Q.createProject, variables: { ownerId: c.ownerId, title } }),
    after: (r, c, created) => {
      const p = r.json && r.json.data && r.json.data.createProjectV2 && r.json.data.createProjectV2.projectV2;
      if (!p || !p.id) fail('the answer carried no Project id');
      c.projectId = p.id; created.projectId = p.id;
      c.projectNumber = p.number;
    },
  }));
  steps.push(gqlStep('add-field', 'createProjectV2Field', {
    needs: ['projectId'],
    body: (c) => ({ query: Q.createField, variables: { projectId: c.projectId, name: 'Due' } }),
    after: (r, c) => {
      const f = r.json && r.json.data && r.json.data.createProjectV2Field && r.json.data.createProjectV2Field.projectV2Field;
      if (!f || !f.id) fail('the answer carried no field id');
      c.fieldId = f.id;
    },
  }));
  steps.push(gqlStep('add-item', 'addProjectV2ItemById', {
    needs: ['projectId', 'issueNodeId'],
    body: (c) => ({ query: Q.addItem, variables: { projectId: c.projectId, contentId: c.issueNodeId } }),
    after: (r, c) => {
      const i = r.json && r.json.data && r.json.data.addProjectV2ItemById && r.json.data.addProjectV2ItemById.item;
      if (!i || !i.id) fail('the answer carried no item id');
      c.itemId = i.id; c.graphqlAddWorked = true;
    },
  }));
  steps.push(gqlStep('set-date', 'updateProjectV2ItemFieldValue', {
    needs: ['projectId', 'itemId', 'fieldId'], final: true,
    body: (c) => ({ query: Q.setDate, variables: { projectId: c.projectId, itemId: c.itemId, fieldId: c.fieldId, date: DUE_DATE } }),
    after: () => {},
    pass: () => 'PENDING',
  }));
  steps.push({
    v: 'VP', method: 'GET', path: (c) => c.projectsPath, after: (r, c) => { c.rawProjects = r.text; },
  });
  steps.push(listProjectFieldsStep());
  steps.push(listProjectItemsStep({ repo }));
  steps.push({
    v: 'VP', method: 'POST', path: () => `${R}/issues`, body: () => ({ title: 'probe check two' }),
    after: (r, c, created) => { c.issue2 = r.json && r.json.number; created.issues.push(c.issue2); },
  });
  steps.push(addIssueToProjectStep({ owner, repo, issueKey: 'issue2' }));
  steps.push(listBothItemsStep({ repo }));
  steps.push({
    v: 'V7', method: 'PATCH', path: (c) => `${R}/issues/${c.issue}`, needs: ['issue'],
    body: () => ({ state: 'closed', state_reason: 'completed' }),
    after: (r) => { if (!r.json || r.json.state !== 'closed') fail('issue did not read back as closed'); },
  });
  steps.push({
    v: 'V7', method: 'PATCH', path: (c) => `${R}/issues/${c.issue}`, needs: ['issue'],
    body: () => ({ state: 'open' }),
    after: (r) => { if (!r.json || r.json.state !== 'open') fail('issue did not read back as open'); },
  });
  steps.push({
    v: 'V7', method: 'POST', path: () => `${R}/labels`, body: () => ({ name: LABEL, color: 'ededed' }),
    after: (r, c, created) => { created.label = LABEL; },
  });
  steps.push({
    v: 'V7', method: 'PATCH', path: (c) => `${R}/issues/${c.issue}`, needs: ['issue'],
    body: () => ({ labels: [LABEL] }),
    after: (r) => {
      const names = ((r.json && r.json.labels) || []).map((l) => (typeof l === 'string' ? l : l && l.name));
      if (!names.includes(LABEL)) fail('label was not set on the issue');
    },
  });
  steps.push({
    v: 'V7', method: 'PATCH', path: (c) => `${R}/issues/${c.issue}`, needs: ['issue', 'ms'],
    body: (c) => ({ milestone: c.ms }),
    after: (r, c) => {
      if (!r.json || !r.json.milestone || r.json.milestone.number !== c.ms) fail('milestone was not set on the issue');
    },
  });
  steps.push({
    v: 'V7', method: 'PUT', path: () => contents,
    body: () => ({ message: 'probe: create', content: Buffer.from('{"probe":1}').toString('base64') }),
    after: (r, c, created) => {
      c.sha = r.json && r.json.content && r.json.content.sha;
      created.file = c.sha || 'unknown';
    },
  });
  steps.push({
    v: 'V7', method: 'PUT', path: () => contents, needs: ['sha'],
    body: (c) => ({ message: 'probe: update', sha: c.sha, content: Buffer.from('{"probe":2}').toString('base64') }),
    after: (r, c, created) => {
      c.sha = r.json && r.json.content && r.json.content.sha;
      created.file = c.sha || created.file;
    },
  });

  // V8: ETag on three lists/reads, then a conditional re-request.
  const needEtag = (name) => (r, c) => {
    if (!r.etag) fail(`no ETag header on the ${name}`);
    c.etags[name] = r.etag;
  };
  steps.push({ v: 'V8', method: 'GET', path: () => issuesList, after: needEtag('issues list') });
  steps.push({ v: 'V8', method: 'GET', path: () => `${R}/milestones?state=all&per_page=1`, after: needEtag('milestones list') });
  steps.push({ v: 'V8', method: 'GET', path: () => contents, after: needEtag('contents read') });
  steps.push({
    v: 'V8', method: 'GET', path: () => issuesList, expect: [304],
    headers: (c) => ({ 'If-None-Match': c.etags['issues list'] }),
    after: () => {},
  });
  steps.push({
    v: 'V8', method: 'GET', path: itemsPath, needs: ['projectNumber', 'fieldIds'], final: true,
    after: (r) => { if (!r.etag) fail('no ETag on project items'); },
    pass: () => 'pass (etag on issues, milestones, contents, project items; API version accepted; conditional request answered 304)',
  });

  steps.push({
    v: 'V7', method: 'DELETE', path: () => contents, needs: ['sha'], final: true,
    body: (c) => ({ message: 'probe: delete', sha: c.sha }),
    after: (r, c, created) => { created.file = null; },
    pass: () => 'pass',
  });
  return steps;
}

const itemsPath = (c) => `${c.projectsPath}/${c.projectNumber}/items?fields=${c.fieldIds}`;
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const itemsOf = (r) => (Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.items) ? r.json.items : null));
const hasIssue = (list, number, repo) => list.some((it) => it && it.content && it.content.number === number
  && it.content.repository && sameText(it.content.repository.full_name, repo));
const findIssue = (list, number, repo) => list.find((it) => it && it.content && it.content.number === number
  && it.content.repository && sameText(it.content.repository.full_name, repo));
const seconds = (p) => `${p.seconds.toFixed(1)}s`;
const tries = (p) => `${p.tries} ${p.tries === 1 ? 'try' : 'tries'}`;

// Reads the Project's fields once, to learn the ids of Status and Due (the items list shows only Title otherwise).
export function listProjectFieldsStep() {
  return {
    v: 'VP', method: 'GET', path: (c) => `${c.projectsPath}/${c.projectNumber}/fields`, needs: ['projectNumber'],
    after: (r, c) => {
      const list = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.fields) ? r.json.fields : null);
      if (!list) throw new ProbeError('the fields answer was not a list');
      const id = (name) => { const f = list.find((x) => x && x.name === name && x.id !== undefined && x.id !== null); return f ? f.id : null; };
      const due = id('Due');
      if (due === null) throw new ProbeError('the Project fields did not include a field named Due');
      const status = id('Status');
      c.rawFields = r.text;
      c.fieldIds = (status === null ? [due] : [status, due]).join(',');
    },
  };
}

// Items list as asked for with the field ids; GitHub's list lags behind a write, so the request is repeated (see poll).
export function listProjectItemsStep({ repo }) {
  return {
    v: 'VP', method: 'GET', path: itemsPath, needs: ['projectNumber', 'fieldIds', 'issue'],
    poll: (list, c) => hasIssue(list, c.issue, repo),
    after: (r, c) => {
      const list = itemsOf(r);
      if (!list) throw new ProbeError('the items list was not a list');
      c.rawItems = r.text;
      const mine = findIssue(list, c.issue, repo);
      if (!mine) throw new ProbeError(`the items list did not show our issue #${c.issue} after ${tries(c.lastPoll)} (${seconds(c.lastPoll)})`);
      c.wait1 = seconds(c.lastPoll);
      const fields = Array.isArray(mine.fields) ? mine.fields : [];
      const named = (n) => fields.find((f) => f && f.name === n);
      const st = named('Status');
      const raw = st && st.value && st.value.name && st.value.name.raw;
      c.statusText = typeof raw === 'string' ? `Status "${raw}"` : 'Status absent';
      const dv = named('Due');
      c.dueRead = dv && typeof dv.value === 'string' ? dv.value.slice(0, 10) : null;
      if (c.dueRead !== DUE_DATE) throw new ProbeError(`the listed item showed Due ${c.dueRead === null ? 'nothing' : c.dueRead}, expected ${DUE_DATE} (${c.statusText})`);
    },
  };
}
export function listBothItemsStep({ repo }) {
  return {
    v: 'VP', method: 'GET', path: itemsPath, needs: ['projectNumber', 'fieldIds', 'issue2'], final: true,
    poll: (list, c) => hasIssue(list, c.issue, repo) && hasIssue(list, c.issue2, repo),
    after: (r, c) => {
      const list = itemsOf(r);
      if (!list) throw new ProbeError('the items list was not a list');
      if (!(hasIssue(list, c.issue, repo) && hasIssue(list, c.issue2, repo))) {
        throw new ProbeError(`the items list did not show both issues after ${tries(c.lastPoll)} (${seconds(c.lastPoll)})`);
      }
      c.wait2 = seconds(c.lastPoll);
    },
    pass: (c) => `pass (items list showed the issue after ${c.wait1}; ${c.statusText}, Due ${c.dueRead}; REST add answered ${c.restStatus}; both issues listed after ${c.wait2})`,
  };
}
export function addIssueToProjectStep({ owner, repo, issueKey = 'issue', final = false }) {
  return {
    v: 'VP', method: 'POST', path: (c) => `${c.projectsPath}/${c.projectNumber}/items`, needs: [issueKey, 'projectNumber'], final,
    body: (c) => ({ type: 'Issue', owner, repo: repo.split('/')[1], number: c[issueKey] }),
    after: (r, c) => { c.restStatus = r.status; },
    onFail: (msg, c) => (c.graphqlAddWorked ? `the REST add to the Project failed (${msg}) although the GraphQL add worked` : `the REST add to the Project failed (${msg})`),
    pass: (c) => `pass (REST add answered ${c.restStatus})`,
  };
}

// What clean-up sends, in this order. `created` says what exists.
export function cleanupPlan(repo, created) {
  const R = `/repos/${repo}`;
  const plan = [];
  if (created.projectId) {
    plan.push({ what: `Project ${created.projectId}`, method: 'POST', path: '/graphql', gql: 'deleteProjectV2', body: { query: Q.deleteProject, variables: { projectId: created.projectId } } });
  }
  for (const n of created.issues) {
    plan.push({ what: `issue #${n}`, method: 'PATCH', path: `${R}/issues/${n}`, body: { state: 'closed', state_reason: 'not_planned' } });
  }
  if (created.label) plan.push({ what: `label ${created.label}`, method: 'DELETE', path: `${R}/labels/${encodeURIComponent(created.label)}` });
  if (created.milestone) plan.push({ what: `milestone #${created.milestone}`, method: 'DELETE', path: `${R}/milestones/${created.milestone}` });
  if (created.file) {
    plan.push({ what: `file ${FILE_PATH}`, method: 'DELETE', path: `${R}/contents/${FILE_PATH}`, body: { message: 'probe: clean up', sha: created.file } });
  }
  return plan;
}

export async function runProbe({ repo, token, fetch: fetchFn, dryRun = false, samples, handMilestone, handDate, out = () => {}, sleep = (ms) => new Promise((res) => setTimeout(res, ms)), now = () => Date.now() } = {}) {
  const scrub = scrubber(token);
  const lines = [];
  const emit = (l) => { const s = scrub(l); lines.push(s); out(s); };
  const done = (ok) => ({ lines, ok });

  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    emit('Give the repository as owner/name with --repo.');
    return done(false);
  }
  const [owner] = repo.split('/');
  const hand = handMilestone !== undefined && handDate !== undefined && handMilestone !== null && handDate !== null
    ? { number: Number(handMilestone), date: String(handDate) } : null;
  if (hand && (!Number.isInteger(hand.number) || hand.number < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(hand.date))) {
    emit('--hand-milestone must be a milestone number and --hand-date a date written YYYY-MM-DD.');
    return done(false);
  }
  const wantHand = !!hand;

  if (dryRun) {
    const c = { ms: '{milestone}', issue: '{issue}', issue2: '{issue2}', sha: '{sha}', projectNumber: '{project}', projectsPath: `/{orgs|users}/${owner}/projectsV2`, fieldIds: '{fieldIds}', etags: {} };
    const tag = (x) => (x.gql ? ` (${x.gql})` : '');
    emit(`GET /repos/${repo}`);
    for (const s of buildSteps({ repo, owner, hand })) emit(`${s.method} ${s.path(c)}${tag(s)}`);
    for (const p of cleanupPlan(repo, { projectId: '{projectId}', issues: ['{issue}', '{issue2}'], label: LABEL, milestone: '{milestone}', file: null })) emit(`${p.method} ${p.path}${tag(p)}`);
    return done(true);
  }

  if (!token) {
    emit('Set BOARD_GITHUB_TOKEN in the environment first; nothing was sent.');
    return done(false);
  }
  if (typeof fetchFn !== 'function') {
    emit('No way to reach GitHub is available; nothing was sent.');
    return done(false);
  }

  // Projects path is only known after the first answer, so it joins the scope then.
  const scope = [`/repos/${repo}`, '/graphql'];
  const ctx = { fetchFn, token, scope, scrub };
  const call = (m, p, b, h) => send(ctx, m, p, b, h);

  let first;
  try {
    first = await call('GET', `/repos/${repo}`);
  } catch (e) {
    emit(`Could not read the repository (${scrub(e.message)}); nothing was created.`);
    return done(false);
  }
  if (first.status < 200 || first.status > 299 || !first.json) {
    emit(`Could not read the repository (${describe(first)}); nothing was created.`);
    return done(false);
  }
  if (first.json.private !== true) {
    emit('That repository is not private, so the probe stopped and created nothing.');
    return done(false);
  }
  const ownerType = first.json.owner && first.json.owner.type;
  if (ownerType !== 'Organization' && ownerType !== 'User') {
    emit('GitHub did not say whether the owner is an organisation or a user, so the probe stopped and created nothing.');
    return done(false);
  }
  const projectsPath = `/${ownerType === 'Organization' ? 'orgs' : 'users'}/${owner}/projectsV2`;
  const projectV = ownerType === 'Organization' ? 'V1' : 'V2';
  scope.push(projectsPath);

  const c = { projectsPath, etags: {}, ownerId: first.json.owner.node_id };
  const created = { projectId: null, milestone: null, issues: [], label: null, file: null };
  const results = new Map();
  if (!wantHand) results.set('V6', 'skip: give --hand-milestone and --hand-date to check a milestone dated by hand');
  let allOk = true;

  try {
    for (const step of buildSteps({ repo, owner, hand })) {
      const v = step.v === 'VP' ? projectV : step.v;
      if ((results.get(v) || '').startsWith('FAIL')) continue;
      const missing = (step.needs || []).find((k) => c[k] === undefined || c[k] === null);
      const at = step.name ? ` at ${step.name}` : '';
      if (missing) { results.set(v, `FAIL${at}: skipped because an earlier step did not complete`); allOk = false; continue; }
      try {
        let r;
        let tried = 0;
        const t0 = now();
        for (;;) {
          r = await call(step.method, step.path(c), step.body ? step.body(c) : undefined, step.headers ? step.headers(c) : undefined);
          const okStatus = step.expect ? step.expect.includes(r.status) : (r.status >= 200 && r.status <= 299);
          if (!okStatus) throw new ProbeError(describe(r));
          tried++;
          if (!step.poll) break;
          const list = itemsOf(r);
          if (!list || step.poll(list, c) || tried >= POLL_TRIES) break;
          await sleep(POLL_GAP_MS);
        }
        if (step.poll) c.lastPoll = { tries: tried, seconds: (now() - t0) / 1000 };
        if (step.gql) { const ge = gqlError(r, scrub); if (ge) throw new ProbeError(ge); }
        if (step.capture) step.capture(r, c);
        step.after(r, c, created);
        if (step.final) results.set(v, step.pass ? step.pass(c) : 'pass');
      } catch (e) {
        let msg = e instanceof ProbeError ? e.message : 'unexpected error while checking the answer';
        if (step.onFail) msg = step.onFail(msg, c);
        results.set(v, `FAIL${at}: ${msg}`);
        allOk = false;
      }
    }
    // V5: the raw bodies, saved only when a folder was named.
    if (!samples) results.set('V5', 'skip: no --samples folder');
    else if (!c.rawProjects || !c.rawFields || !c.rawItems) results.set('V5', 'FAIL: the Projects list, the fields and the items list were not all answered, so nothing was saved');
    else {
      try {
        await mkdir(samples, { recursive: true });
        await writeFile(path.join(samples, 'projects-list.json'), c.rawProjects);
        await writeFile(path.join(samples, 'project-fields.json'), c.rawFields);
        await writeFile(path.join(samples, 'project-items.json'), c.rawItems);
        results.set('V5', 'pass (saved 3 files)');
      } catch {
        results.set('V5', 'FAIL: could not write the sample files');
      }
    }
  } finally {
    const left = [];
    let projectGone = !created.projectId;
    let projectWhy = '';
    for (const p of cleanupPlan(repo, created)) {
      try {
        const r = await call(p.method, p.path, p.body);
        const why = r.status < 200 || r.status > 299 ? describe(r) : (p.gql ? gqlError(r, scrub) : null);
        if (why) { left.push(`${p.what} (${why})`); if (p.gql) projectWhy = why; } else if (p.gql) projectGone = true;
      } catch (e) {
        left.push(`${p.what} (${scrub(e.message)})`);
        if (p.gql) projectWhy = scrub(e.message);
      }
    }
    if (results.get('V4') === 'PENDING') {
      results.set('V4', projectGone ? 'pass (create, add-field, add-item, set-date and delete all answered without errors)' : `FAIL at delete: ${projectWhy}`);
    }
    for (const v of V_ORDER) if (results.has(v)) emit(`${v} ${results.get(v)}`);
    if (left.length) { emit(`cleanup FAILED: left behind: ${left.join('; ')}`); allOk = false; } else emit('cleanup done');
  }
  for (const text of results.values()) if (text.startsWith('FAIL')) allOk = false;
  return done(allOk);
}

export function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--repo') o.repo = val();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--samples') o.samples = val();
    else if (a === '--hand-milestone') o.handMilestone = val();
    else if (a === '--hand-date') o.handDate = val();
    else o.unknown = a;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.unknown) {
    console.log(`Unknown option ${o.unknown}.`);
    process.exitCode = 2;
    return;
  }
  const r = await runProbe({
    ...o,
    token: process.env.BOARD_GITHUB_TOKEN,
    fetch: globalThis.fetch,
    out: (l) => console.log(l),
  });
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
