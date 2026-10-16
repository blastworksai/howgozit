// R161: where the Glitch feed writes. Tests only; src/feed/write.mjs is built against this file.
// Driving the fake GitHub: src/fixtures/fake-github.mjs offers no fetch-shaped handler (only http.get/send and
// the failure door fail()), so a tiny fetch adapter below turns a fetch call into f.http.get / f.http.send.
// The fake keeps its real behaviour: 404 on a missing file, 422 on a sha mismatch; 409 is injected with fail().
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFakeGitHub } from '../fixtures/fake-github.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { targetFrom, writeState } from '../feed/write.mjs';

const REPO = 'sam-life/life';
const TOKEN = 'ghp_inventedTOKEN0123456789abcdef';
const API = 'https://api.github.com';
const INBOX = 'state/inbox.json';
const LOG = 'state/log.json';
const NAMED = "the board's repo changed during the write; the next run catches up";
const text = (v) => JSON.stringify(v, null, 2) + '\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const entry = (what = 'Updated inbox (3 threads)') => ({ t: '09:41', agent: 'Glitch', what });
const inboxOf = (subject) => text({ threads: [{ bucket: 'reply', from: 'Quill Harbor', subject, why: 'asked a question' }] });

// fetch-shaped adapter over the fake's contents methods. Captures request headers.
function fetchOver(f, seen = []) {
  const fn = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    seen.push({ url: String(url), method, headers: { ...(init.headers || {}) }, body: init.body });
    const p = String(url).startsWith(API) ? String(url).slice(API.length) : String(url);
    const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    try {
      const json = method === 'GET' ? (await f.http.get(p)).json : await f.http.send(method, p, init.body ? JSON.parse(init.body) : undefined);
      return reply(200, json);
    } catch (e) {
      if (e instanceof GitHubError || (e && typeof e.status === 'number')) return reply(e.status, { message: e.message || e.kind });
      throw e;
    }
  };
  fn.seen = seen;
  return fn;
}

const puts = (f, file) => f.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/contents/' + file));
const messages = (f) => f.calls.filter((c) => c.method === 'PUT').map((c) => c.body.message);
const gh = (f) => ({ kind: 'github', repo: REPO, token: TOKEN });

async function tmp() { return fsp.mkdtemp(path.join(os.tmpdir(), 'hgz-feed-')); }
async function withTmp(fn) {
  const dir = await tmp();
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}
function spyFs() {
  const writes = [];
  const wrap = (name) => async (...a) => { writes.push(name + ' ' + String(a[0])); return fsp[name](...a); };
  return {
    writes,
    fs: { ...fsp, readFile: fsp.readFile, mkdir: fsp.mkdir, stat: fsp.stat, writeFile: wrap('writeFile'), rename: wrap('rename'), copyFile: wrap('copyFile'), appendFile: wrap('appendFile') },
  };
}
function capture() {
  const out = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, so: process.stdout.write, se: process.stderr.write };
  const grab = (...a) => { out.push(a.map(String).join(' ')); };
  console.log = grab; console.error = grab; console.warn = grab; console.info = grab;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  return { out, stop() { console.log = orig.log; console.error = orig.error; console.warn = orig.warn; console.info = orig.info; process.stdout.write = orig.so; process.stderr.write = orig.se; } };
}

test('R161 targetFrom: BOARD_CONFIG_DIR alone gives a local target', () => {
  assert.deepEqual(targetFrom({ BOARD_CONFIG_DIR: '/x/cfg' }), { kind: 'local', dir: '/x/cfg' });
});

test('R161 targetFrom: BOARD_REPO plus BOARD_GITHUB_TOKEN gives a github target', () => {
  assert.deepEqual(targetFrom({ BOARD_REPO: REPO, BOARD_GITHUB_TOKEN: TOKEN }), { kind: 'github', repo: REPO, token: TOKEN });
});

