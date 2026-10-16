// Tests of R159, R160 and R163 (the Glitch feed: door health, time limits, own settings), written from the contract
// before the code exists. Levels: src/feed/doors.mjs (readMailboxes, realRun), src/feed/config.mjs (readFeedConfig)
// and the CLI (src/scripts/feed.mjs main). Interfaces: .planning/feed-interfaces.md. Invented names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMailboxes, realRun } from '../feed/doors.mjs';
import { readFeedConfig } from '../feed/config.mjs';
import { main } from '../scripts/feed.mjs';
import {
  makeClock, makeFakeRun, scriptedGlitch, isGoogleDoctor, isMsDoctor, isTriage, json,
  googleRow, googleDoctor, msRow, msDoctor, item, triageOk, triageAsk, triageDormant,
} from '../fixtures/feed/fake-run.mjs';

const GLITCH = '/opt/invented/glitch';
const UV = '/opt/invented/bin/uv';
const SCRIPTS = `${GLITCH}/.claude/scripts`;
const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'feed', 'run');
const REASON_TEXT = 'REASON-SENTINEL I do not know an account called alpha. The accounts you have: alpha, beta.';

const R = {
  signin: 'needs you to sign in again in Glitch',
  dormant: 'not connected in Glitch',
  unknown: 'not a mailbox Glitch knows',
  slow: 'took too long',
  notUnderstood: 'answer not understood',
};
const cfgOf = (mailboxes) => ({ mailboxes, frequency: 'morning', glitch: GLITCH, uv: UV });
const read = (mailboxes, run, clock, mode = 'run') => readMailboxes(cfgOf(mailboxes), { run, clock, mode });
const reasonOf = (res, label) => res.skipped.find((s) => s.label === label)?.reason;
const triageCalls = (run) => run.callsMatching((a) => isTriage(a));
const okRun = (clock, extra = {}) => scriptedGlitch({
  clock,
  google: [googleRow('g-1', 'alpha'), googleRow('g-2', 'gamma')],
  microsoft: [msRow('m-1', 'beta')],
  triage: { 'g-1': { stdout: json(triageOk('g-1', 'alpha')) }, 'g-2': { stdout: json(triageOk('g-2', 'gamma')) }, 'm-1': { stdout: json(triageOk('m-1', 'beta')) }, ...extra },
});

// ---------------- R159 ----------------

test('R159 a healthy mailbox is read with the exact doctor and triage argv, and the account id, not the label', async () => {
  const clock = makeClock();
  const run = okRun(clock);
  const res = await read(['alpha', 'beta'], run, clock);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.accounts.map((a) => a.label), ['alpha', 'beta']);
  assert.equal(res.accounts[0].triage.status, 'ok');
  const argvs = run.calls.map((c) => c.argv);
  assert.deepEqual(argvs[0], [UV, 'run', '--directory', SCRIPTS, 'python', 'integrations/connections.py', 'doctor']);
  assert.deepEqual(argvs[1], [UV, 'run', '--directory', SCRIPTS, 'python', 'integrations/ms_connections.py', 'doctor']);
  assert.deepEqual(argvs.find((a) => isTriage(a, 'g-1')), [UV, 'run', '--directory', SCRIPTS, 'python', 'email_triage.py', 'triage', '--account', 'g-1', '--limit', '30']);
  assert.deepEqual(argvs.find((a) => isTriage(a, 'm-1')).slice(-4), ['--account', 'm-1', '--limit', '30']);
  for (const c of triageCalls(run)) assert.ok(!c.argv.includes('alpha') && !c.argv.includes('beta'), 'the label must never reach --account');
});

test('R159 a Google mailbox whose health is not connected is skipped as "needs you to sign in again in Glitch", with no triage call', async () => {
  const clock = makeClock();
  const run = scriptedGlitch({
    clock,
    google: [googleRow('g-1', 'alpha', 'needs_reauth'), googleRow('g-2', 'gamma', 'revoked'), googleRow('g-3', 'delta')],
    triage: { 'g-3': { stdout: json(triageOk('g-3', 'delta')) } },
  });
  const res = await read(['alpha', 'gamma', 'delta'], run, clock);
  assert.equal(reasonOf(res, 'alpha'), R.signin);
  assert.equal(reasonOf(res, 'gamma'), R.signin);
  assert.deepEqual(res.accounts.map((a) => a.label), ['delta']);
  assert.equal(run.callsMatching((a) => isTriage(a, 'g-1')).length, 0);
  assert.equal(run.callsMatching((a) => isTriage(a, 'g-2')).length, 0);
  assert.equal(triageCalls(run).length, 1);
});

