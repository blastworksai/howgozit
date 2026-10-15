import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { createHttp } from '../board/github/http.mjs';
import { undoRecord } from '../scripts/undo.mjs';

const REPO = 'owner/name';
const R = '/repos/' + REPO;
const CFG = 'board.config.json';

// A world built only through the fake's own write calls; the record is what setup would have written.
async function build({ repo = REPO, fileId } = {}) {
  const fake = createFakeGitHub({ repo });
  const { http } = fake;
  const Rr = '/repos/' + repo;
  const created = [];
  const note = (type, name, number, id) => created.push({ type, name, number, id, url: null });
  const label = await http.send('POST', Rr + '/labels', { name: 'board' });
  note('label', 'board', null, String(label.id));
  const ms = await http.send('POST', Rr + '/milestones', { title: 'Autumn' });
  note('milestone', 'Autumn', ms.number, String(ms.id));
  const data = await http.graphql('mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}', { ownerId: 'O_1', title: 'Life' });
  const proj = data.createProjectV2.projectV2;
  note('project', 'Life', proj.number, proj.id);
  const listed = [];
  for (const title of ['Plan the week', 'Buy paint']) {
    const issue = await http.send('POST', Rr + '/issues', { title, milestone: ms.number, labels: ['board'] });
    note('issue', title, issue.number, String(issue.id));
    await http.send('POST', '/orgs/' + repo.split('/')[0] + '/projectsV2/' + proj.number + '/items', { type: 'Issue', owner: repo.split('/')[0], repo: repo.split('/')[1], number: issue.number });
    listed.push(issue);
  }
  const put = await http.send('PUT', Rr + '/contents/' + CFG, { message: 'Board settings', content: Buffer.from('{"version":1}\n').toString('base64') });
  note('file', CFG, null, fileId === undefined ? put.content.sha : fileId);
  return { fake, record: { version: 1, repo, created }, ms, proj, listed, sha: put.content.sha };
}

const writes = (fake, from = 0) => fake.calls.slice(from).filter((c) => c.method !== 'GET');
const mentions = (message, title, number) => message.includes(title) || message.includes('#' + number);
const quiet = { force: false, say: () => {} };

// The fake's own client, but with its paged read wrapped.
function withPaged(fake, wrap) {
  return { ...fake.http, paged: (path, opts) => wrap(path, opts, () => fake.http.paged(path, opts)) };
}

function response(status, json) {
  const text = json === undefined ? '' : JSON.stringify(json);
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => (text ? JSON.parse(text) : {}),
    text: async () => text,
  };
}

test('S7 running undo again after everything is gone, through the real client, finishes ok', async () => {
  const seen = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const p = u.pathname;
    seen.push(method + ' ' + p);
    if (method === 'GET' && p === '/repos/owner/name') {
      return response(200, { full_name: REPO, owner: { login: 'owner', type: 'Organization' }, name: 'name' });
    }
    if (method === 'GET' && /^\/(orgs|users)\/owner\/projectsV2\/1\/items$/.test(p)) return response(404, { message: 'Not Found' });
    if (method === 'GET' && p === '/repos/owner/name/issues') return response(422, { message: 'Validation Failed' });
    if (method === 'GET' && p === '/repos/owner/name/milestones/1') return response(404, { message: 'Not Found' });
    if (method === 'PATCH' && p === '/repos/owner/name/issues/1') return response(200, { number: 1, state: 'closed' });
    if (method === 'DELETE' && p === '/repos/owner/name/milestones/1') return response(404, { message: 'Not Found' });
    if (method === 'DELETE' && p === '/repos/owner/name/labels/board') return response(404, { message: 'Not Found' });
    if (method === 'GET' && p === '/repos/owner/name/contents/' + CFG) return response(404, { message: 'Not Found' });
    if (method === 'POST' && p === '/graphql') {
      return response(200, {
        data: { deleteProjectV2: null },
        errors: [{ type: 'NOT_FOUND', path: ['deleteProjectV2'], message: "Could not resolve to a node with the global id of 'PVT_x'." }],
      });
    }
    return response(500, { message: 'unscripted ' + method + ' ' + p });
  };
  const http = createHttp({ token: 'T', fetch });
  const record = {
    version: 1, repo: REPO,
    created: [
      { type: 'label', name: 'board', number: null, id: '1', url: null },
      { type: 'milestone', name: 'Autumn', number: 1, id: '2', url: null },
      { type: 'project', name: 'Life', number: 1, id: 'PVT_x', url: null },
      { type: 'issue', name: 'Plan the week', number: 1, id: '3', url: null },
      { type: 'file', name: CFG, number: null, id: 'sha-recorded', url: null },
    ],
  };
  const res = await undoRecord(http, record, quiet);
  assert.equal(res.ok, true, res.message + ' | ' + seen.join(', '));
});

