// R162: the scheduled job. One job named howgozit-feed per OS, installed, replaced, queried and
// removed through an injected runner and filesystem. Node stdlib only; nothing here imports.
// The job is the member's own: this module never names, reads or touches any other tool's job.

const NAME = 'howgozit-feed';
const WIN_PATH = '\\Howgozit\\';
const WIN_TASK = 'Feed';
const LAUNCH_LABEL = 'ai.blastworks.howgozit.feed';
const UNIT = 'howgozit-feed';
const CRON_MARKER = '# howgozit-feed';
const HOURLY_FIRST = 7;
const HOURLY_LAST = 22;
const MORNING_HOUR = 6;

function checkCfg(cfg) {
  if (!cfg || (cfg.frequency !== 'morning' && cfg.frequency !== 'hourly')) {
    throw new Error('schedule: frequency must be "morning" or "hourly"');
  }
  for (const k of ['nodePath', 'uvPath', 'feedScript', 'configDir']) {
    if (typeof cfg[k] !== 'string' || cfg[k] === '') throw new Error(`schedule: ${k} is required`);
  }
}

function hours(cfg) {
  if (cfg.frequency === 'morning') return [MORNING_HOUR];
  const out = [];
  for (let h = HOURLY_FIRST; h <= HOURLY_LAST; h += 1) out.push(h);
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

// ---- quoting, one function per consumer --------------------------------------------------

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cronSafe = (s) => s.replace(/%/g, '\\%');
const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// systemd ExecStart: % and $ are specifiers, whitespace splits words, so quote when needed.
function unitQuote(s) {
  let v = String(s).replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (/[\s"'\\;]/.test(v)) v = `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return v;
}

// ---- builders (pure) ------------------------------------------------------------------------

function windowsArgument(cfg) {
  return `"${cfg.feedScript}" run --config-dir "${cfg.configDir}" --uv "${cfg.uvPath}"`;
}

function windowsTrigger(cfg) {
  if (cfg.frequency === 'morning') return ["$trigger = New-ScheduledTaskTrigger -Daily -At '06:00'"];
  return [
    "$trigger = New-ScheduledTaskTrigger -Daily -At '07:00'",
    '# repeat every hour for 15 hours: the last run is 22:00',
    "$rep = New-ScheduledTaskTrigger -Once -At '07:00' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 15 -Minutes 1)",
    '$trigger.Repetition = $rep.Repetition',
  ];
}

function powershell(script) {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script];
}

function windowsInstall(cfg) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `Unregister-ScheduledTask -TaskPath ${psQuote(WIN_PATH)} -TaskName ${psQuote(WIN_TASK)} -Confirm:$false -ErrorAction SilentlyContinue`,
    `$action = New-ScheduledTaskAction -Execute ${psQuote(cfg.nodePath)} -Argument ${psQuote(windowsArgument(cfg))}`,
    ...windowsTrigger(cfg),
    '$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)',
    `Register-ScheduledTask -TaskPath ${psQuote(WIN_PATH)} -TaskName ${psQuote(WIN_TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
  ];
  return powershell(lines.join('\n'));
}

function windowsRemoval() {
  return powershell(
    `Unregister-ScheduledTask -TaskPath ${psQuote(WIN_PATH)} -TaskName ${psQuote(WIN_TASK)} -Confirm:$false -ErrorAction SilentlyContinue`,
  );
}

function windowsQuery() {
  return powershell(
    [
      `$t = Get-ScheduledTask -TaskPath ${psQuote(WIN_PATH)} -TaskName ${psQuote(WIN_TASK)} -ErrorAction SilentlyContinue`,
      "if ($null -eq $t) { Write-Output '{\"installed\":false}'; exit 1 }",
      "Write-Output '{\"installed\":true}'",
    ].join('\n'),
  );
}

function plistText(cfg) {
  const marks = hours(cfg)
    .map((h) => `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>0</integer></dict>`)
    .join('\n');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    `  <key>Label</key>\n  <string>${LAUNCH_LABEL}</string>\n` +
    '  <key>ProgramArguments</key>\n  <array>\n' +
    `    <string>${xmlEscape(cfg.nodePath)}</string>\n` +
    `    <string>${xmlEscape(cfg.feedScript)}</string>\n` +
    '    <string>run</string>\n' +
    '    <string>--config-dir</string>\n' +
    `    <string>${xmlEscape(cfg.configDir)}</string>\n` +
    '    <string>--uv</string>\n' +
    `    <string>${xmlEscape(cfg.uvPath)}</string>\n` +
    '  </array>\n' +
    `  <key>StartCalendarInterval</key>\n  <array>\n${marks}\n  </array>\n` +
    '  <key>RunAtLoad</key>\n  <false/>\n' +
    '</dict>\n</plist>\n'
  );
}

function systemdUnits(cfg) {
  const h = cfg.frequency === 'morning' ? pad2(MORNING_HOUR) : `${pad2(HOURLY_FIRST)}..${pad2(HOURLY_LAST)}`;
  const timer =
    '[Unit]\nDescription=Howgozit feed schedule\n\n' +
    `[Timer]\nOnCalendar=*-*-* ${h}:00:00\nPersistent=true\nUnit=${UNIT}.service\n\n` +
    '[Install]\nWantedBy=timers.target\n';
  const service =
    '[Unit]\nDescription=Howgozit feed run\n\n' +
    '[Service]\nType=oneshot\n' +
    `ExecStart=${unitQuote(cfg.nodePath)} ${unitQuote(cfg.feedScript)} run --config-dir ${unitQuote(cfg.configDir)} --uv ${unitQuote(cfg.uvPath)}\n`;
  return { service, timer };
}

function cronLine(cfg) {
  const when = cfg.frequency === 'morning' ? `0 ${MORNING_HOUR} * * *` : `0 ${HOURLY_FIRST}-${HOURLY_LAST} * * *`;
  const q = (s) => cronSafe(shQuote(s));
  return `${when} ${q(cfg.nodePath)} ${q(cfg.feedScript)} run --config-dir ${q(cfg.configDir)} --uv ${q(cfg.uvPath)} ${CRON_MARKER}`;
}

const lingerNote = (deps) =>
  `To keep the feed running while you are logged out, run this once with sudo: loginctl enable-linger ${deps.user}`;

// ---- shared plumbing ------------------------------------------------------------------------

async function linuxKind(deps) {
  const r = await deps.run('systemctl', ['--user', 'show-environment']);
  return r.code === 0 ? 'systemd' : 'cron';
}

const unitDir = (deps) => `${deps.home}/.config/systemd/user`;
const plistPath = (deps) => `${deps.home}/Library/LaunchAgents/${LAUNCH_LABEL}.plist`;

async function uid(deps) {
  const r = await deps.run('id', ['-u']);
  const v = String(r.stdout || '').trim();
  if (r.code !== 0 || !/^\d+$/.test(v)) throw new Error('schedule: could not read the user id');
  return v;
}

async function must(deps, cmd, args, what, opts) {
  const r = await deps.run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`schedule: ${what} failed (${r.code}): ${String(r.stderr || '').trim()}`);
  return r;
}

function unsupported(osName) {
  return new Error(`schedule: unsupported OS "${osName}"`);
}

// ---- plan -----------------------------------------------------------------------------------

export async function plan(osName, cfg, deps) {
  checkCfg(cfg);
  if (osName === 'win32') {
    return { os: osName, kind: 'schtasks', name: NAME, files: [], commands: [windowsInstall(cfg)] };
  }
  if (osName === 'darwin') {
    const path = plistPath(deps);
    const id = await uid(deps);
    return {
      os: osName,
      kind: 'launchd',
      name: NAME,
      files: [{ path, text: plistText(cfg) }],
      commands: [
        ['launchctl', 'bootout', `gui/${id}/${LAUNCH_LABEL}`],
        ['launchctl', 'bootstrap', `gui/${id}`, path],
      ],
    };
  }
  if (osName === 'linux') {
    const note = lingerNote(deps);
    if ((await linuxKind(deps)) === 'systemd') {
      const dir = unitDir(deps);
      const u = systemdUnits(cfg);
      return {
        os: osName,
        kind: 'systemd',
        name: NAME,
        files: [
          { path: `${dir}/${UNIT}.service`, text: u.service },
          { path: `${dir}/${UNIT}.timer`, text: u.timer },
        ],
        commands: [
          ['systemctl', '--user', 'daemon-reload'],
          ['systemctl', '--user', 'enable', '--now', `${UNIT}.timer`],
          ['systemctl', '--user', 'try-restart', `${UNIT}.timer`],
        ],
        note,
      };
    }
    return {
      os: osName,
      kind: 'cron',
      name: NAME,
      files: [{ path: 'crontab', text: `${cronLine(cfg)}\n` }],
      commands: [['crontab', '-l'], ['crontab', '-']],
      note,
    };
  }
  throw unsupported(osName);
}

// ---- cron helpers -----------------------------------------------------------------------------

async function readCron(deps) {
  const r = await deps.run('crontab', ['-l']);
  if (r.code === 0) return String(r.stdout ?? '');
  if (/no crontab/i.test(String(r.stderr || ''))) return '';
  throw new Error(`schedule: could not read the crontab: ${String(r.stderr || '').trim()}`);
}

const withoutOurs = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trimEnd().endsWith(CRON_MARKER))
    .join('\n');

// ---- apply ------------------------------------------------------------------------------------

export async function apply(osName, cfg, deps) {
  const p = await plan(osName, cfg, deps);
  if (p.kind === 'schtasks') {
    await must(deps, p.commands[0][0], p.commands[0].slice(1), 'registering the task');
  } else if (p.kind === 'launchd') {
    const file = p.files[0];
    await deps.fs.mkdir(`${deps.home}/Library/LaunchAgents`, { recursive: true });
    await deps.run(p.commands[0][0], p.commands[0].slice(1)); // unload a previous copy; not loaded is fine
    await deps.fs.writeFile(file.path, file.text);
    await must(deps, p.commands[1][0], p.commands[1].slice(1), 'loading the LaunchAgent');
  } else if (p.kind === 'systemd') {
    await deps.fs.mkdir(unitDir(deps), { recursive: true });
    for (const f of p.files) await deps.fs.writeFile(f.path, f.text);
    await must(deps, 'systemctl', ['--user', 'daemon-reload'], 'daemon-reload');
    await must(deps, 'systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`], 'enabling the timer');
    await deps.run('systemctl', ['--user', 'try-restart', `${UNIT}.timer`]);
  } else {
    let existing = await readCron(deps);
    existing = withoutOurs(existing);
    if (existing !== '' && !existing.endsWith('\n')) existing += '\n';
    await must(deps, 'crontab', ['-'], 'writing the crontab', { input: existing + p.files[0].text });
  }
  const out = { os: p.os, kind: p.kind, name: p.name, installed: true };
  if (p.note) out.note = p.note;
  return out;
}

