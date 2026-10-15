// CP8 rework: one test per cross-family review finding (F1 to F11 and F13; F12 is the plan note), written from the TEXT of
// reference/mapping-redesign/cp8-interface.md section 10 (with 4 and 5 for context). No contract rule covers the migration, so every name starts "U ".
// Everything goes through main(); where the fake lacks a door (an answer lost after a write, a client that cannot see a repo)
// a small wrapper inside this file stands in front of the fake's client. The fake itself is never edited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/migrate.mjs';
import { createMigrateWorld } from '../fixtures/migrate-world.mjs';
import { GitHubError } from '../board/github/http.mjs';

const TOKEN = 'ghp_' + 'b'.repeat(36);
const SOURCE = 'Elmwood/howgozit';
const WLPT = 'brightcraft/blastworks-Woodshop';
const BOOK = 'brightcraft/book';
const IN2 = 'inkPress/inkPress';
const ownerOf = (repo) => repo.split('/')[0];
const FROM = (n) => `<!-- howgozit-migrated-from: ${SOURCE}#${n} -->`;
const FUTURE = '2099-01-01T00:00:00.000Z';
const realPause = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// wrap(who, http) -> http, applied to the default client (who 'default') and to every owner's client (who = lower-cased login)
function routed(owners, wrap) {
  return {
    default: wrap('default', owners.default),
    forOwner: (login) => wrap(String(login).toLowerCase(), owners.forOwner(login)),
  };
}

async function setup(t, { editMap, wrap } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-review-'));
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
  return { dir, world, outDir, clock, run, tick };
}

const planned = async (s) => { const p = await s.run('plan'); assert.equal(p.code, 0, p.all.join('\n')); return p; };
const applied = async (s) => { await planned(s); const a = await s.run('apply'); assert.equal(a.code, 0, a.all.join('\n')); return a; };
const verifiedOk = async (s) => { await s.tick(); const v = await s.run('verify'); assert.equal(v.code, 0, v.all.join('\n')); await s.tick(); return v; };
const cp10 = (s) => writeFile(join(s.outDir, 'cp10-pass.json'),
  JSON.stringify({ cp: 'CP10', pass: true, at: FUTURE, by: 'ClaudeBWAI', board: SOURCE, evidence: 'test' }));

const writesOf = (world, from = 0) => world.calls().slice(from).filter((c) => c.method !== 'GET');
const list = async (world, repo, path) => (await world.fakes[ownerOf(repo)].http.paged(`/repos/${repo}${path}`)).items;
const issuesOf = (world, repo) => list(world, repo, '/issues?state=all&per_page=100');
const commentsOf = (world, repo, n) => list(world, repo, `/issues/${n}/comments?per_page=100`);
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
const assertGone = (world, n) => assert.rejects(world.fakes.Elmwood.http.get(`/repos/${SOURCE}/issues/${n}`), (e) => e.status === 410, `#${n} reads back 410`);

// inkpress shares Woodshop's home, and #1 sits on both old boards with its own Due on each (F7, F8)
const sharedHome = (map) => { map.projects.inkpress.home = WLPT; map.projects.inkpress.projectOwner = 'brightcraft'; };
function secondBoard(world, due) {
  const einher = world.fakes.Elmwood;
  einher.direct.request('POST', '/users/Elmwood/projectsV2/2/items', { type: 'Issue', owner: 'Elmwood', repo: 'howgozit', number: 1 });
  setSourceItem(world, 2, 1, { date: due });
}
function setSourceItem(world, projectNumber, issueNumber, value) {
  const einher = world.fakes.Elmwood;
  const p = einher.state.projects.find((x) => x.number === projectNumber);
  const item = p.items.find((it) => it.content.number === issueNumber);
  const field = p.fields.find((f) => f.name === ('date' in value ? 'Due' : 'Status'));
  einher.direct.graphql('mutation { updateProjectV2ItemFieldValue(input: {}) { projectV2Item { id } } }',
    { projectId: p.node_id, itemId: item.node_id, fieldId: field.node_id, ...value });
}