test('R159 a Microsoft mailbox that is not signed in, or not connected, is skipped as "needs you to sign in again in Glitch" with no triage call', async () => {
  const clock = makeClock();
  const run = scriptedGlitch({
    clock,
    microsoft: [msRow('m-1', 'beta', 'connected', false), msRow('m-2', 'omega', 'needs_reauth', true), msRow('m-3', 'sigma')],
    triage: { 'm-3': { stdout: json(triageOk('m-3', 'sigma')) } },
  });
  const res = await read(['beta', 'omega', 'sigma'], run, clock);
  assert.equal(reasonOf(res, 'beta'), R.signin);
  assert.equal(reasonOf(res, 'omega'), R.signin);
  assert.deepEqual(res.accounts.map((a) => a.label), ['sigma']);
  assert.equal(run.callsMatching((a) => isTriage(a, 'm-1') || isTriage(a, 'm-2')).length, 0);
});

test('R159 a label in neither doctor is skipped as "not a mailbox Glitch knows" with no triage call; so is a Google account without the gmail surface', async () => {
  const clock = makeClock();
  const run = scriptedGlitch({
    clock,
    google: [googleRow('g-1', 'alpha'), googleRow('g-9', 'calonly', 'connected', ['calendar', 'docs'])],
    triage: { 'g-1': { stdout: json(triageOk('g-1', 'alpha')) } },
  });
  const res = await read(['nowhere', 'calonly', 'alpha'], run, clock);
  assert.equal(reasonOf(res, 'nowhere'), R.unknown);
  assert.equal(reasonOf(res, 'calonly'), R.unknown);
  assert.deepEqual(res.accounts.map((a) => a.label), ['alpha']);
  assert.equal(triageCalls(run).length, 1);
});

test('R159 a triage answer of "ask" is skipped as "not a mailbox Glitch knows"', async () => {
  const clock = makeClock();
  const run = okRun(clock, { 'g-1': { stdout: json(triageAsk(REASON_TEXT)) } });
  const res = await read(['alpha'], run, clock);
  assert.equal(reasonOf(res, 'alpha'), R.unknown);
  assert.deepEqual(res.accounts, []);
});

test('R159 a triage answer of "dormant" is skipped as "not connected in Glitch"', async () => {
  const clock = makeClock();
  const run = okRun(clock, { 'g-1': { stdout: json(triageDormant(REASON_TEXT)) } });
  const res = await read(['alpha'], run, clock);
  assert.equal(reasonOf(res, 'alpha'), R.dormant);
  assert.deepEqual(res.accounts, []);
});

test('R159 a non-zero triage exit is skipped as "needs you to sign in again in Glitch", even when stdout holds an ok answer', async () => {
  const clock = makeClock();
  const run = okRun(clock, { 'g-1': { code: 1, stdout: '' }, 'g-2': { code: 1, stdout: json(triageOk('g-2', 'gamma')) } });
  const res = await read(['alpha', 'gamma'], run, clock);
  assert.equal(reasonOf(res, 'alpha'), R.signin);
  assert.equal(reasonOf(res, 'gamma'), R.signin);
  assert.deepEqual(res.accounts, []);
});

test('R159 empty stdout, bad JSON and missing keys are each skipped as "answer not understood"', async () => {
  const clock = makeClock();
  const noStatus = { surface: [], suppressed: [] };
  const noSurface = { status: 'ok', suppressed: [] };
  const run = scriptedGlitch({
    clock,
    google: [googleRow('g-1', 'a1'), googleRow('g-2', 'a2'), googleRow('g-3', 'a3'), googleRow('g-4', 'a4'), googleRow('g-5', 'a5')],
    triage: {
      'g-1': { code: 0, stdout: '' },
      'g-2': { code: 0, stdout: '{"status": "ok", "surface": [' },
      'g-3': { code: 0, stdout: json(noStatus) },
      'g-4': { code: 0, stdout: json(noSurface) },
      'g-5': { code: 0, stdout: 'not json at all' },
    },
  });
  const res = await read(['a1', 'a2', 'a3', 'a4', 'a5'], run, clock);
  for (const l of ['a1', 'a2', 'a3', 'a4', 'a5']) assert.equal(reasonOf(res, l), R.notUnderstood, l);
  assert.deepEqual(res.accounts, []);
});

