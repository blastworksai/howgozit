// A goal's due date survives the move: GitHub stores midnight UTC a day early, so apply writes noon UTC.
// No contract rule covers the migration, so every name starts "U ".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/migrate.mjs';
import { createMigrateWorld } from '../fixtures/migrate-world.mjs';

const TOKEN = 'ghp_' + 'd'.repeat(36);
const SOURCE = 'Elmwood/howgozit';
const ownerOf = (repo) => repo.split('/')[0];

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-duenoon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = createMigrateWorld();
  const mapPath = join(dir, 'map.json');
  await writeFile(mapPath, JSON.stringify(world.map));
  const outDir = join(dir, 'out');
  const clock = { t: 0, now() { return this.t; }, sleep(ms) { this.t += ms; return Promise.resolve(); } };
  async function run(command, extra = []) {
    const lines = [];
    const errs = [];
    const code = await main([command, '--map', mapPath, '--out', outDir, ...extra], {
      env: { BOARD_GITHUB_TOKEN: TOKEN, BOARD_REPO: SOURCE },
      fetch: async () => { throw new Error('no network in tests'); },
      cwd: dir, out: (l) => lines.push(String(l)), err: (l) => errs.push(String(l)), clock, owners: world.owners,
    });
    return { code, lines, errs, all: [...lines, ...errs] };
  }
  const tick = async () => { clock.t += 3600 * 1000; await new Promise((r) => setTimeout(r, 15)); };
  return { world, run, tick };
}
const milestonesOf = async (world, repo) => (await world.fakes[ownerOf(repo)].http.paged(`/repos/${repo}/milestones?state=all&per_page=100`)).items;
const day = (v) => (v ? v.slice(0, 10) : null);

// Every copy milestone in the fakes: each fake's main repo is state.milestones, extra repos sit under state.repos; the source is excluded
const copiesOf = (world) => Object.entries(world.fakes).flatMap(([owner, f]) => [
  ...(owner === 'Elmwood' ? [] : f.state.milestones),
  ...Object.entries(f.state.repos ?? {}).filter(([full]) => full !== SOURCE).flatMap(([, e]) => e.milestones),
]);

test('U a moving goal with a due date keeps the same UTC date on its copy, and verify passes', async (t) => {
  const s = await setup(t);
  const p = await s.run('plan'); assert.equal(p.code, 0, p.all.join('\n'));
  const a = await s.run('apply'); assert.equal(a.code, 0, a.all.join('\n'));
  const src = (await milestonesOf(s.world, SOURCE)).filter((m) => m.due_on);
  assert.ok(src.length > 0, 'the world has dated goals');
  // copy titles carry a prefix, so match by the source date: the world gives every dated goal one UTC date
  const srcDays = new Set(src.map((m) => day(m.due_on)));
  assert.equal(srcDays.size, 1);
  const dated = copiesOf(s.world).filter((m) => m.due_on);
  assert.ok(dated.length > 0, 'at least one dated copy');
  for (const m of dated) assert.equal(day(m.due_on), [...srcDays][0], m.title);
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 0, v.all.join('\n'));
});

test('U verify treats 2026-11-10T00:00:00Z and 2026-11-10T07:00:00Z as the same date', async (t) => {
  const s = await setup(t);
  const p = await s.run('plan'); assert.equal(p.code, 0, p.all.join('\n'));
  const a = await s.run('apply'); assert.equal(a.code, 0, a.all.join('\n'));
  const copies = copiesOf(s.world).filter((m) => m.due_on);
  assert.ok(copies.length > 0, 'a dated copy exists');
  // set the stored values directly (state, not a PATCH, so the fake's shift does not apply)
  for (const m of copies) {
    m.due_on = '2026-11-10T07:00:00Z';
  }
  for (const m of s.world.fakes.Elmwood.state.milestones) if (m.due_on) m.due_on = '2026-11-10T00:00:00Z';
  await s.tick();
  const v = await s.run('verify');
  assert.ok(!v.all.join('\n').includes('DIFFERENT: due'), v.all.join('\n'));
  assert.equal(v.code, 0, v.all.join('\n'));
});
