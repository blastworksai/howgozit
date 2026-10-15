import test from 'node:test';
import assert from 'node:assert/strict';
import { readAll, rawIssue } from '../board/github/read.mjs';
import { checkRaw } from '../board/shape-data.mjs';
import { fakeHttp, callsTo } from '../fixtures/github/fake-http.mjs';
import {
  REPO, R, ISSUES_FULL, MILESTONES, FILE_PATHS, TEXTS, NOW, SINCE,
  routes, apiIssue, issues, fileAnswer,
} from '../fixtures/github/world.mjs';

const ORG = '/orgs/sam-life/projectsV2';
const USR = '/users/sam-life/projectsV2';
const ITEMS3 = ORG + '/3/items?per_page=100&fields=101,102';

async function run(opts = {}, args = {}) {
  const http = fakeHttp(routes(opts));
  const out = await readAll(http, { repo: REPO, full: true, now: NOW, ...args });
  return { http, ...out };
}
const settingsWith = (projects) => ({ files: { 'board.config.json': JSON.stringify({ projects }) } });
const projectCalls = (http) => http.calls.filter((c) => c.path.includes('projectsV2'));

test('U a full read passes checkRaw and carries the injected time', async () => {
  const { raw } = await run();
  const r = checkRaw(raw);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(raw.fetchedAt, NOW);
  assert.equal(raw.repo, REPO);
  assert.deepEqual(raw.partial, { issues: false, items: false });
});

test('U a private repository and an organisation owner are read from the repo answer', async () => {
  const { raw, http } = await run();
  assert.equal(raw.repoPrivate, true);
  assert.equal(raw.ownerType, 'organization');
  assert.ok(projectCalls(http).every((c) => c.path.startsWith(ORG)));
  assert.ok(projectCalls(http).length > 0);
});

test('U a public repository gives repoPrivate false', async () => {
  const { raw } = await run({ private: false });
  assert.equal(raw.repoPrivate, false);
});

test('U a user owner reads Projects under users, not orgs', async () => {
  const { raw, http } = await run({ ownerType: 'User' });
  assert.equal(raw.ownerType, 'user');
  assert.equal(checkRaw(raw).ok, true);
  assert.ok(projectCalls(http).length > 0);
  assert.ok(projectCalls(http).every((c) => c.path.startsWith(USR)));
  assert.equal(raw.projects[0].url, 'https://github.com/users/sam-life/projects/3');
});

test('U a raw issue has every contract field and drops the extras', async () => {
  const { raw } = await run();
  assert.deepEqual(raw.issues[0], {
    number: 12, title: 'Paint the hallway', state: 'open', state_reason: null, is_pr: false,
    labels: ['home', 'urgent'], milestone: 5,
    created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
    html_url: 'https://github.com/sam-life/life/issues/12',
  });
});

test('U labels as plain strings, a closed issue and a null milestone', async () => {
  const { raw } = await run();
  const i = raw.issues[1];
  assert.deepEqual(i.labels, ['paperwork', 'done']);
  assert.equal(i.state, 'closed');
  assert.equal(i.state_reason, 'completed');
  assert.equal(i.closed_at, '2026-10-02T09:00:00Z');
  assert.equal(i.milestone, null);
});

test('U a pull request is marked is_pr', async () => {
  const { raw } = await run();
  assert.equal(raw.issues[2].is_pr, true);
  assert.equal(raw.issues[0].is_pr, false);
});

test('U milestones keep the contract fields only', async () => {
  const { raw } = await run();
  assert.deepEqual(raw.milestones[0], {
    number: 5, title: 'House · Hallway', state: 'open', due_on: '2026-10-20T07:00:00Z', closed_at: null,
    html_url: 'https://github.com/sam-life/life/milestone/5',
  });
  assert.equal(raw.milestones[1].state, 'closed');
  assert.equal(raw.milestones[1].due_on, null);
});

test('U all seven files are decoded from base64, multi-line and non-ASCII', async () => {
  const { texts, http } = await run();
  assert.equal(texts.settings, TEXTS['board.config.json']);
  assert.equal(texts.theme, TEXTS['theme.json']);
  assert.equal(texts.state.brief, TEXTS['state/brief.json']);
  assert.equal(texts.state.calendar, TEXTS['state/calendar.json']);
  assert.equal(texts.state.inbox, TEXTS['state/inbox.json']);
  assert.equal(texts.state.log, TEXTS['state/log.json']);
  assert.equal(texts.state.proposals, TEXTS['state/proposals.json']);
  assert.ok(texts.theme.includes('·'));
  assert.ok(texts.state.brief.includes('·'));
  const long = http.routes.get(R + '/contents/state/brief.json').content;
  assert.ok(long.trim().includes('\n'), 'fixture body spans several base64 lines');
  for (const p of FILE_PATHS) assert.ok(http.calls.some((c) => c.path === R + '/contents/' + p), p);
});

