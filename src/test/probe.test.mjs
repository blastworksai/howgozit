import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProbe, parseArgs } from '../scripts/probe.mjs';

const TOKEN = 'tok-SECRET-123';
const REPO = 'sam-life/scratch';
const R = `/repos/${REPO}`;

// A small in-memory GitHub. Records every request as { method, path, headers, body }.
function fakeGithub({ isPrivate = true, ownerType = 'Organization', failOn = null, dueShift = false, hand = {}, gqlErrorOn = null, noItemsEtag = false, lag = 0, dueWrong = false } = {}) {
  const requests = [];
  const st = { milestones: new Map(), issues: new Map(), labels: new Set(), files: new Map(), nextMs: 1, nextIssue: 1, version: 1, unexpected: [], projects: new Map(), nextProject: 1, gql: [], itemPolls: 0, itemQueries: [] };
  const reply = (status, body, headers = {}) => new Response(status === 204 || status === 304 ? null : JSON.stringify(body ?? {}), { status, headers });
  const etag = () => `W/"v${st.version}"`;
  const msView = (m) => ({ number: m.number, due_on: m.due_on });
  const issueView = (i) => ({ node_id: `I_${i.number}`, number: i.number, state: i.state, state_reason: i.state_reason, labels: [...i.labels].map((name) => ({ name })), milestone: i.milestone ? { number: i.milestone } : null });

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, path, headers: init.headers || {}, body });
    if (failOn && failOn(method, path)) return reply(500, { message: `server error, token was ${TOKEN}` });
    const p = u.pathname;
    let m;
    if (method === 'GET' && p === R) return reply(200, { private: isPrivate, owner: { type: ownerType, login: 'sam-life', node_id: 'O_sam' }, default_branch: 'main' });
    if (method === 'POST' && p === `${R}/milestones`) {
      const n = st.nextMs++; st.version++;
      let due = body.due_on;
      if (dueShift && due) due = new Date(Date.parse(due) - 5 * 3600 * 1000 - 86400000).toISOString().replace('.000', '');
      st.milestones.set(n, { number: n, due_on: due });
      return reply(201, msView(st.milestones.get(n)));
    }
    if ((m = p.match(/^\/repos\/sam-life\/scratch\/milestones\/(\d+)$/))) {
      const n = Number(m[1]);
      if (method === 'GET') {
        if (hand[n]) return reply(200, { number: n, due_on: hand[n] });
        return st.milestones.has(n) ? reply(200, msView(st.milestones.get(n))) : reply(404, { message: 'Not Found' });
      }
      if (method === 'DELETE') { st.version++; return st.milestones.delete(n) ? reply(204) : reply(404, { message: 'Not Found' }); }
    }
    if (method === 'GET' && p === `${R}/milestones`) return reply(200, [...st.milestones.values()].map(msView), { ETag: etag() });
    if (method === 'POST' && p === `${R}/issues`) {
      const n = st.nextIssue++; st.version++;
      st.issues.set(n, { number: n, state: 'open', state_reason: null, labels: new Set(), milestone: null });
      return reply(201, issueView(st.issues.get(n)));
    }
    if (method === 'GET' && p === `${R}/issues`) {
      if (init.headers && init.headers['If-None-Match'] === etag()) return reply(304);
      return reply(200, [...st.issues.values()].map(issueView), { ETag: etag() });
    }
    if ((m = p.match(/^\/repos\/sam-life\/scratch\/issues\/(\d+)$/)) && method === 'PATCH') {
      const i = st.issues.get(Number(m[1]));
      if (!i) return reply(404, { message: 'Not Found' });
      st.version++;
      if (body.state) { i.state = body.state; i.state_reason = body.state_reason ?? null; }
      if (body.labels) i.labels = new Set(body.labels);
      if (body.milestone !== undefined) i.milestone = body.milestone;
      return reply(200, issueView(i));
    }
    if (method === 'POST' && p === `${R}/labels`) { st.labels.add(body.name); st.version++; return reply(201, { name: body.name }); }
    if ((m = p.match(/^\/repos\/sam-life\/scratch\/labels\/(.+)$/)) && method === 'DELETE') {
      st.version++;
      return st.labels.delete(decodeURIComponent(m[1])) ? reply(204) : reply(404, { message: 'Not Found' });
    }
    if ((m = p.match(/^\/repos\/sam-life\/scratch\/contents\/(.+)$/))) {
      const f = m[1];
      if (method === 'PUT') {
        const had = st.files.get(f);
        if (had && body.sha !== had) return reply(409, { message: 'sha does not match' });
        const sha = `sha${++st.version}`;
        st.files.set(f, sha);
        return reply(had ? 200 : 201, { content: { sha } });
      }
      if (method === 'GET') return st.files.has(f) ? reply(200, { sha: st.files.get(f) }, { ETag: etag() }) : reply(404, { message: 'Not Found' });
      if (method === 'DELETE') {
        if (st.files.get(f) !== body.sha) return reply(409, { message: 'sha does not match' });
        st.files.delete(f); st.version++;
        return reply(200, {});
      }
    }
    if (method === 'POST' && p === '/graphql') {
      const op = (body.query.match(/(\w+)\(input/) || [])[1];
      st.gql.push({ op, variables: body.variables });
      if (gqlErrorOn === op) return reply(200, { data: null, errors: [{ message: `cannot do ${op}` }] });
      const v = body.variables;
      if (op === 'createProjectV2') {
        const n = st.nextProject++;
        st.projects.set(`PVT_${n}`, { number: n, title: v.title, items: [], hasDue: false });
        return reply(200, { data: { createProjectV2: { projectV2: { id: `PVT_${n}`, number: n } } } });
      }
      const proj = st.projects.get(v.projectId);
      if (!proj) return reply(200, { data: null, errors: [{ message: 'Could not resolve to a ProjectV2' }] });
      if (op === 'createProjectV2Field') { proj.hasDue = true; return reply(200, { data: { createProjectV2Field: { projectV2Field: { id: 'F_due', name: v.name } } } }); }
      if (op === 'addProjectV2ItemById') {
        const num = Number(String(v.contentId).replace('I_', ''));
        const item = { id: `ITEM_${num}`, number: num, due: null };
        proj.items.push(item);
        return reply(200, { data: { addProjectV2ItemById: { item: { id: item.id } } } });
      }
      if (op === 'updateProjectV2ItemFieldValue') {
        const item = proj.items.find((i) => i.id === v.itemId);
        item.due = dueWrong ? '2030-06-16' : v.date;
        return reply(200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } } });
      }
      if (op === 'deleteProjectV2') { st.projects.delete(v.projectId); return reply(200, { data: { deleteProjectV2: { projectV2: { id: v.projectId } } } }); }
    }
    if (method === 'GET' && (p === '/orgs/sam-life/projectsV2' || p === '/users/sam-life/projectsV2')) {
      return reply(200, [...st.projects.values()].map((x) => ({ number: x.number, title: x.title, state: 'open', closed_at: null })));
    }
    if ((m = p.match(/^\/(?:orgs|users)\/sam-life\/projectsV2\/(\d+)\/fields$/)) && method === 'GET') {
      const proj = [...st.projects.values()].find((x) => x.number === Number(m[1]));
      if (!proj) return reply(404, { message: 'Not Found' });
      const defs = [{ id: 7001, name: 'Title', data_type: 'title' }, { id: 7003, name: 'Status', data_type: 'single_select' }];
      if (proj.hasDue) defs.push({ id: 7005, name: 'Due', data_type: 'date' });
      return reply(200, defs);
    }
    if ((m = p.match(/^\/(?:orgs|users)\/sam-life\/projectsV2\/(\d+)\/items$/))) {
      const proj = [...st.projects.values()].find((x) => x.number === Number(m[1]));
      if (!proj) return reply(404, { message: 'Not Found' });
      if (method === 'POST') { proj.items.push({ id: `REST_${body.number}`, number: body.number, due: null }); return reply(201, { id: 1 }); }
      st.itemPolls++;
      st.itemQueries.push(u.search);
      const asked = (u.searchParams.get('fields') || '').split(',').filter(Boolean);
      const view = (it) => {
        const fields = [{ id: 7001, name: 'Title', data_type: 'title', value: { raw: 'probe check' } }];
        if (asked.includes('7003')) fields.push({ id: 7003, name: 'Status', data_type: 'single_select', value: { name: { raw: 'Todo' } } });
        if (asked.includes('7005')) fields.push({ id: 7005, name: 'Due', data_type: 'date', value: it.due ? `${it.due}T00:00:00+00:00` : null });
        return { id: 900 + it.number, content_type: 'Issue', archived_at: null, content: { number: it.number, repository: { full_name: 'sam-life/scratch' } }, fields };
      };
      const shown = st.itemPolls <= lag ? [] : proj.items.map(view);
      return reply(200, shown, noItemsEtag ? {} : { ETag: etag() });
    }
    st.unexpected.push(`${method} ${path}`);
    return reply(404, { message: 'Not Found' });
  }
  return { fetch, requests, st };
}

