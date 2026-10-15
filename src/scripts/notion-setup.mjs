// Builds the Howgozit tables in Notion once. Usage:
//   node scripts/notion-setup.mjs [--parent <page id>] [--habits id1,id2 | --settings <board.config.json>]
//                                 [--state <file>] [--dry-run] [--json]
//   node scripts/notion-setup.mjs plan  <proposal.json> [--config-dir <dir>] [--state <file>] [--json]
//   node scripts/notion-setup.mjs apply <proposal.json> [--config-dir <dir>] [--parent <page id>] [--state <file>] [--json]
// Built to reference/notion-native/interface.md section 1 and 2; contract R154. The token comes from BOARD_NOTION_TOKEN.
// plan (R156) reads the proposal and the row record beside the state file, lists every table, row and file apply would create, and writes and sends nothing.
// apply makes the tables as above, then one Projects row per project, one Goals row per milestone and one Tasks row per task, and writes board.config.json
// into --config-dir (default ./config, relative to where the command runs). A row record (.howgozit-notion-rows.json, beside the state file) is saved after every write.
// A state file records what was created, so a second run reads it back and writes nothing. Nothing the script did not create is ever changed.
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNotionHttp } from '../board/notion/http.mjs';
import { readJsonFile, writeJsonAtomic, createPacer } from './lib/migrate-io.mjs';
import { validateNotionProposal, planNotionProposal, applyNotionProposal, emptyRowsRecord, ROWS_FILE } from './lib/notion-proposal.mjs';

export const STATE_FILE = '.howgozit-notion.json';
const USAGE = 'Use: notion-setup.mjs [--parent <page id>] [--habits id1,id2 | --settings <board.config.json>] [--state <file>] [--dry-run] [--json], or notion-setup.mjs plan|apply <proposal.json> [--config-dir <dir>, default ./config] [--parent <page id>] [--state <file>] [--json].';
const NO_TOKEN = 'Set BOARD_NOTION_TOKEN to a Notion token that can create pages and databases.';
const NEEDS_PARENT = 'An internal connection cannot create a page at the top of a workspace: share a page with the connection in Notion and run this again with --parent <page id>.';
const BAD_PARENT = 'Notion would not create the page under that parent; share the page with the connection and check the id given to --parent.';
const UNEXPECTED = 'The setup stopped because of a problem it did not expect; run the same command again, it carries on from the state file.';
const NOTION_SENTENCES = {
  auth: 'Notion did not accept the token.',
  'not-found': 'Notion could not find something the setup needs; check what the token can see.',
  conflict: 'Notion refused the change because the page changed at the same time.',
  'rate-limited': 'Notion is limiting requests right now; run the same command again later.',
  unavailable: 'Notion could not be reached.',
  invalid: 'Notion did not accept that request.',
};

const KEYS = ['projects', 'goals', 'tasks', 'habitLog'];
const TITLES = { projects: 'Projects', goals: 'Goals', tasks: 'Tasks', habitLog: 'Habit log' };
const TITLE_PROP = { projects: 'Project name', goals: 'Goal name', tasks: 'Task name', habitLog: 'Name' };
const MODES = [['DO', 'red'], ['THINK', 'purple'], ['REVIEW', 'yellow'], ['LAUNCH', 'green'], ['Idea', 'gray']];
const PRIORITY = [{ name: 'High', color: 'red' }, { name: 'Medium', color: 'yellow' }, { name: 'Low', color: 'gray' }];

// The properties every table must hold (name -> type), checked before an existing set is adopted.
const EXPECTED = {
  projects: { 'Project name': 'title', ID: 'unique_id', Status: 'status', Priority: 'select', Dates: 'date', Owner: 'people', Tasks: 'relation', Goals: 'relation', Completion: 'rollup' },
  goals: { 'Goal name': 'title', ID: 'unique_id', Due: 'date', Done: 'checkbox', Project: 'relation', Tasks: 'relation', Completion: 'rollup' },
  tasks: { 'Task name': 'title', ID: 'unique_id', Status: 'status', Due: 'date', Priority: 'select', Tags: 'multi_select', Assignee: 'people', Project: 'relation', Goal: 'relation', 'Blocked by': 'relation', Blocking: 'relation' },
  habitLog: { Name: 'title', ID: 'unique_id', Habit: 'select', Date: 'date', Done: 'checkbox', Score: 'number' },
};

