// CP4 (SKILLS-76) job D1, reader half: home repos, cards from Project items, the Habits window, repo privacy, field ids.
// Written from the rule text (R4, R68, R69, R72, R141) and reference/mapping-redesign/cp4-interface.md, not from the code.
// Every answer is invented and served by a local fake of the `http` object; no network and no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAll } from '../board/github/read.mjs';
import { GitHubError } from '../board/github/http.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const HOME = 'sam-life/x';
const R = '/repos/' + REPO;
const P = '/orgs/' + OWNER + '/projectsV2';
const NOW = '2026-10-12T06:10:00Z';
const SINCE = '2026-10-12T06:05:00Z';

const FIELDS = [
  { id: 100, name: 'Title', data_type: 'title' },
  { id: 101, name: 'Status', data_type: 'single_select' },
  { id: 102, name: 'Due', data_type: 'date' },
  { id: 103, name: 'Labels', data_type: 'labels' },
];
const HABIT_FIELDS = [...FIELDS, { id: 104, name: 'Score', data_type: 'number' }];

function b64(text) {
  return { name: 'file', type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') };
}

function apiIssue(repoFull, number, extra = {}) {
  return {
    id: number * 10, number, title: 'Task ' + number, state: 'open', state_reason: null,
    labels: [], milestone: null, comments: 0,
    created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
    html_url: 'https://github.com/' + repoFull + '/issues/' + number,
    repository: { full_name: repoFull },
    ...extra,
  };
}

const status = (name) => ({ id: 101, name: 'Status', data_type: 'single_select', value: { id: 'a', name: { raw: name, html: name }, color: 'GREEN' } });
const due = (value) => ({ id: 102, name: 'Due', data_type: 'date', value });

// An Issue item of a Project: the item's content carries the whole issue.
function issueItem(repoFull, number, extra = {}, withFields = true) {
  return {
    id: number, content_type: 'Issue', content: apiIssue(repoFull, number, extra),
    fields: withFields ? [status('Todo'), due(null)] : [],
  };
}

// A mutable world and an http fake that answers by path shape.
// w.settings: object (the board.config.json), w.dataIssues, w.sinceIssues, w.items (project number -> list | fn),
// w.fields (project number -> list), w.projectNumbers, w.homePrivate, w.homeMilestones.
function makeWorld(over = {}) {
  const w = {
    settings: { version: 1, timezone: 'UTC', projects: [{ number: 3, home: HOME }] },
    dataIssues: [apiIssue(REPO, 12, { title: 'Paint the hallway' })],
    sinceIssues: [],
    items: { 3: [] },
    fields: { 3: FIELDS },
    projectNumbers: [3],
    homePrivate: true,
    homeMilestones: [],
    calls: [],
    ...over,
  };
  function answer(method, p) {
    w.calls.push({ method, path: p });
    if (p === R) return { private: true, default_branch: 'main', owner: { login: OWNER, type: 'Organization' } };
    if (p === '/repos/' + HOME || p === '/repos/sam-life/home') return { private: w.homePrivate, owner: { login: OWNER, type: 'Organization' } };
    if (p === R + '/contents/board.config.json') return b64(JSON.stringify(w.settings));
    if (p.startsWith(R + '/contents/')) throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
    if (p.startsWith(R + '/issues?')) return { items: p.includes('&since=') ? w.sinceIssues : w.dataIssues, partial: false };
    if (p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    let m = /^\/repos\/([^/]+\/[^/]+)\/milestones\?/.exec(p);
    if (m) return { items: w.homeMilestones, partial: false };
    if (p === P + '?per_page=100') {
      return { items: w.projectNumbers.map((n) => ({ number: n, title: 'Project ' + n, state: 'open' })), partial: false };
    }
    m = /^\/orgs\/sam-life\/projectsV2\/(\d+)\/fields\?/.exec(p);
    if (m) return { items: w.fields[m[1]] || [], partial: false };
    m = /^\/orgs\/sam-life\/projectsV2\/(\d+)\/items\?/.exec(p);
    if (m) {
      const v = w.items[m[1]] || [];
      return { items: typeof v === 'function' ? v(p) : v, partial: false };
    }
    throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
  }
  w.http = {
    async get(p) { return { status: 200, json: answer('get', p), notModified: false, link: null }; },
    async paged(p) { return answer('paged', p); },
  };
  w.paths = (re) => w.calls.map((c) => c.path).filter((p) => re.test(p));
  return w;
}

const read = (w, args = {}) => readAll(w.http, { repo: REPO, full: true, now: NOW, ...args });
const fieldsCalls = (w, n) => w.paths(new RegExp('^' + P + '/' + n + '/fields\\?'));
const itemsCalls = (w, n) => w.paths(new RegExp('^' + P + '/' + n + '/items\\?'));
const withRef = (raw) => raw.issues.filter((i) => typeof i.ref === 'string');

test('R4 an Issue item of a project with a home gives a card built from the item\'s issue', async () => {
  const w = makeWorld({ items: { 3: [issueItem(HOME, 5, { title: 'Sand the floor', labels: [{ name: 'home' }] })] } });
  const { raw } = await read(w);
  const card = raw.issues.find((i) => i.ref === HOME + '#5');
  assert.ok(card, 'a card with ref ' + HOME + '#5');
  assert.equal(card.repo, HOME);
  assert.equal(card.number, 5);
  assert.equal(card.title, 'Sand the floor');
  assert.equal(card.state, 'open');
  assert.deepEqual(card.labels, ['home']);
  assert.ok(raw.issues.some((i) => i.number === 12), 'the data repo\'s own issues are still there');
});

test('R4 items a/x#5 and a/y#5 are two cards, because two cards are the same only when their refs are equal', async () => {
  const w = makeWorld({ items: { 3: [issueItem('sam-life/x', 5), issueItem('sam-life/y', 5)] } });
  const { raw } = await read(w);
  assert.deepEqual(withRef(raw).map((i) => i.ref).sort(), ['sam-life/x#5', 'sam-life/y#5']);
  assert.deepEqual(withRef(raw).map((i) => i.number), [5, 5]);
});

test('R4 the same item twice, with the ref spelt in a different case, is one card', async () => {
  const w = makeWorld({ items: { 3: [issueItem('sam-life/x', 5), issueItem('Sam-Life/X', 5)] } });
  const { raw } = await read(w);
  assert.equal(withRef(raw).length, 1);
});

test('R4 a PullRequest item, a DraftIssue item and an Issue item of the data repo give no home card', async () => {
  const pr = { id: 8, content_type: 'PullRequest', content: { number: 8, repository: { full_name: HOME } }, fields: [] };
  const draft = { id: 9, content_type: 'DraftIssue', content: { title: 'Buy paint' }, fields: [] };
  const mine = issueItem(REPO, 12, { title: 'Paint the hallway' });
  const w = makeWorld({ items: { 3: [pr, draft, mine] } });
  const { raw } = await read(w);
  assert.equal(withRef(raw).length, 0);
  assert.equal(raw.issues.filter((i) => i.number === 12).length, 1, 'the data repo issue is not doubled');
});

test('R4 the item row of a home card stays an item row with type, repo, number, status and due', async () => {
  const w = makeWorld({ items: { 3: [issueItem(HOME, 5)] } });
  const { raw } = await read(w);
  assert.deepEqual(raw.projects[0].items, [{ type: 'Issue', repo: HOME, number: 5, status: 'Todo', due: null }]);
});

test('R4 with no home, an Issue item of another repo gives no card, no extra rows and no new raw keys', async () => {
  const w = makeWorld({
    settings: { version: 1, timezone: 'UTC', projects: [{ number: 3 }] },
    items: { 3: [issueItem('sam-life/x', 5), issueItem('sam-life/y', 5)] },
  });
  const { raw } = await read(w);
  assert.deepEqual(raw.issues.map((i) => i.number), [12]);
  assert.equal(withRef(raw).length, 0);
  for (const key of ['repos', 'labelColors']) assert.equal(Object.hasOwn(raw, key), false, key);
  assert.equal(raw.milestones.length, 0);
  assert.equal(w.paths(/\/repos\/sam-life\/[xy](\/|$)/).length, 0, 'no request leaves for another repo');
});

test('R68 the Habits Project\'s items address carries q=updated:>= and the date 120 days before today', async () => {
  const w = makeWorld({
    settings: { version: 1, timezone: 'UTC', projects: [{ number: 3 }], habitsProject: { owner: OWNER, number: 9 } },
    projectNumbers: [3, 9],
    fields: { 3: FIELDS, 9: HABIT_FIELDS },
    items: { 3: [], 9: [] },
  });
  await read(w);
  const habits = itemsCalls(w, 9);
  assert.equal(habits.length, 1);
  assert.ok(habits[0].includes('q=updated:>=2026-06-14'), habits[0]);
  const business = itemsCalls(w, 3);
  assert.equal(business.length, 1);
  assert.equal(business[0].includes('q='), false, 'an ordinary Project\'s items carry no q');
});

test('R68 the window start is today in the settings timezone, not in UTC', async () => {
  // 2026-10-12 20:00 UTC is already 2026-10-13 in Auckland (UTC+13 in October).
  const settings = { version: 1, timezone: 'Pacific/Auckland', projects: [{ number: 3 }], habitsProject: { owner: OWNER, number: 9 } };
  const w = makeWorld({ settings, projectNumbers: [3, 9], fields: { 3: FIELDS, 9: HABIT_FIELDS }, items: { 3: [], 9: [] } });
  await read(w, { now: '2026-10-12T20:00:00Z' });
  assert.ok(itemsCalls(w, 9)[0].includes('q=updated:>=2026-06-15'), itemsCalls(w, 9)[0]);
  const utc = makeWorld({ settings: { ...settings, timezone: 'UTC' }, projectNumbers: [3, 9], fields: { 3: FIELDS, 9: HABIT_FIELDS }, items: { 3: [], 9: [] } });
  await read(utc, { now: '2026-10-12T20:00:00Z' });
  assert.ok(itemsCalls(utc, 9)[0].includes('q=updated:>=2026-06-14'), itemsCalls(utc, 9)[0]);
});

test('R72 a full read asks for the home repo\'s privacy and records it; a following load that is not full does not ask again', async () => {
  const w = makeWorld({ homePrivate: true });
  const first = await read(w);
  assert.equal(w.paths(new RegExp('^/repos/' + HOME + '$')).length, 1);
  const home = first.raw.repos.find((r) => r.role === 'home');
  assert.deepEqual(home, { repo: HOME, private: true, role: 'home' });
  assert.deepEqual(first.raw.repos.find((r) => r.role === 'data'), { repo: REPO, private: true, role: 'data' });

  const next = makeWorld({ homePrivate: true });
  await read(next, { full: false, since: SINCE, previous: first.raw });
  assert.equal(next.paths(new RegExp('^/repos/' + HOME + '$')).length, 0);
});

test('R72 a load that is not full carries the home repo\'s privacy from the previous read', async () => {
  const w = makeWorld({ homePrivate: false });
  const first = await read(w);
  assert.equal(first.raw.repos.find((r) => r.role === 'home').private, false);
  const next = makeWorld({ homePrivate: true });
  const second = await read(next, { full: false, since: SINCE, previous: first.raw });
  assert.equal(second.raw.repos.find((r) => r.role === 'home').private, false, 'not re-read, so still what the full read saw');
});

test('R72 a second full read asks for the privacy again', async () => {
  const w = makeWorld();
  const first = await read(w);
  await read(w, { previous: first.raw });
  assert.equal(w.paths(new RegExp('^/repos/' + HOME + '$')).length, 2);
});

test('R72 a non-full read whose previous read knew nothing of the home repo asks for its privacy', async () => {
  const w = makeWorld();
  const first = await read(makeWorld({ settings: { version: 1, timezone: 'UTC', projects: [{ number: 3 }] } }));
  const second = await read(w, { full: false, since: SINCE, previous: first.raw });
  assert.equal(w.paths(new RegExp('^/repos/' + HOME + '$')).length, 1);
  assert.equal(second.raw.repos.find((r) => r.role === 'home').private, true);
});

test('R72 with no home the snapshot has no repos list and no request leaves for a home repo', async () => {
  const w = makeWorld({ settings: { version: 1, timezone: 'UTC', projects: [{ number: 3 }] } });
  const { raw } = await read(w);
  assert.equal(Object.hasOwn(raw, 'repos'), false);
});

test('R141 two loads sharing one field cache ask the fields address once', async () => {
  const w = makeWorld({ items: { 3: [issueItem(HOME, 5)] } });
  const fieldCache = new Map();
  const first = await read(w, { fieldCache });
  await read(w, { full: false, since: SINCE, previous: first.raw, fieldCache });
  assert.equal(fieldsCalls(w, 3).length, 1);
  const items = itemsCalls(w, 3);
  assert.equal(items.length, 2);
  assert.match(items[1], /fields=[^&]*101/, 'the second load names the Status field id it already knew');
});

test('R141 the full read reads the fields list again, even when the cache knows the Project', async () => {
  const w = makeWorld();
  const fieldCache = new Map();
  await read(w, { fieldCache });
  await read(w, { fieldCache });
  assert.equal(fieldsCalls(w, 3).length, 2);
});

test('R141 a direct caller with no field cache gets a fresh one each time, so each read asks the fields address', async () => {
  const w = makeWorld();
  const first = await read(w);
  await read(w, { full: false, since: SINCE, previous: first.raw });
  assert.equal(fieldsCalls(w, 3).length, 2);
});

test('R141 an items page that comes back without a field it asked for makes the board read the fields list again, then the items with the new ids', async () => {
  let lacking = false;
  const w = makeWorld({
    items: {
      3: () => {
        if (!lacking) return [issueItem(HOME, 5)];
        lacking = false; // only the first items read of the second load is short
        return [issueItem(HOME, 5, {}, false)];
      },
    },
  });
  const fieldCache = new Map();
  const first = await read(w, { fieldCache });
  assert.equal(fieldsCalls(w, 3).length, 1);
  lacking = true;
  // The Due field was deleted and made again on GitHub, so it has a new id.
  w.fields = { 3: FIELDS.map((f) => (f.name === 'Due' ? { ...f, id: 202 } : f)) };
  const second = await read(w, { full: false, since: SINCE, previous: first.raw, fieldCache });
  assert.equal(fieldsCalls(w, 3).length, 2, 'the fields list was read again');
  const items = itemsCalls(w, 3);
  assert.equal(items.length, 3, 'one items read in the first load, two in the second');
  assert.match(items[2], /fields=101,202/, 'the second items read of the second load asks the new id');
  assert.deepEqual(second.raw.projects[0].items.map((i) => i.status), ['Todo'], 'the second items read is the one kept');
});

test('R141 an items page without an asked field whose ids have not changed reads the fields list again but not the same items address twice', async () => {
  let lacking = false;
  const w = makeWorld({
    items: {
      3: () => {
        if (!lacking) return [issueItem(HOME, 5)];
        lacking = false;
        return [issueItem(HOME, 5, {}, false)];
      },
    },
  });
  const fieldCache = new Map();
  const first = await read(w, { fieldCache });
  lacking = true;
  await read(w, { full: false, since: SINCE, previous: first.raw, fieldCache });
  assert.equal(fieldsCalls(w, 3).length, 2, 'the fields list was read again');
  assert.equal(itemsCalls(w, 3).length, 2, 'the same address is not asked twice in one load');
});

test('R141 an items read refused as not found while using the known ids makes the board read the fields list again and ask once more', async () => {
  let refuse = false;
  const w = makeWorld({
    items: {
      3: () => {
        if (!refuse) return [issueItem(HOME, 5)];
        refuse = false;
        throw new GitHubError('not-found', 404, 'Nothing is stored here.');
      },
    },
  });
  const fieldCache = new Map();
  const first = await read(w, { fieldCache });
  refuse = true;
  const second = await read(w, { full: false, since: SINCE, previous: first.raw, fieldCache });
  assert.equal(fieldsCalls(w, 3).length, 2);
  assert.equal(second.raw.projects[0].items.length, 1);
});

test('R69 a stored home row and a fresh item for the same ref give one row, from the fresh item', async () => {
  const w = makeWorld({ items: { 3: [issueItem(HOME, 5, { title: 'Old title' })] } });
  const first = await read(w);
  assert.equal(first.raw.issues.find((i) => i.ref === HOME + '#5').title, 'Old title');
  w.items = { 3: [issueItem(HOME, 5, { title: 'New title' })] };
  const second = await read(w, { full: false, since: SINCE, previous: first.raw, fieldCache: new Map() });
  const rows = second.raw.issues.filter((i) => i.ref === HOME + '#5');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'New title');
});

test('R69 a stored issue a/x#5 and a changed data-repo issue number 5 are both held', async () => {
  const w = makeWorld({ items: { 3: [issueItem(HOME, 5, { title: 'In the home repo' })] } });
  const first = await read(w);
  w.sinceIssues = [apiIssue(REPO, 5, { title: 'In the data repo' })];
  const second = await read(w, { full: false, since: SINCE, previous: first.raw, fieldCache: new Map() });
  const fives = second.raw.issues.filter((i) => i.number === 5);
  assert.equal(fives.length, 2);
  assert.equal(fives.filter((i) => i.repo === HOME).length, 1);
  assert.equal(fives.find((i) => i.repo === HOME).title, 'In the home repo');
  const other = fives.find((i) => i.repo !== HOME);
  assert.equal(other.title, 'In the data repo');
});

test('R69 a changed issue of the data repo still replaces its stored row by number', async () => {
  const w = makeWorld({ items: { 3: [issueItem(HOME, 5)] } });
  const first = await read(w);
  w.sinceIssues = [apiIssue(REPO, 12, { title: 'Paint the hallway twice', updated_at: '2026-10-12T06:06:00Z' })];
  const second = await read(w, { full: false, since: SINCE, previous: first.raw, fieldCache: new Map() });
  const twelve = second.raw.issues.filter((i) => i.number === 12);
  assert.equal(twelve.length, 1);
  assert.equal(twelve[0].title, 'Paint the hallway twice');
});
