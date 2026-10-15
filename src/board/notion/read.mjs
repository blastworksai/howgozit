// read: turns the four Notion data sources (projects, tasks, goals, habitLog) into the board snapshot
// (notion-native interface §3; contract R144-R146, R68, R65, R151 idea/card split, R152 labels from Tags,
// R155 the Projects rows are the project list when the settings hold none).
// Takes an http object (request); makes no request of its own outside it and reads no clock (`now` is passed in).
// The store is the adapter's own memory of every row; toRaw derives the snapshot from it and is pure.

import { BackendError } from '../model/adapter.mjs';
import { addDays, isDate, isZone, todayIn, instantOf } from '../days.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;

export const KINDS = ['projects', 'tasks', 'goals', 'habitLog'];
const PAGE_CAP = 100; // query pages per data source (R68)
const RELATION_PAGE_CAP = 20; // pages of one relation (R146)
const DELTA_MARGIN_MS = 5 * 60 * 1000; // R145
const HABIT_WINDOW_DAYS = 120; // R68
const ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SETTINGS_SENTENCE = 'The settings need a notion block with the four data source ids (projects, tasks, goals, habitLog); see notion-setup.md.';

// The setup palette (cp7-interface §2); `default` has no entry (R132's muted).
const PALETTE = {
  green: '#0e8a16', purple: '#5319e7', yellow: '#fbca04', orange: '#d93f0b', blue: '#1d76db',
  red: '#b60205', gray: '#5d6d7e', brown: '#8a6d3b', pink: '#c2185b',
};

// Which relation property feeds which row key.
const RELATIONS = {
  tasks: [['projectIds', 'Project'], ['goalIds', 'Goal'], ['blockedByIds', 'Blocked by']],
  goals: [['projectIds', 'Project']],
};

export function createStore() {
  return {
    rows: { projects: new Map(), tasks: new Map(), goals: new Map(), habitLog: new Map() },
    schema: {
      tasks: { groupOf: new Map(), completeFirst: null, tagColors: new Map() },
      projects: { groupOf: new Map() },
      habitLog: { hasScore: false },
    },
    lastReadMs: null,
    partial: { issues: false, items: false },
  };
}

const urlOf = (id) => `https://www.notion.so/${String(id).replace(/-/g, '')}`;

// ---- page value readers (notion-api §4 value shapes); every one tolerates a missing or odd value ----

function prop(page, name, type) {
  const p = isObj(page.properties) ? page.properties[name] : undefined;
  return isObj(p) && (type === undefined || p.type === type) ? p : null;
}

function plain(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((t) => (isObj(t) ? (isStr(t.plain_text) ? t.plain_text : isObj(t.text) && isStr(t.text.content) ? t.text.content : '') : '')).join('');
}

function titleOf(page) {
  if (!isObj(page.properties)) return '';
  for (const p of Object.values(page.properties)) if (isObj(p) && p.type === 'title') return plain(p.title);
  return '';
}

// The unique ID: the property named ID when it is one, else the first unique_id property.
function numberOf(page) {
  if (!isObj(page.properties)) return null;
  let p = prop(page, 'ID', 'unique_id');
  if (!p) p = Object.values(page.properties).find((x) => isObj(x) && x.type === 'unique_id') ?? null;
  const n = p && isObj(p.unique_id) ? p.unique_id.number : null;
  return isPosInt(n) ? n : null;
}

function dateOf(page, name) {
  const p = prop(page, name, 'date');
  const s = p && isObj(p.date) && isStr(p.date.start) ? p.date.start.slice(0, 10) : null;
  return s !== null && isDate(s) ? s : null;
}

function checkboxOf(page, name) {
  const p = prop(page, name, 'checkbox');
  return Boolean(p && p.checkbox === true);
}

function selectOf(page, name) {
  const p = prop(page, name, 'select');
  return p && isObj(p.select) && isStr(p.select.name) && p.select.name !== '' ? p.select.name : null;
}

