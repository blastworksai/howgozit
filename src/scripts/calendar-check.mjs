// Shows which calendars an iCloud account has and how many events each named calendar has today.
// It never prints an event title, the sign-in or the password.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIcloud } from '../board/env.mjs';
import { isZone } from '../board/days.mjs';
import { createCalendarSource } from '../board/calendar/icloud.mjs';
import { warningText } from '../board/render/page.mjs';

// A name is the person's own data, but a terminal should not be driven by it.
const clean = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  let tz = null;
  const names = [];
  for (let i = 0; i < list.length; i += 1) {
    const flag = list[i];
    if (flag !== '--timezone' && flag !== '--calendar') {
      return { error: 'Unknown argument. Use --timezone <zone> and --calendar "<name>" (the second may repeat).' };
    }
    const value = list[i + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      return { error: `The ${flag} argument needs a value after it.` };
    }
    i += 1;
    if (flag === '--timezone') tz = value;
    else names.push(value);
  }
  return { tz, names };
}

export async function run({ argv, env, fetch, now, out } = {}) {
  const say = (line) => {
    try {
      out(line);
    } catch {
      // a failing printer must not turn into a thrown error
    }
  };
  try {
    const args = parseArgs(argv);
    if (args.error) {
      say(args.error);
      return 1;
    }
    let tz = args.tz;
    if (tz === null) {
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        tz = '';
      }
    }
    if (!isZone(tz)) {
      say('That time zone is not known. Give a zone name such as Europe/Brussels.');
      return 1;
    }
    const sign = readIcloud(env);
    if (!sign.ok) {
      say(sign.message);
      return 1;
    }
    if (!sign.icloud) {
      say('Set BOARD_ICLOUD_USER and BOARD_ICLOUD_APP_PASSWORD to check iCloud calendars.');
      return 1;
    }
    const source = createCalendarSource({ fetch, login: sign.icloud });
    const r = await source.inspect({ names: args.names, tz, now });
    if (!r.ok) {
      say(warningText({ code: r.code, count: 1 }));
      return 1;
    }
    say('Calendars found in iCloud:');
    for (const name of r.found) say(`  ${clean(name)}`);
    for (const row of r.rows) {
      const name = clean(row.name);
      say(row.found ? `${name}: ${row.timed} timed, ${row.allDay} all-day today` : `${name}: not found`);
    }
    for (const w of r.warnings) say(warningText(w));
    return 0;
  } catch {
    say('The calendar check could not be completed.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    fetch: globalThis.fetch,
    now: new Date().toISOString(),
    out: (line) => console.log(line),
  });
}