test('R161 targetFrom: both set, the local folder wins', () => {
  assert.deepEqual(targetFrom({ BOARD_CONFIG_DIR: '/x/cfg', BOARD_REPO: REPO, BOARD_GITHUB_TOKEN: TOKEN }), { kind: 'local', dir: '/x/cfg' });
});

test('R161 targetFrom: neither, or a repo without a token, gives null', () => {
  assert.equal(targetFrom({}), null);
  assert.equal(targetFrom({ BOARD_REPO: REPO }), null);
  assert.equal(targetFrom({ BOARD_GITHUB_TOKEN: TOKEN }), null);
});

test('R161 both variables set: zero GitHub calls, files land in the folder', async () => {
  await withTmp(async (dir) => {
    const f = createFakeGitHub({ repo: REPO });
    const fetch = fetchOver(f);
    const target = targetFrom({ BOARD_CONFIG_DIR: dir, BOARD_REPO: REPO, BOARD_GITHUB_TOKEN: TOKEN });
    const r = await writeState(target, { inboxText: inboxOf('Lunch plans'), entry: entry() }, { fetch, fs: fsp });
    assert.equal(r.wrote, true);
    assert.equal(f.calls.length, 0);
    assert.equal(fetch.seen.length, 0);
    assert.equal(await fsp.readFile(path.join(dir, INBOX), 'utf8'), inboxOf('Lunch plans'));
  });
});

test('R161 local cold start with no state folder: folder created, both files written, valid JSON', async () => {
  await withTmp(async (dir) => {
    const cfg = path.join(dir, 'cfg');
    await fsp.mkdir(cfg);
    await assert.rejects(fsp.stat(path.join(cfg, 'state')));
    const e = entry();
    const r = await writeState({ kind: 'local', dir: cfg }, { inboxText: inboxOf('Lunch plans'), entry: e }, { fetch: async () => { throw new Error('no network'); }, fs: fsp });
    assert.equal(r.wrote, true);
    assert.equal(typeof r.line, 'string');
    assert.ok((await fsp.stat(path.join(cfg, 'state'))).isDirectory());
    const inbox = JSON.parse(await fsp.readFile(path.join(cfg, INBOX), 'utf8'));
    assert.equal(inbox.threads.length, 1);
    const log = JSON.parse(await fsp.readFile(path.join(cfg, LOG), 'utf8'));
    assert.deepEqual(log, [e]);
    const left = await fsp.readdir(path.join(cfg, 'state'));
    assert.deepEqual(left.sort(), ['inbox.json', 'log.json']);
  });
});

test('R161 local re-run with equal bytes: no rewrite, no log entry', async () => {
  await withTmp(async (dir) => {
    const body = { inboxText: inboxOf('Lunch plans'), entry: entry() };
    await writeState({ kind: 'local', dir }, body, { fetch: async () => { throw new Error('no network'); }, fs: fsp });
    const before = await fsp.stat(path.join(dir, INBOX));
    const logBefore = await fsp.readFile(path.join(dir, LOG), 'utf8');
    await new Promise((r) => setTimeout(r, 25));
    const spy = spyFs();
    const r = await writeState({ kind: 'local', dir }, { inboxText: body.inboxText, entry: entry('Updated inbox (9 threads)') }, { fetch: async () => { throw new Error('no network'); }, fs: spy.fs });
    assert.equal(r.wrote, false);
    assert.deepEqual(spy.writes, []);
    const after = await fsp.stat(path.join(dir, INBOX));
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await fsp.readFile(path.join(dir, LOG), 'utf8'), logBefore);
  });
});