function multiSelectOf(page, name) {
  const p = prop(page, name, 'multi_select');
  if (!p || !Array.isArray(p.multi_select)) return [];
  return p.multi_select.filter((o) => isObj(o) && isStr(o.name) && o.name !== '').map((o) => o.name);
}

function relationOf(page, name) {
  const p = prop(page, name, 'relation');
  if (!p || !Array.isArray(p.relation)) return { ids: [], more: null };
  const ids = p.relation.filter((r) => isObj(r) && isStr(r.id)).map((r) => r.id);
  return { ids, more: p.has_more === true && isStr(p.id) && p.id !== '' ? p.id : null };
}

// normalize(kind, page, schema): one page -> its row, or null when the row cannot be used (no page id, no ID,
// and for a Habit log row no Date or Habit; R144). A relation cut at 25 is marked in `_more` for the reader to complete.
// `schema` (the store's) is accepted for the adapter's writes; a row holds the raw option ids and names, and groups
// are applied in toRaw, so a schema change shows without re-reading rows.
export function normalize(kind, page, schema) {
  void schema;
  if (!isObj(page) || !isStr(page.id) || page.id === '' || !KINDS.includes(kind)) return null;
  const number = numberOf(page);
  if (number === null) return null;
  const row = {
    id: page.id,
    number,
    title: titleOf(page),
    created: isStr(page.created_time) ? page.created_time : '',
    edited: isStr(page.last_edited_time) ? page.last_edited_time : '',
  };
  const more = [];
  for (const [key, name] of RELATIONS[kind] || []) {
    const r = relationOf(page, name);
    row[key] = r.ids;
    if (r.more !== null) more.push({ key, prop: r.more });
  }
  if (kind === 'tasks' || kind === 'projects') {
    const st = prop(page, 'Status', 'status');
    const s = st && isObj(st.status) ? st.status : null;
    row.statusId = s && isStr(s.id) ? s.id : null;
    row.statusName = s && isStr(s.name) ? s.name : null;
  }
  if (kind === 'tasks') {
    row.tags = multiSelectOf(page, 'Tags');
    row.due = dateOf(page, 'Due');
  } else if (kind === 'goals') {
    row.due = dateOf(page, 'Due');
    row.done = checkboxOf(page, 'Done');
  } else if (kind === 'habitLog') {
    const habit = selectOf(page, 'Habit');
    const date = dateOf(page, 'Date');
    if (habit === null || date === null) return null;
    row.habit = habit;
    row.date = date;
    row.done = checkboxOf(page, 'Done');
    const sc = prop(page, 'Score', 'number');
    row.score = sc && typeof sc.number === 'number' && Number.isFinite(sc.number) ? sc.number : null;
  }
  if (more.length) Object.defineProperty(row, '_more', { value: more, enumerable: false, writable: true, configurable: true });
  return row;
}

// ---- settings ----

function dataSourceIds(settings) {
  const n = isObj(settings) && isObj(settings.notion) ? settings.notion : null;
  const ids = {};
  for (const k of KINDS) {
    if (!n || !isStr(n[k]) || !ID_RE.test(n[k])) {
      throw new BackendError('invalid', null, SETTINGS_SENTENCE);
    }
    ids[k] = n[k];
  }
  return ids;
}

function zoneOf(settings) {
  return isObj(settings) && isStr(settings.timezone) && isZone(settings.timezone) ? settings.timezone : 'UTC';
}

// ---- schema ----

