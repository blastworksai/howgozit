// CP8 J5: the migration's `apply` command, written from reference/mapping-redesign/cp8-interface.md (sections 4, 5 and 6) alone.
// No contract rule covers the migration, so every name starts "U ".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/migrate.mjs';
import { createMigrateWorld } from '../fixtures/migrate-world.mjs';
import { checkSettings } from '../board/shape-settings.mjs';
import { GitHubError } from '../board/github/http.mjs';

const TOKEN = 'ghp_' + 'a'.repeat(36);
const SOURCE = 'Elmwood/howgozit';
const WLPT = 'brightcraft/blastworks-Woodshop';
const BOOK = 'brightcraft/book';
const IN2 = 'inkPress/inkPress';
const ownerOf = (repo) => repo.split('/')[0];
const FROM = (n) => `<!-- howgozit-migrated-from: ${SOURCE}#${n} -->`;

// owners whose clients note the clock at every write (anything but get/paged), so pacing can be read back
function stampedOwners(owners, clock, stamps) {
  const wrap = (http) => new Proxy(http, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      if (prop === 'get' || prop === 'paged') return v.bind(target);
      return (...a) => { stamps.push(clock.t); return v.apply(target, a); };
    },
  });
  return { default: wrap(owners.default), forOwner: (login) => wrap(owners.forOwner(login)) };
}

async function setup(t, worldOpts) {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-apply-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const world = createMigrateWorld(worldOpts);
  const mapPath = join(dir, 'map.json');
  await writeFile(mapPath, JSON.stringify(world.map));
  const outDir = join(dir, 'out');
  const clock = { t: 0, sleeps: [], now() { return this.t; }, sleep(ms) { this.sleeps.push(ms); this.t += ms; return Promise.resolve(); } };
  const stamps = [];
  const owners = stampedOwners(world.owners, clock, stamps);
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
      owners,
    });
    return { code, lines, errs, all: [...lines, ...errs] };
  }
  return { dir, world, outDir, clock, stamps, run };
}

// plan, then apply, both expected to succeed
async function cold(t) {
  const s = await setup(t);
  const p = await s.run('plan');
  assert.equal(p.code, 0, p.errs.join('\n'));
  const a = await s.run('apply');
  assert.equal(a.code, 0, a.all.join('\n'));
  return s;
}

const writesOf = (world, from = 0) => world.calls().slice(from).filter((c) => c.method !== 'GET');
const exists = async (p) => stat(p).then(() => true, () => false);
const list = async (world, repo, path) => (await world.fakes[ownerOf(repo)].http.paged(`/repos/${repo}${path}`)).items;
const issuesOf = (world, repo) => list(world, repo, '/issues?state=all&per_page=100');
const commentsOf = (world, repo, n) => list(world, repo, `/issues/${n}/comments?per_page=100`);
const milestonesOf = (world, repo) => list(world, repo, '/milestones?state=all&per_page=100');
const labelsOf = (world, repo) => list(world, repo, '/labels?per_page=100');
const repoOf = async (world, repo) => (await world.fakes[ownerOf(repo)].http.get(`/repos/${repo}`)).json;
const projectOf = (world, owner, title) => world.fakes[owner].state.projects.find((p) => p.title === title);
const itemOf = (project, repo, n) => project.items.find((it) => it.content.number === n && it.content.repository.full_name === repo);
const endsWith = (issue, marker) => String(issue.body || '').split('\n').pop() === marker;

async function copyOf(world, repo, oldN) {
  const hits = (await issuesOf(world, repo)).filter((i) => endsWith(i, FROM(oldN)));
  assert.equal(hits.length, 1, `${repo} should hold exactly one copy of #${oldN}, found ${hits.length}`);
  return hits[0];
}

// everything the three fakes hold, with times removed, for comparing two end states
async function snapshot(world) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/_at$/.test(k)).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  const out = {};
  for (const [owner, fake] of Object.entries(world.fakes)) out[owner] = strip(JSON.parse(JSON.stringify(fake.state)));
  out.comments = {};
  for (const repo of [SOURCE, WLPT, BOOK, IN2]) {
    let issues = [];
    try { issues = await issuesOf(world, repo); } catch { continue; }
    for (const i of issues) out.comments[`${repo}#${i.number}`] = strip(await commentsOf(world, repo, i.number));
  }
  return out;
}

