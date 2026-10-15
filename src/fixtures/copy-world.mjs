// CP3: a small GitHub + Notion world for the copier tests (reference/notion-native/interface.md section 6). Every value is invented.
//   Elmwood      (user)  Elmwood/howgozit        data repo; projects 1 Road to a garden, 2 Ideas, 3 Habits
//   brightcraft  (org)   brightcraft/woodshop    shared home of projects 1 Woodshop and 2 Carpentry (number 1 reused by Elmwood)
//   inkPress     (org)   inkPress/press          home of project 1 Press
// One `fetch` serves api.github.com (REST by the owner in the path, GraphQL by the bearer token) and api.notion.com.
//   const w = await createCopyWorld();   // async: seedHowgozit builds the Notion schema through the fake
//   await main(['plan', '--notion', ids, '--out', dir], { env: w.env, fetch: w.fetch, cwd, out, err });

import { createFakeGitHub } from './fake-github.mjs';
import { createFakeNotion } from './fake-notion.mjs';
import { seedHowgozit } from './notion-howgozit.mjs';
import { GitHubError } from '../board/github/http.mjs';

const DATA = 'Elmwood/howgozit';
const WOOD = 'brightcraft/woodshop';
const PRESS = 'inkPress/press';
const API = 'https://api.github.com';
const NOTION_ORIGIN = 'https://api.notion.com';
const TOKENS = { Elmwood: 'ghp_fake_elmwood_0001', brightcraft: 'ghp_fake_brightcraft_0002', inkPress: 'ghp_fake_inkpress_0003' };
const NOTION_TOKEN = 'ntn_fake_copy_world_token_0001';

const SETTINGS = {
  version: 1,
  name: 'Fake board',
  timezone: 'Europe/Brussels',
  projects: [
    { key: 'garden', number: 1 },
    { key: 'woodshop', owner: 'brightcraft', number: 1, home: WOOD },
    { key: 'carpentry', owner: 'brightcraft', number: 2, home: WOOD },
    { key: 'press', owner: 'inkPress', number: 1, home: PRESS },
  ],
  modes: ['DO', 'THINK', 'REVIEW', 'LAUNCH'],
  ideas: { owner: 'Elmwood', number: 2 },
  habitsProject: { owner: 'Elmwood', number: 3 },
  habits: [
    { id: 'mood', title: 'Mood', project: 'garden', score: { min: 1, max: 10 } },
    { id: 'walk', title: 'Walk', project: 'garden' },
  ],
  focus: ['garden'],
};
const THEME = '{"radius":8,"accent":"#1d76db"}\n';
const STATE_LOG = '{"entries":[{"at":"2026-10-01","text":"first note"}]}\n';

const NEW_PROJECT = 'mutation { createProjectV2(input: {}) { projectV2 { id } } }';
const NEW_FIELD = 'mutation { createProjectV2Field(input: {}) { projectV2Field { id } } }';
const SET_VALUE = 'mutation { updateProjectV2ItemFieldValue(input: {}) { projectV2Item { id } } }';

function seedOwner(f, { repo, ownerType, owner, repoName, projectTitles, numberField = null }) {
  const rq = (m, p, b) => f.direct.request(m, p, b);
  const gq = (q, v) => f.direct.graphql(q, v);
  const base = (ownerType === 'user' ? '/users/' : '/orgs/') + owner + '/projectsV2';
  const projects = {};
  for (const title of projectTitles) {
    const p = gq(NEW_PROJECT, { ownerId: 'O_1', title }).createProjectV2.projectV2;
    const pj = f.state.projects.find((x) => x.number === p.number);
    gq(NEW_FIELD, { projectId: pj.node_id, name: 'Due', dataType: 'DATE' });
    if (numberField && numberField.title === title) gq(NEW_FIELD, { projectId: pj.node_id, name: numberField.name, dataType: 'NUMBER' });
    projects[title] = pj;
  }
  const add = (title, number) => {
    const pj = projects[title];
    rq('POST', `${base}/${pj.number}/items`, { type: 'Issue', owner, repo: repoName, number });
    return pj.items.find((it) => it.content.number === number);
  };
  const setStatus = (title, item, status) => gq(SET_VALUE, {
    projectId: projects[title].node_id, itemId: item.node_id, fieldId: projects[title].fields.find((x) => x.name === 'Status').node_id, status,
  });
  const setDue = (title, item, date) => gq(SET_VALUE, {
    projectId: projects[title].node_id, itemId: item.node_id, fieldId: projects[title].fields.find((x) => x.name === 'Due').node_id, date,
  });
  const setScore = (title, item, value) => {
    const fld = projects[title].fields.find((x) => x.name === 'Score');
    rq('PATCH', `${base}/${projects[title].number}/items/${item.id}`, { fields: [{ id: fld.id, value }] });
  };
  return { rq, gq, projects, add, setStatus, setDue, setScore, repo };
}

