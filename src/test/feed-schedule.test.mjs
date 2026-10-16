// R162: the scheduled job. Tests only, written from the contract before src/feed/schedule.mjs exists.
// The fakes below simulate OS state; the protocols they speak are documented at each fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, apply, remove, status } from '../feed/schedule.mjs';

// ---------------------------------------------------------------------------
// Fake promises-shaped fs. Exactly five methods: readFile, writeFile, mkdir, rm, rename.
// Files live in a Map path -> string. Every call is logged in `ops`.
// readFile of a missing path rejects with err.code === 'ENOENT'. rm without { force: true }
// on a missing path rejects with ENOENT. mkdir is a logged no-op. rename moves the entry.
// ---------------------------------------------------------------------------
function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const ops = [];
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files,
    ops,
    readFile: async (p) => {
      ops.push({ op: 'readFile', path: String(p) });
      if (!files.has(String(p))) throw enoent(p);
      return files.get(String(p));
    },
    writeFile: async (p, data) => {
      ops.push({ op: 'writeFile', path: String(p) });
      files.set(String(p), String(data));
    },
    mkdir: async (p) => {
      ops.push({ op: 'mkdir', path: String(p) });
    },
    rm: async (p, o = {}) => {
      ops.push({ op: 'rm', path: String(p) });
      if (!files.has(String(p))) {
        if (o && o.force) return;
        throw enoent(p);
      }
      files.delete(String(p));
    },
    rename: async (a, b) => {
      ops.push({ op: 'rename', path: String(a), to: String(b) });
      if (!files.has(String(a))) throw enoent(a);
      files.set(String(b), files.get(String(a)));
      files.delete(String(a));
    },
  };
}

// ---------------------------------------------------------------------------
// Fake runner: run(cmd, args, { input }) -> { code, stdout, stderr }. Never rejects.
// Protocols (the code under test must work against exactly these):
//  systemctl --user show-environment : code 0 (systemd world) or 1 (cron world).
//  systemctl --user is-enabled|is-active|status|cat|show|list-timers ... : code 0 if the timer
//     unit file exists in the fake fs, else 1. Any other `systemctl --user <verb>` : code 0, no state.
//  crontab -l : { code 0, stdout: <whole crontab> }. crontab - : replaces the crontab with `input`.
//     Any other crontab form : code 1.
//  launchctl bootstrap <domain> <plist path> : code 0 and the label (plist basename) becomes loaded;
//     code 5 if already loaded. launchctl bootout <target> (target ends in a label or a plist path):
//     code 0 and unloads; code 113 if not loaded. launchctl print|list <...label> : code 0 if loaded
//     else 113. Other launchctl verbs : code 0.
//  id -u : stdout "501\n".
//  powershell.exe | powershell | pwsh | pwsh.exe : the script is in the args as plain text (any
//     argument, e.g. after -Command) or as -EncodedCommand (base64 UTF-16LE). Statements are split
//     on newlines, ';' and '|'. Statements are interpreted loosely:
//       Register-ScheduledTask   with -TaskPath/-TaskName : adds \Path\Name. Code 1 if it already
//                                exists and the statement has no -Force.
//       Unregister-ScheduledTask with -TaskPath/-TaskName : removes it. Code 1 if missing and the
//                                statement has no `-ErrorAction SilentlyContinue`.
//       Get-ScheduledTask        with -TaskPath/-TaskName : exists -> code 0, stdout {"installed":true};
//                                missing -> code 1, stdout {"installed":false}.
//     Other statements are ignored. A task name starting with a backslash is already a full path.
//  schtasks / schtasks.exe : /query /tn <path> -> code 0 if present else 1; /delete /tn <path> -> removes.
//  loginctl, and any unknown command : recorded, code 127.
// ---------------------------------------------------------------------------
const WIN_GLITCH = '\\Glitch\\Watch';
const WIN_GLITCH_SPEC = 'GLITCH-ORIGINAL-TASK';
const CRON_SEED =
  "*/5 * * * * '/usr/bin/python3' '/opt/x/watch.py' check --quiet # glitch-watch\n" +
  '17 3 * * * /usr/local/bin/backup.sh --nightly\n';
