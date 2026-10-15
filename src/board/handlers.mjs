// The request handlers: the page and the five actions (R55, R62, R63, R67, R70, R77).
// Time comes only from the injected clock; nothing here reads the environment or logs.
import { randomBytes } from 'node:crypto';
import { buildBoard } from './model.mjs';
import { renderPage, renderNotice } from './render/page.mjs';
import { themeCss } from './theme.mjs';
import { createMadeMemory, verbsFromGh } from './github/adapter.mjs';
import { parseShortRef } from './model/snapshot.mjs';
import { logIdea, setHabit, sortIdea, closeTask, setScore } from './actions.mjs';

const HTML = 'text/html; charset=utf-8';
const FONT_STYLE = 'https://fonts.googleapis.com';
const FONT_FILES = 'https://fonts.gstatic.com';
const TITLES = { 400: 'That did not work', 403: 'Not allowed', 502: 'GitHub did not answer', 503: 'The board is not available' };
const FAILED = 'Something went wrong on the board. Nothing was changed that you can see; try again in a minute.';

export function securityHeaders({ nonce = null, fontHosts = false } = {}) {
  const style = ["'self'"];
  if (nonce) style.push(`'nonce-${nonce}'`);
  if (fontHosts) style.push(FONT_STYLE);
  const parts = [
    "default-src 'none'",
    "script-src 'self'",
    `style-src ${style.join(' ')}`,
  ];
  if (fontHosts) parts.push(`font-src ${FONT_FILES}`);
  parts.push("img-src 'self' data:", "connect-src 'self'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'");
  const csp = parts.join('; ');
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

function noticeAnswer(title, message, status) {
  return {
    status,
    headers: { ...securityHeaders(), 'content-type': HTML },
    body: renderNotice({ title, message, status }),
  };
}

const fromLoader = (n) => noticeAnswer(n.title, n.message, n.status || 503);
const refusal = (status, message) => noticeAnswer(TITLES[status] || TITLES[400], message, status);
const redirect = () => ({ status: 303, headers: { ...securityHeaders(), location: '/' }, body: '' });
const str = (v) => (typeof v === 'string' ? v : '');

// The target a form token is signed for, and the input the action takes; null when the form cannot give one.
function readForm(name, form, dataRepo) {
  if (name === 'idea') return { target: 'new', input: { title: str(form.title) } };
  if (name === 'habit') {
    const id = str(form.id);
    const date = str(form.date);
    if (!id || !date || (form.on !== '1' && form.on !== '0')) return null;
    const on = form.on === '1';
    return { target: `${id}:${date}:${on ? 'on' : 'off'}`, input: { id, date, on } };
  }
  if (name === 'score') {
    const id = str(form.id);
    const date = str(form.date);
    const score = str(form.score);
    if (!id || !date || !score) return null;
    return { target: `${id}:${date}:score`, input: { id, date, score } };
  }
  if (name === 'sort' || name === 'close') {
    const number = str(form.number);
    if (!number) return null;
    if (name === 'close') return parseShortRef(number, dataRepo) === null ? null : { target: number, input: { ref: number } };
    if (form.accept === '1') return { target: number, input: { number, accept: true } };
    const [project, milestone, ...rest] = str(form.target).split('/');
    if (!project || rest.length) return null;
    return { target: number, input: { number, project, milestone: milestone || undefined, accept: false } };
  }
  return null;
}

const RUN = { idea: logIdea, habit: setHabit, sort: sortIdea, close: closeTask, score: setScore };

export function createHandlers({ loader, gh, guard, env, clock, random = () => randomBytes(16).toString('base64url'), verbsFor }) {
  const notion = env.backend === 'notion';
  const owner = String(env.repo || '').split('/')[0];

  // The low-level gh, shaped for the actions, telling the loader about each write (R70).
  // The seam: the verbs for a bundle. The default is today's GitHub verbs (the off path); a Notion board passes its adapter.
  const made = createMadeMemory(); // BR2-3: one memory of completed creates for the life of the server
  const verbsOf = typeof verbsFor === 'function' ? verbsFor : (bundle) => verbsFromGh(wrap(bundle), env.repo, made);

  function wrap(bundle) {
    return {
      async createIssue(args) {
        const issue = await gh.createIssue(args);
        loader.noteWrite({ apiIssue: issue });
        return issue;
      },
      async patchIssue(number, patch) {
        const issue = await gh.patchIssue(number, patch);
        loader.noteWrite({ apiIssue: issue });
        return issue;
      },
      async patchIssueIn(repo, number, patch) {
        const issue = await gh.patchIssueIn(repo, number, patch);
        loader.noteWrite({ apiIssue: issue, repo });
        return issue;
      },
      listIssuesIn: (repo, o) => gh.listIssuesIn(repo, o),
      listProjectIssues: (x) => gh.listProjectIssues(x),
      async createIssueIn(repo, args) {
        const issue = await gh.createIssueIn(repo, args);
        loader.noteWrite({ apiIssue: issue, repo });
        return issue;
      },
      getIssueIn: (repo, number) => gh.getIssueIn(repo, number),
      getRepo: (repo) => gh.getRepo(repo),
      transferIssue: (args) => gh.transferIssue(args),
      listComments: (repo, number) => gh.listComments(repo, number),
      addComment: (repo, number, body) => gh.addComment(repo, number, body),
      async addProjectItem({ owner: projectOwner, ownerType, projectNumber, repo, issueNumber }) {
        const where = { projectOwner: projectOwner ?? null, projectNumber, ...(repo === undefined ? {} : { repo }), issueNumber };
        let out;
        try {
          out = await gh.addProjectItem({
            owner: projectOwner ?? owner,
            ownerType: ownerType ?? bundle.raw.ownerType,
            projectNumber,
            ...(repo === undefined ? {} : { repo }),
            issueNumber,
          });
        } catch (e) {
          // A 422 means the issue is already an item of that Project (R59): hold it as a write (R70), then let actions decide.
          if (e && e.name === 'GitHubError' && e.status === 422) loader.noteWrite({ item: where });
          throw e;
        }
        loader.noteWrite({ item: where });
        return out;
      },
      async deleteProjectItem({ owner: projectOwner, ownerType, projectNumber, itemId, repo, issueNumber }) {
        const where = { projectOwner: projectOwner ?? null, projectNumber, ...(repo === undefined ? {} : { repo }), issueNumber, removed: true };
        let out;
        try {
          out = await gh.deleteProjectItem({ owner: projectOwner ?? owner, ownerType: ownerType ?? bundle.raw.ownerType, projectNumber, itemId });
        } catch (e) {
          // A 404 means it is already gone: hold the removal, then let actions decide.
          if (e && e.name === 'GitHubError' && e.status === 404) loader.noteWrite({ item: where });
          throw e;
        }
        loader.noteWrite({ item: where });
        return out;
      },
      async setItemNumber({ owner: projectOwner, ownerType, projectNumber, itemId, fieldId, value, repo, issueNumber }) {
        const out = await gh.setItemNumber({ owner: projectOwner ?? owner, ownerType: ownerType ?? bundle.raw.ownerType, projectNumber, itemId, fieldId, value });
        loader.noteWrite({ item: { projectOwner: projectOwner ?? null, projectNumber, ...(repo === undefined ? {} : { repo }), issueNumber, itemId, score: value } });
        return out;
      },
      noteRemoved(ref) {
        loader.noteWrite({ removeRef: ref });
      },
      // CP6 (lead): a moved idea or a found copy, held like any issue GitHub returned (R70)
      noteIssue(repo, apiIssue) {
        loader.noteWrite({ apiIssue, repo });
      },
    };
  }

  async function page() {
    const loaded = await loader.load();
    if (!loaded.ok) return fromLoader(loaded.notice);
    const bundle = loaded.bundle;
    const nonce = random();
    const board = buildBoard({ ...bundle, now: new Date(clock.now()).toISOString() });
    const body = renderPage(board, bundle.theme, { styleNonce: nonce, formToken: guard.formToken });
    return {
      status: 200,
      headers: {
        ...securityHeaders({ nonce, fontHosts: themeCss(bundle.theme).fontHosts === true }),
        'content-type': HTML,
      },
      body,
    };
  }

  const inFlight = new Map();

  async function runAction(name, req, form) {
    if (env.readOnly) return refusal(403, 'The board is read-only, so changes are switched off.');
    const read = readForm(name, form || {}, env.repo);
    if (!read) return refusal(400, 'That form is missing something, so nothing was changed.');
    const token = str(form.token);
    const checked = guard.checkPost(req, name, read.target, token);
    if (!checked.ok) return refusal(403, `The change was refused: ${checked.reason}. Reload the page and try again.`);
    if (guard.remembered(token)) return redirect();
    // Two posts of one token that overlap are one write: the second awaits the first's answer (R55).
    if (inFlight.has(token)) return inFlight.get(token);
    const work = (async () => {
      const loaded = await loader.load();
      if (!loaded.ok) return fromLoader(loaded.notice);
      if (loaded.bundle.run && loaded.bundle.run.stale) {
        return refusal(502, `${notion ? 'Notion' : 'GitHub'} is not answering right now, so nothing was changed. Try again in a minute.`);
      }
      const now = new Date(clock.now()).toISOString();
      const result = await RUN[name](loaded.bundle, read.input, verbsOf(loaded.bundle), now);
      if (!result.ok) return refusal(result.status, result.message);
      guard.remember(token);
      await loader.load();
      return redirect();
    })();
    inFlight.set(token, work);
    try {
      return await work;
    } finally {
      inFlight.delete(token);
    }
  }

  // No handler throws: an unexpected error becomes a plain 500 page with no detail.
  const safe = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch {
      return noticeAnswer('Something went wrong', FAILED, 500);
    }
  };

  return { page: safe(page), action: safe(runAction) };
}
