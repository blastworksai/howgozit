// R155 on the native four-table Notion schema: with no `projects` list in the settings, the open Projects rows are the list.
// The world is built by seedHowgozit on the fake Notion; the reader is the real Notion adapter, and for the board tests the real loader and model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { seedHowgozit } from '../fixtures/notion-howgozit.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { settings as baseSettings } from '../fixtures/build.mjs';

const TOKEN = 'ntn_fake_token';
const NOW = '2026-10-12T06:10:00Z';
const LATER = '2026-10-12T06:20:00Z';
const CONFIG = '/srv/board-config';

async function world(overrides = {}, { withList = false } = {}) {
  const fake = createFakeNotion({ token: TOKEN });
  const ids = await seedHowgozit(fake, { habits: ['mood'] });
  const settings = baseSettings({
    modes: ['DO', 'THINK', 'REVIEW', 'LAUNCH'],
    notion: { projects: ids.projects, tasks: ids.tasks, goals: ids.goals, habitLog: ids.habitLog },
    ...overrides,
  });
  if (!withList && !('projects' in overrides)) delete settings.projects;
  const http = createNotionHttp({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  const readFile = async (p) => {
    if (String(p).endsWith('board.config.json')) return JSON.stringify(settings);
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  };
  const adapter = createNotionAdapter({ http, configDir: CONFIG, readFile });
  fake.addPage(ids.projects, { 'Project name': 'Yard', ID: 4 }, { edited: '2026-10-12T06:09:00Z' });
  fake.addPage(ids.projects, { 'Project name': 'House', ID: 2 }, { edited: '2026-10-12T06:09:00Z' });
  fake.addPage(ids.projects, { 'Project name': 'Old', ID: 3, Status: 'Done' }, { edited: '2026-10-12T06:09:00Z' });
  const clock = { t: Date.parse(NOW), now() { return clock.t; } };
  const cache = { readLastGood: async () => null, writeLastGood: async () => {}, etags: new Map() };
  const loader = createLoader({ env: { backend: 'notion', repo: 'notion', readOnly: false, configDir: CONFIG }, cache, clock, adapter });
  return { fake, ids, http, adapter, loader, clock };
}
const keys = (raw) => raw.projects.map((p) => p.number);
const board = (res) => buildBoard({ ...res.bundle, now: NOW });

test('R155 no projects list: every Projects row not Done shows, in ID order, the Done one absent', async () => {
  const w = await world();
  const { raw, texts } = await w.adapter.read({ full: true, now: NOW });
  assert.deepEqual(keys(raw), [2, 4]);
  assert.deepEqual(JSON.parse(texts.settings).projects, [
    { key: 'notion-2', owner: 'notion', number: 2 },
    { key: 'notion-4', owner: 'notion', number: 4 },
  ]);
});

test('R155 the built board shows the two open projects keyed notion-<ID> in ID order', async () => {
  const w = await world();
  const res = await w.loader.load({ full: true });
  assert.equal(res.ok, true);
  const b = board(res);
  assert.deepEqual(b.projects.map((p) => p.key), ['notion-2', 'notion-4']);
  assert.deepEqual(b.projects.map((p) => p.title), ['House', 'Yard']);
  assert.ok(!(b.warnings || []).includes('project-missing'));
});

test('R155 a settings projects list, when present, still decides which rows show', async () => {
  const w = await world({ projects: [{ key: 'yard', owner: 'notion', number: 4 }] });
  const { raw, texts } = await w.adapter.read({ full: true, now: NOW });
  assert.deepEqual(keys(raw), [4]);
  assert.deepEqual(JSON.parse(texts.settings).projects, [{ key: 'yard', owner: 'notion', number: 4 }]);
  const b = board(await w.loader.load({ full: true }));
  assert.deepEqual(b.projects.map((p) => p.key), ['yard']);
});

test('R155 a row added in Notion shows on the next read, full or delta, with no settings edit', async () => {
  const w = await world();
  await w.adapter.read({ full: true, now: NOW });
  w.fake.addPage(w.ids.projects, { 'Project name': 'Garage', ID: 5 }, { edited: '2026-10-12T06:15:00Z' });
  const delta = await w.adapter.read({ full: false, now: LATER });
  assert.deepEqual(keys(delta.raw), [2, 4, 5]);
  w.fake.addPage(w.ids.projects, { 'Project name': 'Attic', ID: 6 }, { edited: '2026-10-12T06:25:00Z' });
  const full = await w.adapter.read({ full: true, now: '2026-10-12T06:30:00Z' });
  assert.deepEqual(keys(full.raw), [2, 4, 5, 6]);
});

test('R155 a row moved to Done drops off on the next delta read', async () => {
  const w = await world();
  await w.adapter.read({ full: true, now: NOW });
  const yard = w.fake.state.dataSources[w.ids.projects].pages.find((p) => p.values['Project name'] === 'Yard');
  await w.http.request('PATCH', `/v1/pages/${yard.id}`, { properties: { Status: { status: { name: 'Done' } } } });
  const delta = await w.adapter.read({ full: false, now: LATER });
  assert.deepEqual(keys(delta.raw), [2]);
});

test('R155 focus naming notion-<ID> puts that project in focus on the built board', async () => {
  const w = await world({ focus: ['notion-4'] });
  const b = board(await w.loader.load({ full: true }));
  assert.deepEqual(b.focus.projects.map((p) => p.key), ['notion-4']);
  assert.ok(!(b.warnings || []).includes('focus-unknown'));
});

test('R155 settings with no projects list pass the settings check: no projects must be a list notice', async () => {
  const w = await world();
  const res = await w.loader.load({ full: true });
  assert.equal(res.ok, true);
  assert.equal(res.bundle.settings.projects.length, 2);
  assert.equal(res.bundle.settings.name, 'Sam');
  assert.ok(!JSON.stringify(res.bundle.run.warnings).includes('must be a list'));
});

test('R155 a projects value that is present but not a list stays a settings error', async () => {
  const w = await world({ projects: 'nope' });
  const res = await w.loader.load({ full: true });
  assert.equal(res.ok, false);
  assert.match(res.notice.message, /projects: must be a list/);
});