test('S7 undo run twice with the same record finishes ok both times', async () => {
  const w = await build();
  const first = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(first.ok, true, first.message);
  const second = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(second.ok, true, second.message);
});

test('S7 undo asks for a recorded milestone itself and never lists the issues of one that is gone', async () => {
  const w = await build();
  await w.fake.http.send('DELETE', R + '/milestones/' + w.ms.number);
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
  const seen = w.fake.calls.slice(from);
  const listed = seen.filter((c) => c.method === 'GET' && /\/issues\?/.test(c.path) && new RegExp('[?&]milestone=' + w.ms.number + '(&|$)').test(c.path));
  assert.deepEqual(listed, [], 'issue lists for the gone milestone: ' + JSON.stringify(listed));
});

test('S7 a settings file changed since setup is refused without force and nothing is written', async () => {
  const w = await build({ fileId: 'sha-from-setup' });
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, false);
  assert.match(res.message, /changed/i);
  assert.match(res.message, /board\.config\.json/);
  assert.equal(writes(w.fake, from).length, 0);
  assert.equal(CFG in w.fake.state.files, true);
});

test('S7 a settings file changed since setup goes with force', async () => {
  const w = await build({ fileId: 'sha-from-setup' });
  const res = await undoRecord(w.fake.http, w.record, { force: true, say: () => {} });
  assert.equal(res.ok, true, res.message);
  assert.equal(CFG in w.fake.state.files, false);
});

test('S7 a settings file with the recorded sha is deleted without force', async () => {
  const w = await build();
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
  assert.equal(CFG in w.fake.state.files, false);
});

test('S7 a settings file entry with no recorded sha (an old record) is deleted without force', async () => {
  const w = await build({ fileId: null });
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
  assert.equal(CFG in w.fake.state.files, false);
});

test('S7 undo deletes no file but the settings file, whatever the record lists', async () => {
  const w = await build();
  w.fake.state.files['README.md'] = { text: 'hello', sha: 'S_readme' };
  w.record.created.push({ type: 'file', name: 'README.md', number: null, id: null, url: null });
  w.record.created.push({ type: 'file', name: '../other/contents/x', number: null, id: null, url: null });
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
  const named = w.fake.calls.slice(from).filter((c) => /README|other|\.\./.test(c.path));
  assert.deepEqual(named, []);
  assert.equal('README.md' in w.fake.state.files, true);
  assert.equal(CFG in w.fake.state.files, false);
  const kept = (res.kept || []).map((k) => k && k.name);
  assert.ok(kept.includes('README.md'), JSON.stringify(res.kept));
  assert.ok(kept.includes('../other/contents/x'), JSON.stringify(res.kept));
});