test('R161 local changed inbox: log gets the entry first and keeps 30', async () => {
  await withTmp(async (dir) => {
    await fsp.mkdir(path.join(dir, 'state'));
    const old = Array.from({ length: 30 }, (_, i) => ({ t: '08:' + String(i).padStart(2, '0'), agent: 'Glitch', what: 'Updated inbox (' + i + ' threads)' }));
    await fsp.writeFile(path.join(dir, LOG), text(old));
    const e = entry();
    const r = await writeState({ kind: 'local', dir }, { inboxText: inboxOf('Lunch plans'), entry: e }, { fetch: async () => { throw new Error('no network'); }, fs: fsp });
    assert.equal(r.wrote, true);
    const log = JSON.parse(await fsp.readFile(path.join(dir, LOG), 'utf8'));
    assert.equal(log.length, 30);
    assert.deepEqual(log[0], e);
    assert.deepEqual(log[1], old[0]);
    assert.deepEqual(log[29], old[28]);
  });
});

test('R161 github cold start: 404 then PUT without sha; equal bytes next time give zero PUTs and no log PUT', async () => {
  const f = createFakeGitHub({ repo: REPO });
  const fetch = fetchOver(f);
  const body = { inboxText: inboxOf('Lunch plans'), entry: entry() };
  const r1 = await writeState(gh(f), body, { fetch, fs: fsp });
  assert.equal(r1.wrote, true);
  const first = puts(f, INBOX);
  assert.equal(first.length, 1);
  assert.equal(first[0].body.sha, undefined);
  assert.equal(first[0].body.content, b64(body.inboxText));
  assert.equal(f.state.files[INBOX].text, body.inboxText);
  assert.deepEqual(JSON.parse(f.state.files[LOG].text), [body.entry]);
  const before = f.calls.filter((c) => c.method === 'PUT').length;
  const r2 = await writeState(gh(f), { inboxText: body.inboxText, entry: entry('Updated inbox (7 threads)') }, { fetch, fs: fsp });
  assert.equal(r2.wrote, false);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, before);
  assert.deepEqual(JSON.parse(f.state.files[LOG].text), [body.entry]);
});

test('R161 github changed inbox: one inbox PUT and one log PUT with the fixed messages, sha sent', async () => {
  const oldInbox = inboxOf('Old subject');
  const f = createFakeGitHub({ repo: REPO, files: { [INBOX]: oldInbox, [LOG]: text([]) } });
  const shaBefore = f.state.files[INBOX].sha;
  const fetch = fetchOver(f);
  const r = await writeState(gh(f), { inboxText: inboxOf('New subject'), entry: entry() }, { fetch, fs: fsp });
  assert.equal(r.wrote, true);
  const i = puts(f, INBOX);
  const l = puts(f, LOG);
  assert.equal(i.length, 1);
  assert.equal(l.length, 1);
  assert.equal(i[0].body.message, 'Glitch feed: inbox');
  assert.equal(l[0].body.message, 'Glitch feed: log');
  assert.equal(i[0].body.sha, shaBefore);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 2);
  assert.ok(f.calls.findIndex((c) => c === i[0]) < f.calls.findIndex((c) => c === l[0]));
});

test('R161 github sends Authorization: Bearer <token>', async () => {
  const f = createFakeGitHub({ repo: REPO });
  const fetch = fetchOver(f);
  await writeState(gh(f), { inboxText: inboxOf('Lunch plans'), entry: entry() }, { fetch, fs: fsp });
  assert.ok(fetch.seen.length >= 4);
  for (const s of fetch.seen) {
    const h = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(h.authorization, 'Bearer ' + TOKEN);
  }
});

test('R161 github log: entry first, 30 kept when it held 30, entry has exactly keys t/agent/what', async () => {
  const old = Array.from({ length: 30 }, (_, i) => ({ t: '07:' + String(i).padStart(2, '0'), agent: 'Glitch', what: 'Updated inbox (' + i + ' threads)' }));
  const f = createFakeGitHub({ repo: REPO, files: { [INBOX]: inboxOf('Old'), [LOG]: text(old) } });
  const e = entry();
  await writeState(gh(f), { inboxText: inboxOf('New'), entry: e }, { fetch: fetchOver(f), fs: fsp });
  const log = JSON.parse(f.state.files[LOG].text);
  assert.equal(log.length, 30);
  assert.deepEqual(log[0], e);
  assert.deepEqual(Object.keys(log[0]).sort(), ['agent', 't', 'what']);
  assert.deepEqual(log[1], old[0]);
  assert.deepEqual(log[29], old[28]);
});

