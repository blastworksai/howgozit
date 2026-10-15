// actions: the four writes the board makes to GitHub (contract R54, R56 to R61). Issues and labels only; never a file.
// Each action resolves to { ok: true } or { ok: false, status: 400 | 502, message } and never rejects.
import { prepare } from './prepare.mjs';
import { buildBoard } from './model.mjs';
import { BackendError } from './model/adapter.mjs';
import { parseShortRef, refKey } from './model/snapshot.mjs';

const OK = { ok: true };
const norm = (s) => String(s).trim().toLowerCase();

class Refusal extends Error {}

const refuse = (message) => {
  throw new Refusal(message);
};

// Runs the whole body: a refusal gives 400, anything else 502 naming the step when there is one.
async function run(body) {
  let step = null;
  const at = (name) => {
    step = name;
  };
  try {
    await body(at);
    return OK;
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, status: 400, message: err.message };
    const base = err && (err.name === 'GitHubError' || err instanceof BackendError) && typeof err.message === 'string' && err.message !== ''
      ? err.message
      : 'GitHub did not accept the change.';
    const message = step === null ? base : `${base.replace(/\.?$/, '')} while ${step}.`;
    return { ok: false, status: 502, message };
  }
}

function positiveInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 && Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBare = (v) => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v);
// The bare-number match is for a Notion board only; GitHub keeps today's comparison of refs, byte for byte.
const isNotion = (bundle) => isObj(bundle) && isObj(bundle.raw) && bundle.raw.source === 'notion';

// A bundle without its data or its settings is nothing to act on.
function bundleCtx(bundle, now) {
  if (!isObj(bundle) || !isObj(bundle.raw) || !isObj(bundle.settings)) refuse('The board has no data to act on yet; reload the page and try again.');
  return prepare({ ...bundle, now });
}

export async function logIdea(bundle, input, verbs, now) {
  return run(async () => {
    const { title } = input ?? {};
    const clean = String(title ?? '')
      .replace(/\p{Cc}/gu, (c) => (/\s/.test(c) ? ' ' : ''))
      .replace(/\s+/g, ' ')
      .trim();
    const length = [...clean].length;
    if (length === 0) refuse('Please type a title for the idea.');
    if (length > 200) refuse('That title is too long; please keep it under 200 characters.');
    const ctx = bundleCtx(bundle, now);
    if (ctx.settings.ideas !== undefined) {
      // R56: with the Ideas Project in the settings, the new issue is added to it as a second write.
      const row = ctx.roleRow('ideas');
      if (!row || positiveInt(row.number) === null || typeof row.owner !== 'string' || row.owner === '' || (row.ownerType !== 'user' && row.ownerType !== 'organization')) {
        refuse('The Ideas Project in the settings was not found on GitHub, so the idea was not logged.');
      }
      await verbs.logIdea({
        title: clean,
        labels: [ctx.settings.labels.idea],
        ideasProject: { owner: row.owner, ownerType: row.ownerType, projectNumber: row.number },
        now,
      });
      return;
    }
    await verbs.logIdea({ title: clean, labels: [ctx.settings.labels.idea] });
  });
}

export async function setHabit(bundle, input, verbs, now) {
  return run(async () => {
    const { id, date, on } = input ?? {};
    const ctx = bundleCtx(bundle, now);
    const habit = (ctx.settings.habits || []).find((h) => h && h.id === id);
    if (!habit) refuse('That habit does not exist.');
    if (isObj(habit.score)) refuse('This habit takes a score.');
    if (date !== ctx.today) refuse('A habit can only be changed for today.');
    const today = ctx.checkins.filter((c) => c.habitId === habit.id && c.date === ctx.today).map((c) => c.issue);
    await verbs.setCheckin({
      habitTitle: habit.title,
      habitLabel: ctx.settings.labels.habitPrefix + habit.id,
      date: ctx.today,
      on,
      existing: today,
    });
  });
}

const lower = (v) => String(v).toLowerCase();

