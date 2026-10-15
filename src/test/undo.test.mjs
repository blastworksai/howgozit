import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { main, undoRecord } from '../scripts/undo.mjs';

const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const TOKEN = 'SENTINEL-TOKEN-123';

// A world built only through the fake's own write calls, with a record collected as setup would.
async function build({ extraInMilestone = false, extraInProject = false, withField = true } = {}) {
  const fake = createFakeGitHub({ repo: REPO });
  const { http } = fake;
  const created = [];
  const note = (type, name, number, id, url) => created.push({ type, name, number, id, url });

  // Things that existed before setup and are not in the record.
  await http.send('POST', R + '/labels', { name: 'old-label' });
  const oldMilestone = await http.send('POST', R + '/milestones', { title: 'Old milestone' });
  const oldIssue = await http.send('POST', R + '/issues', { title: 'Old issue' });

  const label = await http.send('POST', R + '/labels', { name: 'board' });
  note('label', 'board', null, String(label.id), null);

  const ms = await http.send('POST', R + '/milestones', { title: 'Autumn' });
  note('milestone', 'Autumn', ms.number, String(ms.id), ms.html_url);

  const data = await http.graphql('mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}', { ownerId: 'O_1', title: 'Life' });
  const proj = data.createProjectV2.projectV2;
  note('project', 'Life', proj.number, proj.id, null);
  if (withField) {
    const f = await http.graphql('mutation($projectId:ID!,$name:String!){createProjectV2Field(input:{projectId:$projectId,dataType:DATE,name:$name}){projectV2Field{id name}}}', { projectId: proj.id, name: 'Due' });
    note('field', 'Due', null, f.createProjectV2Field.projectV2Field.id, null);
  }

  const listed = [];
  for (const title of ['Plan the week', 'Buy paint']) {
    const issue = await http.send('POST', R + '/issues', { title, milestone: ms.number, labels: ['board'] });
    note('issue', title, issue.number, String(issue.id), issue.html_url);
    await http.send('POST', '/orgs/sam-life/projectsV2/' + proj.number + '/items', { type: 'Issue', owner: 'sam-life', repo: 'life', number: issue.number });
    listed.push(issue);
  }

  const put = await http.send('PUT', R + '/contents/board.config.json', { message: 'Board settings', content: Buffer.from('{"version":1}\n').toString('base64') });
  note('file', 'board.config.json', null, put.content.sha, null);

  let stranger = null;
  if (extraInMilestone) {
    stranger = await http.send('POST', R + '/issues', { title: 'Stranger task', milestone: ms.number });
  }
  if (extraInProject) {
    stranger = await http.send('POST', R + '/issues', { title: 'Outsider task' });
    await http.send('POST', '/orgs/sam-life/projectsV2/' + proj.number + '/items', { type: 'Issue', owner: 'sam-life', repo: 'life', number: stranger.number });
  }

  const record = { version: 1, repo: REPO, created };
  return { fake, record, ms, proj, listed, oldIssue, oldMilestone, stranger };
}

const writes = (fake, from = 0) => fake.calls.slice(from).filter((c) => c.method !== 'GET');

function mentions(message, issue) {
  return message.includes(issue.title) || message.includes('#' + issue.number);
}

test('S7 undo removes exactly what the record lists and leaves earlier things alone', async () => {
  const w = await build();
  const res = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(res.ok, true, res.message);
  for (const l of w.listed) {
    const now = w.fake.state.issues.find((i) => i.number === l.number);
    assert.equal(now.state, 'closed');
    assert.equal(now.state_reason, 'not_planned');
  }
  assert.equal(w.fake.state.milestones.some((m) => m.title === 'Autumn'), false);
  assert.equal(w.fake.state.projects.length, 0);
  assert.equal(w.fake.state.labels.some((l) => l.name === 'board'), false);
  assert.equal('board.config.json' in w.fake.state.files, false);
  // What existed before is untouched.
  const old = w.fake.state.issues.find((i) => i.number === w.oldIssue.number);
  assert.equal(old.state, 'open');
  assert.equal(w.fake.state.labels.some((l) => l.name === 'old-label'), true);
  assert.equal(w.fake.state.milestones.some((m) => m.title === 'Old milestone'), true);
});

