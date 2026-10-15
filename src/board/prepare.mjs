// prepare: turns the six model inputs into the context every stage reads (contract R1, R2, R3, R5, R46, R92).
// Pure: no clock, no file, no network, no environment.
import { addDays, isDate, isZone, monthEnd, monthStart, todayIn, weekStart } from './days.mjs';
import { DEFAULT_THEME, isHexColor, withDefaults } from './shape-settings.mjs';
import { addProjects } from './core-projects.mjs';
import { addMilestones } from './core-milestones.mjs';
import { cardRef, refKey, shortRef as shortRefOf } from './model/snapshot.mjs';

const EPOCH = '1970-01-01T00:00:00Z';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const FONT_RE = /^[A-Za-z0-9 ]{1,60}$/;
const KEYS = ['brief', 'calendar', 'inbox', 'log', 'proposals'];

function clone(v) {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

// ---- empty parts: shared by the stubs and by the failure path of model.mjs ----------------------------------
function heatmapEmpty(ctx) {
  const first = weekStart(ctx.today, ctx.settings?.weekStart === 'sunday' ? 'sunday' : 'monday');
  const weeks = [];
  for (let w = 0; w < 12; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(first, (w - 11) * 7 + d);
      const future = date > ctx.today;
      week.push({ date, count: future ? null : 0, level: future ? null : 0 });
    }
    weeks.push(week);
  }
  return weeks;
}

export const EMPTY = {
  meta: (ctx) => ({
    meta: {
      generatedAt: ctx.now, today: ctx.today, timezone: ctx.tz, name: '', greeting: 'Good morning', weekNumber: 1,
      agentName: 'Agent', repoUrl: 'https://github.com/', stale: null, readOnly: false, sources: [], warnings: [],
    },
  }),
  projects: () => ({ projects: [], standalone: { count: 0, items: [] }, sortTargets: [] }),
  timeline: (ctx) => ({
    timeline: {
      start: monthStart(addDays(ctx.today, -14)),
      end: monthEnd(addDays(ctx.today, 28)),
      today: ctx.today, lanes: [], other: [],
    },
  }),
  focus: () => ({ focus: { projects: [], proposal: null } }),
  next: () => ({ next: [] }),
  ideas: () => ({ ideas: { count: 0, shown: 0, items: [] } }),
  habits: () => ({ habits: [] }),
  extras: (ctx) => ({ heatmap: { weeks: heatmapEmpty(ctx) }, season: null }),
  panels: () => ({ panels: { brief: null, calendar: null, inbox: null, log: null } }),
};

// ---- theme ----------------------------------------------------------------------------------------------------
function resolveTheme(t) {
  const given = isObj(t) ? t : {};
  const colors = {};
  const gc = isObj(given.colors) ? given.colors : {};
  for (const [k, d] of Object.entries(DEFAULT_THEME.colors)) colors[k] = isHexColor(gc[k]) ? gc[k] : d;
  let projectColors = Array.isArray(given.projectColors) ? given.projectColors.filter((c) => isHexColor(c)) : [];
  if (projectColors.length === 0) projectColors = DEFAULT_THEME.projectColors.slice();
  const gf = isObj(given.fonts) ? given.fonts : {};
  const fonts = {
    source: gf.source === 'google' || gf.source === 'system' ? gf.source : DEFAULT_THEME.fonts.source,
  };
  for (const k of ['heading', 'body', 'mono']) {
    fonts[k] = isStr(gf[k]) && FONT_RE.test(gf[k]) && gf[k].trim() !== '' ? gf[k] : DEFAULT_THEME.fonts[k];
  }
  const radius = isInt(given.radius) && given.radius >= 0 && given.radius <= 40 ? given.radius : DEFAULT_THEME.radius;
  return { colors, projectColors, fonts, radius };
}

// ---- rows -----------------------------------------------------------------------------------------------------
function issueRowOk(r) {
  return (
    isObj(r) && isInt(r.number) && isStr(r.title) && isStr(r.state) && typeof r.is_pr === 'boolean' &&
    Array.isArray(r.labels) && r.labels.every(isStr) &&
    (r.milestone === null || isInt(r.milestone)) &&
    isStr(r.created_at) && (r.closed_at === null || isStr(r.closed_at)) && isStr(r.html_url)
  );
}

function milestoneRowOk(r) {
  return (
    isObj(r) && isInt(r.number) && isStr(r.title) && isStr(r.state) &&
    (r.due_on === null || isStr(r.due_on)) && (r.closed_at === null || isStr(r.closed_at)) && isStr(r.html_url)
  );
}