// The Status option -> group map of one data source (done / doing / todo) and the first Complete option's name.
function statusGroups(ds) {
  const groupOf = new Map();
  let completeFirst = null;
  const props = isObj(ds) && isObj(ds.properties) ? ds.properties : {};
  let status = isObj(props.Status) && props.Status.type === 'status' ? props.Status : null;
  if (!status) status = Object.values(props).find((p) => isObj(p) && p.type === 'status') ?? null;
  const sdef = status && isObj(status.status) ? status.status : {};
  const options = Array.isArray(sdef.options) ? sdef.options.filter((o) => isObj(o) && isStr(o.id)) : [];
  const nameOf = new Map(options.map((o) => [o.id, o.name]));
  for (const g of Array.isArray(sdef.groups) ? sdef.groups : []) {
    if (!isObj(g) || !Array.isArray(g.option_ids)) continue;
    const gn = String(g.name ?? '').trim().toLowerCase();
    const kind = gn === 'complete' ? 'done' : gn === 'in progress' ? 'doing' : gn === 'to-do' ? 'todo' : null;
    if (kind === null) continue;
    for (const oid of g.option_ids) {
      if (!isStr(oid)) continue;
      groupOf.set(oid, kind);
      if (kind === 'done' && completeFirst === null && isStr(nameOf.get(oid))) completeFirst = nameOf.get(oid);
    }
  }
  return { groupOf, completeFirst };
}

function readSchemas(tasksDs, habitDs, projectsDs) {
  const tasks = { ...statusGroups(tasksDs), tagColors: new Map() };
  const props = isObj(tasksDs) && isObj(tasksDs.properties) ? tasksDs.properties : {};
  const tags = isObj(props.Tags) && props.Tags.type === 'multi_select' ? props.Tags : null;
  const topts = tags && isObj(tags.multi_select) && Array.isArray(tags.multi_select.options) ? tags.multi_select.options : [];
  for (const o of topts) {
    if (!isObj(o) || !isStr(o.name) || o.name === '') continue;
    const hex = PALETTE[o.color];
    if (hex !== undefined) tasks.tagColors.set(o.name.trim().toLowerCase(), hex);
  }
  const hprops = isObj(habitDs) && isObj(habitDs.properties) ? habitDs.properties : {};
  return { tasks, projects: { groupOf: statusGroups(projectsDs).groupOf }, habitLog: { hasScore: isObj(hprops.Score) && hprops.Score.type === 'number' } };
}

// ---- reading ----

async function queryAll(http, id, filter) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let partial = false;
  for (;;) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor !== null) body.start_cursor = cursor;
    const res = await http.request('POST', `/v1/data_sources/${id}/query`, body);
    pages += 1;
    if (!isObj(res)) throw new BackendError('unavailable', null, 'Notion could not be reached.');
    for (const p of Array.isArray(res.results) ? res.results : []) rows.push(p);
    if (isObj(res.request_status) && res.request_status.type === 'incomplete') { partial = true; break; }
    if (res.has_more !== true || !isStr(res.next_cursor) || res.next_cursor === '') break;
    if (pages >= PAGE_CAP) { partial = true; break; }
    cursor = res.next_cursor;
  }
  return { pages: rows, partial };
}

// R146: the whole relation of one page property; false when 20 pages did not reach its end.
async function fullRelation(http, pageId, propId) {
  const ids = [];
  let cursor = null;
  for (let n = 1; n <= RELATION_PAGE_CAP; n += 1) {
    const q = cursor === null ? '' : `?start_cursor=${encodeURIComponent(cursor)}`;
    const res = await http.request('GET', `/v1/pages/${pageId}/properties/${propId}${q}`);
    if (!isObj(res)) throw new BackendError('unavailable', null, 'Notion could not be reached.');
    for (const it of Array.isArray(res.results) ? res.results : []) {
      if (isObj(it) && isObj(it.relation) && isStr(it.relation.id)) ids.push(it.relation.id);
    }
    if (res.has_more !== true || !isStr(res.next_cursor) || res.next_cursor === '') return { ids, complete: true };
    cursor = res.next_cursor;
  }
  return { ids, complete: false };
}

