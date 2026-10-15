// The copier's verify step: reads Notion directly (all four data sources, the Habit log with no window, every
// relation paged) and compares each copied row with the plan built from GitHub, by record key -> page id.
// Built to reference/notion-native/interface.md, section 6.3; contract R153. Makes no write and reads no clock.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const norm = (id) => String(id ?? '').replace(/-/g, '').toLowerCase();
const PAGE_CAP = 200; // query pages per data source
const RELATION_PAGE_CAP = 50;

export const VERIFY_FILE = 'copy-verify.json';

// ---------- reading Notion ----------

async function queryAll(http, id) {
  const pages = [];
  let cursor = null;
  for (let n = 1; ; n += 1) {
    const body = { page_size: 100 };
    if (cursor !== null) body.start_cursor = cursor;
    const res = await http.request('POST', `/v1/data_sources/${id}/query`, body);
    if (!isObj(res)) return { pages, partial: true };
    for (const p of Array.isArray(res.results) ? res.results : []) pages.push(p);
    if (isObj(res.request_status) && res.request_status.type === 'incomplete') return { pages, partial: true };
    if (res.has_more !== true || !isStr(res.next_cursor) || res.next_cursor === '') return { pages, partial: false };
    if (n >= PAGE_CAP) return { pages, partial: true };
    cursor = res.next_cursor;
  }
}

function prop(page, name, type) {
  const p = isObj(page.properties) ? page.properties[name] : undefined;
  return isObj(p) && p.type === type ? p : null;
}
const plain = (arr) => (Array.isArray(arr)
  ? arr.map((t) => (isObj(t) ? (isStr(t.plain_text) ? t.plain_text : isObj(t.text) && isStr(t.text.content) ? t.text.content : '') : '')).join('')
  : '');
function titleOf(page) {
  if (!isObj(page.properties)) return '';
  for (const p of Object.values(page.properties)) if (isObj(p) && p.type === 'title') return plain(p.title);
  return '';
}
function dateOf(page, name) {
  const p = prop(page, name, 'date');
  return p && isObj(p.date) && isStr(p.date.start) ? p.date.start.slice(0, 10) : null;
}
const checkboxOf = (page, name) => { const p = prop(page, name, 'checkbox'); return Boolean(p && p.checkbox === true); };
function selectOf(page, name) {
  const p = prop(page, name, 'select');
  return p && isObj(p.select) && isStr(p.select.name) ? p.select.name : null;
}
function statusOf(page) {
  const p = prop(page, 'Status', 'status');
  return p && isObj(p.status) && isStr(p.status.name) ? p.status.name : null;
}
function tagsOf(page) {
  const p = prop(page, 'Tags', 'multi_select');
  return p && Array.isArray(p.multi_select) ? p.multi_select.filter((o) => isObj(o) && isStr(o.name)).map((o) => o.name) : [];
}
function scoreOf(page) {
  const p = prop(page, 'Score', 'number');
  return p && typeof p.number === 'number' ? p.number : null;
}

// The whole relation of one property: the page's own list, completed through the property endpoint when Notion cut it.
async function relationIds(http, page, name) {
  const p = prop(page, name, 'relation');
  if (!p) return { ids: [], complete: true };
  let ids = (Array.isArray(p.relation) ? p.relation : []).filter((r) => isObj(r) && isStr(r.id)).map((r) => norm(r.id));
  if (p.has_more !== true) return { ids, complete: true };
  ids = [];
  let cursor = null;
  for (let n = 1; n <= RELATION_PAGE_CAP; n += 1) {
    const q = cursor === null ? '' : `?start_cursor=${encodeURIComponent(cursor)}`;
    const res = await http.request('GET', `/v1/pages/${page.id}/properties/${p.id}${q}`);
    if (!isObj(res)) return { ids, complete: false };
    for (const it of Array.isArray(res.results) ? res.results : []) {
      if (isObj(it) && isObj(it.relation) && isStr(it.relation.id)) ids.push(norm(it.relation.id));
    }
    if (res.has_more !== true || !isStr(res.next_cursor) || res.next_cursor === '') return { ids, complete: true };
    cursor = res.next_cursor;
  }
  return { ids, complete: false };
}

