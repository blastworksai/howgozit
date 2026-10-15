import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { applyProposal } from '../scripts/lib/apply.mjs';
import { undoRecord } from '../scripts/undo.mjs';

const SETTINGS = 'board.config.json';
const HOME = 'sam-life/house';
const PALETTE = ['0E8A16', '5319E7', 'FBCA04', 'D93F0B', '1D76DB', 'B60205', '006B75', '5D6D7E'];

const fakeOpts = (extra = {}) => ({ repo: 'sam-life/life', repos: [{ name: HOME, private: true }, { name: 'sam-life/open', private: false }], ...extra });
const writesOf = (fake, from = 0) => fake.calls.slice(from).filter((c) => c.method !== 'GET');
const settingsOf = (fake) => JSON.parse(fake.state.files[SETTINGS].text);
const homeState = (fake) => fake.state.repos[HOME];
const project = (fake, title) => fake.state.projects.find((p) => p.title === title);
const label = (labels, name) => labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
const gql = (fake, name) => fake.calls.filter((c) => c.method === 'GRAPHQL' && c.path === name);

function v1() {
  return {
    owner: 'sam-life', repo: 'life', name: 'Sam', timezone: 'Europe/Brussels',
    projects: [
      { key: 'garden', title: 'Garden', milestones: [{ title: 'Beds', due: '2026-11-20' }], tasks: [{ title: 'Plant the beds', milestone: 'Beds', due: '2026-11-10' }, { title: 'Buy seed' }] },
      { key: 'health', title: 'Health', tasks: [{ title: 'Book a check-up' }] },
    ],
    standalone: [{ title: 'Renew passport' }],
    habits: [{ id: 'move', title: 'Move', project: 'health' }, { id: 'read', title: 'Read' }],
    focus: ['garden'],
  };
}

function v2() {
  return {
    owner: 'sam-life', repo: 'life', name: 'Sam', timezone: 'Europe/Brussels',
    modes: ['Work', 'Home'],
    ideas: true,
    projects: [
      { key: 'house', title: 'House', home: HOME,
        milestones: [{ title: 'Hallway', due: '2026-11-20' }],
        tasks: [{ title: 'Paint the hallway', milestone: 'Hallway', due: '2026-11-10' }, { title: 'Pick a colour' }] },
      { key: 'garden', title: 'Garden', tasks: [{ title: 'Plant the beds' }] },
    ],
    habits: [{ id: 'mood', title: 'Mood', score: { min: 1, max: 10 } }, { id: 'read', title: 'Read' }],
    focus: ['house'],
  };
}

// Home projects, modes, ideas and a score habit, and nothing in the data repo but labels and the file.
function homeOnly() {
  const p = v2();
  p.projects = [p.projects[0]];
  p.focus = ['house'];
  return p;
}

async function run(proposal, { fake = createFakeGitHub(fakeOpts()), record = null, dry = false } = {}) {
  const box = { record };
  const res = await applyProposal(fake.http, proposal, { dry, record, saveRecord: async (r) => { box.record = structuredClone(r); } });
  return { fake, res, box };
}

test('S8 a proposal with none of the new keys makes the same requests, settings and undo record as before', async () => {
  const base = await run(v1(), { fake: createFakeGitHub() });
  const withRepos = await run(v1(), { fake: createFakeGitHub(fakeOpts()) });
  assert.equal(base.res.ok, true, base.res.message);
  assert.equal(withRepos.res.ok, true, withRepos.res.message);
  assert.deepEqual(withRepos.fake.calls, base.fake.calls);
  assert.deepEqual(withRepos.fake.state.files, base.fake.state.files);
  assert.deepEqual(withRepos.box.record, base.box.record);
  assert.deepEqual(withRepos.res.steps, base.res.steps);
  const s = settingsOf(withRepos.fake);
  for (const k of ['modes', 'ideas', 'habitsProject']) assert.equal(k in s, false, k);
  for (const x of s.projects) assert.equal('home' in x, false);
  for (const h of s.habits) assert.equal('score' in h, false);
  assert.equal(withRepos.fake.calls.some((c) => c.path === 'linkProjectV2ToRepository'), false);
  assert.equal(withRepos.fake.calls.some((c) => c.method === 'GRAPHQL' && JSON.stringify(c.body).includes('NUMBER')), false);
  assert.equal(withRepos.fake.calls.some((c) => c.method === 'GRAPHQL' && c.path === 'createProjectV2Field' && c.body.dataType === 'NUMBER'), false);
  for (const c of withRepos.fake.calls) {
    if (c.method === 'GET' && c.path.startsWith('/repos/')) assert.ok(c.path.startsWith('/repos/sam-life/life'), c.path);
  }
});

