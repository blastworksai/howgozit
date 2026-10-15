import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { checkSettings } from '../board/shape-settings.mjs';
import { validateProposal, applyProposal } from '../scripts/lib/apply.mjs';
import { main } from '../scripts/setup.mjs';

const SETTINGS = 'board.config.json';

function proposal() {
  return {
    owner: 'sam-life',
    repo: 'life',
    name: 'Sam',
    timezone: 'Europe/Brussels',
    projects: [
      {
        key: 'house',
        title: 'House',
        milestones: [{ title: 'Hallway', due: '2026-11-20' }],
        tasks: [
          { title: 'Paint the hallway', milestone: 'Hallway', due: '2026-11-10' },
          { title: 'Pick a colour' },
        ],
      },
      {
        key: 'side',
        title: 'Side',
        milestones: [{ title: 'Launch' }],
        tasks: [{ title: 'Write the page', milestone: 'Launch', due: '2026-12-01' }],
      },
      { key: 'health', title: 'Health', tasks: [{ title: 'Book a check-up' }] },
    ],
    standalone: [{ title: 'Renew passport' }, { title: 'Call the dentist' }],
    habits: [
      { id: 'move', title: 'Move', project: 'health' },
      { id: 'read', title: 'Read' },
    ],
    focus: ['house'],
  };
}

function recorder() {
  const r = { record: null, saves: 0 };
  r.saveRecord = async (rec) => {
    r.saves += 1;
    r.record = structuredClone(rec);
  };
  return r;
}

const writesOf = (fake) => fake.calls.filter((c) => c.method !== 'GET');
const labelNames = (fake) => fake.state.labels.map((l) => l.name);
const projectByTitle = (fake, title) => fake.state.projects.find((p) => p.title === title);
const issueByTitle = (fake, title) => fake.state.issues.find((i) => i.title === title);
const milestoneByTitle = (fake, title) => fake.state.milestones.find((m) => m.title === title);
const settingsOf = (fake) => JSON.parse(fake.state.files[SETTINGS].text);

function itemTitles(fake, projectTitle) {
  const p = projectByTitle(fake, projectTitle);
  return p.items.map((it) => fake.state.issues.find((i) => i.number === it.content.number).title);
}

function itemFor(fake, projectTitle, issueTitle) {
  const p = projectByTitle(fake, projectTitle);
  const issue = issueByTitle(fake, issueTitle);
  return p.items.find((it) => it.content.number === issue.number);
}

async function applied(opts = {}, fakeOpts = {}, p = proposal()) {
  const fake = createFakeGitHub(fakeOpts);
  const rec = recorder();
  const result = await applyProposal(fake.http, p, { saveRecord: rec.saveRecord, ...opts });
  return { fake, rec, result };
}

// ---------- S1 ----------

test('S1 a public repo is refused with a plain sentence and nothing is written', async () => {
  const fake = createFakeGitHub({ isPrivate: false });
  const result = await applyProposal(fake.http, proposal(), {});
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, 'string');
  assert.match(result.message, /private/i);
  assert.equal(writesOf(fake).length, 0);
  assert.equal(fake.state.projects.length, 0);
  assert.equal(fake.state.labels.length, 0);
});

test('S1 a private repo goes ahead', async () => {
  const { result, fake } = await applied();
  assert.equal(result.ok, true);
  assert.ok(writesOf(fake).length > 0);
});

// ---------- S2 ----------

test('S2 the repo gets the idea label and one habit label per habit', async () => {
  const { fake, result } = await applied();
  assert.equal(result.ok, true);
  const names = labelNames(fake);
  assert.ok(names.includes('idea'));
  assert.ok(names.includes('habit:move'));
  assert.ok(names.includes('habit:read'));
  assert.equal(names.length, 3);
});

test('S2 a label that already exists is not created again', async () => {
  const fake = createFakeGitHub();
  fake.state.labels.push({ id: 1, name: 'idea', color: 'ededed', description: null });
  const result = await applyProposal(fake.http, proposal(), {});
  assert.equal(result.ok, true);
  const created = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/labels'));
  assert.equal(created.some((c) => c.body.name === 'idea'), false);
  assert.equal(labelNames(fake).filter((n) => n === 'idea').length, 1);
  assert.ok(labelNames(fake).includes('habit:move'));
});

