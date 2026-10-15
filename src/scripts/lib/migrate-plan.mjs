// Plans the migration of cards and goals out of the source repo. Reads only; writes nothing. Built to reference/mapping-redesign/cp8-interface.md, sections 2 and 3.
import { createHash } from 'node:crypto';

const SEP = ' · ';
const KEY_RE = /^[a-z0-9-]{1,30}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_STATUSES = ['Todo', 'In Progress', 'Done'];
const ISSUE_MARKER = /^<!-- howgozit-migrated-from: (.+)#(\d+) -->$/;
const MILESTONE_MARKER = /^<!-- howgozit-migrated-from: (.+) milestone (\d+) -->$/;

// F11: what is ours, by exact shape only (first line and last line). Anything else is nobody's but the member's.
export function commentKind(body) {
  if (typeof body !== 'string') return null;
  const lines = body.replace(/\r\n/g, '\n').trim().split('\n');
  const first = lines[0].trim();
  const last = lines[lines.length - 1].trim();
  if (lines.length >= 2 && /^\S+ wrote on \d{4}-\d{2}-\d{2}:$/.test(first) && /^<!-- howgozit-comment: \d+ -->$/.test(last)) return 'copied';
  if (lines.length >= 2 && first.startsWith('Copied from https://github.com/') && last === '<!-- howgozit-link-to-original -->') return 'link';
  if (lines.length >= 2 && first.startsWith('Moved to https://github.com/') && /^<!-- howgozit-copied-to: [^\s#]+#\d+ -->$/.test(last)) return 'copied-to';
  return null;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isText = (x) => typeof x === 'string' && x.trim() !== '';
const lower = (s) => String(s).toLowerCase();
const norm = (s) => String(s).trim().normalize('NFC').toLowerCase();
const sha = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const ownerOf = (repo) => String(repo).split('/')[0];
const isRepo = (v) => typeof v === 'string' && REPO_RE.test(v) && !v.split('/').some((seg) => /^\.+$/.test(seg));

// A non-enumerable property travels with the object in memory but never reaches JSON or a printed line.
function hide(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: false, writable: true, configurable: true });
  return obj;
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

function unknownKeys(obj, allowed, at, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${at}: "${k}" is not a field the migration map knows.`);
}

export function validateMap(json) {
  const errors = [];
  if (!isObj(json)) return { ok: false, errors: ['map: must be an object.'] };
  unknownKeys(json, ['version', 'source', 'projects', 'ideas', 'habits', 'createRepos'], 'map', errors);
  if (json.version !== 1) errors.push('version: must be 1.');
  const sourceOk = isRepo(json.source);
  if (!sourceOk) errors.push('source: must be written owner/name.');
  const sourceOwner = sourceOk ? ownerOf(json.source) : null;
  if (sourceOk && !OWNER_RE.test(sourceOwner)) errors.push('source: the owner is not a GitHub login.');

  const homes = new Set();
  const numbers = new Set();
  if (!isObj(json.projects) || Object.keys(json.projects).length === 0) errors.push('projects: must be an object with at least one project.');
  else {
    for (const [key, p] of Object.entries(json.projects)) {
      const at = `projects.${key}`;
      if (!KEY_RE.test(key)) errors.push(`projects: the key "${key}" must be 1 to 30 lower-case letters, digits or dashes.`);
      if (!isObj(p)) { errors.push(`${at}: must be an object.`); continue; }
      unknownKeys(p, ['old', 'home', 'projectOwner'], at, errors);
      if (!isRepo(p.home)) errors.push(`${at}.home: must be written owner/name.`);
      else {
        homes.add(lower(p.home));
        if (!OWNER_RE.test(ownerOf(p.home))) errors.push(`${at}.home: the owner is not a GitHub login.`);
      }
      if (typeof p.projectOwner !== 'string' || !OWNER_RE.test(p.projectOwner)) errors.push(`${at}.projectOwner: must be a GitHub login.`);
      else if (isRepo(p.home) && lower(p.projectOwner) !== lower(ownerOf(p.home))) errors.push(`${at}.projectOwner: must be the owner of the home repository.`);
      if (!isObj(p.old)) errors.push(`${at}.old: must be an object.`);
      else {
        unknownKeys(p.old, ['owner', 'number'], `${at}.old`, errors);
        if (typeof p.old.owner !== 'string' || !OWNER_RE.test(p.old.owner)) errors.push(`${at}.old.owner: must be a GitHub login.`);
        else if (sourceOwner && lower(p.old.owner) !== lower(sourceOwner)) errors.push(`${at}.old.owner: must be the owner of the source repository.`);
        if (p.old.number !== null) {
          if (!(Number.isInteger(p.old.number) && p.old.number > 0)) errors.push(`${at}.old.number: must be null or a positive whole number.`);
          else if (typeof p.old.owner === 'string') {
            const pair = `${lower(p.old.owner)}#${p.old.number}`;
            if (numbers.has(pair)) errors.push(`${at}.old.number: another project already uses this Project number.`);
            else numbers.add(pair);
          }
        }
      }
    }
  }

  if (!isObj(json.ideas)) errors.push('ideas: must be an object.');
  else {
    unknownKeys(json.ideas, ['owner', 'title'], 'ideas', errors);
    if (typeof json.ideas.owner !== 'string' || !OWNER_RE.test(json.ideas.owner)) errors.push('ideas.owner: must be a GitHub login.');
    if (!isText(json.ideas.title)) errors.push('ideas.title: must be a non-empty text.');
  }
  if (!isObj(json.habits)) errors.push('habits: must be an object.');
  else {
    unknownKeys(json.habits, ['owner', 'title', 'scoreField', 'scored'], 'habits', errors);
    if (typeof json.habits.owner !== 'string' || !OWNER_RE.test(json.habits.owner)) errors.push('habits.owner: must be a GitHub login.');
    if (!isText(json.habits.title)) errors.push('habits.title: must be a non-empty text.');
    if (!isText(json.habits.scoreField)) errors.push('habits.scoreField: must be a non-empty text.');
    if (!Array.isArray(json.habits.scored) || !json.habits.scored.every(isText)) errors.push('habits.scored: must be a list of habit ids.');
  }
  if (!Array.isArray(json.createRepos)) errors.push('createRepos: must be a list.');
  else {
    const seen = new Set();
    json.createRepos.forEach((r, i) => {
      const at = `createRepos[${i}]`;
      if (!isRepo(r)) errors.push(`${at}: must be written owner/name.`);
      else if (!homes.has(lower(r))) errors.push(`${at}: must be the home of one of the projects.`);
      else if (seen.has(lower(r))) errors.push(`${at}: is listed twice.`);
      else seen.add(lower(r));
    });
  }
  return { ok: errors.length === 0, errors };
}

