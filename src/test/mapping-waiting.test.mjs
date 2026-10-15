// CP5 (SKILLS-77) job D: waiting on. The reader half (R133), the model half (R27, R134) and the page half (R134).
// Written from references/contract.md (R27, R133, R134) and reference/mapping-redesign/cp5-interface.md, not from the code.
// Every answer is invented; the reader is served by a local fake of the `http` object, the model and page by hand-made raw.
// Fixed now: 2026-10-12. No network, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAll } from '../board/github/read.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { settings, project, task, raw, resetNumbers, board } from '../fixtures/build.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

// =====================================================================================
// Reader half (R133)
// =====================================================================================

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const HOME = 'sam-life/x';
const OTHER_OWNER = 'other-org';
const OTHER_HOME = 'other-org/y';
const R = '/repos/' + REPO;
const NOW = '2026-10-12T06:10:00Z';
const SINCE = '2026-10-12T06:05:00Z';
const FIELDS = [
  { id: 100, name: 'Title', data_type: 'title' },
  { id: 101, name: 'Status', data_type: 'single_select' },
  { id: 102, name: 'Due', data_type: 'date' },
  { id: 103, name: 'Labels', data_type: 'labels' },
];

function b64(text) {
  return { name: 'file', type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') };
}
const summary = (blockedBy) => ({ blocked_by: blockedBy, blocking: 0, total_blocked_by: blockedBy, total_blocking: 0 });

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
// A blocker as GitHub answers it: a full Issue object whose repository_url names the repo.
function blocker(repoFull, number, extra = {}) {
  return {
    number, title: 'Blocker ' + number, state: 'open',
    html_url: 'https://github.com/' + repoFull + '/issues/' + number,
    repository_url: 'https://api.github.com/repos/' + repoFull,
    ...extra,
  };
}
const status = (name) => ({ id: 101, name: 'Status', data_type: 'single_select', value: { id: 'a', name: { raw: name, html: name }, color: 'GREEN' } });
const due = (value) => ({ id: 102, name: 'Due', data_type: 'date', value });
function issueItem(repoFull, number, extra = {}) {
  return { id: number, content_type: 'Issue', content: apiIssue(repoFull, number, extra), fields: [status('Todo'), due(null)] };
}

// w.blockers: 'owner/repo#n' -> list of blocker objects the blocked-by address answers.
// Each client tags its calls, so a test can see which client asked: `data` is the `http` given to readAll,
// `for:<owner>` is whatever httpFor(<owner>) returned.
function makeWorld(over = {}) {
  const w = {
    settings: { version: 1, timezone: 'UTC', projects: [{ number: 3, home: HOME }] },
    dataIssues: [apiIssue(REPO, 12, { title: 'Paint the hallway' })],
    sinceIssues: [],
    items: { 3: [] },
    otherItems: [],
    blockers: {},
    calls: [],
    ...over,
  };
  function answer(via, method, p, opts) {
    w.calls.push({ via, method, path: p, opts });
    if (p === R) return { private: true, default_branch: 'main', owner: { login: OWNER, type: 'Organization' } };
    if (p === '/repos/' + HOME) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p === '/repos/' + OTHER_HOME) return { private: true, owner: { login: OTHER_OWNER, type: 'Organization' } };
    if (p === '/users/' + OTHER_OWNER) return { login: OTHER_OWNER, type: 'Organization' };
    if (p === R + '/contents/board.config.json') return b64(JSON.stringify(w.settings));
    if (p.startsWith(R + '/contents/')) throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
    if (p.startsWith(R + '/issues?')) return { items: p.includes('&since=') ? w.sinceIssues : w.dataIssues, partial: false };
    if (/\/milestones\?/.test(p)) return { items: [], partial: false };
    let m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/dependencies\/blocked_by\?/.exec(p);
    if (m) {
      const key = m[1] + '#' + m[2];
      if (!(key in w.blockers)) throw new GitHubError('not-found', 404, 'No answer set for ' + key + '.');
      return { items: w.blockers[key], partial: false };
    }
    if (p === '/orgs/' + OWNER + '/projectsV2?per_page=100') return { items: [{ number: 3, title: 'Project 3', state: 'open' }], partial: false };
    if (p === '/orgs/' + OTHER_OWNER + '/projectsV2?per_page=100') return { items: [{ number: 4, title: 'Project 4', state: 'open' }], partial: false };
    m = /^\/orgs\/([^/]+)\/projectsV2\/(\d+)\/fields\?/.exec(p);
    if (m) return { items: FIELDS, partial: false };
    m = /^\/orgs\/([^/]+)\/projectsV2\/(\d+)\/items\?/.exec(p);
    if (m) return { items: m[1] === OTHER_OWNER ? w.otherItems : (w.items[m[2]] || []), partial: false };
    throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
  }
  const client = (via) => ({
    async get(p, opts) { return { status: 200, json: answer(via, 'get', p, opts), notModified: false, link: null }; },
    async paged(p, opts) { return answer(via, 'paged', p, opts); },
  });
  w.http = client('data');
  w.httpFor = (owner) => client('for:' + owner);
  w.deps = () => w.calls.filter((c) => /\/dependencies\//.test(c.path));
  return w;
}

const read = (w, args = {}) => readAll(w.http, { repo: REPO, full: true, now: NOW, httpFor: w.httpFor, ...args });
const depPath = (repoFull, n) => `/repos/${repoFull}/issues/${n}/dependencies/blocked_by?per_page=100`;
const cardOf = (raw, ref) => raw.issues.find((i) => i.ref === ref);
const dataIssue = (raw, n) => raw.issues.find((i) => i.number === n && typeof i.ref !== 'string');

test('R133 a data-repo card with summary 0 and a card with no summary cause no blocked-by request', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(0) }), apiIssue(REPO, 13)],
    items: { 3: [issueItem(HOME, 5, { issue_dependencies_summary: summary(0) })] },
  });
  const { raw } = await read(w);
  assert.equal(w.deps().length, 0);
  for (const row of raw.issues) assert.equal(Object.hasOwn(row, 'waitingOn'), false, 'no waitingOn on ' + (row.ref ?? row.number));
});

