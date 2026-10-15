// R156: scripts/notion-setup.mjs plan|apply <proposal.json> builds a starter board from a proposal on the native Notion tables.
// The world is the fake Notion; the script and the board are the real ones. No network. The clock advances only when the pacer sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/notion-setup.mjs';
import { ROWS_FILE, validateNotionProposal, applyNotionProposal } from '../scripts/lib/notion-proposal.mjs';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';

const TOKEN = 'ntn_fake_token_0123456789abcdefghij';
const NOW = '2026-10-12T06:10:00Z';

// references/setup-proposal.md example, without owner and repo, with one scored habit.
const PROPOSAL = {
  name: 'Sam',
  timezone: 'Europe/Brussels',
  projects: [
    { key: 'house', title: 'House', milestones: [{ title: 'Hallway', due: '2026-11-20' }, { title: 'Garden shed', due: '2027-03-31' }],
      tasks: [{ title: 'Paint the hallway', milestone: 'Hallway', due: '2026-11-10' }, { title: 'Pick a colour' }, { title: 'Order shed panels', milestone: 'Garden shed' }] },
    { key: 'choir', title: 'Choir', milestones: [{ title: 'Spring concert', due: '2027-04-18' }],
      tasks: [{ title: 'Learn the alto line', milestone: 'Spring concert' }, { title: 'Book the hall', milestone: 'Spring concert', due: '2027-01-15' }] },
    { key: 'japan', title: 'Japan trip', milestones: [{ title: 'Bookings', due: '2027-02-28' }],
      tasks: [{ title: 'Compare flights', milestone: 'Bookings' }, { title: 'Check passport dates' }] },
  ],
  standalone: [{ title: 'Renew passport' }, { title: 'Call the dentist' }],
  habits: [{ id: 'move', title: 'Move' }, { id: 'sing', title: 'Sing for ten minutes', project: 'choir', score: { min: 1, max: 10 } }],
  focus: ['house', 'choir'],
};
// The same proposal without the scored habit, for tests that are about something else.
const PLAIN = { ...PROPOSAL, habits: [{ id: 'move', title: 'Move' }] };
const PROJECT_TASKS = { house: ['Paint the hallway', 'Pick a colour', 'Order shed panels'], choir: ['Learn the alto line', 'Book the hall'], japan: ['Compare flights', 'Check passport dates'] };
const TITLE_BY_KEY = { house: 'House', choir: 'Choir', japan: 'Japan trip' };
const STANDALONE = ['Renew passport', 'Call the dentist'];
const GOALS = { Hallway: 'House', 'Garden shed': 'House', 'Spring concert': 'Choir', Bookings: 'Japan trip' };

