// One read of the data repository, printing counts only. Usage: node scripts/read-once.mjs [--full]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../board/env.mjs';
import { createHttp } from '../board/github/http.mjs';
import { createCache } from '../board/cache.mjs';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { checkRaw } from '../board/shape-data.mjs';
import { createCalendarSource } from '../board/calendar/icloud.mjs';
import { readCalendarSetting } from '../board/shape-settings.mjs';

const read = readEnv(process.env);
if (!read.ok) {
  console.log(read.message);
  process.exit(1);
}
const { env } = read;
// a relative data folder is read against the project folder, as the server does
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
env.dataDir = path.resolve(SRC, env.dataDir);
const cache = createCache(env.dataDir);
const http = createHttp({ token: env.token, fetch: globalThis.fetch, etags: cache.etags });
const calendar = env.icloud ? createCalendarSource({ fetch: globalThis.fetch, login: env.icloud }) : null;
const loader = createLoader({ http, env, cache, clock: { now: () => Date.now() }, calendar });

const result = await loader.load({ full: true });
if (!result.ok) {
  console.log(`${result.notice.title}: ${result.notice.message}`);
  process.exit(1);
}
const { bundle } = result;
if (bundle.run.stale) {
  console.log(`stale: ${bundle.run.stale.reason}`);
  process.exit(1);
}

const { raw, state } = bundle;
// only the five state files: a loaded bundle always has settings, and a resolved theme does not say whether a file was there
const files = {};
for (const k of Object.keys(state)) files[k] = state[k] !== null;
const board = buildBoard({ raw, settings: bundle.settings, theme: bundle.theme, state, now: new Date().toISOString(), run: bundle.run });
const warnings = (board.meta && board.meta.warnings) || [];

console.log(`issues: ${raw.issues.length}`);
console.log(`milestones: ${raw.milestones.length}`);
console.log(`projects: ${raw.projects.length}`);
for (const p of raw.projects) console.log(`project ${p.number} items: ${p.items.length}`);
for (const [k, v] of Object.entries(files)) console.log(`state file ${k}: ${v ? 'yes' : 'no'}`);
console.log(`partial issues: ${raw.partial.issues}`);
console.log(`partial items: ${raw.partial.items}`);
for (const w of warnings) console.log(`warning ${w.code}: ${w.count}`);
console.log(`checkRaw: ${checkRaw(raw).ok ? 'ok' : 'not ok'}`);
{
  const cal = state.calendar;
  const on = readCalendarSetting(bundle.settings && bundle.settings.calendar).setting !== null;
  const count = cal && Array.isArray(cal.events) ? cal.events.length : 0;
  if (!on) console.log('calendar: off');
  else if (cal && cal.error === 'unreadable') console.log('calendar: not readable');
  else if (cal && cal.stale === true) console.log(`calendar: stale, ${count} events`);
  else console.log(`calendar: ${count} events`);
}