test('R133 a data-repo card with 2 blockers of which one is closed gives one entry with ref, title and url', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(2) })],
    blockers: {
      [REPO + '#12']: [
        blocker(REPO, 7, { title: 'Buy paint' }),
        blocker(REPO, 8, { title: 'Old thing', state: 'closed' }),
      ],
    },
  });
  const { raw } = await read(w);
  assert.deepEqual(dataIssue(raw, 12).waitingOn, [
    { ref: REPO + '#7', title: 'Buy paint', url: 'https://github.com/' + REPO + '/issues/7' },
  ]);
});

test('R133 a card whose blockers are all closed has no waitingOn key', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(1) })],
    blockers: { [REPO + '#12']: [blocker(REPO, 8, { state: 'closed' })] },
  });
  const { raw } = await read(w);
  assert.equal(w.deps().length, 1, 'it was asked');
  assert.equal(Object.hasOwn(dataIssue(raw, 12), 'waitingOn'), false);
});

test('R133 a closed card with summary 2 is never asked', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { state: 'closed', state_reason: 'completed', closed_at: '2026-10-05T09:00:00Z', issue_dependencies_summary: summary(2) })],
    blockers: { [REPO + '#12']: [blocker(REPO, 7)] },
  });
  const { raw } = await read(w);
  assert.equal(w.deps().length, 0);
  assert.equal(Object.hasOwn(dataIssue(raw, 12), 'waitingOn'), false);
});

test('R133 the blocked-by address is /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by?per_page=100, asked once, one page', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(1) })],
    blockers: { [REPO + '#12']: [blocker(REPO, 7)] },
  });
  await read(w);
  const deps = w.deps();
  assert.equal(deps.length, 1);
  assert.equal(deps[0].path, depPath(REPO, 12));
  assert.equal(deps[0].method, 'paged');
  assert.equal(deps[0].opts && deps[0].opts.maxPages, 1);
});

