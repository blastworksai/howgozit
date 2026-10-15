// CP8 review round 3: tests for the rulings R3-1 to R3-4, written from the TEXT of reference/mapping-redesign/cp8-interface.md
// section 12 (with 11, 5 and 4 for context). No contract rule covers the migration, so every name starts "U ".
// Everything goes through main(); the fake is only used through its documented test doors (direct, lagItems, fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/migrate.mjs';
import { createMigrateWorld } from '../fixtures/migrate-world.mjs';
import { GitHubError } from '../board/github/http.mjs';

const TOKEN = 'ghp_' + 'd'.repeat(36);
const SOURCE = 'Elmwood/howgozit';
const WLPT = 'brightcraft/blastworks-Woodshop';
const BOOK = 'brightcraft/book';
const ownerOf = (repo) => repo.split('/')[0];
const FROM = (n) => `<!-- howgozit-migrated-from: ${SOURCE}#${n} -->`;
const FUTURE = '2099-01-01T00:00:00.000Z';
const realPause = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function setup(t, { editMap } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-review3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = createMigrateWorld();
  const map = structuredClone(world.map);
  if (editMap) editMap(map);
  const mapPath = join(dir, 'map.json');
  await writeFile(mapPath, JSON.stringify(map));
  const outDir = join(dir, 'out');
  const clock = { t: 0, sleeps: [], now() { return this.t; }, sleep(ms) { this.sleeps.push(ms); this.t += ms; return Promise.resolve(); } };
  async function run(command, extra = []) {
    const lines = [];
    const errs = [];
    const code = await main([command, '--map', mapPath, '--out', outDir, ...extra], {
      env: { BOARD_GITHUB_TOKEN: TOKEN, BOARD_REPO: SOURCE },
      fetch: async () => { throw new Error('no network in tests'); },
      cwd: dir,
      out: (l) => lines.push(String(l)),
      err: (l) => errs.push(String(l)),
      clock,
      owners: world.owners,
    });
    return { code, lines, errs, all: [...lines, ...errs] };
  }
  const tick = async () => { clock.t += 3600 * 1000; await realPause(); };
  return { dir, world, outDir, mapPath, clock, run, tick };
}

const planned = async (s) => { const p = await s.run('plan'); assert.equal(p.code, 0, p.all.join('\n')); return p; };
const applied = async (s) => { await planned(s); const a = await s.run('apply'); assert.equal(a.code, 0, a.all.join('\n')); return a; };
const verifiedOk = async (s) => { await s.tick(); const v = await s.run('verify'); assert.equal(v.code, 0, v.all.join('\n')); await s.tick(); return v; };
const cp10 = (s) => writeFile(join(s.outDir, 'cp10-pass.json'),
  JSON.stringify({ cp: 'CP10', pass: true, at: FUTURE, by: 'ClaudeBWAI', board: SOURCE, evidence: 'test' }));

const writesOf = (world, from = 0) => world.calls().slice(from).filter((c) => c.method !== 'GET');
const list = async (world, repo, path) => (await world.fakes[ownerOf(repo)].http.paged(`/repos/${repo}${path}`)).items;
const issuesOf = (world, repo) => list(world, repo, '/issues?state=all&per_page=100');
const milestonesOf = (world, repo) => list(world, repo, '/milestones?state=all&per_page=100');
const projectOf = (world, owner, title) => world.fakes[owner].state.projects.find((p) => p.title === title);
const itemOf = (project, repo, n) => project.items.find((it) => it.content.number === n && it.content.repository.full_name === repo);
const endsWith = (issue, marker) => String(issue.body || '').split('\n').pop() === marker;
const copyOf = async (world, repo, oldN) => {
  const hits = (await issuesOf(world, repo)).filter((i) => endsWith(i, FROM(oldN)));
  assert.equal(hits.length, 1, `${repo} should hold exactly one copy of #${oldN}, found ${hits.length}`);
  return hits[0];
};
const readJson = async (s, name) => JSON.parse(await readFile(join(s.outDir, name), 'utf8'));
const sourceGoal = async (world, title) => {
  const hit = (await milestonesOf(world, SOURCE)).find((m) => m.title === title);
  assert.ok(hit, `source goal "${title}" exists`);
  return hit;
};
const renameGoal = async (world, title, to) => {
  const m = await sourceGoal(world, title);
  world.fakes.Elmwood.direct.request('PATCH', `/repos/${SOURCE}/milestones/${m.number}`, { title: to });
};
const refusesDelete = async (s) => {
  await s.tick();
  await cp10(s);
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.deepEqual(writesOf(s.world, from), [], 'delete wrote nothing');
};
// inkpress: empty its only card's Project and drop its goal, so the key moves nothing but still has a home
const emptyKey = (s) => {
  const p2 = s.world.fakes.Elmwood.state.projects.find((p) => p.number === 2);
  p2.items.splice(0, p2.items.length);
};
const retarget = async (s) => {
  const map = JSON.parse(await readFile(s.mapPath, 'utf8'));
  map.projects.inkpress.home = WLPT; // another existing private repo and owner
  map.projects.inkpress.projectOwner = 'brightcraft';
  await writeFile(s.mapPath, JSON.stringify(map));
};