const isMoving = (map, p) => lower(p.home) !== lower(map.source);

// Which open source issues sit on which projects, from the old Projects' items; the one join readWorld and buildPlan share.
function boards(map, world, issues) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const cards = new Map();
  for (const [key, p] of Object.entries(map.projects)) {
    const old = world.oldProjects && world.oldProjects[key];
    if (!old || !Array.isArray(old.items)) continue;
    for (const it of old.items) {
      if (lower(it.repo) !== lower(map.source)) continue;
      const issue = byNumber.get(it.number);
      if (!issue) continue;
      if (!cards.has(it.number)) cards.set(it.number, { issue, keys: [], items: {} });
      const c = cards.get(it.number);
      c.keys.push(key);
      c.items[key] = it;
    }
  }
  return cards;
}

const movingKeysOf = (map, keys) => keys.filter((k) => isMoving(map, map.projects[k]));

// ---------- reading ----------

const notFound = (e) => Boolean(e) && e.kind === 'not-found';

async function all(http, path) {
  const r = await http.paged(path, { maxPages: 100 });
  if (r.partial) {
    const e = new Error('The migration reads whole lists, and GitHub returned more pages than it will follow.');
    e.kind = 'partial';
    throw e;
  }
  return r.items;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return null;
  if (typeof v.name === 'string') return v.name;
  if (isObj(v.name) && typeof v.name.raw === 'string') return v.name.raw;
  return null;
}