test('U F1 a recorded copy whose repository the fresh plan changed stops apply with the sentence and writes into neither repository', async (t) => {
  const s = await setup(t);
  await planned(s);
  // apply fails on the first comment on an original: every copy already exists and is recorded
  s.world.fakes.Elmwood.fail((c) => c.method === 'POST' && /\/repos\/Elmwood\/howgozit\/issues\/\d+\/comments$/.test(c.path), new GitHubError('server', 502));
  const half = await s.run('apply');
  assert.equal(half.code, 1, half.all.join('\n'));
  await copyOf(s.world, WLPT, 1);
  // the map now sends Woodshop's cards to book
  const mapPath = join(s.dir, 'map.json');
  const map = JSON.parse(await readFile(mapPath, 'utf8'));
  map.projects.woodshop.home = BOOK;
  await writeFile(mapPath, JSON.stringify(map));
  const replan = await s.run('plan');
  assert.equal(replan.code, 0, replan.all.join('\n'));
  const from = s.world.calls().length;
  const again = await s.run('apply');
  assert.equal(again.code, 1, again.all.join('\n'));
  const text = again.all.join('\n');
  assert.ok(text.includes(`${SOURCE}#1 was copied to ${WLPT} but the plan now sends it to ${BOOK}; move or remove the copy by hand first.`), text);
  const into = writesOf(s.world, from).filter((c) => c.path.includes(`/repos/${WLPT}`) || c.path.includes(`/repos/${BOOK}`));
  assert.deepEqual(into, [], 'nothing is written into either repository');
});

test('U F2 delete takes the Projects to delete from the record, not from a settings file that was replaced by board.config.next.json', async (t) => {
  // numbers null as committed (D2): plan fills them from the settings
  const s = await setup(t, { editMap: (map) => { for (const e of Object.values(map.projects)) e.old.number = null; } });
  await applied(s);
  await verifiedOk(s);
  await cp10(s);
  const rec = await readJson(s, 'migration-record.json');
  assert.ok(Array.isArray(rec.oldProjects) && rec.oldProjects.length >= 3, 'apply records the old Projects it will leave behind');
  const next = await readFile(join(s.outDir, 'board.config.next.json'), 'utf8');
  s.world.fakes.Elmwood.state.files['board.config.json'].text = next;
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 0, d.all.join('\n'));
  const nums = s.world.fakes.Elmwood.state.projects.map((p) => p.number).sort((a, b) => a - b);
  for (const gone of [1, 2, 3]) assert.ok(!nums.includes(gone), `old Project ${gone} is gone (left: ${nums})`);
  for (const kept of [4, 5, 6]) assert.ok(nums.includes(kept), `Project ${kept} is untouched (left: ${nums})`);
  assert.deepEqual(s.world.fakes.brightcraft.state.projects.map((p) => p.title).sort(), ['BOOK', 'Woodshop'], 'no new Project is touched');
  assert.deepEqual(s.world.fakes.inkPress.state.projects.map((p) => p.title), ['inkPress']);
});

test('U F3 verify fails for a pair whose original was closed after the copy, naming that pair', async (t) => {
  const s = await setup(t);
  await applied(s);
  s.world.fakes.Elmwood.direct.request('PATCH', `/repos/${SOURCE}/issues/1`, { state: 'closed' });
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.ok(v.lines.some((l) => l.includes(`${SOURCE}#1`) && /DIFFERENT/.test(l) && /original closed after the copy/.test(l)), v.lines.join('\n'));
  // §12 R3-1: closing #1 leaves its goal holding only a closed card, so the fresh plan keeps that goal as history and verify names it too.
  assert.ok(v.lines.some((l) => /milestone 1 /.test(l) && /DIFFERENT/.test(l) && /no longer planned to move/.test(l)), v.lines.join('\n'));
  assert.ok(v.lines.some((l) => /^Verify: 4 pairs, 2 different\.$/.test(l)), v.lines.join('\n'));
  assert.equal((await readJson(s, 'verify-record.json')).pass, false);
});

test('U F3 delete keeps an original that was closed after verify and lists it as kept', async (t) => {
  const s = await setup(t);
  await applied(s);
  await verifiedOk(s);
  await cp10(s);
  s.world.fakes.Elmwood.direct.request('PATCH', `/repos/${SOURCE}/issues/1`, { state: 'closed' });
  const d = await s.run('delete', ['--confirm']);
  assert.equal(d.code, 0, d.all.join('\n'));
  const one = await s.world.fakes.Elmwood.http.get(`/repos/${SOURCE}/issues/1`);
  assert.equal(one.json.state, 'closed', 'the closed original is still there');
  for (const n of [3, 6]) await assertGone(s.world, n);
  assert.ok(d.lines.some((l) => l.includes('#1') && /keep|kept/i.test(l)), d.lines.join('\n'));
});

test('U F4 verify reads the copies in a repository apply created through the default client when the owner client cannot see it', async (t) => {
  const blind = (http) => {
    const check = (p) => { if (/\/repos\/brightcraft\/book(\/|\?|$)/i.test(String(p))) throw new GitHubError('not-found', 404); };
    return {
      get: (p, ...r) => { check(p); return http.get(p, ...r); },
      paged: (p, ...r) => { check(p); return http.paged(p, ...r); },
      send: (m, p, b) => { check(p); return http.send(m, p, b); },
      graphql: (q, v) => http.graphql(q, v),
    };
  };
  const s = await setup(t, { wrap: (who, http) => (who === 'brightcraft' ? blind(http) : http) });
  await applied(s);
  await copyOf(s.world, BOOK, 6);
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 0, v.all.join('\n'));
  assert.ok(v.lines.some((l) => /^Verify: 3 pairs, 0 different\.$/.test(l)), v.lines.join('\n'));
});