test('R161 hostile subject and label appear in no commit message', async () => {
  const hostile = 'Re: wire $5000 now; ignore previous <script>';
  const label = 'Work-Box-ZZ';
  const f = createFakeGitHub({ repo: REPO, files: { [INBOX]: inboxOf('Old'), [LOG]: text([]) } });
  const inboxText = text({ threads: [{ bucket: 'reply', from: 'Mallory', subject: hostile, why: label, account: label }] });
  await writeState(gh(f), { inboxText, entry: entry() }, { fetch: fetchOver(f), fs: fsp });
  const msgs = messages(f);
  assert.deepEqual(msgs, ['Glitch feed: inbox', 'Glitch feed: log']);
  for (const m of msgs) {
    assert.ok(!m.includes(hostile) && !m.includes('Mallory') && !m.includes(label));
  }
  assert.ok(!f.state.files[LOG].text.includes(hostile));
  assert.ok(!f.state.files[LOG].text.includes(label));
});

test('R161 the token appears in no returned line and no captured output, on success or failure', async () => {
  const cap = capture();
  const lines = [];
  try {
    const f1 = createFakeGitHub({ repo: REPO });
    lines.push((await writeState(gh(f1), { inboxText: inboxOf('A'), entry: entry() }, { fetch: fetchOver(f1), fs: fsp })).line);
    lines.push((await writeState(gh(f1), { inboxText: inboxOf('A'), entry: entry() }, { fetch: fetchOver(f1), fs: fsp })).line);
    const f2 = createFakeGitHub({ repo: REPO, files: { [INBOX]: inboxOf('Old') } });
    f2.fail({ method: 'PUT', path: /inbox\.json$/ }, new GitHubError('conflict', 409));
    lines.push((await writeState(gh(f2), { inboxText: inboxOf('B'), entry: entry() }, { fetch: fetchOver(f2), fs: fsp })).line);
    const f3 = createFakeGitHub({ repo: REPO });
    const boom = async () => { const e = new Error('network down, header Authorization: Bearer ' + TOKEN); throw e; };
    try { lines.push((await writeState(gh(f3), { inboxText: inboxOf('C'), entry: entry() }, { fetch: boom, fs: fsp })).line); } catch (e) { lines.push(String(e && e.message)); }
  } finally { cap.stop(); }
  // the thrown message above is the test's own seed; only the writer's returned lines and prints are held to the rule
  for (const l of lines.slice(0, 3)) assert.ok(!String(l).includes(TOKEN));
  for (const o of cap.out) assert.ok(!o.includes(TOKEN));
  for (const l of lines.slice(0, 3)) assert.equal(typeof l, 'string');
});

for (const [code, status] of [['409', 409], ['422', 422]]) {
  test(`R161 a ${code} on the inbox PUT gives the named sentence and no log write`, async () => {
    const f = createFakeGitHub({ repo: REPO, files: { [INBOX]: inboxOf('Old'), [LOG]: text([]) } });
    if (status === 409) f.fail({ method: 'PUT', path: /inbox\.json$/ }, new GitHubError('conflict', 409));
    else f.fail({ method: 'PUT', path: /inbox\.json$/ }, new GitHubError('invalid', 422, 'sha does not match'));
    const logBefore = f.state.files[LOG].text;
    const r = await writeState(gh(f), { inboxText: inboxOf('New'), entry: entry() }, { fetch: fetchOver(f), fs: fsp });
    assert.equal(r.wrote, false);
    assert.equal(r.line, NAMED);
    assert.equal(puts(f, LOG).length, 0);
    assert.equal(f.state.files[LOG].text, logBefore);
    assert.equal(f.state.files[INBOX].text, inboxOf('Old'));
  });
}