function dateOf(v) {
  const s = typeof v === 'string' ? v : (isObj(v) && typeof v.raw === 'string' ? v.raw : null);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function optionNames(field) {
  return (Array.isArray(field.options) ? field.options : []).map((o) => textOf(o) ?? (isObj(o) && typeof o.name === 'string' ? o.name : null)).filter(Boolean);
}

function fieldRows(fields) {
  return fields.map((f) => ({ id: f.id, nodeId: f.node_id ?? null, name: f.name, dataType: f.data_type ?? null, options: optionNames(f) }));
}

export async function readWorld(clients, map, opts = {}) {
  const world = {
    boardRepo: opts.boardRepo, invalidMap: false, problems: [], source: null, settings: null, settingsError: false,
    issues: [], milestones: [], labels: [], oldProjects: {}, comments: {}, repos: {}, owners: {}, projectFields: {}, ideasItems: null,
  };
  if (!validateMap(map).ok) { world.invalidMap = true; return world; }
  const defaultRepos = new Set((Array.isArray(opts.defaultRepos) ? opts.defaultRepos : []).map(lower));
  const client = (owner) => (typeof clients.forOwner === 'function' ? clients.forOwner(owner) : clients.default);
  // F4: a repository listed in defaultRepos (one apply created) is always read with the default client.
  const repoClient = (repo) => (defaultRepos.has(lower(repo)) ? clients.default : client(ownerOf(repo)));
  const ownerTypes = {};
  const [srcOwner] = map.source.split('/');
  const srcHttp = repoClient(map.source);

  let repoJson;
  try {
    repoJson = (await srcHttp.get(`/repos/${map.source}`)).json;
  } catch (e) {
    if (!notFound(e)) throw e;
    world.source = { repo: map.source, exists: false };
    return world;
  }
  world.source = { repo: map.source, exists: true, private: repoJson.private === true, ownerType: repoJson.owner && repoJson.owner.type ? repoJson.owner.type : null };
  if (world.source.ownerType) ownerTypes[lower(srcOwner)] = world.source.ownerType;

  try {
    const file = (await srcHttp.get(`/repos/${map.source}/contents/board.config.json`)).json;
    world.settings = JSON.parse(Buffer.from(String(file.content || ''), 'base64').toString('utf8'));
    if (!isObj(world.settings)) { world.settings = null; world.settingsError = true; }
  } catch (e) {
    if (!notFound(e) && !(e instanceof SyntaxError)) throw e;
    world.settingsError = true;
  }

  world.issues = (await all(srcHttp, `/repos/${map.source}/issues?state=all&per_page=100`))
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number, nodeId: i.node_id ?? null, title: i.title, body: i.body ?? null, state: i.state,
      labels: (i.labels || []).map((l) => (typeof l === 'string' ? { name: l } : { name: l.name })),
      milestone: i.milestone ? { number: i.milestone.number, title: i.milestone.title ?? null } : null,
    }))
    .sort((a, b) => a.number - b.number);
  world.milestones = (await all(srcHttp, `/repos/${map.source}/milestones?state=all&per_page=100`))
    .map((m) => ({ number: m.number, title: m.title, state: m.state, dueOn: m.due_on ?? null, description: m.description ?? null }))
    .sort((a, b) => a.number - b.number);
  world.labels = (await all(srcHttp, `/repos/${map.source}/labels?per_page=100`))
    .map((l) => ({ name: l.name, color: l.color ?? null, description: l.description ?? null }));

  // Target repositories: every home of a moving project, plus the repositories to create.
  const wanted = new Map();
  for (const p of Object.values(map.projects)) if (isMoving(map, p)) wanted.set(lower(p.home), p.home);
  for (const r of map.createRepos) wanted.set(lower(r), r);
  for (const [lk, full] of wanted) {
    const http = repoClient(full);
    let j;
    try {
      j = (await http.get(`/repos/${full}`)).json;
    } catch (e) {
      if (!notFound(e)) throw e;
      world.repos[lk] = { repo: full, exists: false };
      continue;
    }
    if (j.owner && j.owner.type) ownerTypes[lower(ownerOf(full))] = j.owner.type;
    const issues = await all(http, `/repos/${full}/issues?state=all&per_page=100`);
    const milestones = await all(http, `/repos/${full}/milestones?state=all&per_page=100`);
    const labels = await all(http, `/repos/${full}/labels?per_page=100`);
    const last = (text) => String(text ?? '').trimEnd().split('\n').pop();
    world.repos[lk] = {
      repo: full, exists: true, private: j.private === true, hasIssues: j.has_issues !== false,
      issueMarkers: issues
        .map((i) => ({ i, m: ISSUE_MARKER.exec(last(i.body)) }))
        .filter((x) => x.m)
        .map((x) => ({ source: x.m[1], number: Number(x.m[2]), copy: x.i.number })),
      milestones: milestones.map((m) => {
        const mm = MILESTONE_MARKER.exec(last(m.description));
        return { number: m.number, title: m.title, state: m.state, marker: mm ? { source: mm[1], number: Number(mm[2]) } : null };
      }),
      labels: labels.map((l) => l.name),
    };
  }

  // Projects of each owner involved.
  const base = {};
  const projectsOf = async (owner) => {
    const lk = lower(owner);
    if (world.owners[lk]) return world.owners[lk];
    const order = ownerTypes[lk] === 'User' ? ['users', 'orgs'] : ['orgs', 'users'];
    for (const b of order) {
      try {
        const list = await all(client(owner), `/${b}/${owner}/projectsV2?per_page=100`);
        base[lk] = b;
        world.owners[lk] = { login: owner, projects: list.map((p) => ({ number: p.number, title: p.title, nodeId: p.node_id ?? null })) };
        return world.owners[lk];
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    }
    world.owners[lk] = { login: owner, projects: null };
    return world.owners[lk];
  };
  const fieldsOf = async (owner, number) => {
    const rows = fieldRows(await all(client(owner), `/${base[lower(owner)]}/${owner}/projectsV2/${number}/fields?per_page=100`));
    world.projectFields[`${lower(owner)}|${number}`] = rows;
    return rows;
  };
  const owners = new Set([srcOwner, map.ideas.owner, map.habits.owner]);
  for (const p of Object.values(map.projects)) owners.add(p.projectOwner);
  const seenOwner = new Set();
  for (const o of owners) {
    if (seenOwner.has(lower(o))) continue;
    seenOwner.add(lower(o));
    await projectsOf(o);
  }

  // Old Projects: the number comes from the map, or from the source's own settings (D2).
  const settingsProjects = world.settings && Array.isArray(world.settings.projects) ? world.settings.projects : [];
  for (const [key, p] of Object.entries(map.projects)) {
    const fromSettings = settingsProjects.find((s) => isObj(s) && s.key === key);
    const number = p.old.number ?? (fromSettings && Number.isInteger(fromSettings.number) ? fromSettings.number : null);
    const entry = { owner: p.old.owner, number, numberFrom: p.old.number !== null ? 'map' : (number !== null ? 'settings' : null), exists: false, title: null, nodeId: null, items: [] };
    world.oldProjects[key] = entry;
    if (number === null) continue;
    const listed = (await projectsOf(p.old.owner)).projects;
    const row = listed ? listed.find((x) => x.number === number) : null;
    if (!row) continue;
    entry.exists = true;
    entry.title = row.title;
    entry.nodeId = row.nodeId ?? null;
    const fields = await fieldsOf(p.old.owner, number);
    const statusId = (fields.find((f) => lower(f.name) === 'status') || {}).id;
    const dueId = (fields.find((f) => lower(f.name) === 'due') || {}).id;
    const ids = [statusId, dueId].filter((x) => x !== undefined);
    const items = await all(client(p.old.owner), `/${base[lower(p.old.owner)]}/${p.old.owner}/projectsV2/${number}/items?per_page=100${ids.length ? `&fields=${ids.join(',')}` : ''}`);
    for (const it of items) {
      const c = it && it.content;
      if (!isObj(c) || !Number.isInteger(c.number)) continue;
      const out = { repo: (c.repository && (c.repository.full_name || c.repository.nameWithOwner)) || map.source, number: c.number, status: null, due: null };
      for (const f of it.fields || []) {
        if (f.id === statusId) out.status = textOf(f.value);
        else if (f.id === dueId) out.due = dateOf(f.value);
      }
      entry.items.push(out);
    }
  }

  // Comments of every open card on a moving board.
  const cards = boards(map, world, world.issues);
  for (const [number, c] of cards) {
    if (c.issue.state !== 'open' || movingKeysOf(map, c.keys).length === 0) continue;
    const list = await all(srcHttp, `/repos/${map.source}/issues/${number}/comments?per_page=100`);
    world.comments[number] = list.map((x) => ({ id: x.id, login: x.user ? x.user.login : null, createdAt: x.created_at ?? null, body: x.body ?? '' }));
  }

  // Existing Projects with the planned titles: their fields, and the Ideas members.
  const want = new Map();
  for (const [key, p] of Object.entries(map.projects)) {
    if (!isMoving(map, p) || !world.oldProjects[key].exists) continue;
    want.set(`${lower(p.projectOwner)}|${world.oldProjects[key].title}`, { owner: p.projectOwner, title: world.oldProjects[key].title });
  }
  want.set(`${lower(map.ideas.owner)}|${map.ideas.title}`, { owner: map.ideas.owner, title: map.ideas.title, ideas: true });
  want.set(`${lower(map.habits.owner)}|${map.habits.title}`, { owner: map.habits.owner, title: map.habits.title });
  for (const w of want.values()) {
    const listed = world.owners[lower(w.owner)].projects;
    const row = listed ? listed.find((x) => x.title === w.title && !(isOldProject(map, world, w.owner, x.number))) : null;
    if (!row) continue;
    await fieldsOf(w.owner, row.number);
    if (w.ideas) {
      const items = await all(client(w.owner), `/${base[lower(w.owner)]}/${w.owner}/projectsV2/${row.number}/items?per_page=100`);
      world.ideasItems = items.filter((it) => it && isObj(it.content) && Number.isInteger(it.content.number))
        .map((it) => `${(it.content.repository && it.content.repository.full_name) || map.source}#${it.content.number}`);
    }
  }
  return world;
}

