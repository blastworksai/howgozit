// The write half of the GitHub -> Notion copier (interface.md 6.2, contract R153).
// Takes a copy plan and writes it into the four Notion tables, resumably: a record row per plan key is saved
// before and after every create, so a run repeated or resumed after a crash never makes a second page.
// Reads nothing from GitHub. Every Notion write goes through `http` (createNotionHttp) after `pace()`.

const SMALL = 'The copy stopped: ';
export const BOUND = 'The copy record was made for other Notion data sources; move it away or use the ids it was made for.';

export function emptyCopyRecord(startedAt, notionIds = null) {
  return { version: 1, startedAt, notionIds, planDigests: [], rows: {} };
}

class Stop extends Error {}

const titleOf = (t) => ({ title: [{ text: { content: String(t ?? '') } }] });
const dateOf = (d) => ({ date: d ? { start: String(d) } : null });
const relationOf = (ids) => ({ relation: ids.map((id) => ({ id })) });
const tagsOf = (names) => ({ multi_select: (names || []).map((name) => ({ name })) });
const plain = (rich) => (Array.isArray(rich) ? rich.map((r) => r.plain_text ?? r.text?.content ?? '').join('') : '');

export async function runCopy({ plan, http, notionIds, record, save, say = () => {}, pace = async () => {}, outDir, writeConfig }) { // eslint-disable-line no-unused-vars
  try {
    if (!plan || plan.ok === false) throw new Stop('The plan is not in order, so nothing was written.');
    if (!record || typeof record !== 'object') throw new Stop('There is no copy record to work from.');
    if (!record.rows || typeof record.rows !== 'object') record.rows = {};
    if (!Array.isArray(record.planDigests)) record.planDigests = [];
    if (record.version === undefined) record.version = 1;
    if (notionIds && typeof notionIds === 'object') {
      const here = ['projects', 'tasks', 'goals', 'habitLog'].map((k) => notionIds[k]).join('|');
      if (record.notionIds == null) {
        if (Object.keys(record.rows).length) throw new Stop(BOUND);
        record.notionIds = { projects: notionIds.projects, tasks: notionIds.tasks, goals: notionIds.goals, habitLog: notionIds.habitLog };
      } else if (['projects', 'tasks', 'goals', 'habitLog'].map((k) => record.notionIds[k]).join('|') !== here) throw new Stop(BOUND);
    }
    if (plan.digest && !record.planDigests.includes(plan.digest)) record.planDigests.push(plan.digest);
    const rows = record.rows;
    const persist = async () => { if (typeof save === 'function') await save(record); };
    const write = async (method, path, body) => { await pace(); return http.request(method, path, body); };
    await persist();

    const pageIdOf = (key) => {
      const r = rows[key];
      if (!r || r.state !== 'done' || !r.pageId) throw new Stop(`${SMALL}"${key}" has no copied page yet.`);
      return r.pageId;
    };
    const idsOf = (keys) => (keys || []).map(pageIdOf);

    // Find pages in a data source by exact title; `relations` ({ 'Project': [ids] }) narrows by the same relation set.
    // A relation the page reply cut at 25 is read in full through the page-property endpoint.
    async function fullRelation(pageId, propId) {
      const ids = [];
      let cursor;
      for (let i = 0; i < 200; i += 1) {
        const q = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : '';
        const res = await http.request('GET', `/v1/pages/${pageId}/properties/${propId}${q}`);
        for (const it of res.results || []) if (it && it.relation && it.relation.id) ids.push(it.relation.id);
        if (!res.has_more || !res.next_cursor) return ids;
        cursor = res.next_cursor;
      }
      throw new Stop(`${SMALL}a page has more related pages than could be read, so nothing was guessed; remove the extra copies and run again.`);
    }

    // Pages already recorded under any key; a pending row never adopts one of these.
    const assigned = (except) => new Set(Object.entries(rows).filter(([k, r]) => k !== except && r && r.pageId).map(([, r]) => r.pageId));

    async function lookup(ds, titleProp, title, relations = {}, except = null) {
      const taken = assigned(except);
      const found = [];
      let cursor;
      for (let i = 0; i < 50; i += 1) {
        const body = { filter: { property: titleProp, title: { equals: title } }, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const res = await http.request('POST', `/v1/data_sources/${ds}/query`, body); // the exact title is checked below as well
        for (const p of res.results || []) {
          if (p.in_trash || p.archived) continue;
          if (taken.has(p.id)) continue;
          if (plain(p.properties?.[titleProp]?.title) !== title) continue;
          let ok = true;
          for (const [prop, want] of Object.entries(relations)) {
            const pv = p.properties?.[prop];
            let have = (pv?.relation || []).map((r) => r.id);
            if (pv?.has_more === true) {
              if (!pv.id) throw new Stop(`${SMALL}a long list of related pages on "${title}" could not be read in full, so nothing was guessed.`);
              have = await fullRelation(p.id, pv.id);
            }
            have.sort();
            if (JSON.stringify(have) !== JSON.stringify([...want].sort())) ok = false;
          }
          if (ok) found.push(p);
        }
        if (!res.has_more || !res.next_cursor) break;
        cursor = res.next_cursor;
      }
      return found;
    }

    // Create one row's page once. Returns true when a page was created or adopted.
    async function ensure({ key, ds, titleProp, title, props, relations }) {
      const row = rows[key];
      if (row && row.state === 'done') return;
      if (row && row.state === 'pending') {
        const hits = await lookup(ds, titleProp, title, relations, key);
        if (hits.length > 1) throw new Stop(`${SMALL}more than one page already matches "${key}", so nothing was guessed; remove the extra copies and run again.`);
        if (hits.length === 1) {
          rows[key] = { state: 'done', pageId: hits[0].id, number: hits[0].properties?.ID?.unique_id?.number ?? null };
          await persist();
          return;
        }
      }
      rows[key] = { state: 'pending' };
      await persist();
      const page = await write('POST', '/v1/pages', { parent: { data_source_id: ds }, properties: props });
      rows[key] = { state: 'done', pageId: page.id, number: page.properties?.ID?.unique_id?.number ?? null };
      await persist();
    }

    const list = (name) => (Array.isArray(plan[name]) ? plan[name] : []);

    say(`Copying ${list('projects').length} projects.`);
    for (const p of list('projects')) {
      await ensure({
        key: p.key, ds: notionIds.projects, titleProp: 'Project name', title: p.title,
        props: { 'Project name': titleOf(p.title), Status: { status: { name: p.status } } },
      });
    }

    say(`Copying ${list('goals').length} goals.`);
    for (const g of list('goals')) {
      const projectIds = idsOf(g.projectKeys);
      await ensure({
        key: g.key, ds: notionIds.goals, titleProp: 'Goal name', title: g.title, relations: { Project: projectIds },
        props: { 'Goal name': titleOf(g.title), Due: dateOf(g.due), Done: { checkbox: Boolean(g.done) }, Project: relationOf(projectIds) },
      });
    }

    say(`Copying ${list('tasks').length} tasks.`);
    for (const t of list('tasks')) {
      const projectIds = idsOf(t.projectKeys);
      const goalIds = t.goalKey ? [pageIdOf(t.goalKey)] : [];
      await ensure({
        key: t.key, ds: notionIds.tasks, titleProp: 'Task name', title: t.title, relations: { Project: projectIds, Goal: goalIds },
        props: {
          'Task name': titleOf(t.title), Status: { status: { name: t.status } }, Due: dateOf(t.due), Tags: tagsOf(t.tags),
          Project: relationOf(projectIds), Goal: relationOf(goalIds),
        },
      });
    }

    say(`Linking ${list('blockers').length} blocked cards.`);
    for (const b of list('blockers')) {
      if (rows[b.key] && rows[b.key].state === 'done') continue;
      const taskId = pageIdOf(b.taskKey);
      const blockedBy = idsOf(b.blockedByKeys);
      rows[b.key] = { state: 'pending' };
      await persist();
      await write('PATCH', `/v1/pages/${taskId}`, { properties: { 'Blocked by': relationOf(blockedBy) } });
      rows[b.key] = { state: 'done' };
      await persist();
    }

    say(`Copying ${list('ideas').length} ideas.`);
    for (const i of list('ideas')) {
      await ensure({
        key: i.key, ds: notionIds.tasks, titleProp: 'Task name', title: i.title, relations: { Project: [], Goal: [] },
        props: { 'Task name': titleOf(i.title), Tags: tagsOf(['Idea']) },
      });
    }

    say(`Copying ${list('checkins').length} check-ins.`);
    for (const c of list('checkins')) {
      const props = { Name: titleOf(c.title), Habit: { select: { name: c.habit } }, Date: dateOf(c.date), Done: { checkbox: Boolean(c.done) } };
      props.Score = { number: typeof c.score === 'number' ? c.score : null };
      await ensure({ key: c.key, ds: notionIds.habitLog, titleProp: 'Name', title: c.title, props });
    }

    const colours = list('tagColours');
    if (colours.length && !(rows['tagColours'] && rows['tagColours'].state === 'done')) {
      say('Setting tag colours.');
      const ds = await http.request('GET', `/v1/data_sources/${notionIds.tasks}`);
      const prop = ds.properties && ds.properties.Tags;
      const options = (prop && prop.multi_select && prop.multi_select.options) || [];
      const want = new Map(colours.map((c) => [String(c.name).trim().toLowerCase(), c.color]));
      const known = new Set(options.map((o) => o.name.trim().toLowerCase()));
      const next = options.map((o) => {
        const c = want.get(o.name.trim().toLowerCase());
        return c ? { id: o.id, name: o.name, color: c } : { id: o.id, name: o.name, color: o.color };
      });
      for (const c of colours) if (!known.has(String(c.name).trim().toLowerCase())) next.push({ name: c.name, color: c.color });
      rows['tagColours'] = { state: 'pending' };
      await persist();
      await write('PATCH', `/v1/data_sources/${notionIds.tasks}`, { properties: { Tags: { multi_select: { options: next } } } });
      rows['tagColours'] = { state: 'done' };
      await persist();
    }

    // Config files: written byte for byte; a rewrite is harmless, so no record row.
    const files = plan.configFiles;
    const entries = Array.isArray(files)
      ? files.map((f) => [f.name ?? f.path, f.text ?? f.content])
      : (files && typeof files === 'object' ? Object.entries(files) : []);
    for (const [name, text] of entries) {
      if (typeof text !== 'string' || !name) continue;
      await writeConfig(name, text);
    }
    if (plan.settingsNext && typeof plan.settingsNext === 'object') {
      const next = JSON.parse(JSON.stringify(plan.settingsNext));
      if (Array.isArray(next.projects)) {
        for (const pr of next.projects) {
          const r = rows[`project:${pr.key}`];
          if (r && r.state === 'done' && r.number !== undefined && r.number !== null) pr.number = r.number;
        }
      }
      await writeConfig('board.config.json', `${JSON.stringify(next, null, 2)}\n`);
    }
    say('The copy is complete.');
    return { ok: true };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, message: e.message };
    return { ok: false, message: `${SMALL}${String(e && e.message ? e.message : 'an unexpected error').replace(/[.]$/, '')}; run the same command again to resume.` };
  }
}