const PLIST_GLITCH = '<plist>com.glitch.watch original</plist>\n';
const UNIT_GLITCH_SERVICE = '[Service]\nExecStart=/usr/bin/glitch-watch\n';
const UNIT_GLITCH_TIMER = '[Timer]\nOnCalendar=*:0/5\n';

function psText(args) {
  const i = args.findIndex((a) => /^-enc(odedcommand)?$/i.test(a));
  if (i >= 0 && args[i + 1]) return Buffer.from(args[i + 1], 'base64').toString('utf16le');
  return args.join('\n');
}

function taskFullPath(stmt) {
  const grab = (flag) => {
    const m = stmt.match(new RegExp(`-${flag}\\s+(?:'([^']*)'|"([^"]*)"|([^\\s'";|]+))`, 'i'));
    return m ? (m[1] ?? m[2] ?? m[3]) : null;
  };
  const name = grab('TaskName');
  let path = grab('TaskPath');
  if (name === null) return null;
  if (name.startsWith('\\')) return name;
  path = path || '\\';
  if (!path.startsWith('\\')) path = '\\' + path;
  if (!path.endsWith('\\')) path += '\\';
  return path + name;
}

function makeRunner(world, fs) {
  const calls = [];
  const st = {
    cron: world === 'linux-cron' ? CRON_SEED : null,
    tasks: new Map(world === 'win32' ? [[WIN_GLITCH, WIN_GLITCH_SPEC]] : []),
    loaded: new Set(world === 'darwin' ? ['com.glitch.watch'] : []),
  };
  const timerPath = '/home/tester/.config/systemd/user/howgozit-feed.timer';
  const run = async (cmd, args = [], opts = {}) => {
    const call = { cmd: String(cmd), args: args.map(String), input: opts && opts.input, text: '' };
    calls.push(call);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const bad = (code = 1, stderr = 'failed', stdout = '') => ({ code, stdout, stderr });
    const base = call.cmd.split(/[\\/]/).pop().toLowerCase();
    call.text = [call.cmd, ...call.args].join(' ');
    if (base === 'systemctl') {
      const a = call.args.filter((x) => x !== '--user');
      if (a[0] === 'show-environment') return world === 'linux-systemd' ? ok('HOME=/home/tester\n') : bad(1, 'Failed to connect to bus');
      if (['is-enabled', 'is-active', 'status', 'cat', 'show', 'list-timers'].includes(a[0])) {
        return fs.files.has(timerPath) ? ok() : bad(1, 'not found');
      }
      return ok();
    }
    if (base === 'crontab') {
      if (call.args.length === 1 && call.args[0] === '-l') {
        return st.cron === null ? bad(1, 'no crontab for tester') : ok(st.cron);
      }
      if (call.args.length === 1 && call.args[0] === '-') {
        st.cron = String(call.input ?? '');
        return ok();
      }
      return bad(1, 'unsupported crontab form');
    }
    if (base === 'launchctl') {
      const verb = call.args[0];
      const last = call.args[call.args.length - 1] || '';
      const label = last.split('/').pop().replace(/\.plist$/, '');
      if (verb === 'bootstrap') {
        if (st.loaded.has(label)) return bad(5, 'Bootstrap failed: 5: Input/output error');
        st.loaded.add(label);
        return ok();
      }
      if (verb === 'bootout') {
        if (!st.loaded.has(label)) return bad(113, 'Boot-out failed: 113');
        st.loaded.delete(label);
        return ok();
      }
      if (verb === 'print' || verb === 'list') return st.loaded.has(label) ? ok() : bad(113, 'not loaded');
      return ok();
    }
    if (base === 'id') return ok('501\n');
    if (['powershell.exe', 'powershell', 'pwsh', 'pwsh.exe'].includes(base)) {
      const text = psText(call.args);
      call.text = text;
      const stmts = text.split(/\r?\n|;|\|/);
      let out = '';
      for (const s of stmts) {
        if (/\bUnregister-ScheduledTask\b/i.test(s)) {
          const p = taskFullPath(s);
          if (p === null) return bad(1, 'unparsed unregister');
          if (st.tasks.has(p)) st.tasks.delete(p);
          else if (!/-ErrorAction\s+SilentlyContinue/i.test(s)) return bad(1, `task ${p} not found`);
        } else if (/(?<![A-Za-z])Register-ScheduledTask\b/i.test(s)) {
          const p = taskFullPath(s);
          if (p === null) return bad(1, 'unparsed register');
          if (st.tasks.has(p) && !/-Force\b/i.test(s)) return bad(1, `task ${p} already exists`);
          st.tasks.set(p, s);
        } else if (/\bGet-ScheduledTask\b/i.test(s)) {
          const p = taskFullPath(s);
          if (p !== null) {
            const there = st.tasks.has(p);
            if (!there) return bad(1, 'not found', '{"installed":false}');
            out = '{"installed":true}';
          }
        }
      }
      return ok(out);
    }
    if (base === 'schtasks' || base === 'schtasks.exe') {
      const lower = call.args.map((x) => x.toLowerCase());
      const i = lower.indexOf('/tn');
      const p = i >= 0 ? call.args[i + 1] : null;
      if (lower.includes('/query')) return p && st.tasks.has(p) ? ok() : bad(1, 'not found');
      if (lower.includes('/delete')) {
        if (p && st.tasks.has(p)) {
          st.tasks.delete(p);
          return ok();
        }
        return bad(1, 'not found');
      }
      return bad(1, 'unsupported schtasks form');
    }
    return bad(127, `unknown command ${call.cmd}`);
  };
  const isReadOnly = (c) => {
    const base = c.cmd.split(/[\\/]/).pop().toLowerCase();
    if (base === 'systemctl') {
      const a = c.args.filter((x) => x !== '--user');
      return ['show-environment', 'is-enabled', 'is-active', 'status', 'cat', 'show', 'list-timers'].includes(a[0]);
    }
    if (base === 'crontab') return c.args.length === 1 && c.args[0] === '-l';
    if (base === 'id') return true;
    if (base === 'launchctl') return ['print', 'list'].includes(c.args[0]);
    if (['powershell.exe', 'powershell', 'pwsh', 'pwsh.exe'].includes(base)) {
      return /Get-ScheduledTask/i.test(c.text) && !/Register-ScheduledTask|Unregister-ScheduledTask/i.test(c.text);
    }
    if (base === 'schtasks' || base === 'schtasks.exe') return c.args.some((x) => x.toLowerCase() === '/query');
    return false;
  };
  return { run, calls, st, mutating: () => calls.filter((c) => !isReadOnly(c)) };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const SCENARIOS = [
  {
    id: 'win32',
    osName: 'win32',
    home: 'C:\\Users\\tester',
    paths: {
      nodePath: 'C:\\nodejs\\node.exe',
      uvPath: 'C:\\Users\\tester\\.local\\bin\\uv.exe',
      feedScript: 'C:\\hg\\src\\scripts\\feed.mjs',
      configDir: 'C:\\Users\\tester\\AppData\\Roaming\\hg',
    },
    kind: 'schtasks',
  },
  {
    id: 'darwin',
    osName: 'darwin',
    home: '/Users/tester',
    paths: {
      nodePath: '/usr/local/bin/node',
      uvPath: '/Users/tester/.local/bin/uv',
      feedScript: '/opt/hg/src/scripts/feed.mjs',
      configDir: '/Users/tester/.config/hg',
    },
    kind: 'launchd',
  },
  {
    id: 'linux-systemd',
    osName: 'linux',
    home: '/home/tester',
    paths: {
      nodePath: '/usr/local/bin/node',
      uvPath: '/home/tester/.local/bin/uv',
      feedScript: '/opt/hg/src/scripts/feed.mjs',
      configDir: '/home/tester/.config/hg',
    },
    kind: 'systemd',
  },
  {
    id: 'linux-cron',
    osName: 'linux',
    home: '/home/tester',
    paths: {
      nodePath: '/usr/local/bin/node',
      uvPath: '/home/tester/.local/bin/uv',
      feedScript: '/opt/hg/src/scripts/feed.mjs',
      configDir: '/home/tester/.config/hg',
    },
    kind: 'cron',
  },
];

function makeEnv(sc, frequency = 'morning') {
  const seed = {};
  if (sc.id === 'darwin') seed[`${sc.home}/Library/LaunchAgents/com.glitch.watch.plist`] = PLIST_GLITCH;
  if (sc.id === 'linux-systemd') {
    seed[`${sc.home}/.config/systemd/user/glitch-watch.service`] = UNIT_GLITCH_SERVICE;
    seed[`${sc.home}/.config/systemd/user/glitch-watch.timer`] = UNIT_GLITCH_TIMER;
  }
  const fs = makeFs(seed);
  const runner = makeRunner(sc.id, fs);
  const deps = { run: runner.run, fs, home: sc.home, user: 'tester' };
  const cfg = { frequency, ...sc.paths };
  return { sc, fs, runner, deps, cfg, seed: { ...seed } };
}

const HOWGOZIT_MARK = '# howgozit-feed';
const darwinPlist = (e) => `${e.sc.home}/Library/LaunchAgents/ai.blastworks.howgozit.feed.plist`;
const sdDir = (e) => `${e.sc.home}/.config/systemd/user`;
const ourFsPaths = (e) => [...e.fs.files.keys()].filter((p) => /howgozit/i.test(p)).sort();
const ourCronLines = (e) => (e.runner.st.cron || '').split('\n').filter((l) => l.includes(HOWGOZIT_MARK));
const ourTasks = (e) => [...e.runner.st.tasks.keys()].filter((p) => /howgozit/i.test(p));

// Text of the installed job (what runs the feed), after apply.
function installedJobText(e) {
  switch (e.sc.id) {
    case 'win32':
      return e.runner.mutating().map((c) => c.text).join('\n');
    case 'darwin':
      return e.fs.files.get(darwinPlist(e)) ?? '';
    case 'linux-systemd':
      return (e.fs.files.get(`${sdDir(e)}/howgozit-feed.service`) ?? '') + '\n' + (e.fs.files.get(`${sdDir(e)}/howgozit-feed.timer`) ?? '');
    default:
      return ourCronLines(e).join('\n');
  }
}
// Text that carries the schedule (trigger).
function installedScheduleText(e) {
  switch (e.sc.id) {
    case 'linux-systemd':
      return e.fs.files.get(`${sdDir(e)}/howgozit-feed.timer`) ?? '';
    default:
      return installedJobText(e);
  }
}
function planJobText(p) {
  return [
    ...(p.files || []).map((f) => f.text),
    ...(p.commands || []).map((c) => c.join('\n')),
  ].join('\n');
}

function assertCommandLine(text, cfg, label) {
  const tokens = [cfg.nodePath, cfg.feedScript, 'run', '--config-dir', cfg.configDir, '--uv', cfg.uvPath];
  let at = 0;
  for (const t of tokens) {
    const i = text.indexOf(t, at);
    assert.ok(i >= 0, `${label}: expected "${t}" in order after offset ${at} in:\n${text}`);
    at = i + t.length;
  }
  assert.ok(!/\.cmd\b/i.test(text), `${label}: no .cmd shim`);
}

function assertNoGlitchInMutating(e) {
  for (const c of e.runner.mutating()) {
    const isCronWrite = c.cmd.split('/').pop() === 'crontab';
    const hay = isCronWrite ? c.text : `${c.text}\n${c.input ?? ''}`;
    assert.ok(!/glitch/i.test(hay), `mutating command names Glitch: ${c.text}`);
  }
  for (const o of e.fs.ops) {
    assert.ok(!/glitch/i.test(o.path + (o.to || '')), `fs ${o.op} touched ${o.path}`);
  }
  if (e.sc.id === 'linux-cron') {
    for (const l of ourCronLines(e)) assert.ok(!/glitch/i.test(l), `our cron line names Glitch: ${l}`);
  }
}

function assertGlitchIntact(e) {
  switch (e.sc.id) {
    case 'win32':
      assert.equal(e.runner.st.tasks.get(WIN_GLITCH), WIN_GLITCH_SPEC);
      break;
    case 'darwin':
      assert.equal(e.fs.files.get(`${e.sc.home}/Library/LaunchAgents/com.glitch.watch.plist`), PLIST_GLITCH);
      assert.ok(e.runner.st.loaded.has('com.glitch.watch'));
      break;
    case 'linux-systemd':
      assert.equal(e.fs.files.get(`${sdDir(e)}/glitch-watch.service`), UNIT_GLITCH_SERVICE);
      assert.equal(e.fs.files.get(`${sdDir(e)}/glitch-watch.timer`), UNIT_GLITCH_TIMER);
      break;
    default: {
      const lines = e.runner.st.cron.split('\n');
      for (const keep of CRON_SEED.split('\n').filter(Boolean)) {
        assert.equal(lines.filter((l) => l === keep).length, 1, `cron line kept byte for byte: ${keep}`);
      }
    }
  }
  assertNoGlitchInMutating(e);
}

function assertNothingOurs(e) {
  assert.deepEqual(ourFsPaths(e), [], 'no howgozit file left on disk');
  assert.deepEqual(ourTasks(e), [], 'no howgozit task left');
  assert.deepEqual(ourCronLines(e), [], 'no howgozit cron line left');
  for (const l of e.runner.st.loaded) assert.ok(!/howgozit/i.test(l), `still loaded: ${l}`);
}

// ---- schedule parsers ----
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const HOURLY = range(7, 22);
function expandHourField(field) {
  const out = [];
  for (const part of field.split(',')) {
    const m = part.match(/^(\d{1,2})(?:(?:\.\.|-)(\d{1,2}))?$/);
    assert.ok(m, `unparseable hour part "${part}"`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    out.push(...range(a, b));
  }
  return out;
}
const uniqSorted = (xs) => [...new Set(xs)].sort((a, b) => a - b);

function systemdHours(timerText) {
  const lines = timerText.split('\n').filter((l) => /^OnCalendar=/.test(l));
  assert.ok(lines.length >= 1, 'timer has OnCalendar');
  const hours = [];
  for (const l of lines) {
    const t = l.slice('OnCalendar='.length).trim().split(/\s+/).pop();
    const [h, m, s] = t.split(':');
    assert.ok(h !== undefined && m !== undefined, `OnCalendar time part "${t}"`);
    assert.equal(Number(m), 0, `minute zero in ${l}`);
    if (s !== undefined) assert.equal(Number(s), 0, `second zero in ${l}`);
    hours.push(...expandHourField(h));
  }
  return uniqSorted(hours);
}
function cronHours(lines) {
  assert.equal(lines.length, 1, 'exactly one cron line');
  const f = lines[0].trim().split(/\s+/);
  assert.equal(Number(f[0]), 0, 'cron minute 0');
  assert.deepEqual(f.slice(2, 5), ['*', '*', '*'], 'cron day/month/weekday are *');
  return uniqSorted(expandHourField(f[1]));
}
function plistSchedule(text) {
  const k = text.indexOf('<key>StartCalendarInterval</key>');
  assert.ok(k >= 0, 'plist has StartCalendarInterval');
  const rest = text.slice(k + '<key>StartCalendarInterval</key>'.length);
  const isArray = /^\s*<array>/.test(rest);
  const end = rest.indexOf(isArray ? '</array>' : '</dict>');
  assert.ok(end > 0, 'StartCalendarInterval closes');
  const sec = rest.slice(0, end);
  const hours = [...sec.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]));
  const minutes = [...sec.matchAll(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]));
  return { hours: uniqSorted(hours), count: hours.length, minutes };
}
function winHasHourly(text) {
  const all16 = HOURLY.every((h) => text.includes(`${String(h).padStart(2, '0')}:00`));
  const windowed = text.includes('07:00') && text.includes('22:00') && /(New-TimeSpan\s+-Hours\s+1\b|PT1H\b|-Minutes\s+60\b)/i.test(text);
  return all16 || windowed;
}