test('U a missing file gives null and the read goes on', async () => {
  const { texts, raw } = await run({ files: { 'state/log.json': null, 'theme.json': null } });
  assert.equal(texts.state.log, null);
  assert.equal(texts.theme, null);
  assert.equal(texts.state.brief, TEXTS['state/brief.json']);
  assert.equal(checkRaw(raw).ok, true);
});

test('U an answer without base64 content gives null', async () => {
  const { texts } = await run({ files: {
    'state/inbox.json': { name: 'inbox.json', type: 'dir' },
    'state/calendar.json': { name: 'calendar.json', type: 'file', encoding: 'none', content: '' },
  } });
  assert.equal(texts.state.inbox, null);
  assert.equal(texts.state.calendar, null);
});

test('U an error that is not not-found on a file propagates', async () => {
  const boom = Object.assign(new Error('GitHub did not accept the token.'), { kind: 'auth', status: 401 });
  await assert.rejects(run({ files: { 'theme.json': boom } }), (e) => e === boom && e.kind === 'auth');
});

test('U only Projects listed in settings are read, in settings order, and an unreturned one is absent', async () => {
  const list = [
    { number: 3, title: 'House', state: 'open' }, { number: 5, title: 'Garden', state: 'open' },
    { number: 8, title: 'Unlisted', state: 'open' },
  ];
  const { raw, http } = await run({
    ...settingsWith([{ number: 5 }, { number: 7 }, { number: 3 }]),
    projectList: list,
    fields: { 3: [], 5: [] }, items: { 3: [], 5: [] },
  });
  assert.deepEqual(raw.projects.map((p) => p.number), [5, 3]);
  assert.deepEqual(raw.projects.map((p) => p.title), ['Garden', 'House']);
  assert.ok(!http.calls.some((c) => c.path.includes('/8/') || c.path.includes('/7/')));
});

test('U closed follows the Project state and url is built', async () => {
  const { raw } = await run({
    ...settingsWith([{ number: 3 }, { number: 4 }]),
    fields: { 3: [], 4: [] }, items: { 3: [], 4: [] },
  });
  const [a, b] = raw.projects;
  assert.equal(a.closed, false);
  assert.equal(b.closed, true);
  assert.equal(a.url, 'https://github.com/orgs/sam-life/projects/3');
  assert.equal(b.url, 'https://github.com/orgs/sam-life/projects/4');
});

test('U no settings text, or unparsable settings, means no Projects requests', async () => {
  for (const text of [null, '{not json', '', '[]', '{"projects":"x"}']) {
    const { raw, http } = await run({ files: { 'board.config.json': text } });
    assert.deepEqual(raw.projects, [], JSON.stringify(text));
    assert.equal(projectCalls(http).length, 0, JSON.stringify(text));
    assert.equal(checkRaw(raw).ok, true);
  }
});

test('U project numbers that are not positive integers are skipped', async () => {
  const { raw, http } = await run(settingsWith([{ number: 0 }, { number: -1 }, { number: 2.5 }, { number: '3' }, {}, null]));
  assert.deepEqual(raw.projects, []);
  assert.equal(projectCalls(http).length, 0);
});

test('U fields are asked first, then items name Status then Due', async () => {
  const { http, raw } = await run();
  const paths = callsTo(http, 'paged').map((c) => c.path);
  const fi = paths.indexOf(ORG + '/3/fields?per_page=100');
  const ii = paths.indexOf(ITEMS3);
  assert.ok(fi >= 0, 'fields requested');
  assert.ok(ii > fi, 'items requested after fields');
  assert.equal(raw.projects[0].items.length, 5);
});

test('U item status and due come from the fields array', async () => {
  const { raw } = await run();
  const [a, b, c] = raw.projects[0].items;
  assert.deepEqual(a, { type: 'Issue', repo: 'sam-life/life', number: 12, status: 'In Progress', due: '2026-10-18' });
  assert.equal(b.status, null);
  assert.equal(b.due, null);
  assert.equal(c.status, 'Todo');
  assert.equal(c.due, null);
});