export async function readNotion(http, store, { settings, full, now } = {}) {
  const ids = dataSourceIds(settings); // refused before any request
  const tz = zoneOf(settings);
  const nowMs = Date.parse(now);
  const doFull = full === true || store.lastReadMs === null || !Number.isFinite(store.lastReadMs);

  let schemas = null;
  if (doFull) {
    const tasksDs = await http.request('GET', `/v1/data_sources/${ids.tasks}`);
    const habitDs = await http.request('GET', `/v1/data_sources/${ids.habitLog}`);
    const projectsDs = await http.request('GET', `/v1/data_sources/${ids.projects}`);
    schemas = readSchemas(tasksDs, habitDs, projectsDs);
  }

  const since = doFull ? null : new Date(store.lastReadMs - DELTA_MARGIN_MS).toISOString();
  const stamp = since === null ? null : { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } };
  const today = todayIn(tz, now);
  const windowStart = today === null ? null : addDays(today, -HABIT_WINDOW_DAYS);

  const warnings = [];
  const skipped = { count: 0 };
  let partialIssues = false;
  let partialItems = false;
  const next = {};
  for (const kind of KINDS) {
    let filter = stamp;
    if (kind === 'habitLog' && windowStart !== null) {
      const win = { property: 'Date', date: { on_or_after: windowStart } };
      filter = stamp ? { and: [stamp, win] } : win;
    }
    const q = await queryAll(http, ids[kind], filter);
    if (q.partial) partialIssues = true;
    const rows = new Map();
    for (const page of q.pages) {
      if (isObj(page) && (page.in_trash === true || page.archived === true)) continue;
      const row = normalize(kind, page, schemas ?? store.schema);
      if (row === null) { skipped.count += 1; continue; }
      rows.set(row.id, row);
    }
    // R146: relations the page cut at 25
    for (const row of rows.values()) {
      if (!row._more) continue;
      for (const m of row._more) {
        const got = await fullRelation(http, row.id, m.prop);
        const merged = [...row[m.key]];
        for (const id of got.ids) if (!merged.includes(id)) merged.push(id);
        row[m.key] = merged;
        if (!got.complete) partialItems = true;
      }
    }
    next[kind] = rows;
  }

  // every request succeeded: only now is the store touched
  if (doFull) {
    store.rows = next;
    store.schema = schemas;
    store.partial = { issues: partialIssues, items: partialItems };
  } else {
    for (const kind of KINDS) {
      const held = store.rows[kind];
      for (const [id, row] of next[kind]) {
        const old = held.get(id);
        if (old && old.edited > row.edited) continue; // a list that runs behind must not undo a newer copy
        held.set(id, row);
      }
    }
    store.partial = { issues: store.partial.issues || partialIssues, items: store.partial.items || partialItems };
  }
  store.lastReadMs = Number.isFinite(nowMs) ? nowMs : null;

  if (skipped.count > 0) warnings.push({ code: 'row-skipped', count: skipped.count });
  const capped = (partialIssues ? 1 : 0) + (partialItems ? 1 : 0);
  if (capped > 0) warnings.push({ code: 'too-much-data', count: capped });
  // R155: with no `projects` list in the settings, the open Projects rows are the list, handed on as if the settings held it.
  const effective = isObj(settings) && settings.projects === undefined ? { ...settings, projects: listedFromRows(store) } : settings;
  const raw = toRaw(store, effective, now);
  // R143: a role number a listed project already uses is ignored, and counted as a setting the board cannot use.
  const cfg = isObj(effective) ? effective : {};
  let invalid = 0;
  if (isObj(cfg.habitsProject) && isPosInt(cfg.habitsProject.number) && !raw.projects.some((p) => p.role === 'habits')) invalid += 1;
  if (isObj(cfg.ideas) && isPosInt(cfg.ideas.number) && !raw.projects.some((p) => p.role === 'ideas')) invalid += 1;
  if (invalid > 0) warnings.push({ code: 'setting-invalid', count: invalid });
  return { raw, warnings, settings: effective };
}