test('R159 one provider\'s doctor failing does not hide the other provider\'s mailboxes', async () => {
  for (const [name, bad] of [['bad JSON', { stdout: 'oops' }], ['non-zero exit', { code: 1, stdout: '' }], ['timeout', { takes: 999999 }]]) {
    const clock = makeClock();
    const run = makeFakeRun({ clock });
    run.on(isGoogleDoctor, bad);
    run.on(isMsDoctor, { stdout: json(msDoctor([msRow('m-1', 'beta')])) });
    run.on((a) => isTriage(a, 'm-1'), { stdout: json(triageOk('m-1', 'beta')) });
    const res = await read(['alpha', 'beta'], run, clock);
    assert.deepEqual(res.accounts.map((a) => a.label), ['beta'], `Google doctor ${name}`);
    assert.ok(reasonOf(res, 'alpha'), `Google doctor ${name}: alpha is named as skipped`);
  }
  for (const [name, bad] of [['bad JSON', { stdout: '' }], ['non-zero exit', { code: 2, stdout: '' }]]) {
    const clock = makeClock();
    const run = makeFakeRun({ clock });
    run.on(isGoogleDoctor, { stdout: json(googleDoctor([googleRow('g-1', 'alpha')])) });
    run.on(isMsDoctor, bad);
    run.on((a) => isTriage(a, 'g-1'), { stdout: json(triageOk('g-1', 'alpha')) });
    const res = await read(['alpha', 'beta'], run, clock);
    assert.deepEqual(res.accounts.map((a) => a.label), ['alpha'], `Microsoft doctor ${name}`);
    assert.ok(reasonOf(res, 'beta'), `Microsoft doctor ${name}: beta is named as skipped`);
  }
});

test('R159 Glitch\'s own reason text never appears in the result of readMailboxes', async () => {
  const clock = makeClock();
  const run = okRun(clock, {
    'g-1': { stdout: json(triageAsk(REASON_TEXT)) },
    'g-2': { stdout: json(triageDormant(REASON_TEXT)) },
    'm-1': { code: 1, stdout: json({ status: 'error', reason: REASON_TEXT }) },
  });
  const res = await read(['alpha', 'gamma', 'beta'], run, clock);
  assert.equal(res.skipped.length, 3);
  assert.ok(!JSON.stringify(res).includes('REASON-SENTINEL'));
  assert.ok(!JSON.stringify(res).includes('The accounts you have'));
});

test('R159 the CLI prints no Glitch reason text, no address and no snippet, only labels and the fixed reasons', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { mailboxes: ['alpha', 'gamma'], frequency: 'morning', glitch: GLITCH });
  const clock = makeClock();
  const run = okRun(clock, { 'g-1': { stdout: json(triageAsk(REASON_TEXT)) }, 'g-2': { stdout: json(triageOk('g-2', 'gamma', [item(1)])) } });
  const io = makeIo();
  const code = await main(['run', '--config-dir', dir, '--uv', UV], deps({ dir, run, clock, io }));
  assert.equal(code, 0);
  const printed = io.all();
  assert.ok(!printed.includes('REASON-SENTINEL') && !printed.includes('The accounts you have'));
  assert.ok(!printed.includes('SNIPPET-SENTINEL') && !printed.includes('@') && !/http/i.test(printed));
  const line = JSON.parse(io.lines()[0]);
  assert.ok(line.items.join(' ').includes('alpha') && line.items.join(' ').includes(R.unknown));
});

// ---------------- R160 ----------------

test('R160 run mode gives every door call timeoutMs 60000', async () => {
  const clock = makeClock();
  const run = okRun(clock);
  await read(['alpha', 'beta', 'gamma'], run, clock, 'run');
  assert.ok(run.calls.length >= 5);
  for (const c of run.calls) assert.equal(c.timeoutMs, 60000);
});

test('R160 check mode gives every door call timeoutMs 240000', async () => {
  const clock = makeClock();
  const run = okRun(clock);
  await read(['alpha', 'beta', 'gamma'], run, clock, 'check');
  assert.ok(run.calls.length >= 5);
  for (const c of run.calls) assert.equal(c.timeoutMs, 240000);
});