function isOldProject(map, world, owner, number) {
  return Object.values(world.oldProjects).some((o) => lower(o.owner) === lower(owner) && o.number === number);
}

// ---------- planning ----------

function stripTitle(title, homeRepo, movingTitles) {
  const at = title.indexOf(SEP);
  if (at < 0) return title;
  const left = norm(title.slice(0, at));
  const right = title.slice(at + SEP.length);
  return right.trim() !== '' && (movingTitles.get(left) || []).some((h) => lower(h) === lower(homeRepo)) ? right : title;
}

function statusFor(oldName, options) {
  if (!oldName) return null;
  let want = lower(oldName.trim());
  if (want === 'doing') want = 'in progress';
  return options.find((o) => lower(o) === want) ?? null;
}

export function buildPlan(world, map) {
  const refusals = [];
  const valid = validateMap(map);
  const blank = () => ({ ok: false, refusals, source: isObj(map) ? map.source ?? null : null, issues: [], milestones: [], targets: [], ideas: [], notes: [], digest: null });
  if (!valid.ok) { refusals.push(...valid.errors); return blank(); }
  if (!isObj(world) || world.invalidMap) { refusals.push('The migration map is not valid.'); return blank(); }
  const source = map.source;
  const notes = [];

  if (world.boardRepo !== undefined && lower(world.boardRepo) !== lower(source)) refusals.push(`BOARD_REPO names ${world.boardRepo}, but the map moves from ${source}.`);
  if (!world.source || world.source.exists === false) {
    refusals.push(`GitHub could not find ${source}, or the token cannot see it.`);
    return { ...blank(), notes };
  }

  const settingsProjects = world.settings && Array.isArray(world.settings.projects) ? world.settings.projects : [];
  const needsSettings = Object.values(map.projects).some((p) => p.old.number === null);
  if (needsSettings && world.settingsError) refusals.push(`GitHub could not find board.config.json in ${source}, or it cannot be read.`);
  if (world.settings) {
    for (const key of Object.keys(map.projects)) {
      if (!settingsProjects.some((s) => isObj(s) && s.key === key)) notes.push(`${key} is not in your settings, so its Project is not read.`);
    }
    for (const s of settingsProjects) {
      if (isObj(s) && typeof s.key === 'string' && !(s.key in map.projects)) refusals.push(`board.config.json in ${source} lists the project ${s.key}, which the migration map does not know.`);
    }
  }

  const moving = Object.entries(map.projects).filter(([, p]) => isMoving(map, p));
  const staying = Object.entries(map.projects).filter(([, p]) => !isMoving(map, p));
  const skipped = new Set();
  for (const [key, p] of Object.entries(map.projects)) {
    const old = world.oldProjects[key];
    if (!old || old.number === null || old.number === undefined) {
      // a project that stays in the source needs no number; a moving one cannot be planned without it
      if (!isMoving(map, p)) { skipped.add(key); continue; }
      if (!(needsSettings && world.settingsError)) refusals.push(`The project ${key} has no Project number in the map, and board.config.json in ${source} has no project with that key.`);
      continue;
    }
    if (!old.exists) refusals.push(`The old Project ${old.number} of ${old.owner}, for ${key}, does not exist or the token cannot see it.`);
  }

  const issues = world.issues;
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const cards = boards(map, world, issues);
  const labelInfo = new Map((world.labels || []).map((l) => [lower(l.name), l]));
  const ideaLabel = lower((world.settings && world.settings.labels && world.settings.labels.idea) || 'idea');
  const oldTitle = (key) => world.oldProjects[key].title;
  const repoOf = (home) => (world.repos || {})[lower(home)];

  // Target repositories and their refusals.
  const homes = new Map();
  for (const [, p] of moving) homes.set(lower(p.home), p.home);
  for (const r of map.createRepos) homes.set(lower(r), r);
  const creating = new Set(map.createRepos.map(lower));
  for (const [lk, full] of homes) {
    const r = repoOf(full);
    if (!r || !r.exists) {
      if (!creating.has(lk)) refusals.push(`GitHub could not find ${full}, or the token cannot see it.`);
      continue;
    }
    if (!r.private) refusals.push(`${full} is public; the migration only moves cards into private repositories.`);
    const seen = new Map();
    for (const m of r.issueMarkers || []) {
      if (lower(m.source) !== lower(source)) continue;
      seen.set(m.number, (seen.get(m.number) || 0) + 1);
    }
    for (const [n, count] of seen) if (count > 1) refusals.push(`${full} holds two copies of ${source}#${n}; one has to be removed by hand before the migration goes on.`);
  }

  // Cards.
  const planIssues = [];
  const planNotes = notes;
  const movingSet = new Set();
  const oldTitles = new Map();
  for (const [key] of moving) {
    if (!world.oldProjects[key] || !world.oldProjects[key].exists) continue;
    const t = norm(oldTitle(key));
    oldTitles.set(t, [...(oldTitles.get(t) || []), map.projects[key].home]);
  }
  const statusOptions = (key) => {
    const p = map.projects[key];
    const row = ((world.owners || {})[lower(p.projectOwner)] || { projects: [] }).projects || [];
    const hit = row.find((x) => x.title === oldTitle(key) && !(lower(p.projectOwner) === lower(world.oldProjects[key].owner) && x.number === world.oldProjects[key].number));
    const fields = hit ? (world.projectFields || {})[`${lower(p.projectOwner)}|${hit.number}`] : null;
    const status = fields ? fields.find((f) => lower(f.name) === 'status') : null;
    return status && status.options.length ? status.options : DEFAULT_STATUSES;
  };
  const cardTarget = new Map();
  for (const [number, c] of [...cards].sort((a, b) => a[0] - b[0])) {
    const movingKeys = movingKeysOf(map, c.keys).filter((k) => world.oldProjects[k].exists);
    if (movingKeys.length === 0) continue;
    const issue = c.issue;
    const ref = `${source}#${number}`;
    if (issue.state !== 'open') {
      planIssues.push({ moves: false, old: { repo: source, number, ref }, title: issue.title, reason: `stays in ${source} as history` });
      continue;
    }
    const homeSet = new Map();
    for (const k of c.keys) homeSet.set(lower(map.projects[k].home), map.projects[k].home);
    if (homeSet.size > 1) {
      refusals.push(`${ref} sits on Projects that move to different repositories (${[...homeSet.values()].join(' and ')}), and a copy lives in one repository.`);
      continue;
    }
    movingSet.add(number);
    const home = map.projects[movingKeys[0]].home;
    cardTarget.set(number, home);
    const comments = (world.comments[number] || []).filter((x) => commentKind(x.body) === null);
    const first = c.items[movingKeys[0]];
    const projects = movingKeys.map((k) => {
      const options = statusOptions(k);
      const expected = statusFor(c.items[k].status, options);
      if (c.items[k].status && expected === null) planNotes.push(`Status "${oneLine(c.items[k].status)}" of #${number} has no option in the new Project; it will be left empty.`);
      const o = world.oldProjects[k];
      return { key: k, owner: map.projects[k].projectOwner, title: oldTitle(k), status: expected, statusOld: c.items[k].status ?? null, due: c.items[k].due ?? null, oldProject: { owner: o.owner, number: o.number } };
    });
    const r = repoOf(home);
    const copies = r && r.exists ? (r.issueMarkers || []).filter((m) => lower(m.source) === lower(source) && m.number === number) : [];
    const entry = {
      moves: true, old: { repo: source, number, ref, nodeId: issue.nodeId ?? null }, title: issue.title, bodySha256: sha(issue.body),
      labels: issue.labels.map((l) => {
        const info = labelInfo.get(lower(l.name)) || {};
        return { name: l.name, color: info.color ?? null, description: info.description ?? null };
      }),
      milestone: issue.milestone ? { oldNumber: issue.milestone.number, oldTitle: issue.milestone.title, title: null } : null,
      statusOld: first.status ?? null,
      due: c.items[movingKeys[0]].due ?? movingKeys.map((k) => c.items[k].due).find(Boolean) ?? null,
      commentCount: comments.length,
      comments: comments.map((x) => hide({ id: x.id, login: x.login, createdAt: x.createdAt, bodySha256: sha(x.body) }, 'body', x.body)),
      target: { repo: home, projects },
      existing: copies.length === 1 ? { number: copies[0].copy } : null,
    };
    hide(entry, 'body', issue.body);
    planIssues.push(entry);
  }

  // A target repository with Issues switched off cannot take a copy (apply is refused at the first issue POST).
  const receiving = new Set(planIssues.filter((e) => e.moves).map((e) => lower(e.target.repo)));
  for (const [lk, full] of homes) {
    const r = repoOf(full);
    if (r && r.exists && r.hasIssues === false && receiving.has(lk)) refusals.push(`${full} has Issues switched off; turn them on in its Settings, then run plan again.`);
  }

  // Goals.
  const holders = new Map();
  for (const i of issues) if (i.milestone) holders.set(i.milestone.number, [...(holders.get(i.milestone.number) || []), i]);
  const rawGoals = [];
  for (const m of world.milestones) {
    const held = holders.get(m.number) || [];
    const targets = new Map();
    for (const i of held) if (movingSet.has(i.number)) targets.set(lower(cardTarget.get(i.number)), cardTarget.get(i.number));
    let reason = null;
    let wholeTitle = false;
    if (targets.size === 0) {
      if (held.length === 0) {
        const whole = oldTitles.get(norm(m.title));
        const at = m.title.indexOf(SEP);
        const hit = at >= 0 ? oldTitles.get(norm(m.title.slice(0, at))) : null;
        if (whole) { for (const h of whole) targets.set(lower(h), h); wholeTitle = true; }
        else if (hit) for (const h of hit) targets.set(lower(h), h);
        else reason = 'no card moves with it';
      } else reason = 'no card moves with it';
    }
    rawGoals.push({ m, targets: [...targets.values()].sort((a, b) => lower(a).localeCompare(lower(b))), reason, wholeTitle });
  }
  const stripped = new Map();
  const tally = new Map();
  for (const g of rawGoals) {
    for (const h of g.targets) {
      const t = g.wholeTitle ? g.m.title : stripTitle(g.m.title, h, oldTitles);
      stripped.set(`${g.m.number}|${lower(h)}`, t);
      const k = `${lower(h)}|${norm(t)}`;
      tally.set(k, (tally.get(k) || 0) + 1);
    }
  }
  const planMilestones = [];
  for (const g of rawGoals) {
    const old = { number: g.m.number, title: g.m.title };
    if (g.targets.length === 0) { planMilestones.push({ moves: false, old, reason: g.reason }); continue; }
    const copies = g.targets.map((h) => {
      let title = stripped.get(`${g.m.number}|${lower(h)}`);
      if (tally.get(`${lower(h)}|${norm(title)}`) > 1) {
        if (title !== g.m.title) planNotes.push(`In ${h}, the goals "${oneLine(g.m.title)}" and another would both be called "${oneLine(title)}"; both keep their full title.`);
        title = g.m.title;
      }
      const r = repoOf(h);
      let existing = null;
      if (r && r.exists) {
        const ours = (r.milestones || []).find((x) => x.marker && lower(x.marker.source) === lower(source) && x.marker.number === g.m.number);
        const same = ours || (r.milestones || []).find((x) => lower(x.title) === lower(title));
        if (same) {
          existing = { number: same.number, ours: Boolean(ours) };
          if (!ours) planNotes.push(`${h} already has a goal titled "${oneLine(title)}"; it will be used as it is.`);
        }
      }
      return { repo: h, title, existing };
    });
    const entry = { moves: true, old, state: g.m.state, dueOn: g.m.dueOn, descriptionSha256: sha(g.m.description), copies };
    hide(entry, 'description', g.m.description);
    planMilestones.push(entry);
  }
  for (const e of planIssues) {
    if (e.moves && e.milestone) {
      const g = planMilestones.find((x) => x.moves && x.old.number === e.milestone.oldNumber);
      const c = g && g.copies.find((x) => lower(x.repo) === lower(e.target.repo));
      e.milestone.title = c ? c.title : null;
    }
  }

  // Targets.
  const targets = [];
  for (const r of map.createRepos) {
    const x = repoOf(r);
    targets.push({ kind: 'repo', repo: r, private: true, exists: Boolean(x && x.exists) });
  }
  const projectTarget = (owner, title, role) => {
    const listed = ((world.owners || {})[lower(owner)] || {}).projects || [];
    const hit = listed.find((x) => x.title === title && !isOldProject(map, world, owner, x.number));
    const fields = hit ? (world.projectFields || {})[`${lower(owner)}|${hit.number}`] || [] : [];
    return { role, owner, title, exists: Boolean(hit), number: hit ? hit.number : null, hasFields: fields.map((f) => lower(f.name)) };
  };
  const byProject = new Map();
  for (const [key, p] of moving) {
    if (!world.oldProjects[key] || !world.oldProjects[key].exists) continue;
    const title = oldTitle(key);
    const k = `${lower(p.projectOwner)}|${title}`;
    if (!byProject.has(k)) {
      const t = projectTarget(p.projectOwner, title, 'project');
      byProject.set(k, { kind: 'project', role: 'project', keys: [], owner: p.projectOwner, title, exists: t.exists, number: t.number, needsDue: !t.hasFields.includes('due'), links: [] });
    }
    const t = byProject.get(k);
    t.keys.push(key);
    if (!t.links.some((h) => lower(h) === lower(p.home))) t.links.push(p.home);
  }
  targets.push(...byProject.values());
  const ideasT = projectTarget(map.ideas.owner, map.ideas.title, 'ideas');
  targets.push({ kind: 'project', role: 'ideas', keys: [], owner: map.ideas.owner, title: map.ideas.title, exists: ideasT.exists, number: ideasT.number, needsDue: false, links: [] });
  const habitsT = projectTarget(map.habits.owner, map.habits.title, 'habits');
  targets.push({
    kind: 'project', role: 'habits', keys: [], owner: map.habits.owner, title: map.habits.title, exists: habitsT.exists, number: habitsT.number, needsDue: false,
    scoreField: map.habits.scoreField, scored: [...map.habits.scored], needsScore: !habitsT.hasFields.includes(lower(map.habits.scoreField)), links: [],
  });

  // Ideas that stay.
  const held = new Set(world.ideasItems || []);
  const ideas = [];
  for (const i of issues) {
    if (i.state !== 'open' || movingSet.has(i.number)) continue;
    if (!i.labels.some((l) => lower(l.name) === ideaLabel)) continue;
    ideas.push({ ref: `${source}#${i.number}`, number: i.number, title: i.title, already: held.has(`${source}#${i.number}`) });
  }
  if (map.habits.scored.length === 0) planNotes.push('No habit gets a score.');
  else {
    const settingsHabits = world.settings && Array.isArray(world.settings.habits) ? world.settings.habits : [];
    for (const id of map.habits.scored) {
      const h = settingsHabits.find((x) => isObj(x) && x.id === id);
      if (h) planNotes.push(`Habit "${oneLine(h.title ?? id)}" (${id}) gets a score from 1 to 10.`);
      else if (world.settings) refusals.push(`habits.scored names ${id}, which is not a habit in the settings.`);
    }
  }

  // R2-3: the old Project of every moving key, whether or not it holds a moving issue.
  const movingProjects = moving
    .filter(([key]) => world.oldProjects[key] && world.oldProjects[key].exists)
    .map(([key]) => { const o = world.oldProjects[key]; return { key, owner: o.owner, number: o.number ?? null, title: o.title }; });
  const plan = { ok: refusals.length === 0, refusals, source, issues: planIssues, milestones: planMilestones, targets, ideas, notes: planNotes, movingProjects, digest: null };
  if (plan.ok) plan.digest = planDigest(plan);
  return plan;
}

