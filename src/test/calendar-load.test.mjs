import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { settings } from '../fixtures/build.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const AT = '2026-10-12T06:10:00.900Z';
const TODAY = '2026-10-12';
const BLOCK = { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }] };

const EVENT = { title: 'Standup', start: '09:00', end: '09:30', kind: 'meeting' };
const FILE_EVENT = { title: 'From the file', start: '11:00', end: '11:30', kind: 'personal' };
const goodValue = (events = [EVENT]) => ({ date: TODAY, events });

function apiIssue(number) {
  return {
    id: number * 10, number, title: 'Task ' + number, state: 'open', state_reason: null,
    labels: [], milestone: null, comments: 0,
    created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
    html_url: 'https://github.com/' + REPO + '/issues/' + number,
  };
}

function notFound(p) {
  return new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
}

// The same kind of fake GitHub world as load.test.mjs; `calendar` goes into the settings file.
function makeWorld({ calendar, calendarFile = null, theme = null } = {}) {
  const world = {
    calls: [],
    fail: null,
    files: {
      'board.config.json': JSON.stringify(settings(calendar === undefined ? {} : { calendar })),
      'theme.json': theme,
      'state/brief.json': null,
      'state/calendar.json': calendarFile === null ? null : JSON.stringify(calendarFile),
      'state/inbox.json': null,
      'state/log.json': null,
      'state/proposals.json': null,
    },
    full: [apiIssue(1), apiIssue(2), apiIssue(3)],
  };
  function answer(method, p) {
    world.calls.push({ method, path: p });
    if (world.fail) throw world.fail;
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    const f = p.startsWith(R + '/contents/') ? p.slice((R + '/contents/').length) : null;
    if (f !== null) {
      if (!Object.hasOwn(world.files, f) || world.files[f] === null) throw notFound(p);
      return { content: Buffer.from(world.files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?')) return { items: structuredClone(world.full), partial: false };
    if (p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    if (p === '/orgs/' + OWNER + '/projectsV2?per_page=100') return { items: [], partial: false };
    throw notFound(p);
  }
  world.http = {
    async get(p) { return { status: 200, json: answer('get', p), notModified: false, link: null }; },
    async paged(p) { return answer('paged', p); },
  };
  return world;
}

function fakeCache() {
  const c = {
    stored: null,
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

// A calendar stand-in: records every call and answers with `answer` (a value, or a function of the args).
function makeSource(answer) {
  const src = {
    calls: [],
    answer,
    async read(args) {
      src.calls.push(structuredClone(args));
      return typeof src.answer === 'function' ? src.answer(args) : structuredClone(src.answer);
    },
  };
  return src;
}

function setup({ world = makeWorld({ calendar: BLOCK }), source, at = AT } = {}) {
  const cache = fakeCache();
  const clock = makeClock(at);
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-TOKEN-123' };
  const loader = createLoader({ http: world.http, env, cache, clock, ...(source ? { calendar: source } : {}) });
  return { world, cache, clock, source, loader, load: loader.load };
}

const warningsOf = (out, code) => out.bundle.run.warnings.filter((w) => w.code === code);
const githubWrites = (world) => world.calls.filter((c) => c.method !== 'get' && c.method !== 'paged');

test('R96 a block and a source: read is called once with the calendars, the settings timezone and the load instant', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const s = setup({ source });
  const out = await s.load();
  assert.equal(out.ok, true);
  assert.equal(source.calls.length, 1);
  assert.deepEqual(source.calls[0], {
    calendars: [{ name: 'Home', kind: 'personal' }],
    tz: 'Europe/Brussels',
    now: '2026-10-12T06:10:00.900Z',
  });
});

test('R96 a block and a source: the source value is state.calendar', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const out = await setup({ source }).load();
  assert.deepEqual(out.bundle.state.calendar, goodValue());
});

test('R96 with a block the source events win over a state/calendar.json holding a different event', async () => {
  const source = makeSource({ value: goodValue([EVENT]), warnings: [] });
  const world = makeWorld({ calendar: BLOCK, calendarFile: goodValue([FILE_EVENT]) });
  const out = await setup({ world, source }).load();
  assert.deepEqual(out.bundle.state.calendar.events, [EVENT]);
  assert.equal(JSON.stringify(out.bundle.state.calendar).includes('From the file'), false);
});

test('R96 with a block and a source, the file is still what drives the panel when the source is not asked (twin: no block)', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const world = makeWorld({ calendarFile: goodValue([FILE_EVENT]) });
  const out = await setup({ world, source }).load();
  assert.equal(source.calls.length, 0);
  assert.deepEqual(out.bundle.state.calendar, goodValue([FILE_EVENT]));
});

test('R96 no block and the file absent: read is never called and state.calendar is null', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const out = await setup({ world: makeWorld(), source }).load();
  assert.equal(source.calls.length, 0);
  assert.equal(out.bundle.state.calendar, null);
});

test('R96 no block and the file present: state.calendar is what the file gives', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const world = makeWorld({ calendarFile: goodValue([FILE_EVENT]) });
  const out = await setup({ world, source }).load();
  assert.equal(source.calls.length, 0);
  assert.deepEqual(out.bundle.state.calendar, goodValue([FILE_EVENT]));
});

test('R96 a block and no source: state.calendar is unreadable and calendar-no-login is raised once', async () => {
  const world = makeWorld({ calendar: BLOCK, calendarFile: goodValue([FILE_EVENT]) });
  const out = await setup({ world }).load();
  assert.equal(out.ok, true);
  assert.deepEqual(out.bundle.state.calendar, { error: 'unreadable', from: 'icloud' });
  assert.deepEqual(warningsOf(out, 'calendar-no-login'), [{ code: 'calendar-no-login', count: 1 }]);
});

test('R96 no block and no source: no calendar-no-login warning (twin)', async () => {
  const out = await setup({ world: makeWorld() }).load();
  assert.deepEqual(warningsOf(out, 'calendar-no-login'), []);
  assert.equal(out.bundle.state.calendar, null);
});

test('R96 a block the settings rules reject (source yahoo): read is not called and the file drives the panel', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const world = makeWorld({ calendar: { source: 'yahoo', calendars: [{ name: 'Home' }] }, calendarFile: goodValue([FILE_EVENT]) });
  const out = await setup({ world, source }).load();
  assert.equal(out.ok, true);
  assert.equal(source.calls.length, 0);
  assert.deepEqual(out.bundle.state.calendar, goodValue([FILE_EVENT]));
  assert.deepEqual(warningsOf(out, 'calendar-no-login'), []);
});

