// CP8 review round 2: one test per ruling R2-1 to R2-7, written from the TEXT of reference/mapping-redesign/cp8-interface.md
// section 11 (with 10, 5 and 4 for context). No contract rule covers the migration, so every name starts "U ".
// Everything goes through main(); where the fake lacks a door, a small wrapper in this file stands in front of the fake's client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/migrate.mjs';
import { createMigrateWorld } from '../fixtures/migrate-world.mjs';
import { GitHubError } from '../board/github/http.mjs';

const TOKEN = 'ghp_' + 'c'.repeat(36);
const SOURCE = 'Elmwood/howgozit';
const WLPT = 'brightcraft/blastworks-Woodshop';
const BOOK = 'brightcraft/book';
const IN2 = 'inkPress/inkPress';
const ownerOf = (repo) => repo.split('/')[0];
const FROM = (n) => `<!-- howgozit-migrated-from: ${SOURCE}#${n} -->`;
const FUTURE = '2099-01-01T00:00:00.000Z';
const realPause = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const MUT = 'mutation { updateProjectV2ItemFieldValue(input: {}) { projectV2Item { id } } }';

function routed(owners, wrap) {
  return {
    default: wrap('default', owners.default),
    forOwner: (login) => wrap(String(login).toLowerCase(), owners.forOwner(login)),
  };
}