test('S2 existing settings that name another idea label and prefix are used', async () => {
  const existing = {
    version: 1, name: 'Old', timezone: 'Europe/Paris', projects: [], focus: [],
    labels: { idea: 'spark', habitPrefix: 'h-' },
  };
  const fake = createFakeGitHub({ files: { [SETTINGS]: JSON.stringify(existing, null, 2) + '\n' } });
  const result = await applyProposal(fake.http, proposal(), {});
  assert.equal(result.ok, true);
  const names = labelNames(fake);
  assert.ok(names.includes('spark'));
  assert.ok(names.includes('h-move'));
  assert.ok(names.includes('h-read'));
  assert.equal(names.includes('idea'), false);
  assert.equal(names.includes('habit:move'), false);
});

// ---------- S3 ----------

test('S3 each project is one Project owned by the organisation, with a Due field', async () => {
  const { fake, result } = await applied();
  assert.equal(result.ok, true);
  assert.equal(fake.state.projects.length, 3);
  for (const title of ['House', 'Side', 'Health']) {
    const p = projectByTitle(fake, title);
    assert.ok(p, title);
    assert.ok(p.fields.some((f) => f.name === 'Due'), title + ' has Due');
  }
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.path.startsWith('/orgs/sam-life/projectsV2')));
});

test('S3 each project is one Project owned by the user on a personal account', async () => {
  const { fake, result } = await applied({}, { ownerType: 'user' });
  assert.equal(result.ok, true);
  assert.equal(fake.state.projects.length, 3);
  for (const p of fake.state.projects) assert.ok(p.fields.some((f) => f.name === 'Due'));
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.path.startsWith('/users/sam-life/projectsV2')));
  assert.equal(fake.calls.some((c) => c.path.startsWith('/orgs/')), false);
});

test('S3 the settings file lists each project with its key and number', async () => {
  const { fake } = await applied();
  const s = settingsOf(fake);
  for (const [key, title] of [['house', 'House'], ['side', 'Side'], ['health', 'Health']]) {
    const entry = s.projects.find((p) => p.key === key);
    assert.ok(entry, key);
    assert.equal(entry.number, projectByTitle(fake, title).number);
  }
  assert.equal(s.projects.length, 3);
});

test('S3 a project title containing the separator is refused by validateProposal', async () => {
  const p = proposal();
  p.projects[1].title = 'Side · Hustle';
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /projects\[1\]\.title/.test(e)), v.errors.join(' | '));
});

// ---------- S4 ----------

test('S4 each milestone is titled with its project title, a separator and its own title', async () => {
  const { fake } = await applied();
  const titles = fake.state.milestones.map((m) => m.title).sort();
  assert.deepEqual(titles, ['House · Hallway', 'Side · Launch']);
});

test('S4 a milestone due date is written as noon UTC of that date', async () => {
  const { fake } = await applied();
  const sent = fake.calls.find((c) => c.method === 'POST' && /\/milestones$/.test(c.path) && c.body && c.body.title === 'House · Hallway');
  assert.equal(sent.body.due_on, '2026-11-20T12:00:00Z');
  assert.equal(milestoneByTitle(fake, 'House · Hallway').due_on.slice(0, 10), '2026-11-20');
});

test('S4 a milestone without a date has none', async () => {
  const { fake } = await applied();
  assert.equal(milestoneByTitle(fake, 'Side · Launch').due_on, null);
});

// ---------- S5 ----------

test('S5 every project task is an item of its own Project and only that one', async () => {
  const { fake } = await applied();
  assert.deepEqual(itemTitles(fake, 'House').sort(), ['Paint the hallway', 'Pick a colour']);
  assert.deepEqual(itemTitles(fake, 'Side'), ['Write the page']);
  assert.deepEqual(itemTitles(fake, 'Health'), ['Book a check-up']);
});

test('S5 a task sits in its milestone, and a task without one sits in none', async () => {
  const { fake } = await applied();
  const hallway = milestoneByTitle(fake, 'House · Hallway');
  const launch = milestoneByTitle(fake, 'Side · Launch');
  assert.equal(issueByTitle(fake, 'Paint the hallway').milestone.number, hallway.number);
  assert.equal(issueByTitle(fake, 'Write the page').milestone.number, launch.number);
  assert.equal(issueByTitle(fake, 'Pick a colour').milestone, null);
  assert.equal(issueByTitle(fake, 'Book a check-up').milestone, null);
});

