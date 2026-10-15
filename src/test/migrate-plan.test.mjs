// CP8 J5: the migration's `plan` command, written from reference/mapping-redesign/cp8-interface.md (sections 3 and 5) alone.
// No contract rule covers the migration, so every name starts "U ".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/migrate.mjs';
import { createMigrateWorld } from '../fixtures/migrate-world.mjs';

const TOKEN = 'ghp_' + 'a'.repeat(36);
const SOURCE = 'Elmwood/howgozit';

async function setup(t, worldOpts) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = createMigrateWorld(worldOpts);
  const mapPath = join(dir, 'map.json');
  await writeFile(mapPath, JSON.stringify(world.map));
  const outDir = join(dir, 'out');
  const clock = { t: 0, sleeps: [], now() { return this.t; }, sleep(ms) { this.sleeps.push(ms); this.t += ms; return Promise.resolve(); } };
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
    return { code, lines, errs, all: [...lines, ...errs] };
  }
  return { dir, world, mapPath, outDir, clock, run };
}

const writesOf = (world, from = 0) => world.calls().slice(from).filter((c) => c.method !== 'GET');
const exists = async (p) => stat(p).then(() => true, () => false);
const has = (lines, text) => lines.some((l) => l.includes(text));

test('U plan makes no write call on any of the three fakes and says nothing was written', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.equal(writesOf(s.world).length, 0, JSON.stringify(writesOf(s.world)));
  assert.ok(s.world.calls().length > 0, 'plan must have read something');
  assert.match(r.lines[r.lines.length - 1], /^Plan: \d+ cards move, \d+ stay as history, \d+ goals move, \d+ stay, \d+ targets to create\. Nothing was written\.$/);
  assert.equal(s.clock.sleeps.length, 0, 'reads are not paced');
});

test('U plan counts the cards and goals of the world in its last line', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.equal(r.code, 0, r.errs.join('\n'));
  // #1, #3 and #6 move; closed #2 stays; Launch and Pilot move; Someday stays.
  assert.match(r.lines[r.lines.length - 1], /^Plan: 3 cards move, 1 stay as history, 2 goals move, 1 stay,/);
});

test('U plan lists the closed issue as staying in the source as history', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.ok(has(r.lines, `${SOURCE}#2 stays in ${SOURCE} as history`), r.lines.join('\n'));
  assert.ok(!r.lines.some((l) => l.startsWith(`${SOURCE}#2 →`)), 'closed #2 must not be planned to move');
});

test('U plan moves the open card of the Woodshop board to its home with its Project and comment count', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  const line = r.lines.find((l) => l.startsWith(`${SOURCE}#1 →`));
  assert.ok(line, r.lines.join('\n'));
  assert.ok(line.includes('brightcraft/blastworks-Woodshop'), line);
  assert.ok(line.includes('Project "Woodshop" (brightcraft)'), line);
  assert.ok(line.includes('2 comments'), line);
});

test('U plan sends the card with no goal to its own board home', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  // #3 is open on the inkPress board and holds no milestone.
  const line = r.lines.find((l) => l.startsWith(`${SOURCE}#3 →`));
  assert.ok(line, r.lines.join('\n'));
  assert.ok(line.includes('inkPress/inkPress'), line);
  assert.ok(line.includes('Project "inkPress" (inkPress)'), line);
  const book = r.lines.find((l) => l.startsWith(`${SOURCE}#6 →`));
  assert.ok(book && book.includes('brightcraft/book'), r.lines.join('\n'));
});

test('U plan strips the project prefix from the goal title it moves', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.ok(has(r.lines, 'Goal "Woodshop · Launch" → brightcraft/blastworks-Woodshop as "Launch"'), r.lines.join('\n'));
});

test('U plan moves the empty goal "inkPress · Pilot" to inkPress/inkPress as "Pilot"', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.ok(has(r.lines, 'Goal "inkPress · Pilot" → inkPress/inkPress as "Pilot"'), r.lines.join('\n'));
});

test('U plan leaves the goal "Someday" in the source because no card moves with it', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.ok(has(r.lines, `Goal "Someday" stays in ${SOURCE}: no card moves with it`), r.lines.join('\n'));
});

