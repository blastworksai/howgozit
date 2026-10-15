// R154: scripts/notion-setup.mjs builds the Howgozit page and four tables once (reference/notion-native/interface.md section 1, 2).
// The world is the fake Notion; the script is the real one. No network, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/notion-setup.mjs';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { seedHowgozit } from '../fixtures/notion-howgozit.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createStore, readNotion } from '../board/notion/read.mjs';
import { settings as baseSettings } from '../fixtures/build.mjs';

const TOKEN = 'ntn_fake_token_0123456789abcdefghij';
const NOW = '2026-10-12T06:10:00Z';
const NEEDS_PARENT = 'An internal connection cannot create a page at the top of a workspace: share a page with the connection in Notion and run this again with --parent <page id>.';
const STATE = '.howgozit-notion.json';
const SHARED = '00000000-0000-4000-8000-0000000000bb';

async function session(opts = {}) {
  const fake = createFakeNotion({ token: TOKEN, tokenKind: opts.tokenKind });
  const dir = await mkdtemp(join(tmpdir(), 'notion-setup-'));
  const run = async (argv) => {
    const lines = [];
    const errs = [];
    const before = fake.calls.length;
    const code = await main(argv, { env: { BOARD_NOTION_TOKEN: TOKEN }, fetch: fake.fetch, cwd: dir, out: (l) => lines.push(l), err: (l) => errs.push(l), sleep: async () => {} });
    const calls = fake.calls.slice(before);
    const writes = calls.filter((c) => (c.method === 'POST' && c.path !== '/v1/search') || c.method === 'PATCH');
    return { code, lines, errs, calls, writes, all: [...lines, ...errs].join('\n') };
  };
  return { fake, dir, run, done: () => rm(dir, { recursive: true, force: true }) };
}
// the printed block, as the object it spells
const blockOf = (lines) => JSON.parse('{' + lines.slice(lines.indexOf('"notion": {')).join('\n') + '}').notion;
const schemaOf = (fake, ds) => fake.state.dataSources[ds];
const shape = (fake, ds) => Object.fromEntries(Object.values(fake.state.dataSources[ds].properties).map((p) => [p.name, p.type]));

test('R154 a first run on an empty workspace creates the page and four tables, and the Notion reader reads a board from the printed block', async () => {
  const s = await session();
  try {
    const r = await s.run(['--habits', 'mood,sleep']);
    assert.equal(r.code, 0, r.all);
    const block = blockOf(r.lines);
    assert.deepEqual(Object.keys(block), ['projects', 'goals', 'tasks', 'habitLog']);
    assert.equal(s.fake.state.pages.filter((p) => p.title === 'Howgozit').length, 1);
    const http = createNotionHttp({ token: TOKEN, fetch: s.fake.fetch, sleep: async () => {} });
    const settings = baseSettings({ modes: ['DO', 'THINK'], notion: block, ideas: { owner: 'notion', number: 998 } });
    s.fake.addPage(block.projects, { 'Project name': 'Garden', ID: 1 });
    const raw = await readNotion(http, createStore(), { settings, full: true, now: NOW });
    assert.ok(raw, 'the reader read the printed block');
    const habit = Object.values(schemaOf(s.fake, block.habitLog).properties).find((p) => p.name === 'Habit');
    assert.deepEqual(habit.options.map((o) => o.name), ['mood', 'sleep']);
  } finally { await s.done(); }
});

test('R154 the tables match what the seeding helper builds: names, types, the Blocked by / Blocking self relation, the Completion rollups', async () => {
  const s = await session();
  const ref = createFakeNotion({ token: TOKEN });
  try {
    const refIds = await seedHowgozit(ref, { habits: ['mood'] });
    const r = await s.run(['--habits', 'mood']);
    assert.equal(r.code, 0, r.all);
    const b = blockOf(r.lines);
    for (const k of ['projects', 'goals', 'tasks', 'habitLog']) assert.deepEqual(shape(s.fake, b[k]), shape(ref, refIds[k]), k);
    const tasks = schemaOf(s.fake, b.tasks).properties;
    assert.equal(tasks['Blocked by'].twin.id, tasks.Blocking.id);
    assert.equal(tasks['Blocked by'].data_source_id, b.tasks);
    assert.equal(tasks.Blocking.data_source_id, b.tasks);
    for (const k of ['projects', 'goals']) {
      const c = schemaOf(s.fake, b[k]).properties.Completion;
      assert.equal(c.type, 'rollup');
      assert.equal(c.relation_property_name, 'Tasks');
      assert.equal(c.rollup_property_name, 'Status');
      assert.equal(c.function, 'percent_per_group');
    }
    assert.deepEqual(tasks.Tags.options.map((o) => o.name), ['DO', 'THINK', 'REVIEW', 'LAUNCH', 'Idea']);
  } finally { await s.done(); }
});

test('R154 a second run makes no write request and prints the same block', async () => {
  const s = await session();
  try {
    const first = await s.run([]);
    const second = await s.run([]);
    assert.equal(second.code, 0, second.all);
    assert.equal(second.writes.length, 0);
    assert.deepEqual(second.lines.slice(1), first.lines.slice(1));
    assert.equal(s.fake.state.pages.filter((p) => p.title === 'Howgozit').length, 1);
  } finally { await s.done(); }
});