test('S2 modes become labels with their palette colour in the data repo and in the home repo', async () => {
  const p = homeOnly();
  p.modes = ['Work', 'Home', 'Errands', 'Calls', 'Deep', 'Admin', 'Travel', 'Rest'];
  const { fake, res } = await run(p);
  assert.equal(res.ok, true, res.message);
  p.modes.forEach((m, i) => {
    for (const [where, labels] of [['data', fake.state.labels], ['home', homeState(fake).labels]]) {
      const l = label(labels, m);
      assert.ok(l, `${m} in ${where}`);
      assert.equal(String(l.color).toUpperCase(), PALETTE[i], `${m} in ${where}`);
    }
  });
});

test('S2 a mode label that already exists is left as it is, in either repo', async () => {
  const fake = createFakeGitHub(fakeOpts());
  await fake.http.send('POST', '/repos/sam-life/life/labels', { name: 'work', color: 'ffffff' });
  await fake.http.send('POST', `/repos/${HOME}/labels`, { name: 'WORK', color: 'aaaaaa' });
  const { res } = await run(homeOnly(), { fake });
  assert.equal(res.ok, true, res.message);
  assert.equal(fake.state.labels.filter((l) => l.name.toLowerCase() === 'work').length, 1);
  assert.equal(homeState(fake).labels.filter((l) => l.name.toLowerCase() === 'work').length, 1);
  assert.equal(label(fake.state.labels, 'work').color, 'ffffff');
  assert.equal(label(homeState(fake).labels, 'work').color, 'aaaaaa');
  assert.equal(String(label(fake.state.labels, 'Home').color).toUpperCase(), PALETTE[1]);
  assert.equal(String(label(homeState(fake).labels, 'Home').color).toUpperCase(), PALETTE[1]);
  const workSteps = res.steps.filter((s) => s.type === 'label' && s.name.toLowerCase() === 'work');
  assert.ok(workSteps.length >= 1 && workSteps.every((s) => s.action === 'exists'), JSON.stringify(workSteps));
});

test('S3 a project with a home reads the home repo and links the Project to it', async () => {
  const { fake, res } = await run(homeOnly());
  assert.equal(res.ok, true, res.message);
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.path === '/repos/' + HOME), 'home repo read');
  const homeNode = (await fake.http.get('/repos/' + HOME)).json.node_id;
  const links = gql(fake, 'linkProjectV2ToRepository');
  assert.equal(links.length, 1);
  assert.equal(links[0].body.projectId, project(fake, 'House').node_id);
  assert.equal(links[0].body.repositoryId, homeNode);
  assert.deepEqual(project(fake, 'House').repositories, [homeNode]);
  const step = res.steps.find((s) => s.type === 'link');
  assert.ok(step);
  assert.equal(step.name, `House → ${HOME}`);
  assert.equal(step.action, 'create');
});

test('S3 a project without a home is not linked and keeps its settings free of home', async () => {
  const { fake, res } = await run(v2());
  assert.equal(res.ok, true, res.message);
  assert.equal(gql(fake, 'linkProjectV2ToRepository').length, 1);
  assert.deepEqual(project(fake, 'Garden').repositories || [], []);
  const s = settingsOf(fake);
  assert.equal(s.projects.find((x) => x.key === 'garden').home, undefined);
  assert.equal(s.projects.find((x) => x.key === 'house').home, HOME);
});