const flat = (id) => String(id).replace(/-/g, '').toLowerCase();
const text = (s) => [{ type: 'text', text: { content: s } }];
const dual = (data_source_id) => ({ relation: { data_source_id, type: 'dual_property', dual_property: {} } });
const rollup = (relation) => ({ rollup: { relation_property_name: relation, rollup_property_name: 'Status', function: 'percent_per_group' } });

class Stop extends Error {}

function parseArgs(argv) {
  const f = { parent: null, habits: null, settings: null, state: null, configDir: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--parent' || a === '--habits' || a === '--settings' || a === '--state' || a === '--config-dir') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value. ${USAGE}` };
      f[a === '--config-dir' ? 'configDir' : a.slice(2)] = v;
      i += 1;
    } else if (a === '--dry-run') f.dryRun = true;
    else if (a === '--json') f.json = true;
    else return { error: USAGE };
  }
  if (f.habits !== null && f.settings !== null) return { error: 'Give --habits or --settings, not both.' };
  return f;
}

function makeScrub(env) {
  const t = env && typeof env.BOARD_NOTION_TOKEN === 'string' ? env.BOARD_NOTION_TOKEN : '';
  const values = [...new Set([t, t.trim()].filter((v) => v !== ''))].sort((a, b) => b.length - a.length);
  const shapes = [/\bsecret_[A-Za-z0-9]{20,}/g, /\bntn_[A-Za-z0-9]{20,}/g];
  return (s) => {
    let out = String(s ?? '');
    for (const v of values) out = out.split(v).join('***');
    for (const re of shapes) out = out.replace(re, '***');
    return out;
  };
}

function habitOptions(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || id.includes(',') || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push({ name: id });
  }
  return out;
}