test('U R3-1 a moving empty goal renamed after apply so it now stays fails verify with "no longer planned to move" and delete refuses', async (t) => {
  const s = await setup(t);
  await applied(s);
  const pilot = await sourceGoal(s.world, 'inkPress · Pilot');
  await renameGoal(s.world, 'inkPress · Pilot', 'Pilot');
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.ok(v.all.some((l) => l.includes('no longer planned to move') && l.includes(`milestone ${pilot.number}`)), v.all.join('\n'));
  await refusesDelete(s);
});

test('U R3-1 a still-moving goal whose source title is renamed after apply fails verify naming the title; the recorded copy title is not accepted', async (t) => {
  const s = await setup(t);
  await applied(s);
  await verifiedOk(s); // sanity: it passed before the rename
  const launch = await sourceGoal(s.world, 'Woodshop · Launch');
  await renameGoal(s.world, 'Woodshop · Launch', 'Woodshop · Launch renamed');
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.ok(v.all.some((l) => l.includes(`milestone ${launch.number}`) && /DIFFERENT/.test(l) && /title/.test(l)), v.all.join('\n'));
  await refusesDelete(s);
});

test('U R3-2 changing only the home and projectOwner of a moving key with no moving issue or goal changes the plan digest', async (t) => {
  const s = await setup(t);
  emptyKey(s);
  await s.world.fakes.Elmwood.direct.request('DELETE', `/repos/${SOURCE}/milestones/${(await sourceGoal(s.world, 'inkPress · Pilot')).number}`);
  await planned(s);
  const before = (await readJson(s, 'plan.json')).digest;
  assert.ok(before, 'the plan holds a digest');
  await retarget(s);
  await planned(s);
  const after = (await readJson(s, 'plan.json')).digest;
  assert.notEqual(after, before, 'a changed home is a changed digest');
});

test('U R3-2 apply with the old saved plan refuses on the digest and writes nothing when only that key\'s home changed', async (t) => {
  const s = await setup(t);
  emptyKey(s);
  await s.world.fakes.Elmwood.direct.request('DELETE', `/repos/${SOURCE}/milestones/${(await sourceGoal(s.world, 'inkPress · Pilot')).number}`);
  await planned(s);
  await retarget(s);
  const from = s.world.calls().length;
  const a = await s.run('apply');
  assert.equal(a.code, 1, a.all.join('\n'));
  assert.ok(a.errs.join('\n').includes('The board changed after the plan was made; run plan again.'), a.all.join('\n'));
  assert.deepEqual(writesOf(s.world, from), [], 'zero writes');
});

test('U R3-2 a resume after a partial apply (targets made, then a failed write) still matches the digest and completes', async (t) => {
  const s = await setup(t);
  await planned(s);
  // the first copy POST into the Woodshop repo fails once: targets (repo, Projects, labels, goals) already exist by then
  s.world.fakes.brightcraft.fail({ method: 'POST', path: /\/repos\/brightcraft\/blastworks-Woodshop\/issues$/ }, new GitHubError('network', 0));
  const first = await s.run('apply');
  assert.equal(first.code, 1, first.all.join('\n'));
  assert.ok(projectOf(s.world, 'brightcraft', 'Woodshop'), 'the targets were created before the stop');
  const second = await s.run('apply');
  assert.equal(second.code, 0, second.all.join('\n'));
  assert.ok(!second.all.join('\n').includes('The board changed after the plan was made'), 'no false digest refusal');
  await copyOf(s.world, WLPT, 1);
});

