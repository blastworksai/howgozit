// A small in-memory GitHub for tests: one world, the four methods of the real client.
// Every value here is invented. Timestamps come from a counter, never from the clock.

import { GitHubError } from '../board/github/http.mjs';

const MUTATION = /\b(createProjectV2Field|createProjectV2|updateProjectV2ItemFieldValue|clearProjectV2ItemFieldValue|addProjectV2ItemById|deleteProjectV2|deleteIssue|linkProjectV2ToRepository|unlinkProjectV2FromRepository)\b/;
const API = 'https://api.github.com';

function b64(text) {
  const s = Buffer.from(text, 'utf8').toString('base64');
  return (s.match(/.{1,60}/g) || []).join('\n') + '\n';
}

const notFound = () => new GitHubError('not-found', 404);
const invalid = (message) => new GitHubError('invalid', 422, message);
const copy = (v) => structuredClone(v);

export function createFakeGitHub({ repo = 'sam-life/life', ownerType = 'organization', isPrivate = true, files = {}, repos = [], login = 'fake-user', statusOptions = false, dueShift = false } = {}) {
  const [owner, repoName] = repo.split('/');
  const R = '/repos/' + repo;
  const P = (ownerType === 'user' ? '/users/' : '/orgs/') + owner + '/projectsV2';
  const calls = [];
  let failure = null;
  const n = { tick: 0, label: 0, milestone: 0, issue: 0, project: 0, field: 0, item: 0, sha: 0 };
  const stamp = () => {
    n.tick += 1;
    return new Date(Date.UTC(2026, 9, 1) + n.tick * 1000).toISOString().replace('.000Z', 'Z');
  };

  const state = { labels: [], milestones: [], issues: [], projects: [], files: {} };
  if (repos.length) state.repos = {};
  for (const [path, text] of Object.entries(files)) state.files[path] = { text, sha: 'S_' + (n.sha += 1) };

  // One context per repo: the main repo (k 0) reads state.*, an extra repo has its own lists and counters.
  const main = {
    k: 0, full: repo, name: repoName, isPrivate, node_id: 'R_0', n,
    get labels() { return state.labels; }, get milestones() { return state.milestones; }, get issues() { return state.issues; },
  };
  const extra = [];
  repos.forEach((def, i) => {
    const full = String(def && def.name);
    const [o, nm] = full.split('/');
    if (!o || !nm || o !== owner) throw new Error('fake-github: repos entries must be owner/name under ' + owner + ': ' + full);
    if (full.toLowerCase() === repo.toLowerCase() || extra.some((x) => x.full.toLowerCase() === full.toLowerCase())) throw new Error('fake-github: repeated repo ' + full);
    const entry = { labels: [], milestones: [], issues: [] };
    state.repos[full] = entry;
    extra.push({
      k: i + 1, full, name: nm, isPrivate: def.private !== false, hasIssues: def.has_issues !== false, node_id: 'R_' + (i + 1),
      n: { label: 0, milestone: 0, issue: 0 }, labels: entry.labels, milestones: entry.milestones, issues: entry.issues,
    });
  });
  const allRepos = [main, ...extra];
  // CP8: comments live beside the issues, never inside them, so an issue's answer is unchanged.
  const comments = {};
  let commentSeq = 0;
  const gone = new Set();
  // CP9: blockers live beside the issues (key repo#number -> [{ full, number }]), never inside them; only a blocked issue's answers change.
  const blockers = {};
  const blockersOf = (c, issue) => blockers[c.full + '#' + issue.number] || [];
  const blockerIssue = (b) => {
    const bc = ctxOf(b.full);
    return { c: bc, issue: bc.issues.find((i) => i.number === b.number) };
  };
  const summaryOf = (c, issue) => {
    const held = blockersOf(c, issue);
    const open = held.filter((b) => { const h = blockerIssue(b).issue; return h && h.state === 'open'; }).length;
    return { blocked_by: open, total_blocked_by: held.length, blocking: 0, total_blocking: 0 };
  };
  const answerIssue = (c, issue) => {
    const out = copy(issue);
    if (blockersOf(c, issue).length) out.issue_dependencies_summary = summaryOf(c, issue);
    return out;
  };
  function setBlockers(c, issue, list) {
    if (!Array.isArray(list)) throw invalid();
    const held = list.map((v) => {
      const m = typeof v === 'string' ? /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(v) : null;
      const full = m ? m[1] : c.full;
      const num = m ? Number(m[2]) : v;
      if (!Number.isInteger(num)) throw invalid();
      const bc = ctxOf(full);
      issueNo(num, bc);
      return { full: bc.full, number: num };
    });
    blockers[c.full + '#' + issue.number] = held;
  }
  const ctxOf = (full) => {
    const hit = allRepos.find((x) => x.full === full) || extra.find((x) => x.full.toLowerCase() === String(full).toLowerCase());
    if (!hit) throw notFound();
    return hit;
  };
  // Ids of an extra repo are offset so they never meet the main repo's; the main repo's ids are unchanged.
  const off = (c, per) => c.k * per;
  const nodeOf = (c, issue) => (c.k === 0 ? 'I_' : 'I' + c.k + '_') + issue;

  const repoAnswer = (c = main) => ({
    id: c.k === 0 ? 1 : 10 + c.k, node_id: c.node_id, name: c.name, full_name: c.full, private: c.isPrivate, has_issues: c.hasIssues !== false, default_branch: 'main',
    owner: { login: owner, type: ownerType === 'user' ? 'User' : 'Organization', id: 2, node_id: 'O_1' },
  });

  // dueShift (opt-in): GitHub reads a milestone's due_on in a timezone west of UTC (measured 15 Oct: midnight UTC lands a day
  // early, noon UTC keeps the date): the stored date is the UTC date of (instant - 8h), at midnight UTC. Off: stored as given.
  const msDue = (v) => (!dueShift ? v || null : v ? new Date(Date.parse(v) - 8 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00Z' : null);
  const milestoneRef = (m) => ({ id: m.id, number: m.number, title: m.title, state: m.state });
  const issueNo = (v, c = main) => {
    const num = Number(v);
    if (gone.size && gone.has(c.full + '#' + num)) throw new GitHubError('not-found', 410);
    const found = c.issues.find((i) => i.number === num);
    if (!found) throw notFound();
    return found;
  };
  const milestoneNo = (v, c = main) => {
    const found = c.milestones.find((m) => m.number === Number(v));
    if (!found) throw notFound();
    return found;
  };
  const projectNo = (v) => {
    const found = state.projects.find((p) => p.number === Number(v));
    if (!found) throw notFound();
    return found;
  };
  const projectNode = (id) => {
    const found = state.projects.find((p) => p.node_id === id);
    if (!found) throw notFound();
    return found;
  };

  function labelObjects(names, c = main) {
    if (names === undefined || names === null) return [];
    if (!Array.isArray(names)) throw invalid();
    return names.map((nm) => {
      const name = typeof nm === 'string' ? nm : nm && nm.name;
      if (typeof name !== 'string' || !name) throw invalid();
      const known = c.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      return { id: known ? known.id : 0, name: known ? known.name : name, color: known ? known.color : 'ededed' };
    });
  }

  function newField(project, name, dataType) {
    n.field += 1;
    const f = { id: 100 + n.field, node_id: 'F_' + n.field, name, data_type: dataType };
    project.fields.push(f);
    return f;
  }

  function newProject(title) {
    n.project += 1;
    const p = { id: 9000 + n.project, node_id: 'P_' + n.project, number: n.project, title, state: 'open', fields: [], items: [], repositories: [] };
    newField(p, 'Title', 'title');
    const status = newField(p, 'Status', 'single_select');
    if (statusOptions) {
      status.options = ['Todo', 'In Progress', 'Done'].map((nm, i) => ({ id: 'SO_' + (i + 1), name: { raw: nm, html: nm } }));
    }
    state.projects.push(p);
    return p;
  }

  let lag = 0;

  const itemRepo = (it) => (it.content && it.content.repository ? it.content.repository.full_name : repo);

  function addItem(project, issue, c = main) {
    const held = project.items.find((it) => it.content && it.content.number === issue.number && itemRepo(it) === c.full);
    if (held) return held;
    n.item += 1;
    const it = {
      id: 5000 + n.item, node_id: 'PI_' + n.item, content_type: 'Issue',
      content: { number: issue.number, title: issue.title, repository: { full_name: c.full } },
      fields: [], status: 'Todo', due: null, nums: {},
    };
    project.items.push(it);
    return it;
  }

  function renderItem(it, project, ids) {
    const out = { id: it.id, node_id: it.node_id, content_type: it.content_type, content: copy(it.content), fields: [] };
    if (blockersOf(allRepos.find((x) => x.full === itemRepo(it)) || main, it.content).length) {
      const ic = allRepos.find((x) => x.full === itemRepo(it)) || main;
      out.content.issue_dependencies_summary = summaryOf(ic, it.content);
    }
    const wanted = ids === null ? [project.fields.find((f) => f.name === 'Title').id] : ids;
    for (const fid of wanted) {
      const f = project.fields.find((x) => x.id === fid);
      if (!f) continue;
      let value = null;
      if (f.name === 'Title') value = { raw: it.content.title, html: it.content.title };
      else if (f.name === 'Status') value = it.status === null ? null : { id: (statusOptions && (f.options || []).find((o) => o.name.raw === it.status) || { id: 'O_' + it.status }).id, name: { raw: it.status, html: it.status }, color: 'GRAY' };
      else if (f.name === 'Due') value = it.due ? it.due + 'T00:00:00+00:00' : null;
      else if (f.data_type === 'number') value = it.nums && f.id in it.nums ? it.nums[f.id] : null;
      out.fields.push({ id: f.id, name: f.name, data_type: f.data_type, value });
    }
    return out;
  }

  function addComment(c, issue, { login: who, body, created_at: at }) {
    commentSeq += 1;
    const id = 8000000 + commentSeq;
    const cm = {
      id, node_id: 'IC_' + commentSeq, body, user: { login: who }, created_at: at,
      html_url: 'https://github.com/' + c.full + '/issues/' + issue.number + '#issuecomment-' + id,
    };
    (comments[c.full + '#' + issue.number] ||= []).push(cm);
    return cm;
  }

  function route(method, origPath, body, query) {
    let path = origPath;
    const b = body && typeof body === 'object' ? body : {};
    let m;
    if (method === 'POST' && path === (ownerType === 'user' ? '/user/repos' : '/orgs/' + owner + '/repos')) {
      if (typeof b.name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(b.name) || /^\.+$/.test(b.name)) throw invalid();
      const full = owner + '/' + b.name;
      if (allRepos.some((x) => x.full.toLowerCase() === full.toLowerCase())) throw invalid('name already exists on this account');
      const k = extra.length + 1;
      const entry = { labels: [], milestones: [], issues: [] };
      if (!state.repos) state.repos = {};
      state.repos[full] = entry;
      const made = {
        k, full, name: b.name, isPrivate: b.private === true, node_id: 'R_' + k,
        n: { label: 0, milestone: 0, issue: 0 }, labels: entry.labels, milestones: entry.milestones, issues: entry.issues,
      };
      extra.push(made);
      allRepos.push(made);
      return repoAnswer(made);
    }
    if (path === R && method === 'GET') return repoAnswer();
    let c = main;
    if (!path.startsWith(R + '/') && !path.startsWith(P)) {
      if (!extra.length || !(m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path))) throw notFound();
      c = ctxOf(m[1]);
      if (c === main) throw notFound();
      if (m[2] === undefined) return method === 'GET' ? repoAnswer(c) : (() => { throw notFound(); })();
      path = R + m[2];
    }

    if (path === R + '/labels') {
      if (method === 'GET') return copy(c.labels);
      if (method === 'POST') {
        if (typeof b.name !== 'string' || !b.name) throw invalid();
        if (c.labels.some((l) => l.name.toLowerCase() === b.name.toLowerCase())) throw invalid('already_exists');
        c.n.label += 1;
        const l = { id: off(c, 10000) + 300 + c.n.label, name: b.name, color: b.color || 'ededed', description: b.description || null };
        c.labels.push(l);
        return copy(l);
      }
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/labels\/(.+)$/.exec(path)) && method === 'DELETE') {
      const name = decodeURIComponent(m[1]).toLowerCase();
      const at = c.labels.findIndex((l) => l.name.toLowerCase() === name);
      if (at < 0) throw notFound();
      c.labels.splice(at, 1);
      return null;
    }

    if (path === R + '/milestones') {
      if (method === 'GET') {
        const s = query.get('state') || 'open';
        return copy(c.milestones.filter((x) => s === 'all' || x.state === s));
      }
      if (method === 'POST') {
        if (typeof b.title !== 'string' || !b.title) throw invalid();
        if (c.milestones.some((x) => x.title.toLowerCase() === b.title.toLowerCase())) throw invalid('already_exists');
        c.n.milestone += 1;
        const ms = {
          id: off(c, 10000) + 500 + c.n.milestone, number: c.n.milestone, title: b.title, state: 'open', description: b.description || null,
          due_on: msDue(b.due_on), closed_at: null, html_url: 'https://github.com/' + c.full + '/milestone/' + c.n.milestone,
          open_issues: 0, closed_issues: 0, created_at: stamp(),
        };
        c.milestones.push(ms);
        return copy(ms);
      }
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/milestones\/(\d+)$/.exec(path))) {
      const ms = milestoneNo(m[1], c);
      if (method === 'GET') return copy(ms);
      if (method === 'PATCH') {
        if (typeof b.title === 'string') ms.title = b.title;
        if (b.due_on !== undefined) ms.due_on = msDue(b.due_on);
        if (b.state === 'open' || b.state === 'closed') {
          ms.state = b.state;
          ms.closed_at = b.state === 'closed' ? stamp() : null;
        }
        return copy(ms);
      }
      if (method === 'DELETE') {
        c.milestones.splice(c.milestones.indexOf(ms), 1);
        for (const i of c.issues) if (i.milestone && i.milestone.number === ms.number) i.milestone = null;
        return null;
      }
    }

    if (path === R + '/issues') {
      if (method === 'GET') {
        const s = query.get('state') || 'open';
        const since = query.get('since');
        const sinceMs = since ? Date.parse(since) : null;
        const ms = query.get('milestone');
        if (ms !== null && ms !== '*' && ms !== 'none' && !c.milestones.some((x) => String(x.number) === ms)) throw invalid();
        const inMilestone = (i) => {
          if (ms === null || ms === '*') return ms === null || i.milestone !== null;
          if (ms === 'none') return i.milestone === null || i.milestone === undefined;
          const n = i.milestone && typeof i.milestone === 'object' ? i.milestone.number : i.milestone;
          return String(n) === ms;
        };
        return c.issues.filter((i) => (s === 'all' || i.state === s)
          && (sinceMs === null || Date.parse(i.updated_at) >= sinceMs) && inMilestone(i)).map((i) => answerIssue(c, i));
      }
      if (method === 'POST') {
        if (typeof b.title !== 'string' || !b.title) throw invalid();
        let milestone = null;
        if (b.milestone !== undefined && b.milestone !== null) {
          const ms = c.milestones.find((x) => x.number === b.milestone);
          if (!ms) throw invalid();
          milestone = milestoneRef(ms);
        }
        if (b.blockedBy !== undefined) setBlockers(c, { number: c.n.issue + 1 }, b.blockedBy);
        c.n.issue += 1;
        const at = stamp();
        const issue = {
          id: off(c, 100000) + c.n.issue * 10, node_id: nodeOf(c, c.n.issue), number: c.n.issue, title: b.title, body: b.body || null,
          state: 'open', state_reason: null, labels: labelObjects(b.labels, c), milestone,
          created_at: at, updated_at: at, closed_at: null,
          html_url: 'https://github.com/' + c.full + '/issues/' + c.n.issue,
        };
        c.issues.push(issue);
        return answerIssue(c, issue);
      }
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path))) {
      const issue = issueNo(m[1], c);
      if (method === 'GET') return answerIssue(c, issue);
      if (method === 'PATCH') {
        if (typeof b.title === 'string') issue.title = b.title;
        if (b.body !== undefined) issue.body = b.body;
        if (b.labels !== undefined) issue.labels = labelObjects(b.labels, c);
        if (b.milestone !== undefined) {
          if (b.milestone === null) issue.milestone = null;
          else {
            const ms = c.milestones.find((x) => x.number === b.milestone);
            if (!ms) throw invalid();
            issue.milestone = milestoneRef(ms);
          }
        }
        if (b.state === 'closed') {
          if (issue.state !== 'closed') issue.closed_at = stamp();
          issue.state = 'closed';
          issue.state_reason = b.state_reason || 'completed';
        } else if (b.state === 'open') {
          issue.state = 'open';
          issue.state_reason = null;
          issue.closed_at = null;
        }
        issue.updated_at = stamp();
        for (const p of state.projects) {
          for (const it of p.items) if (it.content.number === issue.number && itemRepo(it) === c.full) it.content.title = issue.title;
        }
        return answerIssue(c, issue);
      }
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path)) && method === 'GET') {
      const issue = issueNo(m[1], c);
      return blockersOf(c, issue).map((b) => {
        const { c: bc, issue: held } = blockerIssue(b);
        return { ...answerIssue(bc, held), repository_url: API + '/repos/' + bc.full };
      });
    }

    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path))) {
      const issue = issueNo(m[1], c);
      const key = c.full + '#' + issue.number;
      if (method === 'GET') return copy(comments[key] || []);
      if (method === 'POST') {
        if (typeof b.body !== 'string' || !b.body) throw invalid();
        return copy(addComment(c, issue, { login, body: b.body, created_at: stamp() }));
      }
    }

    if ((m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path))) {
      const file = decodeURIComponent(m[1]);
      const held = state.files[file];
      if (method === 'GET') {
        if (!held) throw notFound();
        return {
          name: file.split('/').pop(), path: file, sha: held.sha, type: 'file', encoding: 'base64',
          size: Buffer.byteLength(held.text), content: b64(held.text),
        };
      }
      if (method === 'PUT') {
        if (typeof b.content !== 'string') throw invalid();
        if (held && b.sha !== held.sha) throw invalid('sha does not match');
        if (!held && b.sha !== undefined && b.sha !== null) throw invalid('sha does not match');
        const sha = 'S_' + (n.sha += 1);
        state.files[file] = { text: Buffer.from(b.content, 'base64').toString('utf8'), sha };
        return { content: { path: file, sha } };
      }
      if (method === 'DELETE') {
        if (!held) throw notFound();
        if (b.sha !== held.sha) throw invalid('sha does not match');
        delete state.files[file];
        return { content: null };
      }
    }

    if (path === P && method === 'GET') {
      return state.projects.map((p) => ({ id: p.id, node_id: p.node_id, number: p.number, title: p.title, state: p.state, public: false, ...(extra.length ? { repositories: [...p.repositories] } : {}) }));
    }
    if ((m = /^\/(?:orgs|users)\/[^/]+\/projectsV2\/(\d+)$/.exec(path)) && path.startsWith(P + '/') && method === 'GET') {
      const p = projectNo(m[1]);
      return { id: p.id, node_id: p.node_id, number: p.number, title: p.title, state: p.state };
    }
    if ((m = /^\/(?:orgs|users)\/[^/]+\/projectsV2\/(\d+)\/(fields|items)$/.exec(path))) {
      if (!path.startsWith(P + '/')) throw notFound();
      const project = projectNo(m[1]);
      if (m[2] === 'fields' && method === 'GET') return copy(project.fields);
      if (m[2] === 'items' && method === 'GET') {
        const raw = query.get('fields');
        const ids = raw ? raw.split(',').map(Number) : null;
        if (lag > 0) { lag -= 1; return []; }
        return project.items.map((it) => renderItem(it, project, ids));
      }
      if (m[2] === 'items' && method === 'POST') {
        if (b.type !== 'Issue' || b.owner !== owner) throw notFound();
        const ic = allRepos.find((x) => x.name === b.repo);
        if (!ic) throw notFound();
        const issue = issueNo(b.number, ic);
        if (project.items.some((x) => x.content && x.content.number === issue.number && itemRepo(x) === ic.full)) throw invalid('Project already contains this item');
        const it = addItem(project, issue, ic);
        return renderItem(it, project, null);
      }
    }
    if ((m = /^\/(?:orgs|users)\/[^/]+\/projectsV2\/(\d+)\/items\/(\d+)$/.exec(path)) && path.startsWith(P + '/')) {
      const project = projectNo(m[1]);
      const at = project.items.findIndex((x) => x.id === Number(m[2]));
      if (at < 0) throw notFound();
      const it = project.items[at];
      if (method === 'GET') {
        const raw = query.get('fields');
        return renderItem(it, project, raw ? raw.split(',').map(Number) : null);
      }
      if (method === 'DELETE') {
        project.items.splice(at, 1);
        return null;
      }
      if (method === 'PATCH') {
        if (!Array.isArray(b.fields) || !b.fields.length) throw invalid();
        const ids = [];
        const sets = [];
        for (const e of b.fields) {
          const f = e && project.fields.find((x) => x.id === e.id || (typeof e.id === 'string' && x.node_id === e.id));
          if (!f || f.data_type !== 'number') throw invalid();
          if (e.value !== null && !(typeof e.value === 'number' && Number.isFinite(e.value))) throw invalid();
          sets.push([f, e.value]);
        }
        for (const [f, value] of sets) {
          if (value === null) delete it.nums[f.id]; else it.nums[f.id] = value;
          ids.push(f.id);
        }
        return renderItem(it, project, ids);
      }
    }
    throw notFound();
  }

  function matches(match, call) {
    if (typeof match === 'function') return Boolean(match(call));
    if (!match) return true;
    if (match.method && match.method !== call.method) return false;
    const p = match.path;
    if (p === undefined) return true;
    if (p instanceof RegExp) return p.test(call.path);
    return call.path === p || call.path.startsWith(p);
  }

  let quiet = false;
  function record(method, path, body) {
    if (quiet) return;
    const call = { method, path, body: body === undefined ? undefined : copy(body) };
    calls.push(call);
    if (failure && matches(failure.match, call)) {
      const err = failure.error;
      failure = null;
      throw err;
    }
  }

  function request(method, path, body) {
    record(method, path, body);
    let p = path.startsWith(API) ? path.slice(API.length) : path;
    const q = p.indexOf('?');
    const query = new URLSearchParams(q >= 0 ? p.slice(q + 1) : '');
    if (q >= 0) p = p.slice(0, q);
    return route(method, p, body, query);
  }

  const get = async (path) => ({ status: 200, json: request('GET', path), notModified: false, link: null });
  const paged = async (path) => {
    const json = request('GET', path);
    return { items: Array.isArray(json) ? json : (json && Array.isArray(json.items) ? json.items : []), partial: false };
  };
  const send = async (method, path, body) => {
    const out = request(String(method).toUpperCase(), path, body);
    return out === undefined ? null : out;
  };

  const graphqlNow = (query, variables = {}) => {
    const hit = MUTATION.exec(String(query));
    if (!hit) {
      record('GRAPHQL', 'unknown', variables);
      throw invalid('Unknown mutation');
    }
    const name = hit[1];
    record('GRAPHQL', name, variables);
    const v = variables || {};
    if (name === 'createProjectV2') {
      if (v.ownerId !== 'O_1' || typeof v.title !== 'string' || !v.title) throw invalid();
      const p = newProject(v.title);
      return { createProjectV2: { projectV2: { id: p.node_id, number: p.number } } };
    }
    if (name === 'createProjectV2Field') {
      const p = projectNode(v.projectId);
      if (typeof v.name !== 'string' || !v.name) throw invalid();
      if (p.fields.some((f) => f.name.toLowerCase() === v.name.toLowerCase())) throw invalid('Name has already been taken');
      // the enum may come as a variable or written into the mutation, as setup writes it (lead, CP7)
      const f = newField(p, v.name, v.dataType === 'NUMBER' || /dataType:\s*NUMBER\b/.test(String(query)) ? 'number' : 'date');
      return { createProjectV2Field: { projectV2Field: { id: f.node_id, name: f.name } } };
    }
    if (name === 'addProjectV2ItemById') {
      const p = projectNode(v.projectId);
      let issue = null;
      let ic = main;
      for (const x of allRepos) {
        issue = x.issues.find((i) => i.node_id === v.contentId);
        if (issue) { ic = x; break; }
      }
      if (!issue) throw notFound();
      return { addProjectV2ItemById: { item: { id: addItem(p, issue, ic).node_id } } };
    }
    if (name === 'updateProjectV2ItemFieldValue') {
      const p = projectNode(v.projectId);
      const it = p.items.find((x) => x.node_id === v.itemId);
      const f = p.fields.find((x) => x.node_id === v.fieldId);
      if (!it || !f) throw notFound();
      if (f.name === 'Due') {
        if (typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) throw invalid();
        it.due = v.date;
      } else if (f.name === 'Status' && typeof v.status === 'string') it.status = v.status;
      else if (f.name === 'Status' && typeof v.optionId === 'string') {
        const opt = (f.options || []).find((x) => x.id === v.optionId);
        if (!opt) throw invalid();
        it.status = opt.name.raw;
      } else throw invalid();
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: it.node_id } } };
    }
    if (name === 'clearProjectV2ItemFieldValue') {
      const p = projectNode(v.projectId);
      const it = p.items.find((x) => x.node_id === v.itemId);
      const f = p.fields.find((x) => x.node_id === v.fieldId);
      if (!it || !f) throw notFound();
      if (f.name === 'Due') it.due = null;
      else if (f.name === 'Status') it.status = null;
      else if (f.data_type === 'number') delete it.nums[f.id];
      else throw invalid();
      return { clearProjectV2ItemFieldValue: { projectV2Item: { id: it.node_id } } };
    }
    if (name === 'linkProjectV2ToRepository' || name === 'unlinkProjectV2FromRepository') {
      const p = projectNode(v.projectId);
      const target = allRepos.find((x) => x.node_id === v.repositoryId);
      if (!target) throw notFound();
      const at = p.repositories.indexOf(target.node_id);
      if (name === 'linkProjectV2ToRepository') {
        if (at < 0) p.repositories.push(target.node_id);
        return { linkProjectV2ToRepository: { repository: { id: target.node_id } } };
      }
      if (at < 0) throw notFound();
      p.repositories.splice(at, 1);
      return { unlinkProjectV2FromRepository: { repository: { id: target.node_id } } };
    }
    if (name === 'deleteIssue') {
      const id = v.issueId !== undefined ? v.issueId : v.input && v.input.issueId;
      let hit = null;
      let hc = main;
      for (const x of allRepos) {
        hit = x.issues.find((i) => i.node_id === id);
        if (hit) { hc = x; break; }
      }
      if (!hit) throw notFound();
      hc.issues.splice(hc.issues.indexOf(hit), 1);
      for (const pr of state.projects) {
        for (let i = pr.items.length - 1; i >= 0; i -= 1) {
          if (pr.items[i].content.number === hit.number && itemRepo(pr.items[i]) === hc.full) pr.items.splice(i, 1);
        }
      }
      gone.add(hc.full + '#' + hit.number);
      delete comments[hc.full + '#' + hit.number];
      return { deleteIssue: { repository: { id: hc.node_id } } };
    }
    const p = projectNode(v.projectId);
    state.projects.splice(state.projects.indexOf(p), 1);
    return { deleteProjectV2: { projectV2: { id: p.node_id } } };
  };
  const graphql = async (query, variables) => graphqlNow(query, variables);

  // Test seeding that is not a call: answered at once, never recorded.
  const direct = {
    request(method, path, body) {
      quiet = true;
      try {
        let p = path.startsWith(API) ? path.slice(API.length) : path;
        const q = p.indexOf('?');
        const query = new URLSearchParams(q >= 0 ? p.slice(q + 1) : '');
        if (q >= 0) p = p.slice(0, q);
        return route(String(method).toUpperCase(), p, body, query);
      } finally { quiet = false; }
    },
    graphql(query, variables) {
      quiet = true;
      try { return graphqlNow(query, variables); } finally { quiet = false; }
    },
  };

  return {
    http: { get, paged, send, graphql },
    calls,
    state,
    fail(match, error) { failure = { match, error }; },
    lagItems(count) { lag = Number(count) > 0 ? Number(count) : 0; },
    direct,
    // test door: switch a repo's Issues feature off (or on); GET /repos/:o/:r answers has_issues
    setHasIssues(repoFull, on) { ctxOf(repoFull).hasIssues = on !== false; },
    seedBlockedBy(repoFull, number, list) {
      const c = ctxOf(repoFull);
      setBlockers(c, issueNo(number, c), list);
    },
    seedComment(repoFull, number, { login: who = login, body, created_at: at } = {}) {
      const c = ctxOf(repoFull);
      return copy(addComment(c, issueNo(number, c), { login: who, body: String(body === undefined ? '' : body), created_at: at || stamp() }));
    },
  };
}
