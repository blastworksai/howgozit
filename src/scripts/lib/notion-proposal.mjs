// The Notion half of the starter-board setup (contract R156). Checks a proposal, lists what it would create,
// and writes it into the four Notion tables resumably, then writes the starter board.config.json.
// A record row per plan key is saved before and after every create, so a repeated or resumed run never makes a second row.
// Every Notion write goes through `http` after `pace()`. The proposal has the shape of references/setup-proposal.md without owner and repo.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkSettings, isKnownZone } from '../../board/shape-settings.mjs';
import { writeJsonAtomic } from './migrate-io.mjs';

export const ROWS_FILE = '.howgozit-notion-rows.json';
export const SETTINGS_FILE = 'board.config.json';
export const DEFAULT_MODES = ['DO', 'THINK', 'REVIEW', 'LAUNCH'];
export const BOUND = 'The starter-board record was made for other Notion data sources; move it away or use the tables it was made for.';
const IDS = ['projects', 'tasks', 'goals', 'habitLog'];
const KEY_RE = /^[a-z0-9-]{1,30}$/;
const SEP = ' · ';
const TOP = ['name', 'timezone', 'projects', 'standalone', 'habits', 'focus', 'modes'];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isText = (x) => typeof x === 'string' && x.trim() !== '';

function realDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function unknownKeys(obj, allowed, at, errors) {
  for (const k of Object.keys(obj)) {
    if ((k === 'owner' || k === 'repo') && at === 'proposal') errors.push(`${k}: a Notion proposal has no owner or repo; remove it.`);
    else if (!allowed.includes(k)) errors.push(`${at}: "${k}" is not a field setup knows.`);
  }
}

function checkTask(t, at, errors, titles, full) {
  if (!isObj(t)) { errors.push(`${at}: must be an object.`); return; }
  unknownKeys(t, full ? ['title', 'milestone', 'due'] : ['title'], at, errors);
  if (!isText(t.title)) errors.push(`${at}.title: must be a non-empty text.`);
  else if (t.title.includes(SEP)) errors.push(`${at}.title: must not contain " · ".`);
  else if (titles.has(t.title)) errors.push(`${at}.title: "${t.title}" is used twice; task titles must be different.`);
  else titles.add(t.title);
  if (full && t.due !== undefined && !realDate(t.due)) errors.push(`${at}.due: must be a real date written YYYY-MM-DD.`);
  if (full && t.milestone !== undefined && !isText(t.milestone)) errors.push(`${at}.milestone: must be a non-empty text.`);
}