test('R133 a data-repo card is asked with the data repo\'s client', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(1) })],
    blockers: { [REPO + '#12']: [blocker(REPO, 7)] },
  });
  await read(w);
  assert.equal(w.deps()[0].via, 'data');
});

test('R133 a blocker in a repo the board does not read keeps its ref and has title null and url null', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(1) })],
    blockers: { [REPO + '#12']: [blocker('stranger/elsewhere', 3, { title: 'Secret title' })] },
  });
  const { raw } = await read(w);
  assert.deepEqual(dataIssue(raw, 12).waitingOn, [{ ref: 'stranger/elsewhere#3', title: null, url: null }]);
});

test('R133 a blocker in the data repo or in a home repo keeps its title and url, whatever the case of the repo in the answer', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(2) })],
    blockers: {
      [REPO + '#12']: [
        blocker('Sam-Life/X', 4, { title: 'In the home repo', html_url: 'https://github.com/sam-life/x/issues/4' }),
        blocker(REPO, 9, { title: 'In the data repo' }),
      ],
    },
  });
  const { raw } = await read(w);
  const got = dataIssue(raw, 12).waitingOn;
  assert.equal(got.length, 2);
  assert.equal(got[0].ref.toLowerCase(), 'sam-life/x#4');
  assert.equal(got[0].title, 'In the home repo');
  assert.equal(got[0].url, 'https://github.com/sam-life/x/issues/4');
  assert.equal(got[1].title, 'In the data repo');
});

test('R133 a blocker with no usable repository_url is skipped', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(2) })],
    blockers: { [REPO + '#12']: [blocker(REPO, 7, { repository_url: 'not-a-url' }), blocker(REPO, 8)] },
  });
  const { raw } = await read(w);
  assert.deepEqual(dataIssue(raw, 12).waitingOn.map((b) => b.ref), [REPO + '#8']);
});

test('R133 a home card with a summary is asked, through the client httpFor gives for its owner', async () => {
  const w = makeWorld({
    items: { 3: [issueItem(HOME, 5, { issue_dependencies_summary: summary(1) })] },
    blockers: { [HOME + '#5']: [blocker(HOME, 6, { title: 'Sand first' })] },
  });
  const { raw } = await read(w);
  const deps = w.deps();
  assert.equal(deps.length, 1);
  assert.equal(deps[0].path, depPath(HOME, 5));
  assert.equal(deps[0].via, 'for:' + OWNER);
  assert.deepEqual(cardOf(raw, HOME + '#5').waitingOn, [{ ref: HOME + '#6', title: 'Sand first', url: 'https://github.com/' + HOME + '/issues/6' }]);
});

test('R133 a home card of another owner\'s project is asked through that owner\'s client, not the data repo\'s', async () => {
  const w = makeWorld({
    settings: { version: 1, timezone: 'UTC', projects: [{ number: 3 }, { owner: OTHER_OWNER, number: 4, home: OTHER_HOME }] },
    otherItems: [issueItem(OTHER_HOME, 2, { issue_dependencies_summary: summary(1) })],
    blockers: { [OTHER_HOME + '#2']: [blocker(OTHER_HOME, 1, { title: 'Other first' })] },
  });
  const { raw } = await read(w);
  const deps = w.deps();
  assert.equal(deps.length, 1);
  assert.equal(deps[0].path, depPath(OTHER_HOME, 2));
  assert.equal(deps[0].via, 'for:' + OTHER_OWNER);
  assert.equal(cardOf(raw, OTHER_HOME + '#2').waitingOn[0].title, 'Other first');
});

