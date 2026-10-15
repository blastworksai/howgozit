// Plans the copy of a GitHub board into Notion. Reads only; writes nothing. Built to reference/notion-native/interface.md, sections 2 and 6.1 (contract R153).
import { createHash } from 'node:crypto';
import { readAll } from '../../board/github/read.mjs';
import { dateIn, isDate } from '../../board/days.mjs';

const SEP = ' · ';

// The setup palette, name -> hex; copied from board/notion/read.mjs:21-24 (PALETTE, not exported there). `default` has no entry.
const PALETTE = {
  green: '#0e8a16', purple: '#5319e7', yellow: '#fbca04', orange: '#d93f0b', blue: '#1d76db',
  red: '#b60205', gray: '#5d6d7e', brown: '#8a6d3b', pink: '#c2185b',
};

// GitHub Status name -> Notion Status name (interface §6.1).
const STATUS_MAP = { Todo: 'Not started', 'In Progress': 'In progress', Done: 'Done' };

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const lower = (s) => String(s).toLowerCase();
const sha = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const refOf = (repo, n) => `${repo}#${n}`;

// ---------- reading ----------

export async function readSource({ owners, repo, now }) {
  const refusals = [];
  const { raw, texts, warnings } = await readAll(owners.default, { repo, full: true, now, httpFor: (o) => owners.forOwner(o) });
  const codes = (Array.isArray(warnings) ? warnings : []).map((w) => w.code);
  if (codes.length) refusals.push(`GitHub was not read completely (${[...new Set(codes)].join(', ')}).`);
  const partial = isObj(raw.partial) ? Object.keys(raw.partial).filter((k) => raw.partial[k]) : [];
  if (partial.length) refusals.push(`GitHub returned more than the board reads (${partial.join(', ')}).`);

  let settings = null;
  try {
    settings = JSON.parse(texts.settings);
    if (!isObj(settings)) settings = null;
  } catch {
    settings = null;
  }
  if (settings === null) refusals.push('The board settings could not be read from the data repository.');

  const checkins = [];
  const habits = settings && Array.isArray(settings.habits) ? settings.habits : [];
  for (const h of habits) {
    if (!isObj(h) || typeof h.id !== 'string' || h.id === '') continue;
    const label = encodeURIComponent(`habit:${h.id}`);
    const page = await owners.default.paged(`/repos/${repo}/issues?state=all&labels=${label}&per_page=100`, { maxPages: 50 });
    if (page.partial) refusals.push(`The check-ins of habit "${h.id}" came back incomplete.`);
    for (const i of page.items || []) {
      if (!isObj(i) || i.pull_request) continue;
      checkins.push({
        habit: h.id, repo, number: i.number, title: typeof i.title === 'string' ? i.title : '',
        state: i.state === 'closed' ? 'closed' : 'open', closed_at: typeof i.closed_at === 'string' ? i.closed_at : null,
      });
    }
  }

  // Scores from the Habits role project's items, by lower-cased repo#number.
  const scores = {};
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    if (!isObj(p) || p.role !== 'habits') continue;
    for (const it of p.items || []) {
      if (isObj(it) && it.repo && Number.isInteger(it.number) && typeof it.score === 'number') scores[lower(refOf(it.repo, it.number))] = it.score;
    }
  }

  return { repo, raw, texts, settings, checkins, scores, refusals };
}

// ---------- planning ----------