// ---------- digest and lines ----------

export function planDigest(plan) {
  const material = {
    source: plan.source,
    issues: plan.issues.filter((i) => i.moves).map((i) => ({
      old: i.old.ref, title: i.title, body: i.bodySha256, labels: i.labels, milestone: i.milestone ? { old: i.milestone.oldNumber, title: i.milestone.title } : null,
      status: i.statusOld, due: i.due, comments: i.comments.map((c) => ({ id: c.id, body: c.bodySha256 })),
      target: { repo: i.target.repo, projects: i.target.projects.map((p) => ({ key: p.key, owner: p.owner, title: p.title, status: p.statusOld ?? null, due: p.due ?? null, oldProject: p.oldProject ?? null })) },
    })),
    milestones: plan.milestones.filter((m) => m.moves).map((m) => ({
      old: m.old, state: m.state, dueOn: m.dueOn, description: m.descriptionSha256, copies: m.copies.map((c) => ({ repo: c.repo, title: c.title })),
    })),
    ideas: plan.ideas.map((i) => i.ref),
    oldProjects: (plan.movingProjects || []).map((o) => ({ key: o.key, owner: o.owner, number: o.number, title: o.title })).sort((a, b) => (a.key < b.key ? -1 : 1)),
    // R3-2: every target's definition, never what apply itself changes (exists, number, needsDue, needsScore, field lists).
    targets: (plan.targets || []).map((x) => ({
      kind: x.kind, role: x.role ?? null, keys: [...(x.keys || [])].sort(), owner: x.owner ?? null, title: x.title ?? null, repo: x.repo ?? null,
      links: [...(x.links || [])].sort(), scoreField: x.scoreField ?? null,
    })).sort((a, b) => {
      const ka = [a.kind, lower(a.owner ?? ''), a.title ?? '', a.repo ?? '', a.role ?? ''].join('\u0000');
      const kb = [b.kind, lower(b.owner ?? ''), b.title ?? '', b.repo ?? '', b.role ?? ''].join('\u0000');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }),
    ideasTarget: plan.targets.filter((x) => x.role === 'ideas').map((x) => ({ owner: x.owner, title: x.title })),
    habitsTarget: plan.targets.filter((x) => x.role === 'habits').map((x) => ({ owner: x.owner, title: x.title, scoreField: x.scoreField ?? null, scored: x.scored ?? [] })),
  };
  return createHash('sha256').update(JSON.stringify(canonical(material))).digest('hex');
}