test('S3 ideas true makes an Ideas Project with no field, and it is not a listed project', async () => {
  const { fake, res } = await run(v2());
  assert.equal(res.ok, true, res.message);
  const ideas = project(fake, 'Ideas');
  assert.ok(ideas);
  // lead (CP7): a Project starts with GitHub's own fields; setup adds none to Ideas
  assert.equal(fake.calls.some((c) => c.method === 'GRAPHQL' && c.path === 'createProjectV2Field' && c.body && c.body.projectId === ideas.node_id), false);
  assert.equal(ideas.fields.some((f) => f.name === 'Due' || f.name === 'Score'), false);
  const s = settingsOf(fake);
  assert.deepEqual(s.ideas, { owner: 'sam-life', number: ideas.number });
  assert.equal(s.projects.some((x) => x.number === ideas.number), false);
  assert.equal(res.steps.some((x) => x.type === 'project' && x.name === 'Ideas' && x.action === 'create'), true);
});

test('S3 a score habit makes a Habits Project with a number field Score, not a listed project', async () => {
  const { fake, res } = await run(v2());
  assert.equal(res.ok, true, res.message);
  const habits = project(fake, 'Habits');
  assert.ok(habits);
  const score = habits.fields.find((f) => f.name === 'Score');
  assert.ok(score);
  assert.equal(score.data_type, 'number');
  assert.equal(habits.fields.some((f) => f.name === 'Due'), false);
  const calls = gql(fake, 'createProjectV2Field').filter((c) => c.body.projectId === habits.node_id);
  assert.equal(calls.length, 1);
  // lead (CP7): setup writes the NUMBER enum into the mutation, as it writes DATE for Due; the field's type is asserted above
  assert.equal(calls[0].body.name, 'Score');
  assert.equal(res.steps.some((x) => x.type === 'field' && x.name === 'Habits · Score'), true);
  const s = settingsOf(fake);
  assert.deepEqual(s.habitsProject, { owner: 'sam-life', number: habits.number });
  assert.equal(s.projects.some((x) => x.number === habits.number), false);
});

test('S3 without ideas or a score habit there is no Ideas or Habits Project', async () => {
  const p = v2();
  delete p.ideas;
  p.habits = [{ id: 'read', title: 'Read' }];
  const { fake, res } = await run(p);
  assert.equal(res.ok, true, res.message);
  assert.equal(project(fake, 'Ideas'), undefined);
  assert.equal(project(fake, 'Habits'), undefined);
  const s = settingsOf(fake);
  assert.equal('ideas' in s, false);
  assert.equal('habitsProject' in s, false);
});

test('S4 a milestone of a home project lives in the home repo with its own title alone', async () => {
  const { fake, res } = await run(homeOnly());
  assert.equal(res.ok, true, res.message);
  const ms = homeState(fake).milestones;
  assert.deepEqual(ms.map((m) => m.title), ['Hallway']);
  assert.equal(ms[0].due_on.slice(0, 10), '2026-11-20');
  assert.equal(fake.state.milestones.length, 0);
  assert.equal(res.steps.some((s) => s.type === 'milestone' && s.name === 'Hallway'), true);
  assert.equal(res.steps.some((s) => s.name.includes('House · Hallway')), false);
});

test('S4 a milestone of a project without a home keeps its prefixed title in the data repo', async () => {
  const p = v2();
  p.projects[1].milestones = [{ title: 'Beds' }];
  const { fake, res } = await run(p);
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(fake.state.milestones.map((m) => m.title), ['Garden · Beds']);
  assert.deepEqual(homeState(fake).milestones.map((m) => m.title), ['Hallway']);
});

