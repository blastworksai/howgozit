import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { readAll } from '../board/github/read.mjs';
import { checkRaw } from '../board/shape-data.mjs';

const R = '/repos/sam-life/life';
const P = '/orgs/sam-life/projectsV2';
const text = (v) => JSON.stringify(v, null, 2) + '\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function rejects(promise, kind, status) {
  await assert.rejects(promise, (e) => e.name === 'GitHubError' && e.kind === kind && e.status === status);
}

const NEW_PROJECT = 'mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}';
const NEW_FIELD = 'mutation($projectId:ID!,$name:String!){createProjectV2Field(input:{projectId:$projectId,dataType:DATE,name:$name}){projectV2Field{... on ProjectV2Field{id name}}}}';
const SET_VALUE = 'mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$date:Date!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{date:$date}}){projectV2Item{id}}}';
const ADD_BY_ID = 'mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}';
const DELETE_PROJECT = 'mutation($projectId:ID!){deleteProjectV2(input:{projectId:$projectId}){projectV2{id}}}';

test('U the repo answer carries privacy and owner type', async () => {
  const org = createFakeGitHub();
  const a = (await org.http.get(R)).json;
  assert.equal(a.private, true);
  assert.equal(a.owner.type, 'Organization');
  assert.equal(a.owner.login, 'sam-life');
  const user = createFakeGitHub({ ownerType: 'user', isPrivate: false });
  const b = (await user.http.get(R)).json;
  assert.equal(b.private, false);
  assert.equal(b.owner.type, 'User');
});

test('U an address of another repo is not found', async () => {
  const f = createFakeGitHub();
  await rejects(f.http.get('/repos/other/thing'), 'not-found', 404);
  await rejects(f.http.get(R + '/nothing-here'), 'not-found', 404);
});

test('U a label is created, listed and deleted', async () => {
  const f = createFakeGitHub();
  const made = await f.http.send('POST', R + '/labels', { name: 'idea', color: 'ededed' });
  assert.equal(made.name, 'idea');
  const list = await f.http.paged(R + '/labels?per_page=100', { maxPages: 5 });
  assert.deepEqual(list.items.map((l) => l.name), ['idea']);
  assert.equal(list.partial, false);
  assert.equal(await f.http.send('DELETE', R + '/labels/idea'), null);
  assert.equal((await f.http.paged(R + '/labels?per_page=100', { maxPages: 5 })).items.length, 0);
  await rejects(f.http.send('DELETE', R + '/labels/idea'), 'not-found', 404);
});

test('U a duplicate label is refused with invalid 422', async () => {
  const f = createFakeGitHub();
  await f.http.send('POST', R + '/labels', { name: 'habit:move' });
  await rejects(f.http.send('POST', R + '/labels', { name: 'Habit:Move' }), 'invalid', 422);
  assert.equal(f.state.labels.length, 1);
});

test('U a label name with a colon is found by its encoded path', async () => {
  const f = createFakeGitHub();
  await f.http.send('POST', R + '/labels', { name: 'habit:move' });
  await f.http.send('DELETE', R + '/labels/' + encodeURIComponent('habit:move'));
  assert.equal(f.state.labels.length, 0);
});

test('U a milestone is created, listed by state and deleted', async () => {
  const f = createFakeGitHub();
  const a = await f.http.send('POST', R + '/milestones', { title: 'House · Hallway', due_on: '2026-11-20T12:00:00Z' });
  const b = await f.http.send('POST', R + '/milestones', { title: 'Garden' });
  assert.equal(a.number, 1);
  assert.equal(b.number, 2);
  assert.equal(a.due_on, '2026-11-20T12:00:00Z');
  assert.equal(b.due_on, null);
  await f.http.send('PATCH', R + '/milestones/2', { state: 'closed' });
  const open = await f.http.paged(R + '/milestones?per_page=100', { maxPages: 1 });
  assert.equal(open.items.length, 1);
  const all = await f.http.paged(R + '/milestones?state=all&per_page=100', { maxPages: 10 });
  assert.equal(all.items.length, 2);
  await f.http.send('DELETE', R + '/milestones/1');
  assert.deepEqual(f.state.milestones.map((m) => m.title), ['Garden']);
});