test('R154 a second run with the state file deleted adopts the tables, writes nothing and prints the same block', async () => {
  const s = await session();
  try {
    const first = await s.run([]);
    await unlink(join(s.dir, STATE));
    const second = await s.run([]);
    assert.equal(second.code, 0, second.all);
    assert.equal(second.writes.length, 0);
    assert.deepEqual(second.lines.slice(1), first.lines.slice(1));
    const state = JSON.parse(await readFile(join(s.dir, STATE), 'utf8'));
    assert.equal(state.databases.tasks.data_source, blockOf(first.lines).tasks);
  } finally { await s.done(); }
});

test('R154 a Howgozit page that does not hold the four tables is refused: nothing is created or changed', async () => {
  const s = await session();
  try {
    s.fake.state.pages.push({ id: '00000000-0000-4000-8000-0000000000aa', title: 'Howgozit', parent: { type: 'workspace', workspace: true }, created: 'x', edited: 'x' });
    const r = await s.run([]);
    assert.equal(r.code, 1);
    assert.equal(r.writes.length, 0);
    assert.match(r.errs[0], /does not hold exactly the four tables/);
    assert.equal(Object.keys(s.fake.state.databases).length, 0);
  } finally { await s.done(); }
});

test('R154 a complete set it did not create is adopted without a write', async () => {
  const s = await session();
  try {
    const ids = await seedHowgozit(s.fake);
    const r = await s.run([]);
    assert.equal(r.code, 0, r.all);
    assert.equal(r.writes.length, 0);
    assert.deepEqual(blockOf(r.lines), { projects: ids.projects, goals: ids.goals, tasks: ids.tasks, habitLog: ids.habitLog });
  } finally { await s.done(); }
});

test('R154 an internal connection without --parent is refused with one sentence and nothing is written; with --parent it works', async () => {
  const s = await session({ tokenKind: 'internal' });
  try {
    const r = await s.run([]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.errs, [NEEDS_PARENT]);
    assert.equal(r.lines.length, 0);
    assert.equal(s.fake.state.pages.length, 0);
    assert.equal(Object.keys(s.fake.state.databases).length, 0);
    s.fake.state.pages.push({ id: SHARED, title: 'Shared', parent: { type: 'workspace', workspace: true }, created: 'x', edited: 'x' });
    const ok = await s.run(['--parent', SHARED]);
    assert.equal(ok.code, 0, ok.all);
    assert.equal(Object.keys(blockOf(ok.lines)).length, 4);
    const again = await s.run(['--parent', SHARED]);
    assert.equal(again.writes.length, 0);
    assert.deepEqual(again.lines.slice(1), ok.lines.slice(1));
  } finally { await s.done(); }
});

test('R154 --dry-run writes nothing, to Notion or to disk; --json prints a machine-readable result; --settings supplies the habits', async () => {
  const s = await session();
  try {
    const dry = await s.run(['--dry-run']);
    assert.equal(dry.code, 0, dry.all);
    assert.equal(dry.writes.length, 0);
    assert.equal(s.fake.state.pages.length, 0);
    await assert.rejects(readFile(join(s.dir, STATE)), { code: 'ENOENT' });
    assert.match(dry.lines.join('\n'), /create the page "Howgozit"/);
    await writeFile(join(s.dir, 'board.config.json'), JSON.stringify({ habits: [{ id: 'run' }, { id: 'read' }] }));
    const j = await s.run(['--json', '--settings', 'board.config.json', '--state', 'other.json']);
    assert.equal(j.code, 0, j.all);
    const parsed = JSON.parse(j.lines.join('\n'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.created, true);
    const habit = Object.values(schemaOf(s.fake, parsed.notion.habitLog).properties).find((p) => p.name === 'Habit');
    assert.deepEqual(habit.options.map((o) => o.name), ['run', 'read']);
    assert.ok(JSON.parse(await readFile(join(s.dir, 'other.json'), 'utf8')).page);
  } finally { await s.done(); }
});

test('R154 a failure part way carries on from the state file and creates no second set', async () => {
  const s = await session();
  try {
    s.fake.fail((c) => c.method === 'POST' && c.path === '/v1/databases' && s.fake.calls.filter((x) => x.path === '/v1/databases').length === 3, 500);
    const broke = await s.run([]);
    assert.equal(broke.code, 1);
    const again = await s.run([]);
    assert.equal(again.code, 0, again.all);
    assert.equal(Object.keys(s.fake.state.databases).length, 4);
    assert.equal(s.fake.state.pages.filter((p) => p.title === 'Howgozit').length, 1);
  } finally { await s.done(); }
});

test('R154 the token never appears in any output line', async () => {
  const s = await session({ tokenKind: 'internal' });
  try {
    const bad = await s.run([]);
    const worse = await s.run(['--parent', 'not-a-page']);
    const noArgs = await s.run(['--nope']);
    for (const r of [bad, worse, noArgs]) {
      assert.ok(!r.all.includes(TOKEN));
      assert.ok(!/ntn_/.test(r.all));
    }
    const lines = [];
    const code = await main([], { env: { BOARD_NOTION_TOKEN: TOKEN }, fetch: async () => { throw new Error('boom ' + TOKEN); }, cwd: s.dir, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.ok(!lines.join('\n').includes(TOKEN));
  } finally { await s.done(); }
});