function assertSchedule(e, freq) {
  const t = installedScheduleText(e);
  const want = freq === 'morning' ? [6] : HOURLY;
  switch (e.sc.id) {
    case 'win32':
      if (freq === 'morning') {
        assert.ok(/06:00/.test(t) && /Daily/i.test(t), `windows morning trigger daily 06:00:\n${t}`);
        assert.ok(!/07:00|22:00/.test(t), 'morning has no hourly window');
      } else {
        assert.ok(winHasHourly(t), `windows hourly trigger 07:00-22:00 every hour:\n${t}`);
      }
      break;
    case 'darwin': {
      const s = plistSchedule(t);
      assert.deepEqual(s.hours, want);
      assert.equal(s.count, want.length, 'one calendar entry per hour');
      assert.equal(s.minutes.length, want.length, 'every entry names Minute');
      assert.ok(s.minutes.every((m) => m === 0));
      break;
    }
    case 'linux-systemd':
      assert.deepEqual(systemdHours(t), want);
      break;
    default:
      assert.deepEqual(cronHours(ourCronLines(e)), want);
  }
}

const readOnlyOnly = (e) => {
  const m = e.runner.mutating();
  assert.deepEqual(m.map((c) => c.text), [], 'no mutating command was run');
};
const fsMutations = (e) => e.fs.ops.filter((o) => o.op !== 'readFile');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
for (const sc of SCENARIOS) {
  const name = (s) => `R162 ${sc.id}: ${s}`;

  test(name('plan writes nothing and runs no mutating command'), async () => {
    const e = makeEnv(sc);
    const before = JSON.stringify([...e.fs.files]);
    const cronBefore = e.runner.st.cron;
    const tasksBefore = JSON.stringify([...e.runner.st.tasks]);
    const loadedBefore = JSON.stringify([...e.runner.st.loaded]);
    await plan(sc.osName, e.cfg, e.deps);
    assert.equal(JSON.stringify([...e.fs.files]), before);
    assert.deepEqual(fsMutations(e), []);
    readOnlyOnly(e);
    assert.equal(e.runner.st.cron, cronBefore);
    assert.equal(JSON.stringify([...e.runner.st.tasks]), tasksBefore);
    assert.equal(JSON.stringify([...e.runner.st.loaded]), loadedBefore);
  });

  test(name('plan names the job and holds absolute node and uv paths in the run line'), async () => {
    const e = makeEnv(sc);
    const p = await plan(sc.osName, e.cfg, e.deps);
    assert.equal(p.os, sc.osName);
    assert.equal(p.kind, sc.kind);
    assert.match(String(p.name), /howgozit/i);
    assert.match(String(p.name), /feed/i);
    const text = planJobText(p);
    const ident = {
      win32: ['\\Howgozit\\', 'Feed'],
      darwin: ['ai.blastworks.howgozit.feed'],
      'linux-systemd': ['howgozit-feed.timer', 'howgozit-feed.service'],
      'linux-cron': [HOWGOZIT_MARK],
    }[sc.id];
    const hay = text + '\n' + (p.files || []).map((f) => f.path).join('\n');
    for (const i of ident) assert.ok(hay.includes(i), `plan mentions ${i}`);
    assertCommandLine(text, e.cfg, 'plan');
    if (sc.id === 'linux-cron') {
      assert.equal(p.files.length, 1, 'cron plan: files[0].text is the cron line');
      assert.ok(p.files[0].text.includes(HOWGOZIT_MARK));
    }
  });

  test(name('apply installs exactly one job with the contract name'), async () => {
    const e = makeEnv(sc);
    await apply(sc.osName, e.cfg, e.deps);
    switch (sc.id) {
      case 'win32':
        assert.deepEqual(ourTasks(e), ['\\Howgozit\\Feed']);
        assert.equal(e.runner.st.tasks.size, 2);
        break;
      case 'darwin':
        assert.deepEqual(ourFsPaths(e), [darwinPlist(e)]);
        assert.ok(e.runner.st.loaded.has('ai.blastworks.howgozit.feed'));
        break;
      case 'linux-systemd':
        assert.deepEqual(ourFsPaths(e), [`${sdDir(e)}/howgozit-feed.service`, `${sdDir(e)}/howgozit-feed.timer`]);
        break;
      default:
        assert.equal(ourCronLines(e).length, 1);
        assert.ok(ourCronLines(e)[0].endsWith(HOWGOZIT_MARK));
        assert.ok(e.runner.st.cron.endsWith('\n'));
        assert.deepEqual(ourFsPaths(e), []);
    }
    assertCommandLine(installedJobText(e), e.cfg, 'apply');
  });

  test(name('a second apply replaces, leaving exactly one job'), async () => {
    const e = makeEnv(sc);
    await apply(sc.osName, e.cfg, e.deps);
    await apply(sc.osName, { ...e.cfg, frequency: 'hourly' }, e.deps);
    switch (sc.id) {
      case 'win32':
        assert.deepEqual(ourTasks(e), ['\\Howgozit\\Feed']);
        assert.equal(e.runner.st.tasks.size, 2);
        break;
      case 'darwin':
        assert.deepEqual(ourFsPaths(e), [darwinPlist(e)]);
        assert.equal([...e.runner.st.loaded].filter((l) => /howgozit/.test(l)).length, 1);
        break;
      case 'linux-systemd':
        assert.equal(ourFsPaths(e).length, 2);
        break;
      default:
        assert.equal(ourCronLines(e).length, 1);
    }
    assertSchedule(e, 'hourly');
  });

  test(name('morning is 06:00 daily'), async () => {
    const e = makeEnv(sc, 'morning');
    await apply(sc.osName, e.cfg, e.deps);
    assertSchedule(e, 'morning');
  });

  test(name('hourly is every hour from 07:00 to 22:00'), async () => {
    const e = makeEnv(sc, 'hourly');
    await apply(sc.osName, e.cfg, e.deps);
    assertSchedule(e, 'hourly');
  });

  test(name('plan text carries the same schedule as apply'), async () => {
    const e = makeEnv(sc, 'hourly');
    const p = await plan(sc.osName, e.cfg, e.deps);
    const pt = planJobText(p);
    if (sc.id === 'win32') assert.ok(winHasHourly(pt));
    else if (sc.id === 'darwin') assert.deepEqual(plistSchedule(pt).hours, HOURLY);
    else if (sc.id === 'linux-systemd') {
      const timer = p.files.find((f) => /\.timer$/.test(f.path));
      assert.ok(timer, 'plan lists the .timer file');
      assert.deepEqual(systemdHours(timer.text), HOURLY);
    } else assert.deepEqual(cronHours(p.files[0].text.split('\n').filter((l) => l.includes(HOWGOZIT_MARK))), HOURLY);
  });

  test(name('remove leaves no trace of ours'), async () => {
    const e = makeEnv(sc);
    await apply(sc.osName, e.cfg, e.deps);
    await remove(sc.osName, e.cfg, e.deps);
    assertNothingOurs(e);
    if (sc.id === 'linux-cron') assert.equal(e.runner.st.cron, CRON_SEED, 'crontab restored byte for byte');
    // removing again, with nothing installed, is quiet
    await remove(sc.osName, e.cfg, e.deps);
    assertNothingOurs(e);
  });

  test(name("Glitch's watch job is untouched after apply, second apply and remove"), async () => {
    const e = makeEnv(sc);
    await plan(sc.osName, e.cfg, e.deps);
    assertGlitchIntact(e);
    await apply(sc.osName, e.cfg, e.deps);
    assertGlitchIntact(e);
    await apply(sc.osName, e.cfg, e.deps);
    assertGlitchIntact(e);
    await remove(sc.osName, e.cfg, e.deps);
    assertGlitchIntact(e);
    if (sc.id === 'linux-cron') assert.equal(e.runner.st.cron, CRON_SEED);
  });

  test(name('status reports installed false, true, false and mutates nothing'), async () => {
    const e = makeEnv(sc);
    const s0 = await status(sc.osName, e.cfg, e.deps);
    assert.equal(s0.installed, false);
    assert.equal(s0.kind, sc.kind);
    await apply(sc.osName, e.cfg, e.deps);
    const mutBefore = e.runner.mutating().length;
    const opsBefore = fsMutations(e).length;
    const s1 = await status(sc.osName, e.cfg, e.deps);
    assert.equal(s1.installed, true);
    assert.equal(s1.kind, sc.kind);
    assert.equal(e.runner.mutating().length, mutBefore, 'status ran no mutating command');
    assert.equal(fsMutations(e).length, opsBefore, 'status wrote nothing');
    await remove(sc.osName, e.cfg, e.deps);
    const s2 = await status(sc.osName, e.cfg, e.deps);
    assert.equal(s2.installed, false);
  });

  test(name('Glitch watch alone does not read as installed'), async () => {
    const e = makeEnv(sc);
    const s = await status(sc.osName, e.cfg, e.deps);
    assert.equal(s.installed, false);
    assertGlitchIntact(e);
  });

  if (sc.osName === 'linux') {
    test(name('plan and apply carry the loginctl enable-linger note and never run loginctl'), async () => {
      const e = makeEnv(sc);
      const p = await plan(sc.osName, e.cfg, e.deps);
      assert.ok(String(p.note).includes('loginctl enable-linger tester'), `plan note: ${p.note}`);
      const a = await apply(sc.osName, e.cfg, e.deps);
      assert.ok(String(a.note).includes('loginctl enable-linger tester'), `apply note: ${a.note}`);
      await apply(sc.osName, e.cfg, e.deps);
      await status(sc.osName, e.cfg, e.deps);
      await remove(sc.osName, e.cfg, e.deps);
      for (const c of e.runner.calls) {
        assert.ok(!/loginctl/i.test(c.cmd), `ran loginctl: ${c.text}`);
        assert.ok(!/loginctl/i.test(c.args.join(' ')), `loginctl in args: ${c.text}`);
      }
    });
  }
}

test('R162 linux: the service-manager probe picks systemd or cron', async () => {
  const sd = makeEnv(SCENARIOS[2]);
  const cr = makeEnv(SCENARIOS[3]);
  assert.equal((await plan('linux', sd.cfg, sd.deps)).kind, 'systemd');
  assert.equal((await plan('linux', cr.cfg, cr.deps)).kind, 'cron');
  assert.ok(sd.runner.calls.some((c) => c.cmd === 'systemctl' && c.args.join(' ') === '--user show-environment'));
  await apply('linux', sd.cfg, sd.deps);
  assert.ok(!sd.runner.calls.some((c) => c.cmd === 'crontab'), 'systemd world never touches crontab');
  await apply('linux', cr.cfg, cr.deps);
  assert.deepEqual(ourFsPaths(cr), [], 'cron world writes no unit files');
});