// Every page of a data source with the fields verify compares, keyed by normalised page id.
async function readKind(http, kind, id) {
  const { pages, partial } = await queryAll(http, id);
  const map = new Map();
  let incomplete = partial;
  for (const page of pages) {
    if (!isObj(page) || !isStr(page.id)) continue;
    const row = { id: norm(page.id), title: titleOf(page) };
    if (kind === 'projects') row.status = statusOf(page);
    if (kind === 'goals') {
      row.due = dateOf(page, 'Due');
      row.done = checkboxOf(page, 'Done');
      const r = await relationIds(http, page, 'Project');
      row.projects = r.ids;
      if (!r.complete) incomplete = true;
    }
    if (kind === 'tasks') {
      row.status = statusOf(page);
      row.due = dateOf(page, 'Due');
      row.tags = tagsOf(page);
      const pr = await relationIds(http, page, 'Project');
      const go = await relationIds(http, page, 'Goal');
      const bl = await relationIds(http, page, 'Blocked by');
      row.projects = pr.ids;
      row.goals = go.ids;
      row.blockedBy = bl.ids;
      if (!pr.complete || !go.complete || !bl.complete) incomplete = true;
    }
    if (kind === 'habitLog') {
      row.habit = selectOf(page, 'Habit');
      row.date = dateOf(page, 'Date');
      row.done = checkboxOf(page, 'Done');
      row.score = scoreOf(page);
    }
    map.set(row.id, row);
  }
  return { rows: map, incomplete };
}

export async function readNotionForVerify(http, notionIds) {
  const out = {};
  let incomplete = false;
  for (const kind of ['projects', 'tasks', 'goals', 'habitLog']) {
    const r = await readKind(http, kind, notionIds[kind]);
    out[kind] = r.rows;
    if (r.incomplete) incomplete = true;
  }
  return { ...out, incomplete };
}

// ---------- comparing ----------

const sameSet = (a, b) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const show = (v) => JSON.stringify(v);