test('S5 Due is set when the proposal gives one and left alone when it does not', async () => {
  const { fake } = await applied();
  assert.equal(itemFor(fake, 'House', 'Paint the hallway').due, '2026-11-10');
  assert.equal(itemFor(fake, 'Side', 'Write the page').due, '2026-12-01');
  assert.equal(itemFor(fake, 'House', 'Pick a colour').due, null);
  assert.equal(itemFor(fake, 'Health', 'Book a check-up').due, null);
  const sets = fake.calls.filter((c) => c.method === 'GRAPHQL' && c.path === 'updateProjectV2ItemFieldValue');
  assert.equal(sets.length, 2);
});

test('S5 a standalone task is an item of no Project and has no milestone', async () => {
  const { fake } = await applied();
  for (const title of ['Renew passport', 'Call the dentist']) {
    const issue = issueByTitle(fake, title);
    assert.ok(issue, title);
    assert.equal(issue.milestone, null);
    for (const p of fake.state.projects) {
      assert.equal(p.items.some((it) => it.content.number === issue.number), false);
    }
  }
});

// ---------- S6 ----------

test('S6 the settings file is at the repo root, parses and passes the settings check', async () => {
  const { fake } = await applied();
  assert.ok(fake.state.files[SETTINGS], 'file exists');
  const s = settingsOf(fake);
  assert.deepEqual(checkSettings(s), { ok: true, errors: [] });
  assert.ok(fake.state.files[SETTINGS].text.endsWith('\n'));
  assert.equal(fake.state.files[SETTINGS].text, JSON.stringify(s, null, 2) + '\n');
});

test('S6 the settings file holds name, timezone, projects, habits and focus', async () => {
  const { fake } = await applied();
  const s = settingsOf(fake);
  assert.equal(s.version, 1);
  assert.equal(s.name, 'Sam');
  assert.equal(s.timezone, 'Europe/Brussels');
  assert.deepEqual(s.focus, ['house']);
  assert.deepEqual(s.projects.map((p) => p.key).sort(), ['health', 'house', 'side']);
  assert.deepEqual(s.habits.map((h) => h.id).sort(), ['move', 'read']);
  const move = s.habits.find((h) => h.id === 'move');
  assert.equal(move.title, 'Move');
  assert.equal(move.project, 'health');
  assert.equal(s.habits.find((h) => h.id === 'read').title, 'Read');
});

test('S6 with a settings file already there, setup adds and removes or changes nothing', async () => {
  const existing = {
    version: 1,
    name: 'Old name',
    timezone: 'Europe/Paris',
    weekStart: 'sunday',
    agentName: 'Robo',
    projects: [{ key: 'old', number: 7, color: '#123456' }],
    focus: ['old'],
    labels: { idea: 'spark', habitPrefix: 'h-', ignore: ['weekly-review', 'noise'] },
    habits: [{ id: 'walk', title: 'Walk', start: '2026-09-01' }],
    streak: { tokenEvery: 4, flameTiers: [2, 4, 8, 16, 32] },
    next: { count: 3 },
  };
  const before = structuredClone(existing);
  const fake = createFakeGitHub({ files: { [SETTINGS]: JSON.stringify(existing, null, 2) + '\n' } });
  const result = await applyProposal(fake.http, proposal(), {});
  assert.equal(result.ok, true);
  const after = settingsOf(fake);
  assert.deepEqual(checkSettings(after), { ok: true, errors: [] });
  for (const k of Object.keys(before)) {
    if (['projects', 'focus', 'habits'].includes(k)) continue;
    assert.deepEqual(after[k], before[k], 'unchanged: ' + k);
  }
  assert.deepEqual(after.projects[0], before.projects[0]);
  assert.deepEqual(after.habits[0], before.habits[0]);
  assert.equal(after.focus[0], 'old');
  assert.ok(after.projects.some((p) => p.key === 'house'));
  assert.ok(after.projects.some((p) => p.key === 'side'));
  assert.ok(after.projects.some((p) => p.key === 'health'));
  assert.ok(after.habits.some((h) => h.id === 'move'));
  assert.ok(after.habits.some((h) => h.id === 'read'));
  assert.ok(after.focus.includes('house'));
});