export function planLines(plan) {
  const lines = [];
  if (!plan.ok) {
    for (const r of plan.refusals) lines.push(r);
    lines.push(`Plan refused: ${plan.refusals.length} problem${plan.refusals.length === 1 ? '' : 's'}. Nothing was written.`);
    return lines;
  }
  const source = plan.source;
  const t = (s) => oneLine(s);
  for (const i of plan.issues) {
    if (!i.moves) { lines.push(`${i.old.ref} ${i.reason}`); continue; }
    const projs = i.target.projects.map((p) => `"${t(p.title)}" (${p.owner})`).join(', ');
    lines.push(`${i.old.ref} → ${i.target.repo} · Project${i.target.projects.length === 1 ? '' : 's'} ${projs} · ${i.commentCount} comment${i.commentCount === 1 ? '' : 's'} · "${t(i.title)}"`);
  }
  for (const m of plan.milestones) {
    if (!m.moves) { lines.push(`Goal "${t(m.old.title)}" stays in ${source}: ${m.reason}`); continue; }
    for (const c of m.copies) lines.push(`Goal "${t(m.old.title)}" → ${c.repo} as "${t(c.title)}"`);
  }
  let toCreate = 0;
  for (const x of plan.targets) {
    if (x.kind === 'repo') {
      if (x.exists) lines.push(`Repository ${x.repo} exists and will be used.`);
      else { toCreate += 1; lines.push(`To create: repository ${x.repo} (private)`); }
      continue;
    }
    const withs = [];
    if (x.role === 'habits') { if (x.needsScore || !x.exists) withs.push(`a number field ${x.scoreField}`); }
    else if (x.role === 'project' && (x.needsDue || !x.exists)) withs.push('a Due date field');
    const link = x.links.length ? `linked to ${x.links.join(', ')}` : '';
    if (x.exists) {
      lines.push(`Project "${t(x.title)}" under ${x.owner} exists and will be used${withs.length ? `; it gets ${withs.join(' and ')}` : ''}${link ? `, ${link}` : ''}.`);
    } else {
      toCreate += 1;
      lines.push(`To create: Project "${t(x.title)}" under ${x.owner}${[...withs.map((w) => `with ${w}`), link].filter(Boolean).length ? `, ${[...withs.map((w) => `with ${w}`), link].filter(Boolean).join(', ')}` : ''}`);
    }
  }
  for (const i of plan.ideas) if (!i.already) lines.push(`To add to Ideas: ${i.ref} "${t(i.title)}"`);
  for (const n of plan.notes) lines.push(n);
  const a = plan.issues.filter((i) => i.moves).length;
  const b = plan.issues.length - a;
  const c = plan.milestones.filter((m) => m.moves).length;
  const d = plan.milestones.length - c;
  lines.push(`Plan: ${a} cards move, ${b} stay as history, ${c} goals move, ${d} stay, ${toCreate} targets to create. Nothing was written.`);
  return lines;
}