test('U a duplicate milestone title is refused and a missing one is not found', async () => {
  const f = createFakeGitHub();
  await f.http.send('POST', R + '/milestones', { title: 'Garden' });
  await rejects(f.http.send('POST', R + '/milestones', { title: 'garden' }), 'invalid', 422);
  await rejects(f.http.send('DELETE', R + '/milestones/9'), 'not-found', 404);
});

test('U an issue is created with labels and a milestone and read back', async () => {
  const f = createFakeGitHub();
  await f.http.send('POST', R + '/labels', { name: 'home' });
  await f.http.send('POST', R + '/milestones', { title: 'Hallway' });
  const made = await f.http.send('POST', R + '/issues', { title: 'Paint', labels: ['home', 'extra'], milestone: 1 });
  assert.equal(made.number, 1);
  assert.equal(made.state, 'open');
  assert.deepEqual(made.labels.map((l) => l.name), ['home', 'extra']);
  assert.deepEqual({ number: made.milestone.number, title: made.milestone.title }, { number: 1, title: 'Hallway' });
  const one = (await f.http.get(R + '/issues/1')).json;
  assert.equal(one.title, 'Paint');
  await rejects(f.http.get(R + '/issues/5'), 'not-found', 404);
  await rejects(f.http.send('POST', R + '/issues', { title: 'x', milestone: 8 }), 'invalid', 422);
});

test('U an issue patch changes title, labels, milestone and state', async () => {
  const f = createFakeGitHub();
  await f.http.send('POST', R + '/milestones', { title: 'Hallway' });
  const made = await f.http.send('POST', R + '/issues', { title: 'Paint', labels: ['a', 'b'] });
  const patched = await f.http.send('PATCH', R + '/issues/1', { title: 'Paint it', labels: ['b'], milestone: 1 });
  assert.equal(patched.title, 'Paint it');
  assert.deepEqual(patched.labels.map((l) => l.name), ['b']);
  assert.equal(patched.milestone.number, 1);
  assert.ok(Date.parse(patched.updated_at) > Date.parse(made.updated_at));
  const closed = await f.http.send('PATCH', R + '/issues/1', { state: 'closed', state_reason: 'not_planned' });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.state_reason, 'not_planned');
  assert.ok(closed.closed_at);
  const unset = await f.http.send('PATCH', R + '/issues/1', { milestone: null });
  assert.equal(unset.milestone, null);
  const reopened = await f.http.send('PATCH', R + '/issues/1', { state: 'open' });
  assert.equal(reopened.state_reason, null);
  assert.equal(reopened.closed_at, null);
});

test('U the issue list honours state and since', async () => {
  const f = createFakeGitHub();
  await f.http.send('POST', R + '/issues', { title: 'One' });
  await f.http.send('POST', R + '/issues', { title: 'Two' });
  const mid = f.state.issues[1].updated_at;
  await f.http.send('PATCH', R + '/issues/1', { state: 'closed' });
  const open = await f.http.paged(R + '/issues?per_page=100', { maxPages: 1 });
  assert.deepEqual(open.items.map((i) => i.number), [2]);
  const all = await f.http.paged(R + '/issues?state=all&per_page=100&t=5', { maxPages: 1 });
  assert.deepEqual(all.items.map((i) => i.number), [1, 2]);
  const since = await f.http.paged(R + '/issues?state=all&per_page=100&since=' + mid, { maxPages: 1 });
  assert.deepEqual(since.items.map((i) => i.number), [1, 2]);
  const late = await f.http.paged(R + '/issues?state=all&since=' + f.state.issues[0].updated_at, { maxPages: 1 });
  assert.deepEqual(late.items.map((i) => i.number), [1]);
});

test('U a file is written, read as base64 and given a new sha on update', async () => {
  const f = createFakeGitHub();
  const first = await f.http.send('PUT', R + '/contents/board.config.json', { message: 'Board settings', content: b64('{"a":1}\n') });
  assert.equal(first.content.path, 'board.config.json');
  const read = (await f.http.get(R + '/contents/board.config.json')).json;
  assert.equal(read.encoding, 'base64');
  assert.equal(read.sha, first.content.sha);
  assert.equal(Buffer.from(read.content, 'base64').toString('utf8'), '{"a":1}\n');
  const second = await f.http.send('PUT', R + '/contents/board.config.json', { message: 'm', content: b64('{"a":2}\n'), sha: first.content.sha });
  assert.notEqual(second.content.sha, first.content.sha);
  assert.equal(f.state.files['board.config.json'].text, '{"a":2}\n');
});

