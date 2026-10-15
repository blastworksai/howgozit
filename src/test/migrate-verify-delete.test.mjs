// CP8 J6: the migration's `verify` and `delete` commands, written from reference/mapping-redesign/cp8-interface.md
// (sections 5.1, 5.3, 5.4 and 7) alone. No contract rule covers the migration, so every name starts "U ".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/migrate.mjs';
import { createMigrateWorld } from '../fixtures/migrate-world.mjs';
import { GitHubError } from '../board/github/http.mjs';

const LETTERS = 'AbCdEfGhIjKlMnOpQrStUvWxYzaBcDeFgHiJkLmNoPqRsTuVwXyZ';
const tokenOf = (seed) => 'ghp_' + Array.from({ length: 36 }, (_, i) => LETTERS[(i * seed + seed) % LETTERS.length]).join('');
const TOKEN = tokenOf(7);
const TOKEN2 = tokenOf(11);
const SOURCE = 'Elmwood/howgozit';
const WLPT = 'brightcraft/blastworks-Woodshop';
const BOOK = 'brightcraft/book';
const IN2 = 'inkPress/inkPress';
const ownerOf = (repo) => repo.split('/')[0];
const FROM = (n) => `<!-- howgozit-migrated-from: ${SOURCE}#${n} -->`;
const TOKEN_SHAPE = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/;
const FUTURE = '2099-01-01T00:00:00.000Z';
const realPause = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-verify-delete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = createMigrateWorld();
  const mapPath = join(dir, 'map.json');
  await writeFile(mapPath, JSON.stringify(world.map));
  const outDir = join(dir, 'out');
  const clock = { t: 0, sleeps: [], now() { return this.t; }, sleep(ms) { this.sleeps.push(ms); this.t += ms; return Promise.resolve(); } };
  const everything = []; // every out/err line of every run
  async function run(command, extra = [], env = {}) {
    const lines = [];
    const errs = [];
    const code = await main([command, '--map', mapPath, '--out', outDir, ...extra], {
      env: { BOARD_GITHUB_TOKEN: TOKEN, BOARD_REPO: SOURCE, ...env },
      fetch: async () => { throw new Error('no network in tests'); },
      cwd: dir,
      out: (l) => lines.push(String(l)),
      err: (l) => errs.push(String(l)),
      clock,
      owners: world.owners,
    });
    everything.push(...lines, ...errs);
    return { code, lines, errs, all: [...lines, ...errs] };
  }
  // time moves on between phases, on the fake clock and (in case a record is stamped by the real clock) the real one
  const tick = async () => { clock.t += 3600 * 1000; await realPause(); };
  return { dir, world, outDir, clock, run, tick, everything };
}

async function applied(t) {
  const s = await setup(t);
  const p = await s.run('plan');
  assert.equal(p.code, 0, p.all.join('\n'));
  const a = await s.run('apply');
  assert.equal(a.code, 0, a.all.join('\n'));
  return s;
}

async function verified(t) {
  const s = await applied(t);
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 0, v.all.join('\n'));
  await s.tick();
  return s;
}

const cp10 = (s, body) => writeFile(join(s.outDir, 'cp10-pass.json'),
  JSON.stringify({ cp: 'CP10', pass: true, at: FUTURE, by: 'ClaudeBWAI', board: SOURCE, evidence: 'test', ...body }));

// verified, with a passing CP10 file: delete is allowed to run
async function ready(t) {
  const s = await verified(t);
  await cp10(s, {});
  return s;
}

const readJson = async (s, name) => JSON.parse(await readFile(join(s.outDir, name), 'utf8'));
const writesOf = (world, from = 0) => world.calls().slice(from).filter((c) => c.method !== 'GET');
const list = async (world, repo, path) => (await world.fakes[ownerOf(repo)].http.paged(`/repos/${repo}${path}`)).items;
const issuesOf = (world, repo) => list(world, repo, '/issues?state=all&per_page=100');
const commentsOf = (world, repo, n) => list(world, repo, `/issues/${n}/comments?per_page=100`);
const milestonesOf = (world, repo) => list(world, repo, '/milestones?state=all&per_page=100');
const endsWith = (issue, marker) => String(issue.body || '').split('\n').pop() === marker;
const clone = (v) => JSON.parse(JSON.stringify(v));
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/_at$/.test(k)).map(([k, x]) => [k, strip(x)]));
  return v;
};
const stateOf = (world) => Object.fromEntries(Object.entries(world.fakes).map(([o, f]) => [o, strip(clone(f.state))]));
const outFiles = async (dir) => Object.fromEntries(await Promise.all((await readdir(dir)).sort().map(async (f) => [f, await readFile(join(dir, f), 'utf8')])));