test('U apply cold start copies #1 into the Woodshop repo with its marker, labels, goal and open state', async (t) => {
  const s = await cold(t);
  const orig = (await issuesOf(s.world, SOURCE)).find((i) => i.number === 1);
  const copy = await copyOf(s.world, WLPT, 1);
  assert.equal(copy.title, orig.title);
  assert.equal(copy.body, `${orig.body}\n\n${FROM(1)}`);
  assert.ok(copy.labels.some((l) => l.name.toLowerCase() === 'do'), JSON.stringify(copy.labels));
  assert.equal(copy.milestone && copy.milestone.title, 'Launch');
  assert.equal(copy.state, 'open');
  assert.equal(orig.state, 'open', 'the original is left in place');
});

test('U apply cold start copies the two comments of #1 with headers, then the link comment', async (t) => {
  const s = await cold(t);
  const origComments = (await commentsOf(s.world, SOURCE, 1)).filter((c) => !/howgozit-copied-to/.test(c.body));
  assert.equal(origComments.length, 2);
  const copy = await copyOf(s.world, WLPT, 1);
  const got = await commentsOf(s.world, WLPT, copy.number);
  assert.equal(got.length, 3, got.map((c) => c.body).join('\n---\n'));
  origComments.forEach((c, i) => {
    const login = (c.user && c.user.login) || 'ghost';
    const date = new Date(c.created_at).toISOString().slice(0, 10);
    assert.equal(got[i].body, `${login} wrote on ${date}:\n\n${c.body}\n\n<!-- howgozit-comment: ${c.id} -->`);
  });
  assert.equal(got[2].body, `Copied from https://github.com/${SOURCE}/issues/1.\n\n<!-- howgozit-link-to-original -->`);
});

test('U apply cold start puts the copy of #1 on the new Woodshop Project with Status In Progress and its Due date', async (t) => {
  const s = await cold(t);
  const copy = await copyOf(s.world, WLPT, 1);
  const p = projectOf(s.world, 'brightcraft', 'Woodshop');
  assert.ok(p, 'the Woodshop Project exists under brightcraft');
  const item = itemOf(p, WLPT, copy.number);
  assert.ok(item, 'the copy is an item of the new Project');
  assert.equal(item.status, 'In Progress');
  assert.equal(item.due, '2026-11-01');
});

test('U apply cold start creates the org Projects with a Due field, linked to their home repositories', async (t) => {
  const s = await cold(t);
  for (const [owner, title, home] of [['brightcraft', 'Woodshop', WLPT], ['brightcraft', 'BOOK', BOOK], ['inkPress', 'inkPress', IN2]]) {
    const p = projectOf(s.world, owner, title);
    assert.ok(p, `Project "${title}" under ${owner}`);
    const due = p.fields.find((f) => f.name === 'Due');
    assert.ok(due && due.data_type === 'date', `Project "${title}" has a Due date field`);
    const repo = await repoOf(s.world, home);
    assert.ok(p.repositories.includes(repo.node_id), `Project "${title}" is linked to ${home}`);
  }
  assert.equal(projectOf(s.world, 'Elmwood', 'Road').items.length, 1, 'the staying Project keeps its one card');
});

test('U apply cold start creates brightcraft/book private and copies #6 into it', async (t) => {
  const s = await cold(t);
  const repo = await repoOf(s.world, BOOK);
  assert.equal(repo.private, true);
  const create = s.world.calls().find((c) => c.method === 'POST' && /\/orgs\/brightcraft\/repos$/.test(c.path));
  assert.ok(create, 'a POST to the org repos route');
  assert.equal(create.body.name, 'book');
  assert.equal(create.body.private, true);
  await copyOf(s.world, BOOK, 6);
});

test('U apply cold start holds #4 in the new Ideas Project and gives Habits a number field Score', async (t) => {
  const s = await cold(t);
  const ideas = projectOf(s.world, 'Elmwood', 'Ideas');
  assert.ok(ideas, 'Ideas Project under Elmwood');
  assert.ok(itemOf(ideas, SOURCE, 4), '#4 is an item of Ideas');
  assert.equal((await issuesOf(s.world, SOURCE)).find((i) => i.number === 4).state, 'open');
  const habits = projectOf(s.world, 'Elmwood', 'Habits');
  assert.ok(habits, 'Habits Project under Elmwood');
  const score = habits.fields.find((f) => f.name === 'Score');
  assert.ok(score && score.data_type === 'number');
});

