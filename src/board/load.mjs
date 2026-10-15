// The loader: one read at a time, a full read once a day, trust checks, the last good read (R65-R67, R69-R72, R85).
// Time comes only from the injected clock; files and GitHub only from what is passed in.
import { readFile as fsReadFile } from 'node:fs/promises';
import { GitHubError } from './github/http.mjs';
import { BackendError } from './model/adapter.mjs';
import { rawIssue } from './github/read.mjs';
import { createGithubAdapter } from './github/adapter.mjs';
import { cardRef, refKey, sameRepo } from './model/snapshot.mjs';
import { checkSettings, readCalendarSetting } from './shape-settings.mjs';
import { resolveTheme } from './theme.mjs';
import { todayIn, timeIn, addDays, isZone } from './days.mjs';

const MAX_STATE_BYTES = 262144;
const PENDING_MS = 10 * 60000; // GitHub's item lists were seen running two minutes behind
const BACK_MS = 5 * 60000;
const STATE_KEYS = ['brief', 'calendar', 'inbox', 'log', 'proposals'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (ms) => new Date(ms).toISOString();
const notice = (title, message) => ({ ok: false, notice: { title, message, status: 503 } });

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// R125: `names` travels with the six Google codes and project-owner-unreadable only; merged lists keep settings order without duplicates.
function mergeWarnings(...lists) {
  const counts = new Map();
  const names = new Map();
  for (const list of lists) {
    for (const w of list) {
      counts.set(w.code, (counts.get(w.code) || 0) + w.count);
      if ((/^calendar-google-/.test(w.code) || w.code === 'project-owner-unreadable') && Array.isArray(w.names)) {
        const have = names.get(w.code) || [];
        for (const n of w.names) if (typeof n === 'string' && !have.includes(n)) have.push(n);
        names.set(w.code, have);
      }
    }
  }
  return [...counts].map(([code, count]) => (names.has(code) ? { code, count, names: names.get(code) } : { code, count }));
}

function parseState(text) {
  if (text === null) return null;
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) return { error: 'unreadable' };
  const p = parseJson(text);
  return p.ok ? p.value : { error: 'unreadable' };
}