// runCopyVerify({ plan, http, notionIds, record, say? }) -> { pass, rows: [{ key, ok, diff? }] }
export async function runCopyVerify({ plan, http, notionIds, record, say = () => {} }) {
  const rows = [];
  const add = (key, diffs) => rows.push(diffs.length ? { key, ok: false, diff: diffs.join('; ') } : { key, ok: true });
  const recRows = isObj(record) && isObj(record.rows) ? record.rows : {};
  const pageOf = (key) => (isObj(recRows[key]) && recRows[key].state === 'done' && isStr(recRows[key].pageId) ? norm(recRows[key].pageId) : null);
  const idsOf = (keys) => (keys || []).map(pageOf);

  const n = await readNotionForVerify(http, notionIds);
  if (n.incomplete) add('read', ['Notion did not return every row or relation, so nothing can be confirmed']);

  // counts: what the plan holds against what Notion holds
  const p = plan;
  const counts = [
    ['count:projects', (p.projects || []).length, n.projects.size],
    ['count:goals', (p.goals || []).length, n.goals.size],
    ['count:tasks', (p.tasks || []).length + (p.ideas || []).length, n.tasks.size],
    ['count:checkins', (p.checkins || []).length, n.habitLog.size],
  ];
  for (const [key, want, have] of counts) add(key, want === have ? [] : [`plan ${want}, Notion ${have}`]);

  const find = (map, key) => {
    const id = pageOf(key);
    if (id === null) return { missing: 'no done row in the record' };
    const row = map.get(id);
    return row ? { row } : { missing: 'page not found in Notion' };
  };

  for (const e of p.projects || []) {
    const f = find(n.projects, e.key);
    if (!f.row) { add(e.key, [f.missing]); continue; }
    const d = [];
    if (f.row.title !== e.title) d.push(`title ${show(f.row.title)} vs ${show(e.title)}`);
    if (f.row.status !== e.status) d.push(`status ${show(f.row.status)} vs ${show(e.status)}`);
    add(e.key, d);
  }

  for (const e of p.goals || []) {
    const f = find(n.goals, e.key);
    if (!f.row) { add(e.key, [f.missing]); continue; }
    const d = [];
    if (f.row.title !== e.title) d.push(`title ${show(f.row.title)} vs ${show(e.title)}`);
    if ((f.row.due ?? null) !== (e.due ?? null)) d.push(`due ${show(f.row.due)} vs ${show(e.due ?? null)}`);
    if (f.row.done !== (e.done === true)) d.push(`done ${f.row.done} vs ${e.done === true}`);
    if (!sameSet(f.row.projects, idsOf(e.projectKeys).map(String))) d.push('project relation differs');
    add(e.key, d);
  }

  const blockedBy = new Map();
  for (const b of p.blockers || []) blockedBy.set(b.taskKey, b.blockedByKeys || []);
  for (const e of p.tasks || []) {
    const f = find(n.tasks, e.key);
    if (!f.row) { add(e.key, [f.missing]); continue; }
    const d = [];
    if (f.row.title !== e.title) d.push(`title ${show(f.row.title)} vs ${show(e.title)}`);
    if (f.row.status !== e.status) d.push(`status ${show(f.row.status)} vs ${show(e.status)}`);
    if ((f.row.due ?? null) !== (e.due ?? null)) d.push(`due ${show(f.row.due)} vs ${show(e.due ?? null)}`);
    if (!sameSet(f.row.tags, e.tags || [])) d.push(`tags ${show(f.row.tags)} vs ${show(e.tags || [])}`);
    if (!sameSet(f.row.projects, idsOf(e.projectKeys).map(String))) d.push('project relation differs');
    const wantGoal = e.goalKey ? [pageOf(e.goalKey)] : [];
    if (!sameSet(f.row.goals, wantGoal.map(String))) d.push('goal relation differs');
    if (!sameSet(f.row.blockedBy, idsOf(blockedBy.get(e.key)).map(String))) d.push('blocked-by relation differs');
    add(e.key, d);
  }

  // Names of the Status options in the Complete group of the Tasks data source; null when the schema cannot be read.
  let completeNames = new Set();
  if ((p.ideas || []).length) {
    completeNames = null;
    try {
      const schema = await http.request('GET', `/v1/data_sources/${notionIds.tasks}`);
      const st = isObj(schema) && isObj(schema.properties) ? Object.values(schema.properties).find((x) => isObj(x) && x.type === 'status' && x.name === 'Status') : null;
      if (st && isObj(st.status) && Array.isArray(st.status.groups) && Array.isArray(st.status.options)) {
        const group = st.status.groups.find((g) => isObj(g) && String(g.name).toLowerCase() === 'complete');
        if (group && Array.isArray(group.option_ids)) {
          completeNames = new Set(st.status.options.filter((o) => group.option_ids.includes(o.id) || group.option_ids.includes(o.name)).map((o) => o.name));
        }
      }
    } catch { completeNames = null; }
  }
  for (const e of p.ideas || []) {
    const f = find(n.tasks, e.key);
    if (!f.row) { add(e.key, [f.missing]); continue; }
    const d = [];
    if (f.row.title !== e.title) d.push(`title ${show(f.row.title)} vs ${show(e.title)}`);
    if (!f.row.tags.includes('Idea')) d.push('missing the Idea tag');
    // An idea shows as an idea only with no Project, no Goal and a status outside the Complete group.
    if (f.row.projects.length) d.push('has a Project relation, so it no longer shows as an idea');
    if (f.row.goals.length) d.push('has a Goal relation, so it no longer shows as an idea');
    if (completeNames === null) d.push('the Status groups could not be read, so the idea status cannot be confirmed');
    else if (f.row.status !== null && completeNames.has(f.row.status)) d.push(`status ${show(f.row.status)} is in the Complete group, so it no longer shows as an idea`);
    add(e.key, d);
  }

  for (const e of p.checkins || []) {
    const f = find(n.habitLog, e.key);
    if (!f.row) { add(e.key, [f.missing]); continue; }
    const d = [];
    if (f.row.habit !== e.habit) d.push(`habit ${show(f.row.habit)} vs ${show(e.habit)}`);
    if (f.row.date !== e.date) d.push(`date ${show(f.row.date)} vs ${show(e.date)}`);
    if (f.row.done !== (e.done === true)) d.push(`done ${f.row.done} vs ${e.done === true}`);
    if ((f.row.score ?? null) !== (e.score ?? null)) d.push(`score ${show(f.row.score)} vs ${show(e.score ?? null)}`);
    add(e.key, d);
  }

  const bad = rows.filter((r) => !r.ok);
  const pass = bad.length === 0;
  say(pass ? `Verify passed: ${rows.length} checks, every copied row matches.` : `Verify failed: ${bad.length} of ${rows.length} checks differ.`);
  for (const r of bad.slice(0, 20)) say(`  ${r.key}: ${r.diff}`);
  if (bad.length > 20) say(`  and ${bad.length - 20} more, in ${VERIFY_FILE}.`);
  return { pass, rows };
}