const titleOf = (rt) => (Array.isArray(rt) ? rt.map((t) => t.plain_text ?? (t.text && t.text.content) ?? '').join('') : '');

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const scrub = makeScrub(env);
  const rawOut = deps.out ?? ((l) => console.log(l));
  const rawErr = deps.err ?? ((l) => console.error(l));
  const out = (l) => rawOut(scrub(l));
  const err = (l) => rawErr(scrub(l));
  const fail = (l) => { err(l); return 1; };
  try {
    let command = null;
    let proposalFile = null;
    let rest = argv;
    if (argv[0] === 'plan' || argv[0] === 'apply') {
      command = argv[0];
      proposalFile = argv[1];
      if (!proposalFile || proposalFile.startsWith('--')) return fail(`${command} needs the proposal file. ${USAGE}`);
      rest = argv.slice(2);
    }
    const args = parseArgs(rest);
    if (args.error) return fail(args.error);
    if (command === null && args.configDir !== null) return fail(`--config-dir belongs to plan and apply. ${USAGE}`);
    if (command !== null && args.dryRun) return fail(`--dry-run is not used with ${command}; plan writes nothing. ${USAGE}`);

    let proposal = null;
    if (command !== null) {
      const pr = await readJsonFile(resolve(cwd, proposalFile));
      if (!pr.ok) return fail(pr.missing ? 'The proposal file was not found.' : 'The proposal file could not be read as JSON.');
      const v = validateNotionProposal(pr.json);
      if (!v.ok) { v.errors.forEach(err); return fail('The proposal is not in order; fix the places above and run again. Nothing was written.'); }
      proposal = pr.json;
    }
    const configDir = resolve(cwd, args.configDir || 'config');
    const rowsPath = join(dirname(resolve(cwd, args.state || STATE_FILE)), ROWS_FILE);

    if (command === 'plan') {
      const rr = await readJsonFile(rowsPath);
      if (!rr.ok && !rr.missing) return fail('The row record could not be read; move it away or fix it first.');
      const record = rr.ok && rr.json && typeof rr.json === 'object' ? rr.json : emptyRowsRecord();
      const st = await readJsonFile(resolve(cwd, args.state || STATE_FILE));
      const tablesThere = st.ok && st.json && typeof st.json.page === 'string';
      const steps = planNotionProposal(proposal, record);
      if (args.json) out(JSON.stringify({ ok: true, plan: true, tables: tablesThere ? 'recorded' : 'to create or adopt', configDir, steps }, null, 2));
      else {
        out('Plan only: nothing was written and Notion was not contacted.');
        out(tablesThere ? 'The Howgozit page and its four tables are recorded in the state file.' : 'The Howgozit page and its four tables would be created, or adopted if they are already there.');
        for (const s of steps) out(`- ${s.kind} ${s.kind === 'settings' ? `${join(configDir, s.title)}` : `"${s.title}"`}: ${s.exists ? 'already there' : 'new'}`);
        out(`${steps.filter((s) => !s.exists).length} of ${steps.length} steps would write.`);
      }
      return 0;
    }

    const token = typeof env.BOARD_NOTION_TOKEN === 'string' ? env.BOARD_NOTION_TOKEN.trim() : '';
    if (!token) return fail(NO_TOKEN);

    let habitIds = [];
    if (args.habits !== null) habitIds = args.habits.split(',');
    else if (proposal) habitIds = (proposal.habits || []).map((h) => h.id);
    else if (args.settings !== null) {
      const r = await readJsonFile(resolve(cwd, args.settings));
      if (!r.ok) return fail(r.missing ? 'The settings file was not found.' : 'The settings file could not be read as JSON.');
      const h = r.json && Array.isArray(r.json.habits) ? r.json.habits : [];
      habitIds = h.map((x) => (x && typeof x.id === 'string' ? x.id : '')).filter(Boolean);
    }
    const habits = habitOptions(habitIds);

    const http = createNotionHttp({ token, fetch: deps.fetch ?? globalThis.fetch, sleep: deps.sleep });
    const get = (p) => http.request('GET', p);
    const statePath = resolve(cwd, args.state || STATE_FILE);
    const saved = await readJsonFile(statePath);
    if (!saved.ok && !saved.missing) return fail('The state file could not be read; move it away or fix it first.');
    const parentId = args.parent ? args.parent.trim() : null;
    if (args.parent !== null && !parentId) return fail(`--parent needs a page id. ${USAGE}`);

    let writes = 0;
    const write = async (method, path, body) => { writes += 1; return http.request(method, path, body); };

    // ---- reading helpers ----
    const children = async (pageId) => {
      const found = [];
      let cursor = null;
      do {
        const r = await get(`/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
        found.push(...(Array.isArray(r.results) ? r.results : []));
        cursor = r.has_more && r.next_cursor ? r.next_cursor : null;
      } while (cursor);
      return found;
    };
    const checkTables = async (databases) => {
      for (const k of KEYS.filter((x) => databases[x])) {
        const db = await get(`/v1/databases/${encodeURIComponent(databases[k].database)}`);
        if (db.in_trash === true || db.archived === true) throw new Stop(`The ${TITLES[k]} table is in the Notion trash; take it out of the trash or delete the state file and the page, then run again. Nothing was changed.`);
        const ds = await get(`/v1/data_sources/${encodeURIComponent(databases[k].data_source)}`);
        const props = ds && ds.properties ? ds.properties : {};
        const titles = Object.values(props).filter((p) => p.type === 'title').map((p) => p.name);
        if (titles[0] !== TITLE_PROP[k]) throw new Stop(`The ${TITLES[k]} table does not have the "${TITLE_PROP[k]}" title property; nothing was changed.`);
      }
    };

    // ---- find what exists: the state file, else a page called Howgozit under the parent / workspace ----
    let state = saved.ok && saved.json && typeof saved.json === 'object' ? saved.json : null;
    if (state && (typeof state.page !== 'string' || !state.databases || !Array.isArray(state.done))) return fail('The state file is not one this script wrote; move it away first.');
    let adopted = false;

    if (state) {
      try {
        const kids = await children(state.page);
        const have = new Set(kids.filter((b) => b.type === 'child_database').map((b) => flat(b.id)));
        for (const k of KEYS) {
          const d = state.databases[k];
          if (d && !have.has(flat(d.database))) throw new Stop(`The ${TITLES[k]} table recorded in the state file is no longer on the Howgozit page; nothing was changed or created.`);
        }
        await checkTables(Object.fromEntries(Object.entries(state.databases)));
      } catch (e) {
        if (e && e.name === 'BackendError' && e.code === 'not-found') return fail('The Howgozit page or a table recorded in the state file is gone from Notion; nothing was changed or created. Delete the state file to start over.');
        throw e;
      }
    } else {
      const pages = [];
      let cursor = null;
      do {
        const r = await http.request('POST', '/v1/search', { query: 'Howgozit', filter: { property: 'object', value: 'page' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        pages.push(...(Array.isArray(r.results) ? r.results : []));
        cursor = r.has_more && r.next_cursor ? r.next_cursor : null;
      } while (cursor);
      const hits = pages.filter((p) => {
        if (p.in_trash === true || p.archived === true) return false;
        const t = p.properties && p.properties.title ? titleOf(p.properties.title.title) : '';
        if (t !== 'Howgozit') return false;
        const par = p.parent || {};
        return parentId ? par.type === 'page_id' && flat(par.page_id) === flat(parentId) : par.type === 'workspace';
      });
      if (hits.length > 1) return fail('Notion holds more than one page called Howgozit there; the script will not guess which is yours. Nothing was changed.');
      if (hits.length === 1) {
        const kids = (await children(hits[0].id)).filter((b) => b.type === 'child_database');
        const databases = {};
        const problems = [];
        for (const k of KEYS) {
          const m = kids.filter((b) => b.child_database && b.child_database.title === TITLES[k]);
          if (m.length !== 1) { problems.push(`${m.length} ${TITLES[k]}`); continue; }
          const db = await get(`/v1/databases/${encodeURIComponent(m[0].id)}`);
          const dsId = db.data_sources && db.data_sources[0] && db.data_sources[0].id;
          if (!dsId) { problems.push(`no data source for ${TITLES[k]}`); continue; }
          databases[k] = { database: m[0].id, data_source: dsId };
        }
        if (problems.length) return fail(`A page called Howgozit already exists but does not hold exactly the four tables (found: ${problems.join(', ')}); the script will not touch it. Nothing was changed.`);
        try {
          await checkTables(databases);
          for (const k of KEYS) {
            const ds = await get(`/v1/data_sources/${encodeURIComponent(databases[k].data_source)}`);
            for (const [name, type] of Object.entries(EXPECTED[k])) {
              const p = ds.properties && ds.properties[name];
              if (!p || p.type !== type) throw new Stop(`The existing ${TITLES[k]} table has no "${name}" ${type} property; the script will not touch it. Nothing was changed.`);
            }
          }
        } catch (e) {
          if (e instanceof Stop) return fail(e.message);
          throw e;
        }
        state = { version: 1, page: hits[0].id, parent: parentId, databases, done: ['page', 'db:projects', 'db:goals', 'db:tasks', 'db:habitLog', 'blockedBy', 'renames', 'rollups'] };
        adopted = true;
      }
    }

    // ---- the steps still to do ----
    if (!state) state = { version: 1, page: null, parent: parentId, databases: {}, done: [] };
    const done = new Set(state.done);
    const persist = async () => { state.done = [...done]; if (!args.dryRun) await writeJsonAtomic(statePath, state, scrub); };
    const mark = async (name) => { done.add(name); await persist(); };
    const ds = (k) => state.databases[k].data_source;
    const steps = [];
    steps.push({ name: 'page', say: 'create the page "Howgozit"', run: async () => {
      let created;
      try {
        created = await write('POST', '/v1/pages', { parent: parentId ? { type: 'page_id', page_id: parentId } : { workspace: true }, properties: { title: { title: text('Howgozit') } } });
      } catch (e) {
        if (e && e.name === 'BackendError' && (e.code === 'invalid' || e.code === 'not-found')) throw new Stop(parentId ? BAD_PARENT : NEEDS_PARENT);
        throw e;
      }
      state.page = created.id;
    } });
    const dbStep = (k, props) => steps.push({ name: `db:${k}`, say: `create the ${TITLES[k]} table`, run: async () => {
      const db = await write('POST', '/v1/databases', { parent: { type: 'page_id', page_id: state.page }, title: text(TITLES[k]), initial_data_source: { properties: props() } });
      state.databases[k] = { database: db.id, data_source: db.data_sources[0].id };
    } });
    dbStep('projects', () => ({
      'Project name': { title: {} }, ID: { unique_id: {} }, Status: { status: {} }, Priority: { select: { options: PRIORITY } },
      Dates: { date: {} }, Owner: { people: {} },
    }));
    dbStep('goals', () => ({
      'Goal name': { title: {} }, ID: { unique_id: {} }, Due: { date: {} }, Done: { checkbox: {} }, Project: dual(ds('projects')),
    }));
    dbStep('tasks', () => ({
      'Task name': { title: {} }, ID: { unique_id: {} }, Status: { status: {} }, Due: { date: {} }, Priority: { select: { options: PRIORITY } },
      Tags: { multi_select: { options: MODES.map(([name, color]) => ({ name, color })) } }, Assignee: { people: {} },
      Project: dual(ds('projects')), Goal: dual(ds('goals')),
    }));
    dbStep('habitLog', () => ({
      Name: { title: {} }, ID: { unique_id: {} }, Habit: { select: { options: habits } },
      Date: { date: {} }, Done: { checkbox: {} }, Score: { number: { format: 'number' } },
    }));
    steps.push({ name: 'blockedBy', say: 'add the Blocked by relation to Tasks', run: async () => {
      await write('PATCH', `/v1/data_sources/${ds('tasks')}`, { properties: { 'Blocked by': dual(ds('tasks')) } });
    } });
    steps.push({ name: 'renames', say: 'name the synced relations', run: async () => {
      // [table, relation made on it, table holding the synced twin, the name the twin should have]
      const pairs = [['goals', 'Project', 'projects', 'Goals'], ['tasks', 'Project', 'projects', 'Tasks'], ['tasks', 'Goal', 'goals', 'Tasks'], ['tasks', 'Blocked by', 'tasks', 'Blocking']];
      for (const [k, prop, twinKey, want] of pairs) {
        const mine = await get(`/v1/data_sources/${ds(k)}`);
        const rel = mine.properties && mine.properties[prop] && mine.properties[prop].relation;
        const twin = rel && rel.dual_property;
        if (!twin || !twin.synced_property_id) throw new Stop('Notion did not report the synced relation of a table the script made; run it again, or check the tables in Notion.');
        if (twin.synced_property_name === want) continue;
        await write('PATCH', `/v1/data_sources/${ds(twinKey)}`, { properties: { [twin.synced_property_id]: { name: want } } });
      }
    } });
    steps.push({ name: 'rollups', say: 'add the Completion rollups to Projects and Goals', run: async () => {
      for (const k of ['projects', 'goals']) {
        const now = await get(`/v1/data_sources/${ds(k)}`);
        if (now.properties && now.properties.Completion) continue;
        await write('PATCH', `/v1/data_sources/${ds(k)}`, { properties: { Completion: rollup('Tasks') } });
      }
    } });

    async function runApply() {
      const tablesMade = writes > 0;
      const rr = await readJsonFile(rowsPath);
      if (!rr.ok && !rr.missing) return fail('The row record could not be read; move it away or fix it first.');
      const record = rr.ok && rr.json && typeof rr.json === 'object' ? rr.json : emptyRowsRecord();
      const clock = deps.clock ?? { now: () => Date.now(), sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) };
      const pacer = createPacer(clock);
      const lines = [];
      const say = (l) => { if (!args.json) out(l); lines.push(l); };
      const ids = Object.fromEntries(KEYS.map((k) => [k, state.databases[k].data_source]));
      const res = await applyNotionProposal({
        proposal, http, ids, record, pace: pacer.pace, say, configDir,
        save: (r) => writeJsonAtomic(rowsPath, r, scrub),
        writeFile: (path, value) => writeJsonAtomic(path, value, scrub),
      });
      if (!res.ok) return fail(res.message);
      const total = res.created.project + res.created.goal + res.created.task;
      const env3 = [
        'BOARD_BACKEND=notion',
        'BOARD_NOTION_TOKEN=<your token>',
        `BOARD_CONFIG_DIR=${configDir}`,
        'BOARD_FORM_KEY=<run: node -e "console.log(require(\'crypto\').randomBytes(36).toString(\'base64url\'))">',
      ];
      if (args.json) out(JSON.stringify({ ok: true, tablesCreated: tablesMade, created: res.created, settings: res.settingsPath, notion: blockOf(state), env: env3 }, null, 2));
      else {
        out(tablesMade ? 'Created the Howgozit page and its four tables.' : 'The Howgozit page and its four tables are there.');
        out(total ? `Created ${res.created.project} ${res.created.project === 1 ? 'project' : 'projects'}, ${res.created.goal} ${res.created.goal === 1 ? 'goal' : 'goals'} and ${res.created.task} ${res.created.task === 1 ? 'task' : 'tasks'}.` : 'Every row was already there; nothing was created.');
        out(`The starter settings are in ${res.settingsPath}.`);
        out('Set these where the board runs:');
        env3.forEach((l) => out(`  ${l}`));
      }
      return 0;
    }

    const todo = steps.filter((s) => !done.has(s.name));
    if (args.dryRun) {
      if (args.json) out(JSON.stringify({ ok: true, dryRun: true, wouldDo: todo.map((s) => s.say), notion: todo.length ? null : blockOf(state) }, null, 2));
      else if (!todo.length) { out('Dry run: everything is already there; nothing would change.'); blockLines(state).forEach(out); }
      else { out('Dry run: nothing was written. It would:'); todo.forEach((s) => out(`- ${s.say}`)); }
      return 0;
    }
    for (const s of todo) {
      await s.run();
      await mark(s.name);
    }
    if (adopted) await persist();

    if (command === 'apply') return await runApply();

    const created = writes > 0;
    if (args.json) out(JSON.stringify({ ok: true, created, page: state.page, databases: state.databases, notion: blockOf(state) }, null, 2));
    else {
      out(created ? 'Created the Howgozit page and its four tables.' : (adopted ? 'Found the Howgozit page and its four tables; nothing was changed.' : 'The Howgozit page and its four tables are already there; nothing was changed.'));
      blockLines(state).forEach(out);
    }
    return 0;
  } catch (x) {
    if (x instanceof Stop) return fail(x.message);
    if (x && x.name === 'BackendError' && NOTION_SENTENCES[x.code]) return fail(`${NOTION_SENTENCES[x.code]} ${UNEXPECTED}`);
    return fail(UNEXPECTED);
  }
}

function blockOf(state) {
  return Object.fromEntries(KEYS.map((k) => [k, state.databases[k].data_source]));
}
function blockLines(state) {
  const b = blockOf(state);
  return ['"notion": {', ...KEYS.map((k, i) => `  "${k}": "${b[k]}"${i < KEYS.length - 1 ? ',' : ''}`), '}'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, fetch: globalThis.fetch, cwd: process.cwd(), out: (l) => console.log(l), err: (l) => console.error(l),
  });
}