export function validateNotionProposal(p) {
  const errors = [];
  if (!isObj(p)) return { ok: false, errors: ['proposal: must be an object.'] };
  unknownKeys(p, TOP, 'proposal', errors);
  for (const k of ['name', 'timezone']) if (!isText(p[k])) errors.push(`${k}: must be a non-empty text.`);
  if (isText(p.timezone) && !isKnownZone(p.timezone)) errors.push('timezone: must be a time zone the runtime knows, such as Europe/Brussels.');

  const keys = new Set();
  const titles = new Set();
  const taskTitles = new Set();
  if (p.projects !== undefined && !Array.isArray(p.projects)) errors.push('projects: must be a list.');
  else {
    (p.projects || []).forEach((pr, i) => {
      const at = `projects[${i}]`;
      if (!isObj(pr)) { errors.push(`${at}: must be an object.`); return; }
      unknownKeys(pr, ['key', 'title', 'milestones', 'tasks'], at, errors);
      if (typeof pr.key !== 'string' || !KEY_RE.test(pr.key)) errors.push(`${at}.key: must be 1 to 30 lower-case letters, digits or dashes.`);
      else if (keys.has(pr.key)) errors.push(`${at}.key: "${pr.key}" is used twice.`);
      else keys.add(pr.key);
      if (!isText(pr.title)) errors.push(`${at}.title: must be a non-empty text.`);
      else if (pr.title.includes(SEP)) errors.push(`${at}.title: must not contain " · ".`);
      else if (titles.has(pr.title)) errors.push(`${at}.title: "${pr.title}" is used twice.`);
      else titles.add(pr.title);
      const ms = new Set();
      if (pr.milestones !== undefined && !Array.isArray(pr.milestones)) errors.push(`${at}.milestones: must be a list.`);
      else (pr.milestones || []).forEach((m, j) => {
        const mat = `${at}.milestones[${j}]`;
        if (!isObj(m)) { errors.push(`${mat}: must be an object.`); return; }
        unknownKeys(m, ['title', 'due'], mat, errors);
        if (!isText(m.title)) errors.push(`${mat}.title: must be a non-empty text.`);
        else if (m.title.includes(SEP)) errors.push(`${mat}.title: must not contain " · ".`);
        else if (ms.has(m.title)) errors.push(`${mat}.title: "${m.title}" is used twice in this project.`);
        else ms.add(m.title);
        if (m.due !== undefined && !realDate(m.due)) errors.push(`${mat}.due: must be a real date written YYYY-MM-DD.`);
      });
      if (pr.tasks !== undefined && !Array.isArray(pr.tasks)) errors.push(`${at}.tasks: must be a list.`);
      else (pr.tasks || []).forEach((t, j) => {
        const tat = `${at}.tasks[${j}]`;
        checkTask(t, tat, errors, taskTitles, true);
        if (isObj(t) && isText(t.milestone) && !ms.has(t.milestone)) errors.push(`${tat}.milestone: "${t.milestone}" is not a milestone of this project.`);
      });
    });
  }
  if (p.standalone !== undefined && !Array.isArray(p.standalone)) errors.push('standalone: must be a list.');
  else (p.standalone || []).forEach((t, i) => checkTask(t, `standalone[${i}]`, errors, taskTitles, false));

  const ids = new Set();
  if (p.habits !== undefined && !Array.isArray(p.habits)) errors.push('habits: must be a list.');
  else (p.habits || []).forEach((h, i) => {
    const at = `habits[${i}]`;
    if (!isObj(h)) { errors.push(`${at}: must be an object.`); return; }
    unknownKeys(h, ['id', 'title', 'project', 'score'], at, errors);
    if (typeof h.id !== 'string' || !KEY_RE.test(h.id)) errors.push(`${at}.id: must be 1 to 30 lower-case letters, digits or dashes.`);
    else if (ids.has(h.id)) errors.push(`${at}.id: "${h.id}" is used twice.`);
    else ids.add(h.id);
    if (!isText(h.title)) errors.push(`${at}.title: must be a non-empty text.`);
    else if (h.title.includes(SEP)) errors.push(`${at}.title: must not contain " · ".`);
    if (h.score !== undefined) {
      const sc = h.score;
      if (!isObj(sc) || Object.keys(sc).some((k) => k !== 'min' && k !== 'max') || !Number.isInteger(sc.min) || !Number.isInteger(sc.max) || sc.min < 1 || sc.min >= sc.max || sc.max > 10) {
        errors.push(`${at}.score: must be { "min": whole, "max": whole } with 1 <= min < max <= 10.`);
      }
    }
    if (h.project !== undefined && (typeof h.project !== 'string' || !keys.has(h.project))) errors.push(`${at}.project: must be a project key from this proposal.`);
  });
  if (p.modes !== undefined) {
    const seen = new Set();
    if (!Array.isArray(p.modes) || p.modes.length < 1 || p.modes.length > 8) errors.push('modes: must be a list of 1 to 8 texts.');
    else p.modes.forEach((m, i) => {
      const at = `modes[${i}]`;
      if (!isText(m)) { errors.push(`${at}: must be a non-empty text.`); return; }
      const t = m.trim().toLowerCase();
      if (m.trim().length > 40) errors.push(`${at}: must be at most 40 characters.`);
      else if (t.startsWith('habit:')) errors.push(`${at}: must not start with "habit:".`);
      else if (t === 'idea') errors.push(`${at}: must not be "idea".`);
      else if (seen.has(t)) errors.push(`${at}: "${m}" is used twice; modes must be different.`);
      else seen.add(t);
    });
  }
  if (p.focus !== undefined) {
    if (!Array.isArray(p.focus)) errors.push('focus: must be a list of project keys.');
    else p.focus.forEach((f, i) => { if (typeof f !== 'string' || !keys.has(f)) errors.push(`focus[${i}]: must be a project key from this proposal.`); });
  }
  return { ok: errors.length === 0, errors };
}

