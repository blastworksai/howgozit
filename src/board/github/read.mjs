// read: turns the data repo and its Projects into the raw object the model takes (contract "Raw", R69).
// Takes an http object (get, paged); makes no request of its own and reads no clock.

import { BackendError } from '../model/adapter.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const str = (v, d = '') => (isStr(v) ? v : d);
const strOrNull = (v) => (isStr(v) ? v : null);

// R116: one limit of four for the whole read; a unit holds one slot for its whole duration
const REQUESTS_AT_ONCE = 4;

function makeLimit(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };
  return async function run(fn) {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

// A unit that never started because an earlier unit of its group had failed
class Skipped extends Error {}

// The units of one group: a failed unit stops further units of that group from starting
function makeGroupUnit(limit) {
  const gate = { failed: false };
  const unit = (fn) => limit(async () => {
    if (gate.failed) throw new Skipped('skipped');
    try {
      return await fn();
    } catch (e) {
      gate.failed = true;
      throw e;
    }
  });
  return unit;
}

// Runs fn over list as units; results in list order; rejects with the first real failure in list order.
async function unitsOf(unit, list, fn) {
  const settled = await Promise.allSettled(list.map((x) => unit(() => fn(x))));
  const bad = settled.find((x) => x.status === 'rejected' && !(x.reason instanceof Skipped)) || settled.find((x) => x.status === 'rejected');
  if (bad) throw bad.reason;
  return settled.map((x) => x.value);
}

const FILES = {
  settings: 'board.config.json',
  theme: 'theme.json',
  brief: 'state/brief.json',
  calendar: 'state/calendar.json',
  inbox: 'state/inbox.json',
  log: 'state/log.json',
  proposals: 'state/proposals.json',
};

const notFound = (err) => Boolean(err) && err.kind === 'not-found';

function labelName(l) {
  if (isStr(l)) return l;
  if (isObj(l) && isStr(l.name)) return l.name;
  return null;
}

export function rawIssue(apiIssue) {
  const a = isObj(apiIssue) ? apiIssue : {};
  const labels = Array.isArray(a.labels) ? a.labels.map(labelName).filter((n) => n !== null) : [];
  const row = {
    number: a.number,
    title: str(a.title),
    state: a.state === 'closed' ? 'closed' : 'open',
    state_reason: strOrNull(a.state_reason),
    is_pr: Object.prototype.hasOwnProperty.call(a, 'pull_request') && a.pull_request !== undefined,
    labels,
    milestone: isObj(a.milestone) && isPosInt(a.milestone.number) ? a.milestone.number : null,
    created_at: str(a.created_at),
    updated_at: str(a.updated_at),
    closed_at: strOrNull(a.closed_at),
    html_url: str(a.html_url),
  };
  // R133: the count of blockers, only when above 0 (a row without one keeps its old shape)
  const sum = isObj(a.issue_dependencies_summary) ? a.issue_dependencies_summary.blocked_by : undefined;
  if (typeof sum === 'number' && Number.isInteger(sum) && sum > 0) row.blockedBy = sum;
  return row;
}

function rawMilestone(m) {
  return {
    number: m.number,
    title: str(m.title),
    state: m.state === 'closed' ? 'closed' : 'open',
    due_on: strOrNull(m.due_on),
    closed_at: strOrNull(m.closed_at),
    html_url: str(m.html_url),
  };
}

async function readFile(http, repo, path) {
  try {
    const res = await http.get(`/repos/${repo}/contents/${path}`);
    const j = res && res.json;
    if (!isObj(j) || !isStr(j.content) || (j.encoding !== undefined && j.encoding !== 'base64')) return null;
    return Buffer.from(j.content, 'base64').toString('utf8');
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

const HOME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function roleRef(v) {
  if (!isObj(v) || !isStr(v.owner) || !LOGIN_RE.test(v.owner) || !isPosInt(v.number)) return null;
  return { owner: v.owner, number: v.number };
}

function validZone(tz) {
  if (!isStr(tz) || tz === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

// R6, R4, R7, R76, R68: what the reader takes from the settings text. A bad value is not used (the model reports it).
// Listed projects are { owner, number, home }; owner is null when the entry names none (the data repo's owner).
function readSettings(settingsText) {
  const out = { refs: [], modes: [], ideas: null, habits: null, timezone: 'UTC' };
  if (settingsText === null) return out;
  let parsed;
  try {
    parsed = JSON.parse(settingsText);
  } catch {
    return out;
  }
  if (!isObj(parsed)) return out;
  if (Array.isArray(parsed.projects)) {
    for (const p of parsed.projects) {
      if (!isObj(p) || !isPosInt(p.number)) continue;
      out.refs.push({
        owner: isStr(p.owner) && p.owner !== '' ? p.owner : null,
        number: p.number,
        home: isStr(p.home) && HOME_RE.test(p.home) ? p.home : null,
      });
    }
  }
  if (Array.isArray(parsed.modes)) {
    const seenModes = new Set();
    for (const m of parsed.modes) {
      if (isStr(m) && m.trim() !== '' && !seenModes.has(m.trim().toLowerCase())) {
        seenModes.add(m.trim().toLowerCase());
        out.modes.push(m.trim());
      }
    }
  }
  out.ideas = roleRef(parsed.ideas);
  out.habits = roleRef(parsed.habitsProject);
  out.timezone = validZone(parsed.timezone);
  return out;
}

// R68: the day 120 days before today in the board timezone, as YYYY-MM-DD.
function windowStart(now, timezone) {
  const at = new Date(now);
  const base = Number.isNaN(at.getTime()) ? new Date() : at;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(base);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 120);
  return d.toISOString().slice(0, 10);
}

function fieldEntry(fields, name) {
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (isObj(f) && f.name === name) return f;
  }
  return null;
}

function rawItem(item) {
  const o = isObj(item) ? item : {};
  const content = isObj(o.content) ? o.content : null;
  const type = ['Issue', 'PullRequest', 'DraftIssue'].includes(o.content_type) && content ? o.content_type : 'REDACTED';
  const repository = content && isObj(content.repository) ? content.repository : null;
  const status = fieldEntry(o.fields, 'Status');
  const due = fieldEntry(o.fields, 'Due');
  const statusName = status && isObj(status.value) && isObj(status.value.name) ? status.value.name.raw : null;
  return {
    type,
    repo: repository && isStr(repository.full_name) ? repository.full_name : null,
    number: content && isPosInt(content.number) ? content.number : null,
    status: isStr(statusName) ? statusName : null,
    due: due && isStr(due.value) ? due.value.slice(0, 10) : null,
  };
}

const fieldKey = (owner, number) => `${owner.toLowerCase()}#${number}`;

function idOf(fields, name) {
  const f = fieldEntry(fields, name);
  return f && typeof f.id === 'number' ? f.id : undefined;
}

// R141: items asked with field ids; true when some asked field has no entry on any item of a non-empty page
function lacksAsked(items, asked) {
  if (items.length === 0) return false;
  return asked.some((name) => !items.some((it) => isObj(it) && fieldEntry(it.fields, name)));
}

function rawScore(item) {
  const e = isObj(item) ? fieldEntry(item.fields, 'Score') : null;
  const v = e ? e.value : null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// numbers: [{ number, role?, home? }] in reading order. Cards (R4) are the issues of listed projects with a home.
async function readProjects(http, { owner, ownerType, numbers, fieldCache, full, windowStartDay, unit }) {
  const base = `/${ownerType === 'organization' ? 'orgs' : 'users'}/${owner}/projectsV2`;
  const urlBase = `https://github.com/${ownerType === 'organization' ? 'orgs' : 'users'}/${owner}/projects`;
  const listed = await unit(() => http.paged(`${base}?per_page=100`, { maxPages: 10 }));
  const byNumber = new Map();
  for (const p of listed.items || []) {
    if (isObj(p) && isPosInt(p.number) && !byNumber.has(p.number)) byNumber.set(p.number, p);
  }
  const wanted = numbers.filter((w) => byNumber.has(w.number));
  // R116: projects are units of the shared limit; results kept in the order of the settings
  const results = await unitsOf(unit, wanted, readOne);
  return {
    projects: results.map((r) => r.project),
    cards: results.flatMap((r) => r.cards),
    partial: results.some((r) => r.partial),
  };

  async function loadFields(n, key) {
    const fields = await http.paged(`${base}/${n}/fields?per_page=100`, { maxPages: 2 });
    const entry = {};
    for (const name of ['Status', 'Due', 'Score']) {
      const id = idOf(fields.items, name);
      if (id !== undefined) entry[name] = id;
    }
    fieldCache.set(key, entry);
    return entry;
  }

  function addressOf(n, entry, habits) {
    const ids = [];
    const asked = [];
    for (const name of habits ? ['Status', 'Due', 'Score'] : ['Status', 'Due']) {
      if (entry[name] !== undefined) { ids.push(entry[name]); asked.push(name); }
    }
    const query = ids.length ? `per_page=100&fields=${ids.join(',')}` : 'per_page=100';
    // R68: the Habits Project is listed from the window start, the literal form CP0's probe proved
    const q = habits ? `&q=updated:>=${windowStartDay}` : '';
    return { path: `${base}/${n}/items?${query}${q}`, asked };
  }

  async function readOne(w) {
    const n = w.number;
    const p = byNumber.get(n);
    const habits = w.role === 'habits';
    const key = fieldKey(owner, n);
    // R141: cached ids unless this is a full read or nothing is cached yet
    let cached = !full && fieldCache.has(key);
    let entry = cached ? fieldCache.get(key) : await loadFields(n, key);
    let addr = addressOf(n, entry, habits);
    let items;
    try {
      items = await http.paged(addr.path, { maxPages: 20 });
    } catch (err) {
      if (!(cached && err instanceof BackendError && (err.code === 'invalid' || err.code === 'not-found'))) throw err;
      fieldCache.delete(key);
      entry = await loadFields(n, key);
      addr = addressOf(n, entry, habits);
      cached = false;
      items = await http.paged(addr.path, { maxPages: 20 });
    }
    if (cached && lacksAsked(items.items || [], addr.asked)) {
      const fresh = await loadFields(n, key);
      const next = addressOf(n, fresh, habits);
      if (next.path !== addr.path) items = await http.paged(next.path, { maxPages: 20 });
    }
    const rows = (items.items || []).map((it) => {
      const row = rawItem(it);
      if (habits) row.score = rawScore(it);
      // CP6 2a: the item's id, only on the role Projects
      if (w.role !== undefined && isObj(it) && isPosInt(it.id)) row.itemId = it.id;
      return row;
    });
    const cards = [];
    if ((w.home && w.role === undefined) || w.role === 'ideas') {
      for (const it of items.items || []) {
        if (!isObj(it) || it.content_type !== 'Issue' || !isObj(it.content)) continue;
        const r = isObj(it.content.repository) ? it.content.repository.full_name : null;
        if (!isStr(r) || !isPosInt(it.content.number)) continue;
        cards.push({ api: it.content, repo: r });
      }
    }
    const project = {
      number: n,
      title: str(p.title),
      closed: p.state === 'closed',
      url: `${urlBase}/${n}`,
      items: rows,
    };
    if (w.role !== undefined) {
      project.role = w.role;
      // CP6 2a: what the writes need
      project.owner = w.owner ?? owner;
      project.ownerType = ownerType;
      if (habits) {
        const sf = fieldCache.get(key);
        if (sf && sf.Score !== undefined) project.scoreField = sf.Score;
      }
    }
    return { partial: !!items.partial, project, cards };
  }
}

function mergeIssues(previous, changed) {
  const list = previous.slice();
  const at = new Map();
  list.forEach((it, i) => {
    if (isObj(it)) at.set(it.number, i);
  });
  for (const it of changed) {
    if (at.has(it.number)) {
      // a list that runs behind must not undo a newer copy (R70)
      const held = list[at.get(it.number)];
      if (!(isStr(held.updated_at) && isStr(it.updated_at) && held.updated_at > it.updated_at)) list[at.get(it.number)] = it;
    }
    else {
      at.set(it.number, list.length);
      list.push(it);
    }
  }
  return list;
}

// R4: a home card is the issue of a project item, with the repo it lives in and its ref
function homeCard(c) {
  return { ...rawIssue(c.api), repo: c.repo, ref: `${c.repo}#${c.api.number}` };
}

const REPO_URL_RE = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/;

// R133: the open blockers of one card as { ref, title, url }; a blocker in a repo the board does not read keeps only its ref.
async function readBlockers(h, repoFull, number, readable) {
  const res = await h.paged(`/repos/${repoFull}/issues/${number}/dependencies/blocked_by?per_page=100`, { maxPages: 1 });
  const out = [];
  for (const b of res.items || []) {
    if (!isObj(b) || b.state !== 'open' || !isPosInt(b.number) || !isStr(b.repository_url)) continue;
    const m = REPO_URL_RE.exec(b.repository_url);
    if (!m) continue;
    const ref = `${m[1]}/${m[2]}#${b.number}`;
    const known = readable.has(`${m[1]}/${m[2]}`.toLowerCase());
    out.push({ ref, title: known ? strOrNull(b.title) : null, url: known ? strOrNull(b.html_url) : null });
  }
  return out;
}

// R133: ask for the open rows with a count above 0, once each, in order; returns row -> waitingOn (non-empty lists only)
async function askBlocked(rows, clientOf, readable) {
  const found = new Map();
  for (const row of rows) {
    if (!isObj(row) || row.is_pr === true || row.state !== 'open' || !(row.blockedBy > 0)) continue; // R1: a pull request is never a card
    const { h, repoFull } = clientOf(row);
    const list = await readBlockers(h, repoFull, row.number, readable);
    if (list.length) found.set(row, list);
  }
  return found;
}

export async function readAll(http, { repo, full, since, previous, now, httpFor = () => http, fieldCache = new Map(), ownerTypeCache = new Map() }) {
  let capped = 0;
  const warn = (count) => { capped += count; };
  const limit = makeLimit(REQUESTS_AT_ONCE); // R116 (whole read): shared by every group

  const info = await http.get(`/repos/${repo}`);
  const meta = isObj(info && info.json) ? info.json : {};
  const owner = isObj(meta.owner) ? meta.owner : {};
  const ownerType = owner.type === 'Organization' ? 'organization' : 'user';
  const ownerLogin = isStr(owner.login) ? owner.login : repo.split('/')[0];

  const names = Object.keys(FILES);
  const read = await Promise.all(names.map((k) => readFile(http, repo, FILES[k])));
  const t = Object.fromEntries(names.map((k, i) => [k, read[i]]));
  const texts = {
    settings: t.settings,
    theme: t.theme,
    state: { brief: t.brief, calendar: t.calendar, inbox: t.inbox, log: t.log, proposals: t.proposals },
  };
  const cfg = readSettings(t.settings);
  const windowStartDay = windowStart(now, cfg.timezone);
  const dataRepoLower = repo.toLowerCase();
  // R6: (owner, number) pairs, the first of a pair wins, settings order kept; grouped by owner in order of first appearance.
  const groups = new Map(); // lower-cased owner -> { owner as written, numbers: [{ number, home?, role? }], homes }
  const dataKey = ownerLogin.toLowerCase();
  const seen = new Set();
  const homeSeen = new Set([dataRepoLower]);
  let others = false;
  let anyHome = false;
  const groupOf = (written) => {
    const key = written.toLowerCase();
    if (key !== dataKey) others = true;
    if (!groups.has(key)) groups.set(key, { owner: written, numbers: [], homes: [] });
    return groups.get(key);
  };
  for (const ref of cfg.refs) {
    const written = ref.owner === null ? ownerLogin : ref.owner;
    const key = written.toLowerCase();
    if (seen.has(`${key}#${ref.number}`)) continue;
    seen.add(`${key}#${ref.number}`);
    const g = groupOf(written);
    g.numbers.push({ number: ref.number, home: ref.home });
    if (ref.home !== null) {
      anyHome = true;
      if (!homeSeen.has(ref.home.toLowerCase())) {
        homeSeen.add(ref.home.toLowerCase());
        g.homes.push(ref.home);
      }
    }
  }
  // R7: the Ideas then the Habits Project, after their owner's listed numbers; a listed one is not read twice
  for (const [role, ref] of [['ideas', cfg.ideas], ['habits', cfg.habits]]) {
    if (ref === null || seen.has(`${ref.owner.toLowerCase()}#${ref.number}`)) continue;
    seen.add(`${ref.owner.toLowerCase()}#${ref.number}`);
    groupOf(ref.owner).numbers.push({ number: ref.number, role, owner: ref.owner });
  }

  const useSince = !full && isStr(since) && isObj(previous) && Array.isArray(previous.issues);
  const issuePath = `/repos/${repo}/issues?state=all&per_page=100${useSince ? `&since=${since}` : ''}`;
  const issuePage = await http.paged(issuePath, { maxPages: 100 });
  const apiIssues = (issuePage.items || []).filter(isObj);
  const fetched = apiIssues.map(rawIssue);
  // R69: home rows of the last snapshot are not kept; the items give them afresh
  // R133: nothing old survives in waitingOn; this load's answer sets it again
  const kept = useSince
    ? previous.issues
      .filter((it) => !(isObj(it) && isStr(it.repo) && it.repo.toLowerCase() !== dataRepoLower))
      .map((it) => {
        if (!isObj(it) || !Object.prototype.hasOwnProperty.call(it, 'waitingOn')) return it;
        const { waitingOn, ...rest } = it;
        return rest;
      })
    : [];
  let issues = useSince ? mergeIssues(kept, fetched) : fetched;
  const issuesPartial = Boolean(issuePage.partial);
  if (issuesPartial) warn(1);

  const msPage = await http.paged(`/repos/${repo}/milestones?state=all&per_page=100`, { maxPages: 10 });
  const milestones = (msPage.items || []).filter(isObj).map(rawMilestone);
  if (msPage.partial) warn(1);

  // R133: the blockers of the data repo's open cards, asked with the data repo's client (a failure fails the read)
  const readable = new Set(homeSeen); // the data repo and every settings home, lower-cased
  const waitingData = await askBlocked(issues, () => ({ h: http, repoFull: repo }), readable);
  if (waitingData.size) issues = issues.map((row) => (waitingData.has(row) ? { ...row, waitingOn: waitingData.get(row) } : row));

  let projects = [];
  let itemsPartial = false;
  const owners = [{ owner: ownerLogin, ok: true }];
  const failed = [];
  let failedCount = 0;
  const cards = [];
  const cardAsked = new Set(); // lower-cased refs of home cards already asked (first wins, read order)
  const cardWaiting = new Map(); // lower-cased ref -> waitingOn
  const homeMilestones = [];
  const unknownHomes = new Set(); // R72: homes whose privacy is unknown (none read, none held): their cards are left out
  const repos = [];
  const prevRepos = isObj(previous) && Array.isArray(previous.repos) ? previous.repos : [];

  // R72: a home's privacy; a full read (or none held) asks, otherwise the last read's value. Null when it could not be read and none is held.
  const observedPrivacy = new Map(); // BR2-1: home lower-cased -> private, as read during this read; it wins over the held value
  async function homePrivacy(home, soft) {
    const lc = home.toLowerCase();
    if (observedPrivacy.get(lc) === false) return false; // once public in this read, public for the whole read
    const held = prevRepos.find((r) => isObj(r) && isStr(r.repo) && r.repo.toLowerCase() === home.toLowerCase() && typeof r.private === 'boolean');
    if (full || !held) {
      try {
        const res = await httpFor(home.split('/')[0]).get(`/repos/${home}`);
        const isPrivate = isObj(res && res.json) && res.json.private === true;
        observedPrivacy.set(lc, isPrivate);
        return isPrivate;
      } catch (err) {
        if (!soft || !(err instanceof BackendError)) throw err;
        if (observedPrivacy.has(lc)) return observedPrivacy.get(lc);
        return held ? held.private : null;
      }
    }
    return held.private;
  }

  // R4, R72: each home repo once, in its listed project's owner's group, with the client of the home's owner
  async function readHomes(g, unit, warnHere) {
    const out = { milestones: [], repos: [] };
    // R116: each home is a unit; its own requests follow each other
    const units = await unitsOf(unit, g.homes, async (home) => {
      const h = httpFor(home.split('/')[0]);
      const isPrivate = await homePrivacy(home, false);
      const page = await h.paged(`/repos/${home}/milestones?state=all&per_page=100`, { maxPages: 10 });
      if (page.partial) warnHere(1);
      return {
        milestones: (page.items || []).filter(isObj).map((m) => ({ ...rawMilestone(m), repo: home })),
        repo: { repo: home, private: isPrivate, role: 'home' },
      };
    });
    for (const u of units) {
      out.milestones.push(...u.milestones);
      out.repos.push(u.repo);
    }
    return out;
  }

  // R72: the homes of a group that was left out still have their privacy read (a public one stops the board)
  async function readHomePrivacy(g) {
    const out = [];
    for (const home of g.homes) {
      const isPrivate = await homePrivacy(home, true);
      if (isPrivate !== null) out.push({ repo: home, private: isPrivate, role: 'home' });
      else unknownHomes.add(home.toLowerCase());
    }
    return out;
  }

  // R133: a group's home cards, open with a count above 0, asked with the client of the card repo's owner
  async function askCards(groupCards) {
    const seenHere = new Set();
    const rows = [];
    for (const c of groupCards) {
      if (c.repo.toLowerCase() === dataRepoLower) continue;
      const row = homeCard(c);
      const k = row.ref.toLowerCase();
      if (cardAsked.has(k) || seenHere.has(k)) continue;
      seenHere.add(k);
      rows.push(row);
    }
    const found = await askBlocked(rows, (row) => ({ h: httpFor(row.repo.split('/')[0]), repoFull: row.repo }), readable);
    const out = new Map();
    for (const [row, list] of found) out.set(row.ref.toLowerCase(), list);
    return { out, seenHere };
  }
  // committed only when the group did not fail, so a left-out group leaves nothing behind
  function keepAsked(a) {
    for (const k of a.seenHere) cardAsked.add(k);
    for (const [k, v] of a.out) cardWaiting.set(k, v);
  }

  // R116 (whole read): every group is read at the same time; homes do not wait for the Projects
  async function readGroup(key, g) {
    const unit = makeGroupUnit(limit);
    let capHere = 0;
    const warnHere = (count) => { capHere += count; };
    const isData = key === dataKey;
    let type = ownerType;
    const projectsPart = (async () => {
      let h = http;
      if (!isData) {
        h = httpFor(g.owner);
        const lc = g.owner.toLowerCase();
        if (!full && ownerTypeCache.has(lc)) {
          type = ownerTypeCache.get(lc);
        } else {
          const who = await unit(() => h.get(`/users/${g.owner}`));
          type = isObj(who && who.json) && who.json.type === 'Organization' ? 'organization' : 'user';
          ownerTypeCache.set(lc, type);
        }
      }
      return readProjects(h, { owner: isData ? ownerLogin : g.owner, ownerType: type, numbers: g.numbers, fieldCache, full, windowStartDay, unit });
    })();
    const homesPart = readHomes(g, unit, warnHere);
    const [rp, rh] = await Promise.allSettled([projectsPart, homesPart]);
    const bad = [rp, rh].find((x) => x.status === 'rejected' && !(x.reason instanceof Skipped)) || [rp, rh].find((x) => x.status === 'rejected');
    if (bad) throw bad.reason;
    return { r: rp.value, hr: rh.value, type, capHere };
  }

  const settledGroups = await Promise.allSettled([...groups].map(([key, g]) => readGroup(key, g)));
  let gi = 0;
  for (const [key, g] of groups) {
    const res = settledGroups[gi++];
    if (key === dataKey) {
      if (res.status === 'rejected') throw res.reason;
      const { r, hr, capHere } = res.value;
      keepAsked(await askCards(r.cards));
      capped += capHere;
      projects = projects.concat(r.projects);
      cards.push(...r.cards);
      homeMilestones.push(...hr.milestones);
      repos.push(...hr.repos);
      if (r.partial) itemsPartial = true;
      continue;
    }
    // R6: one owner failing leaves only its projects out; anything that is not a BackendError is not swallowed
    try {
      if (res.status === 'rejected') throw res.reason;
      const { r, hr, type, capHere } = res.value;
      keepAsked(await askCards(r.cards));
      capped += capHere;
      projects = projects.concat(r.projects.map((p) => (p.role !== undefined ? p : { ...p, owner: g.owner, ownerType: type })));
      cards.push(...r.cards);
      homeMilestones.push(...hr.milestones);
      repos.push(...hr.repos);
      if (r.partial) itemsPartial = true;
      owners.push({ owner: g.owner, ok: true });
    } catch (err) {
      if (!(err instanceof BackendError)) throw err;
      owners.push({ owner: g.owner, ok: false, reason: err.code });
      failed.push(g.owner);
      failedCount += g.numbers.length;
      repos.push(...await readHomePrivacy(g));
    }
  }
  if (itemsPartial) warn(1);
  if (unknownHomes.size) {
    const inUnknown = (r) => isObj(r) && isStr(r.repo) && unknownHomes.has(r.repo.toLowerCase());
    projects = projects.map((p) => ({ ...p, items: p.items.filter((r) => !inUnknown(r)) }));
    issues = issues.filter((r) => !inUnknown(r));
    cards.splice(0, cards.length, ...cards.filter((c) => !unknownHomes.has(c.repo.toLowerCase())));
  }

  const raw = {
    fetchedAt: now,
    partial: { issues: issuesPartial, items: itemsPartial },
    repo,
    repoPrivate: meta.private === true,
    ownerType,
    issues,
    milestones,
    projects,
  };
  if (others) raw.owners = owners;

  // R4, R47: cards by ref, first wins, read order
  const cardRows = [];
  const cardSeen = new Set();
  // R70: a held home row (a written one included) is not undone by older item content on a delta read
  const heldHome = new Map();
  if (useSince) {
    for (const it of previous.issues) {
      if (isObj(it) && isStr(it.repo) && isStr(it.ref) && it.repo.toLowerCase() !== dataRepoLower) heldHome.set(it.ref.toLowerCase(), it);
    }
  }
  const colorSources = [...apiIssues];
  for (const c of cards) {
    if (c.repo.toLowerCase() === dataRepoLower) continue;
    let row = homeCard(c);
    if (cardSeen.has(row.ref.toLowerCase())) continue;
    const heldRow = heldHome.get(row.ref.toLowerCase());
    if (heldRow && isStr(heldRow.updated_at) && isStr(row.updated_at) && heldRow.updated_at > row.updated_at) {
      const { waitingOn, ...rest } = heldRow;
      row = rest;
    }
    if (cardWaiting.has(row.ref.toLowerCase())) row.waitingOn = cardWaiting.get(row.ref.toLowerCase());
    cardSeen.add(row.ref.toLowerCase());
    cardRows.push(row);
    colorSources.push(c.api);
  }
  if (anyHome || cardRows.length) {
    const present = new Set(issues.filter((it) => isObj(it) && isStr(it.ref)).map((it) => it.ref.toLowerCase()));
    raw.issues = issues.concat(cardRows.filter((c) => !present.has(c.ref.toLowerCase())));
  }
  if (anyHome) {
    raw.milestones = milestones.concat(homeMilestones);
    raw.repos = [{ repo, private: meta.private === true, role: 'data' }, ...repos];
  }
  // R76: label colours of the modes, first seen wins; the model checks them
  if (cfg.modes.length) {
    const modeSet = new Set(cfg.modes.map((m) => m.toLowerCase()));
    const colors = {};
    for (const a of colorSources) {
      if (!Array.isArray(a.labels)) continue;
      for (const l of a.labels) {
        if (!isObj(l) || !isStr(l.name) || !isStr(l.color)) continue;
        const nm = l.name.trim().toLowerCase();
        if (modeSet.has(nm) && !Object.prototype.hasOwnProperty.call(colors, nm)) colors[nm] = `#${l.color}`;
      }
    }
    if (useSince && isObj(previous.labelColors)) {
      for (const [k, v] of Object.entries(previous.labelColors)) {
        if (modeSet.has(k) && !Object.prototype.hasOwnProperty.call(colors, k)) colors[k] = v;
      }
    }
    raw.labelColors = colors;
  }
  const warnings = capped > 0 ? [{ code: 'too-much-data', count: capped }] : [];
  // R67: the owners that did not answer, in one notice
  if (failed.length) warnings.push({ code: 'project-owner-unreadable', count: failedCount, names: failed });
  return { raw, texts, warnings };
}