// ---- remove -----------------------------------------------------------------------------------

export async function remove(osName, cfg, deps) {
  if (osName === 'win32') {
    await must(deps, 'powershell.exe', windowsRemoval().slice(1), 'removing the task');
    return { os: osName, kind: 'schtasks', name: NAME, installed: false };
  }
  if (osName === 'darwin') {
    const id = await uid(deps);
    await deps.run('launchctl', ['bootout', `gui/${id}/${LAUNCH_LABEL}`]); // not loaded is fine
    await deps.fs.rm(plistPath(deps), { force: true });
    return { os: osName, kind: 'launchd', name: NAME, installed: false };
  }
  if (osName === 'linux') {
    const kind = await linuxKind(deps);
    if (kind === 'systemd') {
      const dir = unitDir(deps);
      await deps.run('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`]);
      await deps.fs.rm(`${dir}/${UNIT}.timer`, { force: true });
      await deps.fs.rm(`${dir}/${UNIT}.service`, { force: true });
      await deps.run('systemctl', ['--user', 'daemon-reload']);
    } else {
      const existing = await readCron(deps);
      const kept = withoutOurs(existing);
      if (kept !== existing) await must(deps, 'crontab', ['-'], 'writing the crontab', { input: kept });
    }
    return { os: osName, kind, name: NAME, installed: false, note: lingerNote(deps) };
  }
  throw unsupported(osName);
}

// ---- status (read only) -------------------------------------------------------------------------

export async function status(osName, cfg, deps) {
  if (osName === 'win32') {
    const q = windowsQuery();
    const r = await deps.run(q[0], q.slice(1));
    let installed = r.code === 0;
    try {
      const j = JSON.parse(String(r.stdout || '').trim());
      installed = installed && j.installed === true;
    } catch {
      /* keep the exit code's answer */
    }
    return { os: osName, kind: 'schtasks', name: NAME, installed };
  }
  if (osName === 'darwin') {
    const id = await uid(deps);
    const r = await deps.run('launchctl', ['print', `gui/${id}/${LAUNCH_LABEL}`]);
    return { os: osName, kind: 'launchd', name: NAME, installed: r.code === 0 };
  }
  if (osName === 'linux') {
    const kind = await linuxKind(deps);
    if (kind === 'systemd') {
      const r = await deps.run('systemctl', ['--user', 'is-enabled', `${UNIT}.timer`]);
      return { os: osName, kind, name: NAME, installed: r.code === 0 };
    }
    let text = '';
    try {
      text = await readCron(deps);
    } catch {
      text = '';
    }
    const installed = text.split('\n').some((l) => l.trimEnd().endsWith(CRON_MARKER));
    return { os: osName, kind, name: NAME, installed };
  }
  throw unsupported(osName);
}
