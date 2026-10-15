// CP4 (SKILLS-76): closing a task by its short ref. Written from R55, R61 and R129 (references/contract.md)
// and reference/mapping-redesign/cp4-interface.md section 4a. Fake gh and fake per-owner clients only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, settings, project, task, raw, state, resetNumbers, board } from '../fixtures/build.mjs';
import { closeTask } from '../board/actions.mjs';
import { verbsFromGh } from '../board/github/adapter.mjs';
import { patchIssue } from '../board/github/write.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

const DATA = 'sam-life/life';
const HOME = 'other-org/house';
const CLOSE = { state: 'closed', state_reason: 'completed' };

function card(repo, number, extra = {}) {
  return task({ number, repo, ref: `${repo}#${number}`, html_url: `https://github.com/${repo}/issues/${number}`, ...extra });
}
const item = (repo, number) => ({ type: 'Issue', repo, number, status: null, due: null });

const SETTINGS = settings({
  projects: [{ key: 'house', number: 3, home: HOME }, { key: 'garden', number: 4, home: 'sam-life/garden' }, { key: 'data', number: 5 }],
});

function world() {
  resetNumbers();
  return {
    raw: raw({
      projects: [
        project(3, 'House', [item(HOME, 5)]),
        project(4, 'Garden', [item('sam-life/garden', 5)]),
        project(5, 'Data', [5]),
      ],
      issues: [
        card(HOME, 5, { title: 'Home five' }),
        card('sam-life/garden', 5, { title: 'Garden five' }),
        task({ number: 5, title: 'Data five' }),
      ],
    }),
    settings: SETTINGS,
    theme: undefined,
    state: state(),
    run: { stale: null, readOnly: false, warnings: [] },
  };
}

// A recording gh: patchIssue is the data repo, patchIssueIn any other repo.
function recorder() {
  const calls = [];
  const gh = {
    async patchIssue(number, patch) { calls.push(['patch', number, patch]); return { number, ...patch }; },
    async patchIssueIn(repo, number, patch) { calls.push(['patchIn', repo, number, patch]); return { number, ...patch }; },
  };
  return { gh, calls };
}

// ---------- R61 ----------

test('R61 the full ref of an open home-repo task closes it with one request to that repo', async () => {
  const { gh, calls } = recorder();
  const res = await closeTask(world(), { ref: `${HOME}#5` }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['patchIn', HOME, 5, CLOSE]]);
});

test('R61 a bare number still closes the data-repo card, through the data repo\'s own call', async () => {
  const { gh, calls } = recorder();
  const res = await closeTask(world(), { ref: '5' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['patch', 5, CLOSE]]);
});

test('R61 a number input still works as a bare short ref', async () => {
  const { gh, calls } = recorder();
  const res = await closeTask(world(), { number: '5' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['patch', 5, CLOSE]]);
});

test('R61 a ref with no open task is refused with the open-task message and no request', async () => {
  const { gh, calls } = recorder();
  const res = await closeTask(world(), { ref: `${HOME}#99` }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.message, 'Only an open task can be closed.');
  assert.deepEqual(calls, []);
});

test('R61 a closed home-repo task is refused with no request', async () => {
  const w = world();
  w.raw.issues.push(card(HOME, 8, { state: 'closed' }));
  w.raw.projects[0].items.push(item(HOME, 8));
  const { gh, calls } = recorder();
  const res = await closeTask(w, { ref: `${HOME}#8` }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, false);
  assert.deepEqual(calls, []);
});

test('R61 a ref that cannot be read is refused as not a valid task and sends nothing', async () => {
  const { gh, calls } = recorder();
  const res = await closeTask(world(), { ref: 'not a ref#x' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, false);
  assert.equal(res.message, 'That task number is not valid.');
  assert.deepEqual(calls, []);
});

test('R61 a home-repo number alone does not close the home card: a bare number means the data repo', async () => {
  const w = world();
  w.raw.issues = w.raw.issues.filter((i) => !(i.repo === undefined && i.number === 5));
  w.raw.projects = w.raw.projects.filter((p) => p.number !== 5);
  const { gh, calls } = recorder();
  const res = await closeTask(w, { ref: '5' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, false);
  assert.deepEqual(calls, []);
});

// ---------- R129 ----------

test('R129 with #5 open in two home repos, closing one sends exactly one close, to the right repo', async () => {
  const { gh, calls } = recorder();
  const res = await closeTask(world(), { ref: 'sam-life/garden#5' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [['patchIn', 'sam-life/garden', 5, CLOSE]]);
});

// ---------- R55 / R61: through the owner's client ----------

test('R61 the close of a home card is a PATCH of /repos/<home>/issues/<n> sent by that owner\'s client only', async () => {
  const sent = { default: [], 'other-org': [] };
  const client = (name) => ({ async send(method, path, body) { sent[name].push([method, path, body]); return {}; } });
  const owners = { default: client('default'), forOwner: (login) => (login === 'other-org' ? client('other-org') : client('default')) };
  const gh = {
    patchIssue: (n, patch) => patchIssue(owners.default, DATA, n, patch),
    patchIssueIn: (repo, n, patch) => patchIssue(owners.forOwner(repo.split('/')[0]), repo, n, patch),
  };
  const res = await closeTask(world(), { ref: `${HOME}#5` }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(sent['other-org'], [['PATCH', `/repos/${HOME}/issues/5`, CLOSE]]);
  assert.deepEqual(sent.default, []);
});

test('R61 the twin: a bare number closes through the default client at the data repo', async () => {
  const sent = { default: [], 'other-org': [] };
  const client = (name) => ({ async send(method, path, body) { sent[name].push([method, path, body]); return {}; } });
  const owners = { default: client('default'), forOwner: (login) => (login === 'other-org' ? client('other-org') : client('default')) };
  const gh = {
    patchIssue: (n, patch) => patchIssue(owners.default, DATA, n, patch),
    patchIssueIn: (repo, n, patch) => patchIssue(owners.forOwner(repo.split('/')[0]), repo, n, patch),
  };
  const res = await closeTask(world(), { ref: '5' }, verbsFromGh(gh, DATA), NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(sent.default, [['PATCH', `/repos/${DATA}/issues/5`, CLOSE]]);
  assert.deepEqual(sent['other-org'], []);
});

// ---------- R55: the close form on the page ----------

test('R55 a home card\'s close form is signed for its full ref and a data-repo card\'s for its bare number', () => {
  const w = world();
  const b = board({ raw: w.raw, settings: w.settings });
  const html = renderPage(b, resolveTheme(null).theme, {
    styleNonce: 'n',
    formToken: (action, target) => 'tok-' + action + '-' + target,
  });
  const forms = [...html.matchAll(/<form\b[^>]*action="\/actions\/close"[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const tokens = forms.flatMap((f) => [...f.matchAll(/value="(tok-close-[^"]*)"/g)].map((m) => m[1].replace(/&#x2F;/g, '/')));
  assert.equal(tokens.length, 3, 'one close form per seat');
  assert.ok(tokens.includes(`tok-close-${HOME}#5`));
  assert.ok(tokens.includes('tok-close-sam-life/garden#5'));
  assert.ok(tokens.includes('tok-close-5'));
  assert.equal(new Set(tokens).size, 3, 'two cards numbered 5 get different targets');
});
