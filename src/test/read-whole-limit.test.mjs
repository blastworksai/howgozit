import test from 'node:test';
import assert from 'node:assert/strict';
import { readAll } from '../board/github/read.mjs';
import { createGithubAdapter } from '../board/github/adapter.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { fakeHttp } from '../fixtures/github/fake-http.mjs';
import { REPO, OWNER, NOW, routes, projectFields } from '../fixtures/github/world.mjs';

// R116 (whole read, CP10): the limit of four is shared by the whole read; owner groups are read together;
// inside a group the homes do not wait for the Projects; the output follows the settings, never the completion order.
// World: the data owner (3 Projects), org-a (14 Projects, 10 homes), org-b (1 Project, 1 home).
// One shared fake answers every owner's client; counted: /projectsV2 requests, milestone lists of HOME repos, /users/<owner>.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const A = 'org-a';
const B = 'org-b';
const range = (count) => Array.from({ length: count }, (_, i) => i + 1);

function settingsText() {
  const projects = [
    ...range(3).map((number) => ({ number })),
    ...range(14).map((number) => ({ number, owner: A, ...(number <= 10 ? { home: A + '/home-' + number } : {}) })),
    { number: 1, owner: B, home: B + '/home-1' },
  ];
  return JSON.stringify({ projects });
}

const listOf = (count) => range(count).map((number) => ({ id: 9000 + number, number, title: 'Project ' + number, state: 'open' }));
const itemFor = (n) => [{ id: n, content_type: 'Issue', content: { number: 100 + n, repository: { full_name: REPO } },
  fields: [{ id: 101, name: 'Status', data_type: 'single_select', value: { id: 'a', name: { raw: 'Todo ' + n, html: 'x' }, color: 'GRAY' } }] }];

// delay(kind, n) -> ms for a counted request; `down` lists project-list paths answered 503
function build({ delay = () => 10, other = 5, down = [] } = {}) {
  const data = fakeHttp(routes({
    files: { 'board.config.json': settingsText() },
    projectList: listOf(3),
    fields: Object.fromEntries(range(3).map((n) => [n, projectFields()])),
    items: Object.fromEntries(range(3).map((n) => [n, itemFor(n)])),
  }));
  const m = {
    inFlight: 0, max: 0, groupsTogether: false, homeWithProject: false, users: [], counted: 0,
    live: {}, // group -> { project, home }
    homeStarts: {}, projectFinishes: {}, // group -> times (ms) of home milestone starts / Project fields+items finishes
  };
  const group = (kind, owner) => (m.live[owner] ??= { project: 0, home: 0 });

  function classify(p) {
    let r = /^\/(?:orgs|users)\/([^/]+)\/projectsV2/.exec(p);
    if (r) return { kind: 'project', owner: r[1] };
    r = /^\/repos\/([^/]+)\/(home-\d+)\/milestones\?/.exec(p);
    if (r) return { kind: 'home', owner: r[1] };
    r = /^\/users\/([^/]+)$/.exec(p);
    if (r) return { kind: 'owner', owner: r[1] };
    return null;
  }

  async function answer(method, p, options) {
    const c = classify(p);
    if (!c) {
      await sleep(other);
      const home = /^\/repos\/(org-[ab])\/(home-\d+)$/.exec(p);
      if (home) return { status: 200, json: { private: true, owner: { login: home[1], type: 'Organization' } }, notModified: false, link: null };
      return data[method](p, options);
    }
    const g = group(c.kind, c.owner);
    m.inFlight += 1;
    m.counted += 1;
    m.max = Math.max(m.max, m.inFlight);
    if (c.kind === 'owner') m.users.push(p);
    if (c.kind === 'project' || c.kind === 'home') g[c.kind] += 1;
    const active = Object.entries(m.live).filter(([, v]) => v.project + v.home > 0).map(([k]) => k);
    if (active.length > 1) m.groupsTogether = true;
    if (c.kind === 'home') (m.homeStarts[c.owner] ??= []).push(performance.now());
    try {
      await sleep(delay(c.kind, p));
      if (c.kind === 'owner') {
        return { status: 200, json: { login: c.owner, type: 'Organization' }, notModified: false, link: null };
      }
      if (c.kind === 'home') {
        const n = /home-(\d+)/.exec(p)[1];
        return { items: [{ id: 7000 + Number(n), number: Number(n), title: c.owner + ' ' + n, state: 'open', due_on: null, closed_at: null,
          html_url: 'https://github.com/' + c.owner + '/home-' + n + '/milestone/' + n, open_issues: 0, closed_issues: 0 }], partial: false };
      }
      // project requests
      if (down.some((d) => p.startsWith(d))) throw new GitHubError('server', 503, 'GitHub is not answering right now.');
      if (c.owner === OWNER) return data.paged(p, options);
      const list = new RegExp('^/orgs/' + c.owner + '/projectsV2\\?per_page=100$').test(p);
      if (list) return { items: c.owner === A ? listOf(14) : listOf(1), partial: false };
      if (/\/fields\?/.test(p)) return { items: projectFields(), partial: false };
      const n = Number(/projectsV2\/(\d+)\/items/.exec(p)[1]);
      return { items: itemFor(n), partial: false };
    } finally {
      m.inFlight -= 1;
      if (c.kind === 'project' || c.kind === 'home') g[c.kind] -= 1;
      if (c.kind === 'project' && /\/(fields|items)\?/.test(p)) (m.projectFinishes[c.owner] ??= []).push(performance.now());
    }
  }
  const http = {
    get: (p) => answer('get', p),
    paged: (p, o) => answer('paged', p, o),
  };
  return { http, m, data };
}

