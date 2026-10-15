import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLoader } from '../board/load.mjs';
import { createCache } from '../board/cache.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { settings } from '../fixtures/build.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const TOKEN = 'SENTINEL-TOKEN-123';
const FILE_NAMES = [
  'board.config.json', 'theme.json',
  'state/brief.json', 'state/calendar.json', 'state/inbox.json', 'state/log.json', 'state/proposals.json',
];

function apiIssue(number, extra = {}) {
  return {
    id: number * 10, number, title: 'Task ' + number, state: 'open', state_reason: null,
    labels: [], milestone: null, comments: 0,
    created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
    html_url: 'https://github.com/' + REPO + '/issues/' + number,
    ...extra,
  };
}

function notFound(p) {
  return new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
}

// A fake of the http object the real reader runs on. `world` is changed by the tests between loads.
function makeWorld(over = {}) {
  const world = {
    calls: [],
    fail: null,
    repoPrivate: true,
    files: {
      'board.config.json': JSON.stringify(settings()),
      'theme.json': null,
      'state/brief.json': null,
      'state/calendar.json': null,
      'state/inbox.json': null,
      'state/log.json': null,
      'state/proposals.json': null,
    },
    full: [apiIssue(1), apiIssue(2), apiIssue(3)],
    fullPartial: false,
    incremental: [],
    milestones: [],
    items: {},
    ...over,
  };
  function answer(method, p) {
    world.calls.push({ method, path: p });
    if (world.fail) throw world.fail;
    if (p === R) return { private: world.repoPrivate, owner: { login: OWNER, type: 'Organization' } };
    const f = p.startsWith(R + '/contents/') ? p.slice((R + '/contents/').length) : null;
    if (f !== null) {
      if (!Object.hasOwn(world.files, f) || world.files[f] === null) throw notFound(p);
      return { content: Buffer.from(world.files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?')) {
      return { items: structuredClone(p.includes('&since=') ? world.incremental : world.full), partial: !p.includes('&since=') && world.fullPartial };
    }
    if (p.startsWith(R + '/milestones?')) return { items: structuredClone(world.milestones), partial: false };
    if (p === '/orgs/' + OWNER + '/projectsV2?per_page=100') {
      return { items: Object.keys(world.items).map((n) => ({ number: Number(n), title: 'Project ' + n, state: 'open' })), partial: false };
    }
    let m = /^\/orgs\/sam-life\/projectsV2\/(\d+)\/fields\?/.exec(p);
    if (m) return { items: [{ id: 11, name: 'Status' }, { id: 12, name: 'Due' }, { id: 13, name: 'Other' }], partial: false };
    m = /^\/orgs\/sam-life\/projectsV2\/(\d+)\/items\?/.exec(p);
    if (m) {
      const rows = world.items[m[1]] || [];
      return {
        items: rows.map((n) => ({ content_type: 'Issue', content: { number: n, repository: { full_name: REPO } }, fields: [] })),
        partial: false,
      };
    }
    throw notFound(p);
  }
  world.http = {
    async get(p) { return { status: 200, json: answer('get', p), notModified: false, link: null }; },
    async paged(p) { return answer('paged', p); },
  };
  return world;
}

function fakeCache(initial = null) {
  const c = {
    stored: initial,
    writes: 0,
    async readLastGood() { return c.stored; },
    async writeLastGood(b) { c.writes += 1; c.stored = structuredClone(b); },
    etags: { get() {}, set() {} },
  };
  return c;
}

function makeClock(iso) {
  const clock = { t: Date.parse(iso), now() { return clock.t; } };
  return clock;
}

function makeEnv(over = {}) {
  return { repo: REPO, readOnly: false, configDir: null, token: TOKEN, ...over };
}

function setup({ world = makeWorld(), cache = fakeCache(), at = '2026-10-12T06:10:00.900Z', env = makeEnv(), readFile } = {}) {
  const clock = makeClock(at);
  const loader = createLoader({ http: world.http, env, cache, clock, ...(readFile ? { readFile } : {}) });
  return { world, cache, clock, loader, ...loader };
}

const issueCalls = (world) => world.calls.filter((c) => c.path.startsWith(R + '/issues?'));
const lastIssuePath = (world) => issueCalls(world).at(-1).path;
const isFull = (p) => !p.includes('since=');
const sinceOf = (p) => decodeURIComponent(/[?&]since=([^&]+)/.exec(p)[1]);
const withProjects = (world) => {
  world.files['board.config.json'] = JSON.stringify(settings({ projects: [{ key: 'home', number: 3 }] }));
  return world;
};
const projectOf = (bundle, n) => bundle.raw.projects.find((p) => p.number === n);
const unavailable = () => new GitHubError('server', 503, 'GitHub is not answering right now.');

test('R65 a clock crossing 05:00 board time gives exactly one full read, and the same day crossing again gives none', async () => {
  const s = setup({ at: '2026-10-12T02:00:00Z' }); // 04:00 in Brussels
  const kinds = [];
  for (const iso of [
    '2026-10-12T02:00:00Z', // first load of the process: full
    '2026-10-12T02:30:00Z', // 04:30, same refresh day
    '2026-10-12T03:30:00Z', // 05:30, crossed 05:00
    '2026-10-12T03:40:00Z', // same day, after
    '2026-10-12T10:00:00Z', // later the same day
  ]) {
    s.clock.t = Date.parse(iso);
    const out = await s.load();
    assert.equal(out.ok, true);
    kinds.push(isFull(lastIssuePath(s.world)) ? 'full' : 'since');
  }
  assert.deepEqual(kinds, ['full', 'since', 'full', 'since', 'since']);
});

test('R65 a first load on a later date than the last full read is a full read', async () => {
  const s = setup({ at: '2026-10-12T10:00:00Z' });
  await s.load();
  assert.equal(isFull(lastIssuePath(s.world)), true);
  s.clock.t = Date.parse('2026-10-12T14:00:00Z');
  await s.load();
  assert.equal(isFull(lastIssuePath(s.world)), false);
  s.clock.t = Date.parse('2026-10-13T08:00:00Z'); // next day, after 05:00
  await s.load();
  assert.equal(isFull(lastIssuePath(s.world)), true);
});

test('R65 fullDue says whether the next load would be a full read', async () => {
  const s = setup({ at: '2026-10-12T10:00:00Z' });
  assert.equal(s.loader.fullDue(), true);
  await s.load();
  assert.equal(s.loader.fullDue(), false);
  s.clock.t = Date.parse('2026-10-13T02:00:00Z'); // 04:00 board time, before 05:00
  assert.equal(s.loader.fullDue(), false);
  s.clock.t = Date.parse('2026-10-13T08:00:00Z');
  assert.equal(s.loader.fullDue(), true);
  await s.load();
  assert.equal(s.loader.fullDue(), false);
});

test('R65 before 05:00 board time the refresh day is still the day before, so a load just after midnight is not full', async () => {
  const s = setup({ at: '2026-10-12T10:00:00Z' });
  await s.load();
  s.clock.t = Date.parse('2026-10-13T02:30:00Z'); // 04:30 on the 13th, still the 12th's refresh day
  await s.load();
  assert.equal(isFull(lastIssuePath(s.world)), false);
});

test('R65 a caller asking for full gets a full read at any time', async () => {
  const s = setup();
  await s.load();
  assert.equal(isFull(lastIssuePath(s.world)), true);
  await s.load();
  assert.equal(isFull(lastIssuePath(s.world)), false);
  await s.load({ full: true });
  assert.equal(isFull(lastIssuePath(s.world)), true);
});

test('R66 a first read into an empty folder saves last-good.json without the token', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'load-test-'));
  try {
    const folder = path.join(dir, 'data');
    const s = setup({ cache: createCache(folder) });
    const out = await s.load();
    assert.equal(out.ok, true);
    const text = await fs.readFile(path.join(folder, 'last-good.json'), 'utf8');
    assert.equal(text.includes(TOKEN), false);
    const saved = JSON.parse(text);
    assert.equal(saved.savedAt, out.bundle.savedAt);
    assert.equal(saved.raw.issues.length, 3);
    assert.equal(Object.hasOwn(saved, 'run'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('R66 a later read replaces last-good.json whole', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'load-test-'));
  try {
    const s = setup({ cache: createCache(dir) });
    await s.load();
    s.clock.t += 120000;
    s.world.full = [apiIssue(7, { title: 'Only one' })];
    const out = await s.load({ full: true });
    const files = await fs.readdir(dir);
    assert.deepEqual(files, ['last-good.json']);
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'last-good.json'), 'utf8'));
    assert.equal(saved.savedAt, out.bundle.savedAt);
    assert.deepEqual(saved.raw.issues.map((i) => i.number), [7]);
    assert.equal((await fs.readFile(path.join(dir, 'last-good.json'), 'utf8')).includes(TOKEN), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('R67 a failed read after one good read answers ok with run.stale since that read and a plain reason', async () => {
  const s = setup();
  const first = await s.load();
  assert.equal(first.bundle.run.stale, null);
  s.clock.t += 600000;
  s.world.fail = unavailable();
  const out = await s.load();
  assert.equal(out.ok, true);
  assert.equal(out.bundle.run.stale.since, first.bundle.savedAt);
  assert.equal(out.bundle.run.stale.reason, 'GitHub is not answering right now.');
  assert.equal(out.bundle.savedAt, first.bundle.savedAt);
  assert.deepEqual(out.bundle.raw.issues.map((i) => i.number), [1, 2, 3]);
});

test('R67 a failure that is not a GitHub error gives the fixed plain reason', async () => {
  const s = setup();
  await s.load();
  s.world.fail = new TypeError('boom with details');
  const out = await s.load();
  assert.equal(out.ok, true);
  assert.equal(out.bundle.run.stale.reason, 'GitHub could not be reached.');
});

test('R67 a failed read with nothing saved answers 503 and no board', async () => {
  const s = setup();
  s.world.fail = unavailable();
  const out = await s.load();
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
  assert.equal(typeof out.notice.title, 'string');
  assert.match(out.notice.message, /no saved data/i);
});

test('R67 a new process with a saved file serves it as stale when GitHub does not answer', async () => {
  const first = setup({ at: '2026-10-12T06:10:00Z' });
  await first.load();
  const saved = first.cache.stored;
  const second = setup({ cache: fakeCache(saved), at: '2026-10-12T07:00:00Z' });
  second.world.fail = new GitHubError('rate-limit', 429);
  const out = await second.load();
  assert.equal(out.ok, true);
  assert.equal(out.bundle.run.stale.since, saved.savedAt);
  assert.equal(out.bundle.run.stale.reason, 'GitHub is limiting requests right now; try again later.');
  assert.equal(out.bundle.settings.name, saved.settings.name);
});

test('R69 after a full read two loads use the same since, five minutes before the full read began', async () => {
  const s = setup({ at: '2026-10-12T06:10:00.900Z' });
  await s.load();
  s.clock.t += 60000;
  await s.load();
  s.clock.t += 60000;
  await s.load();
  const paths = issueCalls(s.world).map((c) => c.path);
  assert.equal(paths.length, 3);
  assert.equal(isFull(paths[0]), true);
  assert.equal(sinceOf(paths[1]), '2026-10-12T06:05:00Z');
  assert.equal(paths[2], paths[1]);
});

test('R69 a changed issue from the incremental read updates its place and the list keeps its length', async () => {
  const s = setup();
  await s.load();
  s.world.incremental = [apiIssue(2, { title: 'Renamed', updated_at: '2026-10-12T06:11:00Z' })];
  s.clock.t += 60000;
  const out = await s.load();
  assert.equal(out.bundle.raw.issues.length, 3);
  assert.deepEqual(out.bundle.raw.issues.map((i) => i.number).sort(), [1, 2, 3]);
  assert.equal(out.bundle.raw.issues.find((i) => i.number === 2).title, 'Renamed');
  assert.equal(out.bundle.raw.issues.find((i) => i.number === 1).title, 'Task 1');
});

test('R69 a new issue from the incremental read is appended and nothing is dropped', async () => {
  const s = setup();
  await s.load();
  s.world.incremental = [apiIssue(9, { title: 'Brand new' })];
  s.clock.t += 60000;
  const out = await s.load();
  assert.equal(out.bundle.raw.issues.length, 4);
  assert.equal(out.bundle.raw.issues.find((i) => i.number === 9).title, 'Brand new');
});

test('R70 noteWrite with an api issue replaces the stored issue on the next load', async () => {
  const s = setup();
  await s.load();
  s.loader.noteWrite({ apiIssue: apiIssue(2, { title: 'Written just now' }) });
  s.clock.t += 5000;
  // the incremental read does not include issue 2, so the stored (replaced) issue stays
  const out = await s.load();
  assert.equal(out.bundle.raw.issues.length, 3);
  assert.equal(out.bundle.raw.issues.find((i) => i.number === 2).title, 'Written just now');
});

test('R70 noteWrite with an api issue that is new to the list appends it', async () => {
  const s = setup();
  await s.load();
  s.loader.noteWrite({ apiIssue: apiIssue(40, { title: 'Fresh' }) });
  s.clock.t += 5000;
  const out = await s.load();
  assert.equal(out.bundle.raw.issues.length, 4);
  assert.equal(out.bundle.raw.issues.find((i) => i.number === 40).title, 'Fresh');
});

test('R70 a noted item shows under its project while the list lacks it and not after ten minutes', async () => {
  const world = withProjects(makeWorld({ items: { 3: [1] } }));
  const s = setup({ world });
  await s.load();
  s.loader.noteWrite({ item: { projectNumber: 3, issueNumber: 99 } });
  s.clock.t += 10000;
  const during = await s.load();
  const shown = projectOf(during.bundle, 3).items.filter((i) => i.number === 99);
  assert.deepEqual(shown, [{ type: 'Issue', repo: REPO, number: 99, status: null, due: null }]);
  assert.equal(projectOf(during.bundle, 3).items.some((i) => i.number === 1), true);
  s.clock.t += 591000; // ten minutes and one second after the note
  const after = await s.load();
  assert.equal(projectOf(after.bundle, 3).items.some((i) => i.number === 99), false);
});

test('R70 a noted item is still shown 59 seconds after the note', async () => {
  const world = withProjects(makeWorld({ items: { 3: [] } }));
  const s = setup({ world });
  await s.load();
  s.loader.noteWrite({ item: { projectNumber: 3, issueNumber: 99 } });
  s.clock.t += 59000;
  const out = await s.load();
  assert.equal(projectOf(out.bundle, 3).items.filter((i) => i.number === 99).length, 1);
});

test('R70 a noted item is never shown twice when the list already holds it', async () => {
  const world = withProjects(makeWorld({ items: { 3: [99] } }));
  const s = setup({ world });
  await s.load();
  s.loader.noteWrite({ item: { projectNumber: 3, issueNumber: 99 } });
  s.clock.t += 5000;
  const out = await s.load();
  assert.equal(projectOf(out.bundle, 3).items.filter((i) => i.number === 99).length, 1);
});

test('R70 pending items are not written to the saved file', async () => {
  const world = withProjects(makeWorld({ items: { 3: [1] } }));
  const s = setup({ world });
  await s.load();
  s.loader.noteWrite({ item: { projectNumber: 3, issueNumber: 99 } });
  s.clock.t += 5000;
  const out = await s.load();
  assert.equal(projectOf(out.bundle, 3).items.some((i) => i.number === 99), true);
  assert.equal(s.cache.writes, 2);
  const saved = s.cache.stored.raw.projects.find((p) => p.number === 3);
  assert.equal(saved.items.some((i) => i.number === 99), false);
});

test('R71 ten loads started together make one set of requests and get an equal answer', async () => {
  const s = setup();
  const answers = await Promise.all(Array.from({ length: 10 }, () => s.load()));
  assert.equal(s.world.calls.filter((c) => c.path === R).length, 1);
  assert.equal(issueCalls(s.world).length, 1);
  for (const a of answers) {
    assert.equal(a.ok, true);
    assert.deepEqual(a, answers[0]);
  }
});

test('R71 once the shared read has finished a new load reads again', async () => {
  const s = setup();
  await Promise.all([s.load(), s.load(), s.load()]);
  await s.load();
  assert.equal(s.world.calls.filter((c) => c.path === R).length, 2);
});

test('R72 a missing settings file gives a 503 notice that points to setup', async () => {
  const world = makeWorld();
  world.files['board.config.json'] = null;
  const out = await setup({ world }).load();
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
  assert.match(out.notice.title + ' ' + out.notice.message, /setup/i);
});

test('R72 a settings file with a token key gives a notice naming the key and not its value', async () => {
  const world = makeWorld();
  world.files['board.config.json'] = JSON.stringify({ ...settings(), token: 'VALUE-THAT-MUST-NOT-APPEAR' });
  const out = await setup({ world }).load();
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
  const text = out.notice.title + ' ' + out.notice.message;
  assert.match(text, /token/);
  assert.equal(text.includes('VALUE-THAT-MUST-NOT-APPEAR'), false);
});

test('R72 settings that are not valid JSON or break a hard value give a 503 notice', async () => {
  const bad = makeWorld();
  bad.files['board.config.json'] = '{not json';
  const a = await setup({ world: bad }).load();
  assert.equal(a.ok, false);
  assert.equal(a.notice.status, 503);
  const hard = makeWorld();
  hard.files['board.config.json'] = JSON.stringify({ ...settings(), version: 2 });
  const b = await setup({ world: hard }).load();
  assert.equal(b.ok, false);
  assert.equal(b.notice.status, 503);
  assert.match(b.notice.title + ' ' + b.notice.message, /version/);
});

test('R72 a public repo gives a notice saying it is public', async () => {
  const world = makeWorld({ repoPrivate: false });
  const out = await setup({ world }).load();
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
  assert.match(out.notice.title + ' ' + out.notice.message, /public/i);
});

test('R72 the public repo notice comes before the missing settings notice', async () => {
  const world = makeWorld({ repoPrivate: false });
  world.files['board.config.json'] = null;
  const out = await setup({ world }).load();
  assert.equal(out.ok, false);
  assert.match(out.notice.title + ' ' + out.notice.message, /public/i);
});

test('R72 a notice is never replaced by an older good read', async () => {
  const s = setup();
  const good = await s.load();
  assert.equal(good.ok, true);
  s.world.files['board.config.json'] = null;
  s.clock.t += 60000;
  const out = await s.load();
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
});

test('R72 a missing theme file gives the default theme and no warning', async () => {
  const s = setup();
  const out = await s.load();
  assert.equal(out.ok, true);
  assert.deepEqual(out.bundle.theme, resolveTheme(null).theme);
  assert.deepEqual(out.bundle.run.warnings, []);
});

test('R85 a theme file that is not valid JSON gives a bundle with the default theme and a theme-unreadable warning', async () => {
  const world = makeWorld();
  world.files['theme.json'] = '{not json';
  const out = await setup({ world }).load();
  assert.equal(out.ok, true);
  assert.deepEqual(out.bundle.theme, resolveTheme(null).theme);
  assert.deepEqual(out.bundle.run.warnings.filter((w) => w.code === 'theme-unreadable'), [{ code: 'theme-unreadable', count: 1 }]);
});

test('U state texts: missing is null, valid JSON is parsed, invalid JSON is unreadable', async () => {
  const world = makeWorld();
  world.files['state/brief.json'] = JSON.stringify({ lines: [{ src: 'CAL', text: 'Hello' }] });
  world.files['state/calendar.json'] = '{broken';
  world.files['state/log.json'] = '[]';
  const out = await setup({ world }).load();
  const state = out.bundle.state;
  assert.deepEqual(Object.keys(state).sort(), ['brief', 'calendar', 'inbox', 'log', 'proposals']);
  assert.deepEqual(state.brief, { lines: [{ src: 'CAL', text: 'Hello' }] });
  assert.deepEqual(state.calendar, { error: 'unreadable' });
  assert.deepEqual(state.log, []);
  assert.equal(state.inbox, null);
  assert.equal(state.proposals, null);
});

test('U a state text longer than 256 KB is unreadable and one of exactly 256 KB is read', async () => {
  const world = makeWorld();
  world.files['state/brief.json'] = '"' + 'a'.repeat(262142) + '"'; // exactly 262144 bytes
  world.files['state/inbox.json'] = '"' + 'a'.repeat(262143) + '"'; // 262145 bytes
  world.files['state/log.json'] = '"' + 'é'.repeat(131073) + '"'; // fewer characters than the limit, more bytes
  const out = await setup({ world }).load();
  assert.equal(out.bundle.state.brief.length, 262142);
  assert.deepEqual(out.bundle.state.inbox, { error: 'unreadable' });
  assert.deepEqual(out.bundle.state.log, { error: 'unreadable' });
});

test('U the settings in the bundle are the parsed file exactly as written, and savedAt is the clock instant', async () => {
  const written = { ...settings(), name: 'Written Name' };
  const world = makeWorld();
  world.files['board.config.json'] = JSON.stringify(written);
  const s = setup({ world, at: '2026-10-12T06:10:00.123Z' });
  const out = await s.load();
  assert.deepEqual(out.bundle.settings, written);
  assert.equal(out.bundle.savedAt, '2026-10-12T06:10:00.123Z');
  assert.equal(out.bundle.raw.fetchedAt, '2026-10-12T06:10:00.123Z');
});

test('U run.readOnly follows env.readOnly', async () => {
  const on = await setup({ env: makeEnv({ readOnly: true }) }).load();
  const off = await setup({ env: makeEnv({ readOnly: false }) }).load();
  assert.equal(on.bundle.run.readOnly, true);
  assert.equal(off.bundle.run.readOnly, false);
  assert.equal(on.bundle.run.stale, null);
});

test('U a list that hit its cap arrives as a too-much-data warning in run.warnings', async () => {
  const world = makeWorld({ fullPartial: true });
  const out = await setup({ world }).load();
  const w = out.bundle.run.warnings.find((x) => x.code === 'too-much-data');
  assert.ok(w);
  assert.equal(w.count >= 1, true);
  assert.equal(out.bundle.raw.partial.issues, true);
});

test('U with configDir set the seven texts come from readFile and a missing file is null', async () => {
  const asked = [];
  const files = {
    'board.config.json': JSON.stringify(settings({ name: 'From Folder' })),
    'state/brief.json': '{"lines":[]}',
  };
  const readFile = async (p) => {
    asked.push(p);
    const key = FILE_NAMES.find((n) => p.replaceAll('\\', '/').endsWith('/' + n));
    if (key && Object.hasOwn(files, key)) return files[key];
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  };
  const world = makeWorld();
  world.files['board.config.json'] = JSON.stringify(settings({ name: 'From GitHub' }));
  const s = setup({ world, env: makeEnv({ configDir: '/somewhere/config' }), readFile });
  const out = await s.load();
  assert.equal(out.ok, true);
  assert.equal(out.bundle.settings.name, 'From Folder');
  assert.deepEqual(out.bundle.state.brief, { lines: [] });
  assert.equal(out.bundle.state.log, null);
  assert.deepEqual(out.bundle.theme, resolveTheme(null).theme);
  for (const n of FILE_NAMES) assert.equal(asked.some((p) => p.replaceAll('\\', '/').endsWith('/' + n)), true, n);
  assert.equal(world.calls.some((c) => c.path.startsWith(R + '/contents/')), false);
});

test('U a throwing cache write still answers', async () => {
  const cache = fakeCache();
  cache.writeLastGood = async () => { throw new Error('disk full'); };
  const out = await setup({ cache }).load();
  assert.equal(out.ok, true);
  assert.equal(out.bundle.raw.issues.length, 3);
});

test('U load never rejects, even when the cache read throws as well', async () => {
  const cache = fakeCache();
  cache.readLastGood = async () => { throw new Error('unreadable folder'); };
  const s = setup({ cache });
  s.world.fail = unavailable();
  const out = await s.load();
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
});

test('U a caller changing a returned bundle does not change the next answer', async () => {
  const s = setup();
  const first = await s.load();
  first.bundle.settings.name = 'Tampered';
  first.bundle.raw.issues.length = 0;
  first.bundle.state.brief = 'tampered';
  s.world.fail = unavailable();
  const second = await s.load();
  assert.equal(second.ok, true);
  assert.notEqual(second.bundle.settings.name, 'Tampered');
  assert.equal(second.bundle.raw.issues.length, 3);
  assert.notEqual(second.bundle.state.brief, 'tampered');
});

test('U a failed read does not count as the full read, so the next load is full again', async () => {
  const s = setup();
  s.world.fail = unavailable();
  const failed = await s.load();
  assert.equal(failed.ok, false);
  s.world.fail = null;
  s.clock.t += 30000;
  const out = await s.load();
  assert.equal(out.ok, true);
  assert.equal(isFull(lastIssuePath(s.world)), true);
});

test('U a failed incremental read keeps the earlier full read as the full read', async () => {
  const s = setup();
  await s.load();
  s.world.fail = unavailable();
  s.clock.t += 30000;
  await s.load();
  s.world.fail = null;
  s.clock.t += 30000;
  await s.load();
  assert.equal(isFull(lastIssuePath(s.world)), false);
  assert.equal(sinceOf(lastIssuePath(s.world)), '2026-10-12T06:05:00Z');
});