function clockOf() {
  // A fixed `now` would hang the pacer: time moves only when the pacer sleeps.
  const clock = { t: Date.parse(NOW), now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  return clock;
}

async function session(proposal = PROPOSAL) {
  const fake = createFakeNotion({ token: TOKEN });
  const dir = await mkdtemp(join(tmpdir(), 'notion-proposal-'));
  await writeFile(join(dir, 'proposal.json'), JSON.stringify(proposal));
  const clock = clockOf();
  const run = async (argv, extra = {}) => {
    const lines = [];
    const errs = [];
    const before = fake.calls.length;
    const code = await main(argv, { env: { BOARD_NOTION_TOKEN: TOKEN }, fetch: extra.fetch ?? fake.fetch, cwd: dir, out: (l) => lines.push(l), err: (l) => errs.push(l), sleep: async () => {}, clock });
    const calls = fake.calls.slice(before);
    const isRead = (c) => c.method === 'GET' || c.path === '/v1/search' || c.path.endsWith('/query');
    return { code, lines, errs, calls, writes: calls.filter((c) => !isRead(c)), all: [...lines, ...errs].join('\n') };
  };
  const apply = (extra = {}, args = []) => run(['apply', 'proposal.json', '--config-dir', 'cfg', ...args], extra);
  return { fake, dir, run, apply, cfgDir: join(dir, 'cfg'), done: () => rm(dir, { recursive: true, force: true }) };
}

// The fake's tables, found by the title property of each data source.
function tables(fake) {
  const out = {};
  for (const [id, ds] of Object.entries(fake.state.dataSources)) {
    const t = Object.values(ds.properties).find((p) => p.type === 'title');
    out[t.name] = { id, ds };
  }
  return { projects: out['Project name'], goals: out['Goal name'], tasks: out['Task name'], habitLog: out.Name };
}
const rowsOf = (table, titleProp) => (table ? table.ds.pages.filter((p) => !p.trashed).map((p) => ({ id: p.id, title: p.values[titleProp], v: p.values })) : []);
const settingsOf = async (s) => JSON.parse(await readFile(join(s.cfgDir, 'board.config.json'), 'utf8'));
const rowCreate = (c) => c.method === 'POST' && c.path === '/v1/pages' && c.body && c.body.parent && c.body.parent.data_source_id;
const rowCount = (fake) => {
  const t = tables(fake);
  return rowsOf(t.projects, 'Project name').length + rowsOf(t.goals, 'Goal name').length + rowsOf(t.tasks, 'Task name').length;
};

test('R156 apply on an empty workspace makes the four tables, the rows with their relations, and the starter settings', async () => {
  const s = await session();
  try {
    const r = await s.apply();
    assert.equal(r.code, 0, r.all);
    const t = tables(s.fake);
    assert.ok(t.projects && t.goals && t.tasks && t.habitLog, 'four tables');
    const projects = rowsOf(t.projects, 'Project name');
    const goals = rowsOf(t.goals, 'Goal name');
    const tasks = rowsOf(t.tasks, 'Task name');
    assert.deepEqual(projects.map((p) => p.title).sort(), ['Choir', 'House', 'Japan trip']);
    const idOf = Object.fromEntries(projects.map((p) => [p.title, p.id]));
    assert.equal(goals.length, 4);
    for (const g of goals) assert.deepEqual(g.v.Project, [idOf[GOALS[g.title]]], g.title);
    assert.equal(goals.find((g) => g.title === 'Hallway').v.Due.start, '2026-11-20');
    assert.equal(tasks.length, 9);
    const goalId = Object.fromEntries(goals.map((g) => [g.title, g.id]));
    for (const pr of PROPOSAL.projects) {
      for (const pt of pr.tasks) {
        const row = tasks.find((x) => x.title === pt.title);
        assert.ok(row, pt.title);
        assert.deepEqual(row.v.Project, [idOf[TITLE_BY_KEY[pr.key]]], `${pt.title} project`);
        assert.deepEqual(row.v.Goal || [], pt.milestone ? [goalId[pt.milestone]] : [], `${pt.title} goal`);
        if (pt.due) assert.equal(row.v.Due.start, pt.due);
      }
    }
    for (const title of STANDALONE) {
      const row = tasks.find((x) => x.title === title);
      assert.ok(row, title);
      assert.deepEqual(row.v.Project || [], [], `${title} has no project`);
      assert.deepEqual(row.v.Goal || [], []);
      assert.equal((row.v.Tags || []).length, 0, `${title} has no Idea tag`);
    }

    const cfg = await settingsOf(s);
    assert.deepEqual(cfg.notion, { projects: t.projects.id, goals: t.goals.id, tasks: t.tasks.id, habitLog: t.habitLog.id });
    assert.ok(!('projects' in cfg), 'no projects list');
    const numberOf = Object.fromEntries(projects.map((p) => [p.title, p.v.ID]));
    assert.deepEqual(cfg.focus, [`notion-${numberOf.House}`, `notion-${numberOf.Choir}`]);
    assert.deepEqual(cfg.habits, [{ id: 'move', title: 'Move' }, { id: 'sing', title: 'Sing for ten minutes', project: `notion-${numberOf.Choir}`, score: { min: 1, max: 10 } }]);
    assert.deepEqual(cfg.ideas, { owner: 'notion', number: 998 });
    assert.deepEqual(cfg.habitsProject, { owner: 'notion', number: 999 });
    assert.equal(cfg.name, 'Sam');
    assert.equal(cfg.timezone, 'Europe/Brussels');
    assert.match(r.all, /BOARD_BACKEND=notion/);
    assert.match(r.all, /BOARD_FORM_KEY=<run: /, 'the form key is a command to run, never a value');
  } finally { await s.done(); }
});

test('R156 the applied world builds a board that shows every proposed project and task, with house and choir in focus and no settings notice', async () => {
  const s = await session();
  try {
    const r = await s.apply();
    assert.equal(r.code, 0, r.all);
    const http = createNotionHttp({ token: TOKEN, fetch: s.fake.fetch, sleep: async () => {} });
    const adapter = createNotionAdapter({ http, configDir: s.cfgDir, readFile: (p) => readFile(p, 'utf8') });
    const cache = { readLastGood: async () => null, writeLastGood: async () => {}, etags: new Map() };
    const loader = createLoader({ env: { backend: 'notion', repo: 'notion', readOnly: false, configDir: s.cfgDir }, cache, clock: { now: () => Date.parse(NOW) }, adapter });
    const res = await loader.load({ full: true });
    assert.equal(res.ok, true, JSON.stringify(res.notice));
    assert.deepEqual(res.bundle.run.warnings, []);
    const b = buildBoard({ ...res.bundle, now: NOW });
    assert.deepEqual(b.projects.map((p) => p.title).sort(), ['Choir', 'House', 'Japan trip']);
    assert.ok(b.projects.every((p) => /^notion-\d+$/.test(p.key)));
    const issueTitle = Object.fromEntries(res.bundle.raw.issues.map((i) => [i.number, i.title]));
    for (const [k, titles] of Object.entries(PROJECT_TASKS)) {
      const rawProject = res.bundle.raw.projects.find((p) => p.title === TITLE_BY_KEY[k]);
      assert.ok(rawProject, `${TITLE_BY_KEY[k]} is read`);
      assert.deepEqual(rawProject.items.map((it) => issueTitle[it.number]).sort(), [...titles].sort(), `tasks under ${TITLE_BY_KEY[k]}`);
      assert.equal(b.projects.find((p) => p.title === TITLE_BY_KEY[k]).total, titles.length, `${TITLE_BY_KEY[k]} counts its tasks`);
    }
    const sing = b.habits.find((h) => h.id === 'sing');
    assert.deepEqual(sing && sing.score && { min: sing.score.min, max: sing.score.max }, { min: 1, max: 10 }, 'the scored habit shows its 1 to 10 score');
    assert.equal(b.habits.find((h) => h.id === 'move').score, undefined, 'the other habit is a tick');
    assert.deepEqual(b.standalone.items.map((i) => i.title).sort(), [...STANDALONE].sort());
    assert.equal(b.standalone.count, 2);
    assert.deepEqual(b.focus.projects.map((p) => p.title).sort(), ['Choir', 'House']);
    assert.ok(!(b.warnings || []).length, JSON.stringify(b.warnings));
  } finally { await s.done(); }
});

test('R156 a second apply makes no write request and changes neither table nor settings', async () => {
  const s = await session();
  try {
    const first = await s.apply();
    assert.equal(first.code, 0, first.all);
    const settings = await readFile(join(s.cfgDir, 'board.config.json'), 'utf8');
    const snapshot = JSON.stringify(s.fake.state.dataSources);
    const second = await s.apply();
    assert.equal(second.code, 0, second.all);
    assert.equal(second.writes.length, 0, JSON.stringify(second.writes.map((c) => `${c.method} ${c.path}`)));
    assert.equal(JSON.stringify(s.fake.state.dataSources), snapshot);
    assert.equal(await readFile(join(s.cfgDir, 'board.config.json'), 'utf8'), settings);
  } finally { await s.done(); }
});

function noDuplicates(fake) {
  const t = tables(fake);
  for (const [table, prop] of [[t.projects, 'Project name'], [t.goals, 'Goal name'], [t.tasks, 'Task name']]) {
    const titles = rowsOf(table, prop).map((r) => r.title);
    assert.equal(new Set(titles).size, titles.length, `duplicate in ${prop}: ${titles.join(', ')}`);
  }
  assert.equal(rowsOf(t.projects, 'Project name').length, 3);
  assert.equal(rowsOf(t.goals, 'Goal name').length, 4);
  assert.equal(rowsOf(t.tasks, 'Task name').length, 9);
}

test('R156 a crash on the fourth row, then a resume, leaves every row once and the settings written', async () => {
  const s = await session();
  try {
    let n = 0;
    s.fake.fail((c) => rowCreate(c) && (n += 1) === 4, 400);
    const crashed = await s.apply();
    assert.notEqual(crashed.code, 0, 'the run stops');
    assert.equal(rowCount(s.fake), 3, 'three rows were written');
    const record = JSON.parse(await readFile(join(s.dir, ROWS_FILE), 'utf8'));
    assert.equal(Object.values(record.rows).filter((x) => x.state === 'done').length, 3);
    const resumed = await s.apply();
    assert.equal(resumed.code, 0, resumed.all);
    noDuplicates(s.fake);
    assert.ok((await settingsOf(s)).notion.projects);
  } finally { await s.done(); }
});

test('R156 a row Notion made but whose answer was lost is found again on resume, not made twice', async () => {
  const s = await session();
  try {
    let n = 0;
    const lossy = async (url, init) => {
      const res = await s.fake.fetch(url, init);
      let body = null;
      try { body = JSON.parse(String(init && init.body)); } catch { body = null; }
      if (init && String(init.method).toUpperCase() === 'POST' && String(url).endsWith('/v1/pages') && body && body.parent && body.parent.data_source_id && (n += 1) === 4) {
        return new Response(JSON.stringify({ object: 'error', status: 400, code: 'validation_error', message: 'lost' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return res;
    };
    const crashed = await s.apply({ fetch: lossy });
    assert.notEqual(crashed.code, 0);
    assert.equal(rowCount(s.fake), 4, 'Notion made the row the answer for which was lost');
    const resumed = await s.apply();
    assert.equal(resumed.code, 0, resumed.all);
    noDuplicates(s.fake);
  } finally { await s.done(); }
});

test('R156 plan sends no request, writes no file, and prints each step', async () => {
  const s = await session();
  try {
    const before = await readdir(s.dir);
    const r = await s.run(['plan', 'proposal.json', '--config-dir', 'cfg']);
    assert.equal(r.code, 0, r.all);
    assert.equal(r.calls.length, 0, 'not a single request');
    assert.deepEqual((await readdir(s.dir)).sort(), before.sort(), 'no file written');
    for (const title of ['House', 'Choir', 'Japan trip', 'Hallway', 'Spring concert', 'Paint the hallway', 'Renew passport', 'Call the dentist']) assert.ok(r.all.includes(`"${title}"`), title);
    assert.match(r.all, /board\.config\.json/);
    assert.equal(r.lines.filter((l) => l.startsWith('- ')).length, 3 + 4 + 9 + 1, 'one line per project, goal, task and the settings file');
  } finally { await s.done(); }
});

test('R156 a proposal that carries owner is refused with a sentence naming owner, and nothing is written', async () => {
  const s = await session({ owner: 'sam-life', ...PROPOSAL });
  try {
    for (const argv of [['plan', 'proposal.json', '--config-dir', 'cfg'], ['apply', 'proposal.json', '--config-dir', 'cfg']]) {
      const r = await s.run(argv);
      assert.equal(r.code, 1, argv[0]);
      assert.match(r.errs.join('\n'), /owner: a Notion proposal has no owner or repo/);
      assert.equal(r.calls.length, 0);
    }
    assert.deepEqual(await readdir(s.dir), ['proposal.json']);
    assert.equal(Object.keys(s.fake.state.dataSources).length, 0);
  } finally { await s.done(); }
});

test('R156 a board.config.json this setup did not write is refused before any row is written', async () => {
  const s = await session();
  try {
    await mkdir(s.cfgDir);
    const own = '{"version":1,"name":"Mine"}\n';
    await writeFile(join(s.cfgDir, 'board.config.json'), own);
    const r = await s.apply();
    assert.equal(r.code, 1, r.all);
    assert.match(r.errs.join('\n'), /board\.config\.json already exists/);
    assert.match(r.errs.join('\n'), /nothing was written/);
    assert.equal(await readFile(join(s.cfgDir, 'board.config.json'), 'utf8'), own, 'the person\'s file is untouched');
    assert.equal(s.fake.calls.filter(rowCreate).length, 0, 'no row was written');
    assert.equal(rowCount(s.fake), 0);
  } finally { await s.done(); }
});

test('R156 the token appears in no output line, no record file and no settings file', async () => {
  const s = await session();
  try {
    const a = await s.apply();
    const b = await s.apply();
    const p = await s.run(['plan', 'proposal.json', '--config-dir', 'cfg']);
    assert.equal(a.code, 0, a.all);
    assert.equal(b.code, 0, b.all);
    assert.equal(p.code, 0, p.all);
    for (const r of [a, b, p]) assert.ok(!r.all.includes('ntn_fake_token'), 'output');
    const files = [join(s.dir, ROWS_FILE), join(s.dir, '.howgozit-notion.json'), join(s.cfgDir, 'board.config.json')];
    for (const f of files) {
      assert.ok((await stat(f)).isFile(), f);
      assert.ok(!(await readFile(f, 'utf8')).includes('ntn_fake_token'), f);
    }
  } finally { await s.done(); }
});

test('R156 a project keyed "standalone" keeps its tasks\' Project relation, and standalone tasks still have none', async () => {
  const s = await session({ name: 'Sam', timezone: 'Europe/Brussels', projects: [{ key: 'standalone', title: 'House', tasks: [{ title: 'Paint' }] }], standalone: [{ title: 'Call the dentist' }] });
  try {
    const r = await s.apply();
    assert.equal(r.code, 0, r.all);
    const t = tables(s.fake);
    const house = rowsOf(t.projects, 'Project name').find((p) => p.title === 'House');
    const tasks = rowsOf(t.tasks, 'Task name');
    assert.deepEqual(tasks.find((x) => x.title === 'Paint').v.Project, [house.id]);
    assert.deepEqual(tasks.find((x) => x.title === 'Call the dentist').v.Project || [], []);
  } finally { await s.done(); }
});

test('R156 a stop after the settings were written but before the record was saved resumes without a refusal or a second row', async () => {
  const s = await session(PLAIN);
  try {
    const first = await s.apply();
    assert.equal(first.code, 0, first.all);
    // Simulate the stop: the file is on disk, the record has the pending hash only.
    const recPath = join(s.dir, ROWS_FILE);
    const record = JSON.parse(await readFile(recPath, 'utf8'));
    record.settingsPendingSha256 = record.settingsSha256;
    record.settingsSha256 = null;
    await writeFile(recPath, JSON.stringify(record));
    const settings = await readFile(join(s.cfgDir, 'board.config.json'), 'utf8');
    const second = await s.apply();
    assert.equal(second.code, 0, second.all);
    assert.equal(second.writes.length, 0);
    noDuplicates(s.fake);
    assert.equal(await readFile(join(s.cfgDir, 'board.config.json'), 'utf8'), settings);
    const after = JSON.parse(await readFile(recPath, 'utf8'));
    assert.ok(after.settingsSha256 && after.settingsPendingSha256 === undefined, 'the record is final');
  } finally { await s.done(); }
});

test('R156 the pending settings hash is saved before board.config.json is written, and a failing final save resumes cleanly', async () => {
  const s = await session(PLAIN);
  try {
    const first = await s.apply();
    assert.equal(first.code, 0, first.all);
    const base = JSON.parse(await readFile(join(s.dir, ROWS_FILE), 'utf8'));
    const http = { request: async (m, p, b) => (await s.fake.fetch(`https://api.notion.com${p}`, { method: m, headers: { authorization: `Bearer ${TOKEN}`, 'notion-version': '2025-09-03', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json() };
    const dir = join(s.dir, 'cfg2');
    const record = { ...base, settingsSha256: null };
    delete record.settingsPendingSha256;
    const writeCfg = async (path, cfg) => { await mkdir(dir, { recursive: true }); await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`); };
    let wrote = false;
    const snapshots = [];
    const posts = [];
    const counting = { request: async (m, p, b) => { if (m !== 'GET') posts.push(`${m} ${p}`); return http.request(m, p, b); } };
    // save keeps a deep snapshot of each record it is given, so only what was durably saved counts.
    const save = async (rec) => { if (wrote) throw new Error('disk full'); snapshots.push(structuredClone(rec)); };
    const crashed = await applyNotionProposal({ proposal: PLAIN, http: counting, ids: base.notionIds, record, configDir: dir, save,
      writeFile: async (path, cfg) => { await writeCfg(path, cfg); wrote = true; } });
    assert.equal(crashed.ok, false);
    assert.ok(wrote, 'the settings file was written before the final save failed');
    const onDisk = await readFile(join(dir, 'board.config.json'), 'utf8');
    const durable = snapshots[snapshots.length - 1];
    assert.ok(durable, 'a record was saved');
    assert.equal(durable.settingsPendingSha256, createHash('sha256').update(onDisk).digest('hex'), 'the pending hash was durably saved before the write');
    assert.equal(durable.settingsSha256, null);
    posts.length = 0;
    const fromDisk = structuredClone(durable);
    const resumed = await applyNotionProposal({ proposal: PLAIN, http: counting, ids: base.notionIds, record: fromDisk, configDir: dir, save: async () => {}, writeFile: writeCfg });
    assert.equal(resumed.ok, true, resumed.message);
    assert.deepEqual(posts, [], 'no row was created or changed on resume');
    assert.equal(fromDisk.settingsPendingSha256, undefined);
    assert.ok(fromDisk.settingsSha256);
    noDuplicates(s.fake);
  } finally { await s.done(); }
});

test('R156 a settings file that cannot be read is refused before any row is written; only a missing file counts as absent', async () => {
  const s = await session(PLAIN);
  try {
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    const res = await applyNotionProposal({ proposal: PLAIN, http: { request: async () => { throw new Error('no request expected'); } }, ids: { projects: 'a', tasks: 'b', goals: 'c', habitLog: 'd' }, record: { version: 1, notionIds: null, rows: {}, settingsSha256: null }, configDir: s.cfgDir, readFile: async () => { throw eacces; } });
    assert.equal(res.ok, false);
    assert.match(res.message, /could not be read/);
    assert.match(res.message, /nothing was written/);
  } finally { await s.done(); }
});

test('R156 a time zone the runtime does not know is refused by plan and by apply before any request', async () => {
  const s = await session({ ...PLAIN, timezone: 'Europe/Brussles' });
  try {
    for (const argv of [['plan', 'proposal.json', '--config-dir', 'cfg'], ['apply', 'proposal.json', '--config-dir', 'cfg']]) {
      const r = await s.run(argv);
      assert.equal(r.code, 1, argv[0]);
      assert.match(r.errs.join('\n'), /timezone: /);
      assert.equal(r.calls.length, 0, argv[0]);
    }
    assert.equal(Object.keys(s.fake.state.dataSources).length, 0);
  } finally { await s.done(); }
});

test('R156 a habit title with the " · " separator is refused naming habits[0].title; scored is no longer a field', () => {
  const base = { name: 'Sam', timezone: 'Europe/Brussels' };
  const a = validateNotionProposal({ ...base, habits: [{ id: 'move', title: 'Move · daily' }] });
  assert.equal(a.ok, false);
  assert.ok(a.errors.some((e) => e.startsWith('habits[0].title:')), a.errors.join('\n'));
  const b = validateNotionProposal({ ...base, habits: [{ id: 'mood', title: 'Mood', scored: true }] });
  assert.equal(b.ok, false);
  assert.ok(b.errors.some((e) => /"scored" is not a field/.test(e)), b.errors.join('\n'));
  assert.equal(validateNotionProposal({ ...base, habits: [{ id: 'mood', title: 'Mood', score: { min: 1, max: 10 } }] }).ok, true);
  const c = validateNotionProposal({ ...base, habits: [{ id: 'mood', title: 'Mood', score: { min: 5, max: 5 } }] });
  assert.ok(c.errors.some((e) => e.startsWith('habits[0].score:')));
});

test('R156 a second apply prints no "Creating" line that claims a create', async () => {
  const s = await session();
  try {
    const first = await s.apply();
    assert.equal(first.code, 0, first.all);
    assert.match(first.all, /Creating 3 projects\./);
    const second = await s.apply();
    assert.equal(second.code, 0, second.all);
    assert.doesNotMatch(second.all, /Creating/);
  } finally { await s.done(); }
});

test('R156 a proposal with exactly 1 project, 1 goal and 1 task prints "Created 1 project, 1 goal and 1 task."', async () => {
  const one = { name: 'Sam', timezone: 'Europe/Brussels', projects: [{ key: 'house', title: 'House', milestones: [{ title: 'Hallway', due: '2026-11-20' }], tasks: [{ title: 'Paint the hallway', milestone: 'Hallway' }] }], habits: [{ id: 'move', title: 'Move' }], focus: ['house'] };
  const s = await session(one);
  try {
    const r = await s.apply();
    assert.equal(r.code, 0, r.all);
    assert.match(r.all, /Created 1 project, 1 goal and 1 task\./);
    assert.match(r.all, /Creating 1 project\./);
  } finally { await s.done(); }
}); 