export function createLoader({ http, httpFor, env, cache, clock, readFile = (p) => fsReadFile(p, 'utf8'), calendar, googleCalendar, adapter: given }) {
  const notion = env.backend === 'notion';
  const where = notion ? 'the settings folder (BOARD_CONFIG_DIR)' : 'the data repository';
  const adapter = given || createGithubAdapter({ http, httpFor, repo: env.repo, configDir: env.configDir, readFile, gh: null });
  let held = null; // last good read: { savedAt, raw, settings, theme, state, warnings }
  let lastFullDay = null; // refresh day of the last successful full read
  let sinceIso = null; // five minutes before that full read began
  let inflight = null;
  let pending = []; // { projectOwner, projectNumber, issueNumber, at }

  // The refresh day of an instant: the board date, minus one day before refresh.dailyAt (R65).
  function refreshDay(ms) {
    const s = held && isObj(held.settings) ? held.settings : {};
    const tz = typeof s.timezone === 'string' && isZone(s.timezone) ? s.timezone : 'UTC';
    const at = isObj(s.refresh) && typeof s.refresh.dailyAt === 'string' && /^\d\d:\d\d$/.test(s.refresh.dailyAt) ? s.refresh.dailyAt : '05:00';
    const now = iso(ms);
    const day = todayIn(tz, now);
    return timeIn(tz, now) < at ? addDays(day, -1) : day;
  }

  // Pending items (R70) are added to a copy, so they expire without touching what is held.
  function answer(stale) {
    const ms = clock.now();
    pending = pending.filter((e) => ms - e.at <= PENDING_MS);
    const bundle = {
      savedAt: held.savedAt,
      raw: structuredClone(held.raw),
      settings: structuredClone(held.settings),
      theme: structuredClone(held.theme),
      state: structuredClone(held.state),
    };
    // R6: a project is (owner, number); a missing owner on either side is the data repo's owner.
    const dataOwner = String(env.repo).split('/')[0].toLowerCase();
    const ownerOf = (o) => (typeof o === 'string' && o !== '' ? o.toLowerCase() : dataOwner);
    for (const e of pending) {
      if (isObj(e.row) && Array.isArray(bundle.raw.issues)) {
        const key = refKey(cardRef(e.row, bundle.raw.repo));
        if (!bundle.raw.issues.some((x) => refKey(cardRef(x, bundle.raw.repo)) === key)) bundle.raw.issues.push(structuredClone(e.row));
      }
      const project = (bundle.raw.projects || []).find((p) => p.number === e.projectNumber && ownerOf(p.owner) === ownerOf(e.projectOwner));
      if (!project) continue;
      const itemRepo = typeof e.repo === 'string' && e.repo !== '' ? e.repo : env.repo;
      const isIt = (it) => it.type === 'Issue' && sameRepo(it.repo, itemRepo) && it.number === e.issueNumber;
      if (e.removed === true) {
        project.items = project.items.filter((it) => !isIt(it));
        continue;
      }
      const have = project.items.find(isIt);
      if (!have) {
        const added = { type: 'Issue', repo: itemRepo, number: e.issueNumber, status: null, due: null };
        if (e.itemId !== undefined) added.itemId = e.itemId;
        if (e.score !== undefined) added.score = e.score;
        project.items.push(added);
      } else {
        if (e.score !== undefined) have.score = e.score;
        if (e.itemId !== undefined && have.itemId === undefined) have.itemId = e.itemId;
      }
    }
    bundle.run = { stale, readOnly: env.readOnly === true, warnings: structuredClone(held.warnings || []) };
    return { ok: true, bundle };
  }

  // A failed read (R67): the last good read from memory or the cache, marked stale.
  async function staleFrom(err) {
    if (!held && cache) {
      try {
        const saved = await cache.readLastGood();
        if (isObj(saved) && isObj(saved.raw) && isObj(saved.settings) && typeof saved.savedAt === 'string') {
          held = { ...saved, warnings: [] };
        }
      } catch { /* no saved read */ }
    }
    if (!held) {
      // only the kind's own fixed sentence reaches the text; an unreached GitHub keeps the connection advice
      if (notion) {
        const said = err instanceof BackendError && err.code !== 'unavailable';
        return notice('No saved data yet', said
          ? `The board has no saved data yet. ${err.message}`
          : 'The board has no saved data yet and Notion did not answer. Check the connection and try again in a minute.');
      }
      const answered = err instanceof GitHubError && err.kind !== 'network';
      return notice('No saved data yet', answered
        ? `The board has no saved data yet. ${err.message}`
        : 'The board has no saved data yet and GitHub did not answer. Check the connection and try again in a minute.');
    }
    if (notion) return answer({ since: held.savedAt, reason: err instanceof BackendError && err.message ? err.message : 'Notion could not be reached.' });
    const reason = err instanceof GitHubError ? err.message : 'GitHub could not be reached.';
    return answer({ since: held.savedAt, reason });
  }

  // true when the next load would be a full read (R65); the server's timer asks this
  function fullDue(ms = clock.now()) {
    return !held || lastFullDay === null || lastFullDay < refreshDay(ms);
  }

  async function doLoad(full) {
    const startMs = clock.now();
    const doFull = full === true || fullDue(startMs);
    let result;
    try {
      result = await adapter.read({
        full: doFull,
        since: doFull ? undefined : sinceIso,
        previous: held ? held.raw : undefined,
        now: iso(startMs),
      });
    } catch (err) {
      return staleFrom(err);
    }
    const { raw, texts } = result;

    // Trust, in this order (R72). A notice is never replaced by an older read.
    if (raw.repoPrivate !== true) {
      return notice('The data repository is public', 'The data repository is public, and the board will not show data from a public repository. Make it private on GitHub, then reload.');
    }
    // R72: a home repository is held to the same rule as the data repository; the first one in settings order is named.
    const publicHome = Array.isArray(raw.repos)
      ? raw.repos.find((r) => isObj(r) && r.role === 'home' && r.private !== true && typeof r.repo === 'string')
      : undefined;
    if (publicHome) {
      return notice('A home repository is public', `The repository ${publicHome.repo} is public, and the board will not show data from a public repository. Make it private on GitHub, then reload.`);
    }
    if (texts.settings === null) {
      return notice('No settings file found', `No settings file (board.config.json) was found in ${where}. Run the setup step to create one, then reload.`);
    }
    const parsed = parseJson(texts.settings);
    if (!parsed.ok) {
      return notice('The settings file cannot be used', `The settings file cannot be used because it is not valid JSON. Fix the file in ${where}, then reload.`);
    }
    const checked = checkSettings(parsed.value);
    if (!checked.ok) {
      return notice('The settings file cannot be used', `The settings file cannot be used: ${checked.errors[0]}. Fix the file in ${where}, then reload.`);
    }

    // Theme (R85) and state.
    let themeInput = null;
    if (texts.theme !== null) {
      const t = parseJson(texts.theme);
      themeInput = t.ok ? t.value : { error: 'unreadable' };
    }
    const themed = resolveTheme(themeInput);
    const state = {};
    for (const k of STATE_KEYS) state[k] = parseState(texts.state[k]);

    // The calendar read from iCloud (R96, R101). It never fails the load; it is not trusted.
    let calendarWarnings = [];
    const { setting } = readCalendarSetting(parsed.value.calendar);
    if (setting) {
      // includeFile (R109, R110): keep the file's own value under its own key so the model can show both.
      if (setting.includeFile === true && state.calendar !== null) state.calendarFile = state.calendar;
      if (setting.source === 'google') {
        // R118 to R128: the Google source; nothing of this runs for an iCloud block or none.
        const names = setting.calendars.map((c) => c.name);
        const down = () => {
          state.calendar = { error: 'unreadable', from: 'google' };
          calendarWarnings = [{ code: 'calendar-google-unreachable', count: names.length, names }];
        };
        if (!googleCalendar || typeof googleCalendar.read !== 'function') {
          down();
        } else {
          let r = null;
          try {
            r = await googleCalendar.read({ calendars: setting.calendars, tz: parsed.value.timezone, now: iso(startMs) });
          } catch { r = null; }
          if (isObj(r) && isObj(r.value) && Array.isArray(r.warnings)) {
            state.calendar = r.value.error === 'unreadable' ? { error: 'unreadable', from: 'google' } : r.value;
            calendarWarnings = r.warnings;
          } else {
            down();
          }
        }
      } else if (!calendar || typeof calendar.read !== 'function') {
        state.calendar = { error: 'unreadable', from: 'icloud' };
        calendarWarnings = [{ code: 'calendar-no-login', count: 1 }];
      } else {
        let r = null;
        try {
          r = await calendar.read({ calendars: setting.calendars, tz: parsed.value.timezone, now: iso(startMs) });
        } catch { r = null; }
        if (isObj(r) && isObj(r.value) && Array.isArray(r.warnings)) {
          state.calendar = r.value.error === 'unreadable' ? { error: 'unreadable', from: 'icloud' } : r.value;
          calendarWarnings = r.warnings;
        } else {
          state.calendar = { error: 'unreadable', from: 'icloud' };
          calendarWarnings = [{ code: 'calendar-unreachable', count: 1 }];
        }
      }
    }

    // Keep and save (R66). `run` is never saved.
    const savedAt = iso(startMs);
    held = {
      savedAt,
      raw,
      settings: parsed.value,
      theme: themed.theme,
      state,
      warnings: mergeWarnings(result.warnings, themed.warnings, calendarWarnings),
    };
    if (doFull) {
      lastFullDay = refreshDay(startMs);
      sinceIso = iso(startMs - BACK_MS).slice(0, 19) + 'Z';
    }
    try {
      await cache.writeLastGood({ savedAt, raw, settings: held.settings, theme: held.theme, state });
    } catch { /* the board still answers */ }
    return answer(null);
  }

  // One read at a time (R71): callers during a read get the same promise.
  function load({ full } = {}) {
    if (inflight) return inflight;
    const p = doLoad(full)
      .catch((err) => staleFrom(err))
      .catch(() => notice('The board could not load', 'Something went wrong while reading the board. Try again in a minute.'));
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
    return p;
  }

  // After a write (R70): the issue GitHub returned replaces the stored one; a new item shows for ten minutes.
  function noteWrite({ apiIssue, item, repo, removeRef } = {}) {
    let homeRow = null;
    if (isObj(apiIssue) && held && Array.isArray(held.raw.issues)) {
      let issue = rawIssue(apiIssue);
      // R70, R129: a card of another repo is stored with its repo and ref, replacing the held row with that ref.
      if (typeof repo === 'string' && repo !== '' && !sameRepo(repo, held.raw.repo)) {
        issue = { ...issue, repo, ref: `${repo}#${issue.number}` };
        homeRow = issue;
      }
      const key = refKey(cardRef(issue, held.raw.repo));
      const i = held.raw.issues.findIndex((x) => refKey(cardRef(x, held.raw.repo)) === key);
      if (i === -1) held.raw.issues.push(issue);
      else held.raw.issues[i] = issue;
    }
    // BR2-2: a written home card's row is held on its own pending entry (the handlers note the issue and its item in
    // separate calls), so a read that drops it while the Project items list lags still shows the card for PENDING_MS.
    if (homeRow) pending.push({ row: structuredClone(homeRow), at: clock.now() });
    if (typeof removeRef === 'string' && removeRef !== '' && held && Array.isArray(held.raw.issues)) {
      const want = refKey(/^\d+$/.test(removeRef) ? `${held.raw.repo}#${removeRef}` : removeRef);
      held.raw.issues = held.raw.issues.filter((x) => refKey(cardRef(x, held.raw.repo)) !== want);
    }
    if (isObj(item)) {
      const entry = { projectOwner: item.projectOwner, projectNumber: item.projectNumber, issueNumber: item.issueNumber, at: clock.now() };
      for (const k of ['repo', 'itemId', 'score', 'removed']) if (item[k] !== undefined) entry[k] = item[k];
      pending.push(entry);
    }
  }

  return { load, noteWrite, fullDue: () => fullDue() };
}