test('S6 an existing key pointing at another Project number is a refusal', async () => {
  const existing = {
    version: 1, name: 'Old', timezone: 'Europe/Paris',
    projects: [{ key: 'house', number: 7 }], focus: [],
  };
  const text = JSON.stringify(existing, null, 2) + '\n';
  const fake = createFakeGitHub({ files: { [SETTINGS]: text } });
  const result = await applyProposal(fake.http, proposal(), {});
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
  assert.equal(fake.state.files[SETTINGS].text, text);
});

// ---------- S8 ----------

test('S8 a second run with the saved record makes no write and creates nothing twice', async () => {
  const { fake, rec } = await applied();
  const counts = {
    labels: fake.state.labels.length, milestones: fake.state.milestones.length,
    issues: fake.state.issues.length, projects: fake.state.projects.length,
    items: fake.state.projects.map((p) => p.items.length),
  };
  const mark = fake.calls.length;
  const again = await applyProposal(fake.http, proposal(), { record: rec.record, saveRecord: async () => {} });
  assert.equal(again.ok, true);
  assert.equal(again.created, 0);
  assert.equal(fake.calls.slice(mark).filter((c) => c.method !== 'GET').length, 0);
  assert.equal(fake.state.labels.length, counts.labels);
  assert.equal(fake.state.milestones.length, counts.milestones);
  assert.equal(fake.state.issues.length, counts.issues);
  assert.equal(fake.state.projects.length, counts.projects);
  assert.deepEqual(fake.state.projects.map((p) => p.items.length), counts.items);
});

test('S8 a second run with no record makes no write and creates nothing twice', async () => {
  const { fake } = await applied();
  const issues = fake.state.issues.length;
  const mark = fake.calls.length;
  const again = await applyProposal(fake.http, proposal(), {});
  assert.equal(again.ok, true);
  assert.equal(again.created, 0);
  assert.equal(fake.calls.slice(mark).filter((c) => c.method !== 'GET').length, 0);
  assert.equal(fake.state.issues.length, issues);
  assert.equal(fake.state.issues.filter((i) => i.title === 'Renew passport').length, 1);
  assert.ok(again.steps.every((s) => s.action !== 'create'));
});

test('S8 an issue the record lists but GitHub does not show is not created again', async () => {
  const { fake, rec } = await applied();
  const p = proposal();
  p.standalone.push({ title: 'Ghost task' });
  const record = structuredClone(rec.record);
  record.created.push({ type: 'issue', name: 'Ghost task', number: 99, id: 990, url: 'https://github.com/sam-life/life/issues/99' });
  const mark = fake.calls.length;
  const again = await applyProposal(fake.http, p, { record, saveRecord: async () => {} });
  assert.equal(again.ok, true);
  assert.equal(issueByTitle(fake, 'Ghost task'), undefined);
  const posts = fake.calls.slice(mark).filter((c) => c.method === 'POST' && c.path.endsWith('/issues'));
  assert.equal(posts.length, 0);
});

// ---------- U: applyProposal ----------

test('U a dry run sends no write and reports every step as a create', async () => {
  const dryFake = createFakeGitHub();
  const dry = await applyProposal(dryFake.http, proposal(), { dry: true });
  assert.equal(dry.ok, true);
  assert.equal(writesOf(dryFake).length, 0);
  assert.ok(dry.steps.length > 0);
  assert.ok(dry.steps.every((s) => s.action === 'create'), JSON.stringify(dry.steps.filter((s) => s.action !== 'create')));
  const realFake = createFakeGitHub();
  const real = await applyProposal(realFake.http, proposal(), {});
  const sig = (r) => r.steps.map((s) => s.type + '|' + s.name);
  assert.deepEqual(sig(dry), sig(real));
});

