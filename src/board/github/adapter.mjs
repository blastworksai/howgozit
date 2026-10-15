// The GitHub adapter: today's reading and writing behind the back-end-neutral interface (seam §5).
import path from 'node:path';
import { GitHubError } from './http.mjs';
import { readAll } from './read.mjs';
import { BackendError, assertAdapter } from '../model/adapter.mjs';

const CONFIG_FILES = new Set([
  'board.config.json',
  'theme.json',
  'state/brief.json',
  'state/calendar.json',
  'state/inbox.json',
  'state/log.json',
  'state/proposals.json',
]);
const CLOSE = { state: 'closed', state_reason: 'completed' };
const EMPTY = () => ({ cards: [], items: [] });

// GitHub's http, or one whose seven files come from the config folder when one is set.
export function configHttp(http, { configDir, readFile }) {
  if (!configDir) return http;
  const marker = '/contents/';
  return {
    ...http,
    get: async (p) => {
      const i = p.indexOf(marker);
      const name = i === -1 ? null : p.slice(i + marker.length);
      if (!name || !CONFIG_FILES.has(name)) return http.get(p);
      let text;
      try {
        text = await readFile(path.join(configDir, name));
      } catch (err) {
        if (err && err.code === 'ENOENT') throw new GitHubError('not-found', 404);
        throw err;
      }
      const content = Buffer.from(text, 'utf8').toString('base64');
      return { status: 200, json: { encoding: 'base64', content }, notModified: false, link: null };
    },
    paged: (...a) => http.paged(...a),
  };
}

const is422 = (e) => e && e.name === 'GitHubError' && e.status === 422;

const ALREADY_MOVED = 'This idea was already moved to its project\'s repository; reload the board and sort it from there.';
const WINDOW_MS = 10 * 60 * 1000;

// BR2-4: a Date, a finite number or a readable string is a time in ms; anything else is null.
function toMs(now) {
  const t = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : typeof now === 'string' ? Date.parse(now) : NaN;
  return Number.isFinite(t) ? t : null;
}

// BR2-3: creates that succeeded, kept for WINDOW_MS. The verbs are built per request, so the server makes ONE memory
// (createMadeMemory) and hands it to every request; a caller that passes none gets a fresh one (no shared state).
export function createMadeMemory() {
  return { ideas: new Map(), copies: new Map() }; // ideas: data repo, title, sorted labels -> { number, at }; copies: original ref, home -> { number, at }
}
function recall(memory, key, at) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (at === null || at - hit.at > WINDOW_MS || hit.at - at > WINDOW_MS) {
    if (at !== null) memory.delete(key);
    return null;
  }
  return hit;
}