test('U a Project without a Due field names only Status and gives due null', async () => {
  const fields = [{ id: 100, name: 'Title' }, { id: 101, name: 'Status' }, { id: 105, name: 'Due date' }];
  const bare = (n, st) => ({ content_type: 'Issue', content: { number: n, repository: { full_name: REPO } },
    fields: [{ id: 100, name: 'Title', value: { raw: 'x' } }, { id: 101, name: 'Status', value: { name: { raw: st } } }] });
  const { http, raw } = await run({ fields: { 3: fields }, items: { 3: [bare(12, 'Doing'), bare(13, 'Done')] } });
  assert.ok(callsTo(http, 'paged').some((c) => c.path === ORG + '/3/items?per_page=100&fields=101'));
  assert.ok(raw.projects[0].items.every((i) => i.due === null));
  assert.deepEqual(raw.projects[0].items.map((i) => i.status), ['Doing', 'Done']);
});

test('U a Project with neither field leaves the fields parameter out', async () => {
  const fields = [{ id: 100, name: 'Title' }, { id: 105, name: 'Due date' }];
  const bare = { content_type: 'Issue', content: { number: 12, repository: { full_name: REPO } }, fields: [{ id: 100, name: 'Title', value: { raw: 'x' } }] };
  const { http, raw } = await run({ fields: { 3: fields }, items: { 3: [bare] } });
  const items = callsTo(http, 'paged').filter((c) => c.path.includes('/3/items'));
  assert.equal(items.length, 1);
  assert.equal(items[0].path, ORG + '/3/items?per_page=100');
  assert.ok(raw.projects[0].items.every((i) => i.status === null && i.due === null));
});

test('U item types: Issue, PullRequest, DraftIssue, unknown and no content', async () => {
  const { raw } = await run();
  const it = raw.projects[0].items;
  assert.deepEqual(it.map((i) => i.type), ['Issue', 'PullRequest', 'DraftIssue', 'REDACTED', 'REDACTED']);
  assert.equal(it[1].number, 14);
  assert.equal(it[2].repo, null);
  assert.equal(it[2].number, null);
  assert.equal(it[4].repo, null);
  assert.equal(it[4].number, null);
  assert.equal(checkRaw(raw).ok, true);
});

test('U every list is requested with its page cap', async () => {
  const { http } = await run();
  const cap = (path) => callsTo(http, 'paged').find((c) => c.path === path).options.maxPages;
  assert.equal(cap(ISSUES_FULL), 100);
  assert.equal(cap(MILESTONES), 10);
  assert.equal(cap(ORG + '?per_page=100'), 10);
  assert.equal(cap(ITEMS3), 20);
});

test('U partial flags and the too-much-data warning follow the caps hit', async () => {
  const none = await run();
  assert.deepEqual(none.warnings, []);
  const hit = await run({
    issues: { items: issues(), partial: true },
    milestones: { items: [], partial: true },
  });
  assert.equal(hit.raw.partial.issues, true);
  assert.equal(hit.raw.partial.items, false);
  assert.deepEqual(hit.warnings, [{ code: 'too-much-data', count: 2 }]);
  const items = await run({ items: { 3: { items: [], partial: true } } });
  assert.equal(items.raw.partial.items, true);
  assert.equal(items.raw.partial.issues, false);
  assert.deepEqual(items.warnings, [{ code: 'too-much-data', count: 1 }]);
});

test('R69 a full read has no since, and later loads share one since', async () => {
  const SINCE_PATH = ISSUES_FULL + '&since=' + SINCE;
  const first = await run({}, { full: true, since: SINCE });
  const issuePaths1 = callsTo(first.http, 'paged').map((c) => c.path).filter((p) => p.includes('/issues?'));
  assert.deepEqual(issuePaths1, [ISSUES_FULL]);
  const loads = [];
  for (let n = 0; n < 2; n += 1) {
    const r = await run({ extra: { [SINCE_PATH]: [] } }, { full: false, since: SINCE, previous: first.raw });
    loads.push(callsTo(r.http, 'paged').map((c) => c.path).filter((p) => p.includes('/issues?')));
  }
  assert.deepEqual(loads[0], [SINCE_PATH]);
  assert.deepEqual(loads[1], loads[0]);
  assert.equal(callsTo(first.http, 'paged').find((c) => c.path === ISSUES_FULL).options.maxPages, 100);
});