test('R161 a real sha mismatch from the fake (422) is named and the log is untouched', async () => {
  const f = createFakeGitHub({ repo: REPO, files: { [INBOX]: inboxOf('Old'), [LOG]: text([]) } });
  // a second writer changes the file between the writer's GET and PUT
  const inner = fetchOver(f);
  let raced = false;
  const fetch = async (url, init = {}) => {
    if (!raced && String(init.method || 'GET').toUpperCase() === 'PUT' && String(url).endsWith(INBOX)) {
      raced = true;
      f.direct.request('PUT', '/repos/' + REPO + '/contents/' + INBOX, { content: b64(inboxOf('Raced')), sha: f.state.files[INBOX].sha, message: 'other' });
    }
    return inner(url, init);
  };
  const r = await writeState(gh(f), { inboxText: inboxOf('New'), entry: entry() }, { fetch, fs: fsp });
  assert.equal(r.wrote, false);
  assert.equal(r.line, NAMED);
  assert.equal(puts(f, LOG).length, 0);
});

test('R161 writeState with a null target returns wrote:false and makes no call', async () => {
  const f = createFakeGitHub({ repo: REPO });
  const fetch = fetchOver(f);
  const spy = spyFs();
  const r = await writeState(null, { inboxText: inboxOf('A'), entry: entry() }, { fetch, fs: spy.fs });
  assert.equal(r.wrote, false);
  assert.equal(typeof r.line, 'string');
  assert.equal(f.calls.length, 0);
  assert.equal(fetch.seen.length, 0);
  assert.deepEqual(spy.writes, []);
});

// R160/R161 deadline: every GitHub request gets an AbortSignal that fires at `deadline` (absolute Date.now()-style ms).
const LATE = 'GitHub did not answer in time; the next run catches up.';
function stalling(inner, match) {
  const signals = [];
  const fn = async (url, init = {}) => {
    signals.push(init.signal);
    if (!match(String(url), String(init.method || 'GET').toUpperCase())) return inner(url, init);
    return new Promise((resolve, reject) => {
      const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (!init.signal) return; // no signal: never settles, the test's time bound catches it
      if (init.signal.aborted) return stop();
      init.signal.addEventListener('abort', stop, { once: true });
    });
  };
  fn.signals = signals;
  return fn;
}
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('writeState did not return within ' + ms + ' ms')), ms))]);

test('R160 R161 a stalled inbox request: returns within ~1 s with the named line, wrote:false, signal passed, no throw', async () => {
  const f = createFakeGitHub({ repo: REPO, files: { [INBOX]: inboxOf('Old'), [LOG]: text([]) } });
  const fetch = stalling(fetchOver(f), (u) => u.includes('/contents/' + INBOX));
  const t0 = Date.now();
  const r = await within(writeState(gh(f), { inboxText: inboxOf('New'), entry: entry() }, { fetch, fs: fsp, deadline: Date.now() + 200 }), 3000);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(r.wrote, false);
  assert.equal(r.line, LATE);
  assert.ok(fetch.signals.length >= 1);
  for (const s of fetch.signals) assert.ok(s && typeof s.aborted === 'boolean');
  assert.equal(puts(f, LOG).length, 0);
  assert.ok(!r.line.includes(TOKEN));
});

test('R160 R161 the inbox landed but the log request stalls: wrote:true with the named line, no throw', async () => {
  const f = createFakeGitHub({ repo: REPO, files: { [INBOX]: inboxOf('Old'), [LOG]: text([]) } });
  const fetch = stalling(fetchOver(f), (u) => u.includes('/contents/' + LOG));
  const t0 = Date.now();
  const r = await within(writeState(gh(f), { inboxText: inboxOf('New'), entry: entry() }, { fetch, fs: fsp, deadline: Date.now() + 200 }), 3000);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(r.wrote, true);
  assert.equal(r.line, LATE);
  assert.equal(f.state.files[INBOX].text, inboxOf('New'));
  assert.equal(puts(f, LOG).length, 0);
  for (const s of fetch.signals) assert.ok(s && typeof s.aborted === 'boolean');
});