test('R96 the source warnings appear in run.warnings', async () => {
  const source = makeSource({ value: goodValue(), warnings: [{ code: 'calendar-not-found', count: 2 }] });
  const out = await setup({ source }).load();
  assert.deepEqual(warningsOf(out, 'calendar-not-found'), [{ code: 'calendar-not-found', count: 2 }]);
});

test('R96 the source warnings are merged with another warning of the load', async () => {
  const source = makeSource({ value: goodValue(), warnings: [{ code: 'calendar-not-found', count: 2 }] });
  const world = makeWorld({ calendar: BLOCK, theme: '{broken' });
  const out = await setup({ world, source }).load();
  assert.deepEqual(warningsOf(out, 'theme-unreadable'), [{ code: 'theme-unreadable', count: 1 }]);
  assert.deepEqual(warningsOf(out, 'calendar-not-found'), [{ code: 'calendar-not-found', count: 2 }]);
});

test('R96 the saved last good read holds the calendar value, and the loader wrote nothing to GitHub', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const s = setup({ source });
  const out = await s.load();
  assert.equal(out.ok, true);
  assert.equal(s.cache.writes, 1);
  assert.deepEqual(s.cache.stored.state.calendar, goodValue());
  assert.equal(s.world.calls.length > 0, true);
  assert.deepEqual(githubWrites(s.world), []);
});