test('R69 a load returning one changed issue keeps the list length with that issue updated', async () => {
  const SINCE_PATH = ISSUES_FULL + '&since=' + SINCE;
  const first = await run();
  const changed = apiIssue(13, { title: 'Renew the permit, twice', state: 'open', updated_at: '2026-10-12T06:06:00Z' });
  const second = await run({ extra: { [SINCE_PATH]: [changed] } }, { full: false, since: SINCE, previous: first.raw });
  assert.equal(second.raw.issues.length, first.raw.issues.length);
  const got = second.raw.issues.find((i) => i.number === 13);
  assert.equal(got.title, 'Renew the permit, twice');
  assert.equal(got.state, 'open');
  assert.equal(got.updated_at, '2026-10-12T06:06:00Z');
  assert.deepEqual(second.raw.issues.find((i) => i.number === 12), first.raw.issues.find((i) => i.number === 12));
  assert.equal(checkRaw(second.raw).ok, true);
});

test('R69 a new issue is appended and nothing is dropped', async () => {
  const SINCE_PATH = ISSUES_FULL + '&since=' + SINCE;
  const first = await run();
  const second = await run({ extra: { [SINCE_PATH]: [apiIssue(20, { title: 'New thing' })] } }, { full: false, since: SINCE, previous: first.raw });
  assert.equal(second.raw.issues.length, first.raw.issues.length + 1);
  assert.equal(second.raw.issues.at(-1).number, 20);
  assert.deepEqual(second.raw.issues.slice(0, 3).map((i) => i.number), [12, 13, 14]);
});

test('R70 an older copy of an issue from a list that runs behind does not undo the stored one', async () => {
  const SINCE_PATH = ISSUES_FULL + '&since=' + SINCE;
  const first = await run();
  const held = structuredClone(first.raw);
  const mine = held.issues.find((i) => i.number === 13);
  mine.state = 'closed';
  mine.updated_at = '2026-10-12T06:09:00Z';
  const older = apiIssue(13, { state: 'open', updated_at: '2026-10-12T06:06:00Z' });
  const second = await run({ extra: { [SINCE_PATH]: [older] } }, { full: false, since: SINCE, previous: held });
  assert.equal(second.raw.issues.find((i) => i.number === 13).state, 'closed');
  const newer = apiIssue(13, { state: 'open', updated_at: '2026-10-12T06:10:00Z' });
  const third = await run({ extra: { [SINCE_PATH]: [newer] } }, { full: false, since: SINCE, previous: held });
  assert.equal(third.raw.issues.find((i) => i.number === 13).state, 'open');
});

test('U rawIssue maps an API issue on its own', () => {
  const r = rawIssue(apiIssue(7, { labels: [{ name: 'a' }, 'b'], milestone: { number: 2 }, state_reason: 'not_planned', state: 'closed' }));
  assert.equal(r.number, 7);
  assert.deepEqual(r.labels, ['a', 'b']);
  assert.equal(r.milestone, 2);
  assert.equal(r.state_reason, 'not_planned');
  assert.equal(r.is_pr, false);
});

test('U rawIssue copes with a missing state_reason and missing labels', () => {
  const api = apiIssue(8);
  delete api.state_reason;
  delete api.labels;
  delete api.milestone;
  const r = rawIssue(api);
  assert.equal(r.state_reason, null);
  assert.deepEqual(r.labels, []);
  assert.equal(r.milestone, null);
});

test('U hostile shapes do not throw', async () => {
  const items = [
    { content_type: 'Issue', content: { number: 12, repository: { full_name: REPO } }, fields: 'nope' },
    { content_type: 'Issue', content: { number: 13, repository: { full_name: REPO } }, fields: { Status: 1 } },
  ];
  const { raw } = await run({
    issues: [null, apiIssue(30, { milestone: 'five' }), apiIssue(31, { labels: null })],
    items: { 3: items },
  });
  const odd = raw.issues.find((i) => i.number === 30);
  assert.ok(odd, 'a good issue after a null one is kept');
  assert.equal(odd.milestone, null);
  assert.deepEqual(raw.projects[0].items.map((i) => [i.status, i.due]), [[null, null], [null, null]]);
  assert.doesNotThrow(() => rawIssue(apiIssue(32, { milestone: 'five' })));
});