export function emptyRowsRecord(notionIds = null) {
  return { version: 1, notionIds, rows: {}, settingsSha256: null };
}

const keyOf = {
  project: (k) => `project:${k}`,
  goal: (pk, title) => `goal:${pk}/${title}`,
  task: (pk, title) => `task:${pk}/${title}`,
  standalone: (title) => `standalone:${title}`, // a prefix of its own: no project key can reach it
};

// Every row the proposal asks for, in the order it is written.
function wanted(p) {
  const out = [];
  for (const pr of p.projects || []) out.push({ kind: 'project', key: keyOf.project(pr.key), title: pr.title });
  for (const pr of p.projects || []) for (const m of pr.milestones || []) out.push({ kind: 'goal', key: keyOf.goal(pr.key, m.title), title: m.title });
  for (const pr of p.projects || []) for (const t of pr.tasks || []) out.push({ kind: 'task', key: keyOf.task(pr.key, t.title), title: t.title });
  for (const t of p.standalone || []) out.push({ kind: 'task', key: keyOf.standalone(t.title), title: t.title });
  return out;
}

export function planNotionProposal(p, record) {
  const rows = (record && record.rows) || {};
  const steps = wanted(p).map((w) => ({ ...w, exists: Boolean(rows[w.key] && rows[w.key].state === 'done') }));
  steps.push({ kind: 'settings', key: SETTINGS_FILE, title: SETTINGS_FILE, exists: Boolean(record && record.settingsSha256) });
  return steps;
}

const titleOf = (t) => ({ title: [{ text: { content: String(t ?? '') } }] });
const dateOf = (d) => ({ date: d ? { start: String(d) } : null });
const relationOf = (ids) => ({ relation: ids.map((id) => ({ id })) });
const plain = (rich) => (Array.isArray(rich) ? rich.map((r) => r.plain_text ?? r.text?.content ?? '').join('') : '');
const sha = (text) => createHash('sha256').update(text).digest('hex');

class Stop extends Error {}

// The starter settings file for a proposal, given the project numbers the rows got. No `projects` list (R155).
export function buildStarterSettings(p, ids, rows) {
  const numberOf = (k) => rows[keyOf.project(k)].number;
  const cfg = {
    version: 1,
    name: p.name,
    timezone: p.timezone,
    notion: { projects: ids.projects, tasks: ids.tasks, goals: ids.goals, habitLog: ids.habitLog },
    habits: (p.habits || []).map((h) => {
      const o = { id: h.id, title: h.title };
      if (h.project) o.project = `notion-${numberOf(h.project)}`;
      if (h.score) o.score = { min: h.score.min, max: h.score.max };
      return o;
    }),
    modes: p.modes && p.modes.length ? p.modes.map((m) => m.trim()) : [...DEFAULT_MODES],
    focus: (p.focus || []).map((k) => `notion-${numberOf(k)}`),
    ideas: { owner: 'notion', number: 998 },
  };
  if ((p.habits || []).some((h) => h.score)) cfg.habitsProject = { owner: 'notion', number: 999 };
  return cfg;
}