const run = (gh, extra = {}) => {
  const out = [];
  return runProbe({ repo: REPO, token: TOKEN, fetch: gh.fetch, out: (l) => out.push(l), ...extra }).then((r) => ({ ...r, out }));
};
const sig = (requests) => requests.map((r) => `${r.method} ${r.path}`);
const normalise = (s) => s
  .replace('/{orgs|users}/', '/OWNERKIND/')
  .replace(/\/(orgs|users)\//, '/OWNERKIND/')
  .replace(/\{[^}]*\}/g, '#')
  .replace(/fields=[\d,]+/, 'fields=#')
  .replace(/(?<=\/)\d+(?=$|[/?])/g, '#');

function assertAllRemoved(gh) {
  assert.equal(gh.st.milestones.size, 0, 'milestone left behind');
  assert.equal(gh.st.files.size, 0, 'file left behind');
  assert.equal(gh.st.labels.size, 0, 'label left behind');
  assert.equal(gh.st.projects.size, 0, 'Project left behind');
  for (const i of gh.st.issues.values()) {
    assert.equal(i.state, 'closed');
    assert.equal(i.state_reason, 'not_planned');
  }
}

test('U a public repo is refused after exactly one request and nothing is created', async () => {
  const gh = fakeGithub({ isPrivate: false });
  const r = await run(gh);
  assert.equal(gh.requests.length, 1);
  assert.equal(gh.requests[0].method, 'GET');
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /not private/);
  assert.equal(gh.st.milestones.size + gh.st.issues.size + gh.st.files.size + gh.st.labels.size, 0);
});