test('R133 a closed home card with a summary is not asked', async () => {
  const w = makeWorld({
    items: { 3: [issueItem(HOME, 5, { state: 'closed', state_reason: 'completed', closed_at: '2026-10-05T09:00:00Z', issue_dependencies_summary: summary(2) })] },
  });
  await read(w);
  assert.equal(w.deps().length, 0);
});

test('R133 a card is asked once, in the order of the issues the read returns', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(1) }), apiIssue(REPO, 14, { issue_dependencies_summary: summary(1) })],
    items: { 3: [issueItem(HOME, 5, { issue_dependencies_summary: summary(1) })] },
    blockers: { [REPO + '#12']: [blocker(REPO, 1)], [REPO + '#14']: [blocker(REPO, 1)], [HOME + '#5']: [blocker(REPO, 1)] },
  });
  const { raw } = await read(w);
  const asked = w.deps().map((c) => c.path);
  assert.equal(new Set(asked).size, asked.length, 'no address twice');
  assert.equal(asked.length, 3);
  const order = raw.issues.filter((i) => Object.hasOwn(i, 'waitingOn')).map((i) => i.ref ?? i.number);
  const askedOrder = asked.map((p) => /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\//.exec(p)).map((m) => (m[1].toLowerCase() === REPO ? Number(m[2]) : m[1] + '#' + m[2]));
  assert.deepEqual(askedOrder, order);
});

test('R133 a failed blocked-by read for a data-repo card fails the whole read', async () => {
  const w = makeWorld({ dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(1) })], blockers: {} });
  await assert.rejects(read(w));
});

test('R133 on a load that is not full a stored row\'s old waitingOn is dropped and set again from this load\'s answer', async () => {
  const first = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(1) })],
    blockers: { [REPO + '#12']: [blocker(REPO, 7, { title: 'Was blocking' })] },
  });
  const one = await read(first);
  assert.equal(dataIssue(one.raw, 12).waitingOn.length, 1);
  // The blocker closed since: GitHub still counts the row as blocked (summary 1) but the answer holds only a closed one.
  const second = makeWorld({
    dataIssues: [apiIssue(REPO, 12, { issue_dependencies_summary: summary(1) })],
    blockers: { [REPO + '#12']: [blocker(REPO, 7, { title: 'Was blocking', state: 'closed' })] },
  });
  const two = await read(second, { full: false, since: SINCE, previous: one.raw });
  assert.equal(Object.hasOwn(dataIssue(two.raw, 12), 'waitingOn'), false, 'nothing old is kept');
});

test('R133 a board whose issues carry no blocked-by count makes no request for dependencies and no row has blockedBy or waitingOn', async () => {
  const w = makeWorld({
    dataIssues: [apiIssue(REPO, 12), apiIssue(REPO, 13, { issue_dependencies_summary: summary(0) }), apiIssue(REPO, 14, { issue_dependencies_summary: { blocked_by: 'x' } })],
    items: { 3: [issueItem(HOME, 5)] },
  });
  const { raw } = await read(w);
  assert.equal(w.deps().length, 0);
  assert.equal(w.calls.some((c) => c.path.includes('dependencies')), false);
  for (const row of raw.issues) {
    assert.equal(Object.hasOwn(row, 'blockedBy'), false);
    assert.equal(Object.hasOwn(row, 'waitingOn'), false);
  }
});

// =====================================================================================
// Model and page (R27, R134)
// =====================================================================================

const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const render = (b) => renderPage(b, THEME, OPTS);

// A blocker entry as the reader records it.
const blk = (ref, title = null) => ({ ref, title, url: title === null ? null : 'https://github.com/' + ref.replace('#', '/issues/') });
const BLOCKER = 'sam-life/life#90';

// One shown project "house" (number 3) holding the given tasks.
function make(tasks, { projectExtra } = {}) {
  resetNumbers();
  return board({
    settings: settings({ projects: [{ key: 'house', number: 3 }] }),
    raw: raw({
      projects: [project(3, 'House', tasks.map((t) => t.number), projectExtra)],
      issues: tasks,
    }),
  });
}
const row = (b) => b.projects.find((p) => p.key === 'house');
const inNext = (b, n) => (b.next ?? []).some((s) => s.number === n && typeof s.ref !== 'string');

