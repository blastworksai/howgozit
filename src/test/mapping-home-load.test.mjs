// CP4 (SKILLS-76) job D1, loader half: a public home repo, field ids across loads, and a pending item matched by (owner, number).
// Written from the rule text (R72, R141, R70) and reference/mapping-redesign/cp4-interface.md section 3f, not from the code.
// Every answer is invented; the loader runs on a fake `http` and a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../board/load.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { settings } from '../fixtures/build.mjs';

const OWNER = 'sam-life';
const OTHER = 'other';
const REPO = 'sam-life/life';
const HOME = 'sam-life/home';
const R = '/repos/' + REPO;
const TOKEN = 'SENTINEL-TOKEN-123';

function apiIssue(number, extra = {}) {
  return {
    id: number * 10, number, title: 'Task ' + number, state: 'open', state_reason: null,
    labels: [], milestone: null, comments: 0,
    created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
    html_url: 'https://github.com/' + REPO + '/issues/' + number,
    ...extra,
  };
}

const notFound = (p) => new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');

// projects: the settings' project entries. items: `${owner}#${number}` -> issue numbers of the data repo.
function makeWorld({ projects, items = {}, homePrivate = true, extraOwners = [] } = {}) {
  const w = {
    calls: [],
    homePrivate,
    files: { 'board.config.json': JSON.stringify(settings({ projects })) },
    items,
    full: [apiIssue(1), apiIssue(2), apiIssue(3)],
  };
  function answer(method, p) {
    w.calls.push({ method, path: p });
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p === '/repos/' + HOME) return { private: w.homePrivate, owner: { login: OWNER, type: 'Organization' } };
    if (p.startsWith(R + '/contents/')) {
      const f = p.slice((R + '/contents/').length);
      if (typeof w.files[f] !== 'string') throw notFound(p);
      return { content: Buffer.from(w.files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?')) return { items: structuredClone(p.includes('&since=') ? [] : w.full), partial: false };
    if (p.startsWith(R + '/milestones?') || p.startsWith('/repos/' + HOME + '/milestones?')) return { items: [], partial: false };
    let m = /^\/users\/([^/]+)$/.exec(p);
    if (m && extraOwners.includes(m[1])) return { login: m[1], type: 'Organization' };
    m = /^\/orgs\/([^/]+)\/projectsV2\?per_page=100$/.exec(p);
    if (m) {
      const owner = m[1];
      const numbers = Object.keys(w.items).filter((k) => k.split('#')[0] === owner).map((k) => Number(k.split('#')[1]));
      return { items: numbers.map((n) => ({ number: n, title: owner + ' project ' + n, state: 'open' })), partial: false };
    }
    m = /^\/orgs\/([^/]+)\/projectsV2\/(\d+)\/fields\?/.exec(p);
    if (m) return { items: [{ id: 11, name: 'Status' }, { id: 12, name: 'Due' }], partial: false };
    m = /^\/orgs\/([^/]+)\/projectsV2\/(\d+)\/items\?/.exec(p);
    if (m) {
      const rows = w.items[m[1] + '#' + m[2]] || [];
      return {
        items: rows.map((n) => ({
          content_type: 'Issue', content: apiIssue(n, { repository: { full_name: REPO } }),
          fields: [{ id: 11, name: 'Status', value: { name: { raw: 'Todo' } } }, { id: 12, name: 'Due', value: null }],
        })),
        partial: false,
      };
    }
    throw notFound(p);
  }
  w.http = {
    async get(p) { return { status: 200, json: answer('get', p), notModified: false, link: null }; },
    async paged(p) { return answer('paged', p); },
  };
  w.count = (re) => w.calls.filter((c) => re.test(c.path)).length;
  return w;
}

function fakeCache() {
  const c = {
    stored: null,
    async readLastGood() { return c.stored; },
    async writeLastGood(b) { c.stored = structuredClone(b); },
    etags: { get() {}, set() {} },
  };
  return c;
}

function setup(world, at = '2026-10-12T06:10:00.900Z') {
  const clock = { t: Date.parse(at), now() { return clock.t; } };
  const loader = createLoader({
    http: world.http, httpFor: () => world.http, env: { repo: REPO, readOnly: false, configDir: null, token: TOKEN },
    cache: fakeCache(), clock,
  });
  return { world, clock, loader };
}

const homeProjects = [{ key: 'home', number: 3, home: HOME }];
const text = (out) => out.notice.title + ' ' + out.notice.message;

test('R72 a home repo that is public gives a notice naming that repo, status 503 and no board', async () => {
  const s = setup(makeWorld({ projects: homeProjects, items: { [OWNER + '#3']: [1] }, homePrivate: false }));
  const out = await s.loader.load();
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
  assert.ok(text(out).includes(HOME), text(out));
  assert.match(text(out), /public/i);
  assert.ok(!out.bundle, 'no board is shown');
});

test('R72 a home repo that is private lets the board through', async () => {
  const s = setup(makeWorld({ projects: homeProjects, items: { [OWNER + '#3']: [1] }, homePrivate: true }));
  const out = await s.loader.load();
  assert.equal(out.ok, true);
  assert.equal(out.bundle.raw.repos.find((r) => r.role === 'home').private, true);
});

test('R72 with two home repos the notice names the first public one in settings order', async () => {
  const projects = [
    { key: 'home', number: 3, home: HOME },
    { key: 'work', number: 4, home: 'sam-life/work' },
    { key: 'play', number: 5, home: 'sam-life/play' },
  ];
  const w = makeWorld({ projects, items: { [OWNER + '#3']: [], [OWNER + '#4']: [], [OWNER + '#5']: [] } });
  const base = w.http;
  const answerPrivacy = async (p) => ({ private: !/work|play/.test(p), owner: { login: OWNER, type: 'Organization' } });
  w.http = {
    async get(p) {
      if (p === '/repos/sam-life/work' || p === '/repos/sam-life/play') return { status: 200, json: await answerPrivacy(p), notModified: false, link: null };
      return base.get(p);
    },
    async paged(p) {
      if (/^\/repos\/sam-life\/(work|play)\/milestones\?/.test(p)) return { items: [], partial: false };
      return base.paged(p);
    },
  };
  const out = await setup(w).loader.load();
  assert.equal(out.ok, false);
  assert.ok(text(out).includes('sam-life/work'), text(out));
  assert.ok(!text(out).includes('sam-life/play'), text(out));
});

test('R72 a home repo\'s privacy is read on a full read and not on a following load that is not full', async () => {
  const w = makeWorld({ projects: homeProjects, items: { [OWNER + '#3']: [1] } });
  const s = setup(w);
  const asked = () => w.count(new RegExp('^/repos/' + HOME + '$'));
  await s.loader.load();
  assert.equal(asked(), 1);
  s.clock.t += 60000;
  await s.loader.load();
  assert.equal(asked(), 1, 'a load that is not full does not ask');
  s.clock.t += 60000;
  await s.loader.load({ full: true });
  assert.equal(asked(), 2, 'a full read asks again');
});

test('R72 a home repo that has turned public is caught on the next full read', async () => {
  const w = makeWorld({ projects: homeProjects, items: { [OWNER + '#3']: [1] } });
  const s = setup(w);
  assert.equal((await s.loader.load()).ok, true);
  w.homePrivate = false;
  s.clock.t += 60000;
  const out = await s.loader.load({ full: true });
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
  assert.ok(text(out).includes(HOME));
});

test('R141 two loads ask the fields address once', async () => {
  const w = makeWorld({ projects: [{ key: 'home', number: 3 }], items: { [OWNER + '#3']: [1] } });
  const s = setup(w);
  await s.loader.load();
  s.clock.t += 60000;
  await s.loader.load();
  assert.equal(w.count(/\/projectsV2\/3\/fields\?/), 1);
  assert.equal(w.count(/\/projectsV2\/3\/items\?/), 2);
});

test('R141 a full read in between asks the fields address again', async () => {
  const w = makeWorld({ projects: [{ key: 'home', number: 3 }], items: { [OWNER + '#3']: [1] } });
  const s = setup(w);
  await s.loader.load();
  s.clock.t += 60000;
  await s.loader.load({ full: true });
  assert.equal(w.count(/\/projectsV2\/3\/fields\?/), 2);
});

// Two owners list a Project numbered 3.
const twoOwners = [{ key: 'mine', number: 3 }, { key: 'theirs', number: 3, owner: OTHER }];
const twoOwnersWorld = () => makeWorld({
  projects: twoOwners, extraOwners: [OTHER],
  items: { [OWNER + '#3']: [1], [OTHER + '#3']: [2] },
});
const projectOf = (bundle, owner, n) => bundle.raw.projects.find((p) => (p.owner ?? OWNER).toLowerCase() === owner && p.number === n);
const has99 = (project) => project.items.some((i) => i.number === 99);

test('R70 a pending item for the other owner\'s Project 3 shows there and not under the data owner\'s Project 3', async () => {
  const s = setup(twoOwnersWorld());
  const first = await s.loader.load();
  assert.equal(first.ok, true);
  assert.ok(projectOf(first.bundle, OWNER, 3) && projectOf(first.bundle, OTHER, 3), 'both Projects are read');
  s.loader.noteWrite({ item: { projectOwner: OTHER, projectNumber: 3, issueNumber: 99 } });
  s.clock.t += 5000;
  const out = await s.loader.load();
  assert.equal(has99(projectOf(out.bundle, OTHER, 3)), true);
  assert.equal(has99(projectOf(out.bundle, OWNER, 3)), false);
});

test('R70 a pending item with no owner belongs to the data repo owner\'s Project 3', async () => {
  const s = setup(twoOwnersWorld());
  await s.loader.load();
  s.loader.noteWrite({ item: { projectNumber: 3, issueNumber: 99 } });
  s.clock.t += 5000;
  const out = await s.loader.load();
  assert.equal(has99(projectOf(out.bundle, OWNER, 3)), true);
  assert.equal(has99(projectOf(out.bundle, OTHER, 3)), false);
});

test('R70 a pending item\'s owner is matched without regard to case', async () => {
  const s = setup(twoOwnersWorld());
  await s.loader.load();
  s.loader.noteWrite({ item: { projectOwner: 'OTHER', projectNumber: 3, issueNumber: 99 } });
  s.clock.t += 5000;
  const out = await s.loader.load();
  assert.equal(has99(projectOf(out.bundle, OTHER, 3)), true);
  assert.equal(has99(projectOf(out.bundle, OWNER, 3)), false);
});

test('R70 a pending item for the other owner is not shown after ten minutes', async () => {
  const s = setup(twoOwnersWorld());
  await s.loader.load();
  s.loader.noteWrite({ item: { projectOwner: OTHER, projectNumber: 3, issueNumber: 99 } });
  s.clock.t += 601000;
  const out = await s.loader.load();
  assert.equal(has99(projectOf(out.bundle, OTHER, 3)), false);
});