test('S7 undo writes in the order issues, milestones, Projects, labels, file', async () => {
  const w = await build();
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(res.ok, true, res.message);
  const rank = (c) => {
    if (c.method === 'PATCH' && c.path.startsWith(R + '/issues/')) return 0;
    if (c.method === 'DELETE' && c.path.startsWith(R + '/milestones/')) return 1;
    if (c.method === 'GRAPHQL' && c.path === 'deleteProjectV2') return 2;
    if (c.method === 'DELETE' && c.path.startsWith(R + '/labels/')) return 3;
    if (c.method === 'DELETE' && c.path.startsWith(R + '/contents/')) return 4;
    return -1;
  };
  const ranks = writes(w.fake, from).map(rank);
  assert.equal(ranks.includes(-1), false, 'only the five kinds of write are made');
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.deepEqual([...new Set(ranks)], [0, 1, 2, 3, 4]);
});

test('S7 a milestone holding an issue the record does not list is refused with no writes', async () => {
  const w = await build({ extraInMilestone: true });
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(res.ok, false);
  assert.equal(writes(w.fake, from).length, 0);
  assert.ok(mentions(res.message, w.stranger), res.message);
  assert.equal(w.fake.state.milestones.some((m) => m.title === 'Autumn'), true);
});

test('S7 a Project holding an item the record does not list is refused with no writes', async () => {
  const w = await build({ extraInProject: true });
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(res.ok, false);
  assert.equal(writes(w.fake, from).length, 0);
  assert.ok(mentions(res.message, w.stranger), res.message);
  assert.equal(w.fake.state.projects.length, 1);
});

test('S7 force goes ahead on a milestone with an unlisted issue and says what else went', async () => {
  const w = await build({ extraInMilestone: true });
  const res = await undoRecord(w.fake.http, w.record, { force: true, say: () => {} });
  assert.equal(res.ok, true, res.message);
  assert.equal(w.fake.state.milestones.some((m) => m.title === 'Autumn'), false);
  assert.ok(mentions(res.message, w.stranger), res.message);
});

test('S7 force goes ahead on a Project with an unlisted item and says what else went', async () => {
  const w = await build({ extraInProject: true });
  const res = await undoRecord(w.fake.http, w.record, { force: true, say: () => {} });
  assert.equal(res.ok, true, res.message);
  assert.equal(w.fake.state.projects.length, 0);
  assert.ok(mentions(res.message, w.stranger), res.message);
});

test('S7 force leaves the unlisted issue itself open', async () => {
  const w = await build({ extraInMilestone: true });
  await undoRecord(w.fake.http, w.record, { force: true, say: () => {} });
  const stranger = w.fake.state.issues.find((i) => i.number === w.stranger.number);
  assert.equal(stranger.state, 'open');
});

test('S7 a refused undo changes nothing, so a record with no extras afterwards still undoes', async () => {
  const w = await build({ extraInMilestone: true });
  const first = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(first.ok, false);
  const issue = w.fake.state.issues.find((i) => i.number === w.listed[0].number);
  assert.equal(issue.state, 'open');
  assert.equal(w.fake.state.labels.some((l) => l.name === 'board'), true);
  assert.equal('board.config.json' in w.fake.state.files, true);
});

test('U an object already gone on GitHub counts as removed and does not stop the run', async () => {
  const w = await build();
  await w.fake.http.send('DELETE', R + '/labels/board');
  const res = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(res.ok, true, res.message);
  assert.equal('board.config.json' in w.fake.state.files, false);
  assert.equal(w.fake.state.projects.length, 0);
});

test('U an issue and a Project already gone do not stop the run either', async () => {
  const w = await build();
  await w.fake.http.graphql('mutation($projectId:ID!){deleteProjectV2(input:{projectId:$projectId){projectV2{id}}}', { projectId: w.proj.id });
  const res = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(res.ok, true, res.message);
  assert.equal(w.fake.state.milestones.some((m) => m.title === 'Autumn'), false);
  assert.equal('board.config.json' in w.fake.state.files, false);
});