const decode = (s) => s
  .replace(/&#x2F;/gi, '/').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function waitingSpans(html) {
  return [...html.matchAll(/<span class="cal-source" data-waiting>([^<]*)<\/span>/g)].map((m) => decode(m[1]));
}

// ---------- R27 ----------

test('R27 an open project task with one open blocker is absent from next, and one without is present', () => {
  const b = make([
    task({ number: 1, title: 'Blocked', waitingOn: [blk(BLOCKER, 'Buy paint')] }),
    task({ number: 2, title: 'Free' }),
  ]);
  assert.equal(inNext(b, 1), false);
  assert.equal(inNext(b, 2), true);
});

test('R27 an open task whose only blocker closed has no waitingOn and is a candidate', () => {
  const b = make([task({ number: 1, title: 'Was blocked' })]);
  assert.equal(inNext(b, 1), true);
});

test('R27 a blocked task still counts in its project\'s total', () => {
  const b = make([
    task({ number: 1, waitingOn: [blk(BLOCKER, 'Buy paint')] }),
    task({ number: 2 }),
  ]);
  assert.equal(row(b).total, 2);
});

test('R27 a blocked task takes no seat, so the next candidate is not pushed out by it', () => {
  const tasks = [task({ number: 1, waitingOn: [blk(BLOCKER, 'Buy paint')] })];
  for (let n = 2; n <= 7; n++) tasks.push(task({ number: n }));
  const b = make(tasks);
  assert.equal(b.next.length, 5, 'the five seats are filled by the free tasks');
  assert.equal(inNext(b, 1), false);
});

test('R27 a waitingOn that is empty, or holds an entry with no string ref, does not block the task', () => {
  const b = make([
    task({ number: 1, waitingOn: [] }),
    task({ number: 2, waitingOn: [{ title: 'No ref' }, { ref: 5 }, 'text', null] }),
  ]);
  assert.equal(inNext(b, 1), true);
  assert.equal(inNext(b, 2), true);
  assert.equal('waiting' in row(b), false);
});

test('R27 a blocked home card is absent from next as well', () => {
  resetNumbers();
  const HOMECARD = 'sam-life/house';
  const b = board({
    settings: settings({ projects: [{ key: 'house', number: 3, home: HOMECARD }] }),
    raw: raw({
      projects: [project(3, 'House', [{ repo: HOMECARD, number: 5 }, { repo: HOMECARD, number: 6 }])],
      issues: [
        task({ number: 5, repo: HOMECARD, ref: HOMECARD + '#5', html_url: 'https://github.com/' + HOMECARD + '/issues/5', waitingOn: [blk('sam-life/house#6', 'Sand')] }),
        task({ number: 6, repo: HOMECARD, ref: HOMECARD + '#6', html_url: 'https://github.com/' + HOMECARD + '/issues/6' }),
      ],
    }),
  });
  assert.deepEqual(b.next.map((s) => s.ref), [HOMECARD + '#6']);
  assert.equal(row(b).total, 2);
});

// ---------- R134, the model ----------

test('R134 a blocked task is absent from next and its project row says what it waits on, by the blocker\'s title', () => {
  const b = make([task({ number: 1, waitingOn: [blk(BLOCKER, 'Buy paint')] })]);
  assert.equal(inNext(b, 1), false);
  assert.deepEqual(row(b).waiting, { items: ['Buy paint'], more: 0 });
});

test('R134 a blocker with title null is shown by its ref', () => {
  const b = make([task({ number: 1, waitingOn: [blk('stranger/elsewhere#3')] })]);
  assert.deepEqual(row(b).waiting, { items: ['stranger/elsewhere#3'], more: 0 });
});

