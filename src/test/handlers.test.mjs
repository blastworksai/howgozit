// Handler rules R55, R62, R63, R67, R70, R72, R77, written from the pinned design
// and references/contract.md before board/handlers.mjs is read.
// Fake loader, real guard, recording low-level gh, fake clock. No network, no files, no real clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../board/guard.mjs';
import { createHandlers, securityHeaders } from '../board/handlers.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { NOW, settings, project, milestone, task, idea, raw, state, checkin, resetNumbers } from '../fixtures/build.mjs';

const SENTINEL = 'SENTINEL-TOKEN-123';
const HOST = 'localhost:8787';
const TODAY = '2026-10-12';
const HOUR = 3600 * 1000;

const CSP_FONTS = (n) =>
  `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${n}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
const HEADER_NAMES = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'cache-control'];

function ghError() {
  return Object.assign(new Error('GitHub is not answering right now.'), { name: 'GitHubError', kind: 'server', status: 500 });
}

// ---------- the harness ----------

function setup({ readOnly = false, ownerType = 'organization' } = {}) {
  resetNumbers();
  const events = [];
  const world = {
    raw: raw({
      ownerType,
      issues: [idea({ number: 50, title: 'Shelves' }), task({ number: 60, title: 'Paint the door' })],
      projects: [project(3, 'House', [60])],
      milestones: [milestone(5, 'House · Hallway', '2026-10-20')],
    }),
    settings: settings({
      projects: [{ key: 'house', number: 3 }],
      habits: [{ id: 'move', title: 'Move', start: '2026-10-01' }],
    }),
    state: state(),
    stale: null,
    notice: null,
    rejectLoad: false,
    sync: null,
  };
  const loader = {
    loads: 0,
    writes: [],
    async load() {
      loader.loads += 1;
      events.push('load');
      if (world.rejectLoad) throw new Error('boom at /secret/path');
      if (world.sync) world.sync();
      if (world.notice) return { ok: false, notice: world.notice };
      return {
        ok: true,
        bundle: {
          savedAt: NOW,
          raw: world.raw,
          settings: world.settings,
          theme: resolveTheme(null).theme,
          state: world.state,
          run: { stale: world.stale, readOnly, warnings: [] },
        },
      };
    },
    noteWrite(x) {
      loader.writes.push(x);
      events.push('noteWrite');
    },
    fullDue() {
      return false;
    },
  };
  const gh = {
    calls: [],
    fail: false,
    next: 900,
    attempt(name, args) {
      gh.calls.push({ name, args });
      events.push('gh');
      if (gh.fail) throw ghError();
    },
    async createIssue({ title, labels }) {
      gh.attempt('createIssue', { title, labels });
      return { number: gh.next++, title, labels, state: 'open', state_reason: null, created_at: NOW, updated_at: NOW, closed_at: null };
    },
    async patchIssue(number, patch) {
      gh.attempt('patchIssue', { number, patch });
      return { number, title: 'x', labels: [], state: 'open', state_reason: null, created_at: NOW, updated_at: NOW, closed_at: null, ...patch };
    },
    async addProjectItem(args) {
      gh.attempt('addProjectItem', args);
      return { id: 'item-1' };
    },
  };
  const clock = { t: Date.parse(NOW), now() { return this.t; } };
  const guard = createGuard({ token: SENTINEL, allowedHosts: [HOST], identityHeader: null, clock });
  const env = { repo: 'sam-life/life', readOnly };
  const h = createHandlers({ loader, gh, guard, env, clock, random: () => 'NONCE123' });
  return { h, world, loader, gh, guard, clock, events, env };
}

const req = (extra = {}, url = '/actions/idea') => ({
  method: 'POST',
  url,
  headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded', ...extra },
});
const getReq = () => ({ method: 'GET', url: '/', headers: { host: HOST } });
const act = (s, name, form, extra = {}) => s.h.action(name, req(extra, `/actions/${name}`), form);

const forms = {
  idea: (s, title = 'Shelves for the hall') => ({ token: s.guard.formToken('idea', 'new'), title }),
  habit: (s, on = '1') => ({
    token: s.guard.formToken('habit', `move:${TODAY}:${on === '1' ? 'on' : 'off'}`),
    id: 'move',
    date: TODAY,
    on,
  }),
  sort: (s) => ({ token: s.guard.formToken('sort', '50'), number: '50', target: 'house/5' }),
  close: (s) => ({ token: s.guard.formToken('close', '60'), number: '60' }),
};
const NAMES = ['idea', 'habit', 'sort', 'close'];

function tokenFromPage(html, action) {
  const re = new RegExp(`<form[^>]*action="/actions/${action}"[^>]*>\\s*<input type="hidden" name="token" value="([^"]+)"`);
  const m = re.exec(html);
  assert.ok(m, `the page has a ${action} form with a token`);
  return m[1];
}