test('U a file write without the current sha is refused', async () => {
  const f = createFakeGitHub({ files: { 'a.json': '{}' } });
  await rejects(f.http.send('PUT', R + '/contents/a.json', { message: 'm', content: b64('{"x":1}') }), 'invalid', 422);
  await rejects(f.http.send('PUT', R + '/contents/a.json', { message: 'm', content: b64('{"x":1}'), sha: 'stale' }), 'invalid', 422);
  await rejects(f.http.send('PUT', R + '/contents/new.json', { message: 'm', content: b64('{}'), sha: 'S_1' }), 'invalid', 422);
  assert.equal(f.state.files['a.json'].text, '{}');
});

test('U a file delete needs the sha and a missing file is not found', async () => {
  const f = createFakeGitHub({ files: { 'a.json': '{}' } });
  await rejects(f.http.send('DELETE', R + '/contents/a.json', { message: 'm' }), 'invalid', 422);
  const sha = (await f.http.get(R + '/contents/a.json')).json.sha;
  await f.http.send('DELETE', R + '/contents/a.json', { message: 'm', sha });
  assert.deepEqual(f.state.files, {});
  await rejects(f.http.get(R + '/contents/a.json'), 'not-found', 404);
  await rejects(f.http.send('DELETE', R + '/contents/a.json', { message: 'm', sha }), 'not-found', 404);
});

test('U createProjectV2 makes a Project with Title and Status fields and no Due', async () => {
  const f = createFakeGitHub();
  const out = await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' });
  assert.equal(out.createProjectV2.projectV2.number, 1);
  const list = await f.http.paged(P + '?per_page=100', { maxPages: 10 });
  assert.equal(list.items[0].title, 'House');
  assert.equal(list.items[0].state, 'open');
  assert.equal(list.items[0].node_id, out.createProjectV2.projectV2.id);
  const fields = await f.http.paged(P + '/1/fields?per_page=100', { maxPages: 2 });
  assert.deepEqual(fields.items.map((x) => x.name), ['Title', 'Status']);
  assert.ok(fields.items.every((x) => typeof x.id === 'number' && typeof x.node_id === 'string'));
  await rejects(f.http.graphql(NEW_PROJECT, { ownerId: 'wrong', title: 'x' }), 'invalid', 422);
});