test('U R3-3 a cold apply carries Status and Due onto the copy while the target Projects\' items list lags, never asking the list', async (t) => {
  const s = await setup(t);
  await planned(s);
  // every item list on the target owners answers empty for a long time (CP0 c+: the real list lags 45 to 140 s)
  s.world.fakes.brightcraft.lagItems(100000);
  s.world.fakes.inkPress.lagItems(100000);
  const from = s.world.calls().length;
  const a = await s.run('apply');
  assert.equal(a.code, 0, a.all.join('\n'));
  assert.ok(!a.all.join('\n').includes('not listed yet'), a.all.join('\n'));
  const copy = await copyOf(s.world, WLPT, 1);
  const item = itemOf(projectOf(s.world, 'brightcraft', 'Woodshop'), WLPT, copy.number);
  assert.ok(item, 'the copy is on the new Project');
  assert.equal(item.status, 'In Progress', 'Status carried (Doing becomes In Progress)');
  assert.equal(item.due, '2026-11-01', 'Due carried');
  // and the request record agrees: no items LIST read on a target owner during apply
  const listReads = s.world.calls().slice(from).filter((c) => c.method === 'GET' && c.owner !== 'Elmwood' && /\/projectsV2\/\d+\/items(\?|$)/.test(c.path));
  assert.deepEqual(listReads, [], 'apply never read a target Project\'s items list');
});

test('U R3-4 a target Project deleted after apply and replaced by another with the same owner, title and Due field fails verify', async (t) => {
  const s = await setup(t);
  await applied(s);
  await verifiedOk(s);
  const fake = s.world.fakes.brightcraft;
  const old = projectOf(s.world, 'brightcraft', 'BOOK');
  fake.direct.graphql('mutation { deleteProjectV2(input: {}) { projectV2 { id } } }', { projectId: old.node_id });
  const made = fake.direct.graphql('mutation { createProjectV2(input: {}) { projectV2 { id } } }', { ownerId: 'O_1', title: 'BOOK' }).createProjectV2.projectV2;
  const fresh = fake.state.projects.find((p) => p.number === made.number);
  fake.direct.graphql('mutation { createProjectV2Field(input: {}) { projectV2Field { id } } }', { projectId: fresh.node_id, name: 'Due', dataType: 'DATE' });
  assert.notEqual(fresh.number, old.number, 'the replacement has another number');
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.ok(v.all.some((l) => /Project replaced since apply|missing/.test(l)), v.all.join('\n'));
  await refusesDelete(s);
});

test('U R3-4 a Habits Project (holding no copy) deleted after apply and replaced at a new number with the same owner, title and Score field fails verify', async (t) => {
  const s = await setup(t);
  await applied(s);
  await verifiedOk(s);
  const fake = s.world.fakes.Elmwood;
  const old = projectOf(s.world, 'Elmwood', 'Habits');
  assert.ok(old, 'apply made the Habits Project');
  assert.equal(old.items.length, 0, 'Habits holds no copy, so membership cannot be what fails');
  fake.direct.graphql('mutation { deleteProjectV2(input: {}) { projectV2 { id } } }', { projectId: old.node_id });
  const made = fake.direct.graphql('mutation { createProjectV2(input: {}) { projectV2 { id } } }', { ownerId: 'O_1', title: 'Habits' }).createProjectV2.projectV2;
  const fresh = fake.state.projects.find((p) => p.number === made.number);
  fake.direct.graphql('mutation { createProjectV2Field(input: {}) { projectV2Field { id } } }', { projectId: fresh.node_id, name: 'Score', dataType: 'NUMBER' });
  assert.notEqual(fresh.number, old.number, 'the replacement has another number');
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.ok(v.all.some((l) => /Project replaced since apply|missing/.test(l)), v.all.join('\n'));
  await refusesDelete(s);
});
