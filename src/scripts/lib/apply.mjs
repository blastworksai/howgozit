// Creates the labels, Projects, milestones, issues and settings file a proposal describes. Pinned in references/contract.md, rules S1 to S9.
import { checkSettings } from '../../board/shape-settings.mjs';

const KEY_RE = /^[a-z0-9-]{1,30}$/;
const SEP = ' · ';
const SETTINGS_PATH = 'board.config.json';
const TOP = ['owner', 'repo', 'name', 'timezone', 'projects', 'standalone', 'habits', 'focus', 'modes', 'ideas'];
const HOME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODE_COLOURS = ['0E8A16', '5319E7', 'FBCA04', 'D93F0B', '1D76DB', 'B60205', '006B75', '5D6D7E'];
const HABIT_PREFIX = 'habit:';
const IDEAS_TITLE = 'Ideas';
const HABITS_TITLE = 'Habits';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isText = (x) => typeof x === 'string' && x.trim() !== '';
const clone = (x) => JSON.parse(JSON.stringify(x));

function realDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function unknownKeys(obj, allowed, at, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${at}: "${k}" is not a field setup knows.`);
}

function checkTask(t, at, errors, titles, withMilestone) {
  if (!isObj(t)) { errors.push(`${at}: must be an object.`); return; }
  unknownKeys(t, withMilestone ? ['title', 'milestone', 'due'] : ['title'], at, errors);
  if (!isText(t.title)) errors.push(`${at}.title: must be a non-empty text.`);
  else if (titles.has(t.title)) errors.push(`${at}.title: "${t.title}" is used twice; task titles must be different.`);
  else titles.add(t.title);
  if (withMilestone && t.due !== undefined && !realDate(t.due)) errors.push(`${at}.due: must be a real date written YYYY-MM-DD.`);
  if (withMilestone && t.milestone !== undefined && !isText(t.milestone)) errors.push(`${at}.milestone: must be a non-empty text.`);
}

export function validateProposal(p) {
  const errors = [];
  if (!isObj(p)) return { ok: false, errors: ['proposal: must be an object.'] };
  unknownKeys(p, TOP, 'proposal', errors);
  for (const k of ['owner', 'repo']) {
    if (!isText(p[k]) || !/^[A-Za-z0-9._-]+$/.test(p[k]) || /^\.+$/.test(p[k])) errors.push(`${k}: must be a GitHub name of letters, digits, dots, dashes or underscores.`);
  }
  for (const k of ['name', 'timezone']) if (p[k] !== undefined && !isText(p[k])) errors.push(`${k}: must be a non-empty text.`);

  const keys = new Set();
  const projectTitles = new Set();
  const taskTitles = new Set();
  if (!Array.isArray(p.projects)) errors.push('projects: must be a list.');
  else {
    p.projects.forEach((pr, i) => {
      const at = `projects[${i}]`;
      if (!isObj(pr)) { errors.push(`${at}: must be an object.`); return; }
      unknownKeys(pr, ['key', 'title', 'milestones', 'tasks', 'home'], at, errors);
      if (pr.home !== undefined) {
        if (typeof pr.home !== 'string' || !HOME_RE.test(pr.home) || pr.home.split('/').some((seg) => /^\.+$/.test(seg))) errors.push(`${at}.home: must be written owner/name.`);
        else if (isText(p.owner) && pr.home.split('/')[0].toLowerCase() !== p.owner.toLowerCase()) errors.push(`${at}.home: setup only works with repositories of ${p.owner}; move this project by hand.`);
      }
      if (typeof pr.key !== 'string' || !KEY_RE.test(pr.key)) errors.push(`${at}.key: must be 1 to 30 lower-case letters, digits or dashes.`);
      else if (keys.has(pr.key)) errors.push(`${at}.key: "${pr.key}" is used twice.`);
      else keys.add(pr.key);
      if (!isText(pr.title)) errors.push(`${at}.title: must be a non-empty text.`);
      else if (pr.title.includes(SEP)) errors.push(`${at}.title: must not contain " · ".`);
      else if (projectTitles.has(pr.title)) errors.push(`${at}.title: "${pr.title}" is used twice.`);
      else projectTitles.add(pr.title);

      const ms = new Set();
      if (pr.milestones !== undefined && !Array.isArray(pr.milestones)) errors.push(`${at}.milestones: must be a list.`);
      else (pr.milestones || []).forEach((m, j) => {
        const mat = `${at}.milestones[${j}]`;
        if (!isObj(m)) { errors.push(`${mat}: must be an object.`); return; }
        unknownKeys(m, ['title', 'due'], mat, errors);
        if (!isText(m.title)) errors.push(`${mat}.title: must be a non-empty text.`);
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
    if (h.score !== undefined) {
      const sc = h.score;
      if (!isObj(sc) || Object.keys(sc).some((k) => k !== 'min' && k !== 'max') || !Number.isInteger(sc.min) || !Number.isInteger(sc.max) || sc.min < 1 || sc.min >= sc.max || sc.max > 10) {
        errors.push(`${at}.score: must be { "min": whole, "max": whole } with 1 <= min < max <= 10.`);
      }
    }
    if (typeof h.id !== 'string' || !KEY_RE.test(h.id)) errors.push(`${at}.id: must be 1 to 30 lower-case letters, digits or dashes.`);
    else if (ids.has(h.id)) errors.push(`${at}.id: "${h.id}" is used twice.`);
    else ids.add(h.id);
    if (!isText(h.title)) errors.push(`${at}.title: must be a non-empty text.`);
    if (h.project !== undefined && typeof h.project !== 'string') errors.push(`${at}.project: must be a project key.`);
  });
  if (p.modes !== undefined) {
    const seen = new Set();
    if (!Array.isArray(p.modes) || p.modes.length < 1 || p.modes.length > 8) errors.push('modes: must be a list of 1 to 8 texts.');
    else {
      p.modes.forEach((m, i) => {
        const at = `modes[${i}]`;
        if (!isText(m)) { errors.push(`${at}: must be a non-empty text.`); return; }
        const t = m.trim().toLowerCase();
        if (m.trim().length > 40) errors.push(`${at}: must be at most 40 characters.`);
        else if (t.startsWith(HABIT_PREFIX)) errors.push(`${at}: must not start with "${HABIT_PREFIX}".`);
        else if (t === 'idea') errors.push(`${at}: must not be "idea".`);
        else if (seen.has(t)) errors.push(`${at}: "${m}" is used twice; modes must be different.`);
        else seen.add(t);
      });
    }
  }
  if (p.ideas !== undefined && p.ideas !== true) errors.push('ideas: must be true when given.');
  const wantsIdeas = p.ideas === true;
  const wantsHabits = Array.isArray(p.habits) && p.habits.some((h) => isObj(h) && h.score !== undefined);
  if (Array.isArray(p.projects)) {
    p.projects.forEach((pr, i) => {
      if (!isObj(pr) || !isText(pr.title)) return;
      const t = pr.title.trim().toLowerCase();
      if ((wantsIdeas && t === IDEAS_TITLE.toLowerCase()) || (wantsHabits && t === HABITS_TITLE.toLowerCase())) {
        errors.push(`projects[${i}].title: "${pr.title}" is reserved for the ${pr.title.trim()} Project setup makes itself.`);
      }
    });
  }
  if (p.focus !== undefined && (!Array.isArray(p.focus) || !p.focus.every((f) => typeof f === 'string' && KEY_RE.test(f)))) {
    errors.push('focus: must be a list of project keys.');
  }
  return { ok: errors.length === 0, errors };
}

// A plain stop: the run ends with this sentence and nothing more is written.
class Stop extends Error {}

const isGitHub = (e) => e && e.name === 'GitHubError';

export async function applyProposal(http, proposal, {
  dry = false, record = null, saveRecord = async () => {}, say = () => {},
  wait = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = 180000,
} = {}) {
  const v = validateProposal(proposal);
  if (!v.ok) return { ok: false, message: v.errors[0] };
  try {
    return await walk(http, proposal, { dry, record, saveRecord, say, wait, settleMs });
  } catch (e) {
    if (e instanceof Stop || isGitHub(e)) return { ok: false, message: e.message };
    throw e;
  }
}

async function walk(http, p, { dry, record: given, saveRecord, say, wait, settleMs }) {
  const slug = `${p.owner}/${p.repo}`;
  const R = `/repos/${p.owner}/${p.repo}`;
  const record = given ? clone(given) : { version: 1, repo: slug, created: [] };
  if (record.repo !== slug) throw new Stop(`The undo record on disk belongs to ${record.repo}, not ${slug}; move it away or run setup in another folder.`);

  const steps = [];
  const byHand = [];
  let created = 0;
  const step = (type, name, action, note = '') => {
    steps.push({ type, name, action, note });
    if (action !== 'exists' && !dry) created += 1;
    const outcome = action === 'exists' ? 'already there' : dry ? 'would be created' : action === 'update' ? 'updated' : 'created';
    say(`${type} "${name}": ${outcome}${note ? ` (${note})` : ''}`);
  };

  const listAll = async (path, maxPages, what) => {
    const r = await http.paged(path, { maxPages });
    if (r.partial) throw new Stop(`There are more ${what} than setup can check safely, so nothing further was written.`);
    return r.items;
  };
  const fromRecord = (type, name, same = (a, b) => a === b, repoSlug = slug) => record.created.find((c) => c.type === type && same(c.name, name) && String(c.repo ?? slug).toLowerCase() === repoSlug.toLowerCase());
  const remember = async (type, name, res, extra = {}) => {
    const r = isObj(res) ? res : {};
    const entry = { type, name, number: r.number ?? null, id: r.node_id ?? r.id ?? null, url: r.html_url ?? r.url ?? null, ...extra };
    record.created.push(entry);
    await saveRecord(clone(record));
    return entry;
  };

  // 1. the repository (S1)
  let repoJson;
  try {
    repoJson = (await http.get(R)).json;
  } catch (e) {
    if (isGitHub(e) && e.kind === 'not-found') throw new Stop(`GitHub could not find ${slug}, or the token cannot see it.`);
    throw e;
  }
  if (!repoJson || repoJson.private !== true) throw new Stop(`${slug} is not a private repository; setup only works on a private one.`);
  // NEW (CP7): every distinct home repository, in proposal order, must exist and be private
  const homes = new Map();
  for (const pr of p.projects) {
    if (!pr.home) continue;
    const lower = pr.home.toLowerCase();
    if (lower === slug.toLowerCase() || homes.has(lower)) continue;
    let hj;
    try {
      hj = (await http.get(`/repos/${pr.home}`)).json;
    } catch (e) {
      if (isGitHub(e) && e.kind === 'not-found') throw new Stop(`GitHub could not find ${pr.home}, or the token cannot see it.`);
      throw e;
    }
    if (!hj || hj.private !== true) throw new Stop(`${pr.home} is not a private repository; setup only works on a private one.`);
    homes.set(lower, { slug: pr.home, R: `/repos/${pr.home}`, nodeId: hj.node_id ?? null, isData: false, labels: [], milestones: [], issues: [] });
  }
  const owner = repoJson.owner || {};
  const ownerBase = `${owner.type === 'Organization' ? '/orgs/' : '/users/'}${p.owner}`;

  // existing settings, read now because they name the labels
  let existing = null;
  try {
    const f = (await http.get(`${R}/contents/${SETTINGS_PATH}`)).json;
    let parsed;
    try { parsed = JSON.parse(Buffer.from(String(f.content || ''), 'base64').toString('utf8')); } catch { parsed = null; }
    if (!isObj(parsed)) throw new Stop(`${SETTINGS_PATH} exists but could not be read as settings; fix or remove it first.`);
    existing = { sha: f.sha, json: parsed };
  } catch (e) {
    if (!(isGitHub(e) && e.kind === 'not-found')) throw e;
  }
  if (!existing && !(isText(p.name) && isText(p.timezone))) throw new Stop('A first setup needs "name" and "timezone" in the proposal.');
  const knownKeys = new Set([...p.projects.map((x) => x.key), ...((existing && Array.isArray(existing.json.projects)) ? existing.json.projects.map((x) => x && x.key) : [])]);
  for (const h of p.habits || []) if (h.project !== undefined && !knownKeys.has(h.project)) throw new Stop(`habits: "${h.id}" names the project "${h.project}", which is neither in the proposal nor in the settings.`);
  for (const f of p.focus || []) if (!knownKeys.has(f)) throw new Stop(`focus: "${f}" is neither a project of the proposal nor one in the settings.`);

  const labelSettings = (existing && isObj(existing.json.labels)) ? existing.json.labels : {};
  const ideaLabel = isText(labelSettings.idea) ? labelSettings.idea : 'idea';
  const prefix = typeof labelSettings.habitPrefix === 'string' ? labelSettings.habitPrefix : 'habit:';

  // look everything up first
  const labelNames = [ideaLabel, ...(p.habits || []).map((h) => `${prefix}${h.id}`)];
  const labels = await listAll(`${R}/labels?per_page=100`, 5, 'labels');
  const wantsIdeas = p.ideas === true;
  const wantsHabits = (p.habits || []).some((h) => h.score !== undefined);
  const projectList = (p.projects.length || wantsIdeas || wantsHabits) ? await listAll(`${ownerBase}/projectsV2?per_page=100`, 10, 'Projects') : [];
  const wantsMilestones = p.projects.some((x) => (x.milestones || []).length);
  const milestones = wantsMilestones ? await listAll(`${R}/milestones?state=all&per_page=100`, 10, 'milestones') : [];
  const wantsTasks = p.projects.some((x) => (x.tasks || []).length) || (p.standalone || []).length;
  const issues = wantsTasks ? (await listAll(`${R}/issues?state=all&per_page=100`, 100, 'issues')).filter((i) => !i.pull_request) : [];

  // NEW (CP7): what each home repository already holds
  for (const info of homes.values()) {
    const mine = p.projects.filter((x) => x.home && x.home.toLowerCase() === info.slug.toLowerCase());
    if ((p.modes || []).length) info.labels = await listAll(`${info.R}/labels?per_page=100`, 5, 'labels');
    if (mine.some((x) => (x.milestones || []).length)) info.milestones = await listAll(`${info.R}/milestones?state=all&per_page=100`, 10, 'milestones');
    if (mine.some((x) => (x.tasks || []).length)) info.issues = (await listAll(`${info.R}/issues?state=all&per_page=100`, 100, 'issues')).filter((i) => !i.pull_request);
  }
  const otherHomes = [...homes.values()];
  const dataHome = { slug, R, nodeId: repoJson.node_id ?? null, isData: true, labels, milestones, issues };
  for (const pr of p.projects) if (pr.home && pr.home.toLowerCase() === slug.toLowerCase()) { homes.set(slug.toLowerCase(), dataHome); break; }

  // 2. labels (S2)
  const norm = (s) => String(s).trim().toLowerCase();
  const labelSeen = new Set(labels.map((l) => norm(l.name)));
  for (const name of labelNames) {
    if (labelSeen.has(norm(name)) || fromRecord('label', name, (a, b) => norm(a) === norm(b))) { step('label', name, 'exists'); continue; }
    labelSeen.add(norm(name));
    if (!dry) await remember('label', name, await http.send('POST', `${R}/labels`, { name, color: 'ededed' }));
    step('label', name, 'create');
  }
  // NEW (CP7): one label per mode, in the data repo and then in each home repo
  const modeNames = (p.modes || []).map((m) => m.trim());
  for (const target of [dataHome, ...otherHomes]) {
    if (!modeNames.length) break;
    const seen = new Set(target.labels.map((l) => norm(l.name)));
    for (const [i, name] of modeNames.entries()) {
      const note = target.isData ? '' : `in ${target.slug}`;
      if (seen.has(norm(name)) || fromRecord('label', name, (a, b) => norm(a) === norm(b), target.slug)) { step('label', name, 'exists', note); continue; }
      seen.add(norm(name));
      if (!dry) await remember('label', name, await http.send('POST', `${target.R}/labels`, { name, color: MODE_COLOURS[i] }), target.isData ? {} : { repo: target.slug });
      step('label', name, 'create', note);
    }
  }

  // 3. Projects and their Due fields (S3)
  const live = [];
  const byGraphQL = (e) => isGitHub(e) && (e.kind === 'invalid' || e.kind === 'not-found');
  // NEW (CP7): link a Project to its home repository
  const linkHome = async (ctx, found) => {
    const { pr } = ctx;
    const home = homes.get(pr.home.toLowerCase());
    const name = `${pr.title} → ${pr.home}`;
    const rec = fromRecord('link', name, (a, b) => a === b, pr.home);
    let linked = Boolean(rec);
    if (!linked && found) {
      const list = found.repositories;
      if (Array.isArray(list)) linked = list.some((r) => r === home.nodeId || (r && (r.node_id === home.nodeId || r.id === home.nodeId)));
      else if (ctx.nodeId && home.nodeId) {
        try {
          const data = await http.graphql('query($id:ID!){node(id:$id){... on ProjectV2{repositories(first:100){nodes{id}}}}}', { id: ctx.nodeId });
          const nodes = data && data.node && data.node.repositories && data.node.repositories.nodes;
          if (Array.isArray(nodes)) linked = nodes.some((r) => r && r.id === home.nodeId);
        } catch (e) {
          if (!byGraphQL(e)) throw e;
        }
      }
    }
    if (linked) { step('link', name, 'exists'); return; }
    if (!dry) {
      try {
        await http.graphql('mutation($projectId:ID!,$repositoryId:ID!){linkProjectV2ToRepository(input:{projectId:$projectId,repositoryId:$repositoryId}){repository{id}}}', { projectId: ctx.nodeId, repositoryId: home.nodeId });
      } catch (e) {
        if (!byGraphQL(e)) throw e;
        byHand.push(`Link the Project "${pr.title}" to ${pr.home} in GitHub's own page (the Project's Repositories tab), then run setup again.`);
        return;
      }
      await remember('link', name, { id: home.nodeId }, { project: ctx.nodeId, repo: pr.home });
    }
    step('link', name, 'create');
  };
  for (const pr of p.projects) {
    const ctx = { pr, number: null, nodeId: null, fieldId: null, items: null, dueNumber: null, skipped: false };
    live.push(ctx);
    const found = projectList.find((x) => x.title === pr.title && !x.closed_at && x.closed !== true);
    const rec = found ? null : fromRecord('project', pr.title);
    if (found || rec) {
      ctx.number = found ? found.number : rec.number;
      ctx.nodeId = found ? found.node_id : rec.id;
      step('project', pr.title, 'exists');
    } else if (dry) {
      step('project', pr.title, 'create');
    } else {
      try {
        const data = await http.graphql('mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}', { ownerId: owner.node_id, title: pr.title });
        const made = data.createProjectV2.projectV2;
        ctx.number = made.number;
        ctx.nodeId = made.id;
        await remember('project', pr.title, { number: made.number, id: made.id });
        step('project', pr.title, 'create');
      } catch (e) {
        if (!byGraphQL(e)) throw e;
        ctx.skipped = true;
        byHand.push(`Create a Project titled "${pr.title}" with a date field named Due in GitHub's own page, then run setup again.`);
        continue;
      }
    }
    if (pr.home) await linkHome(ctx, found);
    if (ctx.number === null) { step('field', `${pr.title}${SEP}Due`, 'create'); continue; }
    const fields = await listAll(`${ownerBase}/projectsV2/${ctx.number}/fields?per_page=100`, 2, 'Project fields');
    const due = fields.find((f) => f.name === 'Due');
    const recField = fromRecord('field', `${pr.title}${SEP}Due`);
    if (due || recField) {
      ctx.fieldId = due ? due.node_id : recField.id;
      ctx.dueNumber = due && due.id !== undefined ? due.id : null;
      step('field', `${pr.title}${SEP}Due`, 'exists');
    } else if (dry) {
      step('field', `${pr.title}${SEP}Due`, 'create');
    } else {
      try {
        const data = await http.graphql('mutation($projectId:ID!,$name:String!){createProjectV2Field(input:{projectId:$projectId,dataType:DATE,name:$name}){projectV2Field{... on ProjectV2Field{id name}}}}', { projectId: ctx.nodeId, name: 'Due' });
        ctx.fieldId = data.createProjectV2Field.projectV2Field.id;
        await remember('field', `${pr.title}${SEP}Due`, { id: ctx.fieldId });
        step('field', `${pr.title}${SEP}Due`, 'create');
      } catch (e) {
        if (!byGraphQL(e)) throw e;
        ctx.skipped = true;
        byHand.push(`Add a date field named Due to the Project "${pr.title}" in GitHub's own page, then run setup again.`);
      }
    }
  }

  // NEW (CP7): the Ideas and Habits role Projects
  const roleProject = async (title) => {
    const ctx = { title, number: null, nodeId: null, skipped: false };
    const found = projectList.find((x) => x.title === title && !x.closed_at && x.closed !== true);
    const rec = found ? null : fromRecord('project', title);
    if (found || rec) {
      ctx.number = found ? found.number : rec.number;
      ctx.nodeId = found ? found.node_id : rec.id;
      step('project', title, 'exists');
    } else if (dry) {
      step('project', title, 'create');
    } else {
      try {
        const data = await http.graphql('mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}', { ownerId: owner.node_id, title });
        const made = data.createProjectV2.projectV2;
        ctx.number = made.number;
        ctx.nodeId = made.id;
        await remember('project', title, { number: made.number, id: made.id });
        step('project', title, 'create');
      } catch (e) {
        if (!byGraphQL(e)) throw e;
        ctx.skipped = true;
        byHand.push(`Create a Project titled "${title}" in GitHub's own page, then run setup again.`);
      }
    }
    return ctx;
  };
  let ideasCtx = null;
  let habitsCtx = null;
  if (wantsIdeas) ideasCtx = await roleProject(IDEAS_TITLE);
  if (wantsHabits) {
    habitsCtx = await roleProject(HABITS_TITLE);
    const fname = `${HABITS_TITLE}${SEP}Score`;
    if (!habitsCtx.skipped) {
      if (habitsCtx.number === null) step('field', fname, 'create');
      else {
        const fields = await listAll(`${ownerBase}/projectsV2/${habitsCtx.number}/fields?per_page=100`, 2, 'Project fields');
        if (fields.some((f) => norm(f.name) === 'score') || fromRecord('field', fname)) step('field', fname, 'exists');
        else if (dry) step('field', fname, 'create');
        else {
          try {
            const data = await http.graphql('mutation($projectId:ID!,$name:String!){createProjectV2Field(input:{projectId:$projectId,dataType:NUMBER,name:$name}){projectV2Field{... on ProjectV2Field{id name}}}}', { projectId: habitsCtx.nodeId, name: 'Score' });
            await remember('field', fname, { id: data.createProjectV2Field.projectV2Field.id });
            step('field', fname, 'create');
          } catch (e) {
            if (!byGraphQL(e)) throw e;
            byHand.push('Add a number field named Score to the Project "Habits" in GitHub\'s own page, then run setup again.');
          }
        }
      }
    }
  }

  // an existing settings key must keep its Project number
  const existingProjects = (existing && Array.isArray(existing.json.projects)) ? existing.json.projects : [];
  for (const c of live) {
    const old = existingProjects.find((x) => x && x.key === c.pr.key);
    if (old && c.number !== null && old.number !== c.number) {
      throw new Stop(`The settings already point "${c.pr.key}" at Project ${old.number}, but "${c.pr.title}" is Project ${c.number}; setup will not overwrite that.`);
    }
  }

  // 4 and 5. milestones, tasks, items, Due values (S4, S5)
  const expect = [];
  const ensureItems = async (c) => {
    if (!c.items) c.items = await listAll(`${ownerBase}/projectsV2/${c.number}/items?per_page=100${c.dueNumber !== null ? `&fields=${c.dueNumber}` : ''}`, 20, 'Project items');
    return c.items;
  };
  const sameIssue = (it, number, repoSlug = slug) => it.content_type === 'Issue' && it.content && it.content.number === number
    && (!it.content.repository || !it.content.repository.full_name || it.content.repository.full_name.toLowerCase() === repoSlug.toLowerCase());

  for (const c of live) {
    if (c.skipped) continue;
    const { pr } = c;
    const home = pr.home ? homes.get(pr.home.toLowerCase()) : null;
    const PR = home ? home.R : R;
    const rslug = home ? home.slug : slug;
    const msList = home ? home.milestones : milestones;
    const isList = home ? home.issues : issues;
    const repoExtra = home && !home.isData ? { repo: home.slug } : {};
    const msNumbers = new Map();
    for (const m of pr.milestones || []) {
      const title = home ? m.title : `${pr.title}${SEP}${m.title}`;
      const found = msList.find((x) => x.title === title) || fromRecord('milestone', title, undefined, rslug);
      if (found) { msNumbers.set(m.title, found.number); step('milestone', title, 'exists'); continue; }
      if (dry) { msNumbers.set(m.title, null); step('milestone', title, 'create'); continue; }
      const body = m.due ? { title, due_on: `${m.due}T12:00:00Z` } : { title };
      const res = await http.send('POST', `${PR}/milestones`, body);
      await remember('milestone', title, res, repoExtra);
      msList.push({ title, number: res.number });
      msNumbers.set(m.title, res.number);
      step('milestone', title, 'create');
    }

    for (const t of pr.tasks || []) {
      const wantMs = t.milestone === undefined ? null : msNumbers.get(t.milestone);
      const matchable = !(t.milestone !== undefined && wantMs === null);
      let issue = matchable ? isList.find((i) => i.state === 'open' && i.title === t.title && ((i.milestone && i.milestone.number) || null) === wantMs) : null;
      let number = issue ? issue.number : null;
      let madeNow = false;
      if (!issue) {
        const rec = fromRecord('issue', t.title, undefined, rslug);
        if (rec) { number = rec.number; issue = rec; }
      }
      if (issue) step('issue', t.title, 'exists');
      else {
        if (!dry) {
          const res = await http.send('POST', `${PR}/issues`, wantMs === null ? { title: t.title } : { title: t.title, milestone: wantMs });
          await remember('issue', t.title, res, repoExtra);
          number = res.number;
          isList.push({ number, title: t.title, state: 'open', milestone: wantMs === null ? null : { number: wantMs } });
        }
        madeNow = true;
        step('issue', t.title, 'create');
      }

      const itemName = `${t.title}${SEP}${pr.title}`;
      let present = null;
      if (!madeNow && c.number !== null) present = (await ensureItems(c)).find((it) => sameIssue(it, number, rslug)) || null;
      if (present) {
        step('item', itemName, 'exists');
        if (t.due && c.fieldId && c.dueNumber !== null && present.node_id) {
          const entry = (present.fields || []).find((f) => f && (f.id === c.dueNumber || f.name === 'Due'));
          const current = entry && typeof entry.value === 'string' ? entry.value.slice(0, 10) : '';
          if (current === t.due) step('due', `${t.title}: ${t.due}`, 'exists');
          else {
            if (!dry) {
              await http.graphql('mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$date:Date!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{date:$date}}){projectV2Item{id}}}', { projectId: c.nodeId, itemId: present.node_id, fieldId: c.fieldId, date: t.due });
              if (entry) entry.value = `${t.due}T00:00:00+00:00`;
            }
            step('due', `${t.title}: ${t.due}`, current ? 'update' : 'create');
          }
        }
        continue;
      }
      let itemId = null;
      if (!dry) {
        try {
          const res = await http.send('POST', `${ownerBase}/projectsV2/${c.number}/items`, { type: 'Issue', owner: p.owner, repo: home ? home.slug.split('/')[1] : p.repo, number });
          itemId = res && (res.node_id ?? res.id);
          expect.push({ c, number, t, checkDue: false, repo: rslug });
        } catch (e) {
          // GitHub refuses a duplicate while its list still lags: the item is there, only not listed yet
          if (!(isGitHub(e) && e.kind === 'invalid' && number !== null)) throw e;
          expect.push({ c, number, t, checkDue: Boolean(t.due), repo: rslug });
          if (c.items) c.items.push({ content_type: 'Issue', content: { number, repository: { full_name: rslug } } });
          step('item', itemName, 'exists', 'GitHub has it but does not list it yet');
          continue;
        }
        if (c.items) c.items.push({ content_type: 'Issue', content: { number, repository: { full_name: rslug } } });
      }
      step('item', itemName, 'create');
      if (t.due) {
        if (!dry) {
          await http.graphql('mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$date:Date!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{date:$date}}){projectV2Item{id}}}', { projectId: c.nodeId, itemId, fieldId: c.fieldId, date: t.due });
        }
        step('due', `${t.title}: ${t.due}`, 'create');
      }
    }
  }

  for (const t of p.standalone || []) {
    const found = issues.find((i) => i.state === 'open' && i.title === t.title && !i.milestone) || fromRecord('issue', t.title);
    if (found) { step('issue', t.title, 'exists'); continue; }
    if (!dry) {
      const res = await http.send('POST', `${R}/issues`, { title: t.title });
      await remember('issue', t.title, res);
      issues.push({ number: res.number, title: t.title, state: 'open', milestone: null });
    }
    step('issue', t.title, 'create');
  }

  // 6. settings (S6)
  const placeholder = (i) => 1000000 + i;
  const additions = live.filter((c) => !c.skipped).map((c, i) => (c.pr.home ? { key: c.pr.key, number: c.number ?? placeholder(i), home: c.pr.home } : { key: c.pr.key, number: c.number ?? placeholder(i) }));
  const roleRef = (ctx, i) => (ctx && !ctx.skipped ? { owner: p.owner, number: ctx.number ?? placeholder(900 + i) } : null);
  const ideasRef = roleRef(ideasCtx, 0);
  const habitsRef = roleRef(habitsCtx, 1);
  const modesIn = p.modes ? p.modes.map((m) => m.trim()) : null;
  const skippedKeys = new Set(live.filter((c) => c.skipped).map((c) => c.pr.key));
  const habitsIn = (p.habits || []).map((h) => {
    const o = h.project === undefined ? { id: h.id, title: h.title } : { id: h.id, title: h.title, project: h.project };
    if (h.score !== undefined && habitsRef) o.score = { min: h.score.min, max: h.score.max };
    return o;
  });
  const focusIn = (p.focus || []).filter((f) => !skippedKeys.has(f));

  let next;
  if (existing) {
    next = clone(existing.json);
    if (!Array.isArray(next.projects)) next.projects = [];
    for (const a of additions) if (!next.projects.some((x) => x && x.key === a.key)) next.projects.push(a);
    if (habitsIn.length) {
      if (!Array.isArray(next.habits)) next.habits = [];
      for (const h of habitsIn) if (!next.habits.some((x) => x && x.id === h.id)) next.habits.push(h);
    }
    if (focusIn.length) {
      if (!Array.isArray(next.focus)) next.focus = [];
      for (const f of focusIn) if (!next.focus.includes(f)) next.focus.push(f);
    }
    if (modesIn && next.modes === undefined) next.modes = modesIn;
    if (ideasRef && next.ideas === undefined) next.ideas = ideasRef;
    if (habitsRef && next.habitsProject === undefined) next.habitsProject = habitsRef;
  } else {
    next = { version: 1, name: p.name, timezone: p.timezone, projects: additions, focus: focusIn, habits: habitsIn };
    if (modesIn) next.modes = modesIn;
    if (ideasRef) next.ideas = ideasRef;
    if (habitsRef) next.habitsProject = habitsRef;
  }
  const check = checkSettings(next);
  if (!check.ok) throw new Stop(`${SETTINGS_PATH} would not be valid (${check.errors[0]}); nothing was written to it.`);

  if (existing && JSON.stringify(next) === JSON.stringify(existing.json)) {
    step('file', SETTINGS_PATH, 'exists');
  } else {
    if (!dry) {
      const payload = { message: 'Board settings', content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8').toString('base64') };
      if (existing) payload.sha = existing.sha;
      const res = await http.send('PUT', `${R}/contents/${SETTINGS_PATH}`, payload);
      if (!existing) {
        const c = isObj(res) && isObj(res.content) ? res.content : {};
        await remember('file', SETTINGS_PATH, { id: c.sha ?? null, html_url: c.html_url ?? null });
      }
    }
    if (existing) step('file', SETTINGS_PATH, 'update', 'it already existed; setup only added to it, so the undo record does not list it');
    else step('file', SETTINGS_PATH, 'create');
  }

  // 7. settle: GitHub lists new items late, so wait until every one shows
  const notes = [];
  let settled = null;
  if (!dry && settleMs > 0) {
    settled = true;
    if (expect.length) {
      say('Waiting for GitHub to list the new items (this can take a couple of minutes)…');
      const projects = [...new Set(expect.map((x) => x.c))];
      let waited = 0;
      for (;;) {
        for (const c of projects) {
          const open = expect.filter((x) => x.c === c && !x.done);
          if (!open.length) continue;
          let items = [];
          try {
            items = await listAll(`${ownerBase}/projectsV2/${c.number}/items?per_page=100${c.dueNumber !== null ? `&fields=${c.dueNumber}` : ''}`, 20, 'Project items');
          } catch (e) {
            if (!isGitHub(e)) throw e;
          }
          for (const x of open) {
            const it = items.find((i) => sameIssue(i, x.number, x.repo));
            if (!it) continue;
            x.done = true;
            if (!x.checkDue || !c.fieldId || c.dueNumber === null || !it.node_id) continue;
            const entry = (it.fields || []).find((f) => f && (f.id === c.dueNumber || f.name === 'Due'));
            const current = entry && typeof entry.value === 'string' ? entry.value.slice(0, 10) : '';
            if (current === x.t.due) continue;
            await http.graphql('mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$date:Date!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{date:$date}}){projectV2Item{id}}}', { projectId: c.nodeId, itemId: it.node_id, fieldId: c.fieldId, date: x.t.due });
            step('due', `${x.t.title}: ${x.t.due}`, current ? 'update' : 'create');
          }
        }
        if (expect.every((x) => x.done)) break;
        if (waited >= settleMs) { settled = false; break; }
        await wait(5000);
        waited += 5000;
      }
      if (!settled) {
        const dates = expect.some((x) => !x.done && x.checkDue);
        const line = `GitHub has not listed every item yet. The board will show those tasks under their project within a few minutes${dates ? '; run setup again later to check their dates' : ''}.`;
        notes.push(line);
        say(line);
      }
    }
  }

  return { ok: true, steps, created, byHand, settled, notes };
}