test('R134 a blocker whose title is an empty string is shown by its ref', () => {
  const b = make([task({ number: 1, waitingOn: [{ ref: BLOCKER, title: '', url: null }] })]);
  assert.deepEqual(row(b).waiting.items, [BLOCKER]);
});

test('R134 four distinct blockers give three labels and more 1', () => {
  const b = make([
    task({ number: 1, waitingOn: [blk('sam-life/life#91', 'One'), blk('sam-life/life#92', 'Two')] }),
    task({ number: 2, waitingOn: [blk('sam-life/life#93', 'Three'), blk('sam-life/life#94', 'Four')] }),
  ]);
  assert.deepEqual(row(b).waiting, { items: ['One', 'Two', 'Three'], more: 1 });
});

test('R134 six distinct blockers give three labels and more 3', () => {
  const b = make([
    task({ number: 1, waitingOn: [1, 2, 3, 4, 5, 6].map((n) => blk('sam-life/life#9' + n, 'B' + n)) }),
  ]);
  assert.deepEqual(row(b).waiting, { items: ['B1', 'B2', 'B3'], more: 3 });
});

test('R134 exactly three distinct blockers give three labels and more 0', () => {
  const b = make([task({ number: 1, waitingOn: [1, 2, 3].map((n) => blk('sam-life/life#9' + n, 'B' + n)) })]);
  assert.deepEqual(row(b).waiting, { items: ['B1', 'B2', 'B3'], more: 0 });
});

test('R134 two tasks waiting on the same blocker give one label', () => {
  const b = make([
    task({ number: 1, waitingOn: [blk(BLOCKER, 'Buy paint')] }),
    task({ number: 2, waitingOn: [blk(BLOCKER, 'Buy paint')] }),
  ]);
  assert.deepEqual(row(b).waiting, { items: ['Buy paint'], more: 0 });
});

test('R134 the same blocker spelt in a different case is one label', () => {
  const b = make([
    task({ number: 1, waitingOn: [blk('Sam-Life/Life#90', 'Buy paint')] }),
    task({ number: 2, waitingOn: [blk('sam-life/life#90', 'Buy paint')] }),
  ]);
  assert.deepEqual(row(b).waiting, { items: ['Buy paint'], more: 0 });
});

test('R134 labels follow the order of the project\'s tasks, then the order of each task\'s blockers', () => {
  const b = make([
    task({ number: 1, waitingOn: [blk('sam-life/life#91', 'A'), blk('sam-life/life#92', 'B')] }),
    task({ number: 2, waitingOn: [blk('sam-life/life#92', 'B'), blk('sam-life/life#93', 'C')] }),
  ]);
  assert.deepEqual(row(b).waiting.items, ['A', 'B', 'C']);
});

test('R134 only OPEN waiting tasks count: a closed task with a waitingOn adds no label and no waiting key', () => {
  const b = make([
    task({ number: 1, state: 'closed', waitingOn: [blk(BLOCKER, 'Buy paint')] }),
    task({ number: 2 }),
  ]);
  assert.equal('waiting' in row(b), false);
});

test('R134 a project with no waiting task has no waiting key', () => {
  const b = make([task({ number: 1 }), task({ number: 2 })]);
  assert.equal('waiting' in row(b), false);
});

test('R134 the row\'s blockedBy and waitingOn do not reach the board except as the waiting list', () => {
  const b = make([
    task({ number: 1, blockedBy: 2, waitingOn: [blk(BLOCKER, 'Buy paint')] }),
    task({ number: 2, blockedBy: 1 }),
  ]);
  const text = JSON.stringify(b);
  assert.equal(text.includes('blockedBy'), false);
  assert.equal(text.includes('waitingOn'), false);
  assert.equal(text.includes('sam-life/life#90'), false, 'the blocker ref only appears as a label when it is the label');
});

// ---------- R134, the page ----------