test('S5 tasks of a home project are home-repo issues on the Project with their milestone and Due', async () => {
  const { fake, res } = await run(homeOnly());
  assert.equal(res.ok, true, res.message);
  const issues = homeState(fake).issues;
  assert.deepEqual(issues.map((i) => i.title).sort(), ['Paint the hallway', 'Pick a colour']);
  assert.equal(fake.state.issues.some((i) => /hallway|colour/i.test(i.title)), false);
  const paint = issues.find((i) => i.title === 'Paint the hallway');
  assert.equal(paint.milestone.number, homeState(fake).milestones[0].number);
  assert.equal(issues.find((i) => i.title === 'Pick a colour').milestone, null);
  const items = project(fake, 'House').items;
  assert.equal(items.length, 2);
  for (const it of items) assert.equal(it.content.repository.full_name, HOME);
  const adds = fake.calls.filter((c) => c.method === 'POST' && /\/projectsV2\/\d+\/items$/.test(c.path));
  assert.equal(adds.length, 2);
  for (const a of adds) assert.ok(['house', HOME].includes(a.body.repo), JSON.stringify(a.body));
  const due = gql(fake, 'updateProjectV2ItemFieldValue');
  assert.equal(due.length, 1);
  assert.equal(due[0].body.date, '2026-11-10');
});

test('S5 a task of a project without a home stays an issue of the data repo', async () => {
  const { fake, res } = await run(v2());
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(fake.state.issues.map((i) => i.title), ['Plant the beds']);
  assert.equal(project(fake, 'Garden').items[0].content.repository.full_name, 'sam-life/life');
});

test('S3 a public home repo stops setup before anything is written', async () => {
  const p = homeOnly();
  p.projects[0].home = 'sam-life/open';
  const { fake, res } = await run(p);
  assert.equal(res.ok, false);
  assert.match(res.message, /sam-life\/open is not a private repository; setup only works on a private one\./);
  assert.deepEqual(writesOf(fake), []);
});

test('S3 a home repo that cannot be found stops setup before anything is written', async () => {
  const p = homeOnly();
  p.projects[0].home = 'sam-life/missing';
  const { fake, res } = await run(p);
  assert.equal(res.ok, false);
  assert.match(res.message, /GitHub could not find sam-life\/missing, or the token cannot see it\./);
  assert.deepEqual(writesOf(fake), []);
});

test('S3 a home repo of another owner is refused by validation with nothing requested', async () => {
  const p = homeOnly();
  p.projects[0].home = 'someone-else/house';
  const { fake, res } = await run(p);
  assert.equal(res.ok, false);
  assert.match(res.message, /projects\[0\]\.home: setup only works with repositories of sam-life; move this project by hand\./);
  assert.equal(fake.calls.length, 0);
});

test('S3 the titles Ideas and Habits are reserved when the role Projects are wanted', async () => {
  const p = v2();
  p.projects[1].title = 'ideas';
  const a = await run(p);
  assert.equal(a.res.ok, false);
  assert.equal(a.fake.calls.length, 0);
  const q = v2();
  q.projects[1].title = 'Habits';
  const b = await run(q);
  assert.equal(b.res.ok, false);
  assert.equal(b.fake.calls.length, 0);
});

test('S6 the settings carry home, modes, ideas, habitsProject and habits score as the proposal gave them', async () => {
  const { fake, res } = await run(v2());
  assert.equal(res.ok, true, res.message);
  const s = settingsOf(fake);
  assert.deepEqual(s.modes, ['Work', 'Home']);
  assert.equal(s.projects.find((x) => x.key === 'house').home, HOME);
  assert.deepEqual(s.habits.find((h) => h.id === 'mood').score, { min: 1, max: 10 });
  assert.equal('score' in s.habits.find((h) => h.id === 'read'), false);
  assert.equal(s.ideas.owner, 'sam-life');
  assert.equal(s.habitsProject.owner, 'sam-life');
  assert.equal(Number.isInteger(s.ideas.number) && Number.isInteger(s.habitsProject.number), true);
});