const norm = (s) => String(s).trim().toLowerCase();

export function prepare({ raw, settings, theme, state, now, run } = {}) {
  const counts = {};
  const warn = (code, n = 1) => {
    counts[code] = (counts[code] || 0) + n;
  };

  const cfg = withDefaults(isObj(settings) ? settings : {}, warn);
  const tz = isZone(cfg.timezone) ? cfg.timezone : 'UTC';
  cfg.timezone = tz;

  let nowIso = EPOCH;
  if (now instanceof Date) {
    if (!Number.isNaN(now.getTime())) nowIso = now.toISOString();
  } else if (isStr(now) && todayIn(tz, now) !== null) {
    nowIso = now;
  }
  const today = todayIn(tz, nowIso);

  const rawObj = isObj(raw) ? raw : {};
  const st = isObj(state) ? state : {};
  const stateOut = {};
  for (const k of KEYS) stateOut[k] = st[k] === undefined ? null : st[k];
  // The agent's calendar file kept beside iCloud's answer when calendar.includeFile is on (R110); absent otherwise.
  if (st.calendarFile !== undefined && st.calendarFile !== null) stateOut.calendarFile = st.calendarFile;

  const runOut = isObj(run) ? run : { stale: null, readOnly: false, warnings: [] };

  // R2 inputs: labels compared trimmed and case-insensitively.
  const ignore = new Set((cfg.labels.ignore || []).map(norm));
  const ideaLabel = norm(cfg.labels.idea);
  const prefix = norm(cfg.labels.habitPrefix);
  const habitIds = new Set(
    (Array.isArray(cfg.habits) ? cfg.habits : []).filter((h) => isObj(h) && isStr(h.id)).map((h) => h.id),
  );

  const dataRepo = isStr(rawObj.repo) ? rawObj.repo : '';
  // CP6 (R135): with the Ideas Project in the settings, an idea is an Issue item of its role row, not a label.
  const rawProjects = Array.isArray(rawObj.projects) ? rawObj.projects : [];
  const roleRow = (role) => rawProjects.find((p) => isObj(p) && p.role === role) ?? null;
  const itemRefOf = (it) => (isObj(it) && isStr(it.ref) && it.ref !== '' ? it.ref
    : isObj(it) && isStr(it.repo) && it.repo !== '' && isInt(it.number) ? `${it.repo}#${it.number}`
    : isObj(it) && isInt(it.number) ? `${dataRepo}#${it.number}` : null);
  const roleItems = (role) => {
    const map = new Map();
    const row = roleRow(role);
    for (const it of Array.isArray(row?.items) ? row.items : []) {
      if (!isObj(it) || it.type !== 'Issue') continue;
      const r = itemRefOf(it);
      if (r !== null && !map.has(refKey(r))) map.set(refKey(r), it);
    }
    return map;
  };
  const ideaItems = cfg.ideas !== undefined ? roleItems('ideas') : null;
  const habitItems = roleItems('habits');
  // Refs live beside the issue objects, never on them, so no stage can spread one into the board.
  const refs = new Map();
  const issueByRef = new Map();
  const issues = [];
  const tasks = [];
  const ideas = [];
  const checkins = [];
  const checkinHabit = new Map();
  const scoreWarned = new Set();
  for (const row of Array.isArray(rawObj.issues) ? rawObj.issues : []) {
    if (isObj(row) && row.is_pr === true) continue; // R1: silently, before anything else
    if (!issueRowOk(row)) {
      warn('row-skipped');
      continue;
    }
    // R47, R129: a row that carries a repo is counted once by its ref; a repeat is dropped silently.
    const carriesRepo = isStr(row.repo) && row.repo !== '';
    if (carriesRepo && issueByRef.has(refKey(cardRef(row, dataRepo)))) continue;
    const issue = clone(row);
    delete issue.blockedBy; // R133: the count is only a lead for the reader; the list below is what the model uses
    const labels = issue.labels.map(norm);
    // B4 (R37, R38): a check-in is a data-repo issue; a card of another repo with a habit label is not one.
    const foreignRepo = carriesRepo && dataRepo !== '' && row.repo.toLowerCase() !== dataRepo.toLowerCase();
    const habitLabel = foreignRepo ? undefined : labels.find((l) => l.startsWith(prefix));
    if (labels.some((l) => ignore.has(l))) issue.kind = 'ignored';
    else if (habitLabel !== undefined) issue.kind = 'checkin';
    else if (ideaItems !== null ? ideaItems.has(refKey(cardRef(issue, dataRepo))) : labels.includes(ideaLabel)) issue.kind = 'idea';
    else issue.kind = 'task';
    issues.push(issue);
    const ref = cardRef(issue, dataRepo);
    refs.set(issue, ref);
    if (carriesRepo) delete issue.ref; // the ref lives in `refs`; the clone keeps `repo` for the milestone and ref joins
    issueByRef.set(refKey(ref), issue);
    if (issue.kind === 'task') tasks.push(issue);
    else if (issue.kind === 'idea') ideas.push(issue);
    else if (issue.kind === 'checkin') {
      const habitId = habitLabel.slice(prefix.length).trim().toLowerCase();
      if (!habitIds.has(habitId)) continue; // R3: a retired habit is normal
      const at = issue.title.lastIndexOf(' · ');
      const date = at >= 0 ? issue.title.slice(at + 3) : '';
      if (!isDate(date)) {
        warn('checkin-unreadable');
        continue;
      }
      checkinHabit.set(issue, habitId);
      checkins.push({ issue, habitId, date });
    }
  }

  const rawMilestones = [];
  for (const row of Array.isArray(rawObj.milestones) ? rawObj.milestones : []) {
    if (!milestoneRowOk(row)) {
      warn('row-skipped');
      continue;
    }
    const m = clone(row);
    if (!isStr(m.repo) || m.repo === '') m.repo = dataRepo;
    rawMilestones.push(m);
  }

  // R132: the modes the settings name, in order; null when none (the off path).
  const modeList = Array.isArray(cfg.modes)
    ? cfg.modes.map((name, i) => ({ n: i + 1, name, key: norm(name) }))
    : null;
  const modesOf = (issue) => {
    if (modeList === null) return null;
    const have = new Set((Array.isArray(issue?.labels) ? issue.labels : []).map(norm));
    return modeList.filter((m) => have.has(m.key)).map((m) => ({ name: m.name, n: m.n }));
  };

  const ctx = {
    now: nowIso, today, tz,
    settings: cfg, theme: resolveTheme(theme), state: stateOut, run: runOut,
    warn, warnCounts: counts,
    raw: rawObj,
    issues, tasks, ideas, checkins,
    rawMilestones,
    issueByRef,
    refOf: (issue) => refs.get(issue) ?? cardRef(issue, dataRepo),
    shortRef: (issue) => shortRefOf(issue, dataRepo),
    modeList, modesOf,
    roleRow,
    ideaItemOf: (issue) => ideaItems?.get(refKey(refs.get(issue) ?? cardRef(issue, dataRepo))) ?? null,
    habitItemOf: (issue) => habitItems.get(refKey(refs.get(issue) ?? cardRef(issue, dataRepo))) ?? null,
    scoreOf: (issue) => {
      const habitId = checkinHabit.get(issue);
      const h = (Array.isArray(cfg.habits) ? cfg.habits : []).find((x) => isObj(x) && x.id === habitId);
      const sc = h?.score;
      if (!isObj(sc)) return null;
      const item = habitItems.get(refKey(refs.get(issue) ?? cardRef(issue, dataRepo)));
      if (!item || item.score === null || item.score === undefined) return null;
      if (typeof item.score === 'number' && Number.isFinite(item.score) && item.score >= sc.min && item.score <= sc.max) return item.score;
      if (!scoreWarned.has(issue)) {
        scoreWarned.add(issue);
        warn('score-invalid');
      }
      return null;
    },
    // R27, R134: the open blockers the reader found for this issue; [] when none or malformed entries only.
    waitingOn: (issue) =>
      Array.isArray(issue?.waitingOn) ? issue.waitingOn.filter((b) => isObj(b) && isStr(b.ref)) : [],
    // Parts the later core jobs fill; empty until then.
    shown: [],
    projectsOf: () => [],
    itemOf: () => null,
    progress: () => ({ done: 0, total: 0, pct: 0, empty: true }),
    milestones: [],
    milestoneOf: () => null,
    dueOf: () => null,
  };

  // ---- HOOK POINT (later jobs) ------------------------------------------------------------------------------
  // core-projects.mjs and core-milestones.mjs will be imported above and called here, in this order, assigning
  // onto ctx (shown, projectsOf, itemOf, progress, then milestones, milestoneOf, dueOf):
  //   addProjects(ctx, rawObj);
  //   addMilestones(ctx, rawObj);
  // They read ctx.raw (project rows) and ctx.rawMilestones (milestone rows already validated above).
  addProjects(ctx, rawObj);
  addMilestones(ctx, rawObj);
  // -----------------------------------------------------------------------------------------------------------
  return ctx;
}