// The owner of a listed project when it is not the data repo's owner, with its owner type from the read.
function targetOwner(ctx, key, number) {
  const dataOwner = typeof ctx.raw?.repo === 'string' ? lower(ctx.raw.repo.split('/')[0]) : '';
  const entry = (Array.isArray(ctx.settings.projects) ? ctx.settings.projects : []).find((p) => isObj(p) && p.key === key);
  if (!entry || typeof entry.owner !== 'string' || entry.owner === '' || lower(entry.owner) === dataOwner) return {};
  const row = (Array.isArray(ctx.raw?.projects) ? ctx.raw.projects : []).find(
    (p) => isObj(p) && (p.role === undefined || p.role === null) && p.number === number && typeof p.owner === 'string' && lower(p.owner) === lower(entry.owner),
  );
  return { owner: entry.owner, ownerType: row ? row.ownerType : undefined };
}

export async function sortIdea(bundle, input, verbs, now) {
  return run(async (at) => {
    const { number, ref, project, milestone, accept } = input ?? {};
    const value = ref ?? number;
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null;
    const dataRepo = isObj(bundle) && isObj(bundle.raw) && typeof bundle.raw.repo === 'string' ? bundle.raw.repo : '';
    const n0 = positiveInt(value);
    const parsed = n0 !== null && dataRepo !== '' ? `${dataRepo}#${n0}` : text !== null ? parseShortRef(text, dataRepo) : null;
    if (parsed === null) refuse('That idea number is not valid.');
    const ctx = bundleCtx(bundle, now);
    // On Notion a form carries a bare number and a card's ref is notion:<page id>: match the short ref of the card (seam §2).
    const bare = isBare(text) && isNotion(bundle) ? text : null;
    const idea = ctx.ideas.find((i) => (bare !== null ? String(ctx.shortRef(i)) === bare : refKey(ctx.refOf(i)) === refKey(parsed)) && i.state === 'open');
    if (!idea) refuse('Only an open idea can be sorted.');
    const ideaRef = ctx.refOf(idea);
    const short = String(ctx.shortRef(idea));

    let key = project;
    let ms = null;
    if (accept) {
      const board = buildBoard({ ...bundle, now });
      const item = (board.ideas?.items || []).find((i) => lower(i.ref ?? i.number) === lower(short));
      const s = item ? item.suggestion : null;
      if (!s || s.acceptable !== true || typeof s.project !== 'string') refuse('There is no suggestion that can be accepted for this idea.');
      key = s.project;
      ms = s.milestone ?? null;
    } else if (milestone !== undefined && milestone !== null && String(milestone).trim() !== '') {
      ms = positiveInt(milestone);
      if (ms === null) refuse('That milestone is not valid.');
    }

    const shown = ctx.shown.find((p) => p.key === key);
    if (!shown) refuse('That project is not on the board.');
    const home = typeof ctx.homeOf === 'function' ? ctx.homeOf(shown.key) : null;
    const ideaRepo = String(ideaRef).split('#')[0];
    const needMove = typeof home === 'string' && home !== '' && lower(home) !== lower(ideaRepo);
    if (ms !== null) {
      // A goal of a project with a home is a goal of its home repo; otherwise it is the data repo's, as before.
      const goalRepo = lower(typeof home === 'string' && home !== '' ? home : dataRepo);
      const m = ctx.sortGoalsOf(shown.key).find((x) => x.number === ms && String(ctx.goalRepoOf(x)).toLowerCase() === goalRepo);
      if (!m) refuse('That milestone does not belong to this project.');
      if (m.closed === true) refuse('That milestone is already closed.');
    }

    const ideaLabel = norm(ctx.settings.labels.idea);
    const labels = idea.labels.filter((l) => norm(l) !== ideaLabel);
    const settingsIdeas = ctx.settings.ideas !== undefined;
    const needAdd = needMove ? true : !ctx.projectsOf(ideaRef).includes(shown.key);
    const milestoneOut = ms !== null && (needMove || idea.milestone !== ms) ? ms : null;
    const dataLower = lower(dataRepo);
    const args = {
      number: idea.number,
      projectNumber: shown.number,
      needAdd,
      milestone: milestoneOut,
      labels,
      step: at,
    };
    const target = targetOwner(ctx, shown.key, shown.number);
    // B3: a project with its own owner always takes the plan path, so that owner reaches addProjectItem.
    if (!needMove && !settingsIdeas && lower(ideaRepo) === dataLower && target.owner === undefined) {
      await verbs.fileIdea(args); // the off path: exactly today's call
      return;
    }
    let ideasProject = null;
    if (settingsIdeas) {
      const row = ctx.roleRow('ideas');
      const item = ctx.ideaItemOf(idea);
      if (row && item && positiveInt(item.itemId) !== null) {
        ideasProject = { owner: row.owner, ownerType: row.ownerType, projectNumber: row.number, itemId: item.itemId };
      }
    }
    await verbs.fileIdea({
      ...args,
      now, // BR2-3: the move remembers its copy for a re-post
      plan: {
        dataRepo,
        idea: { repo: ideaRepo, number: idea.number, ref: ideaRef, title: idea.title, labels },
        move: needMove ? { home, sameOwner: lower(ideaRepo.split('/')[0]) === lower(home.split('/')[0]) } : null,
        project: { number: shown.number, ...target },
        ideasProject,
        settingsIdeas,
      },
    });
  });
}

