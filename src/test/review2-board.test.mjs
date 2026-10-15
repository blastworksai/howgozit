// Review follow-ups, round two: R59 (an add answered 422 is noted as a Project item, R70)
// and R95 (a page that is not a board page is not swapped in; the window is reloaded).
// Written from references/contract.md. Fake loader, real guard, recording gh, fake clock;
// the script of R95 runs inside node:vm against small hand-made stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGuard } from '../board/guard.mjs';
import { createHandlers } from '../board/handlers.mjs';
import { createLoader } from '../board/load.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { NOW, settings, project, milestone, task, idea, raw, state, resetNumbers } from '../fixtures/build.mjs';

const HOST = 'localhost:8787';
const SECRET = 'SENTINEL-TOKEN-123';

// ---------- R59 through the handlers ----------

function setup(addBehaviour) {
  resetNumbers();
  const world = {
    raw: raw({
      ownerType: 'organization',
      issues: [idea({ number: 50, title: 'Shelves' }), task({ number: 60, title: 'Paint the door' })],
      projects: [project(3, 'House', [60])],
      milestones: [milestone(5, 'House · Hallway', '2026-10-20')],
    }),
    settings: settings({ projects: [{ key: 'house', number: 3 }] }),
    state: state(),
  };
  const loader = {
    writes: [],
    async load() {
      return {
        ok: true,
        bundle: {
          savedAt: NOW, raw: world.raw, settings: world.settings, theme: resolveTheme(null).theme,
          state: world.state, run: { stale: null, readOnly: false, warnings: [] },
        },
      };
    },
    noteWrite(x) { loader.writes.push(x); },
    fullDue() { return false; },
  };
  const gh = {
    adds: [],
    async createIssue() { return {}; },
    async patchIssue(number, patch) {
      return { number, title: 'x', labels: [], state: 'open', state_reason: null, created_at: NOW, updated_at: NOW, closed_at: null, ...patch };
    },
    async addProjectItem(args) {
      gh.adds.push(args);
      if (addBehaviour) throw addBehaviour();
      return { id: 'item-1' };
    },
  };
  const clock = { t: Date.parse(NOW), now() { return this.t; } };
  const guard = createGuard({ token: SECRET, allowedHosts: [HOST], identityHeader: null, clock });
  const env = { repo: 'home-owner/life', readOnly: false };
  const h = createHandlers({ loader, gh, guard, env, clock, random: () => 'NONCE123' });
  return { h, gh, guard, loader };
}
const sortReq = {
  method: 'POST',
  url: '/actions/sort',
  headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
};
const doSort = (s) => s.h.action('sort', sortReq, { token: s.guard.formToken('sort', '50'), number: '50', target: 'house/5' });
const itemNotes = (s) => s.loader.writes.filter((w) => w.item);

test('R59 an add answered 422 is noted to the loader as an item of that project and the sort answers 303', async () => {
  const s = setup(() => new GitHubError('invalid', 422));
  const res = await doSort(s);
  assert.equal(res.status, 303);
  assert.equal(s.gh.adds.length, 1);
  assert.deepEqual(itemNotes(s), [{ item: { projectOwner: null, projectNumber: 3, issueNumber: 50 } }], 'the 422 add is noted as an item of project 3, issue 50');
});

test('R59 an add that succeeds is noted once as an item of that project', async () => {
  const s = setup(null);
  const res = await doSort(s);
  assert.equal(res.status, 303);
  assert.deepEqual(itemNotes(s), [{ item: { projectOwner: null, projectNumber: 3, issueNumber: 50 } }]);
});

for (const [label, status, make] of [
  ['500', 502, () => new GitHubError('server', 500)],
  ['403', 502, () => new GitHubError('auth', 403)],
]) {
  test(`R59 an add answered ${label} is not noted as an item and the sort fails`, async () => {
    const s = setup(make);
    const res = await doSort(s);
    assert.equal(res.status, status);
    assert.deepEqual(itemNotes(s), []);
  });
}