export function buildCopyPlan(source, notionIds) {
  const refusals = [...(Array.isArray(source.refusals) ? source.refusals : [])];
  const notes = [];
  const raw = isObj(source.raw) ? source.raw : {};
  const texts = isObj(source.texts) ? source.texts : {};
  const settings = isObj(source.settings) ? source.settings : {};
  const repo = source.repo;
  const dataOwner = String(repo).split('/')[0];
  const tz = typeof settings.timezone === 'string' ? settings.timezone : 'UTC';
  const modes = Array.isArray(settings.modes) ? settings.modes.filter((m) => typeof m === 'string' && m.trim() !== '') : [];

  // ---- projects ----
  const rawProjects = Array.isArray(raw.projects) ? raw.projects.filter(isObj) : [];
  const projects = [];
  const listed = []; // { key, plan key, p (raw project), home, items }
  for (const s of Array.isArray(settings.projects) ? settings.projects : []) {
    if (!isObj(s) || typeof s.key !== 'string') continue;
    const owner = typeof s.owner === 'string' && s.owner !== '' ? s.owner : dataOwner;
    const p = rawProjects.find((r) => r.role === undefined && r.number === s.number && lower(r.owner ?? dataOwner) === lower(owner));
    if (!p) { notes.push(`Project "${s.key}" was not found on GitHub and is left out.`); continue; }
    const key = `project:${s.key}`;
    projects.push({ key, title: p.title, status: p.closed ? 'Done' : 'In progress' });
    listed.push({ settingsKey: s.key, key, title: p.title, home: typeof s.home === 'string' ? s.home : null, items: Array.isArray(p.items) ? p.items : [] });
  }

  // ---- issue lookup ----
  const issues = new Map(); // lower repo#n -> { row, repo }
  for (const r of Array.isArray(raw.issues) ? raw.issues : []) {
    if (!isObj(r) || !Number.isInteger(r.number)) continue;
    const rrepo = typeof r.repo === 'string' ? r.repo : repo;
    issues.set(lower(refOf(rrepo, r.number)), { row: r, repo: rrepo });
  }
  const habitIds = new Set((Array.isArray(settings.habits) ? settings.habits : []).filter(isObj).map((h) => h.id));
  const isCheckin = (row) => (row.labels || []).some((l) => typeof l === 'string' && l.toLowerCase().startsWith('habit:') && habitIds.has(l.slice(6)));

  const ideasProject = rawProjects.find((p) => p.role === 'ideas');
  const ideaRefs = new Set();
  const ideas = [];
  if (ideasProject) {
    for (const it of ideasProject.items || []) {
      if (!isObj(it) || it.type !== 'Issue' || !it.repo || !Number.isInteger(it.number)) continue;
      ideaRefs.add(lower(refOf(it.repo, it.number)));
      const hit = issues.get(lower(refOf(it.repo, it.number)));
      if (!hit || hit.row.state !== 'open' || hit.row.is_pr) continue;
      ideas.push({ key: `idea:${hit.repo}#${it.number}`, title: hit.row.title });
    }
  }

  // ---- tasks ----
  const tasks = [];
  const taskByRef = new Map(); // lower ref -> task
  const cards = new Map(); // lower ref -> { repo, number, items: [{ project, item }] }
  for (const pr of listed) {
    for (const it of pr.items) {
      if (!isObj(it) || it.type !== 'Issue' || !it.repo || !Number.isInteger(it.number)) continue;
      const k = lower(refOf(it.repo, it.number));
      if (!cards.has(k)) cards.set(k, { items: [] });
      cards.get(k).items.push({ project: pr, item: it });
    }
  }
  let noStatus = 0;
  const unknownStatuses = new Set();
  for (const [k, c] of cards) {
    const hit = issues.get(k);
    if (!hit || hit.row.state !== 'open' || hit.row.is_pr || isCheckin(hit.row) || ideaRefs.has(k)) continue;
    let status = null;
    for (const { item } of c.items) {
      if (item.status === null || item.status === undefined) continue;
      if (!Object.prototype.hasOwnProperty.call(STATUS_MAP, item.status)) unknownStatuses.add(item.status);
      else if (status === null) status = STATUS_MAP[item.status];
    }
    if (status === null) { status = 'Not started'; if (!c.items.some(({ item }) => item.status)) noStatus++; }
    const labels = new Set((hit.row.labels || []).map(lower));
    const due = c.items.map(({ item }) => item.due).find((d) => typeof d === 'string' && d !== '') ?? null;
    const task = {
      key: `task:${hit.repo}#${hit.row.number}`,
      title: hit.row.title,
      status,
      due,
      tags: modes.filter((m) => labels.has(lower(m))),
      projectKeys: listed.filter((pr) => c.items.some((x) => x.project === pr)).map((pr) => pr.key),
      goalKey: null,
      _repo: hit.repo,
      _milestone: Number.isInteger(hit.row.milestone) ? hit.row.milestone : null,
      _waiting: Array.isArray(hit.row.waitingOn) ? hit.row.waitingOn : [],
    };
    tasks.push(task);
    taskByRef.set(k, task);
  }
  for (const name of [...unknownStatuses].sort()) refusals.push(`Status "${name}" has no Notion match.`);
  if (noStatus) notes.push(`${noStatus} card${noStatus === 1 ? ' has' : 's have'} no Status on GitHub and ${noStatus === 1 ? 'is' : 'are'} copied as Not started.`);

  // ---- goals ----
  const milestones = new Map(); // lower repo#n -> { repo, m }
  for (const m of Array.isArray(raw.milestones) ? raw.milestones : []) {
    if (!isObj(m) || !Number.isInteger(m.number)) continue;
    const mrepo = typeof m.repo === 'string' ? m.repo : repo;
    milestones.set(lower(refOf(mrepo, m.number)), { repo: mrepo, m });
  }
  const goals = [];
  for (const [k, { repo: mrepo, m }] of milestones) {
    const named = tasks.filter((t) => t._milestone === m.number && lower(t._repo) === lower(mrepo));
    if (m.state === 'closed' && named.length === 0) continue;
    const goal = { key: `goal:${mrepo}#${m.number}`, title: m.title, due: typeof m.due_on === 'string' ? m.due_on.slice(0, 10) : null, done: m.state === 'closed', projectKeys: [] };
    const add = (key) => { if (!goal.projectKeys.includes(key)) goal.projectKeys.push(key); };
    // A data-repo milestone titled "<Project title> · <goal>" takes that project and loses the prefix.
    let prefixed = null;
    if (lower(mrepo) === lower(repo)) {
      const at = m.title.indexOf(SEP);
      if (at > 0) {
        const head = m.title.slice(0, at).trim().toLowerCase();
        prefixed = listed.find((pr) => pr.title.trim().toLowerCase() === head || pr.settingsKey.toLowerCase() === head) || null;
        if (prefixed && m.title.slice(at + SEP.length).trim() !== '') goal.title = m.title.slice(at + SEP.length).trim();
        else prefixed = null;
      }
    }
    for (const t of named) for (const pk of t.projectKeys) add(pk);
    if (prefixed) add(prefixed.key);
    if (goal.projectKeys.length === 0) {
      const homes = listed.filter((pr) => pr.home && lower(pr.home) === lower(mrepo));
      if (homes.length === 1) add(homes[0].key);
      else notes.push(`Goal "${m.title}" (${refOf(mrepo, m.number)}) has no copied card and no single project; it is copied without a project.`);
    }
    goal.projectKeys = listed.map((pr) => pr.key).filter((pk) => goal.projectKeys.includes(pk));
    goals.push(goal);
  }
  const goalKeys = new Set(goals.map((g) => g.key));
  for (const t of tasks) {
    if (t._milestone !== null && goalKeys.has(`goal:${t._repo}#${t._milestone}`)) t.goalKey = `goal:${t._repo}#${t._milestone}`;
  }

  // ---- blockers ----
  const blockers = [];
  for (const t of tasks) {
    const blockedByKeys = [];
    for (const w of t._waiting) {
      const other = isObj(w) && typeof w.ref === 'string' ? taskByRef.get(lower(w.ref)) : null;
      if (other && other.key !== t.key && !blockedByKeys.includes(other.key)) blockedByKeys.push(other.key);
    }
    if (blockedByKeys.length) blockers.push({ key: `blocker:${t.key}`, taskKey: t.key, blockedByKeys });
  }
  for (const t of tasks) { delete t._repo; delete t._milestone; delete t._waiting; }

  // ---- check-ins ----
  const checkins = [];
  let skipped = 0;
  for (const c of Array.isArray(source.checkins) ? source.checkins : []) {
    const at = c.title.lastIndexOf(SEP);
    const date = at >= 0 ? c.title.slice(at + SEP.length).trim() : '';
    if (!isDate(date)) { skipped++; continue; }
    // board/stages/habits.mjs:33-34: done for a day = closed, and closed on that day in the board's timezone
    const done = c.state === 'closed' && typeof c.closed_at === 'string' && dateIn(tz, c.closed_at) === date;
    const score = source.scores && Object.prototype.hasOwnProperty.call(source.scores, lower(refOf(c.repo, c.number))) ? source.scores[lower(refOf(c.repo, c.number))] : null;
    checkins.push({ key: `checkin:${c.repo}#${c.number}`, title: c.title, habit: c.habit, date, done, score });
  }
  if (skipped) notes.push(`${skipped} check-in${skipped === 1 ? ' has' : 's have'} no readable date and ${skipped === 1 ? 'is' : 'are'} skipped.`);

  // ---- tag colours ----
  const tagColours = [];
  const labelColors = isObj(raw.labelColors) ? raw.labelColors : {};
  for (const m of modes) {
    const hex = labelColors[lower(m)];
    if (typeof hex !== 'string') continue;
    const name = Object.keys(PALETTE).find((n) => PALETTE[n] === lower(hex));
    if (name) tagColours.push({ name: m, color: name });
    else notes.push(`The colour of "${m}" (${lower(hex)}) is not in the palette; its Notion option keeps its colour.`);
  }

  // ---- config files, byte for byte ----
  const configFiles = [];
  if (typeof texts.theme === 'string') configFiles.push({ path: 'theme.json', text: texts.theme });
  const state = isObj(texts.state) ? texts.state : {};
  for (const name of Object.keys(state).sort()) if (typeof state[name] === 'string') configFiles.push({ path: `state/${name}.json`, text: state[name] });

  // ---- settingsNext (interface §2); project numbers are filled at apply time ----
  const destination = isObj(notionIds)
    ? { projects: notionIds.projects, tasks: notionIds.tasks, goals: notionIds.goals, habitLog: notionIds.habitLog }
    : null;
  const settingsNext = { ...settings };
  if (destination) settingsNext.notion = { ...destination }; // the Notion reader needs the four data source ids (interface §2)
  settingsNext.projects = listed.map((pr) => ({ key: pr.settingsKey, owner: 'notion', number: null }));
  if (settings.ideas !== undefined) settingsNext.ideas = { owner: 'notion', number: 998 };
  if (settings.habitsProject !== undefined) settingsNext.habitsProject = { owner: 'notion', number: 999 };
  if (Array.isArray(settings.habits)) {
    settingsNext.habits = settings.habits.map((h) => {
      if (!isObj(h) || isDate(h.start)) return h;
      const dates = checkins.filter((c) => c.habit === h.id).map((c) => c.date).sort();
      return dates.length ? { ...h, start: dates[0] } : h;
    });
  }

  projects.sort(byKey); goals.sort(byKey); tasks.sort(byKey); blockers.sort(byKey); ideas.sort(byKey);
  checkins.sort((a, b) => (a.habit < b.habit ? -1 : a.habit > b.habit ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : byKey(a, b)));

  const plan = {
    ok: refusals.length === 0, refusals, notionIds: destination, projects, goals, tasks, blockers, ideas, checkins, tagColours, configFiles, settingsNext,
    counts: { projects: projects.length, goals: goals.length, tasks: tasks.length, blockers: blockers.length, ideas: ideas.length, checkins: checkins.length },
    notes,
  };
  plan.digest = copyDigest(plan);
  return plan;
}

