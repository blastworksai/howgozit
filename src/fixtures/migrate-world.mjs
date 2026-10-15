// CP8: a small three-owner world for the migration tests. One fake per owner, routed by owner. Every value is invented.
//   Elmwood (user)    Elmwood/howgozit, the source, with four old Projects and six issues
//   brightcraft (org)   brightcraft/blastworks-Woodshop (no book yet: apply creates it)
//   inkPress (org)         inkPress/inkPress
// `owners.forOwner(login)` is that owner's own client; `owners.default` routes a REST path by the owner in it
// and sends everything else (GraphQL, /user/repos) to the Elmwood fake, as the one token of the person who runs it.

import { createFakeGitHub } from './fake-github.mjs';
import { GitHubError } from '../board/github/http.mjs';

const SOURCE = 'Elmwood/howgozit';
const WL = 'brightcraft/blastworks-Woodshop';
const IN2 = 'inkPress/inkPress';
const BOOK = 'brightcraft/book';
const API = 'https://api.github.com';

const SETTINGS = {
  version: 1,
  name: 'Fake board',
  timezone: 'Europe/London',
  projects: [
    { key: 'woodshop', number: 1 },
    { key: 'inkpress', number: 2 },
    { key: 'bookshelf-planner', number: 3 },
    { key: 'road-to-a-garden', number: 4 },
  ],
  focus: [],
};