test('R160 a call over its limit is named "took too long", the next mailbox is still read, and check allows what run does not', async () => {
  for (const [mode, takes, expectSlow] of [['run', 70000, true], ['check', 200000, false]]) {
    const clock = makeClock();
    const run = okRun(clock, { 'g-1': { stdout: json(triageOk('g-1', 'alpha')), takes } });
    const res = await read(['alpha', 'gamma'], run, clock, mode);
    if (expectSlow) {
      assert.equal(reasonOf(res, 'alpha'), R.slow);
      assert.deepEqual(res.accounts.map((a) => a.label), ['gamma']);
    } else {
      assert.deepEqual(res.skipped, []);
      assert.deepEqual(res.accounts.map((a) => a.label), ['alpha', 'gamma']);
    }
  }
});

test('R160 a doctor call over its limit names that provider\'s mailboxes "took too long" without hiding the other provider', async () => {
  const clock = makeClock();
  const run = makeFakeRun({ clock });
  run.on(isGoogleDoctor, { stdout: json(googleDoctor([googleRow('g-1', 'alpha')])), takes: 61000 });
  run.on(isMsDoctor, { stdout: json(msDoctor([msRow('m-1', 'beta')])) });
  run.on((a) => isTriage(a, 'm-1'), { stdout: json(triageOk('m-1', 'beta')) });
  const res = await read(['alpha', 'beta'], run, clock);
  assert.equal(reasonOf(res, 'alpha'), R.slow);
  assert.deepEqual(res.accounts.map((a) => a.label), ['beta']);
});