test('S6 a key already in the settings file is kept, never overwritten', async () => {
  const existing = { version: 1, name: 'Sam', timezone: 'Europe/Brussels', projects: [], focus: [], habits: [], modes: ['Old'], ideas: { owner: 'sam-life', number: 77 } };
  const fake = createFakeGitHub(fakeOpts({ files: { [SETTINGS]: JSON.stringify(existing, null, 2) + '\n' } }));
  const { res } = await run(homeOnly(), { fake });
  assert.equal(res.ok, true, res.message);
  const s = settingsOf(fake);
  assert.deepEqual(s.modes, ['Old']);
  assert.deepEqual(s.ideas, { owner: 'sam-life', number: 77 });
  assert.equal(s.projects.find((x) => x.key === 'house').home, HOME);
  assert.ok(s.habitsProject);
});

test('S8 the same v2 proposal run twice creates nothing the second time', async () => {
  const first = await run(v2());
  assert.equal(first.res.ok, true, first.res.message);
  const { fake } = first;
  const before = {
    main: structuredClone({ l: fake.state.labels, m: fake.state.milestones, i: fake.state.issues }),
    home: structuredClone(homeState(fake)), projects: fake.state.projects.length, files: structuredClone(fake.state.files),
  };
  const from = fake.calls.length;
  const again = await run(v2(), { fake, record: structuredClone(first.box.record) });
  assert.equal(again.res.ok, true, again.res.message);
  assert.equal(again.res.created, 0);
  assert.deepEqual(writesOf(fake, from), []);
  assert.deepEqual(structuredClone({ l: fake.state.labels, m: fake.state.milestones, i: fake.state.issues }), before.main);
  assert.deepEqual(structuredClone(homeState(fake)), before.home);
  assert.equal(fake.state.projects.length, before.projects);
  assert.deepEqual(fake.state.files, before.files);
  assert.ok(again.res.steps.every((s) => s.action === 'exists'), JSON.stringify(again.res.steps.filter((s) => s.action !== 'exists')));
});

test('S7 the undo record names the repo of every home entry and the link', async () => {
  const { box, res, fake } = await run(homeOnly());
  assert.equal(res.ok, true, res.message);
  const by = (type) => box.record.created.filter((c) => c.type === type);
  for (const e of by('milestone').concat(by('issue'))) assert.equal(e.repo, HOME, e.name);
  assert.equal(by('milestone').length, 1);
  assert.equal(by('issue').length, 2);
  assert.ok(by('label').some((e) => e.repo === HOME));
  assert.ok(by('label').some((e) => e.repo === undefined));
  const link = by('link');
  assert.equal(link.length, 1);
  assert.equal(link[0].repo, HOME);
  assert.equal(link[0].project, project(fake, 'House').node_id);
  assert.equal(link[0].id, (await fake.http.get('/repos/' + HOME)).json.node_id);
});

test('S7 undo of a v2 run removes the home-repo things and the Projects and leaves the data repo as it was', async () => {
  const fake = createFakeGitHub(fakeOpts());
  await fake.http.send('POST', '/repos/sam-life/life/labels', { name: 'old-label' });
  await fake.http.send('POST', `/repos/${HOME}/labels`, { name: 'old-home-label' });
  const snap = () => structuredClone({ l: fake.state.labels, m: fake.state.milestones, i: fake.state.issues, f: fake.state.files });
  const before = snap();
  const homeLabelsBefore = homeState(fake).labels.map((l) => l.name);
  const { box, res } = await run(homeOnly(), { fake });
  assert.equal(res.ok, true, res.message);
  const homeIssues = homeState(fake).issues.map((i) => i.number);
  const out = await undoRecord(fake.http, structuredClone(box.record), { force: false, say: () => {} });
  assert.equal(out.ok, true, out.message);
  for (const n of homeIssues) {
    const i = homeState(fake).issues.find((x) => x.number === n);
    assert.equal(i.state, 'closed');
    assert.equal(i.state_reason, 'not_planned');
  }
  assert.equal(homeState(fake).milestones.length, 0);
  assert.deepEqual(homeState(fake).labels.map((l) => l.name), homeLabelsBefore);
  assert.equal(fake.state.projects.length, 0);
  assert.deepEqual(snap(), before);
});