test('U every request stays on the api host and inside the named repo or the owner Projects path', async () => {
  for (const ownerType of ['Organization', 'User']) {
    const gh = fakeGithub({ ownerType });
    const r = await run(gh, { handMilestone: 7, handDate: '2030-01-01' });
    assert.ok(r.lines.length > 0);
    const projects = ownerType === 'Organization' ? '/orgs/sam-life/projectsV2' : '/users/sam-life/projectsV2';
    for (const q of gh.requests) {
      const ok = q.url.startsWith(`https://api.github.com${R}`) || q.url.startsWith(`https://api.github.com${projects}`) || q.url === 'https://api.github.com/graphql';
      assert.ok(ok, `unexpected target ${q.url}`);
      assert.equal(q.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(q.headers['X-GitHub-Api-Version'], '2026-03-10');
      assert.equal(q.headers.Accept, 'application/vnd.github+json');
      assert.ok(q.headers['User-Agent']);
    }
    assert.deepEqual(gh.st.unexpected, []);
  }
});

test('U a clean run passes V3, V7 and V8, removes everything and ends with cleanup done', async () => {
  const gh = fakeGithub();
  const r = await run(gh);
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.match(r.lines.find((l) => l.startsWith('V3 ')), /^V3 pass \(due_on read back as 2030-06-15T12:00:00Z\)$/);
  assert.equal(r.lines.find((l) => l.startsWith('V7 ')), 'V7 pass');
  assert.match(r.lines.find((l) => l.startsWith('V8 ')), /^V8 pass/);
  assert.equal(r.lines.at(-1), 'cleanup done');
  assertAllRemoved(gh);
});

test('U everything created is removed again when a middle step answers 500', async () => {
  const cases = [
    (m, p) => m === 'POST' && p.endsWith('/labels'),
    (m, p) => m === 'PUT' && p.includes('/contents/'),
    (() => { let n = 0; return (m, p) => m === 'PATCH' && p.includes('/issues/') && ++n === 3; })(),
    (m, p) => m === 'GET' && p.includes('/milestones?'),
  ];
  for (const failOn of cases) {
    const gh = fakeGithub({ failOn: (m, p) => failOn(m, p) });
    const r = await run(gh);
    assert.equal(r.ok, false);
    assert.ok(r.lines.some((l) => /^V[78] FAIL: HTTP 500/.test(l)), r.lines.join('\n'));
    assertAllRemoved(gh);
  }
});

test('U clean-up still runs when the label step fails and says so when a removal itself fails', async () => {
  const gh = fakeGithub({ failOn: (m, p) => m === 'DELETE' && p.includes('/milestones/') });
  const r = await run(gh);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^cleanup FAILED: left behind: milestone #1/);
});

test('U the token appears in no output line and no error, even when GitHub echoes it', async () => {
  const gh = fakeGithub({ failOn: (m, p) => m === 'POST' && p.endsWith('/issues') });
  const r = await run(gh);
  assert.ok(r.lines.length > 0);
  for (const l of [...r.lines, ...r.out]) assert.ok(!l.includes(TOKEN), l);
  assert.ok(r.lines.some((l) => l.includes('***')));
  const broken = await runProbe({ repo: REPO, token: TOKEN, out: () => {}, fetch: async () => { throw new Error(`boom ${TOKEN}`); } });
  for (const l of broken.lines) assert.ok(!l.includes(TOKEN));
  assert.equal(broken.ok, false);
});

test('U a missing token is one plain sentence and not ok', async () => {
  const gh = fakeGithub();
  const r = await runProbe({ repo: REPO, token: '', fetch: gh.fetch });
  assert.equal(r.ok, false);
  assert.equal(r.lines.length, 1);
  assert.equal(gh.requests.length, 0);
});

test('U --dry-run sends nothing and lists the methods and paths a real run then sends, in order', async () => {
  let sent = 0;
  const dry = await runProbe({ repo: REPO, token: undefined, dryRun: true, fetch: async () => { sent++; throw new Error('must not be called'); }, handMilestone: 7, handDate: '2030-01-01' });
  assert.equal(sent, 0);
  assert.equal(dry.ok, true);
  for (const l of dry.lines) assert.match(l, /^(GET|POST|PATCH|PUT|DELETE) \/\S*( \(\w+\))?$/);
  for (const l of dry.lines) assert.ok(!l.includes('http') && !l.includes(TOKEN));
  const gh = fakeGithub();
  const real = await run(gh, { handMilestone: 7, handDate: '2030-01-01', fetch: gh.fetch });
  assert.equal(gh.requests.length, dry.lines.length);
  assert.deepEqual(sig(gh.requests).map(normalise), dry.lines.map((l) => normalise(l.replace(/ \(\w+\)$/, ''))));
  assert.ok(dry.lines.includes('POST /graphql (createProjectV2)'));
  assert.ok(dry.lines.includes('POST /graphql (deleteProjectV2)'));
});

test('U a V3 that reads back a different date prints FAIL and the run is not ok', async () => {
  const gh = fakeGithub({ dueShift: true });
  const r = await run(gh);
  assert.equal(r.ok, false);
  const v3 = r.lines.find((l) => l.startsWith('V3 '));
  assert.match(v3, /^V3 FAIL: due_on read back as 2030-06-14T/);
  assert.equal(r.lines.filter((l) => l.startsWith('V3 ')).length, 1);
  assertAllRemoved(gh);
});

test('U V6 skips without its options and passes or fails with them', async () => {
  const none = await run(fakeGithub());
  assert.match(none.lines.find((l) => l.startsWith('V6 ')), /^V6 skip: /);
  const pass = await run(fakeGithub({ hand: { 9: '2030-03-04T08:00:00Z' } }), { handMilestone: 9, handDate: '2030-03-04' });
  assert.equal(pass.lines.find((l) => l.startsWith('V6 ')), 'V6 pass (raw due_on 2030-03-04T08:00:00Z)');
  const bad = await run(fakeGithub({ hand: { 9: '2030-03-03T07:00:00Z' } }), { handMilestone: 9, handDate: '2030-03-04' });
  assert.match(bad.lines.find((l) => l.startsWith('V6 ')), /^V6 FAIL: .*2030-03-03T07:00:00Z/);
  assert.equal(bad.ok, false);
  const only = await run(fakeGithub(), { handMilestone: 9 });
  assert.match(only.lines.find((l) => l.startsWith('V6 ')), /^V6 skip: /);
});

test('U the owner type picks V1 or V2 and the right Projects path', async () => {
  const org = fakeGithub({ ownerType: 'Organization' });
  const ro = await run(org);
  assert.ok(sig(org.requests).includes('GET /orgs/sam-life/projectsV2'));
  assert.ok(!sig(org.requests).some((s) => s.includes('/users/')));
  assert.match(ro.lines.find((l) => l.startsWith('V1 ')), /^V1 pass /);
  assert.ok(!ro.lines.some((l) => l.startsWith('V2 ')));
  const usr = fakeGithub({ ownerType: 'User' });
  const ru = await run(usr);
  assert.ok(sig(usr.requests).includes('GET /users/sam-life/projectsV2'));
  assert.match(ru.lines.find((l) => l.startsWith('V2 ')), /^V2 pass /);
  assert.ok(!ru.lines.some((l) => l.startsWith('V1 ')));
});

test('U the options parse', () => {
  const o = parseArgs(['--repo', REPO, '--dry-run', '--samples', 'x', '--hand-milestone', '4', '--hand-date', '2030-01-01']);
  assert.deepEqual(o, { dryRun: true, repo: REPO, samples: 'x', handMilestone: '4', handDate: '2030-01-01' });
});

const v = (r, tag) => r.lines.find((l) => l.startsWith(`${tag} `));

test('U the scratch Project title is the name of the repo, not a fixed word', async () => {
  const gh = fakeGithub();
  await run(gh);
  const create = gh.st.gql.find((g) => g.op === 'createProjectV2');
  assert.equal(create.variables.title, 'scratch');
  assert.equal(create.variables.ownerId, 'O_sam');
});

test('U the only address outside the repo and the owner Projects path is /graphql', async () => {
  const gh = fakeGithub();
  await run(gh);
  const other = gh.requests.filter((q) => !q.path.startsWith(R) && !q.path.startsWith('/orgs/sam-life/projectsV2'));
  assert.ok(other.length >= 5);
  for (const q of other) {
    assert.equal(q.url, 'https://api.github.com/graphql');
    assert.equal(q.method, 'POST');
  }
});

test('U a GraphQL answer with errors at add-field fails V4 there and the Project is still deleted', async () => {
  const gh = fakeGithub({ gqlErrorOn: 'createProjectV2Field' });
  const r = await run(gh);
  assert.equal(r.ok, false);
  assert.match(v(r, 'V4'), /^V4 FAIL at add-field: cannot do createProjectV2Field$/);
  assert.ok(!gh.st.gql.some((g) => g.op === 'addProjectV2ItemById'));
  assert.ok(gh.st.gql.some((g) => g.op === 'deleteProjectV2'));
  assertAllRemoved(gh);
  assert.equal(r.lines.at(-1), 'cleanup done');
});

test('U the Project that is deleted is the one this run created', async () => {
  const gh = fakeGithub();
  await run(gh);
  const del = gh.st.gql.filter((g) => g.op === 'deleteProjectV2');
  assert.equal(del.length, 1);
  assert.equal(del[0].variables.projectId, 'PVT_1');
  assert.equal(gh.st.gql.filter((g) => g.op === 'createProjectV2').length, 1);
  assert.equal(gh.st.projects.size, 0);
});

test('U a failed Project delete is named in the clean-up line and fails V4', async () => {
  const gh = fakeGithub({ gqlErrorOn: 'deleteProjectV2' });
  const r = await run(gh);
  assert.match(v(r, 'V4'), /^V4 FAIL at delete: /);
  assert.match(r.lines.at(-1), /^cleanup FAILED: left behind: Project PVT_1/);
  assert.equal(r.ok, false);
});

test('U with --samples exactly three files are written and neither holds the token', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-samples-'));
  try {
    const dir = path.join(tmp, 'live');
    const r = await run(fakeGithub(), { samples: dir });
    assert.equal(v(r, 'V5'), 'V5 pass (saved 3 files)');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['project-fields.json', 'project-items.json', 'projects-list.json']);
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!text.includes(TOKEN));
      assert.doesNotThrow(() => JSON.parse(text));
    }
    assert.equal(fs.readdirSync(tmp).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('U without --samples nothing is written and V5 says it was skipped', async () => {
  const before = fs.readdirSync(process.cwd()).sort();
  const r = await run(fakeGithub());
  assert.equal(v(r, 'V5'), 'V5 skip: no --samples folder');
  assert.deepEqual(fs.readdirSync(process.cwd()).sort(), before);
});

test('U V1 for an Organization and V2 for a User both list the items and add by REST', async () => {
  for (const [ownerType, tag, base] of [['Organization', 'V1', '/orgs/sam-life'], ['User', 'V2', '/users/sam-life']]) {
    const gh = fakeGithub({ ownerType });
    const r = await run(gh);
    assert.equal(r.ok, true, r.lines.join('\n'));
    const s = sig(gh.requests);
    assert.ok(s.includes(`GET ${base}/projectsV2`));
    assert.ok(s.includes(`GET ${base}/projectsV2/1/items?fields=7003,7005`));
    assert.ok(s.includes(`POST ${base}/projectsV2/1/items`));
    assert.equal(v(r, tag), `${tag} pass (items list showed the issue after 0.0s; Status "Todo", Due 2030-06-15; REST add answered 201; both issues listed after 0.0s)`);
    assert.match(v(r, 'V4'), /^V4 pass/);
    assert.match(v(r, 'V8'), /^V8 pass \(etag on issues, milestones, contents, project items/);
    assert.ok(!r.lines.some((l) => l.startsWith(tag === 'V1' ? 'V2 ' : 'V1 ')));
  }
});

test('U a REST add that fails after a working GraphQL add says exactly that', async () => {
  const gh = fakeGithub({ failOn: (m, p) => m === 'POST' && p.endsWith('/projectsV2/1/items') });
  const r = await run(gh);
  assert.match(v(r, 'V1'), /^V1 FAIL: the REST add to the Project failed \(HTTP 500.*\) although the GraphQL add worked$/);
  assertAllRemoved(gh);
});

const clock = () => { let t = 0; return { sleep: async (ms) => { t += ms; }, now: () => t }; };

test('U a lag of two polls passes and reports how long the list took', async () => {
  const gh = fakeGithub({ ownerType: 'User', lag: 2 });
  const r = await run(gh, clock());
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.equal(v(r, 'V2'), 'V2 pass (items list showed the issue after 3.0s; Status "Todo", Due 2030-06-15; REST add answered 201; both issues listed after 0.0s)');
  assertAllRemoved(gh);
});

test('U an item that never appears fails after exactly 8 polls and still cleans up', async () => {
  const gh = fakeGithub({ ownerType: 'User', lag: 1000 });
  const r = await run(gh, clock());
  assert.equal(r.ok, false);
  assert.match(v(r, 'V2'), /^V2 FAIL: the items list did not show our issue #1 after 8 tries \(10\.5s\)$/);
  assert.equal(gh.st.itemQueries.filter((q) => q.startsWith('?fields=')).length >= 8, true);
  assert.equal(gh.st.itemPolls >= 8, true);
  assertAllRemoved(gh);
  assert.equal(r.lines.at(-1), 'cleanup done');
});

test('U the first poll of an item that never appears sends exactly 8 requests', async () => {
  const gh = fakeGithub({ lag: 1000 });
  await run(gh, clock());
  const cut = gh.requests.findIndex((q) => /\/milestones\?/.test(q.path));
  const polls = gh.requests.slice(0, cut < 0 ? undefined : cut).filter((q) => q.method === 'GET' && /\/projectsV2\/1\/items\?fields=/.test(q.path));
  assert.equal(polls.length, 8);
});

test('U a Due that reads back as another date fails V1', async () => {
  const gh = fakeGithub({ dueWrong: true });
  const r = await run(gh);
  assert.equal(r.ok, false);
  assert.match(v(r, 'V1'), /^V1 FAIL: the listed item showed Due 2030-06-16, expected 2030-06-15 \(Status "Todo"\)$/);
  assertAllRemoved(gh);
});

test('U the items request carries a fields parameter with the two ids from the fields answer', async () => {
  const gh = fakeGithub();
  await run(gh);
  const s = sig(gh.requests);
  assert.ok(s.includes('GET /orgs/sam-life/projectsV2/1/fields'));
  assert.ok(s.includes('GET /orgs/sam-life/projectsV2/1/items?fields=7003,7005'));
  assert.ok(!s.includes('GET /orgs/sam-life/projectsV2/1/items'));
  assert.ok(gh.st.itemQueries.every((q) => q === '?fields=7003,7005'));
});

test('U the dry run lists the fields request and each items poll once', async () => {
  const dry = await runProbe({ repo: REPO, dryRun: true });
  assert.equal(dry.lines.filter((l) => /\/projectsV2\/\{project\}\/fields$/.test(l)).length, 1);
  assert.equal(dry.lines.filter((l) => /\/items\?fields=\{fieldIds\}$/.test(l)).length, 3);
});

test('U missing ETag on project items alone is reported as V8 FAIL', async () => {
  const r = await run(fakeGithub({ noItemsEtag: true }));
  assert.equal(v(r, 'V8'), 'V8 FAIL: no ETag on project items');
  assert.equal(r.ok, false);
});

test('U a 500 in the middle still deletes the Project, milestone, file and label and closes both issues', async () => {
  const gh = fakeGithub({ failOn: (m, p) => m === 'PUT' && p.includes('/contents/') });
  const r = await run(gh);
  assert.equal(r.ok, false);
  assert.ok(gh.st.gql.some((g) => g.op === 'deleteProjectV2'));
  assert.equal(gh.st.issues.size, 2);
  assertAllRemoved(gh);
  const late = fakeGithub({ failOn: (m, p) => m === 'GET' && p.includes('/milestones?') });
  await run(late);
  assertAllRemoved(late);
});