test('U saveRecord runs once per created object and the entries are complete', async () => {
  const { fake, rec } = await applied();
  const entries = rec.record.created;
  assert.equal(rec.saves, entries.length);
  for (const e of entries) {
    for (const k of ['type', 'name', 'number', 'id', 'url']) assert.ok(Object.hasOwn(e, k), k + ' in ' + JSON.stringify(e));
    assert.equal(typeof e.type, 'string');
    assert.equal(typeof e.name, 'string');
  }
  const count = (t) => entries.filter((e) => e.type === t).length;
  assert.equal(count('label'), 3);
  assert.equal(count('project'), 3);
  assert.equal(count('field'), 3);
  assert.equal(count('milestone'), 2);
  assert.equal(count('issue'), fake.state.issues.length);
  assert.equal(count('file'), 1);
});

test('U the record lists no item and no due step', async () => {
  const { rec } = await applied();
  const types = new Set(rec.record.created.map((e) => e.type));
  assert.equal(types.has('item'), false);
  assert.equal(types.has('due'), false);
  for (const t of types) assert.ok(['label', 'project', 'field', 'milestone', 'issue', 'file'].includes(t), t);
  assert.equal(rec.record.version, 1);
  assert.equal(rec.record.repo, 'sam-life/life');
});

test('U a settings file that already existed is not in the record', async () => {
  const existing = { version: 1, name: 'Old', timezone: 'Europe/Paris', projects: [], focus: [] };
  const rec = recorder();
  const fake = createFakeGitHub({ files: { [SETTINGS]: JSON.stringify(existing, null, 2) + '\n' } });
  const result = await applyProposal(fake.http, proposal(), { saveRecord: rec.saveRecord });
  assert.equal(result.ok, true);
  assert.equal(rec.record.created.some((e) => e.type === 'file'), false);
});

test('U a GraphQL failure on one Project gives a by-hand line and the others still land', async () => {
  const fake = createFakeGitHub();
  fake.fail({ method: 'GRAPHQL', path: 'createProjectV2' }, new GitHubError('invalid', 422, 'refused'));
  const result = await applyProposal(fake.http, proposal(), {});
  assert.equal(result.ok, true);
  assert.ok(result.byHand.length >= 1);
  assert.ok(result.byHand.some((l) => l.includes('House')), result.byHand.join(' | '));
  assert.equal(projectByTitle(fake, 'House'), undefined);
  assert.ok(projectByTitle(fake, 'Side'));
  assert.ok(projectByTitle(fake, 'Health'));
});

test('U a GitHub failure on an issue create stops with a plain message and keeps the record', async () => {
  const fake = createFakeGitHub();
  fake.fail({ method: 'POST', path: '/repos/sam-life/life/issues' }, new GitHubError('server', 500, 'boom'));
  const rec = recorder();
  const result = await applyProposal(fake.http, proposal(), { saveRecord: rec.saveRecord });
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
  assert.equal(/\n\s+at /.test(result.message), false);
  assert.ok(rec.record, 'a record was saved');
  const types = new Set(rec.record.created.map((e) => e.type));
  for (const t of ['label', 'project', 'milestone']) assert.ok(types.has(t), t);
  assert.equal(rec.record.created.filter((e) => e.type === 'project').length, 3);
});

test('U validateProposal accepts the sample proposal', async () => {
  const v = validateProposal(proposal());
  assert.deepEqual(v, { ok: true, errors: [] });
});

test('U validateProposal refuses an unknown top-level key and names it', async () => {
  const p = proposal();
  p.extra = 1;
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('extra')), v.errors.join(' | '));
});

test('U validateProposal refuses a duplicate project key and names the place', async () => {
  const p = proposal();
  p.projects[1].key = 'house';
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /projects\[1\]\.key/.test(e)), v.errors.join(' | '));
});

test('U validateProposal refuses a duplicate project title and names the place', async () => {
  const p = proposal();
  p.projects[2].title = 'House';
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /projects\[2\]\.title/.test(e)), v.errors.join(' | '));
});

test('U validateProposal refuses a task naming a missing milestone', async () => {
  const p = proposal();
  p.projects[0].tasks[0].milestone = 'Nowhere';
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /projects\[0\]\.tasks\[0\]/.test(e)), v.errors.join(' | '));
});

test('U validateProposal refuses a date that is not real', async () => {
  const p = proposal();
  p.projects[0].milestones[0].due = '2026-02-30';
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /projects\[0\]\.milestones\[0\]/.test(e)), v.errors.join(' | '));
  const q = proposal();
  q.projects[0].tasks[0].due = '2026-13-01';
  const w = validateProposal(q);
  assert.equal(w.ok, false);
  assert.ok(w.errors.some((e) => /projects\[0\]\.tasks\[0\]/.test(e)), w.errors.join(' | '));
});