// R140: set today's score for a habit that takes one.
export async function setScore(bundle, input, verbs, now) {
  return run(async (at) => {
    const { id, date, score } = input ?? {};
    const ctx = bundleCtx(bundle, now);
    const habit = (ctx.settings.habits || []).find((h) => h && h.id === id);
    if (!habit) refuse('That habit does not exist.');
    if (!isObj(habit.score)) refuse('This habit does not take a score.');
    if (date !== ctx.today) refuse('A habit can only be changed for today.');
    const { min, max } = habit.score;
    const n = typeof score === 'number' ? score : typeof score === 'string' && /^\d+$/.test(score.trim()) ? Number(score.trim()) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) refuse(`The score must be a whole number from ${min} to ${max}.`);
    const row = ctx.roleRow('habits');
    const field = row ? row.scoreField : undefined;
    const fieldOk = (typeof field === 'string' && field !== '') || positiveInt(field) !== null;
    if (!row || !fieldOk || positiveInt(row.number) === null || typeof row.owner !== 'string' || row.owner === '' || (row.ownerType !== 'user' && row.ownerType !== 'organization')) {
      refuse('The Habits Project has no Score field, so the score was not set.');
    }
    const today = ctx.checkins.filter((c) => c.habitId === habit.id && c.date === ctx.today).map((c) => c.issue);
    // The check-in that carries the score: the closed one updated last (ties: higher number), else the open one that will be closed.
    const best = (list) => list.reduce((a, b) => {
      const au = String(a.updated_at ?? '');
      const bu = String(b.updated_at ?? '');
      if (au !== bu) return au > bu ? a : b;
      return a.number >= b.number ? a : b;
    });
    const closed = today.filter((i) => i.state === 'closed');
    const open = today.filter((i) => i.state === 'open');
    const carrier = closed.length > 0 ? best(closed) : open.length > 0 ? best(open) : null;
    const item = carrier ? ctx.habitItemOf(carrier) : null;
    const itemId = item && positiveInt(item.itemId) !== null ? item.itemId : null;
    await verbs.setScore({
      habitTitle: habit.title,
      habitLabel: ctx.settings.labels.habitPrefix + habit.id,
      date: ctx.today,
      score: n,
      existing: today,
      carrier: carrier ? carrier.number : null,
      itemId,
      project: { owner: row.owner, ownerType: row.ownerType, projectNumber: row.number, scoreField: field },
      step: at,
    });
  });
}

export async function closeTask(bundle, input, verbs, now) {
  return run(async () => {
    const { ref, number } = input ?? {};
    const value = ref ?? (typeof number === 'number' ? String(number) : number);
    const dataRepo = isObj(bundle) && isObj(bundle.raw) && typeof bundle.raw.repo === 'string' ? bundle.raw.repo : '';
    const parsed = typeof value === 'string' ? parseShortRef(value.trim(), dataRepo) : null;
    if (parsed === null) refuse('That task number is not valid.');
    const ctx = bundleCtx(bundle, now);
    const bare = isNotion(bundle) && /^[1-9]\d{0,9}$/.test(value.trim()) ? value.trim() : null;
    const task = ctx.tasks.find((t) => t.state === 'open' && (bare !== null ? String(ctx.shortRef(t)) === bare : refKey(ctx.refOf(t)) === refKey(parsed)));
    // Under a shown project (projectsOf lists shown projects only) or standalone: either way a task the board shows.
    if (!task) refuse('Only an open task can be closed.');
    await verbs.closeCard({ card: { repo: typeof task.repo === 'string' && task.repo !== '' ? task.repo : dataRepo, number: task.number } });
  });
}