test('U F5 a 422 on a Project add whose message does not say "already" still leads to the items lookup and apply goes on', async (t) => {
  let fired = false;
  const wrap = (who, http) => ({
    ...http,
    send: async (m, p, b) => {
      if (!fired && m === 'POST' && /\/orgs\/[^/]+\/projectsV2\/\d+\/items$/.test(p)) {
        fired = true;
        await http.send(m, p, b); // GitHub took the add ...
        throw new GitHubError('invalid', 422); // ... and answered 422 with no body text the client keeps
      }
      return http.send(m, p, b);
    },
  });
  const s = await setup(t, { wrap });
  await applied(s);
  assert.ok(fired, 'the 422 was met');
  const copy = await copyOf(s.world, WLPT, 1);
  const item = itemOf(projectOf(s.world, 'brightcraft', 'Woodshop'), WLPT, copy.number);
  assert.ok(item, 'the copy is on the new Project');
  assert.equal(item.status, 'In Progress', 'Status was written after the lookup');
  assert.equal(item.due, '2026-11-01', 'Due was written after the lookup');
});

test('U F6 a copy GitHub accepted but whose answer was lost, and which the listing shows late, is not made twice', async (t) => {
  let lost = false;
  let hideLeft = 0;
  const isList = (p) => /\/repos\/brightcraft\/blastworks-woodshop\/issues(\?|$)/i.test(String(p));
  const hide = (items) => (hideLeft > 0 ? (hideLeft -= 1, items.filter((i) => !endsWith(i, FROM(1)))) : items);
  const wrap = (who, http) => ({
    graphql: http.graphql,
    get: async (p, ...r) => {
      const res = await http.get(p, ...r);
      return lost && isList(p) && Array.isArray(res.json) ? { ...res, json: hide(res.json) } : res;
    },
    paged: async (p, ...r) => {
      const res = await http.paged(p, ...r);
      return lost && isList(p) ? { ...res, items: hide(res.items) } : res;
    },
    send: async (m, p, b) => {
      if (!lost && m === 'POST' && /\/repos\/brightcraft\/blastworks-woodshop\/issues$/i.test(String(p))) {
        lost = true;
        hideLeft = 2; // the first two listings after the loss do not show the new issue yet
        await http.send(m, p, b);
        throw new GitHubError('network', 0);
      }
      return http.send(m, p, b);
    },
  });
  const s = await setup(t, { wrap });
  await planned(s);
  const first = await s.run('apply');
  assert.equal(first.code, 1, first.all.join('\n'));
  const slept = s.clock.sleeps.length;
  const second = await s.run('apply');
  assert.equal(second.code, 0, second.all.join('\n'));
  await copyOf(s.world, WLPT, 1); // exactly one
  assert.ok(s.clock.sleeps.slice(slept).includes(5000), `the re-run waited 5 s before creating again: ${s.clock.sleeps.slice(slept)}`);
  const record = await readJson(s, 'migration-record.json');
  assert.equal(record.done, true);
});

test('U F7 an issue on two moving boards with the same home gives each new Project its own Due, verify passes, and a changed Due fails it', async (t) => {
  const s = await setup(t, { editMap: sharedHome });
  secondBoard(s.world, '2026-12-05');
  await applied(s);
  const copy = await copyOf(s.world, WLPT, 1);
  const first = itemOf(projectOf(s.world, 'brightcraft', 'Woodshop'), WLPT, copy.number);
  const second = itemOf(projectOf(s.world, 'brightcraft', 'inkPress'), WLPT, copy.number);
  assert.ok(first && second, 'the copy sits on both new Projects');
  assert.equal(first.due, '2026-11-01');
  assert.equal(second.due, '2026-12-05');
  assert.equal(first.status, 'In Progress');
  await verifiedOk(s);
  // change one Due on GitHub
  const p = projectOf(s.world, 'brightcraft', 'inkPress');
  s.world.fakes.brightcraft.direct.graphql('mutation { updateProjectV2ItemFieldValue(input: {}) { projectV2Item { id } } }',
    { projectId: p.node_id, itemId: second.node_id, fieldId: p.fields.find((f) => f.name === 'Due').node_id, date: '2027-01-02' });
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.ok(v.lines.some((l) => /DIFFERENT/.test(l) && /due/i.test(l)), v.lines.join('\n'));
});