test('S7 undo of a record whose Project it did not create but whose link it did makes one unlink', async () => {
  const fake = createFakeGitHub(fakeOpts());
  const data = await fake.http.graphql('mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}', { ownerId: 'O_1', title: 'House' });
  const proj = data.createProjectV2.projectV2;
  const node = (await fake.http.get('/repos/' + HOME)).json.node_id;
  await fake.http.graphql('mutation($projectId:ID!,$repositoryId:ID!){linkProjectV2ToRepository(input:{projectId:$projectId,repositoryId:$repositoryId}){repository{id}}}', { projectId: proj.id, repositoryId: node });
  assert.deepEqual(project(fake, 'House').repositories, [node]);
  const record = { version: 1, repo: 'sam-life/life', created: [{ type: 'link', name: `House → ${HOME}`, number: null, id: node, url: null, project: proj.id, repo: HOME }] };
  const from = fake.calls.length;
  const out = await undoRecord(fake.http, record, { force: false, say: () => {} });
  assert.equal(out.ok, true, out.message);
  const un = fake.calls.slice(from).filter((c) => c.path === 'unlinkProjectV2FromRepository');
  assert.equal(un.length, 1);
  assert.equal(un[0].body.projectId, proj.id);
  assert.equal(un[0].body.repositoryId, node);
  assert.deepEqual(project(fake, 'House').repositories, []);
  assert.equal(fake.calls.slice(from).some((c) => c.path === 'deleteProjectV2'), false);
});

test('S7 undo does nothing for a link whose Project the same record lists, and skips an entry of another owner', async () => {
  const fake = createFakeGitHub(fakeOpts());
  const { box, res } = await run(homeOnly(), { fake });
  assert.equal(res.ok, true, res.message);
  const from = fake.calls.length;
  const out = await undoRecord(fake.http, structuredClone(box.record), { force: false, say: () => {} });
  assert.equal(out.ok, true, out.message);
  assert.equal(fake.calls.slice(from).some((c) => c.path === 'unlinkProjectV2FromRepository'), false);
  assert.equal(fake.calls.slice(from).some((c) => c.path === 'deleteProjectV2'), true);
  const stray = createFakeGitHub(fakeOpts());
  const lbl = await stray.http.send('POST', `/repos/${HOME}/labels`, { name: 'stray' });
  const rec = { version: 1, repo: 'sam-life/life', created: [{ type: 'label', name: 'stray', number: null, id: String(lbl.id), url: null, repo: 'other-owner/house' }] };
  const n = stray.calls.length;
  const said = [];
  const o2 = await undoRecord(stray.http, rec, { force: false, say: (l) => said.push(String(l)) });
  assert.equal(writesOf(stray, n).length, 0);
  assert.ok(label(homeState(stray).labels, 'stray'));
  // lead (CP7): the skip is said in the run's lines, and the entry is kept
  assert.match(said.join('\n'), /not in the record's account/);
});

test('S8 a dry run of a v2 proposal lists every new step as a create and writes nothing', async () => {
  const { fake, res } = await run(v2(), { dry: true });
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(writesOf(fake), []);
  assert.ok(res.steps.every((s) => s.action === 'create'), JSON.stringify(res.steps.filter((s) => s.action !== 'create')));
  const has = (type, name) => res.steps.some((s) => s.type === type && s.name === name);
  assert.ok(has('link', `House → ${HOME}`));
  assert.ok(has('project', 'Ideas'));
  assert.ok(has('project', 'Habits'));
  assert.ok(has('field', 'Habits · Score'));
  assert.ok(has('milestone', 'Hallway'));
  assert.ok(has('issue', 'Paint the hallway'));
  assert.equal(res.steps.filter((s) => s.type === 'label' && s.name === 'Work').length, 2);
  assert.equal(res.steps.filter((s) => s.type === 'label' && s.name === 'Home').length, 2);
  assert.equal(fake.state.projects.length, 0);
  assert.equal(SETTINGS in fake.state.files, false);
});