// R155 (pure): every Projects row whose Status is not in the Complete group (no status counts as open), in ID order,
// as the settings `projects` entries `notion-<ID>`.
export function listedFromRows(store) {
  const groupOf = store.schema.projects.groupOf;
  return [...store.rows.projects.values()]
    .filter((r) => !(r.statusId !== null && r.statusId !== undefined && groupOf.get(r.statusId) === 'done'))
    .sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({ key: `notion-${r.number}`, owner: 'notion', number: r.number }));
}

// ---- toRaw (pure) ----

const byNumber = (a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sorted = (map) => [...map.values()].sort(byNumber);

export function toRaw(store, settings, now) {
  const cfg = isObj(settings) ? settings : {};
  const tz = zoneOf(cfg);
  const labels = isObj(cfg.labels) ? cfg.labels : {};
  const ideaLabel = isStr(labels.idea) && labels.idea.trim() !== '' ? labels.idea : 'idea';
  const prefix = isStr(labels.habitPrefix) && labels.habitPrefix.trim() !== '' ? labels.habitPrefix : 'habit:';
  const habitTitles = new Map();
  for (const h of Array.isArray(cfg.habits) ? cfg.habits : []) {
    if (isObj(h) && isStr(h.id) && isStr(h.title) && h.title !== '') habitTitles.set(h.id.toLowerCase(), h.title);
  }
  const notionIds = isObj(cfg.notion) ? cfg.notion : {};
  const { groupOf } = store.schema.tasks;
  const groupOfCard = (c) => (c.statusId !== null && groupOf.has(c.statusId) ? groupOf.get(c.statusId) : 'todo');
  const isClosed = (c) => groupOfCard(c) === 'done';
  const statusName = { todo: 'Todo', doing: 'In Progress', done: 'Done' };

  const IDEA_TAG = 'idea';
  const modeNames = (Array.isArray(cfg.modes) ? cfg.modes : [])
    .map((m) => (isStr(m) ? m : isObj(m) && isStr(m.name) ? m.name : null))
    .filter((m) => m !== null && m.trim() !== '');
  const tagsOf = (t) => t.tags.map((x) => x.trim().toLowerCase());
  const isIdea = (t) => tagsOf(t).includes(IDEA_TAG) && t.projectIds.length === 0 && !isClosed(t);
  const droppedIdea = (t) => tagsOf(t).includes(IDEA_TAG) && t.projectIds.length === 0 && isClosed(t);
  const allTasks = sorted(store.rows.tasks);
  const cards = allTasks.filter((t) => !isIdea(t) && !droppedIdea(t));
  const ideaRows = allTasks.filter(isIdea);
  const goals = store.rows.goals;
  const projects = store.rows.projects;

  const base = (r, state, closedAt, labelsOut, milestone) => ({
    number: r.number,
    title: r.title,
    state,
    state_reason: state === 'closed' ? 'completed' : null,
    is_pr: false,
    labels: labelsOut,
    milestone,
    created_at: r.created,
    updated_at: r.edited,
    closed_at: closedAt,
    html_url: urlOf(r.id),
    repo: 'notion',
    ref: `notion:${r.id}`,
  });

  const issues = [];
  for (const c of cards) {
    const closed = isClosed(c);
    const goal = c.goalIds.length ? goals.get(c.goalIds[0]) : undefined;
    const row = base(c, closed ? 'closed' : 'open', closed ? c.edited : null, modeNames.filter((m) => tagsOf(c).includes(m.trim().toLowerCase())), goal ? goal.number : null);
    if (!closed) {
      const waiting = [];
      for (const bid of c.blockedByIds) {
        const t = store.rows.tasks.get(bid);
        if (t && !isClosed(t)) waiting.push({ ref: `notion:${t.id}`, title: t.title, url: urlOf(t.id) });
      }
      if (waiting.length) row.waitingOn = waiting;
    }
    issues.push(row);
  }
  for (const i of ideaRows) issues.push(base(i, 'open', null, [ideaLabel], null));
  const habitRows = sorted(store.rows.habitLog);
  for (const h of habitRows) {
    const at = h.done ? (instantOf(tz, h.date, '12:00') ?? `${h.date}T12:00:00Z`) : null;
    const row = base(h, h.done ? 'closed' : 'open', at, [`${prefix}${h.habit}`], null);
    row.title = `${habitTitles.get(h.habit.toLowerCase()) ?? h.habit} · ${h.date}`;
    issues.push(row);
  }

  // Goals: the composed title `<Project title> · <Goal title>` from the first Project relation (cp9-interface §3 (a))
  const milestones = sorted(goals).map((g) => {
    const p = g.projectIds.length ? projects.get(g.projectIds[0]) : undefined;
    return {
      number: g.number,
      title: p ? `${p.title} · ${g.title}` : g.title,
      state: g.done ? 'closed' : 'open',
      due_on: g.due !== null ? `${g.due}T00:00:00Z` : null,
      closed_at: g.done ? g.edited : null,
      html_url: urlOf(g.id),
      repo: 'notion',
    };
  });

  const cardItem = (c) => ({
    type: 'Issue', ref: `notion:${c.id}`, repo: 'notion', number: c.number,
    status: c.statusId === null && c.statusName === null ? null : statusName[groupOfCard(c)], due: c.due,
  });
  const out = [];
  const used = new Set();
  for (const p of Array.isArray(cfg.projects) ? cfg.projects : []) {
    if (!isObj(p) || !isPosInt(p.number)) continue;
    if (p.owner !== undefined && !(isStr(p.owner) && p.owner.toLowerCase() === 'notion')) continue;
    if (used.has(p.number)) continue;
    const row = sorted(projects).find((x) => x.number === p.number);
    if (!row) continue;
    used.add(p.number);
    out.push({
      number: row.number, title: row.title, closed: false, url: urlOf(row.id), owner: 'notion',
      items: cards.filter((c) => c.projectIds.includes(row.id)).map(cardItem),
    });
  }
  // Role rows: the Habits row is the score switch (cp9-interface §3); the Ideas row keeps the same backlog on Notion.
  const hp = isObj(cfg.habitsProject) && isPosInt(cfg.habitsProject.number) ? cfg.habitsProject.number : null;
  if (hp !== null && !used.has(hp)) {
    used.add(hp);
    const row = {
      number: hp, title: 'Habits', closed: false,
      url: isStr(notionIds.habitLog) ? urlOf(notionIds.habitLog) : 'https://www.notion.so/',
      owner: 'notion', ownerType: 'user', role: 'habits',
      items: habitRows.map((h) => ({
        type: 'Issue', ref: `notion:${h.id}`, repo: 'notion', number: h.number, status: null, due: null, score: h.score,
      })),
    };
    if (store.schema.habitLog.hasScore) row.scoreField = 'Score';
    out.push(row);
  }
  const ip = isObj(cfg.ideas) && isPosInt(cfg.ideas.number) ? cfg.ideas.number : null;
  if (ip !== null && !used.has(ip)) {
    used.add(ip);
    out.push({
      number: ip, title: 'Ideas', closed: false,
      url: isStr(notionIds.tasks) ? urlOf(notionIds.tasks) : 'https://www.notion.so/',
      owner: 'notion', ownerType: 'user', role: 'ideas',
      items: ideaRows.map((i) => ({ type: 'Issue', ref: `notion:${i.id}`, repo: 'notion', number: i.number, status: null, due: null })),
    });
  }

  const raw = {
    fetchedAt: now,
    partial: { issues: store.partial.issues === true, items: store.partial.items === true },
    repo: 'notion',
    repoPrivate: true,
    ownerType: 'user',
    source: 'notion',
    issues,
    milestones,
    projects: out,
  };
  const labelColors = {};
  for (const m of modeNames) {
    const k = m.trim().toLowerCase();
    if (store.schema.tasks.tagColors.has(k)) labelColors[k] = store.schema.tasks.tagColors.get(k);
  }
  if (Object.keys(labelColors).length > 0) raw.labelColors = labelColors;
  return raw;
}