test('R101 a source whose read rejects gives unreadable and calendar-unreachable, with GitHub data fresh', async () => {
  const source = makeSource(() => { throw new Error('boom'); });
  const out = await setup({ source }).load();
  assert.equal(out.ok, true);
  assert.equal(out.bundle.run.stale, null);
  assert.deepEqual(out.bundle.state.calendar, { error: 'unreadable', from: 'icloud' });
  assert.deepEqual(warningsOf(out, 'calendar-unreachable'), [{ code: 'calendar-unreachable', count: 1 }]);
});

for (const [label, junk] of [['null', null], ['an empty object', {}], ['a value that is not an object', { value: 1 }]]) {
  test(`R101 a source returning junk (${label}) gives unreadable and calendar-unreachable, with GitHub data fresh`, async () => {
    const source = makeSource(junk);
    const out = await setup({ source }).load();
    assert.equal(out.ok, true);
    assert.equal(out.bundle.run.stale, null);
    assert.deepEqual(out.bundle.state.calendar, { error: 'unreadable', from: 'icloud' });
    assert.deepEqual(warningsOf(out, 'calendar-unreachable'), [{ code: 'calendar-unreachable', count: 1 }]);
  });
}

test('R101 a good source gives no calendar-unreachable and no stale (twin)', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const out = await setup({ source }).load();
  assert.equal(out.bundle.run.stale, null);
  assert.deepEqual(warningsOf(out, 'calendar-unreachable'), []);
});

test('R101 a source value marked stale with its own warning is passed through unchanged', async () => {
  const value = { date: TODAY, events: [EVENT], stale: true };
  const source = makeSource({ value, warnings: [{ code: 'calendar-unreachable', count: 1 }] });
  const out = await setup({ source }).load();
  assert.equal(out.ok, true);
  assert.equal(out.bundle.run.stale, null);
  assert.deepEqual(out.bundle.state.calendar, { date: TODAY, events: [EVENT], stale: true });
  assert.deepEqual(warningsOf(out, 'calendar-unreachable'), [{ code: 'calendar-unreachable', count: 1 }]);
});

test('R101 when GitHub fails after a good load, the stale bundle keeps the earlier calendar value and Apple is not asked', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const s = setup({ source });
  const first = await s.load();
  assert.equal(first.bundle.run.stale, null);
  assert.equal(source.calls.length, 1);
  s.world.fail = new GitHubError('server', 503, 'GitHub is not answering right now.');
  s.clock.t += 60000;
  const out = await s.load();
  assert.equal(out.ok, true);
  assert.notEqual(out.bundle.run.stale, null);
  assert.deepEqual(out.bundle.state.calendar, goodValue());
  assert.equal(source.calls.length, 1);
});

test('U ten loads started together call read once', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const s = setup({ source });
  const outs = await Promise.all(Array.from({ length: 10 }, () => s.load()));
  assert.equal(outs.every((o) => o.ok === true), true);
  assert.equal(source.calls.length, 1);
});

test('U the board built from a bundle with the source value shows the events in panels.calendar', async () => {
  const source = makeSource({ value: goodValue(), warnings: [] });
  const out = await setup({ source }).load();
  const b = out.bundle;
  const board = buildBoard({ raw: b.raw, settings: b.settings, theme: b.theme, state: b.state, run: b.run, now: AT });
  assert.equal(board.panels.calendar.stale, false);
  assert.equal(board.panels.calendar.date, TODAY);
  assert.deepEqual(board.panels.calendar.events, [EVENT]);
});

test('U the board built without the source value does not show the events (twin)', async () => {
  const out = await setup({ world: makeWorld(), source: makeSource({ value: goodValue(), warnings: [] }) }).load();
  const b = out.bundle;
  const board = buildBoard({ raw: b.raw, settings: b.settings, theme: b.theme, state: b.state, run: b.run, now: AT });
  assert.equal(board.panels.calendar, null);
});