async function assertGone(world, n) {
  await assert.rejects(world.fakes.Elmwood.http.get(`/repos/${SOURCE}/issues/${n}`), (e) => e.status === 410, `#${n} reads back 410`);
}

async function assertFullyDeleted(world) {
  for (const n of [1, 3, 6]) await assertGone(world, n);
  const ms = (await milestonesOf(world, SOURCE)).map((m) => m.title);
  assert.ok(!ms.includes('inkPress · Pilot'), 'the empty Pilot goal original is deleted');
  assert.ok(ms.includes('Woodshop · Launch'), 'Launch still holds closed #2 and is kept');
  assert.ok(ms.includes('Someday'), 'Someday never moved and is kept');
  const nums = world.fakes.Elmwood.state.projects.map((p) => p.number);
  for (const n of [1, 2, 3]) assert.ok(!nums.includes(n), `old Project ${n} is gone`);
  const road = world.fakes.Elmwood.state.projects.find((p) => p.title === 'Road');
  assert.ok(road, 'old Project 4 (a staying board) is untouched');
  assert.equal(road.items.length, 1);
  const issues = await issuesOf(world, SOURCE);
  for (const n of [2, 4, 5]) assert.ok(issues.some((i) => i.number === n), `#${n} is untouched`);
}

test('U verify passes after a full plan and apply: every pair same, verify-record.json says pass, nothing written to GitHub', async (t) => {
  const s = await applied(t);
  await s.tick();
  const from = s.world.calls().length;
  const v = await s.run('verify');
  assert.equal(v.code, 0, v.all.join('\n'));
  assert.equal(writesOf(s.world, from).length, 0, 'verify only reads');
  assert.ok(v.lines.some((l) => /^Verify: 3 pairs, 0 different\.$/.test(l)), v.lines.join('\n'));
  assert.equal(v.lines.filter((l) => /\bsame\b/.test(l)).length, 3, v.lines.join('\n'));
  const rec = await readJson(s, 'verify-record.json');
  assert.equal(rec.pass, true);
  assert.ok(typeof rec.at === 'string' && rec.at.length > 0);
  assert.match(rec.recordSha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(rec.rows) && rec.rows.length >= 3);
});

test('U verify fails with exit 1 and names the difference after a copy label is changed', async (t) => {
  const s = await applied(t);
  const copy = (await issuesOf(s.world, WLPT)).find((i) => endsWith(i, FROM(1)));
  assert.ok(copy, 'the copy of #1 exists');
  await s.world.fakes.brightcraft.http.send('PATCH', `/repos/${WLPT}/issues/${copy.number}`, { labels: ['somethingelse'] });
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.ok(v.lines.some((l) => /DIFFERENT/.test(l) && /labels/.test(l)), v.lines.join('\n'));
  assert.ok(v.lines.some((l) => /^Verify: 3 pairs, 1 different\.$/.test(l)), v.lines.join('\n'));
  const rec = await readJson(s, 'verify-record.json');
  assert.equal(rec.pass, false);
});

test('U verify with no migration record exits 1 with a plain sentence and writes no verify record', async (t) => {
  const s = await setup(t);
  const v = await s.run('verify');
  assert.equal(v.code, 1);
  assert.ok(v.all.length > 0);
  await assert.rejects(readFile(join(s.outDir, 'verify-record.json'), 'utf8'));
  assert.equal(writesOf(s.world).length, 0);
});

test('U delete is refused when verify has not been run: exit 1, a sentence, nothing deleted', async (t) => {
  const s = await applied(t);
  await s.tick();
  await cp10(s, {});
  const before = stateOf(s.world);
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.ok(d.errs.length > 0, 'a plain sentence says why');
  assert.equal(writesOf(s.world, from).length, 0);
  assert.deepEqual(stateOf(s.world), before);
});

test('U delete is refused with a stale verify: apply was run again after it', async (t) => {
  const s = await verified(t);
  await cp10(s, {});
  await s.tick();
  // a real change: a new open issue lands on old Project 1 (a no-op re-apply does not make verify stale)
  const einher = s.world.fakes.Elmwood;
  const created = einher.direct.request('POST', `/repos/${SOURCE}/issues`, { title: 'Added after verify', body: 'Body of Added after verify' });
  einher.direct.request('POST', '/users/Elmwood/projectsV2/1/items', { type: 'Issue', owner: 'Elmwood', repo: 'howgozit', number: created.number });
  const replan = await s.run('plan');
  assert.equal(replan.code, 0, replan.all.join('\n'));
  await s.tick();
  const mark = s.world.calls().length;
  const again = await s.run('apply');
  assert.equal(again.code, 0, again.all.join('\n'));
  assert.ok(writesOf(s.world, mark).length > 0, 'the second apply really wrote');
  await s.tick();
  const before = stateOf(s.world);
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.ok(d.errs.length > 0);
  assert.equal(writesOf(s.world, from).length, 0);
  assert.deepEqual(stateOf(s.world), before);
});