export function verbsFromGh(gh, dataRepo = gh && gh.repo, made = createMadeMemory()) {
  const madeIdeas = made.ideas;
  const madeCopies = made.copies;
  // B11 (R56): an open data-repo issue with this exact title and the idea label, made in the last 10 minutes and not yet an Ideas item.
  async function earlierPost({ title, labels, ideasProject, now }) {
    if (typeof gh.listIssuesIn !== 'function' || typeof gh.listProjectIssues !== 'function' || typeof dataRepo !== 'string') return null;
    const open = await gh.listIssuesIn(dataRepo, { state: 'open' });
    const at = toMs(now);
    if (at === null) return null; // BR2-4: an unreadable time adopts nothing
    const same = (Array.isArray(open) ? open : []).filter((i) => {
      if (!i || i.pull_request || i.title !== title) return false;
      const names = (i.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
      if (!labels.every((l) => names.includes(l))) return false;
      const made = Date.parse(i.created_at);
      return Number.isFinite(made) && at - made <= WINDOW_MS && made - at <= WINDOW_MS;
    });
    if (same.length === 0) return null;
    const items = await gh.listProjectIssues(ideasProject);
    const have = new Set((Array.isArray(items) ? items : []).map((x) => `${String(x.repo).toLowerCase()}#${x.number}`));
    return same.find((i) => !have.has(`${dataRepo.toLowerCase()}#${i.number}`)) || null;
  }

  const verbs = {
    async logIdea({ title, labels, ideasProject, now }) {
      // B11: a re-post after a failed Ideas add finds the issue the first post left behind instead of creating another.
      const at = toMs(now);
      const key = `${String(dataRepo).toLowerCase()}|${title}|${JSON.stringify([...labels].sort())}`;
      let made = null;
      if (ideasProject) {
        // BR2-3: this process's own memory of an earlier create comes first.
        const kept = recall(madeIdeas, key, at);
        if (kept && typeof gh.listProjectIssues === 'function') {
          const items = await gh.listProjectIssues(ideasProject);
          const have = new Set((Array.isArray(items) ? items : []).map((x) => `${String(x.repo).toLowerCase()}#${x.number}`));
          if (!have.has(`${String(dataRepo).toLowerCase()}#${kept.number}`)) made = { number: kept.number };
        }
        made = made || (await earlierPost({ title, labels, ideasProject, now }));
      }
      if (!made) {
        made = await gh.createIssue({ title, labels });
        if (ideasProject && at !== null && made && Number.isInteger(made.number)) madeIdeas.set(key, { number: made.number, at });
      }
      if (ideasProject) {
        // R56: the new issue joins the Ideas Project; a 422 means it is already an item.
        try {
          await gh.addProjectItem({ owner: ideasProject.owner, ownerType: ideasProject.ownerType, projectNumber: ideasProject.projectNumber, repo: dataRepo, issueNumber: made.number });
        } catch (e) {
          if (!is422(e)) throw e;
        }
      }
      return EMPTY();
    },
    async setCheckin({ habitTitle, habitLabel, date, on, existing }) {
      const today = existing || [];
      if (on) {
        const open = today.filter((i) => i.state === 'open');
        if (open.length > 0) {
          for (const i of open) await gh.patchIssue(i.number, CLOSE);
        } else if (today.length === 0) {
          const made = await gh.createIssue({ title: `${habitTitle} · ${date}`, labels: [habitLabel] });
          await gh.patchIssue(made.number, CLOSE);
        }
      } else {
        for (const i of today.filter((x) => x.state === 'closed')) await gh.patchIssue(i.number, { state: 'open' });
      }
      return EMPTY();
    },
    async fileIdea({ number, projectNumber, needAdd, milestone, labels, step, plan, now }) {
      if (plan) return fileIdeaPlan({ needAdd, milestone, labels, step, plan, now });
      if (needAdd) {
        step('adding it to the project');
        try {
          await gh.addProjectItem({ projectNumber, issueNumber: number });
        } catch (e) {
          // GitHub answers a second add of the same issue with 422, and its item list can run behind.
          if (!(e && e.name === 'GitHubError' && e.status === 422)) throw e;
        }
      }
      if (milestone !== null && milestone !== undefined) {
        step('setting the milestone');
        await gh.patchIssue(number, { milestone });
      }
      step('removing the idea label');
      await gh.patchIssue(number, { labels });
      return EMPTY();
    },
    async closeCard({ card, number }) {
      const repo = card && typeof card.repo === 'string' ? card.repo : null;
      const n = card && card.number !== undefined ? card.number : number;
      // A card of the data repo (or one whose home is unknown) goes the way it always went; any other repo has its own door.
      if (repo !== null && typeof dataRepo === 'string' && repo.toLowerCase() !== dataRepo.toLowerCase()) await gh.patchIssueIn(repo, n, CLOSE);
      else await gh.patchIssue(n, CLOSE);
      return EMPTY();
    },
    // R140: close the day's check-in (creating it first when there is none), make it an item of the Habits Project, set its Score.
    async setScore(args) {
      const { habitTitle, habitLabel, date, score, existing, carrier, itemId, project, step } = args;
      const today = existing || [];
      let issueNumber = carrier;
      if (today.length === 0) {
        step('creating the check-in');
        const made = await gh.createIssue({ title: `${habitTitle} · ${date}`, labels: [habitLabel] });
        step('closing the check-in');
        await gh.patchIssue(made.number, CLOSE);
        issueNumber = made.number;
      } else if (!today.some((i) => i.state === 'closed')) {
        step('closing the check-in');
        for (const i of today.filter((x) => x.state === 'open')) await gh.patchIssue(i.number, CLOSE);
      }
      const where = { owner: project.owner, ownerType: project.ownerType, projectNumber: project.projectNumber };
      let id = itemId;
      if (id === null || id === undefined) {
        step('adding it to the Habits Project');
        try {
          const out = await gh.addProjectItem({ ...where, repo: dataRepo, issueNumber });
          id = out && Number.isInteger(out.id) ? out.id : null;
        } catch (e) {
          if (!is422(e)) throw e;
          id = null;
        }
        if (id === null) {
          step(null);
          throw new BackendError('unavailable', 502, 'GitHub did not say which Habits item to score; try again in a minute.');
        }
      }
      step('setting the score');
      await gh.setItemNumber({ ...where, itemId: id, fieldId: project.scoreField, value: score, repo: dataRepo, issueNumber });
      return EMPTY();
    },
  };

  const patchAt = (repo, n, patch) =>
    typeof dataRepo !== 'string' || repo.toLowerCase() === dataRepo.toLowerCase() ? gh.patchIssue(n, patch) : gh.patchIssueIn(repo, n, patch);

  // R59 with the Ideas Project and/or a home: move the idea home, add, goal, stop being an idea, close the original.
  async function fileIdeaPlan({ needAdd, milestone, labels, step, plan, now }) {
    const { idea, move, project, ideasProject, settingsIdeas } = plan;
    let card = { repo: idea.repo, number: idea.number };
    let copied = false;
    const nowMs = toMs(now !== undefined ? now : plan.now);
    if (move) {
      const home = move.home;
      if (move.sameOwner) {
        step(`moving it to ${home}`);
        let from;
        try {
          from = await gh.getIssueIn(idea.repo, idea.number);
        } catch (e) {
          // B8: GitHub answers 3xx for an issue that has already been transferred.
          if (e && e.name === 'GitHubError' && e.status >= 300 && e.status < 400) {
            step(null);
            throw new BackendError('conflict', 409, ALREADY_MOVED);
          }
          throw e;
        }
        const to = await gh.getRepo(home);
        const out = await gh.transferIssue({ owner: idea.repo.split('/')[0], issueId: from.node_id, repositoryId: to.node_id });
        const moved = out?.data?.transferIssue?.issue ?? out?.transferIssue?.issue ?? out?.issue ?? out;
        if (!moved || !Number.isInteger(moved.number)) throw new BackendError('unavailable', 502, 'GitHub did not say where the issue went.');
        card = { repo: home, number: moved.number };
        const got = await gh.getIssueIn(home, moved.number);
        if (typeof gh.noteIssue === 'function') gh.noteIssue(home, got);
        if (typeof gh.noteRemoved === 'function') gh.noteRemoved(idea.ref);
      } else {
        step(`copying it to ${home}`);
        const marker = `<!-- howgozit-moved-from: ${idea.ref} -->`;
        const carries = (issue) => issue && typeof issue.body === 'string' && issue.body.trimEnd().endsWith(marker);
        const comments = await gh.listComments(idea.repo, idea.number);
        const mark = `moved to ${home.toLowerCase()}#`;
        let found = null;
        // BR2-3: the copy this process made for this original comes first.
        const copyKey = `${String(idea.ref).toLowerCase()}|${home.toLowerCase()}`;
        const kept = recall(madeCopies, copyKey, nowMs);
        if (kept) {
          let got = null;
          try {
            got = await gh.getIssueIn(home, kept.number);
          } catch (e) {
            if (!(e && e.name === 'GitHubError' && e.status === 404)) throw e;
          }
          if (carries(got)) found = { number: kept.number, got };
        }
        // B9: a "Moved to" comment counts only when the issue it names carries this original's marker.
        for (const b of found ? [] : (Array.isArray(comments) ? comments : []).map((c) => (c && typeof c.body === 'string' ? c.body : ''))) {
          if (!b.toLowerCase().startsWith(mark)) continue;
          const m = /^\d+/.exec(b.slice(mark.length));
          if (!m) continue;
          let got = null;
          try {
            got = await gh.getIssueIn(home, Number(m[0]));
          } catch (e) {
            if (!(e && e.name === 'GitHubError' && e.status === 404)) throw e;
          }
          if (carries(got)) {
            found = { number: Number(m[0]), got };
            break;
          }
        }
        // linked: a comment already names this copy (also when the copy came from this process's memory)
        const names = (n) => (Array.isArray(comments) ? comments : []).some((c) => {
          const b = c && typeof c.body === 'string' ? c.body.toLowerCase() : '';
          return b.startsWith(`${mark}${n}`) && !/^\d/.test(b.slice(mark.length + String(n).length));
        });
        let linked = found !== null && names(found.number);
        // B10: otherwise the home repo's open issues are searched for the marker before a copy is created.
        if (!found && typeof gh.listIssuesIn === 'function') {
          const open = await gh.listIssuesIn(home, { state: 'open' });
          const hit = (Array.isArray(open) ? open : []).find((i) => carries(i) && !i.pull_request);
          if (hit) found = { number: hit.number, got: hit };
        }
        if (found) {
          card = { repo: home, number: found.number };
          // the copy of an earlier post is fetched once so the redirected page shows it (R70)
          const got = await gh.getIssueIn(home, card.number);
          if (typeof gh.noteIssue === 'function') gh.noteIssue(home, got);
          if (!linked) {
            step('linking the copy');
            await gh.addComment(idea.repo, idea.number, `Moved to ${home}#${card.number}`);
          }
        } else {
          const made = await gh.createIssueIn(home, { title: idea.title, body: `Moved from ${idea.ref}.\n\n${marker}`, labels });
          if (nowMs !== null && made && Number.isInteger(made.number)) madeCopies.set(copyKey, { number: made.number, at: nowMs });
          step('linking the copy');
          await gh.addComment(idea.repo, idea.number, `Moved to ${home}#${made.number}: ${made.html_url}`);
          card = { repo: home, number: made.number };
        }
        copied = true;
      }
    }
    if (needAdd) {
      step('adding it to the project');
      const where = { projectNumber: project.number, issueNumber: card.number };
      if (project.owner) {
        where.owner = project.owner;
        where.ownerType = project.ownerType;
      }
      if (typeof dataRepo !== 'string' || card.repo.toLowerCase() !== dataRepo.toLowerCase()) where.repo = card.repo;
      try {
        await gh.addProjectItem(where);
      } catch (e) {
        if (!is422(e)) throw e;
      }
    }
    if (milestone !== null && milestone !== undefined) {
      step('setting the milestone');
      await patchAt(card.repo, card.number, { milestone });
    }
    if (settingsIdeas) {
      if (ideasProject) {
        step('removing it from the Ideas Project');
        try {
          await gh.deleteProjectItem({ ...ideasProject, repo: idea.repo, issueNumber: idea.number });
        } catch (e) {
          if (!(e && e.name === 'GitHubError' && e.status === 404)) throw e;
        }
      }
    } else if (!copied) {
      step('removing the idea label');
      await patchAt(card.repo, card.number, { labels });
    }
    if (move && !move.sameOwner) {
      step('closing the original');
      await patchAt(idea.repo, idea.number, { state: 'closed', state_reason: 'not_planned' });
    }
    return EMPTY();
  }
  return verbs;
}

export function createGithubAdapter({ http, httpFor, repo, configDir, readFile, gh }) {
  // One field cache for the life of the adapter: field ids are asked once per Project (R141).
  const fieldCache = new Map();
  const ownerTypeCache = new Map();
  return assertAdapter({
    kind: 'github',
    read: (opts) => readAll(configHttp(http, { configDir, readFile }), { repo, httpFor, fieldCache, ownerTypeCache, ...opts }),
    ...verbsFromGh(gh, repo),
  });
}