test('U validateProposal refuses a bad project key', async () => {
  const p = proposal();
  p.projects[0].key = 'House Key';
  const v = validateProposal(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /projects\[0\]\.key/.test(e)), v.errors.join(' | '));
});

test('U validateProposal refuses a missing owner or repo', async () => {
  const a = proposal();
  delete a.owner;
  const va = validateProposal(a);
  assert.equal(va.ok, false);
  assert.ok(va.errors.some((e) => /owner/.test(e)), va.errors.join(' | '));
  const b = proposal();
  delete b.repo;
  const vb = validateProposal(b);
  assert.equal(vb.ok, false);
  assert.ok(vb.errors.some((e) => /repo/.test(e)), vb.errors.join(' | '));
});

test('U a task whose item has an empty Due gets its Due set on the next run', async () => {
  const { fake } = await applied();
  const item = itemFor(fake, 'House', 'Paint the hallway');
  assert.equal(item.due, '2026-11-10');
  item.due = null;
  const again = await applyProposal(fake.http, proposal(), {});
  assert.equal(again.ok, true);
  assert.equal(itemFor(fake, 'House', 'Paint the hallway').due, '2026-11-10');
});

test('U adding one project later works against the existing setup', async () => {
  const { fake } = await applied();
  const later = {
    owner: 'sam-life',
    repo: 'life',
    projects: [{ key: 'garden', title: 'Garden', tasks: [{ title: 'Plant beans' }] }],
  };
  assert.deepEqual(validateProposal(later), { ok: true, errors: [] });
  const result = await applyProposal(fake.http, later, {});
  assert.equal(result.ok, true);
  const s = settingsOf(fake);
  assert.deepEqual(checkSettings(s), { ok: true, errors: [] });
  assert.deepEqual(s.projects.map((p) => p.key).sort(), ['garden', 'health', 'house', 'side']);
  assert.equal(s.projects.find((p) => p.key === 'garden').number, projectByTitle(fake, 'Garden').number);
  assert.equal(s.name, 'Sam');
  assert.deepEqual(s.habits.map((h) => h.id).sort(), ['move', 'read']);
  assert.deepEqual(itemTitles(fake, 'Garden'), ['Plant beans']);
});

// ---------- U: main ----------

function harness() {
  const lines = { out: [], err: [] };
  return {
    lines,
    out: (l) => lines.out.push(String(l)),
    err: (l) => lines.err.push(String(l)),
  };
}

test('U main with no arguments prints one plain sentence and returns 1', async () => {
  const h = harness();
  const code = await main([], { env: {}, fetch: async () => { throw new Error('no network'); }, cwd: tmpdir(), out: h.out, err: h.err });
  assert.equal(code, 1);
  assert.equal(h.lines.out.length + h.lines.err.length, 1);
  assert.ok((h.lines.out[0] || h.lines.err[0]).length > 0);
});