async function setup(t, { editMap, wrap } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-review2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = createMigrateWorld();
  const map = structuredClone(world.map);
  if (editMap) editMap(map);
  const mapPath = join(dir, 'map.json');
  await writeFile(mapPath, JSON.stringify(map));
  const outDir = join(dir, 'out');
  const clock = { t: 0, sleeps: [], now() { return this.t; }, sleep(ms) { this.sleeps.push(ms); this.t += ms; return Promise.resolve(); } };
  const owners = wrap ? routed(world.owners, wrap) : world.owners;
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
      owners,
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
const stillThere = async (world, n) => (await world.fakes.Elmwood.http.get(`/repos/${SOURCE}/issues/${n}`)).json;
const assertGone = (world, n) => assert.rejects(world.fakes.Elmwood.http.get(`/repos/${SOURCE}/issues/${n}`), (e) => e.status === 410 || e.status === 404, `#${n} reads back gone`);
const sharedHome = (map) => { map.projects.inkpress.home = WLPT; map.projects.inkpress.projectOwner = 'brightcraft'; };

test('U R2-1 delete refuses when the map names another source than the record and deletes nothing anywhere', async (t) => {
  const s = await setup(t);
  await applied(s);
  await verifiedOk(s);
  await cp10(s);
  const map = JSON.parse(await readFile(s.mapPath, 'utf8'));
  map.source = 'Elmwood/elsewhere'; // same owner, so validateMap passes and only the record check can refuse
  await writeFile(s.mapPath, JSON.stringify(map));
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.ok(d.errs.join('\n').includes(`The map moves from Elmwood/elsewhere, but migration-record.json was made for ${SOURCE}; nothing was deleted.`), d.errs.join('\n'));
  assert.deepEqual(writesOf(s.world, from), [], 'nothing was written or deleted anywhere');
  for (const n of [1, 3, 6]) assert.equal((await stillThere(s.world, n)).state, 'open', `#${n} is still there`);
  const nums = s.world.fakes.Elmwood.state.projects.map((p) => p.number);
  for (const n of [1, 2, 3, 4]) assert.ok(nums.includes(n), `old Project ${n} is still there`);
});

test('U R2-2 two empty goals that become the same title in a shared home stop apply with the sentence and adopt no marked milestone', async (t) => {
  // The plan keeps the full title of goals whose stripped titles collide, so the collision left is the nested one:
  // A = inkPress, B = BOOK, C = Woodshop, all three moving Projects sharing WLPT as home. "A · Launch" and "B · Launch"
  // both strip to "Launch", so both keep their full titles; "C · A · Launch" strips to "A · Launch", the full title A kept.
  // (The world's own "Woodshop · Launch", holding #1 and #2, is a fourth goal and also keeps its full title.)
  const s = await setup(t, { editMap: (map) => { sharedHome(map); const b = map.projects['bookshelf-planner']; b.home = WLPT; b.projectOwner = 'brightcraft'; map.createRepos = []; } });
  const einher = s.world.fakes.Elmwood;
  for (const title of ['inkPress · Launch', 'BOOK · Launch', 'Woodshop · inkPress · Launch']) {
    einher.direct.request('POST', `/repos/${SOURCE}/milestones`, { title, description: title });
  }
  await planned(s);
  const a = await s.run('apply');
  assert.equal(a.code, 1, a.all.join('\n'));
  assert.ok(a.all.join('\n').includes(`${WLPT} already holds goal "inkPress · Launch" from another original; rename one of them first.`), a.all.join('\n'));
  const launches = (await milestonesOf(s.world, WLPT)).filter((m) => m.title === 'inkPress · Launch');
  assert.equal(launches.length, 1, 'only the first original made the goal; the second did not adopt it');
  const markers = String(launches[0].description || '').split('\n').filter((l) => l.includes('howgozit-migrated-from'));
  assert.equal(markers.length, 1, 'the marked milestone still carries exactly one original\'s marker');
});

test('U R2-3 apply refuses and writes nothing when a moving Project without a moving issue gets another number in the settings after the plan', async (t) => {
  const s = await setup(t, { editMap: (map) => { for (const e of Object.values(map.projects)) e.old.number = null; } });
  // inkpress's only card (#3) leaves Project 2: that Project now holds no moving issue
  const p2 = s.world.fakes.Elmwood.state.projects.find((p) => p.number === 2);
  p2.items.splice(0, p2.items.length);
  // an empty Project with the same title to point the key at, so no card and no other board changes: only the old Project's identity differs
  const spare = s.world.fakes.Elmwood.direct.graphql('mutation { createProjectV2(input: {}) { projectV2 { id } } }', { ownerId: 'O_1', title: 'inkPress' }).createProjectV2.projectV2;
  await planned(s);
  const file = s.world.fakes.Elmwood.state.files['board.config.json'];
  const settings = JSON.parse(file.text);
  for (const p of settings.projects) { if (p.key === 'inkpress') p.number = spare.number; }
  file.text = JSON.stringify(settings, null, 2) + '\n';
  const from = s.world.calls().length;
  const a = await s.run('apply');
  assert.equal(a.code, 1, a.all.join('\n'));
  assert.ok(a.errs.join('\n').includes('The board changed after the plan was made; run plan again.'), a.all.join('\n'));
  assert.deepEqual(writesOf(s.world, from), [], 'zero writes');
});

test('U R2-4 a private book that existed before apply and only the org client can see is used through the org client, and verify passes', async (t) => {
  const blocked = (p) => /\/repos\/brightcraft\/book(\/|\?|$)/i.test(String(p));
  const wrap = (who, http) => {
    if (who !== 'default') return http;
    const check = (p) => { if (blocked(p)) throw new GitHubError('not-found', 404); };
    return {
      get: (p, ...r) => { check(p); return http.get(p, ...r); },
      paged: (p, ...r) => { check(p); return http.paged(p, ...r); },
      send: (m, p, b) => { check(p); return http.send(m, p, b); },
      graphql: (q, v) => http.graphql(q, v),
    };
  };
  const s = await setup(t, { wrap });
  s.world.fakes.brightcraft.direct.request('POST', '/orgs/brightcraft/repos', { name: 'book', private: true });
  await applied(s);
  await copyOf(s.world, BOOK, 6);
  await verifiedOk(s);
});

test('U R2-5 a deleted issue answered as 410 "invalid" is recorded as gone and a re-run of delete finishes', async (t) => {
  let deletes = 0;
  const wrap = (who, http) => {
    const as410 = async (fn) => {
      try { return await fn(); } catch (e) { if (e && e.status === 410) throw new GitHubError('invalid', 410); throw e; }
    };
    return {
      get: (p, ...r) => as410(() => http.get(p, ...r)),
      paged: (p, ...r) => as410(() => http.paged(p, ...r)),
      send: (m, p, b) => as410(() => http.send(m, p, b)),
      graphql: async (q, v) => {
        const res = await as410(() => http.graphql(q, v));
        if (/\bdeleteIssue\b/.test(String(q))) {
          deletes += 1;
          if (deletes === 2) throw new GitHubError('network', 0); // the delete went through, the answer was lost
        }
        return res;
      },
    };
  };
  const s = await setup(t, { wrap });
  await applied(s);
  await verifiedOk(s);
  await cp10(s);
  const first = await s.run('delete', ['--confirm']);
  assert.equal(first.code, 1, first.all.join('\n'));
  const second = await s.run('delete', ['--confirm']);
  assert.equal(second.code, 0, second.all.join('\n'));
  for (const n of [1, 3, 6]) await assertGone(s.world, n);
  assert.equal((await stillThere(s.world, 2)).state, 'closed', 'the closed original is untouched');
  const rec = await readJson(s, 'migration-record.json');
  assert.ok(Array.isArray(rec.deletions) && rec.deletions.length >= 3, 'the deletions are recorded');
});

test('U R2-6 verify fails a pair whose original and copy both left their Projects, naming "no longer planned to move", and delete then refuses', async (t) => {
  const s = await setup(t);
  await applied(s);
  // #6 leaves old Project 3 and its copy leaves the new BOOK Project
  const old = s.world.fakes.Elmwood.state.projects.find((p) => p.number === 3);
  old.items = old.items.filter((it) => it.content.number !== 6);
  const fresh = projectOf(s.world, 'brightcraft', 'BOOK');
  const copy = await copyOf(s.world, BOOK, 6);
  fresh.items = fresh.items.filter((it) => !(it.content.number === copy.number && it.content.repository.full_name === BOOK));
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.ok(v.all.some((l) => l.includes(`${SOURCE}#6`) && l.includes('no longer planned to move')), v.all.join('\n'));
  await s.tick();
  await cp10(s);
  const from = s.world.calls().length;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 1, d.all.join('\n'));
  assert.deepEqual(writesOf(s.world, from), [], 'nothing was deleted');
});

