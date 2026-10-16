// The Glitch feed (R157-R163). Usage:
//   node scripts/feed.mjs run   [--config-dir <dir>] [--uv <path>] [--fixtures <dir>]
//   node scripts/feed.mjs check [--config-dir <dir>] [--uv <path>] [--fixtures <dir>]
//   node scripts/feed.mjs schedule plan|apply|remove|status [--config-dir <dir>] [--uv <path>]
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import os from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFeedConfig } from '../feed/config.mjs';
import { readMailboxes, realRun } from '../feed/doors.mjs';
import { buildInbox, dump, logEntry } from '../feed/map.mjs';
import { targetFrom, writeState } from '../feed/write.mjs';

const USAGE = 'Use: feed.mjs run|check [--config-dir <dir>] [--uv <path>] [--fixtures <dir>], or feed.mjs schedule plan|apply|remove|status.';
const FEED_SCRIPT = fileURLToPath(import.meta.url);

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function isFile(fs, p) {
  try { await fs.access(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
}

// uv: --uv, then every PATH entry (uv, uv.exe), then ~/.local/bin, ~/.cargo/bin, /opt/homebrew/bin, /usr/local/bin. Never a .cmd shim.
export async function findUv({ explicit, env, home, fs }) {
  if (explicit) return resolve(explicit);
  const dirs = String((env && (env.PATH || env.Path)) || '').split(delimiter).filter(Boolean);
  dirs.push(join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
  for (const d of dirs) {
    for (const name of ['uv', 'uv.exe']) {
      const p = join(d, name);
      if (await isFile(fs, p)) return p;
    }
  }
  return null;
}

function commandRun(cmd, args, { input } = {}) {
  return new Promise((done) => {
    let out = '';
    let errText = '';
    let child;
    try { child = spawn(cmd, args, { shell: false, windowsHide: true }); } catch { done({ code: 127, stdout: '', stderr: '' }); return; }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errText += d; });
    child.on('error', () => done({ code: 127, stdout: out, stderr: errText }));
    child.on('close', (code) => done({ code, stdout: out, stderr: errText }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export async function main(argv, deps) {
  const { env = {}, fetch, cwd = process.cwd(), out, err } = deps;
  const fs = deps.fs || fsp;
  const clock = deps.clock || { now: () => Date.now() };
  const run = deps.run || realRun;
  const token = env.BOARD_GITHUB_TOKEN ? String(env.BOARD_GITHUB_TOKEN) : '';
  const clean = (s) => (token && String(s).includes(token) ? 'A message that cannot be shown here was hidden.' : String(s));
  const say = (l) => out(clean(l));
  const fail = (l) => { err(clean(l)); return 1; };
  const emit = (headline, items) => say(JSON.stringify({ headline, items }));

  try {
    const [verb, ...rest] = argv;
    let sub = null;
    let args = rest;
    if (verb === 'schedule') { [sub, ...args] = rest; if (!['plan', 'apply', 'remove', 'status'].includes(sub)) return fail(USAGE); }
    else if (verb !== 'run' && verb !== 'check') return fail(USAGE);

    const configDir = resolve(cwd, flag(args, '--config-dir') || env.BOARD_CONFIG_DIR || cwd);
    const read = await readFeedConfig(configDir, { fs });
    if (!read.ok) return fail(read.sentence);
    const config = read.config;
    const home = deps.home || os.homedir();
    const explicitUv = flag(args, '--uv');
    const fixturesDir = flag(args, '--fixtures');
    const uv = (await findUv({ explicit: explicitUv, env, home, fs })) ;

    if (verb === 'schedule') {
      if (!uv) return fail('uv was not found; pass --uv <absolute path to uv>.');
      const schedule = await import('../feed/schedule.mjs');
      const cfg = { frequency: config.frequency, nodePath: process.execPath, uvPath: uv, feedScript: FEED_SCRIPT, configDir };
      const sdeps = { run: deps.scheduleRun || commandRun, fs, home, user: deps.user || os.userInfo().username };
      const osName = deps.osName || process.platform;
      const result = await schedule[sub](osName, cfg, sdeps);
      const items = [];
      if (sub === 'status') items.push(result && result.installed ? `installed (${result.kind})` : 'not installed');
      else if (sub === 'plan') {
        for (const f of (result.files || [])) items.push(`file: ${f.path}`);
        for (const c of (result.commands || [])) items.push(`command: ${c.join(' ')}`);
      }
      if (result && result.note) items.push(String(result.note));
      emit(sub === 'plan' ? 'Feed job plan (nothing installed)' : sub === 'apply' ? 'Feed job installed' : sub === 'remove' ? 'Feed job removed' : 'Feed job status', items);
      return 0;
    }

    const mode = verb === 'check' ? 'check' : 'run';
    const target = verb === 'run' ? targetFrom(env) : null;
    if (verb === 'run' && !target) return fail('Set BOARD_CONFIG_DIR, or BOARD_REPO with BOARD_GITHUB_TOKEN, so the feed knows where to write.');

    const res = await readMailboxes({ ...config, uv: uv || 'uv' }, { run, clock, mode, fixturesDir: fixturesDir ? resolve(cwd, fixturesDir) : undefined, fs });
    const items = res.skipped.map((s) => `${s.label}: ${s.reason}`);
    const now = new Date(clock.now());
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const n = res.accounts.length;
    const total = config.mailboxes.length;

    if (n === 0) {
      emit(`No mailbox could be read (0 of ${total}); nothing was ${verb === 'run' ? 'written' : 'checked'}`, items);
      return 0;
    }
    const doc = buildInbox(now, res.accounts, { timeZone });
    const count = doc.threads.length;
    const mbx = `${n} of ${total} mailboxes`;
    if (verb === 'check') {
      emit(`Check: ${count} threads from ${mbx}; nothing was written`, items);
      return 0;
    }
    const inboxText = dump(doc);
    const entry = logEntry(now, count, { timeZone });
    const w = await writeState(target, { inboxText, entry }, { fetch, fs });
    items.push(w.line);
    emit(`Inbox: ${count} threads from ${mbx}`, items);
    return 0;
  } catch (e) {
    if (e instanceof RangeError) return fail('The inbox document is too large to write; nothing was written.');
    return fail('The feed stopped because of a problem it did not expect; nothing more was done.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
