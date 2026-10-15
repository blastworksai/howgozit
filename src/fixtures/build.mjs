// Builders for the givens of every contract check. Pure: no clock, no file, no network.
// Everything is anchored on NOW.
import { buildBoard } from '../board/model.mjs';

export const NOW = '2026-10-12T06:10:00Z';

// One constant for the data repo. Items and URLs built here use it.
// Limitation: raw({ repo: 'other/name' }) changes only the raw `repo` field; issues, items and
// URLs built earlier keep REPO. Pass the same name in `extra` of each builder when that matters.
const REPO = 'sam-life/life';
const OWNER = REPO.split('/')[0];

const EARLIER = '2026-10-01T08:00:00Z'; // fixed instant before NOW
const CLOSED_EARLIER = '2026-10-05T09:00:00Z'; // fixed instant before NOW

let counter = 1;
export function resetNumbers() {
  counter = 1;
}

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

export function settings(overrides = {}) {
  const base = {
    version: 1,
    name: 'Sam',
    timezone: 'Europe/Brussels',
    weekStart: 'monday',
    agentName: 'Agent',
    projects: [],
    focus: [],
    labels: { idea: 'idea', habitPrefix: 'habit:', ignore: ['weekly-review'] },
    habits: [],
    streak: { tokenEvery: 6, flameTiers: [1, 3, 7, 14, 21] },
    next: { count: 5 },
    refresh: { dailyAt: '05:00' },
  };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (isPlain(v) && isPlain(base[k])) base[k] = { ...base[k], ...clone(v) };
    else base[k] = clone(v);
  }
  return base;
}

export function project(number, title, items = [], extra = {}) {
  return {
    number,
    title,
    closed: false,
    url: `https://github.com/orgs/${OWNER}/projects/${number}`,
    items: items.map((it) =>
      typeof it === 'number'
        ? { type: 'Issue', repo: REPO, number: it, status: null, due: null }
        : { type: 'Issue', repo: REPO, number: null, status: null, due: null, ...it },
    ),
    ...extra,
  };
}

export function milestone(number, title, due = null, extra = {}) {
  return {
    number,
    title,
    state: 'open',
    due_on: due === null ? null : `${due}T07:00:00Z`,
    closed_at: null,
    html_url: `https://github.com/${REPO}/milestone/${number}`,
    ...extra,
  };
}

function issue(kind, extra) {
  const number = extra.number ?? counter++;
  const isPr = kind === 'pr';
  const out = {
    number,
    title: `${isPr ? 'Pull' : kind === 'idea' ? 'Idea' : 'Task'} ${number}`,
    state: 'open',
    state_reason: null,
    is_pr: isPr,
    labels: kind === 'idea' ? ['idea'] : [],
    milestone: null,
    created_at: EARLIER,
    updated_at: EARLIER,
    closed_at: null,
    html_url: `https://github.com/${REPO}/${isPr ? 'pull' : 'issues'}/${number}`,
    ...extra,
    number,
  };
  if (extra.state === 'closed') {
    if (!('closed_at' in extra)) out.closed_at = CLOSED_EARLIER;
    if (!('state_reason' in extra)) out.state_reason = 'completed';
  }
  return out;
}

export function task(extra = {}) {
  return issue('task', extra);
}
export function idea(extra = {}) {
  return issue('idea', extra);
}
export function pr(extra = {}) {
  return issue('pr', extra);
}

export function checkin(habitId, date, { closed = true, closedAt, title } = {}) {
  const base = issue('task', {
    title: title ?? `${habitId} · ${date}`,
    labels: [`habit:${habitId}`],
    state: closed ? 'closed' : 'open',
    closed_at: closed ? (closedAt ?? `${date}T10:00:00Z`) : null,
    state_reason: closed ? 'completed' : null,
    created_at: `${date}T08:00:00Z`,
    updated_at: closed ? (closedAt ?? `${date}T10:00:00Z`) : `${date}T08:00:00Z`,
  });
  return base;
}

export function raw({ issues = [], milestones = [], projects = [], ...extra } = {}) {
  return {
    fetchedAt: NOW,
    partial: { issues: false, items: false },
    repo: REPO,
    repoPrivate: true,
    ownerType: 'organization',
    issues,
    milestones,
    projects,
    ...extra,
  };
}

export function state(overrides = {}) {
  return { brief: null, calendar: null, inbox: null, log: null, proposals: null, ...overrides };
}

export function board(input = {}) {
  return buildBoard({
    raw: input.raw ?? raw(),
    settings: input.settings ?? settings(),
    theme: input.theme,
    state: input.state ?? state(),
    now: input.now ?? NOW,
    run: input.run,
  });
}