test('U R2-7 a marked copy already on its Project with a Status the source does not have gets the Status cleared, and verify passes', async (t) => {
  let fired = false;
  const wrap = (who, http) => ({
    ...http,
    send: async (m, p, b) => {
      const res = await http.send(m, p, b);
      const hit = /^\/orgs\/inkPress\/projectsV2\/(\d+)\/items$/i.exec(String(p));
      if (!fired && m === 'POST' && hit) {
        fired = true;
        // the copy of #3 is now on the inkPress Project with Status "Done"; the source item has no Status
        const fake = s.world.fakes.inkPress;
        const proj = fake.state.projects.find((x) => x.number === Number(hit[1]));
        const item = proj.items[proj.items.length - 1];
        fake.direct.graphql(MUT, { projectId: proj.node_id, itemId: item.node_id, fieldId: proj.fields.find((f) => f.name === 'Status').node_id, optionId: 'SO_3' });
        assert.equal(item.status, 'Done', 'the stray Status is in place');
      }
      return res;
    },
  });
  const s = await setup(t, { wrap });
  // the fake gives every item Status "Todo"; make the source item of #3 truly have none
  const oldItem = s.world.fakes.Elmwood.state.projects.find((p) => p.number === 2).items.find((it) => it.content.number === 3);
  oldItem.status = null;
  await applied(s);
  assert.ok(fired, 'the copy was added to the inkPress Project');
  const copy = await copyOf(s.world, IN2, 3);
  const item = itemOf(projectOf(s.world, 'inkPress', 'inkPress'), IN2, copy.number);
  assert.ok(item, 'the copy is on the new Project');
  assert.ok(!item.status, `Status was cleared (is ${JSON.stringify(item.status)})`);
  await verifiedOk(s);
});