const noTrace = (body) => assert.ok(!/^ {4}at /m.test(body), 'no stack trace line');

// ---------- R77 ----------

test('R77 the policy is spelled exactly with the nonce and both font hosts', () => {
  const hd = securityHeaders({ nonce: 'N', fontHosts: true });
  assert.equal(hd['content-security-policy'], CSP_FONTS('N'));
});

test('R77 without font hosts neither font host appears and the style source keeps the nonce', () => {
  const hd = securityHeaders({ nonce: 'N', fontHosts: false });
  const csp = hd['content-security-policy'];
  assert.ok(!csp.includes('fonts.googleapis.com'));
  assert.ok(!csp.includes('fonts.gstatic.com'));
  assert.ok(csp.includes("style-src 'self' 'nonce-N'"));
  assert.ok(csp.startsWith("default-src 'none'; script-src 'self'; "));
  assert.ok(csp.endsWith("form-action 'self'; base-uri 'none'; frame-ancestors 'none'"));
});

test('R77 with no nonce the style source is the page itself, plus the font host only when asked', () => {
  const plain = securityHeaders()['content-security-policy'];
  assert.ok(plain.includes("style-src 'self';"));
  assert.ok(!plain.includes('nonce-'));
  assert.ok(!plain.includes('fonts.'));
  const withFonts = securityHeaders({ fontHosts: true })['content-security-policy'];
  assert.ok(withFonts.includes("style-src 'self' https://fonts.googleapis.com;"));
  assert.ok(withFonts.includes('font-src https://fonts.gstatic.com'));
});

test('R77 the other three headers are nosniff, no-referrer and no-store', () => {
  const hd = securityHeaders({ nonce: 'N' });
  assert.equal(hd['x-content-type-options'], 'nosniff');
  assert.equal(hd['referrer-policy'], 'no-referrer');
  assert.equal(hd['cache-control'], 'no-store');
});