test('R134 a project with a waiting task renders a small grey word with data-waiting: "waiting on: <title>"', () => {
  const b = make([task({ number: 1, waitingOn: [blk(BLOCKER, 'Buy paint')] }), task({ number: 2 })]);
  const html = render(b);
  assert.ok(html.includes('data-waiting'));
  assert.deepEqual(waitingSpans(html), ['waiting on: Buy paint']);
  assert.ok(html.includes('<span class="cal-source" data-waiting>'), 'the existing small grey class');
});

test('R134 the waiting words sit in the project row\'s stats, after the existing stats', () => {
  const b = make([task({ number: 1, waitingOn: [blk(BLOCKER, 'Buy paint')] }), task({ number: 2 })]);
  const html = render(b);
  const stats = (/<div class="project__stats">([\s\S]*?)<\/div>/.exec(html) ?? [])[1] ?? '';
  assert.ok(stats.includes('data-waiting'), stats);
  assert.ok(stats.indexOf('data-waiting') > 0, 'something comes before it');
  assert.ok(/<span class="cal-source" data-waiting>waiting on: Buy paint<\/span>$/.test(stats), 'it is the last stat: ' + stats);
});

test('R134 four distinct blockers render three "waiting on:" words and one "+1"', () => {
  const b = make([
    task({ number: 1, waitingOn: [blk('sam-life/life#91', 'One'), blk('sam-life/life#92', 'Two')] }),
    task({ number: 2, waitingOn: [blk('sam-life/life#93', 'Three'), blk('sam-life/life#94', 'Four')] }),
  ]);
  assert.deepEqual(waitingSpans(render(b)), ['waiting on: One', 'waiting on: Two', 'waiting on: Three', '+1']);
});

test('R134 three or fewer blockers render no "+n" word', () => {
  const b = make([task({ number: 1, waitingOn: [blk('sam-life/life#91', 'One'), blk('sam-life/life#92', 'Two'), blk('sam-life/life#93', 'Three')] })]);
  const spans = waitingSpans(render(b));
  assert.equal(spans.length, 3);
  assert.equal(spans.some((s) => s.startsWith('+')), false);
});

test('R134 a blocker with no title renders by its ref', () => {
  const b = make([task({ number: 1, waitingOn: [blk('stranger/elsewhere#3')] })]);
  assert.deepEqual(waitingSpans(render(b)), ['waiting on: stranger/elsewhere#3']);
});

test('R134 a blocker title is escaped in the page', () => {
  const b = make([task({ number: 1, waitingOn: [blk(BLOCKER, 'A&B <script>x</script>')] })]);
  const html = render(b);
  assert.ok(html.includes('A&amp;B &lt;script&gt;'), 'escaped');
  assert.equal(html.includes('<script>x'), false);
  assert.deepEqual(waitingSpans(html), ['waiting on: A&B <script>x</script>']);
});

test('R134 a blocked task is not in What\'s next on the page, and the free one is', () => {
  const b = make([
    task({ number: 1, title: 'Blocked chore', waitingOn: [blk(BLOCKER, 'Buy paint')] }),
    task({ number: 2, title: 'Free chore' }),
  ]);
  const html = render(b);
  assert.ok(html.includes('Free chore'));
  assert.equal(html.includes('Blocked chore'), false, 'the blocked task\'s own title is nowhere on the page');
});

// ---------- the off path ----------

test('R134 off path: a board with no waiting task has no data-waiting and no waiting key', () => {
  const b = make([task({ number: 1 }), task({ number: 2 })]);
  assert.equal(render(b).includes('data-waiting'), false);
  assert.equal(JSON.stringify(b).includes('"waiting"'), false);
});

test('R134 off path: empty or malformed waitingOn and a bare blockedBy count give the same board and the same page as none', () => {
  const plain = make([task({ number: 1 }), task({ number: 2 })]);
  const odd = make([
    task({ number: 1, waitingOn: [] }),
    task({ number: 2, blockedBy: 1, waitingOn: [{ title: 'No ref' }, null] }),
  ]);
  assert.equal(JSON.stringify(odd), JSON.stringify(plain));
  assert.equal(render(odd), render(plain));
});