export function createMigrateWorld({ publicTarget } = {}) {
  const pub = publicTarget === undefined ? null : String(publicTarget).toLowerCase();
  if (pub !== null && ![WL, IN2, BOOK, SOURCE].some((r) => r.toLowerCase() === pub)) {
    throw new Error('migrate-world: publicTarget must name one of the world repositories: ' + publicTarget);
  }
  const isPrivate = (full) => pub !== full.toLowerCase();

  const einher = createFakeGitHub({
    repo: SOURCE, ownerType: 'user', isPrivate: isPrivate(SOURCE), login: 'Elmwood', statusOptions: true,
    files: { 'board.config.json': JSON.stringify(SETTINGS, null, 2) + '\n' },
  });
  const blast = createFakeGitHub({
    repo: WL, ownerType: 'organization', isPrivate: isPrivate(WL), login: 'Elmwood', statusOptions: true, dueShift: true, // targets store due_on as GitHub does (15 Oct)
    // a public book is the only way to meet it before apply: it is made to exist, public
    repos: pub === BOOK ? [{ name: BOOK, private: false }] : [],
  });
  const in2 = createFakeGitHub({
    repo: IN2, ownerType: 'organization', isPrivate: isPrivate(IN2), login: 'Elmwood', statusOptions: true, dueShift: true,
  });
  const fakes = { Elmwood: einher, brightcraft: blast, inkPress: in2 };

  // ---- seed the source (quietly: seeding is not a call) ----
  const rq = (m, p, b) => einher.direct.request(m, p, b);
  const gq = (q, v) => einher.direct.graphql(q, v);
  rq('POST', `/repos/${SOURCE}/labels`, { name: 'DO', color: '0E8A16' });
  rq('POST', `/repos/${SOURCE}/labels`, { name: 'idea', color: 'FBCA04' });
  for (const title of ['Woodshop · Launch', 'inkPress · Pilot', 'Someday']) {
    rq('POST', `/repos/${SOURCE}/milestones`, { title, description: title + ' goal', due_on: title === 'Someday' ? null : '2026-12-31T00:00:00Z' });
  }
  const issue = (title, extra = {}) => rq('POST', `/repos/${SOURCE}/issues`, { title, body: 'Body of ' + title, ...extra });
  issue('Ship the pricing page', { labels: ['DO'], milestone: 1 });        // #1
  issue('Old launch chore', { milestone: 1 });                              // #2
  rq('PATCH', `/repos/${SOURCE}/issues/2`, { state: 'closed' });
  issue('Pilot onboarding');                                                // #3
  issue('A loose idea', { labels: ['idea'] });                              // #4
  issue('Write the morning page');                                          // #5
  issue('Plan the BOOK board');                                             // #6

  const titles = ['Woodshop', 'inkPress', 'BOOK', 'Road'];
  titles.forEach((t) => {
    const p = gq('mutation { createProjectV2(input: {}) { projectV2 { id } } }', { ownerId: 'O_1', title: t }).createProjectV2.projectV2;
    const pj = einher.state.projects.find((x) => x.number === p.number);
    gq('mutation { createProjectV2Field(input: {}) { projectV2Field { id } } }', { projectId: pj.node_id, name: 'Due', dataType: 'DATE' });
  });
  const projectOf = (n) => einher.state.projects.find((x) => x.number === n);
  const add = (pn, num) => {
    rq('POST', `/users/Elmwood/projectsV2/${pn}/items`, { type: 'Issue', owner: 'Elmwood', repo: 'howgozit', number: num });
    return projectOf(pn).items.find((it) => it.content.number === num);
  };
  const onP1 = add(1, 1);
  add(1, 2);
  add(2, 3);
  add(4, 5);
  add(3, 6);
  const fieldOf = (p, name) => p.fields.find((f) => f.name === name);
  gq('mutation { updateProjectV2ItemFieldValue(input: {}) { projectV2Item { id } } }',
    { projectId: projectOf(1).node_id, itemId: onP1.node_id, fieldId: fieldOf(projectOf(1), 'Status').node_id, status: 'Doing' });
  gq('mutation { updateProjectV2ItemFieldValue(input: {}) { projectV2Item { id } } }',
    { projectId: projectOf(1).node_id, itemId: onP1.node_id, fieldId: fieldOf(projectOf(1), 'Due').node_id, date: '2026-11-01' });
  einher.seedComment(SOURCE, 1, { login: 'Elmwood', body: 'First note on the pricing page.', created_at: '2026-10-02T09:30:00Z' });
  einher.seedComment(SOURCE, 1, { login: 'helper-bot', body: 'Second note, from someone else.', created_at: '2026-10-03T22:45:00Z' });
  for (const f of Object.values(fakes)) f.calls.length = 0;

  // ---- routing and the shared, owner-tagged call log ----
  const byLower = new Map(Object.entries(fakes).map(([k, f]) => [k.toLowerCase(), f]));
  const seen = new Map(Object.keys(fakes).map((k) => [k, 0]));
  const log = [];
  const sync = () => {
    for (const [owner, f] of Object.entries(fakes)) {
      for (let i = seen.get(owner); i < f.calls.length; i += 1) log.push({ owner, ...f.calls[i] });
      seen.set(owner, f.calls.length);
    }
  };
  const tracked = (http) => {
    const wrap = (fn) => async (...a) => {
      try { return await fn(...a); } finally { sync(); }
    };
    return { get: wrap(http.get), paged: wrap(http.paged), send: wrap(http.send), graphql: wrap(http.graphql) };
  };
  const clients = Object.fromEntries(Object.entries(fakes).map(([k, f]) => [k, tracked(f.http)]));

  const ownerOfPath = (path) => {
    const p = String(path).startsWith(API) ? String(path).slice(API.length) : String(path);
    const m = /^\/(?:repos|orgs|users)\/([^/?]+)/.exec(p);
    if (!m) return 'Elmwood';
    const hit = byLower.get(decodeURIComponent(m[1]).toLowerCase());
    if (!hit) throw new GitHubError('not-found', 404);
    return Object.keys(fakes).find((k) => fakes[k] === hit);
  };
  const route = (name) => async (path, ...rest) => clients[ownerOfPath(path)][name](path, ...rest);
  const def = {
    get: route('get'),
    paged: route('paged'),
    send: async (method, path, body) => clients[ownerOfPath(path)].send(method, path, body),
    graphql: async (query, variables) => clients.Elmwood.graphql(query, variables),
  };
  const owners = {
    default: def,
    forOwner(login) {
      const hit = byLower.get(String(login).toLowerCase());
      return hit ? clients[Object.keys(fakes).find((k) => fakes[k] === hit)] : def;
    },
  };

  const map = {
    version: 1,
    source: SOURCE,
    projects: {
      woodshop: { old: { owner: 'Elmwood', number: 1 }, home: WL, projectOwner: 'brightcraft' },
      inkpress: { old: { owner: 'Elmwood', number: 2 }, home: IN2, projectOwner: 'inkPress' },
      'bookshelf-planner': { old: { owner: 'Elmwood', number: 3 }, home: BOOK, projectOwner: 'brightcraft' },
      'road-to-a-garden': { old: { owner: 'Elmwood', number: 4 }, home: SOURCE, projectOwner: 'Elmwood' },
    },
    ideas: { owner: 'Elmwood', title: 'Ideas' },
    habits: { owner: 'Elmwood', title: 'Habits', scoreField: 'Score', scored: [] },
    createRepos: [BOOK],
  };

  return {
    owners,
    fakes,
    map,
    calls() { sync(); return log.map((c) => ({ ...c })); },
  };
}