test('U apply cold start copies #3 into inkPress/inkPress with no milestone, on the inkPress Project', async (t) => {
  const s = await cold(t);
  const copy = await copyOf(s.world, IN2, 3);
  assert.equal(copy.milestone ?? null, null);
  const p = projectOf(s.world, 'inkPress', 'inkPress');
  assert.ok(itemOf(p, IN2, copy.number));
});

test('U apply cold start copies the goals with the prefix stripped, the marker, the due date and "Pilot" into inkPress/inkPress', async (t) => {
  const s = await cold(t);
  const src = await milestonesOf(s.world, SOURCE);
  const launch = src.find((m) => m.title === 'Woodshop · Launch');
  const pilot = src.find((m) => m.title === 'inkPress · Pilot');
  assert.ok(launch && pilot, 'the source still holds its goals');
  const l = (await milestonesOf(s.world, WLPT)).find((m) => m.title === 'Launch');
  assert.ok(l, 'Launch in the Woodshop repo');
  assert.equal(l.due_on, launch.due_on);
  assert.equal(String(l.description).split('\n').pop(), `<!-- howgozit-migrated-from: ${SOURCE} milestone ${launch.number} -->`);
  const p = (await milestonesOf(s.world, IN2)).find((m) => m.title === 'Pilot');
  assert.ok(p, 'Pilot in inkPress/inkPress');
  assert.equal(String(p.description).split('\n').pop(), `<!-- howgozit-migrated-from: ${SOURCE} milestone ${pilot.number} -->`);
});

test('U apply cold start leaves "Someday" in the source and copies no milestone with that name', async (t) => {
  const s = await cold(t);
  assert.ok((await milestonesOf(s.world, SOURCE)).some((m) => m.title === 'Someday'));
  for (const repo of [WLPT, BOOK, IN2]) assert.ok(!(await milestonesOf(s.world, repo)).some((m) => m.title === 'Someday'), repo);
});

test('U apply cold start creates the four mode labels in a home repo that receives a copy', async (t) => {
  const s = await cold(t);
  const names = (await labelsOf(s.world, WLPT)).map((l) => l.name.toUpperCase());
  for (const mode of ['DO', 'THINK', 'REVIEW', 'LAUNCH']) assert.ok(names.includes(mode), `${mode} in ${names.join(',')}`);
});

test('U apply cold start comments on each moved original and on nothing that stays', async (t) => {
  const s = await setup(t);
  const before = {};
  for (const n of [1, 2, 3, 4, 5, 6]) before[n] = (await commentsOf(s.world, SOURCE, n)).length;
  assert.equal((await s.run('plan')).code, 0);
  const a = await s.run('apply');
  assert.equal(a.code, 0, a.all.join('\n'));
  for (const [n, repo] of [[1, WLPT], [3, IN2], [6, BOOK]]) {
    const copy = await copyOf(s.world, repo, n);
    const got = await commentsOf(s.world, SOURCE, n);
    assert.equal(got.length, before[n] + 1, `#${n}`);
    const last = got[got.length - 1].body;
    assert.ok(last.startsWith(`Moved to https://github.com/${repo}/issues/${copy.number}.`), last);
    assert.equal(last.split('\n').pop(), `<!-- howgozit-copied-to: ${repo}#${copy.number} -->`);
  }
  for (const n of [2, 4, 5]) assert.equal((await commentsOf(s.world, SOURCE, n)).length, before[n], `#${n} stays untouched`);
});

test('U apply cold start keeps closed #2 in the source with no copy anywhere', async (t) => {
  const s = await cold(t);
  const two = (await issuesOf(s.world, SOURCE)).find((i) => i.number === 2);
  assert.equal(two.state, 'closed');
  for (const repo of [WLPT, BOOK, IN2]) assert.ok(!(await issuesOf(s.world, repo)).some((i) => endsWith(i, FROM(2))), repo);
  const p = projectOf(s.world, 'brightcraft', 'Woodshop');
  assert.equal(p.items.length, 1, 'only the open card #1 is on the new Woodshop Project');
});