// sha256 of the canonical JSON of the six lists, the tag colours, the settings to be written, the four destination ids and the config files (path + content hash). No timestamps.
export function copyDigest(plan) {
  const body = {
    projects: plan.projects, goals: plan.goals, tasks: plan.tasks, blockers: plan.blockers, ideas: plan.ideas, checkins: plan.checkins,
    tagColours: plan.tagColours,
    // the settings the copy will write (project numbers are filled at apply, so they are not part of what was reviewed) and where it writes
    settingsNext: plan.settingsNext ? { ...plan.settingsNext, projects: (plan.settingsNext.projects || []).map((p) => ({ ...p, number: null })) } : null,
    notionIds: plan.notionIds ?? null,
    configFiles: (plan.configFiles || []).map((f) => ({ path: f.path, sha: sha(f.text) })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

// Human summary: counts, notes, refusals. Never a token, never a body.
export function planLines(plan) {
  const c = plan.counts || {};
  const lines = [];
  lines.push(`Copy plan: ${c.projects} project${c.projects === 1 ? '' : 's'}, ${c.goals} goal${c.goals === 1 ? '' : 's'}, ${c.tasks} card${c.tasks === 1 ? '' : 's'}, ${c.blockers} blocker${c.blockers === 1 ? '' : 's'}, ${c.ideas} idea${c.ideas === 1 ? '' : 's'}, ${c.checkins} check-in${c.checkins === 1 ? '' : 's'}.`);
  const tagged = (plan.tasks || []).filter((t) => t.tags.length).length;
  lines.push(`${tagged} card${tagged === 1 ? ' carries' : 's carry'} a mode tag; ${(plan.tagColours || []).length} tag colour${(plan.tagColours || []).length === 1 ? '' : 's'} to set; ${(plan.configFiles || []).length} config file${(plan.configFiles || []).length === 1 ? '' : 's'} to copy.`);
  for (const n of plan.notes || []) lines.push(`Note: ${n}`);
  for (const r of plan.refusals || []) lines.push(`Refused: ${r}`);
  lines.push(plan.ok ? `Plan digest ${String(plan.digest).slice(0, 12)}.` : 'The plan is refused; nothing can be applied.');
  return lines;
}