test('U main plan on a missing file prints one plain sentence and returns 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lb-setup-'));
  try {
    const h = harness();
    const code = await main(['plan', join(dir, 'nope.json')], {
      env: { BOARD_GITHUB_TOKEN: 'SENTINEL-TOKEN-123' },
      fetch: async () => { throw new Error('no network'); },
      cwd: dir, out: h.out, err: h.err,
    });
    assert.equal(code, 1);
    assert.equal(h.lines.out.length + h.lines.err.length, 1);
    assert.equal((h.lines.out.concat(h.lines.err)).join('\n').includes('SENTINEL-TOKEN-123'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('U main apply without a token returns 1 and never prints the sentinel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lb-setup-'));
  try {
    const file = join(dir, 'proposal.json');
    writeFileSync(file, JSON.stringify(proposal()));
    const h = harness();
    let fetched = 0;
    const code = await main(['apply', file], {
      env: {},
      fetch: async () => { fetched += 1; throw new Error('no network'); },
      cwd: dir, out: h.out, err: h.err,
    });
    assert.equal(code, 1);
    assert.equal(fetched, 0);
    assert.ok(h.lines.out.length + h.lines.err.length >= 1);
    assert.equal(h.lines.out.concat(h.lines.err).join('\n').includes('SENTINEL-TOKEN-123'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('U main apply with a token that meets a network failure never prints the token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lb-setup-'));
  try {
    const file = join(dir, 'proposal.json');
    writeFileSync(file, JSON.stringify(proposal()));
    const h = harness();
    const code = await main(['apply', file], {
      env: { BOARD_GITHUB_TOKEN: 'SENTINEL-TOKEN-123' },
      fetch: async () => { throw new Error('network down'); },
      cwd: dir, out: h.out, err: h.err,
    });
    assert.notEqual(code, 0);
    assert.equal(h.lines.out.concat(h.lines.err).join('\n').includes('SENTINEL-TOKEN-123'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- S8 / settle under lag ----------

const countingWait = () => {
  const w = { calls: [] };
  w.wait = async (ms) => { w.calls.push(ms); };
  return w;
};
const itemCount = (fake) => fake.state.projects.reduce((n, p) => n + p.items.length, 0);

test('S8 a lagging item list ends unsettled with one note, and a second apply under the lag changes nothing', async () => {
  const fake = createFakeGitHub();
  fake.lagItems(1000);
  const w = countingWait();
  const first = await applyProposal(fake.http, proposal(), { wait: w.wait, settleMs: 20000 });
  assert.equal(first.ok, true);
  assert.equal(first.settled, false);
  assert.equal(first.notes.length, 1);
  assert.equal(w.calls.length, 4);
  const issues = fake.state.issues.length;
  const labels = fake.state.labels.length;
  const milestones = fake.state.milestones.length;
  const projects = fake.state.projects.length;
  const items = itemCount(fake);
  const second = await applyProposal(fake.http, proposal(), { wait: w.wait, settleMs: 20000 });
  assert.equal(second.ok, true);
  assert.equal(fake.state.issues.length, issues);
  assert.equal(fake.state.labels.length, labels);
  assert.equal(fake.state.milestones.length, milestones);
  assert.equal(fake.state.projects.length, projects);
  assert.equal(itemCount(fake), items);
  for (const p of fake.state.projects) {
    const nums = p.items.map((it) => it.content.number);
    assert.equal(new Set(nums).size, nums.length);
  }
});

test('U settle waits only while lists lag, and reports settled null when it is off or dry', async () => {
  const lagged = createFakeGitHub();
  lagged.lagItems(3);
  const w1 = countingWait();
  const r1 = await applyProposal(lagged.http, proposal(), { wait: w1.wait, settleMs: 180000 });
  assert.equal(r1.settled, true);
  assert.ok(w1.calls.length >= 1 && w1.calls.length <= 3);
  assert.ok(w1.calls.every((ms) => ms === 5000));

  const clear = createFakeGitHub();
  const w2 = countingWait();
  const r2 = await applyProposal(clear.http, proposal(), { wait: w2.wait, settleMs: 180000 });
  assert.equal(r2.ok, true);
  assert.equal(w2.calls.length, 0);

  const dry = createFakeGitHub();
  const w3 = countingWait();
  await applyProposal(dry.http, proposal(), { wait: w3.wait, dry: true });
  assert.equal(w3.calls.length, 0);

  const off = createFakeGitHub();
  const w4 = countingWait();
  const r4 = await applyProposal(off.http, proposal(), { wait: w4.wait, settleMs: 0 });
  assert.equal(r4.settled, null);
  assert.equal(w4.calls.length, 0);
});

test('U a third apply after the lag ends writes nothing and the dated task has its Due', async () => {
  const fake = createFakeGitHub();
  fake.lagItems(1000);
  const w = countingWait();
  await applyProposal(fake.http, proposal(), { wait: w.wait, settleMs: 10000 });
  await applyProposal(fake.http, proposal(), { wait: w.wait, settleMs: 10000 });
  fake.lagItems(0);
  const mark = fake.calls.length;
  const third = await applyProposal(fake.http, proposal(), { wait: w.wait, settleMs: 10000 });
  assert.equal(third.ok, true);
  assert.equal(writesOf({ calls: fake.calls.slice(mark) }).length, 0);
  assert.equal(itemFor(fake, 'House', 'Paint the hallway').due, '2026-11-10');
});
