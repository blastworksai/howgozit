// R96 / R101: the Today card names iCloud, not a file, when iCloud was the road that failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../board/load.mjs';
import { checkBoard } from '../board/shape-data.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { settings, board, state } from '../fixtures/build.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const AT = '2026-10-12T06:10:00.900Z';
const BLOCK = { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }] };
const FROM_ICLOUD = { error: 'unreadable', from: 'icloud' };
const ICLOUD_WORDS = 'The calendar could not be read from iCloud. See the note at the foot of the page.';
const FILE_WORDS = 'This file could not be read. Check state/calendar.json in the data repo.';

function makeHttp() {
  const files = {
    'board.config.json': JSON.stringify(settings({ calendar: BLOCK })),
  };
  const notFound = (p) => new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
  const answer = (p) => {
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p.startsWith(R + '/contents/')) {
      const f = p.slice((R + '/contents/').length);
      if (!Object.hasOwn(files, f)) throw notFound(p);
      return { content: Buffer.from(files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?') || p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    if (p === '/orgs/' + OWNER + '/projectsV2?per_page=100') return { items: [], partial: false };
    throw notFound(p);
  };
  return {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
}

function makeLoader(calendar) {
  const cache = {
    async readLastGood() { return null; },
    async writeLastGood() {},
    etags: { get() {}, set() {} },
  };
  const clock = { t: Date.parse(AT), now() { return clock.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-TOKEN-123' };
  return createLoader({ http: makeHttp(), env, cache, clock, ...(calendar ? { calendar } : {}) });
}

const warningsOf = (out, code) => out.bundle.run.warnings.filter((w) => w.code === code);

test('R101 loader, iCloud road: a failed read with nothing kept gives unreadable from icloud', async () => {
  const source = { async read() { return { value: { error: 'unreadable' }, warnings: [{ code: 'calendar-unreachable', count: 1 }] }; } };
  const out = await makeLoader(source).load();
  assert.equal(out.ok, true);
  assert.deepEqual(out.bundle.state.calendar, FROM_ICLOUD);
});

test('R101 loader, iCloud road: a source that throws gives unreadable from icloud', async () => {
  const source = { async read() { throw new Error('boom'); } };
  const out = await makeLoader(source).load();
  assert.equal(out.ok, true);
  assert.deepEqual(out.bundle.state.calendar, FROM_ICLOUD);
});

test('R96 loader: a calendar block and no sign-in gives unreadable from icloud and calendar-no-login once', async () => {
  const out = await makeLoader(null).load();
  assert.equal(out.ok, true);
  assert.deepEqual(out.bundle.state.calendar, FROM_ICLOUD);
  assert.deepEqual(warningsOf(out, 'calendar-no-login'), [{ code: 'calendar-no-login', count: 1 }]);
});

const sourceOf = (b, id) => (b.meta?.sources || []).find((s) => s.id === id);

test('R101 model: a broken iCloud calendar keeps its origin, the source is in error and the shape holds', () => {
  const b = board({ state: state({ calendar: FROM_ICLOUD }) });
  assert.deepEqual(b.panels.calendar, FROM_ICLOUD);
  assert.equal(sourceOf(b, 'calendar')?.state, 'error');
  assert.equal(checkBoard(b).ok, true);
});

test('R101 model twin: a broken calendar file stays plain unreadable and the shape holds', () => {
  const b = board({ state: state({ calendar: { error: 'unreadable' } }) });
  assert.deepEqual(b.panels.calendar, { error: 'unreadable' });
  assert.equal(sourceOf(b, 'calendar')?.state, 'error');
  assert.equal(checkBoard(b).ok, true);
});

test('R101 shape: from icloud is refused on any other broken panel and any other origin is refused on the calendar', () => {
  const b = board();
  assert.equal(checkBoard(b).ok, true);
  const other = structuredClone(b);
  other.panels.inbox = { ...FROM_ICLOUD };
  assert.equal(checkBoard(other).ok, false);
  const elsewhere = structuredClone(b);
  elsewhere.panels.calendar = { error: 'unreadable', from: 'elsewhere' };
  assert.equal(checkBoard(elsewhere).ok, false);
});

const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };

function sectionHtml(html, name) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)];
  const i = marks.findIndex((m) => m[1] === name);
  if (i < 0) return null;
  const end = i + 1 < marks.length ? marks[i + 1].index : html.length;
  return html.slice(marks[i].index, end);
}

function pageWith(panels) {
  const b = board();
  b.panels = { ...b.panels, ...panels };
  return renderPage(b, THEME, OPTS);
}

test('R101 page: the broken iCloud calendar card says iCloud and names no file', () => {
  const cal = sectionHtml(pageWith({ calendar: { ...FROM_ICLOUD } }), 'calendar');
  assert.ok(cal, 'no calendar section');
  assert.ok(cal.includes(ICLOUD_WORDS));
  assert.ok(!cal.includes('state/calendar.json'));
});

test('R101 page twin: a broken calendar file keeps the file sentence, and the inbox card still names its file', () => {
  const html = pageWith({ calendar: { error: 'unreadable' }, inbox: { error: 'unreadable' } });
  const cal = sectionHtml(html, 'calendar');
  assert.ok(cal, 'no calendar section');
  assert.ok(cal.includes(FILE_WORDS));
  assert.ok(!cal.includes(ICLOUD_WORDS));
  const inbox = sectionHtml(html, 'inbox');
  assert.ok(inbox, 'no inbox section');
  assert.ok(inbox.includes('state/inbox.json'));
});