test('U a field entry causes no call of its own', async () => {
  const w = await build({ withField: true });
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(res.ok, true, res.message);
  const odd = writes(w.fake, from).filter((c) => /field/i.test(c.path));
  assert.deepEqual(odd, []);
  const deletes = writes(w.fake, from).filter((c) => c.method === 'GRAPHQL');
  assert.equal(deletes.length, 1);
});

test('U a record for another repo is refused with one plain sentence and no writes', async () => {
  const w = await build();
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, { ...w.record, repo: 'other-owner/other-repo' }, { force: false, say: () => {} });
  assert.equal(res.ok, false);
  assert.equal(typeof res.message, 'string');
  assert.ok(res.message.length > 0 && !res.message.includes('\n'));
  assert.equal(writes(w.fake, from).length, 0);
});

test('U a record with version 2 is refused with one plain sentence and no writes', async () => {
  const w = await build();
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, { ...w.record, version: 2 }, { force: false, say: () => {} });
  assert.equal(res.ok, false);
  assert.ok(res.message.length > 0 && !res.message.includes('\n'));
  assert.equal(writes(w.fake, from).length, 0);
});

test('U a record that is not an object is refused with one plain sentence and no writes', async () => {
  for (const bad of ['just text', 42, null, [1, 2]]) {
    const fake = createFakeGitHub({ repo: REPO });
    const res = await undoRecord(fake.http, bad, { force: false, say: () => {} });
    assert.equal(res.ok, false);
    assert.ok(res.message.length > 0 && !res.message.includes('\n'));
    assert.equal(writes(fake).length, 0);
  }
});

test('U a GitHub failure midway returns ok false without throwing and says to run undo again', async () => {
  const w = await build();
  w.fake.fail({ method: 'DELETE', path: R + '/milestones/' }, new GitHubError('server', 500));
  let res;
  await assert.doesNotReject(async () => {
    res = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /again/i);
  // The issues before the failure were closed; the label after it was not reached.
  assert.equal(w.fake.state.labels.some((l) => l.name === 'board'), true);
});

test('U running undo again after a midway failure finishes the job', async () => {
  const w = await build();
  w.fake.fail({ method: 'DELETE', path: R + '/milestones/' }, new GitHubError('server', 500));
  const first = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(first.ok, false);
  const second = await undoRecord(w.fake.http, w.record, { force: false, say: () => {} });
  assert.equal(second.ok, true);
  assert.equal(w.fake.state.projects.length, 0);
  assert.equal(w.fake.state.labels.some((l) => l.name === 'board'), false);
});

// ---- main ----

const API = 'https://api.github.com';
function response(status, json) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => json,
    text: async () => (json === null || json === undefined ? '' : JSON.stringify(json)),
  };
}
function fetchFor(fake) {
  return async (url, init = {}) => {
    const p = String(url).startsWith(API) ? String(url).slice(API.length) : String(url);
    try {
      if (p === '/graphql') {
        const b = JSON.parse(init.body);
        return response(200, { data: await fake.http.graphql(b.query, b.variables) });
      }
      if (init.method === 'GET' || !init.method) return response(200, (await fake.http.get(p)).json);
      const body = init.body ? JSON.parse(init.body) : undefined;
      return response(200, await fake.http.send(init.method, p, body));
    } catch (e) {
      return response(e && e.status ? e.status : 500, {});
    }
  };
}

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'undo-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const exists = async (p) => fs.access(p).then(() => true, () => false);

function collect() {
  const lines = [];
  return { lines, fn: (...a) => lines.push(a.join(' ')) };
}

test('U main with no token prints one plain sentence and exits 1', async () => {
  await withDir(async (dir) => {
    const out = collect();
    const err = collect();
    const code = await main(['--yes'], { env: {}, cwd: dir, out: out.fn, err: err.fn, fetch: async () => { throw new Error('no network'); } });
    assert.equal(code, 1);
    assert.equal(err.lines.length + out.lines.length, 1);
  });
});

