// Tests of the fake Notion's native-schema behaviour (fixture tests: names start with "U ").
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { seedHowgozit } from '../fixtures/notion-howgozit.mjs';

const TOKEN = 'ntn_fake_token';
function client(fake) {
  return async (method, path, body) => {
    const res = await fake.fetch('https://api.notion.com' + path, {
      method,
      headers: { authorization: 'Bearer ' + TOKEN, 'notion-version': '2026-03-11', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
}
const title = (text) => [{ text: { content: text } }];
const names = (page, prop) => page.properties[prop][page.properties[prop].type].map((x) => x.name);

async function seeded(opts) {
  const fake = createFakeNotion();
  const api = client(fake);
  const ids = await seedHowgozit(fake, opts);
  return { fake, api, ids };
}
async function task(api, ids, name, props = {}) {
  const r = await api('POST', '/v1/pages', { parent: { data_source_id: ids.tasks }, properties: { 'Task name': title(name), ...props } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}
const queryTasks = async (api, ids, filter) => (await api('POST', `/v1/data_sources/${ids.tasks}/query`, { filter })).json;

test('U seedHowgozit schema read back has exactly the section-1 names and types', async () => {
  const { api, ids } = await seeded();
  const shape = async (ds) => Object.fromEntries(Object.values((await api('GET', '/v1/data_sources/' + ds)).json.properties).map((p) => [p.name, p.type]));
  assert.deepEqual(await shape(ids.projects), {
    'Project name': 'title', ID: 'unique_id', Status: 'status', Priority: 'select', Dates: 'date', Owner: 'people',
    Tasks: 'relation', Goals: 'relation', Completion: 'rollup',
  });
  assert.deepEqual(await shape(ids.goals), {
    'Goal name': 'title', ID: 'unique_id', Due: 'date', Done: 'checkbox', Project: 'relation', Tasks: 'relation', Completion: 'rollup',
  });
  assert.deepEqual(await shape(ids.tasks), {
    'Task name': 'title', ID: 'unique_id', Status: 'status', Due: 'date', Priority: 'select', Tags: 'multi_select', Assignee: 'people',
    Project: 'relation', Goal: 'relation', 'Blocked by': 'relation', Blocking: 'relation',
  });
  assert.deepEqual(await shape(ids.habitLog), { Name: 'title', ID: 'unique_id', Habit: 'select', Date: 'date', Done: 'checkbox', Score: 'number' });
});

test('U seedHowgozit gives Notion default status options, the mode tags and the habit options', async () => {
  const { api, ids } = await seeded();
  const t = (await api('GET', '/v1/data_sources/' + ids.tasks)).json.properties;
  assert.deepEqual(t.Status.status.options.map((o) => o.name), ['Not started', 'In progress', 'Done']);
  assert.deepEqual(t.Status.status.groups.map((g) => g.name), ['To-do', 'In progress', 'Complete']);
  const idOf = (n) => t.Status.status.options.find((o) => o.name === n).id;
  assert.deepEqual(t.Status.status.groups.map((g) => g.option_ids), [[idOf('Not started')], [idOf('In progress')], [idOf('Done')]]);
  assert.deepEqual(t.Tags.multi_select.options.map((o) => [o.name, o.color]), [['DO', 'red'], ['THINK', 'purple'], ['REVIEW', 'yellow'], ['LAUNCH', 'green'], ['Idea', 'gray']]);
  const h = (await api('GET', '/v1/data_sources/' + ids.habitLog)).json.properties;
  assert.deepEqual(h.Habit.select.options.map((o) => o.name), ['mood', 'walk']);
});

test('U multi_select writes, adds an unknown option and reads back in order', async () => {
  const { api, ids } = await seeded();
  const p = await task(api, ids, 'Paint', { Tags: { multi_select: [{ name: 'DO' }, { name: 'Fresh' }] } });
  assert.deepEqual(names(p, 'Tags'), ['DO', 'Fresh']);
  const ds = (await api('GET', '/v1/data_sources/' + ids.tasks)).json;
  assert.equal(ds.properties.Tags.multi_select.options.find((o) => o.name === 'Fresh').color, 'default');
  const again = (await api('PATCH', '/v1/pages/' + p.id, { properties: { Tags: { multi_select: [] } } })).json;
  assert.deepEqual(again.properties.Tags.multi_select, []);
});

test('U people is an empty array by default and takes ids', async () => {
  const { api, ids } = await seeded();
  const p = await task(api, ids, 'Sweep');
  assert.deepEqual(p.properties.Assignee.people, []);
  const q = (await api('PATCH', '/v1/pages/' + p.id, { properties: { Assignee: { people: [{ id: 'user-1' }] } } })).json;
  assert.deepEqual(q.properties.Assignee.people, [{ object: 'user', id: 'user-1' }]);
});

test('U rollup reads as a null number and a write to it is 400; unique_id write stays 400', async () => {
  const { api, ids } = await seeded();
  const r = await api('POST', '/v1/pages', { parent: { data_source_id: ids.projects }, properties: { 'Project name': title('Garden') } });
  assert.deepEqual(r.json.properties.Completion.rollup, { type: 'number', number: null, function: 'percent_per_group' });
  assert.equal(r.json.properties.Completion.type, 'rollup');
  const bad = await api('PATCH', '/v1/pages/' + r.json.id, { properties: { Completion: { rollup: { number: 1 } } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'validation_error');
  const id = await api('PATCH', '/v1/pages/' + r.json.id, { properties: { ID: { unique_id: { number: 9 } } } });
  assert.equal(id.status, 400);
  assert.equal(r.json.properties.ID.unique_id.number, 1);
});

test('U multi_select filters: contains and does_not_contain', async () => {
  const { api, ids } = await seeded();
  await task(api, ids, 'A', { Tags: { multi_select: [{ name: 'DO' }] } });
  await task(api, ids, 'B', { Tags: { multi_select: [{ name: 'Idea' }, { name: 'DO' }] } });
  await task(api, ids, 'C');
  const out = async (cond) => (await queryTasks(api, ids, { property: 'Tags', multi_select: cond })).results.map((r) => r.properties['Task name'].title[0].plain_text);
  assert.deepEqual(await out({ contains: 'DO' }), ['A', 'B']);
  assert.deepEqual(await out({ does_not_contain: 'Idea' }), ['A', 'C']);
  assert.equal((await api('POST', `/v1/data_sources/${ids.tasks}/query`, { filter: { property: 'Tags', multi_select: { starts_with: 'D' } } })).status, 400);
});

test('U relation filters and or beside and', async () => {
  const { api, ids } = await seeded();
  const proj = (await api('POST', '/v1/pages', { parent: { data_source_id: ids.projects }, properties: { 'Project name': title('Garden') } })).json;
  await task(api, ids, 'In', { Project: { relation: [{ id: proj.id }] } });
  await task(api, ids, 'Out', { Tags: { multi_select: [{ name: 'Idea' }] } });
  const titles = (r) => r.results.map((x) => x.properties['Task name'].title[0].plain_text);
  assert.deepEqual(titles(await queryTasks(api, ids, { property: 'Project', relation: { is_empty: true } })), ['Out']);
  assert.deepEqual(titles(await queryTasks(api, ids, { property: 'Project', relation: { is_not_empty: true } })), ['In']);
  assert.deepEqual(titles(await queryTasks(api, ids, { property: 'Project', relation: { contains: proj.id } })), ['In']);
  const either = { or: [{ property: 'Project', relation: { is_not_empty: true } }, { property: 'Tags', multi_select: { contains: 'Idea' } }] };
  assert.deepEqual(titles(await queryTasks(api, ids, either)), ['In', 'Out']);
  const both = { and: [{ property: 'Project', relation: { is_empty: true } }, { or: [{ property: 'Tags', multi_select: { contains: 'Idea' } }, { property: 'Tags', multi_select: { contains: 'DO' } }] }] };
  assert.deepEqual(titles(await queryTasks(api, ids, both)), ['Out']);
});

test('U twin relations stay in sync both ways on create and PATCH', async () => {
  const { api, ids } = await seeded();
  const proj = (await api('POST', '/v1/pages', { parent: { data_source_id: ids.projects }, properties: { 'Project name': title('Garden') } })).json;
  const t = await task(api, ids, 'Dig', { Project: { relation: [{ id: proj.id }] } });
  const read = async () => (await api('GET', '/v1/pages/' + proj.id)).json.properties.Tasks.relation.map((r) => r.id);
  assert.deepEqual(await read(), [t.id]);
  // the other direction: write Tasks on the project, read Project on the task
  const t2 = await task(api, ids, 'Plant');
  await api('PATCH', '/v1/pages/' + proj.id, { properties: { Tasks: { relation: [{ id: t.id }, { id: t2.id }] } } });
  assert.deepEqual((await api('GET', '/v1/pages/' + t2.id)).json.properties.Project.relation, [{ id: proj.id }]);
  await api('PATCH', '/v1/pages/' + t.id, { properties: { Project: { relation: [] } } });
  assert.deepEqual(await read(), [t2.id]);
  // self relation: Blocked by / Blocking
  await api('PATCH', '/v1/pages/' + t2.id, { properties: { 'Blocked by': { relation: [{ id: t.id }] } } });
  assert.deepEqual((await api('GET', '/v1/pages/' + t.id)).json.properties.Blocking.relation, [{ id: t2.id }]);
});

test('U PATCH data_sources: add, rename keeps values and the twin follows, set options, null removes', async () => {
  const { api, ids } = await seeded();
  const t = await task(api, ids, 'Dig', { Priority: { select: { name: 'High' } } });
  const add = await api('PATCH', '/v1/data_sources/' + ids.tasks, { properties: { Effort: { number: { format: 'number' } } } });
  assert.equal(add.json.properties.Effort.type, 'number');
  const ren = await api('PATCH', '/v1/data_sources/' + ids.tasks, { properties: { Priority: { name: 'Importance' } } });
  assert.equal(ren.json.properties.Importance.type, 'select');
  assert.equal(ren.json.properties.Priority, undefined);
  assert.equal((await api('GET', '/v1/pages/' + t.id)).json.properties.Importance.select.name, 'High');
  // renaming a relation: the property on the other side reports the new synced name
  await api('PATCH', '/v1/data_sources/' + ids.tasks, { properties: { Project: { name: 'Parent' } } });
  const proj = (await api('GET', '/v1/data_sources/' + ids.projects)).json.properties;
  assert.equal(proj.Tasks.relation.dual_property.synced_property_name, 'Parent');
  const opts = await api('PATCH', '/v1/data_sources/' + ids.tasks, { properties: { Importance: { select: { options: [{ name: 'High', color: 'red' }, { name: 'Low' }] } } } });
  assert.deepEqual(opts.json.properties.Importance.select.options.map((o) => [o.name, o.color]), [['High', 'red'], ['Low', 'default']]);
  const gone = await api('PATCH', '/v1/data_sources/' + ids.tasks, { properties: { Effort: null } });
  assert.equal(gone.json.properties.Effort, undefined);
  assert.equal((await api('PATCH', '/v1/data_sources/' + ids.tasks, { properties: { Nope: null } })).status, 400);
});

test('U POST /v1/databases without a title succeeds (Notion makes title optional)', async () => {
  const fake = createFakeNotion();
  const api = client(fake);
  const page = (await api('POST', '/v1/pages', { parent: { workspace: true }, properties: { title: title('Root') } })).json.id;
  const r = await api('POST', '/v1/databases', { parent: { type: 'page_id', page_id: page }, initial_data_source: { properties: { Name: { title: {} } } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.title, []);
});

test('U POST /v1/databases makes dual and self relations with Related to names, and a bad parent is 404', async () => {
  const fake = createFakeNotion();
  const api = client(fake);
  const page = (await api('POST', '/v1/pages', { parent: { workspace: true }, properties: { title: title('Root') } })).json.id;
  const a = (await api('POST', '/v1/databases', { parent: { type: 'page_id', page_id: page }, title: title('Alpha'), initial_data_source: { properties: { Name: { title: {} } } } })).json;
  assert.equal(a.object, 'database');
  const dsA = a.data_sources[0].id;
  const b = (await api('POST', '/v1/databases', {
    parent: { type: 'page_id', page_id: page }, title: title('Beta'),
    initial_data_source: { properties: { Name: { title: {} }, Link: { relation: { data_source_id: dsA, type: 'dual_property', dual_property: {} } } } },
  })).json;
  const dsB = b.data_sources[0].id;
  assert.equal((await api('PATCH', '/v1/data_sources/' + dsB, { properties: { Peer: { relation: { data_source_id: dsB, type: 'dual_property', dual_property: {} } } } })).status, 200);
  const sa = (await api('GET', '/v1/data_sources/' + dsA)).json.properties;
  assert.equal(sa['Related to Beta (Link)'].type, 'relation');
  const sb = (await api('GET', '/v1/data_sources/' + dsB)).json.properties;
  assert.equal(sb['Related to Beta (Peer)'].relation.data_source_id, dsB);
  assert.equal(sb.Link.relation.dual_property.synced_property_name, 'Related to Beta (Link)');
  const bad = await api('POST', '/v1/databases', { parent: { type: 'page_id', page_id: '00000000-0000-4000-8000-0000000fffff' }, title: 'X', initial_data_source: { properties: { Name: { title: {} } } } });
  assert.equal(bad.status, 404);
});

test('U plain pages, block children, GET database and search', async () => {
  const { api, ids } = await seeded();
  const sub = (await api('POST', '/v1/pages', { parent: { page_id: ids.page }, properties: { title: title('Notes') } })).json;
  assert.equal(sub.parent.page_id, ids.page);
  const kids = (await api('GET', `/v1/blocks/${ids.page}/children`)).json;
  assert.deepEqual(kids.results.map((k) => [k.type, k.child_database.title]), [['child_database', 'Projects'], ['child_database', 'Goals'], ['child_database', 'Tasks'], ['child_database', 'Habit log']]);
  const db = (await api('GET', '/v1/databases/' + kids.results[2].id)).json;
  assert.equal(db.object, 'database');
  assert.equal(db.data_sources[0].id, ids.tasks);
  assert.equal(db.parent.page_id, ids.page);
  assert.equal((await api('GET', '/v1/databases/00000000-0000-4000-8000-0000000fffff')).status, 404);
  assert.equal((await api('GET', '/v1/blocks/00000000-0000-4000-8000-0000000fffff/children')).status, 404);
  const pages = (await api('POST', '/v1/search', { query: 'how', filter: { property: 'object', value: 'page' } })).json;
  assert.deepEqual(pages.results.map((r) => r.id), [ids.page]);
  const sources = (await api('POST', '/v1/search', { query: 'task', filter: { property: 'object', value: 'data_source' } })).json;
  assert.deepEqual(sources.results.map((r) => r.id), [ids.tasks]);
  assert.equal((await api('POST', '/v1/search', {})).json.results.length, 6);
});

test('U an internal token cannot create at the workspace level; a personal one can', async () => {
  const internal = createFakeNotion({ tokenKind: 'internal' });
  const r = await client(internal)('POST', '/v1/pages', { parent: { workspace: true }, properties: { title: title('Howgozit') } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'validation_error');
  await assert.rejects(() => seedHowgozit(internal), /400/);
  const personal = createFakeNotion();
  assert.equal((await client(personal)('POST', '/v1/pages', { parent: { workspace: true }, properties: { title: title('Howgozit') } })).status, 200);
  assert.throws(() => createFakeNotion({ tokenKind: 'robot' }), /tokenKind/);
});

test('U seedHowgozit takes custom habits and modes', async () => {
  const { api, ids } = await seeded({ habits: ['read'], modes: [['DO', 'red']] });
  const t = (await api('GET', '/v1/data_sources/' + ids.tasks)).json.properties;
  assert.deepEqual(t.Tags.multi_select.options.map((o) => o.name), ['DO']);
  const h = (await api('GET', '/v1/data_sources/' + ids.habitLog)).json.properties;
  assert.deepEqual(h.Habit.select.options.map((o) => o.name), ['read']);
});

// ---- CP4 fake: the fake refuses what Notion 2026-03-11 refuses (notion-api.md §4, §5, §6) ----
const NO_PARENT_DB = (page, over) => ({ parent: { type: 'page_id', page_id: page }, initial_data_source: { properties: { Name: { title: {} } } }, ...over });
const patchTags = (api, ids, value) => api('PATCH', '/v1/data_sources/' + ids.tasks, { properties: { Tags: { multi_select: { options: value } } } });
const row = async (api, ds, name, props = {}, key = 'Name') => {
  const r = await api('POST', '/v1/pages', { parent: { data_source_id: ds }, properties: { [key]: title(name), ...props } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};

test('U fake: F2 a database title must be a rich-text array; a page title likewise', async () => {
  const { api, ids } = await seeded();
  const s = await api('POST', '/v1/databases', NO_PARENT_DB(ids.page, { title: 'Plain' }));
  assert.equal(s.status, 400);
  assert.equal(s.json.code, 'validation_error');
  const a = await api('POST', '/v1/databases', NO_PARENT_DB(ids.page, { title: [{ type: 'text', text: { content: 'Rich' } }] }));
  assert.equal(a.status, 200);
  const pg = await api('POST', '/v1/pages', { parent: { data_source_id: ids.tasks }, properties: { 'Task name': 'bare string' } });
  assert.equal(pg.status, 400);
  const plain = await api('POST', '/v1/pages', { parent: { page_id: ids.page }, properties: { title: 'bare' } });
  assert.equal(plain.status, 400);
});

test('U fake: F3 multi_select writes need an array of {name} or {id}, at most 100', async () => {
  const { api, ids } = await seeded();
  const t = await task(api, ids, 'T');
  const write = (v) => api('PATCH', '/v1/pages/' + t.id, { properties: { Tags: { multi_select: v } } });
  assert.equal((await write(['DO'])).status, 400);
  assert.equal((await write(null)).status, 400);
  assert.equal((await write(Array.from({ length: 101 }, (_, i) => ({ name: 'n' + i })))).status, 400);
  assert.equal((await write([{ id: 'nope' }])).status, 400);
  assert.equal((await write([{}])).status, 400);
  const ok = await write([{ name: 'DO' }, { name: 'THINK' }]);
  assert.equal(ok.status, 200);
  const id = ok.json.properties.Tags.multi_select[0].id;
  assert.deepEqual(names(((await write([{ id }])).json), 'Tags'), ['DO']);
  assert.equal((await write([])).status, 200);
});

test('U fake: F4 relation writes are validated before either side changes', async () => {
  const { api, ids } = await seeded();
  const proj = await row(api, ids.projects, 'P', {}, 'Project name');
  const goal = await row(api, ids.goals, 'G', {}, 'Goal name');
  const t = await task(api, ids, 'T');
  const write = (v) => api('PATCH', '/v1/pages/' + t.id, { properties: { Project: { relation: v } } });
  assert.equal((await write('abc')).status, 400);
  assert.equal((await write(['abc'])).status, 400);
  assert.equal((await write([{ id: '00000000-0000-4000-8000-0000000fffff' }])).status, 400);
  assert.equal((await write([{ id: goal.id }])).status, 400); // a page of the wrong data source
  assert.equal((await write(Array.from({ length: 101 }, () => ({ id: proj.id })))).status, 400);
  assert.equal((await write([{ id: proj.id }, { id: goal.id }])).status, 400);
  assert.deepEqual((await api('GET', '/v1/pages/' + proj.id)).json.properties.Tasks.relation, []);
  assert.deepEqual((await api('GET', '/v1/pages/' + t.id)).json.properties.Project.relation, []);
  assert.equal((await write([{ id: proj.id }])).status, 200);
  assert.deepEqual((await api('GET', '/v1/pages/' + proj.id)).json.properties.Tasks.relation, [{ id: t.id }]);
  const made = await api('POST', '/v1/pages', { parent: { data_source_id: ids.tasks }, properties: { 'Task name': title('U'), Project: { relation: [{ id: goal.id }] } } });
  assert.equal(made.status, 400);
});

test('U fake: F5 relation data_source_id "self" is refused over HTTP', async () => {
  const fake = createFakeNotion();
  const api = client(fake);
  const page = (await api('POST', '/v1/pages', { parent: { workspace: true }, properties: { title: title('Root') } })).json.id;
  const r = await api('POST', '/v1/databases', NO_PARENT_DB(page, {
    title: title('Beta'),
    initial_data_source: { properties: { Name: { title: {} }, Peer: { relation: { data_source_id: 'self', type: 'dual_property', dual_property: {} } } } },
  }));
  assert.equal(r.status, 400);
  assert.equal(Object.keys(fake.state.databases).length, 0);
  const ok = (await api('POST', '/v1/databases', NO_PARENT_DB(page, { title: title('Beta') }))).json;
  const ds = ok.data_sources[0].id;
  const patched = await api('PATCH', '/v1/data_sources/' + ds, { properties: { Peer: { relation: { data_source_id: ds, type: 'single_property', single_property: {} } } } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.properties.Peer.relation.data_source_id, ds);
});

test('U fake: F6 option updates keep identity by id or case-insensitive name, and refuse duplicates and commas', async () => {
  const { api, ids } = await seeded();
  const before = (await api('GET', '/v1/data_sources/' + ids.tasks)).json.properties.Tags.multi_select.options;
  const doId = before.find((o) => o.name === 'DO').id;
  const keep = await patchTags(api, ids, [{ id: doId }, { name: 'think' }]);
  assert.equal(keep.status, 200);
  const opts = keep.json.properties.Tags.multi_select.options;
  assert.deepEqual(opts[0], before.find((o) => o.name === 'DO'));
  assert.equal(opts[1].id, before.find((o) => o.name === 'THINK').id);
  assert.equal(opts[1].color, 'purple');
  assert.equal((await patchTags(api, ids, [{ name: 'A' }, { name: 'a' }])).status, 400);
  assert.equal((await patchTags(api, ids, [{ id: doId }, { name: 'do' }])).status, 400);
  assert.equal((await patchTags(api, ids, [{ name: 'a,b' }])).status, 400);
  const fresh = await api('PATCH', '/v1/data_sources/' + ids.tasks, { properties: { Size: { select: { options: [{ name: 'X' }, { name: 'x' }] } } } });
  assert.equal(fresh.status, 400);
  assert.deepEqual(names((await task(api, ids, 'T')), 'Tags'), []);
});

test('U fake: F7 compound filters nest two levels at most', async () => {
  const { api, ids } = await seeded();
  const leaf = { property: 'Task name', title: { contains: 'x' } };
  const q = (filter) => api('POST', `/v1/data_sources/${ids.tasks}/query`, { filter });
  assert.equal((await q({ and: [leaf, { or: [leaf, leaf] }] })).status, 200);
  const r = await q({ and: [{ or: [{ and: [leaf] }] }] });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'validation_error');
  assert.equal((await q({ or: [{ and: [{ or: [leaf] }] }] })).status, 400);
  // depth is validated up front: a source whose only page is trashed still refuses a three-level filter
  const t = await seeded();
  const made = await task(t.api, t.ids, 'Gone');
  assert.equal((await t.api('PATCH', '/v1/pages/' + made.id, { in_trash: true })).status, 200);
  const tq = (filter) => t.api('POST', `/v1/data_sources/${t.ids.tasks}/query`, { filter });
  assert.equal((await tq({ and: [{ or: [{ and: [leaf] }] }] })).status, 400);
  assert.equal((await tq({ and: [leaf, { or: [leaf] }] })).status, 200);
});

test('U fake: F8 a rollup needs a real relation, a real target property and a function', async () => {
  const { api, ids } = await seeded();
  const put = (def) => api('PATCH', '/v1/data_sources/' + ids.projects, { properties: { Roll: { rollup: def } } });
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ relation_property_name: 'Nope', rollup_property_name: 'Status', function: 'count' })).status, 400);
  assert.equal((await put({ relation_property_name: 'Tasks', rollup_property_name: 'Nope', function: 'count' })).status, 400);
  assert.equal((await put({ relation_property_name: 'Tasks', rollup_property_name: 'Status' })).status, 400);
  assert.equal((await put({ relation_property_name: 'Owner', rollup_property_name: 'Status', function: 'count' })).status, 400); // not a relation
  assert.equal((await put({ relation_property_name: 'Tasks', rollup_property_name: 'Project name', function: 'count' })).status, 400); // on this source, not the related one
  assert.equal((await put({ relation_property_name: 'Tasks', rollup_property_name: 'Status', function: 'garbage' })).status, 400);
  const ok = await put({ relation_property_name: 'Tasks', rollup_property_name: 'Status', function: 'count' });
  assert.equal(ok.status, 200);
  const r = ok.json.properties.Roll.rollup;
  assert.equal(r.relation_property_name, 'Tasks');
  assert.equal(r.rollup_property_name, 'Status');
  assert.equal(r.function, 'count');
  assert.ok(r.relation_property_id && r.rollup_property_id);
  const byId = await api('PATCH', '/v1/data_sources/' + ids.projects, { properties: { Roll2: { rollup: { relation_property_id: r.relation_property_id, rollup_property_id: r.rollup_property_id, function: 'count' } } } });
  assert.equal(byId.status, 200);
  assert.equal(byId.json.properties.Roll2.rollup.rollup_property_name, 'Status');
});
