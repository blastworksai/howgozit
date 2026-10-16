// Reads each configured mailbox through Glitch's own doors (R159, R160). The runner is injected.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_STDOUT = 8 * 1024 * 1024;
const WHOLE_MS = 300000;
const MIN_LEFT_MS = 3000;
const PER_CALL = { run: 60000, check: 240000 };

export const REASONS = {
  signin: 'needs you to sign in again in Glitch',
  dormant: 'not connected in Glitch',
  unknown: 'not a mailbox Glitch knows',
  slow: 'took too long',
  notUnderstood: 'answer not understood',
};

// Ends a process and its children. Resolves true when the system call reported success.
export function defaultKillTree(pid, platform = process.platform) {
  if (platform === 'win32') {
    return new Promise((resolve) => {
      let done = false;
      const end = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      let k;
      const t = setTimeout(() => { try { k && k.kill(); } catch { /* gone */ } end(false); }, 5000);
      try {
        k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        k.on('error', () => end(false));
        k.on('close', (code) => end(code === 0));
      } catch { end(false); }
    });
  }
  try { process.kill(-pid, 'SIGKILL'); return Promise.resolve(true); } catch { return Promise.resolve(false); }
}

// The child's environment: process.env merged with opts.env, with every BOARD_* variable removed.
export function childEnv(extra, platform = process.platform) {
  const merged = { ...process.env, ...(extra || {}) };
  for (const k of Object.keys(merged)) {
    if ((platform === 'win32' ? k.toUpperCase() : k).startsWith('BOARD_')) delete merged[k];
  }
  return merged;
}

// The real runner: no shell, stdin closed, stderr discarded, whole process tree killed on timeout.
// Seam: realRun(argv, { timeoutMs, cwd, env, platform = process.platform, killTree = (pid) => Promise<boolean> }).
export function realRun(argv, { timeoutMs, cwd, env, platform = process.platform, killTree } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: platform !== 'win32',
        windowsHide: true,
        cwd,
        env: childEnv(env, platform),
      });
    } catch {
      resolve({ code: null, stdout: '', timedOut: false });
      return;
    }
    let out = '';
    let size = 0;
    let timedOut = false;
    let done = false;
    const release = () => {
      try { child.stdout.destroy(); } catch { /* closed */ }
      try { child.unref(); } catch { /* gone */ }
    };
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (timedOut) release();
      resolve({ code: timedOut ? null : code, stdout: timedOut ? '' : out, timedOut });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { size += d.length; if (size <= MAX_STDOUT) out += d; });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    const timer = setTimeout(async () => {
      timedOut = true;
      let killed = false;
      try {
        killed = await Promise.race([
          Promise.resolve((killTree || ((pid) => defaultKillTree(pid, platform)))(child.pid)),
          new Promise((r) => setTimeout(() => r(false), 6000).unref()),
        ]);
      } catch { killed = false; }
      if (!killed) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      // do not wait for pipes held by orphaned grandchildren
      finish(null);
    }, timeoutMs);
  });
}

function parseObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// A run function that answers from a fixtures folder instead of a process.
function fixtureRun(dir, fsMod) {
  const readJson = async (name) => (await fsMod.readFile(join(dir, name), 'utf8'));
  let ids = null;
  return async (argv) => {
    try {
      if (argv.includes('doctor')) {
        const h = JSON.parse(await readJson('health.json'));
        const which = argv.includes('integrations/ms_connections.py') ? 'microsoft' : 'google';
        ids = ids || {};
        for (const a of (h[which] && h[which].accounts) || []) ids[a.id] = a.label;
        return { code: 0, stdout: JSON.stringify(h[which] ?? {}), timedOut: false };
      }
      const id = argv[argv.indexOf('--account') + 1];
      return { code: 0, stdout: await readJson(`triage-${ids && ids[id] ? ids[id] : id}.json`), timedOut: false };
    } catch {
      return { code: 1, stdout: '', timedOut: false };
    }
  };
}

export async function readMailboxes(cfg, { run, clock = { now: () => Date.now() }, mode = 'run', fixturesDir, fs = { readFile } } = {}) {
  const uv = cfg.uv || 'uv';
  const scripts = join(cfg.glitch, '.claude', 'scripts');
  const call = fixturesDir ? fixtureRun(fixturesDir, fs) : run;
  const perCall = PER_CALL[mode] ?? PER_CALL.run;
  const t0 = clock.now();
  const door = async (tail) => {
    const left = WHOLE_MS - (clock.now() - t0);
    if (left < MIN_LEFT_MS) return { state: 'late' };
    let r;
    try {
      r = await call([uv, 'run', '--directory', scripts, 'python', ...tail], { timeoutMs: Math.min(perCall, left) });
    } catch { return { state: 'failed' }; }
    if (r.timedOut) return { state: 'late' };
    return { state: 'done', code: r.code, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
  };

  const rowsOf = async (script) => {
    const r = await door([script, 'doctor']);
    if (r.state === 'late') return { fail: REASONS.slow, rows: [] };
    if (r.state !== 'done' || r.code !== 0) return { fail: REASONS.notUnderstood, rows: [] };
    const j = parseObject(r.stdout);
    if (!j || !Array.isArray(j.accounts)) return { fail: REASONS.notUnderstood, rows: [] };
    return { fail: null, rows: j.accounts, enabled: j.enabled };
  };
  const google = await rowsOf('integrations/connections.py');
  const ms = await rowsOf('integrations/ms_connections.py');

  const rows = [];
  for (const a of google.rows) {
    if (!a || !Array.isArray(a.surfaces) || !a.surfaces.includes('gmail')) continue;
    rows.push({ id: a.id, label: a.label, healthy: !!a.health && a.health.status === 'connected' });
  }
  for (const a of ms.rows) {
    if (!a) continue;
    rows.push({ id: a.id, label: a.label, healthy: ms.enabled !== false && !!a.health && a.health.status === 'connected' && a.signed_in === true });
  }
  const lookupFail = [google.fail, ms.fail].includes(REASONS.slow) ? REASONS.slow : (google.fail || ms.fail);

  const accounts = [];
  const skipped = [];
  for (const label of cfg.mailboxes) {
    const same = rows.filter((r) => r.label === label);
    const found = same.find((r) => r.healthy) || same[0]
      || rows.find((r) => typeof r.label === 'string' && r.label.toLowerCase() === String(label).toLowerCase());
    if (!found) { skipped.push({ label, reason: lookupFail || REASONS.unknown }); continue; }
    if (!found.healthy) { skipped.push({ label, reason: REASONS.signin }); continue; }
    const r = await door(['email_triage.py', 'triage', '--account', String(found.id), '--limit', '30']);
    if (r.state === 'late') { skipped.push({ label, reason: REASONS.slow }); continue; }
    if (r.state !== 'done') { skipped.push({ label, reason: REASONS.notUnderstood }); continue; }
    if (r.code !== 0) { skipped.push({ label, reason: REASONS.signin }); continue; }
    const j = parseObject(r.stdout);
    if (!j || typeof j.status !== 'string') { skipped.push({ label, reason: REASONS.notUnderstood }); continue; }
    if (j.status === 'ask') { skipped.push({ label, reason: REASONS.unknown }); continue; }
    if (j.status === 'dormant') { skipped.push({ label, reason: REASONS.dormant }); continue; }
    if (j.status !== 'ok' || !Array.isArray(j.surface)) { skipped.push({ label, reason: REASONS.notUnderstood }); continue; }
    accounts.push({ label, triage: j });
  }
  return { accounts, skipped };
}