const read = (http, extra = {}) => readAll(http, { repo: REPO, full: true, now: NOW, httpFor: () => http, ...extra });

test('R116 three owner groups on a slow GitHub: groups together, a home started before the last Project request finished, never more than four project/home/owner requests', async () => {
  const { http, m } = build();
  await read(http);
  assert.ok(m.counted > 40, 'counted requests: ' + m.counted);
  assert.ok(m.groupsTogether, 'requests of two different groups were never in flight together');
  const firstHome = Math.min(...m.homeStarts[A]);
  const lastProject = Math.max(...m.projectFinishes[A]);
  assert.ok(firstHome < lastProject, 'org A: the first home milestone request started at ' + firstHome + ', after the last Project request finished at ' + lastProject);
  assert.ok(m.max <= 4, 'max in flight was ' + m.max);
  assert.ok(m.max >= 2, 'max in flight was ' + m.max);
});

test('R116 the board raw follows the settings, not the completion order', async () => {
  const plain = await read(build({ delay: () => 0, other: 0 }).http);
  const counter = { n: 0 };
  // answers come back in a scrambled order: the delay depends on the request, not on its place in the settings
  const scrambled = await read(build({ delay: (_k, p) => 2 + ((p.length * 7 + (counter.n++ * 5)) % 17) }).http);
  assert.deepEqual(scrambled.raw, plain.raw);
  assert.deepEqual(scrambled.warnings, plain.warnings);
  const numbers = (r) => r.raw.projects.map((p) => (p.owner || OWNER) + '#' + p.number);
  assert.equal(plain.raw.projects.length, 18);
  assert.deepEqual(numbers(scrambled), [
    ...range(3).map((n) => OWNER + '#' + n), ...range(14).map((n) => A + '#' + n), B + '#1']);
  assert.deepEqual(plain.raw.repos.filter((r) => r.role === 'home').map((r) => r.repo),
    [...range(10).map((n) => A + '/home-' + n), B + '/home-1']);
  assert.deepEqual(plain.raw.owners.map((o) => o.owner), [OWNER, A, B]);
});

test('R116 the second organisation answers its Project list 503: only its project is left out, with its notice', async () => {
  const { http } = build({ down: ['/orgs/' + B + '/projectsV2?'] });
  const out = await read(http);
  assert.equal(out.raw.projects.length, 17);
  assert.ok(!out.raw.projects.some((p) => p.owner === B));
  assert.equal(out.raw.projects.filter((p) => p.owner === A).length, 14);
  assert.equal(out.raw.projects.filter((p) => p.owner === undefined).length, 3);
  const b = out.raw.owners.find((o) => o.owner === B);
  assert.equal(b && b.ok, false);
  assert.ok(out.raw.owners.find((o) => o.owner === A).ok);
  const note = out.warnings.find((w) => w.code === 'project-owner-unreadable');
  assert.ok(note, 'no owner notice');
  assert.deepEqual(note.names, [B]);
  assert.equal(note.count, 1);
});

test('R116 an owner type is asked on a full read and held otherwise: a non-full read after a full one asks no /users/<owner>', async () => {
  const { http, m } = build();
  const adapter = createGithubAdapter({ http, httpFor: () => http, repo: REPO, configDir: null, readFile: async () => '', gh: {} });
  await adapter.read({ full: true, now: NOW });
  assert.deepEqual([...m.users].sort(), ['/users/' + A, '/users/' + B]);
  m.users.length = 0;
  await adapter.read({ full: false, now: NOW });
  assert.deepEqual(m.users, [], 'a non-full read asked ' + m.users.join(', '));
  await adapter.read({ full: true, now: NOW });
  assert.deepEqual([...m.users].sort(), ['/users/' + A, '/users/' + B]);
});