test('R160 the 300 second run budget caps timeoutMs, and no call starts with under 3000 ms left', async () => {
  const clock = makeClock();
  const labels = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
  const takes = [59000, 59000, 59000, 59000, 58000, 4000, 1000];
  const triage = {};
  labels.forEach((l, i) => { triage[`g-${l}`] = { stdout: json(triageOk(`g-${l}`, l)), takes: takes[i] }; });
  const run = scriptedGlitch({ clock, google: labels.map((l) => googleRow(`g-${l}`, l)), triage });
  const t0 = clock.now();
  const res = await read(labels, run, clock, 'run');
  for (const c of run.calls) {
    const left = 300000 - (c.startedAt - t0);
    assert.ok(left >= 3000, `a call started with ${left} ms left`);
    assert.equal(c.timeoutMs, Math.min(60000, left), 'timeoutMs is min(per-call, remaining)');
  }
  const m6 = run.callsMatching((a) => isTriage(a, 'g-m6'))[0];
  assert.equal(m6.timeoutMs, 6000);
  assert.equal(run.callsMatching((a) => isTriage(a, 'g-m7')).length, 0, 'm7 had 2000 ms left and is never started');
  assert.equal(reasonOf(res, 'm7'), R.slow);
  assert.deepEqual(res.accounts.map((a) => a.label), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
});

test('R160 a call that runs into the end of the budget is killed at the remaining time and named "took too long"', async () => {
  const clock = makeClock();
  const labels = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
  const triage = {};
  labels.forEach((l, i) => { triage[`g-${l}`] = { stdout: json(triageOk(`g-${l}`, l)), takes: i < 4 ? 59000 : 62000 }; });
  const run = scriptedGlitch({ clock, google: labels.map((l) => googleRow(`g-${l}`, l)), triage });
  const res = await read(labels, run, clock, 'run');
  assert.equal(reasonOf(res, 'm5'), R.slow);
  assert.equal(run.callsMatching((a) => isTriage(a, 'g-m5'))[0].timeoutMs, 60000);
  const m6 = run.callsMatching((a) => isTriage(a, 'g-m6'))[0];
  assert.equal(m6.timeoutMs, 300000 - (4 * 59000 + 60000));
  assert.equal(reasonOf(res, 'm6'), R.slow);
  assert.equal(reasonOf(res, 'm7'), R.slow);
  assert.equal(run.callsMatching((a) => isTriage(a, 'g-m7')).length, 0);
});

test('R160 realRun kills the whole process group on timeout (POSIX only)', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmpDir();
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    setTimeout(() => {}, 30000);
  `;
  const t0 = Date.now();
  const res = await realRun([process.execPath, '-e', script], { timeoutMs: 300 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 10000, 'returned promptly after the kill');
  assert.ok(fs.existsSync(pidFile), 'the child started its grandchild within the limit');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 1);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch (e) { gone = e.code === 'ESRCH'; if (!gone) throw e; }
  }
  if (!gone) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  assert.ok(gone, 'the grandchild is gone after the group kill');
});

// ---------------- R163 ----------------

const VALID = { mailboxes: ['alpha', 'beta'], frequency: 'morning', glitch: '/opt/invented/glitch' };
const memFs = (files) => ({
  readFile: async (p) => {
    if (Object.hasOwn(files, p)) return files[p];
    const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e;
  },
});
const CFG_DIR = '/opt/invented/config';
const CFG_PATH = path.join(CFG_DIR, 'feed.config.json');
const readWith = (content) => readFeedConfig(CFG_DIR, { fs: memFs(content === undefined ? {} : { [CFG_PATH]: typeof content === 'string' ? content : JSON.stringify(content) }) });
const oneSentence = (res) => {
  assert.equal(res.ok, false);
  assert.equal(typeof res.sentence, 'string');
  assert.ok(res.sentence.trim().length > 0 && !/\n/.test(res.sentence), 'one line');
};

test('R163 readFeedConfig returns a valid file as ok:true with the three fields', async () => {
  const res = await readWith(VALID);
  assert.equal(res.ok, true);
  assert.deepEqual(res.config, VALID);
  const hourly = await readWith({ ...VALID, frequency: 'hourly' });
  assert.equal(hourly.config.frequency, 'hourly');
  const one = await readWith({ ...VALID, mailboxes: ['solo'] });
  assert.equal(one.ok, true);
  const ten = await readWith({ ...VALID, mailboxes: Array.from({ length: 10 }, (_, i) => `box${i}`) });
  assert.equal(ten.ok, true);
});

test('R163 readFeedConfig: a missing file is ok:false with one sentence', async () => oneSentence(await readWith(undefined)));

test('R163 readFeedConfig: a file that is not JSON is ok:false with one sentence', async () => {
  oneSentence(await readWith('{ not json'));
  oneSentence(await readWith(''));
});

test('R163 readFeedConfig: each invalid field is ok:false with one sentence', async () => {
  const bad = {
    'mailboxes empty': { ...VALID, mailboxes: [] },
    'mailboxes more than 10': { ...VALID, mailboxes: Array.from({ length: 11 }, (_, i) => `box${i}`) },
    'mailboxes holds a non-string': { ...VALID, mailboxes: ['alpha', 7] },
    'mailboxes holds an empty string': { ...VALID, mailboxes: ['alpha', ''] },
    'mailboxes not an array': { ...VALID, mailboxes: 'alpha' },
    'mailboxes missing': { frequency: 'morning', glitch: VALID.glitch },
    'frequency other': { ...VALID, frequency: 'daily' },
    'frequency missing': { mailboxes: VALID.mailboxes, glitch: VALID.glitch },
    'glitch relative': { ...VALID, glitch: 'relative/glitch' },
    'glitch dot-relative': { ...VALID, glitch: './glitch' },
    'glitch not a string': { ...VALID, glitch: 5 },
    'glitch missing': { mailboxes: VALID.mailboxes, frequency: 'morning' },
    'not an object': ['alpha'],
  };
  for (const [name, content] of Object.entries(bad)) {
    const res = await readWith(content);
    assert.equal(res.ok, false, name);
    oneSentence(res);
  }
});

test('R163 the CLI with an invalid config exits non-zero, writes nothing, prints one sentence and spawns nothing', async () => {
  const cases = { missing: undefined, 'mailboxes empty': { ...VALID, mailboxes: [] }, 'glitch relative': { ...VALID, glitch: 'rel/path' }, 'frequency other': { ...VALID, frequency: 'weekly' } };
  for (const verb of ['run', 'check']) {
    for (const [name, content] of Object.entries(cases)) {
      const dir = await tmpDir();
      if (content !== undefined) await writeConfig(dir, content);
      const before = (await fsp.readdir(dir)).sort();
      const clock = makeClock();
      const run = makeFakeRun({ clock });
      const io = makeIo();
      const code = await main([verb, '--config-dir', dir], deps({ dir, run, clock, io }));
      assert.notEqual(code, 0, `${verb} ${name}`);
      assert.deepEqual((await fsp.readdir(dir)).sort(), before, `${verb} ${name}: nothing written`);
      assert.equal(run.calls.length, 0, `${verb} ${name}: no process`);
      assert.equal(io.lines().length, 1, `${verb} ${name}: exactly one sentence, got ${JSON.stringify(io.all())}`);
    }
  }
});

test('R163 run --fixtures spawns nothing and its counts come from the fixtures folder', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { mailboxes: ['alpha-box', 'beta-box'], frequency: 'morning', glitch: GLITCH });
  const clock = makeClock();
  const run = makeFakeRun({ clock });
  const io = makeIo();
  const code = await main(['run', '--config-dir', dir, '--fixtures', FIXTURES], deps({ dir, run, clock, io }));
  assert.equal(code, 0);
  assert.equal(run.calls.length, 0, 'the fake run records zero calls');
  const inbox = JSON.parse(await fsp.readFile(path.join(dir, 'state', 'inbox.json'), 'utf8'));
  assert.equal(inbox.threads.length, 3, 'two items from triage-alpha-box.json plus one from triage-beta-box.json');
  assert.deepEqual(inbox.counts, { reply: 2, decide: 0, fyi: 1 });
  const line = JSON.parse(io.lines()[0]);
  assert.ok(/3/.test(line.headline), `the headline carries the count: ${line.headline}`);
  assert.ok(!io.all().includes('SNIPPET-SENTINEL') && !io.all().includes('@'));
});

test('R163 --fixtures counts follow the folder: a folder with no alpha items gives one thread', async () => {
  const dir = await tmpDir();
  const fx = await tmpDir();
  await writeConfig(dir, { mailboxes: ['alpha-box', 'beta-box'], frequency: 'morning', glitch: GLITCH });
  await fsp.copyFile(path.join(FIXTURES, 'health.json'), path.join(fx, 'health.json'));
  await fsp.copyFile(path.join(FIXTURES, 'triage-beta-box.json'), path.join(fx, 'triage-beta-box.json'));
  await fsp.writeFile(path.join(fx, 'triage-alpha-box.json'), json(triageOk('g-acct-1', 'alpha-box', [])));
  const clock = makeClock();
  const run = makeFakeRun({ clock });
  const io = makeIo();
  const code = await main(['run', '--config-dir', dir, '--fixtures', fx], deps({ dir, run, clock, io }));
  assert.equal(code, 0);
  assert.equal(run.calls.length, 0);
  const inbox = JSON.parse(await fsp.readFile(path.join(dir, 'state', 'inbox.json'), 'utf8'));
  assert.equal(inbox.threads.length, 1);
});

test('R163 run and check each print exactly one JSON line {headline, items}', async () => {
  for (const verb of ['run', 'check']) {
    const dir = await tmpDir();
    await writeConfig(dir, { mailboxes: ['alpha-box', 'beta-box'], frequency: 'hourly', glitch: GLITCH });
    const clock = makeClock();
    const run = makeFakeRun({ clock });
    const io = makeIo();
    const code = await main([verb, '--config-dir', dir, '--fixtures', FIXTURES], deps({ dir, run, clock, io }));
    assert.equal(code, 0, verb);
    assert.equal(io.lines().length, 1, `${verb}: one line, got ${JSON.stringify(io.all())}`);
    const parsed = JSON.parse(io.lines()[0]);
    assert.deepEqual(Object.keys(parsed).sort(), ['headline', 'items']);
    assert.equal(typeof parsed.headline, 'string');
    assert.ok(Array.isArray(parsed.items) && parsed.items.every((s) => typeof s === 'string'));
  }
});

test('R163 check writes nothing: no state folder appears, door calls use the check limit and the --uv program', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { mailboxes: ['alpha', 'beta'], frequency: 'morning', glitch: GLITCH });
  const clock = makeClock();
  const run = okRun(clock);
  const io = makeIo();
  const code = await main(['check', '--config-dir', dir, '--uv', UV], deps({ dir, run, clock, io }));
  assert.equal(code, 0);
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['feed.config.json']);
  assert.ok(!fs.existsSync(path.join(dir, 'state')));
  assert.ok(run.calls.length >= 4);
  for (const c of run.calls) assert.equal(c.timeoutMs, 240000);
  assert.ok(run.calls.every((c) => c.argv[0] === UV), '--uv is the program that is spawned');
  assert.equal(io.lines().length, 1);
});

test('R163 run with BOARD_CONFIG_DIR and no --config-dir reads the config there, writes state/inbox.json and uses 60 second door calls', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { mailboxes: ['alpha', 'beta'], frequency: 'morning', glitch: GLITCH });
  const clock = makeClock();
  const run = okRun(clock);
  const io = makeIo();
  const code = await main(['run'], deps({ dir, run, clock, io }));
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(dir, 'state', 'inbox.json')));
  for (const c of run.calls) assert.equal(c.timeoutMs, 60000);
});

// ---- feed.env (amendment A5): the scheduled job starts with none of the board's environment ----
const TOKEN = 'secret-token-xyz';
async function envSetup({ envText, mode = 0o600, mailboxes = ['alpha-box', 'beta-box'] }) {
  const cfg = await tmpDir();
  const data = await tmpDir();
  await writeConfig(cfg, { mailboxes, frequency: 'morning', glitch: GLITCH });
  if (envText !== undefined) {
    const p = path.join(cfg, 'feed.env');
    await fsp.writeFile(p, envText.replaceAll('<DATA>', data));
    await fsp.chmod(p, mode);
  }
  return { cfg, data };
}
const bareDeps = ({ cfg, run, clock, io, env = {} }) => ({ env, fetch: async () => { throw new Error('no network in these tests'); }, cwd: cfg, out: io.out, err: io.err, run, fs: fsp, clock });
const runEnv = async (argv, setup, { env = {}, run } = {}) => {
  const clock = makeClock();
  const fake = run ?? makeFakeRun({ clock });
  const io = makeIo();
  const code = await main(argv, bareDeps({ cfg: setup.cfg, run: fake, clock, io, env }));
  return { code, io, fake };
};

test('R163 with an empty environment, feed.env supplies BOARD_CONFIG_DIR and a --fixtures run writes state/inbox.json there', async () => {
  const s = await envSetup({ envText: 'BOARD_CONFIG_DIR=<DATA>\n' });
  const { code, io, fake } = await runEnv(['run', '--config-dir', s.cfg, '--fixtures', FIXTURES], s);
  assert.equal(code, 0, io.all());
  assert.equal(fake.calls.length, 0);
  assert.ok(fs.existsSync(path.join(s.data, 'state', 'inbox.json')));
  assert.ok(!fs.existsSync(path.join(s.cfg, 'state')), 'nothing lands beside the config unless the file said so');
});

test('R163 a variable already in the environment wins over feed.env', async () => {
  const s = await envSetup({ envText: 'BOARD_CONFIG_DIR=<DATA>\n' });
  const other = await tmpDir();
  const { code, io } = await runEnv(['run', '--config-dir', s.cfg, '--fixtures', FIXTURES], s, { env: { BOARD_CONFIG_DIR: other } });
  assert.equal(code, 0, io.all());
  assert.ok(fs.existsSync(path.join(other, 'state', 'inbox.json')));
  assert.ok(!fs.existsSync(path.join(s.data, 'state')), 'the file\'s value was not used');
});

test('R163 an unknown key in feed.env is ignored and never reaches a spawned process', async () => {
  const s = await envSetup({
    mailboxes: ['alpha', 'beta'],
    envText: 'PATH=/evil\nNODE_OPTIONS=--require=/evil/x.js\nEVIL_KEY=evil-value\nBOARD_CONFIG_DIR=<DATA>\n',
  });
  const clock = makeClock();
  const run = okRun(clock);
  const io = makeIo();
  const code = await main(['run', '--config-dir', s.cfg, '--uv', UV], bareDeps({ cfg: s.cfg, run, clock, io, env: { PATH: '/usr/bin', HOME: '/home/invented' } }));
  assert.equal(code, 0, io.all());
  assert.ok(fs.existsSync(path.join(s.data, 'state', 'inbox.json')), 'the allowed key was still read');
  assert.ok(run.calls.length >= 4);
  for (const c of run.calls) {
    const blob = JSON.stringify([c.argv, c.opts?.env ?? null]);
    assert.ok(!blob.includes('/evil') && !blob.includes('NODE_OPTIONS') && !blob.includes('EVIL_KEY') && !blob.includes('evil-value'), blob);
    if (c.opts?.env?.PATH !== undefined) assert.equal(c.opts.env.PATH, '/usr/bin');
  }
  assert.ok(!io.all().includes('/evil'));
});

test('R163 feed.env comments, blank lines and surrounding spaces are ignored', async () => {
  const s = await envSetup({ envText: '# the feed\'s own settings\n\n   \n# BOARD_CONFIG_DIR=/nowhere/commented\nBOARD_CONFIG_DIR=<DATA>\n\n# end\n' });
  const { code, io } = await runEnv(['run', '--config-dir', s.cfg, '--fixtures', FIXTURES], s);
  assert.equal(code, 0, io.all());
  assert.ok(fs.existsSync(path.join(s.data, 'state', 'inbox.json')));
});

test('R163 a feed.env that group or others can read stops the run with one sentence and writes nothing (POSIX only)', { skip: process.platform === 'win32' }, async () => {
  for (const mode of [0o644, 0o640, 0o604]) {
    const s = await envSetup({ envText: `BOARD_CONFIG_DIR=<DATA>\nBOARD_GITHUB_TOKEN=${TOKEN}\n`, mode });
    const before = (await fsp.readdir(s.cfg)).sort();
    const { code, io, fake } = await runEnv(['run', '--config-dir', s.cfg, '--fixtures', FIXTURES], s);
    assert.notEqual(code, 0, `mode ${mode.toString(8)}`);
    assert.equal(io.lines().length, 1, `one sentence, got ${JSON.stringify(io.all())}`);
    assert.ok(io.all().includes('feed.env') && !io.all().includes('Set BOARD_CONFIG_DIR'), `the sentence is about feed.env: ${io.all()}`);
    assert.deepEqual((await fsp.readdir(s.cfg)).sort(), before);
    assert.deepEqual(await fsp.readdir(s.data), [],'nothing written to the data folder');
    assert.equal(fake.calls.length, 0);
    assert.ok(!io.all().includes(TOKEN));
  }
});

test('R163 the token in feed.env appears in no printed line: success, bad mode and missing repo', async () => {
  const good = await envSetup({ envText: `BOARD_CONFIG_DIR=<DATA>\nBOARD_GITHUB_TOKEN=${TOKEN}\n` });
  const ok = await runEnv(['run', '--config-dir', good.cfg, '--fixtures', FIXTURES], good);
  assert.equal(ok.code, 0, ok.io.all());
  assert.ok(!ok.io.all().includes(TOKEN), 'success path');
  if (process.platform !== 'win32') {
    const bad = await envSetup({ envText: `BOARD_CONFIG_DIR=<DATA>\nBOARD_GITHUB_TOKEN=${TOKEN}\n`, mode: 0o644 });
    const r = await runEnv(['run', '--config-dir', bad.cfg, '--fixtures', FIXTURES], bad);
    assert.notEqual(r.code, 0);
    assert.ok(!r.io.all().includes(TOKEN), 'bad-mode path');
  }
  const noRepo = await envSetup({ envText: `BOARD_GITHUB_TOKEN=${TOKEN}\n` });
  const m = await runEnv(['run', '--config-dir', noRepo.cfg, '--fixtures', FIXTURES], noRepo);
  assert.notEqual(m.code, 0);
  assert.ok(!m.io.all().includes(TOKEN), 'missing-repo path');
  assert.deepEqual((await fsp.readdir(noRepo.cfg)).sort(), ['feed.config.json', 'feed.env']);
});

test('R163 with no feed.env and no environment, run still fails with the "Set BOARD_CONFIG_DIR" sentence and writes nothing', async () => {
  const s = await envSetup({});
  const { code, io, fake } = await runEnv(['run', '--config-dir', s.cfg, '--fixtures', FIXTURES], s);
  assert.notEqual(code, 0);
  assert.equal(io.lines().length, 1);
  assert.ok(io.all().includes('Set BOARD_CONFIG_DIR'), io.all());
  assert.deepEqual((await fsp.readdir(s.cfg)).sort(), ['feed.config.json']);
  assert.equal(fake.calls.length, 0);
});

// ---------------- helpers ----------------
async function tmpDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'feed-run-test-')); }
async function writeConfig(dir, content) { await fsp.writeFile(path.join(dir, 'feed.config.json'), JSON.stringify(content)); }
// Assumption: out and err are functions taking one string (a line, with or without its newline); they also expose
// .write so a stream-shaped use works. Blank chunks are ignored when counting lines.
function makeIo() {
  const chunks = [];
  const sink = (s) => { chunks.push(String(s)); };
  const mk = () => Object.assign((s) => sink(s), { write: (s) => { sink(s); return true; } });
  return {
    out: mk(), err: mk(),
    all: () => chunks.join('\n'),
    lines: () => chunks.join('\n').split('\n').filter((l) => l.trim() !== ''),
  };
}
function deps({ dir, run, clock, io }) {
  return { env: { BOARD_CONFIG_DIR: dir }, fetch: async () => { throw new Error('no network in these tests'); }, cwd: dir, out: io.out, err: io.err, run, fs: fsp, clock };
}