test('U main with no record file prints one plain sentence and exits 1', async () => {
  await withDir(async (dir) => {
    const fake = createFakeGitHub({ repo: REPO });
    const out = collect();
    const err = collect();
    const code = await main(['--yes'], { env: { BOARD_GITHUB_TOKEN: TOKEN }, cwd: dir, out: out.fn, err: err.fn, fetch: fetchFor(fake) });
    assert.equal(code, 1);
    assert.equal(err.lines.length + out.lines.length, 1);
    assert.equal(writes(fake).length, 0);
    assert.equal([...err.lines, ...out.lines].join('\n').includes(TOKEN), false);
  });
});

test('U main with an answer other than undo changes nothing and keeps the record', async () => {
  await withDir(async (dir) => {
    const w = await build();
    await fs.writeFile(path.join(dir, 'setup-undo.json'), JSON.stringify(w.record));
    const from = w.fake.calls.length;
    const out = collect();
    const err = collect();
    await main([], { env: { BOARD_GITHUB_TOKEN: TOKEN }, cwd: dir, out: out.fn, err: err.fn, fetch: fetchFor(w.fake), readLine: async () => 'maybe' });
    const all = [...out.lines, ...err.lines].join('\n');
    assert.match(all, /nothing was changed/i);
    assert.equal(writes(w.fake, from).length, 0);
    assert.equal(await exists(path.join(dir, 'setup-undo.json')), true);
    assert.equal(await exists(path.join(dir, 'setup-undo.done.json')), false);
  });
});

test('U main with --yes after a full undo renames the record to setup-undo.done.json', async () => {
  await withDir(async (dir) => {
    const w = await build();
    await fs.writeFile(path.join(dir, 'setup-undo.json'), JSON.stringify(w.record));
    const out = collect();
    const err = collect();
    const code = await main(['--yes'], { env: { BOARD_GITHUB_TOKEN: TOKEN }, cwd: dir, out: out.fn, err: err.fn, fetch: fetchFor(w.fake), readLine: async () => { throw new Error('must not ask'); } });
    assert.equal(code, 0);
    assert.equal(await exists(path.join(dir, 'setup-undo.json')), false);
    assert.equal(await exists(path.join(dir, 'setup-undo.done.json')), true);
    assert.equal(w.fake.state.projects.length, 0);
  });
});

test('U main answering undo on the prompt carries the undo out', async () => {
  await withDir(async (dir) => {
    const w = await build();
    await fs.writeFile(path.join(dir, 'setup-undo.json'), JSON.stringify(w.record));
    const out = collect();
    const err = collect();
    const code = await main([], { env: { BOARD_GITHUB_TOKEN: TOKEN }, cwd: dir, out: out.fn, err: err.fn, fetch: fetchFor(w.fake), readLine: async () => 'undo' });
    assert.equal(code, 0);
    assert.equal(w.fake.state.labels.some((l) => l.name === 'board'), false);
  });
});

test('U main never prints the token on any output line', async () => {
  await withDir(async (dir) => {
    const w = await build({ extraInMilestone: true });
    await fs.writeFile(path.join(dir, 'setup-undo.json'), JSON.stringify(w.record));
    const out = collect();
    const err = collect();
    // A refusal run, a declined run and a forced run, all with the sentinel token.
    const env = { BOARD_GITHUB_TOKEN: TOKEN };
    await main(['--yes'], { env, cwd: dir, out: out.fn, err: err.fn, fetch: fetchFor(w.fake) });
    await main([], { env, cwd: dir, out: out.fn, err: err.fn, fetch: fetchFor(w.fake), readLine: async () => 'no' });
    await main(['--yes', '--force'], { env, cwd: dir, out: out.fn, err: err.fn, fetch: fetchFor(w.fake) });
    const all = [...out.lines, ...err.lines].join('\n');
    assert.ok(all.length > 0);
    assert.equal(all.includes(TOKEN), false);
  });
});
