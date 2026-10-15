import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { undoRecord } from '../scripts/undo.mjs';

const REPO = 'owner/name';
const R = '/repos/' + REPO;
const CFG = 'board.config.json';
const ITEMS = /projectsV2\/\d+\/items/;

// A world built only through the fake's own write calls; the record is what setup would have written.
async function build() {
  const fake = createFakeGitHub({ repo: REPO });
  const { http } = fake;
  const created = [];
  const note = (type, name, number, id) => created.push({ type, name, number, id, url: null });
  const label = await http.send('POST', R + '/labels', { name: 'board' });
  note('label', 'board', null, String(label.id));
  const ms = await http.send('POST', R + '/milestones', { title: 'Autumn' });
  note('milestone', 'Autumn', ms.number, String(ms.id));
  const data = await http.graphql('mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}', { ownerId: 'O_1', title: 'Life' });
  const proj = data.createProjectV2.projectV2;
  note('project', 'Life', proj.number, proj.id);
  const listed = [];
  for (const title of ['Plan the week', 'Buy paint']) {
    const issue = await http.send('POST', R + '/issues', { title, milestone: ms.number, labels: ['board'] });
    note('issue', title, issue.number, String(issue.id));
    await http.send('POST', '/orgs/owner/projectsV2/' + proj.number + '/items', { type: 'Issue', owner: 'owner', repo: 'name', number: issue.number });
    listed.push(issue);
  }
  const put = await http.send('PUT', R + '/contents/' + CFG, { message: 'Board settings', content: Buffer.from('{"version":1}\n').toString('base64') });
  note('file', CFG, null, put.content.sha);
  return { fake, record: { version: 1, repo: REPO, created }, ms, proj, listed };
}

const writes = (fake, from = 0) => fake.calls.slice(from).filter((c) => c.method !== 'GET');
const quiet = { force: false, say: () => {} };
const notFound = () => new GitHubError('not-found', 404);

// Same shape as the fake's client; `over` replaces any of get, paged, send, graphql.
function wrap(fake, over) {
  const real = fake.http;
  return {
    get: (...a) => (over.get ? over.get(real, ...a) : real.get(...a)),
    paged: (...a) => (over.paged ? over.paged(real, ...a) : real.paged(...a)),
    send: (...a) => (over.send ? over.send(real, ...a) : real.send(...a)),
    graphql: (...a) => (over.graphql ? over.graphql(real, ...a) : real.graphql(...a)),
  };
}

// Either "returns ok false" or "rejects" counts as a stop.
async function runStop(http, record, opts = quiet) {
  try {
    const res = await undoRecord(http, record, opts);
    return { stopped: res.ok === false, res };
  } catch (e) {
    return { stopped: true, res: { message: String(e && e.message) } };
  }
}

async function stateOf(w) {
  const issues = [];
  for (const i of w.listed) issues.push((await w.fake.http.get(R + '/issues/' + i.number)).json.state);
  let milestone = true;
  try { await w.fake.http.get(R + '/milestones/' + w.ms.number); } catch { milestone = false; }
  return { issues, milestone, projects: w.fake.state.projects.length, file: CFG in w.fake.state.files };
}

test('S7 a milestone found whose issue list then answers not found stops undo and changes nothing', async () => {
  const w = await build();
  const before = await stateOf(w);
  const http = wrap(w.fake, {
    paged: async (real, path, opts) => {
      if (/milestone=/.test(path)) throw notFound();
      return real.paged(path, opts);
    },
  });
  const from = w.fake.calls.length;
  const out = await runStop(http, w.record);
  assert.equal(out.stopped, true, 'undo went ahead: ' + JSON.stringify(out.res));
  assert.equal(writes(w.fake, from).length, 0, JSON.stringify(writes(w.fake, from)));
  assert.deepEqual(await stateOf(w), before);
  assert.equal(before.milestone, true);
});

test('S7 a milestone that itself answers not found counts as already gone and undo finishes ok', async () => {
  const w = await build();
  await w.fake.http.send('DELETE', R + '/milestones/' + w.ms.number);
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
  assert.equal(CFG in w.fake.state.files, false);
});

test('S7 a Project whose first items request answers not found counts as already gone and undo finishes ok', async () => {
  const w = await build();
  const http = wrap(w.fake, {
    get: async (real, path) => { if (ITEMS.test(path)) throw notFound(); return real.get(path); },
    paged: async (real, path, opts) => { if (ITEMS.test(path)) throw notFound(); return real.paged(path, opts); },
  });
  const from = w.fake.calls.length;
  const res = await undoRecord(http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
  const deletes = writes(w.fake, from).filter((c) => /deleteProjectV2/.test(JSON.stringify(c)));
  assert.deepEqual(deletes, [], 'delete mutations: ' + JSON.stringify(deletes));
  assert.equal(w.fake.state.projects.length, 1);
});

test('S7 a later read of a Project items answering not found stops undo and changes nothing', async () => {
  const w = await build();
  const before = await stateOf(w);
  // The items path answers normally the first time it is requested (by get or paged), and throws not-found on every later request.
  let seen = 0;
  const gate = () => { seen += 1; if (seen > 1) throw notFound(); };
  const http = wrap(w.fake, {
    get: async (real, path) => { if (ITEMS.test(path)) gate(); return real.get(path); },
    paged: async (real, path, opts) => { if (ITEMS.test(path)) gate(); return real.paged(path, opts); },
  });
  const from = w.fake.calls.length;
  const out = await runStop(http, w.record);
  assert.equal(out.stopped, true, 'undo went ahead: ' + JSON.stringify(out.res));
  assert.equal(writes(w.fake, from).length, 0, JSON.stringify(writes(w.fake, from)));
  assert.deepEqual(await stateOf(w), before);
  assert.equal(before.projects, 1);
});

// On the first non-GET request undo makes, the settings file is rewritten first, then the request goes through.
function editBeforeFirstWrite(w) {
  let edited = false;
  return wrap(w.fake, {
    send: async (real, method, path, body) => {
      if (!edited && method !== 'GET') {
        edited = true;
        const cur = await real.get(R + '/contents/' + CFG);
        await real.send('PUT', R + '/contents/' + CFG, { message: 'Hand edit', sha: cur.json.sha, content: Buffer.from('{"version":2,"mine":true}\n').toString('base64') });
      }
      return real.send(method, path, body);
    },
  });
}

test('S7 a settings file edited after undo looked and before it is deleted stops undo without force and stays', async () => {
  const w = await build();
  const http = editBeforeFirstWrite(w);
  const out = await runStop(http, w.record);
  assert.equal(out.stopped, true, 'undo deleted the edited file: ' + JSON.stringify(out.res));
  assert.match(out.res.message, /changed/i);
  assert.equal(CFG in w.fake.state.files, true);
  assert.equal(w.fake.state.files[CFG].text, '{"version":2,"mine":true}\n');
  for (const i of w.listed) assert.equal((await w.fake.http.get(R + '/issues/' + i.number)).json.state, 'closed');
});

test('S7 a settings file edited after undo looked and before it is deleted goes with force', async () => {
  const w = await build();
  const http = editBeforeFirstWrite(w);
  const res = await undoRecord(http, w.record, { force: true, say: () => {} });
  assert.equal(res.ok, true, res.message);
  assert.equal(CFG in w.fake.state.files, false);
});

test('S7 a settings file not edited in between, with the recorded sha, is deleted without force', async () => {
  const w = await build();
  const http = wrap(w.fake, {});
  const res = await undoRecord(http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
  assert.equal(CFG in w.fake.state.files, false);
});