test('U apply cold start works in the order repositories, Projects, labels, milestones, copies, comments on originals', async (t) => {
  const s = await cold(t);
  const calls = s.world.calls();
  const idx = (pred) => calls.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);
  const repos = idx((c) => c.method === 'POST' && /\/repos$/.test(c.path));
  const projects = idx((c) => c.method === 'GRAPHQL' && c.path === 'createProjectV2');
  const labels = idx((c) => c.method === 'POST' && /\/labels$/.test(c.path));
  const milestones = idx((c) => ['POST', 'PATCH'].includes(c.method) && /\/milestones(\/\d+)?$/.test(c.path));
  const copies = idx((c) => c.method === 'POST' && /\/issues$/.test(c.path));
  const originals = idx((c) => c.method === 'POST' && c.path.includes(`/repos/${SOURCE}/issues/`) && /\/comments$/.test(c.path));
  for (const [name, a] of Object.entries({ repos, projects, labels, milestones, copies, originals })) assert.ok(a.length > 0, `no ${name} written`);
  const last = (a) => a[a.length - 1];
  assert.ok(last(repos) < projects[0], 'repositories before Projects');
  assert.ok(last(projects) < labels[0], 'Projects before labels');
  assert.ok(last(labels) < milestones[0], 'labels before milestones');
  assert.ok(last(milestones) < copies[0], 'milestones before copies');
  assert.ok(last(copies) < originals[0], 'copies before comments on the originals');
  assert.ok(await exists(join(s.outDir, 'migration-record.json')));
});

test('U apply writes board.config.next.json that passes checkSettings and names the new Projects', async (t) => {
  const s = await cold(t);
  const next = JSON.parse(await readFile(join(s.outDir, 'board.config.next.json'), 'utf8'));
  const checked = checkSettings(next);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.ok(Array.isArray(next.projects), 'projects is an array');
  const byKey = (key) => next.projects.find((p) => p.key === key);
  const wl = byKey('woodshop');
  assert.ok(wl, 'woodshop is carried');
  assert.equal(wl.owner, 'brightcraft');
  assert.equal(wl.home, WLPT);
  assert.equal(wl.number, projectOf(s.world, 'brightcraft', 'Woodshop').number);
  assert.ok(byKey('inkpress'), 'inkpress is carried');
  assert.equal(byKey('inkpress').owner, 'inkPress');
  assert.equal(byKey('inkpress').home, IN2);
  assert.deepEqual(next.modes, ['DO', 'THINK', 'REVIEW', 'LAUNCH']);
  assert.equal(next.ideas.owner, 'Elmwood');
  assert.equal(next.ideas.number, projectOf(s.world, 'Elmwood', 'Ideas').number);
  assert.equal(next.habitsProject.number, projectOf(s.world, 'Elmwood', 'Habits').number);
});