test('S7 a record repo not written owner/name is refused with one line and no request at all', async () => {
  for (const repo of ['a/b/c', '../x', 'a b/c', 'owner', '/name']) {
    const fake = createFakeGitHub({ repo: REPO });
    const res = await undoRecord(fake.http, { version: 1, repo, created: [{ type: 'label', name: 'board', number: null, id: '1', url: null }] }, quiet);
    assert.equal(res.ok, false, repo);
    assert.equal(fake.calls.length, 0, 'requests for ' + repo + ': ' + JSON.stringify(fake.calls));
    assert.equal(typeof res.message, 'string');
    assert.ok(res.message.length > 0 && !res.message.includes('\n'), repo);
  }
});

test('S7 a record repo with letters, digits, dots, dashes and underscores is accepted', async () => {
  const w = await build({ repo: 'my-org/board.data_1' });
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
});

test('S7 a milestone whose issue list is more than undo can read is refused without force, written nothing', async () => {
  const w = await build();
  const http = withPaged(w.fake, async (path, opts, real) => {
    const out = await real();
    return /milestone=/.test(path) ? { ...out, partial: true } : out;
  });
  const from = w.fake.calls.length;
  const res = await undoRecord(http, w.record, quiet);
  assert.equal(res.ok, false);
  assert.match(res.message, /could not check/i);
  assert.equal(writes(w.fake, from).length, 0);
});

test('S7 a Project whose items are more than undo can read is refused without force, written nothing', async () => {
  const w = await build();
  const http = withPaged(w.fake, async (path, opts, real) => {
    const out = await real();
    return /projectsV2\/\d+\/items/.test(path) ? { ...out, partial: true } : out;
  });
  const from = w.fake.calls.length;
  const res = await undoRecord(http, w.record, quiet);
  assert.equal(res.ok, false);
  assert.match(res.message, /could not check/i);
  assert.equal(writes(w.fake, from).length, 0);
});

test('S7 force goes ahead past a partial read of a milestone and of a Project', async () => {
  const w = await build();
  const http = withPaged(w.fake, async (path, opts, real) => ({ ...(await real()), partial: true }));
  const res = await undoRecord(http, w.record, { force: true, say: () => {} });
  assert.equal(res.ok, true, res.message);
});

test('S7 a pull request in a listed milestone is refused without force and named, written nothing', async () => {
  const w = await build();
  const http = withPaged(w.fake, async (path, opts, real) => {
    const out = await real();
    if (!/milestone=/.test(path)) return out;
    return { ...out, items: [...out.items, { number: 99, title: 'A pull request', state: 'open', pull_request: { url: 'x' } }] };
  });
  const from = w.fake.calls.length;
  const res = await undoRecord(http, w.record, quiet);
  assert.equal(res.ok, false);
  assert.ok(mentions(res.message, 'A pull request', 99), res.message);
  assert.equal(writes(w.fake, from).length, 0);
});

test('S7 only the record own issues in the milestone go ahead', async () => {
  const w = await build();
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
});

function addItem(w, content) {
  w.fake.state.projects[0].items.push({
    id: 7000 + w.fake.state.projects[0].items.length, node_id: 'PI_x' + w.fake.state.projects[0].items.length,
    content_type: 'Issue', content, fields: [], status: 'Todo', due: null,
  });
}

test('S7 a Project item of another repo carrying a listed number is refused without force and named', async () => {
  const w = await build();
  addItem(w, { number: w.listed[0].number, title: 'Theirs', repository: { full_name: 'owner/other' } });
  const from = w.fake.calls.length;
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, false);
  assert.ok(mentions(res.message, 'Theirs', w.listed[0].number), res.message);
  assert.equal(writes(w.fake, from).length, 0);
});

test('S7 a Project item of the record repo in other letter case is the record own', async () => {
  const w = await build();
  addItem(w, { number: w.listed[0].number, title: 'Ours', repository: { full_name: 'OWNER/Name' } });
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
});

test('S7 a Project item with no repository key is the record own', async () => {
  const w = await build();
  addItem(w, { number: w.listed[0].number, title: 'Ours' });
  const res = await undoRecord(w.fake.http, w.record, quiet);
  assert.equal(res.ok, true, res.message);
});