test('U createProjectV2Field adds Due once and refuses a second', async () => {
  const f = createFakeGitHub();
  const proj = (await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' })).createProjectV2.projectV2;
  const due = await f.http.graphql(NEW_FIELD, { projectId: proj.id, name: 'Due' });
  assert.equal(due.createProjectV2Field.projectV2Field.name, 'Due');
  const fields = await f.http.paged(P + '/1/fields?per_page=100', { maxPages: 2 });
  const f3 = fields.items.find((x) => x.name === 'Due');
  assert.equal(f3.node_id, due.createProjectV2Field.projectV2Field.id);
  assert.equal(f3.data_type, 'date');
  await rejects(f.http.graphql(NEW_FIELD, { projectId: proj.id, name: 'Due' }), 'invalid', 422);
  await rejects(f.http.graphql(NEW_FIELD, { projectId: 'P_99', name: 'Due' }), 'not-found', 404);
});

test('U an issue is added to a Project by REST and a second add is refused with invalid 422', async () => {
  const f = createFakeGitHub();
  await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' });
  await f.http.send('POST', R + '/issues', { title: 'Paint' });
  const body = { type: 'Issue', owner: 'sam-life', repo: 'life', number: 1 };
  const a = await f.http.send('POST', P + '/1/items', body);
  await rejects(f.http.send('POST', P + '/1/items', body), 'invalid', 422);
  assert.equal(a.node_id, f.state.projects[0].items[0].node_id);
  assert.equal(f.state.projects[0].items.length, 1);
  await rejects(f.http.send('POST', P + '/1/items', { ...body, number: 7 }), 'not-found', 404);
  await rejects(f.http.send('POST', P + '/4/items', body), 'not-found', 404);
});

test('U addProjectV2ItemById adds an issue by its node id', async () => {
  const f = createFakeGitHub();
  const proj = (await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' })).createProjectV2.projectV2;
  const issue = await f.http.send('POST', R + '/issues', { title: 'Paint' });
  const out = await f.http.graphql(ADD_BY_ID, { projectId: proj.id, contentId: issue.node_id });
  assert.equal(f.state.projects[0].items[0].node_id, out.addProjectV2ItemById.item.id);
  await rejects(f.http.graphql(ADD_BY_ID, { projectId: proj.id, contentId: 'I_99' }), 'not-found', 404);
});

test('U items carry Status Todo and Due once set, and only a Title without the fields parameter', async () => {
  const f = createFakeGitHub();
  const proj = (await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' })).createProjectV2.projectV2;
  const dueField = (await f.http.graphql(NEW_FIELD, { projectId: proj.id, name: 'Due' })).createProjectV2Field.projectV2Field;
  await f.http.send('POST', R + '/issues', { title: 'Paint' });
  await f.http.send('POST', R + '/issues', { title: 'Sand' });
  const one = await f.http.send('POST', P + '/1/items', { type: 'Issue', owner: 'sam-life', repo: 'life', number: 1 });
  await f.http.send('POST', P + '/1/items', { type: 'Issue', owner: 'sam-life', repo: 'life', number: 2 });
  const set = await f.http.graphql(SET_VALUE, { projectId: proj.id, itemId: one.node_id, fieldId: dueField.id, date: '2026-11-10' });
  assert.equal(set.updateProjectV2ItemFieldValue.projectV2Item.id, one.node_id);
  const fields = (await f.http.paged(P + '/1/fields?per_page=100', { maxPages: 2 })).items;
  const ids = ['Status', 'Due'].map((nm) => fields.find((x) => x.name === nm).id);
  const withF = (await f.http.paged(P + '/1/items?per_page=100&fields=' + ids.join(','), { maxPages: 20 })).items;
  const entry = (it, nm) => it.fields.find((x) => x.name === nm);
  assert.equal(entry(withF[0], 'Status').value.name.raw, 'Todo');
  assert.equal(entry(withF[0], 'Due').value, '2026-11-10T00:00:00+00:00');
  assert.equal(entry(withF[1], 'Due').value, null);
  assert.equal(withF[0].content_type, 'Issue');
  assert.deepEqual(withF[0].content, { number: 1, title: 'Paint', repository: { full_name: 'sam-life/life' } });
  const plain = (await f.http.paged(P + '/1/items?per_page=100', { maxPages: 20 })).items;
  assert.deepEqual(plain[0].fields.map((x) => x.name), ['Title']);
});

test('U updateProjectV2ItemFieldValue refuses an unknown item and a bad date', async () => {
  const f = createFakeGitHub();
  const proj = (await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' })).createProjectV2.projectV2;
  const dueField = (await f.http.graphql(NEW_FIELD, { projectId: proj.id, name: 'Due' })).createProjectV2Field.projectV2Field;
  await f.http.send('POST', R + '/issues', { title: 'Paint' });
  const it = await f.http.send('POST', P + '/1/items', { type: 'Issue', owner: 'sam-life', repo: 'life', number: 1 });
  await rejects(f.http.graphql(SET_VALUE, { projectId: proj.id, itemId: 'PI_99', fieldId: dueField.id, date: '2026-11-10' }), 'not-found', 404);
  await rejects(f.http.graphql(SET_VALUE, { projectId: proj.id, itemId: it.node_id, fieldId: dueField.id, date: 'soon' }), 'invalid', 422);
});

test('U deleteProjectV2 removes the Project and a second delete is not found', async () => {
  const f = createFakeGitHub();
  const proj = (await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' })).createProjectV2.projectV2;
  const out = await f.http.graphql(DELETE_PROJECT, { projectId: proj.id });
  assert.equal(out.deleteProjectV2.projectV2.id, proj.id);
  assert.equal(f.state.projects.length, 0);
  await rejects(f.http.graphql(DELETE_PROJECT, { projectId: proj.id }), 'not-found', 404);
  await rejects(f.http.get(P + '/1/fields?per_page=100'), 'not-found', 404);
});

test('U an unknown graphql mutation is refused', async () => {
  const f = createFakeGitHub();
  await rejects(f.http.graphql('mutation { somethingElse }', {}), 'invalid', 422);
});

test('U calls records every call and fail throws once for the matching call', async () => {
  const f = createFakeGitHub();
  await f.http.get(R);
  await f.http.send('POST', R + '/labels', { name: 'idea' });
  await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' });
  assert.deepEqual(f.calls.map((c) => c.method), ['GET', 'POST', 'GRAPHQL']);
  assert.equal(f.calls[1].path, R + '/labels');
  assert.deepEqual(f.calls[1].body, { name: 'idea' });
  assert.equal(f.calls[2].path, 'createProjectV2');
  assert.deepEqual(f.calls[2].body, { ownerId: 'O_1', title: 'House' });
  const boom = Object.assign(new Error('x'), { name: 'GitHubError', kind: 'server', status: 500 });
  f.fail({ method: 'POST', path: R + '/labels' }, boom);
  await f.http.get(R);
  await assert.rejects(f.http.send('POST', R + '/labels', { name: 'two' }), (e) => e === boom);
  const made = await f.http.send('POST', R + '/labels', { name: 'two' });
  assert.equal(made.name, 'two');
  f.fail({ method: 'GRAPHQL', path: 'deleteProjectV2' }, boom);
  await assert.rejects(f.http.graphql(DELETE_PROJECT, { projectId: 'P_1' }), (e) => e === boom);
});

test('U the files option seeds the world', async () => {
  const f = createFakeGitHub({ files: { 'theme.json': '{"radius":8}' } });
  const read = (await f.http.get(R + '/contents/theme.json')).json;
  assert.equal(Buffer.from(read.content, 'base64').toString('utf8'), '{"radius":8}');
});

async function buildWorld(f, base) {
  const { http } = f;
  await http.send('POST', R + '/labels', { name: 'idea', color: 'ededed' });
  const proj = (await http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' })).createProjectV2.projectV2;
  const dueField = (await http.graphql(NEW_FIELD, { projectId: proj.id, name: 'Due' })).createProjectV2Field.projectV2Field;
  await http.send('POST', R + '/milestones', { title: 'House · Hallway', due_on: '2026-11-20T12:00:00Z' });
  await http.send('POST', R + '/issues', { title: 'Paint the hallway', milestone: 1 });
  await http.send('POST', R + '/issues', { title: 'Renew passport', labels: ['idea'] });
  const item = await http.send('POST', base + '/' + proj.number + '/items', { type: 'Issue', owner: 'sam-life', repo: 'life', number: 1 });
  await http.graphql(SET_VALUE, { projectId: proj.id, itemId: item.node_id, fieldId: dueField.id, date: '2026-11-10' });
  const settings = text({ version: 1, name: 'Sam', timezone: 'Europe/Brussels', projects: [{ key: 'house', number: proj.number }], focus: ['house'], habits: [] });
  await http.send('PUT', R + '/contents/board.config.json', { message: 'Board settings', content: b64(settings) });
  return settings;
}

test('U the real reader reads a world built through the fake and checkRaw accepts it', async () => {
  const f = createFakeGitHub();
  const settings = await buildWorld(f, P);
  const { raw, texts, warnings } = await readAll(f.http, { repo: 'sam-life/life', full: true, now: '2026-10-12T06:10:00Z' });
  assert.equal(checkRaw(raw).ok, true);
  assert.deepEqual(warnings, []);
  assert.equal(raw.repoPrivate, true);
  assert.equal(raw.ownerType, 'organization');
  assert.equal(raw.issues.length, 2);
  assert.deepEqual(raw.issues[1].labels, ['idea']);
  assert.equal(raw.issues[0].milestone, 1);
  assert.equal(raw.milestones[0].title, 'House · Hallway');
  assert.equal(raw.projects.length, 1);
  const item = raw.projects[0].items[0];
  assert.equal(item.type, 'Issue');
  assert.equal(item.repo, 'sam-life/life');
  assert.equal(item.number, 1);
  assert.equal(item.status, 'Todo');
  assert.equal(item.due.length, 10);
  assert.equal(item.due, '2026-11-10');
  assert.equal(texts.settings, settings);
  assert.equal(texts.theme, null);
  assert.equal(texts.state.brief, null);
});

test('U the real reader reads a user-owned world through users paths', async () => {

  const f2 = createFakeGitHub({ ownerType: 'user' });
  const UP = '/users/sam-life/projectsV2';
  const proj = (await f2.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' })).createProjectV2.projectV2;
  await f2.http.send('POST', R + '/issues', { title: 'Paint' });
  await f2.http.send('POST', UP + '/1/items', { type: 'Issue', owner: 'sam-life', repo: 'life', number: 1 });
  await f2.http.send('PUT', R + '/contents/board.config.json', {
    message: 'm', content: b64(text({ version: 1, projects: [{ key: 'house', number: proj.number }] })),
  });
  await rejects(f2.http.get('/orgs/sam-life/projectsV2?per_page=100'), 'not-found', 404);
  const { raw } = await readAll(f2.http, { repo: 'sam-life/life', full: true, now: '2026-10-12T06:10:00Z' });
  assert.equal(raw.ownerType, 'user');
  assert.equal(checkRaw(raw).ok, true);
  assert.equal(raw.projects[0].url, 'https://github.com/users/sam-life/projects/1');
  assert.equal(raw.projects[0].items[0].status, 'Todo');
  assert.equal(raw.projects[0].items[0].due, null);
  assert.ok(f2.calls.some((c) => c.path.startsWith('/users/sam-life/projectsV2')));
});

test('U a since read returns only issues changed at or after it', async () => {
  const f = createFakeGitHub();
  await buildWorld(f, P);
  const first = await readAll(f.http, { repo: 'sam-life/life', full: true, now: '2026-10-12T06:10:00Z' });
  await f.http.send('PATCH', R + '/issues/2', { title: 'Renew the passport' });
  const since = f.state.issues[1].updated_at;
  const next = await readAll(f.http, { repo: 'sam-life/life', full: false, since, previous: first.raw, now: '2026-10-12T06:15:00Z' });
  assert.equal(checkRaw(next.raw).ok, true);
  assert.equal(next.raw.issues.length, 2);
  assert.equal(next.raw.issues[1].title, 'Renew the passport');
  const getIssues = f.calls.filter((c) => c.path.startsWith(R + '/issues?'));
  assert.ok(getIssues[1].path.includes('since='));
});

test('U addProjectV2ItemById stays idempotent and returns the existing item', async () => {
  const f = createFakeGitHub();
  const proj = (await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' })).createProjectV2.projectV2;
  const issue = await f.http.send('POST', R + '/issues', { title: 'Paint' });
  const a = await f.http.graphql(ADD_BY_ID, { projectId: proj.id, contentId: issue.node_id });
  const b = await f.http.graphql(ADD_BY_ID, { projectId: proj.id, contentId: issue.node_id });
  assert.equal(a.addProjectV2ItemById.item.id, b.addProjectV2ItemById.item.id);
  assert.equal(f.state.projects[0].items.length, 1);
});

test('U lagItems makes the next item lists empty, then lists are truthful again, writes unaffected', async () => {
  const f = createFakeGitHub();
  await f.http.graphql(NEW_PROJECT, { ownerId: 'O_1', title: 'House' });
  await f.http.send('POST', R + '/issues', { title: 'Paint' });
  const body = { type: 'Issue', owner: 'sam-life', repo: 'life', number: 1 };
  f.lagItems(2);
  await f.http.send('POST', P + '/1/items', body);
  assert.equal(f.state.projects[0].items.length, 1);
  await rejects(f.http.send('POST', P + '/1/items', body), 'invalid', 422);
  const before = f.calls.length;
  assert.deepEqual((await f.http.paged(P + '/1/items')).items, []);
  assert.deepEqual((await f.http.paged(P + '/1/items?fields=1,2')).items, []);
  assert.equal(f.calls.length, before + 2);
  assert.equal((await f.http.paged(P + '/1/items')).items.length, 1);
  assert.equal(f.state.projects[0].items.length, 1);
});