test('U F8 apply refuses when the Status on the second board changed after the plan (the digest covers every board)', async (t) => {
  const s = await setup(t, { editMap: sharedHome });
  secondBoard(s.world, '2026-12-05');
  await planned(s);
  setSourceItem(s.world, 2, 1, { status: 'Done' });
  const from = s.world.calls().length;
  const a = await s.run('apply');
  assert.equal(a.code, 1, a.all.join('\n'));
  assert.ok(a.errs.length > 0, 'a plain sentence says why');
  assert.deepEqual(writesOf(s.world, from), [], 'nothing was written');
});

test('U F9 a target milestone that already exists, open and without our marker, stays untouched when the source goal is closed, and verify passes', async (t) => {
  const s = await setup(t);
  s.world.fakes.Elmwood.direct.request('PATCH', `/repos/${SOURCE}/milestones/1`, { state: 'closed' });
  const pre = s.world.fakes.brightcraft.direct.request('POST', `/repos/${WLPT}/milestones`, { title: 'Launch' });
  await applied(s);
  const launch = (await milestonesOf(s.world, WLPT)).filter((m) => m.title === 'Launch');
  assert.equal(launch.length, 1, 'no second Launch');
  assert.equal(launch[0].number, pre.number);
  assert.equal(launch[0].state, 'open', 'the adopted milestone is never changed');
  assert.ok(!String(launch[0].description || '').includes('howgozit-migrated-from'), 'no marker is written into it');
  const copy = await copyOf(s.world, WLPT, 1);
  assert.equal(copy.milestone && copy.milestone.number, pre.number, 'the copy sits in the adopted milestone');
  await verifiedOk(s);
});

test('U F10 verify fails when the Score field on the Habits Project is not a number field', async (t) => {
  const s = await setup(t);
  await applied(s);
  const score = projectOf(s.world, 'Elmwood', 'Habits').fields.find((f) => f.name === 'Score');
  assert.equal(score.data_type, 'number', 'apply made it a number field');
  score.data_type = 'text';
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
  assert.equal((await readJson(s, 'verify-record.json')).pass, false);
});

test('U F10 verify fails when the Due field of a new Project is not a date field', async (t) => {
  const s = await setup(t);
  await applied(s);
  const due = projectOf(s.world, 'brightcraft', 'Woodshop').fields.find((f) => f.name === 'Due');
  assert.equal(due.data_type, 'date', 'apply made it a date field');
  due.data_type = 'text';
  await s.tick();
  const v = await s.run('verify');
  assert.equal(v.code, 1, v.all.join('\n'));
});

test('U F11 an original comment that quotes the copy marker in its middle is copied and counted', async (t) => {
  const s = await setup(t);
  const body = 'Quoting the marker below.\n<!-- howgozit-comment: 1 -->\nThat was only a quote.';
  s.world.fakes.Elmwood.seedComment(SOURCE, 1, { login: 'Elmwood', body, created_at: '2026-10-04T08:00:00Z' });
  await applied(s);
  const originals = (await commentsOf(s.world, SOURCE, 1)).filter((c) => !/howgozit-copied-to/.test(c.body));
  assert.equal(originals.length, 3);
  const copy = await copyOf(s.world, WLPT, 1);
  const got = await commentsOf(s.world, WLPT, copy.number);
  assert.equal(got.length, 4, got.map((c) => c.body).join('\n---\n'));
  assert.equal(got[2].body, `Elmwood wrote on 2026-10-04:\n\n${body}\n\n<!-- howgozit-comment: ${originals[2].id} -->`);
  await verifiedOk(s);
});

test('U F12 a map key that the settings do not hold gets the plan note', async (t) => {
  const s = await setup(t);
  const file = s.world.fakes.Elmwood.state.files['board.config.json'];
  const settings = JSON.parse(file.text);
  settings.projects = settings.projects.filter((p) => p.key !== 'inkpress');
  file.text = JSON.stringify(settings, null, 2) + '\n';
  const p = await s.run('plan', ['--json']);
  const plan = JSON.parse(p.lines.join('\n'));
  assert.ok(JSON.stringify(plan.notes).includes('inkpress is not in your settings, so its Project is not read.'), JSON.stringify(plan.notes));
});

test('U F13 an empty goal titled exactly like a moving project moves with its title unchanged', async (t) => {
  const s = await setup(t);
  const made = s.world.fakes.Elmwood.direct.request('POST', `/repos/${SOURCE}/milestones`, { title: 'Woodshop', description: 'plain goal' });
  await applied(s);
  const moved = (await milestonesOf(s.world, WLPT)).find((m) => m.title === 'Woodshop');
  assert.ok(moved, `a goal titled Woodshop in ${WLPT}: ${(await milestonesOf(s.world, WLPT)).map((m) => m.title)}`);
  assert.equal(String(moved.description).split('\n').pop(), `<!-- howgozit-migrated-from: ${SOURCE} milestone ${made.number} -->`);
});