export async function applyNotionProposal({ proposal, http, ids, record, save, pace = async () => {}, say = () => {}, configDir, writeFile, readFile: readSettings = readFile }) {
  try {
    const v = validateNotionProposal(proposal);
    if (!v.ok) throw new Stop(`The proposal is not in order, so nothing was written: ${v.errors[0]}`);
    if (!record || typeof record !== 'object') throw new Stop('There is no record to work from.');
    if (!record.rows || typeof record.rows !== 'object') record.rows = {};
    if (record.version === undefined) record.version = 1;
    const here = IDS.map((k) => ids[k]).join('|');
    if (record.notionIds == null) {
      if (Object.keys(record.rows).length) throw new Stop(BOUND);
      record.notionIds = Object.fromEntries(IDS.map((k) => [k, ids[k]]));
    } else if (IDS.map((k) => record.notionIds[k]).join('|') !== here) throw new Stop(BOUND);
    const rows = record.rows;
    const persist = async () => { if (typeof save === 'function') await save(record); };

    // Never overwrite a person's settings: an existing file must be one this record wrote, or already the same.
    const settingsPath = join(configDir, SETTINGS_FILE);
    let existing = null;
    try { existing = await readSettings(settingsPath, 'utf8'); } catch (e) {
      if (!e || e.code !== 'ENOENT') throw new Stop(`${SETTINGS_FILE} in ${configDir} could not be read, so nothing was written; make it readable, move it away or pick another --config-dir.`);
      existing = null;
    }
    const settingsRefusal = `${SETTINGS_FILE} already exists in ${configDir} and this setup did not write it, so nothing was written; move it away or pick another --config-dir.`;
    const ours = [record.settingsSha256, record.settingsPendingSha256].filter(Boolean);
    if (existing !== null && !ours.includes(sha(existing))) throw new Stop(settingsRefusal);

    const write = async (method, path, body) => { await pace(); return http.request(method, path, body); };
    await persist();

    // The first option of the To-do group of a status property, by name.
    async function todoName(ds) {
      const res = await http.request('GET', `/v1/data_sources/${ds}`);
      const st = res.properties && res.properties.Status && res.properties.Status.status;
      const group = st && (st.groups || []).find((g) => g.name === 'To-do');
      const first = group && group.option_ids && group.option_ids[0];
      const opt = first && (st.options || []).find((o) => o.id === first || o.name === first);
      return (opt && opt.name) || 'Not started';
    }
    const projectStatus = await todoName(ids.projects);
    const taskStatus = await todoName(ids.tasks);

    const taken = (except) => new Set(Object.entries(rows).filter(([k, r]) => k !== except && r && r.pageId).map(([, r]) => r.pageId));
    async function lookup(ds, titleProp, title, relations, except) {
      const skip = taken(except);
      const found = [];
      let cursor;
      for (let i = 0; i < 50; i += 1) {
        const body = { filter: { property: titleProp, title: { equals: title } }, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const res = await http.request('POST', `/v1/data_sources/${ds}/query`, body);
        for (const pg of res.results || []) {
          if (pg.in_trash || pg.archived || skip.has(pg.id)) continue;
          if (plain(pg.properties?.[titleProp]?.title) !== title) continue;
          let ok = true;
          for (const [prop, want] of Object.entries(relations || {})) {
            const pv = pg.properties?.[prop];
            if (pv?.has_more === true) throw new Stop('A page has more related pages than could be read, so nothing was guessed; remove the extra copies and run again.');
            const have = (pv?.relation || []).map((r) => r.id).sort();
            if (JSON.stringify(have) !== JSON.stringify([...want].sort())) ok = false;
          }
          if (ok) found.push(pg);
        }
        if (!res.has_more || !res.next_cursor) break;
        cursor = res.next_cursor;
      }
      return found;
    }
    async function numberOfPage(page) {
      const n = page.properties?.ID?.unique_id?.number;
      if (typeof n === 'number') return n;
      const again = await http.request('GET', `/v1/pages/${page.id}`);
      const m = again.properties?.ID?.unique_id?.number;
      return typeof m === 'number' ? m : null;
    }
    const created = { project: 0, goal: 0, task: 0 };
    async function ensure({ kind, key, ds, titleProp, title, props, relations }) {
      const row = rows[key];
      if (row && row.state === 'done') return;
      if (row && row.state === 'pending') {
        const hits = await lookup(ds, titleProp, title, relations, key);
        if (hits.length > 1) throw new Stop(`More than one page already matches "${title}", so nothing was guessed; remove the extra copies and run again.`);
        if (hits.length === 1) {
          rows[key] = { state: 'done', pageId: hits[0].id, number: await numberOfPage(hits[0]) };
          await persist();
          return;
        }
      }
      rows[key] = { state: 'pending' };
      await persist();
      const page = await write('POST', '/v1/pages', { parent: { data_source_id: ds }, properties: props });
      rows[key] = { state: 'done', pageId: page.id, number: await numberOfPage(page) };
      created[kind] += 1;
      await persist();
    }
    const pageIdOf = (key) => {
      const r = rows[key];
      if (!r || r.state !== 'done' || !r.pageId) throw new Stop(`"${key}" has no page yet.`);
      return r.pageId;
    };

    const prs = proposal.projects || [];
    const open = (keys) => keys.filter((k) => !(rows[k] && rows[k].state === 'done')).length; // rows still to create
    const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const openProjects = open(prs.map((pr) => keyOf.project(pr.key)));
    if (openProjects) say(`Creating ${noun(openProjects, 'project', 'projects')}.`);
    for (const pr of prs) {
      await ensure({ kind: 'project', key: keyOf.project(pr.key), ds: ids.projects, titleProp: 'Project name', title: pr.title,
        props: { 'Project name': titleOf(pr.title), Status: { status: { name: projectStatus } } } });
    }
    if (open(prs.flatMap((pr) => (pr.milestones || []).map((m) => keyOf.goal(pr.key, m.title))))) say('Creating the goals.');
    for (const pr of prs) {
      for (const m of pr.milestones || []) {
        const pid = pageIdOf(keyOf.project(pr.key));
        await ensure({ kind: 'goal', key: keyOf.goal(pr.key, m.title), ds: ids.goals, titleProp: 'Goal name', title: m.title, relations: { Project: [pid] },
          props: { 'Goal name': titleOf(m.title), Due: dateOf(m.due), Project: relationOf([pid]) } });
      }
    }
    const taskKeys = [...prs.flatMap((pr) => (pr.tasks || []).map((t) => keyOf.task(pr.key, t.title))), ...(proposal.standalone || []).map((t) => keyOf.standalone(t.title))];
    if (open(taskKeys)) say('Creating the tasks.');
    const task = async (pk, t) => { // pk is null for a standalone task
      const pids = pk === null ? [] : [pageIdOf(keyOf.project(pk))];
      const gids = t.milestone ? [pageIdOf(keyOf.goal(pk, t.milestone))] : [];
      await ensure({ kind: 'task', key: pk === null ? keyOf.standalone(t.title) : keyOf.task(pk, t.title), ds: ids.tasks, titleProp: 'Task name', title: t.title, relations: { Project: pids, Goal: gids },
        props: { 'Task name': titleOf(t.title), Status: { status: { name: taskStatus } }, Due: dateOf(t.due), Project: relationOf(pids), Goal: relationOf(gids) } });
    };
    for (const pr of prs) for (const t of pr.tasks || []) await task(pr.key, t);
    for (const t of proposal.standalone || []) await task(null, t);

    const cfg = buildStarterSettings(proposal, ids, rows);
    const text = `${JSON.stringify(cfg, null, 2)}\n`;
    const bad = checkSettings({ ...cfg, projects: [] });
    if (!bad.ok) throw new Stop(`The starter settings did not pass the settings check (${bad.errors[0]}); the rows are saved, nothing else was written.`);
    if (existing !== text) {
      // The intent is on disk before the file is, so a stop between the two is recognised as ours on the next run.
      record.settingsPendingSha256 = sha(text);
      await persist();
      if (typeof writeFile === 'function') await writeFile(settingsPath, cfg);
      else await writeJsonAtomic(settingsPath, cfg);
    }
    record.settingsSha256 = sha(text);
    delete record.settingsPendingSha256;
    await persist();
    say('The starter board is complete.');
    return { ok: true, created, settingsPath, settings: cfg, rows: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.number ?? null])) };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, message: e.message };
    return { ok: false, message: 'The starter board stopped because of a problem it did not expect; run the same command again, it carries on from the record.', cause: e };
  }
}