test('R77 the page answer carries all four headers and the right content type', async () => {
  const s = setup();
  const res = await s.h.page(getReq());
  assert.equal(res.status, 200);
  for (const n of HEADER_NAMES) assert.ok(res.headers[n], `page has ${n}`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(res.headers['content-security-policy'].includes("'nonce-NONCE123'"));
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
});

test('R77 a notice answer and a refusal answer carry all four headers', async () => {
  const s = setup();
  s.world.notice = { title: 'No settings file found', message: 'Run the setup step.', status: 503 };
  const notice = await s.h.page(getReq());
  for (const n of HEADER_NAMES) assert.ok(notice.headers[n], `notice has ${n}`);
  const t = setup();
  const refusal = await act(t, 'idea', { title: 'x' });
  assert.equal(refusal.status, 403);
  for (const n of HEADER_NAMES) assert.ok(refusal.headers[n], `refusal has ${n}`);
});

test('R77 the page holds no style attribute, no on-attribute and exactly one script with a src and no content', async () => {
  const s = setup();
  const { body } = await s.h.page(getReq());
  assert.equal((body.match(/style="/g) || []).length, 0);
  assert.equal((body.match(/ on[a-z]+="/g) || []).length, 0);
  const scripts = body.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
  assert.equal((body.match(/<script/g) || []).length, 1);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^<script [^>]*src="[^"]+"[^>]*><\/script>$/);
});

test('R77 the nonce in the policy equals the nonce on the style block', async () => {
  const s = setup();
  const res = await s.h.page(getReq());
  const fromHeader = /'nonce-([^']+)'/.exec(res.headers['content-security-policy']);
  const fromBody = /<style nonce="([^"]+)"/.exec(res.body);
  assert.ok(fromHeader && fromBody);
  assert.equal(fromHeader[1], 'NONCE123');
  assert.equal(fromBody[1], fromHeader[1]);
});

// ---------- R62 ----------

test('R62 each of the four actions with a valid post answers 303 to the front page', async () => {
  for (const name of NAMES) {
    const s = setup();
    const res = await act(s, name, forms[name](s));
    assert.equal(res.status, 303, name);
    assert.equal(res.headers.location, '/', name);
    assert.ok(s.gh.calls.length > 0, `${name} wrote`);
    for (const n of HEADER_NAMES) assert.ok(res.headers[n], `${name} redirect has ${n}`);
  }
});

test('R62 a forced GitHub failure on each action answers 502 with a plain message and no trace or token', async () => {
  for (const name of NAMES) {
    const s = setup();
    s.gh.fail = true;
    const res = await act(s, name, forms[name](s));
    assert.equal(res.status, 502, name);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.ok(res.body.includes('GitHub is not answering right now'), name);
    noTrace(res.body);
    assert.ok(!res.body.includes(SENTINEL), name);
    assert.equal(res.headers.location, undefined);
  }
});

test('R62 bad input, an empty idea title, answers 400 and creates nothing', async () => {
  const s = setup();
  const res = await act(s, 'idea', forms.idea(s, '   '));
  assert.equal(res.status, 400);
  assert.equal(s.gh.calls.length, 0);
  noTrace(res.body);
});

// ---------- R55 ----------

test('R55 a cross-site origin, a cross-site fetch, no token, another target and an old token give five 403s and no write', async () => {
  const s = setup();
  const good = forms.idea(s);
  const results = [];
  results.push(await act(s, 'idea', good, { origin: 'http://evil.example' }));
  results.push(await act(s, 'idea', good, { 'sec-fetch-site': 'cross-site' }));
  results.push(await act(s, 'idea', { title: 'Shelves' }));
  results.push(await act(s, 'idea', { token: s.guard.formToken('idea', 'other'), title: 'Shelves' }));
  const old = forms.idea(s);
  s.clock.t += 13 * HOUR;
  results.push(await act(s, 'idea', old));
  assert.deepEqual(results.map((r) => r.status), [403, 403, 403, 403, 403]);
  assert.equal(s.gh.calls.length, 0);
  for (const r of results) {
    assert.ok(!r.body.includes(SENTINEL));
    noTrace(r.body);
  }
});

test('R55 the same valid post twice writes once and answers 303 both times', async () => {
  const s = setup();
  const form = forms.idea(s);
  const first = await act(s, 'idea', form);
  const second = await act(s, 'idea', form);
  assert.equal(first.status, 303);
  assert.equal(second.status, 303);
  assert.equal(second.headers.location, '/');
  assert.equal(s.gh.calls.filter((c) => c.name === 'createIssue').length, 1);
});

test('R55 a post whose write failed can be posted again and then writes', async () => {
  const s = setup();
  const form = forms.idea(s);
  s.gh.fail = true;
  const failed = await act(s, 'idea', form);
  assert.equal(failed.status, 502);
  s.gh.fail = false;
  const again = await act(s, 'idea', form);
  assert.equal(again.status, 303);
  assert.equal(s.gh.calls.filter((c) => c.name === 'createIssue').length, 2);
  const third = await act(s, 'idea', form);
  assert.equal(third.status, 303);
  assert.equal(s.gh.calls.length, 2);
});

test('R55 a token taken from the page and a token made by the guard both work', async () => {
  const s = setup();
  const page = await s.h.page(getReq());
  const fromPage = tokenFromPage(page.body, 'idea');
  const a = await act(s, 'idea', { token: fromPage, title: 'From the page' });
  assert.equal(a.status, 303);
  const b = await act(s, 'idea', { token: s.guard.formToken('idea', 'new'), title: 'From the guard' });
  assert.equal(b.status, 303);
  assert.deepEqual(s.gh.calls.filter((c) => c.name === 'createIssue').map((c) => c.args.title), ['From the page', 'From the guard']);
});

test('R55 a token issued before a restart is accepted by a new handler set', async () => {
  const s = setup();
  const form = forms.idea(s);
  const t = setup();
  const res = await act(t, 'idea', form);
  assert.equal(res.status, 303);
  assert.equal(t.gh.calls.filter((c) => c.name === 'createIssue').length, 1);
});

// ---------- R63 ----------

test('R63 read-only: the page holds no form', async () => {
  const s = setup({ readOnly: true });
  const res = await s.h.page(getReq());
  assert.equal(res.status, 200);
  assert.equal((res.body.match(/<form/g) || []).length, 0);
});

test('R63 read-only: the four action paths answer 403 and make no GitHub call', async () => {
  const s = setup({ readOnly: true });
  for (const name of NAMES) {
    const res = await act(s, name, forms[name](s));
    assert.equal(res.status, 403, name);
    noTrace(res.body);
  }
  assert.equal(s.gh.calls.length, 0);
});

// ---------- R67 ----------

test('R67 a stale bundle answers the page with 200 and exactly one banner', async () => {
  const s = setup();
  s.world.stale = { since: '2026-10-12T04:00:00Z', reason: 'GitHub is not answering right now.' };
  const res = await s.h.page(getReq());
  assert.equal(res.status, 200);
  assert.equal((res.body.match(/data-banner/g) || []).length, 1);
});

test('R67 a notice with status 503 answers 503 and no board section', async () => {
  const s = setup();
  s.world.notice = { title: 'No saved data yet', message: 'GitHub did not answer. Try again in a minute.', status: 503 };
  const res = await s.h.page(getReq());
  assert.equal(res.status, 503);
  assert.ok(!res.body.includes('data-section'));
  assert.ok(res.body.includes('No saved data yet'));
});

test('R67 an action on a stale bundle answers 502 and writes nothing', async () => {
  const s = setup();
  s.world.stale = { since: '2026-10-12T04:00:00Z', reason: 'GitHub is not answering right now.' };
  for (const name of NAMES) {
    const res = await act(s, name, forms[name](s));
    assert.equal(res.status, 502, name);
    assert.ok(/GitHub/.test(res.body), name);
  }
  assert.equal(s.gh.calls.length, 0);
});

// ---------- R70 ----------

test('R70 after a tick every write is noted and the data is loaded again before the answer', async () => {
  const s = setup();
  const res = await act(s, 'habit', forms.habit(s));
  assert.equal(res.status, 303);
  const writes = s.gh.calls.filter((c) => c.name !== 'addProjectItem');
  assert.deepEqual(writes.map((c) => c.name), ['createIssue', 'patchIssue']);
  assert.equal(s.loader.writes.length, 2);
  for (const w of s.loader.writes) assert.ok(w.apiIssue && typeof w.apiIssue.number === 'number');
  assert.equal(s.loader.writes[0].apiIssue.number, 900);
  const lastNote = s.events.lastIndexOf('noteWrite');
  const lastLoad = s.events.lastIndexOf('load');
  assert.ok(lastLoad > lastNote, 'a load comes after the last noteWrite');
  assert.ok(s.loader.loads >= 2);
});

test('R70 with GitHub now holding the closed check-in the next page shows the habit done today', async () => {
  const s = setup();
  s.world.sync = () => {
    if (s.gh.calls.some((c) => c.name === 'patchIssue') && !s.world.raw.issues.some((i) => i.labels.includes('habit:move'))) {
      s.world.raw.issues.push(checkin('move', TODAY, { closedAt: '2026-10-12T06:10:00Z' }));
    }
  };
  const before = await s.h.page(getReq());
  assert.ok(before.body.includes('data-done="false"'));
  assert.ok(!before.body.includes('data-done="true"'));
  const res = await act(s, 'habit', forms.habit(s));
  assert.equal(res.status, 303);
  const after = await s.h.page(getReq());
  assert.ok(after.body.includes('data-done="true"'));
});

test('R70 after a sort the added project item is noted with its project and issue number', async () => {
  const s = setup();
  const res = await act(s, 'sort', forms.sort(s));
  assert.equal(res.status, 303);
  assert.ok(s.loader.writes.some((w) => w.item && w.item.projectNumber === 3 && w.item.issueNumber === 50));
  assert.deepEqual(s.loader.writes.find((w) => w.item), { item: { projectOwner: null, projectNumber: 3, issueNumber: 50 } });
  assert.ok(s.events.lastIndexOf('load') > s.events.lastIndexOf('noteWrite'));
});

// ---------- R72 ----------

test('R72 the loader notice is what the page answers, escaped, as html', async () => {
  const s = setup();
  s.world.notice = { title: 'The settings file cannot be used', message: 'Key "token" <b>bad</b> & worse.', status: 503 };
  const res = await s.h.page(getReq());
  assert.equal(res.status, 503);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.ok(res.body.includes('The settings file cannot be used'));
  assert.ok(res.body.includes('&lt;b&gt;bad&lt;/b&gt;'));
  assert.ok(!res.body.includes('<b>bad</b>'));
  assert.ok(!res.body.includes('data-section'));
});

test('R72 the loader notice is also what an action answers, with the notice status', async () => {
  const s = setup();
  s.world.notice = { title: 'The data repository is public', message: 'Make it private on GitHub.', status: 503 };
  const res = await act(s, 'idea', forms.idea(s));
  assert.equal(res.status, 503);
  assert.ok(res.body.includes('The data repository is public'));
  assert.equal(s.gh.calls.length, 0);
});

// ---------- U ----------

test('U addProjectItem receives the owner from env.repo and the owner type from the bundle', async () => {
  for (const ownerType of ['organization', 'user']) {
    const s = setup({ ownerType });
    const res = await act(s, 'sort', forms.sort(s));
    assert.equal(res.status, 303);
    const call = s.gh.calls.find((c) => c.name === 'addProjectItem');
    assert.ok(call, 'project item added');
    assert.deepEqual(call.args, { owner: 'sam-life', ownerType, projectNumber: 3, issueNumber: 50 });
  }
});

test('U a habit form with on=2 answers 400 and writes nothing', async () => {
  const s = setup();
  const res = await act(s, 'habit', { token: s.guard.formToken('habit', `move:${TODAY}:on`), id: 'move', date: TODAY, on: '2' });
  assert.equal(res.status, 400);
  assert.equal(s.gh.calls.length, 0);
});

test('U a sort form with neither target nor accept answers 400 and writes nothing', async () => {
  const s = setup();
  const res = await act(s, 'sort', { token: s.guard.formToken('sort', '50'), number: '50' });
  assert.equal(res.status, 400);
  assert.equal(s.gh.calls.length, 0);
});

test('U a sort target house/5 is split into project house and milestone 5', async () => {
  const s = setup();
  const res = await act(s, 'sort', forms.sort(s));
  assert.equal(res.status, 303);
  const patches = s.gh.calls.filter((c) => c.name === 'patchIssue');
  assert.ok(patches.some((c) => c.args.number === 50 && c.args.patch.milestone === 5));
  assert.equal(s.gh.calls.find((c) => c.name === 'addProjectItem').args.projectNumber, 3);
});

test('U a sort target with only a project key sets no milestone', async () => {
  const s = setup();
  const res = await act(s, 'sort', { token: s.guard.formToken('sort', '50'), number: '50', target: 'house' });
  assert.equal(res.status, 303);
  assert.equal(s.gh.calls.find((c) => c.name === 'addProjectItem').args.projectNumber, 3);
  assert.ok(!s.gh.calls.some((c) => c.name === 'patchIssue' && c.args.patch.milestone !== undefined));
});

test('U closing a task patches it closed as completed', async () => {
  const s = setup();
  const res = await act(s, 'close', forms.close(s));
  assert.equal(res.status, 303);
  assert.deepEqual(s.gh.calls.map((c) => [c.name, c.args]), [['patchIssue', { number: 60, patch: { state: 'closed', state_reason: 'completed' } }]]);
});

test('U an unknown action name answers 404 or 400 without throwing and writes nothing', async () => {
  const s = setup();
  const res = await s.h.action('delete', req({}, '/actions/delete'), { token: s.guard.formToken('delete', 'new') });
  assert.ok(res.status === 404 || res.status === 400, `status ${res.status}`);
  assert.equal(s.gh.calls.length, 0);
  noTrace(res.body);
});

test('U a form that gives no target is refused with 400 before the token is checked', async () => {
  const s = setup();
  const res = await act(s, 'sort', { token: 'junk', number: '50' });
  assert.equal(res.status, 400);
  assert.equal(s.gh.calls.length, 0);
});

test('U read-only is answered 403 before the form is looked at', async () => {
  const s = setup({ readOnly: true });
  const res = await act(s, 'sort', { token: 'junk' });
  assert.equal(res.status, 403);
  assert.equal(s.gh.calls.length, 0);
});

test('U a loader whose load rejects still gets a plain 500 answer from the page', async () => {
  const s = setup();
  s.world.rejectLoad = true;
  const res = await s.h.page(getReq());
  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /^text\/html/);
  noTrace(res.body);
  assert.ok(!res.body.includes('/secret/path'));
  assert.ok(!res.body.includes(SENTINEL));
  for (const n of HEADER_NAMES) assert.ok(res.headers[n]);
});

test('U a loader whose load rejects still gets a plain 500 answer from an action', async () => {
  const s = setup();
  s.world.rejectLoad = true;
  const res = await act(s, 'idea', forms.idea(s));
  assert.equal(res.status, 500);
  noTrace(res.body);
  assert.ok(!res.body.includes('/secret/path'));
  assert.equal(s.gh.calls.length, 0);
});