test('U plan lists the targets to create and the idea to add, and does not list the staying board', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.ok(has(r.lines, 'To create: repository brightcraft/book (private)'), r.lines.join('\n'));
  assert.ok(has(r.lines, 'To create: Project "Woodshop" under brightcraft, with a Due date field, linked to brightcraft/blastworks-Woodshop'), r.lines.join('\n'));
  assert.ok(has(r.lines, 'To create: Project "Habits" under Elmwood, with a number field Score'), r.lines.join('\n'));
  assert.ok(has(r.lines, `To add to Ideas: ${SOURCE}#4`), r.lines.join('\n'));
  assert.ok(!r.lines.some((l) => l.startsWith(`${SOURCE}#5 →`)), '#5 sits on a staying board');
});

test('U plan writes plan.json with a digest, and the digest is the same on a second plan', async (t) => {
  const s = await setup(t);
  const first = await s.run('plan');
  assert.equal(first.code, 0, first.errs.join('\n'));
  const one = JSON.parse(await readFile(join(s.outDir, 'plan.json'), 'utf8'));
  assert.match(one.digest, /^[0-9a-f]{64}$/);
  assert.ok(one.at, 'plan.json carries the time it was made');
  const second = await s.run('plan');
  assert.equal(second.code, 0, second.errs.join('\n'));
  const two = JSON.parse(await readFile(join(s.outDir, 'plan.json'), 'utf8'));
  assert.equal(two.digest, one.digest);
});

test('U plan --json prints the plan object with no refusals and the same digest as plan.json', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan', ['--json']);
  assert.equal(r.code, 0, r.errs.join('\n'));
  const printed = JSON.parse(r.lines.join('\n'));
  assert.equal(printed.ok, true);
  assert.deepEqual(printed.refusals, []);
  for (const k of ['issues', 'milestones', 'targets', 'ideas', 'notes']) assert.ok(Array.isArray(printed[k]), k);
  const file = JSON.parse(await readFile(join(s.outDir, 'plan.json'), 'utf8'));
  assert.equal(file.digest, printed.digest);
});

test('U plan refuses a public target, exits 1 and writes no plan.json', async (t) => {
  const s = await setup(t, { publicTarget: 'inkPress/inkPress' });
  const r = await s.run('plan');
  assert.equal(r.code, 1);
  assert.ok(has(r.all, 'inkPress/inkPress is public; the migration only moves cards into private repositories.'), r.all.join('\n'));
  assert.equal(await exists(join(s.outDir, 'plan.json')), false);
  assert.equal(writesOf(s.world).length, 0);
});

test('U plan refuses when BOARD_REPO is not the repository the map moves from', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan', [], { BOARD_REPO: 'someone/else' });
  assert.equal(r.code, 1);
  assert.ok(has(r.all, `BOARD_REPO names someone/else, but the map moves from ${SOURCE}.`), r.all.join('\n'));
  assert.equal(await exists(join(s.outDir, 'plan.json')), false);
});

test('U plan prints no token', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.ok(!r.all.some((l) => l.includes(TOKEN)));
});

async function scoredSetup(t, scored) {
  const s = await setup(t);
  const fake = s.world.fakes.Elmwood.direct;
  const cur = fake.request('GET', `/repos/${SOURCE}/contents/board.config.json`);
  const settings = JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8'));
  settings.habits = [{ id: 'mood', title: 'Mood' }];
  fake.request('PUT', `/repos/${SOURCE}/contents/board.config.json`, { content: Buffer.from(JSON.stringify(settings)).toString('base64'), sha: cur.sha });
  s.world.map.habits.scored = scored;
  await writeFile(s.mapPath, JSON.stringify(s.world.map));
  return s;
}

test('U plan names a scored habit and gives it a score from 1 to 10', async (t) => {
  const s = await scoredSetup(t, ['mood']);
  const r = await s.run('plan');
  assert.equal(r.code, 0, r.all.join('\n'));
  assert.ok(has(r.lines, 'Habit "Mood" (mood) gets a score from 1 to 10.'), r.all.join('\n'));
});

test('U plan refuses a scored id that is not a habit in the settings, exits 1 and writes no plan.json', async (t) => {
  const s = await scoredSetup(t, ['nope']);
  const r = await s.run('plan');
  assert.equal(r.code, 1);
  assert.ok(has(r.all, 'habits.scored names nope, which is not a habit in the settings.'), r.all.join('\n'));
  assert.equal(await exists(join(s.outDir, 'plan.json')), false);
});