test('U delete is refused when the record changed after verify (recordSha256 no longer matches)', async (t) => {
  const s = await ready(t);
  const recPath = join(s.outDir, 'migration-record.json');
  const rec = JSON.parse(await readFile(recPath, 'utf8'));
  rec.startedAt = '2001-01-01T00:00:00.000Z';
  await writeFile(recPath, JSON.stringify(rec, null, 2) + '\n');
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.equal(writesOf(s.world, from).length, 0);
});

test('U delete is refused without cp10-pass.json', async (t) => {
  const s = await verified(t);
  const before = stateOf(s.world);
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.ok(d.errs.length > 0);
  assert.equal(writesOf(s.world, from).length, 0);
  assert.deepEqual(stateOf(s.world), before);
});

test('U delete is refused when cp10-pass.json says pass false', async (t) => {
  const s = await verified(t);
  await cp10(s, { pass: false });
  const before = stateOf(s.world);
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.ok(d.errs.length > 0);
  assert.equal(writesOf(s.world, from).length, 0);
  assert.deepEqual(stateOf(s.world), before);
});

test('U delete is refused when cp10-pass.json is older than the verify', async (t) => {
  const s = await verified(t);
  await cp10(s, { at: '2000-01-01T00:00:00.000Z' });
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.equal(writesOf(s.world, from).length, 0);
});

test('U delete without --confirm lists what it would delete and writes nothing anywhere', async (t) => {
  const s = await ready(t);
  const beforeState = stateOf(s.world);
  const beforeFiles = await outFiles(s.outDir);
  const from = s.world.calls().length;
  const d = await s.run('delete');
  assert.equal(d.code, 0, d.all.join('\n'));
  assert.ok(d.lines.length > 0, 'it lists what it would delete');
  assert.equal(writesOf(s.world, from).length, 0, 'no write call');
  assert.deepEqual(stateOf(s.world), beforeState);
  assert.deepEqual(await outFiles(s.outDir), beforeFiles, 'no file in --out is written or changed');
});

test('U delete with --confirm reads the originals back as 410 and deletes only the moved ones', async (t) => {
  const s = await ready(t);
  const untouched = {};
  for (const n of [2, 4, 5]) untouched[n] = clone((await issuesOf(s.world, SOURCE)).find((i) => i.number === n));
  const comments = {};
  for (const n of [2, 4, 5]) comments[n] = clone(await commentsOf(s.world, SOURCE, n));
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 0, d.all.join('\n'));
  for (const n of [1, 3, 6]) await assertGone(s.world, n);
  const issues = await issuesOf(s.world, SOURCE);
  for (const n of [2, 4, 5]) {
    assert.deepEqual(issues.find((i) => i.number === n), untouched[n], `#${n} untouched`);
    assert.deepEqual(await commentsOf(s.world, SOURCE, n), comments[n], `#${n} comments untouched`);
  }
  for (const [repo, n] of [[WLPT, 1], [IN2, 3], [BOOK, 6]]) {
    assert.ok((await issuesOf(s.world, repo)).some((i) => endsWith(i, FROM(n))), `the copy of #${n} survives`);
  }
  const rec = await readJson(s, 'migration-record.json');
  assert.ok(Array.isArray(rec.deletions) && rec.deletions.length >= 3, 'the record lists the deletions');
});

test('U delete with --confirm deletes the empty Pilot goal original and keeps the goal that still holds closed #2', async (t) => {
  const s = await ready(t);
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 0, d.all.join('\n'));
  const titles = (await milestonesOf(s.world, SOURCE)).map((m) => m.title);
  assert.ok(!titles.includes('inkPress · Pilot'));
  assert.ok(titles.includes('Woodshop · Launch'));
  assert.ok(titles.includes('Someday'));
  const two = (await issuesOf(s.world, SOURCE)).find((i) => i.number === 2);
  assert.equal(two.state, 'closed');
  assert.equal(two.milestone && two.milestone.title, 'Woodshop · Launch', 'closed #2 keeps its goal');
  assert.ok((await milestonesOf(s.world, IN2)).some((m) => m.title === 'Pilot'), 'the copy of Pilot survives');
});