test('U apply makes no contents PUT anywhere and writes no file into any repository', async (t) => {
  const s = await cold(t);
  assert.deepEqual(s.world.calls().filter((c) => c.method === 'PUT' && /\/contents\//.test(c.path)), []);
  assert.ok(!Object.keys(s.world.fakes.brightcraft.state.files || {}).some((f) => f.includes('board.config')), 'no settings file lands in a target repo');
});

test('U apply refuses to run without plan.json, exits 1 and writes nothing', async (t) => {
  const s = await setup(t);
  const a = await s.run('apply');
  assert.equal(a.code, 1);
  assert.ok(a.errs.length > 0, 'a plain sentence says why');
  assert.equal(writesOf(s.world).length, 0);
  assert.equal(await exists(join(s.outDir, 'migration-record.json')), false);
});

test('U apply refuses when the source changed after the plan was made', async (t) => {
  const s = await setup(t);
  assert.equal((await s.run('plan')).code, 0);
  await s.world.fakes.Elmwood.http.send('PATCH', `/repos/${SOURCE}/issues/1`, { title: 'A title changed after the plan' });
  const from = s.world.calls().length;
  const a = await s.run('apply');
  assert.equal(a.code, 1);
  assert.equal(writesOf(s.world, from).length, 0);
});

test('U apply resumes after a failed 5th write with no duplicate and the same end state as a cold run', async (t) => {
  const reference = await cold(t);
  const expected = await snapshot(reference.world);

  const s = await setup(t);
  assert.equal((await s.run('plan')).code, 0);
  let count = 0;
  for (const fake of Object.values(s.world.fakes)) fake.fail((call) => call.method !== 'GET' && ++count === 5, new GitHubError('server', 502));
  const first = await s.run('apply');
  assert.equal(first.code, 1, first.all.join('\n'));
  assert.ok(await exists(join(s.outDir, 'migration-record.json')), 'the record holds what was done');
  const writtenBefore = writesOf(s.world).length;
  assert.ok(writtenBefore >= 5);

  const second = await s.run('apply');
  assert.equal(second.code, 0, second.all.join('\n'));
  for (const [repo, n] of [[WLPT, 1], [IN2, 3], [BOOK, 6]]) await copyOf(s.world, repo, n);
  assert.deepEqual(await snapshot(s.world), expected);
  assert.ok(await exists(join(s.outDir, 'board.config.next.json')));
});

test('U apply adopts an issue already copied with its marker but not in the record, with no second POST', async (t) => {
  const s = await setup(t);
  const orig = (await issuesOf(s.world, SOURCE)).find((i) => i.number === 1);
  const made = await s.world.fakes.brightcraft.http.send('POST', `/repos/${WLPT}/issues`, { title: orig.title, body: `${orig.body}\n\n${FROM(1)}` });
  assert.ok(made.number, 'the pre-made copy exists');
  assert.equal((await s.run('plan')).code, 0);
  const from = s.world.calls().length;
  const a = await s.run('apply');
  assert.equal(a.code, 0, a.all.join('\n'));
  const posts = s.world.calls().slice(from).filter((c) => c.method === 'POST' && new RegExp(`/repos/${WLPT}/issues$`).test(c.path));
  assert.equal(posts.length, 0, 'no second copy is posted');
  const copy = await copyOf(s.world, WLPT, 1);
  assert.equal(copy.number, made.number);
  const comments = await commentsOf(s.world, WLPT, copy.number);
  assert.ok(comments.some((c) => c.body.includes('<!-- howgozit-link-to-original -->')), 'the adopted copy still gets its link comment');
  const record = JSON.parse(await readFile(join(s.outDir, 'migration-record.json'), 'utf8'));
  assert.ok(record.issues.some((i) => String(i.copy).endsWith(`#${made.number}`) || (i.copy && i.copy.number === made.number)), 'the adoption is recorded');
});

test('U apply run a second time writes nothing at all', async (t) => {
  const s = await cold(t);
  const from = s.world.calls().length;
  const again = await s.run('apply');
  assert.equal(again.code, 0, again.all.join('\n'));
  assert.equal(writesOf(s.world, from).length, 0, JSON.stringify(writesOf(s.world, from)));
});

test('U apply paces its writes: one second apart, only through clock.sleep, and never 80 in a minute', async (t) => {
  const s = await cold(t);
  const writes = writesOf(s.world).length;
  assert.ok(writes > 10, `a cold run writes plenty (${writes})`);
  assert.equal(s.stamps.length, writes, 'every write was seen by the pacing probe');
  const slept = s.clock.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(slept >= 1000 * (writes - 1), `slept ${slept} ms for ${writes} writes`);
  for (let i = 1; i < s.stamps.length; i += 1) assert.ok(s.stamps[i] - s.stamps[i - 1] >= 1000, `write ${i} came ${s.stamps[i] - s.stamps[i - 1]} ms after the one before`);
  for (let i = 0; i + 80 < s.stamps.length; i += 1) assert.ok(s.stamps[i + 80] - s.stamps[i] >= 60000, `81 writes inside one minute from write ${i}`);
});

test('U apply writes no token into the plan, the record or the next settings', async (t) => {
  const s = await cold(t);
  for (const file of ['migration-record.json', 'board.config.next.json', 'plan.json']) {
    assert.ok(!(await readFile(join(s.outDir, file), 'utf8')).includes(TOKEN), file);
  }
});
