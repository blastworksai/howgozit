// A target repository with Issues switched off cannot take a copy: plan refuses it (apply would fail at the first issue POST).
// Written beside migrate-plan.test.mjs; names start "U " because no contract rule covers the migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/migrate.mjs';
import { createMigrateWorld } from '../fixtures/migrate-world.mjs';

const TOKEN = 'ghp_' + 'e'.repeat(36);
const SOURCE = 'Elmwood/howgozit';
const IN2 = 'inkPress/inkPress';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-issues-off-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = createMigrateWorld();
  const mapPath = join(dir, 'map.json');
  await writeFile(mapPath, JSON.stringify(world.map));
  const outDir = join(dir, 'out');
  const clock = { t: 0, now() { return this.t; }, sleep(ms) { this.t += ms; return Promise.resolve(); } };
  async function run(command) {
    const lines = [];
    const errs = [];
    const code = await main([command, '--map', mapPath, '--out', outDir], {
      env: { BOARD_GITHUB_TOKEN: TOKEN, BOARD_REPO: SOURCE },
      fetch: async () => { throw new Error('no network in tests'); },
      cwd: dir, out: (l) => lines.push(String(l)), err: (l) => errs.push(String(l)), clock, owners: world.owners,
    });
    return { code, all: [...lines, ...errs] };
  }
  return { world, outDir, run };
}
const exists = (p) => access(p).then(() => true, () => false);
const writesOf = (world) => world.calls().filter((c) => c.method !== 'GET');
const SENTENCE = `${IN2} has Issues switched off; turn them on in its Settings, then run plan again.`;

test('U plan refuses a target with Issues switched off that receives a moving issue', async (t) => {
  const s = await setup(t);
  s.world.fakes.inkPress.setHasIssues(IN2, false);
  const r = await s.run('plan');
  assert.equal(r.code, 1, r.all.join('\n'));
  assert.ok(r.all.some((l) => l.includes(SENTENCE)), r.all.join('\n'));
  assert.equal(await exists(join(s.outDir, 'plan.json')), false);
  assert.equal(writesOf(s.world).length, 0);
});

test('U plan does not refuse a target with Issues switched off that receives no moving issue', async (t) => {
  const s = await setup(t);
  s.world.fakes.inkPress.setHasIssues(IN2, false);
  // the only open card for inkPress is #3; closed, it stays as history and nothing moves there
  s.world.fakes.Elmwood.direct.request('PATCH', `/repos/${SOURCE}/issues/3`, { state: 'closed' });
  const r = await s.run('plan');
  assert.equal(r.code, 0, r.all.join('\n'));
  assert.equal(r.all.some((l) => l.includes('Issues switched off')), false);
});

test('U plan on the default world is unchanged and ok', async (t) => {
  const s = await setup(t);
  const r = await s.run('plan');
  assert.equal(r.code, 0, r.all.join('\n'));
  assert.equal(await exists(join(s.outDir, 'plan.json')), true);
});