test('U delete with --confirm removes old Projects 1 to 3 and leaves Project 4, Ideas and Habits', async (t) => {
  const s = await ready(t);
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 0, d.all.join('\n'));
  const projects = s.world.fakes.Elmwood.state.projects;
  const titles = projects.map((p) => p.title);
  for (const gone of ['Woodshop', 'inkPress', 'BOOK']) assert.ok(!projects.some((p) => p.number <= 3 && p.title === gone), `old ${gone} is gone`);
  assert.ok(titles.includes('Road'));
  assert.ok(titles.includes('Ideas'));
  assert.ok(titles.includes('Habits'));
  assert.equal(projects.find((p) => p.title === 'Road').items.length, 1);
  assert.ok(s.world.fakes.brightcraft.state.projects.some((p) => p.title === 'Woodshop'), 'the new org Projects stay');
  await assertFullyDeleted(s.world);
});

test('U delete resumes after a failed delete write and finishes without deleting anything twice', async (t) => {
  const s = await ready(t);
  let count = 0;
  s.world.fakes.Elmwood.fail((call) => call.method === 'GRAPHQL' && call.path === 'deleteIssue' && ++count === 2, new GitHubError('server', 502));
  const first = await s.run('delete', ['--confirm']);
  assert.equal(first.code, 1, first.all.join('\n'));
  const rec = await readJson(s, 'migration-record.json');
  assert.ok(Array.isArray(rec.deletions) && rec.deletions.length >= 1, 'the first delete is recorded');
  const second = await s.run('delete', ['--confirm']);
  assert.equal(second.code, 0, second.all.join('\n'));
  await assertFullyDeleted(s.world);
  const deleteCalls = s.world.calls().filter((c) => c.method === 'GRAPHQL' && c.path === 'deleteIssue');
  assert.equal(deleteCalls.length, 4, '3 issues deleted once each, plus the one failed write');
  const third = await s.run('delete', ['--confirm']);
  assert.equal(third.code, 0, third.all.join('\n'));
  assert.equal(s.world.calls().filter((c) => c.method === 'GRAPHQL' && c.path === 'deleteIssue').length, 4, 'a third run deletes nothing more');
});

test('U delete treats an original already gone as done', async (t) => {
  const s = await ready(t);
  await s.world.fakes.Elmwood.http.graphql('mutation { deleteIssue(input: {}) { repository { id } } }',
    { issueId: (await issuesOf(s.world, SOURCE)).find((i) => i.number === 6).node_id });
  await assertGone(s.world, 6);
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 0, d.all.join('\n'));
  await assertFullyDeleted(s.world);
});

test('U no token reaches any output line or written file, even when a failure message holds one', async (t) => {
  const env = { BOARD_GITHUB_TOKEN_1: TOKEN2, BOARD_GITHUB_OWNER_1: 'inkPress' };
  const s = await setup(t);
  assert.equal((await s.run('plan', [], env)).code, 0);
  assert.equal((await s.run('apply', [], env)).code, 0);
  await s.tick();
  // a failure whose message holds a token, mid-verify
  s.world.fakes.Elmwood.fail((call) => call.method === 'GET' && /\/comments/.test(call.path), new Error(`boom ${TOKEN} and ${TOKEN2}`));
  const bad = await s.run('verify', [], env);
  assert.equal(bad.code, 1, bad.all.join('\n'));
  const good = await s.run('verify', [], env);
  assert.equal(good.code, 0, good.all.join('\n'));
  await s.tick();
  await cp10(s, {});
  // a failure whose message holds a token, mid-delete (a GitHub error, then an unexpected one)
  s.world.fakes.Elmwood.fail((call) => call.method === 'GRAPHQL' && call.path === 'deleteIssue', new GitHubError('server', 502, `upstream said ${TOKEN}`));
  const d1 = await s.run('delete', ['--confirm'], env);
  assert.equal(d1.code, 1, d1.all.join('\n'));
  s.world.fakes.Elmwood.fail((call) => call.method === 'GRAPHQL' && call.path === 'deleteIssue', new Error(`surprise ${TOKEN2} ${TOKEN}`));
  const d2 = await s.run('delete', ['--confirm'], env);
  assert.equal(d2.code, 1, d2.all.join('\n'));
  const d3 = await s.run('delete', ['--confirm'], env);
  assert.equal(d3.code, 0, d3.all.join('\n'));

  for (const line of s.everything) {
    assert.ok(!line.includes(TOKEN) && !line.includes(TOKEN2), `a token in an output line: ${line}`);
    assert.ok(!TOKEN_SHAPE.test(line), `token-shaped text in an output line: ${line}`);
  }
  const files = await outFiles(s.outDir);
  assert.ok(Object.keys(files).length >= 4, Object.keys(files).join(','));
  for (const [name, text] of Object.entries(files)) {
    assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN2), `a token in ${name}`);
    assert.ok(!TOKEN_SHAPE.test(text), `token-shaped text in ${name}`);
  }
});