export async function createCopyWorld({ unknownStatus = false, twins = false } = {}) {
  const elm = createFakeGitHub({
    repo: DATA, ownerType: 'user', isPrivate: true, login: 'Elmwood', statusOptions: true,
    files: {
      'board.config.json': JSON.stringify(SETTINGS, null, 2) + '\n',
      'theme.json': THEME,
      'state/log.json': STATE_LOG,
    },
  });
  const bright = createFakeGitHub({ repo: WOOD, ownerType: 'organization', isPrivate: true, login: 'Elmwood', statusOptions: true, dueShift: true });
  const ink = createFakeGitHub({ repo: PRESS, ownerType: 'organization', isPrivate: true, login: 'Elmwood', statusOptions: true, dueShift: true });
  const fakes = { Elmwood: elm, brightcraft: bright, inkPress: ink };

  // ---- data repo (Elmwood, a user) ----
  const E = seedOwner(elm, { repo: DATA, ownerType: 'user', owner: 'Elmwood', repoName: 'howgozit', projectTitles: ['Road to a garden', 'Ideas', 'Habits'], numberField: { title: 'Habits', name: 'Score' } });
  const lab = (name, color) => E.rq('POST', `/repos/${DATA}/labels`, { name, color });
  lab('DO', '0E8A16'); lab('THINK', '5319E7'); lab('REVIEW', 'FBCA04'); lab('LAUNCH', 'AABBCC'); // LAUNCH is off the palette
  lab('habit:mood', 'ededed'); lab('habit:walk', 'ededed');
  E.rq('POST', `/repos/${DATA}/milestones`, { title: 'Road to a garden · First beds', description: 'goal', due_on: '2026-12-31T12:00:00Z' }); // 1
  E.rq('POST', `/repos/${DATA}/milestones`, { title: 'Someday', description: 'no date' });                                                           // 2
  const issue = (title, extra = {}) => E.rq('POST', `/repos/${DATA}/issues`, { title, body: 'Body of ' + title, ...extra });
  issue('Plan the beds', { labels: ['THINK', 'DO'], milestone: 1 });  // 1 open, Todo, two modes
  issue('Buy the seeds', { labels: ['REVIEW'], milestone: 1 });        // 2 open, In Progress, blocked by 1
  issue('Old chore');                                                   // 3 closed, must not be copied
  issue('Build the cold frame', { labels: ['LAUNCH'], milestone: 2 }); // 4 open, Todo, due
  issue('Learn to graft');                                              // 5 idea
  E.rq('PATCH', `/repos/${DATA}/issues/3`, { state: 'closed' });
  elm.seedBlockedBy(DATA, 2, [1]);
  const g = 'Road to a garden';
  E.setStatus(g, E.add(g, 1), 'Todo');
  const c2 = E.add(g, 2); E.setStatus(g, c2, unknownStatus ? 'Blocked' : 'In Progress'); E.setDue(g, c2, '2026-11-05');
  E.setStatus(g, E.add(g, 3), 'Done');
  const c4 = E.add(g, 4); E.setStatus(g, c4, 'Todo'); E.setDue(g, c4, '2026-11-20');
  E.add('Ideas', 5);
  if (twins) { // a second card with the same title, Project and Goal as card 1 (the copier cannot tell the two apart by what they say)
    const t = issue('Plan the beds', { labels: ['THINK', 'DO'], milestone: 1 }).number;
    E.setStatus(g, E.add(g, t), 'Todo');
  }

  // check-ins: two older than 120 days, closed the same day, closed a later day, one open
  const ci = (habit, label, date, close) => {
    const num = E.rq('POST', `/repos/${DATA}/issues`, { title: `${label} · ${date}`, labels: [`habit:${habit}`] }).number;
    if (close) E.rq('PATCH', `/repos/${DATA}/issues/${num}`, { state: 'closed' });
    return num;
  };
  ci('mood', 'Mood', '2026-05-01', true);
  ci('walk', 'Walk', '2026-05-02', false);
  const sameDay = ci('mood', 'Mood', '2026-10-01', true);        // closed 1 Oct (fake clock), title 1 Oct: done
  ci('walk', 'Walk', '2026-09-30', true);       // closed a later day: not done
  ci('mood', 'Mood', '2026-10-14', false);                       // open
  E.setScore('Habits', E.add('Habits', sameDay), 7);

  // ---- brightcraft: the shared home of Woodshop and Carpentry ----
  const B = seedOwner(bright, { repo: WOOD, ownerType: 'organization', owner: 'brightcraft', repoName: 'woodshop', projectTitles: ['Woodshop', 'Carpentry'] });
  B.rq('POST', `/repos/${WOOD}/milestones`, { title: 'Shop tour', description: 'nobody has an open card here', due_on: '2026-11-30T12:00:00Z' }); // 1, no open card
  B.rq('POST', `/repos/${WOOD}/milestones`, { title: 'Bench', description: 'goal', due_on: '2026-12-15T12:00:00Z' });                                    // 2
  B.rq('POST', `/repos/${WOOD}/labels`, { name: 'DO', color: '0E8A16' });
  B.rq('POST', `/repos/${WOOD}/issues`, { title: 'Sand the bench', labels: ['DO'], milestone: 2 }); // 1, on both projects
  B.rq('POST', `/repos/${WOOD}/issues`, { title: 'Oil the saw' });                                   // 2, Carpentry only
  B.setStatus('Woodshop', B.add('Woodshop', 1), 'Todo');
  B.setStatus('Carpentry', B.add('Carpentry', 1), 'In Progress');
  B.add('Carpentry', 2);

  // ---- inkPress ----
  const I = seedOwner(ink, { repo: PRESS, ownerType: 'organization', owner: 'inkPress', repoName: 'press', projectTitles: ['Press'] });
  I.rq('POST', `/repos/${PRESS}/milestones`, { title: 'First print', description: 'goal', due_on: '2026-11-15T12:00:00Z' }); // 1
  I.rq('POST', `/repos/${PRESS}/issues`, { title: 'Set the type', milestone: 1 });
  I.setStatus('Press', I.add('Press', 1), 'Todo');

  for (const f of Object.values(fakes)) f.calls.length = 0;

  // ---- notion ----
  const notion = createFakeNotion({ token: NOTION_TOKEN });
  const seeded = await seedHowgozit(notion);
  notion.calls.length = 0;
  const notionIds = { projects: seeded.projects, tasks: seeded.tasks, goals: seeded.goals, habitLog: seeded.habitLog };

  // ---- one fetch for both hosts ----
  const owners = Object.keys(fakes);
  const ownerByToken = new Map(Object.entries(TOKENS).map(([o, t]) => [t, o]));
  const ownerOfPath = (p) => {
    const m = /^\/(?:repos|orgs|users)\/([^/?]+)/.exec(p);
    if (!m) return 'Elmwood';
    const hit = owners.find((o) => o.toLowerCase() === decodeURIComponent(m[1]).toLowerCase());
    if (!hit) throw new GitHubError('not-found', 404);
    return hit;
  };
  const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const githubFetch = async (u, init) => {
    const method = String(init.method || 'GET').toUpperCase();
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    const who = ownerByToken.get(String(auth).replace(/^Bearer /, ''));
    if (!who) return json(401, { message: 'Bad credentials' });
    let path = u.pathname + u.search;
    try {
      if (path === '/graphql') {
        const b = JSON.parse(String(init.body));
        try {
          return json(200, { data: await fakes[who].http.graphql(b.query, b.variables) });
        } catch (e) {
          if (e instanceof GitHubError) return json(200, { errors: [{ message: e.message, type: e.kind === 'not-found' ? 'NOT_FOUND' : 'INVALID' }] });
          throw e;
        }
      }
      const f = fakes[ownerOfPath(u.pathname)];
      if (method === 'GET') {
        const got = await f.http.get(path);
        return json(200, got.json, got.link ? { link: got.link } : {});
      }
      const out = await f.http.send(method, path, init.body === undefined ? undefined : JSON.parse(String(init.body)));
      return out === null ? new Response(null, { status: 204 }) : json(200, out);
    } catch (e) {
      if (e instanceof GitHubError) return json(e.status || 500, { message: e.message });
      throw e;
    }
  };
  const fetch = async (input, init = {}) => {
    const u = new URL(String(input && input.url ? input.url : input));
    if (u.origin === API) return githubFetch(u, init);
    if (u.origin === NOTION_ORIGIN) return notion.fetch(input, init);
    throw new TypeError('fetch failed');
  };

  const env = {
    BOARD_GITHUB_TOKEN: TOKENS.Elmwood,
    BOARD_REPO: DATA,
    BOARD_GITHUB_TOKEN_1: TOKENS.brightcraft, BOARD_GITHUB_OWNER_1: 'brightcraft',
    BOARD_GITHUB_TOKEN_2: TOKENS.inkPress, BOARD_GITHUB_OWNER_2: 'inkPress',
    BOARD_NOTION_TOKEN: NOTION_TOKEN,
  };
  return { github: { fakes, ...fakes, calls: () => Object.entries(fakes).flatMap(([owner, f]) => f.calls.map((c) => ({ owner, ...c }))) }, notion, notionIds, env, fetch, settings: SETTINGS };
}

// Two cards with identical title, Project and Goal.
export const twinCardsWorld = () => createCopyWorld({ twins: true });

// One open card carries a Status the copier has no Notion match for.
export const unknownStatusWorld = () => createCopyWorld({ unknownStatus: true });