// ---------- R59 / R70 end to end: real loader, real handlers ----------

const OWNER = 'home-owner';
const REPO = `${OWNER}/life`;
const R = `/repos/${REPO}`;
const apiIssue = (number, extra = {}) => ({
  id: number * 10, number, title: `Item ${number}`, state: 'open', state_reason: null, labels: [], milestone: null, comments: 0,
  created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
  html_url: `https://github.com/${REPO}/issues/${number}`, ...extra,
});
const notFound = (p) => new GitHubError('not-found', 404, `Nothing is stored at ${p}.`);

function endToEnd() {
  const world = {
    files: { 'board.config.json': JSON.stringify(settings({ projects: [{ key: 'house', number: 3 }] })) },
    issues: [apiIssue(41, { title: 'Shelves for the hall', labels: ['idea'] })],
    items: { 3: [] }, // GitHub's item list never shows the issue
  };
  const answer = (p) => {
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p.startsWith(`${R}/contents/`)) {
      const f = p.slice(`${R}/contents/`.length);
      if (world.files[f] == null) throw notFound(p);
      return { content: Buffer.from(world.files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(`${R}/issues?`)) return { items: structuredClone(p.includes('&since=') ? [] : world.issues), partial: false };
    if (p.startsWith(`${R}/milestones?`)) return { items: [], partial: false };
    if (p === `/orgs/${OWNER}/projectsV2?per_page=100`) {
      return { items: Object.keys(world.items).map((n) => ({ number: Number(n), title: `Project ${n}`, state: 'open' })), partial: false };
    }
    if (new RegExp(`^/orgs/${OWNER}/projectsV2/\\d+/fields\\?`).test(p)) {
      return { items: [{ id: 11, name: 'Status' }, { id: 12, name: 'Due' }], partial: false };
    }
    if (new RegExp(`^/orgs/${OWNER}/projectsV2/\\d+/items\\?`).test(p)) return { items: [], partial: false };
    throw notFound(p);
  };
  const http = {
    async get(p) { return { status: 200, json: answer(p), notModified: false, link: null }; },
    async paged(p) { return answer(p); },
  };
  const cache = {
    stored: null,
    async readLastGood() { return cache.stored; },
    async writeLastGood(b) { cache.stored = structuredClone(b); },
    etags: { get() {}, set() {} },
  };
  const clock = { t: Date.parse('2026-10-12T06:10:00.900Z'), now() { return this.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: SECRET };
  const loader = createLoader({ http, env, cache, clock });
  const gh = {
    async createIssue() { return {}; },
    async patchIssue(number, patch) { return { ...apiIssue(number, { title: 'Shelves for the hall' }), ...patch }; },
    async addProjectItem() { throw new GitHubError('invalid', 422); },
  };
  const guard = createGuard({ token: SECRET, allowedHosts: [HOST], identityHeader: null, clock });
  const h = createHandlers({ loader, gh, guard, env, clock, random: () => 'NONCE123' });
  return { h, guard, loader };
}

test('R59 an add answered 422 while the item list still lacks the issue shows the issue under that project on the next load', async () => {
  const s = endToEnd();
  const res = await s.h.action('sort', sortReq, { token: s.guard.formToken('sort', '41'), number: '41', target: 'house' });
  assert.equal(res.status, 303);
  const after = await s.loader.load();
  assert.equal(after.ok, true);
  const p3 = after.bundle.raw.projects.find((p) => p.number === 3);
  assert.deepEqual(p3.items.filter((i) => i.number === 41).map((i) => i.number), [41], 'issue 41 is an item of project 3');
});

// ---------- R95: the script, run in node:vm ----------

const SCRIPT = fs.readFileSync(fileURLToPath(new URL('../board/static/board.js', import.meta.url)), 'utf8');
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

// Stand-ins: a page is a list of section nodes; DOMParser reads `<div data-section="x">..</div>` out of text.
// They do not imitate focus, forms with real fields, style blocks, layout or any event but submit.
function runScript({ followUp }) {
  const log = { reloads: 0, removed: [], replaced: [], fetched: [], submitted: 0 };
  const node = (html) => {
    const name = /data-section="([^"]+)"/.exec(html)[1];
    const n = {
      outerHTML: html,
      getAttribute: (a) => (a === 'data-section' ? name : null),
      querySelector: () => null,
      contains: () => false,
      remove() { log.removed.push(name); live = live.filter((x) => x !== n); },
      replaceWith(other) { log.replaced.push(name); live = live.map((x) => (x === n ? other : x)); },
    };
    return n;
  };
  const parse = (text) => (text.match(/<div data-section="[^"]+">[^<]*<\/div>/g) || []).map(node);
  let live = parse('<div data-section="capture">c</div><div data-section="today">OLD</div>');
  let listener = null;
  const document = {
    activeElement: null,
    addEventListener: (type, fn) => { if (type === 'submit') listener = fn; },
    querySelectorAll: () => live.slice(),
    querySelector: () => null,
    importNode: (n) => n,
    createElement: () => ({ setAttribute() {}, set textContent(_v) {} }),
  };
  const form = {
    tagName: 'FORM',
    action: '/actions/habit',
    nextElementSibling: null,
    closest: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    removeAttribute() {},
    submit() { log.submitted += 1; },
    after() {},
  };
  const fetchStub = async (url) => {
    log.fetched.push(url);
    if (url !== '/') return { ok: true, status: 200, text: async () => '' };
    return { ok: followUp.status >= 200 && followUp.status < 300, status: followUp.status, text: async () => followUp.body };
  };
  const context = vm.createContext({
    document,
    window: { location: { reload: () => { log.reloads += 1; } } },
    location: { reload: () => { log.reloads += 1; } },
    fetch: fetchStub,
    DOMParser: class { parseFromString(text) { const found = parse(text); return { querySelectorAll: () => found, querySelector: () => null, body: { textContent: text } }; } },
    FormData: class { constructor() { this.entries = []; } *[Symbol.iterator]() { yield* this.entries; } },
    URLSearchParams,
  });
  vm.runInContext(SCRIPT, context, { filename: 'board.js' });
  assert.equal(typeof listener, 'function', 'the script registers a submit listener');
  return {
    log,
    async submit() {
      listener({ target: form, defaultPrevented: false, preventDefault() {}, submitter: undefined });
      await tick();
    },
    liveNames: () => live.map((n) => n.getAttribute('data-section')),
  };
}

test('R95 a follow-up fetch answered 503 with a notice page changes nothing and reloads the window', async () => {
  const s = runScript({ followUp: { status: 503, body: '<html><body><p>The board is unavailable.</p></body></html>' } });
  await s.submit();
  assert.deepEqual(s.log.removed, [], 'no section is removed');
  assert.deepEqual(s.log.replaced, [], 'no section is replaced');
  assert.equal(s.log.reloads, 1, 'location.reload() is called once');
});

test('R95 a follow-up fetch answered 200 with a page that holds no section changes nothing and reloads the window', async () => {
  const s = runScript({ followUp: { status: 200, body: '<html><body><form><input name="user"></form></body></html>' } });
  await s.submit();
  assert.deepEqual(s.log.removed, [], 'no section is removed');
  assert.deepEqual(s.log.replaced, [], 'no section is replaced');
  assert.equal(s.log.reloads, 1, 'location.reload() is called once');
});

test('R95 a follow-up fetch answered 200 with an ordinary board page swaps in the changed section and does not reload', async () => {
  const s = runScript({
    followUp: { status: 200, body: '<html><body><div data-section="capture">c</div><div data-section="today">NEW</div></body></html>' },
  });
  await s.submit();
  assert.deepEqual(s.log.replaced, ['today']);
  assert.deepEqual(s.log.removed, []);
  assert.equal(s.log.reloads, 0);
  assert.deepEqual(s.liveNames(), ['capture', 'today']);
});
