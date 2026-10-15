import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbeV2, parseArgs } from '../scripts/probe-v2.mjs';
import { GitHubError } from '../board/github/http.mjs';

const CLASSIC = 'ghp_CLASSICSECRET1234567890';
const FINE = 'github_pat_FINESECRET1234567890';
const SECRET_TEXT = 'SECRET-TITLE-AND-BODY-TEXT';
const ARGS = { orgRepo: 'acme/one', orgRepo2: 'acme/two', userRepo: 'me/probe', step: 'all' };

// A small world behind a fake http. `who` names the credential; `rules` can refuse a call by returning a status.
function world({ refuse = () => null, failStep } = {}) {
  const calls = [];
  let n = 100;
  const issues = new Map();
  const make = (who) => {
    const fake = (method, path, body) => {
      calls.push({ who, method, path, body });
      const r = refuse(who, method, path, body);
      if (r) throw new GitHubError(r.kind || 'invalid', r.status, `${r.status} refused ${CLASSIC}`);
      let m;
      if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) return { id: 1 };
      if (method === 'POST' && (m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path))) {
        n += 1;
        const issue = { id: 9000 + n, number: n, node_id: `I_${n}`, title: SECRET_TEXT, body: SECRET_TEXT, state: 'open', milestone: null };
        issues.set(`${m[1]}#${n}`, issue);
        return issue;
      }
      if (method === 'POST' && /dependencies\/blocked_by$/.test(path)) return { id: 1, title: SECRET_TEXT };
      if (method === 'GET' && /dependencies\/blocked_by$/.test(path)) {
        return [{ id: 5, number: 5, title: SECRET_TEXT, body: SECRET_TEXT, repository_url: 'https://x', html_url: 'https://y' }];
      }
      if (method === 'GET' && /\/issues\?state=open/.test(path)) {
        return [{ number: 101, title: SECRET_TEXT, issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1, blocking: 0, total_blocking: 0 } }];
      }
      if (method === 'POST' && /\/milestones$/.test(path)) return { number: 3, title: SECRET_TEXT };
      if (method === 'DELETE') return null;
      if (method === 'GET' && (m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path))) {
        const iss = issues.get(`${m[1]}#${m[2]}`);
        if (iss && iss.deleted) throw new GitHubError('not-found', 404);
        return { ...(iss || {}), state: 'open', milestone: null };
      }
      if (method === 'GET' && /\/fields$/.test(path)) return [{ id: 55, name: 'Score', data_type: 'number', title: SECRET_TEXT }];
      if (method === 'POST' && /\/items$/.test(path)) return { id: 77, node_id: 'PVTI_77' };
      if (method === 'PATCH') return { id: 77 };
      if (method === 'GET' && /\/items\?fields=/.test(path)) return [{ id: 77, fields: [{ id: 55, name: 'Score', data_type: 'number', value: 7 }] }];
      if (method === 'GET' && /\/items\?/.test(path)) return [{ id: 77 }, { id: 78 }];
      if (method === 'GET' && /projectsV2\?/.test(path)) return [{ title: 'howgozit-probe-v2', node_id: 'P_probe' }, { title: 'other', node_id: 'P_other' }];
      throw new GitHubError('not-found', 404);
    };
    return {
      get: async (path) => ({ status: 200, json: fake('GET', path) }),
      paged: async () => ({ items: [], partial: false }),
      send: async (method, path, body) => fake(method, path, body),
      graphql: async (query, vars) => {
        calls.push({ who, method: 'GRAPHQL', query, vars });
        const r = refuse(who, 'GRAPHQL', query, vars);
        if (r) throw new GitHubError('invalid', 200, `FORBIDDEN ${CLASSIC}`);
        if (failStep === 'c' && /createProjectV2\(/.test(query)) throw new GitHubError('invalid', 200, 'boom');
        if (/viewer/.test(query)) return { viewer: { id: 'U_1', login: 'me' } };
        if (/createProjectV2\(/.test(query)) return { createProjectV2: { projectV2: { id: 'P_new', number: 4 } } };
        if (/createProjectV2Field/.test(query)) return { createProjectV2Field: { projectV2Field: { id: 'F_1', name: 'Score' } } };
        if (/deleteIssue/.test(query)) {
          for (const [k, v] of issues) if (v.node_id === vars.issueId) v.deleted = true;
          return { deleteIssue: { clientMutationId: null } };
        }
        return {};
      },
    };
  };
  return { calls, httpUser: make('classic'), httpOrg: make('fine') };
}

async function run(w, overrides = {}) {
  const lines = [];
  const sleeps = [];
  const out = await runProbeV2({
    httpUser: w.httpUser, httpOrg: w.httpOrg, args: ARGS, orgOwner: 'acme', today: '2026-10-14',
    emit: (l) => lines.push(l), sleep: async (ms) => { sleeps.push(ms); w.calls.push({ sleep: ms }); },
    ...overrides,
  });
  return { lines, sleeps, ...out };
}

test('U missing token or arguments exits 2 and sends nothing', async () => {
  const w = world();
  const a = await run(w, { httpOrg: null });
  assert.equal(a.code, 2);
  const b = await run(w, { args: { ...ARGS, userRepo: undefined } });
  assert.equal(b.code, 2);
  const c = await run(w, { orgOwner: undefined });
  assert.equal(c.code, 2);
  assert.equal(w.calls.length, 0);
  assert.match(a.lines[0], /BOARD_GITHUB_TOKEN_1/);
});

test('U parseArgs reads the three repos and the step', () => {
  const p = parseArgs(['--org-repo', 'a/b', '--org-repo-2', 'a/c', '--user-repo', 'u/r', '--step', 'd']);
  assert.deepEqual(p, { step: 'd', orgRepo: 'a/b', orgRepo2: 'a/c', userRepo: 'u/r' });
});

test('U step a posts issue_id as the numeric id, not the number', async () => {
  const w = world();
  await run(w, { args: { ...ARGS, step: 'a' } });
  const post = w.calls.find((c) => c.method === 'POST' && /blocked_by$/.test(c.path));
  assert.ok(post);
  assert.equal(post.path, '/repos/acme/one/issues/101/dependencies/blocked_by');
  assert.deepEqual(post.body, { issue_id: 9102 });
  assert.notEqual(post.body.issue_id, 102);
  assert.equal(post.who, 'fine');
});

test('U a refused fine-grained POST falls back to classic and the output says so', async () => {
  const w = world({ refuse: (who, m, p) => (who === 'fine' && m === 'POST' && /blocked_by$/.test(p) ? { status: 403 } : null) });
  const r = await run(w, { args: { ...ARGS, step: 'a' } });
  const line = r.lines.find((l) => l.startsWith('STEP a cross-repo-blocked_by'));
  assert.match(line, /YES/);
  assert.match(line, /worked_with=classic/);
  assert.match(line, /fine-grained=refused HTTP 403/);
  assert.ok(w.calls.some((c) => c.who === 'classic' && /blocked_by$/.test(c.path || '')));
  assert.ok(r.lines.some((l) => /issue_dependencies_summary keys=\[blocked_by,blocking,total_blocked_by,total_blocking\]/.test(l)));
});

test('U no output line contains a token, a canned title or body, across every step', async () => {
  const w = world({ refuse: (who, m, p) => (who === 'fine' && m === 'POST' && /blocked_by$/.test(p) ? { status: 403 } : null) });
  const r = await run(w);
  assert.ok(r.lines.length > 10);
  const all = r.lines.join('\n');
  assert.ok(!all.includes(CLASSIC));
  assert.ok(!all.includes(FINE));
  assert.ok(!/ghp_|github_pat_/.test(all));
  assert.ok(!all.includes(SECRET_TEXT));
  assert.ok(r.lines.every((l) => l.length < 1200));
});

test('U step c writes 7 and prints the exact shape of the Score value', async () => {
  const w = world();
  const r = await run(w, { args: { ...ARGS, step: 'all' } });
  const patch = w.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { fields: [{ id: 55, value: 7 }] });
  const line = r.lines.find((l) => l.startsWith('STEP c readback'));
  assert.match(line, /value_type=number value=7 value_is_7=yes/);
  assert.match(line, /Score value keys=\[data_type,id,name,value\]/);
});

test('U step c falls back to GraphQL when REST refuses the number write', async () => {
  const w = world({ refuse: (who, m) => (m === 'PATCH' ? { status: 422 } : null) });
  const r = await run(w);
  const line = r.lines.find((l) => l.startsWith('STEP c write-number'));
  assert.match(line, /worked_with=graphql/);
  assert.match(line, /rest=refused HTTP 422/);
});

test('U a failing step does not stop later steps and dependants are skipped', async () => {
  const w = world({ failStep: 'c' });
  const r = await run(w);
  assert.ok(r.lines.some((l) => l.startsWith('STEP c create-project: FAILED')));
  assert.ok(r.lines.some((l) => l.startsWith('STEP d milestone-deleted-under-issue: ANSWERED')));
  assert.ok(r.lines.some((l) => /^STEP e items-q-filter: SKIPPED \(needs the probe Project/.test(l)));
  assert.ok(r.lines.some((l) => l.startsWith('STEP f deleteIssue-org-repo')));
  assert.ok(r.lines.some((l) => /^STEP cleanup .*SKIPPED|NOTHING TO DELETE|DELETED/.test(l)));
});

test('U a step that throws is reported and the run continues', async () => {
  const w = world();
  const orig = w.httpUser.get;
  w.httpUser.get = async (p) => { if (/milestones|issues\/10\d$/.test(p)) throw new TypeError('kaboom'); return orig(p); };
  const r = await run(w);
  assert.ok(r.lines.some((l) => l.startsWith('STEP d')));
  assert.ok(r.lines.some((l) => l.startsWith('STEP f')));
  assert.equal(r.code, 0);
});

test('U step b and the reverse both record statuses; step a missing B skips b', async () => {
  const w = world();
  const r = await run(w, { args: { ...ARGS, step: 'b' } });
  assert.deepEqual(r.lines.filter((l) => l.startsWith('STEP b')), ['STEP b cross-owner-blocked_by: SKIPPED (needs B (step a))']);
  const w2 = world();
  const r2 = await run(w2);
  assert.ok(r2.lines.some((l) => /^STEP b user-issue-blocked-by-org-issue: YES/.test(l)));
  assert.ok(r2.lines.some((l) => /^STEP b org-issue-blocked-by-user-issue: YES/.test(l)));
});

test('U step f falls back to classic for the org issue and reads back 404', async () => {
  const w = world({ refuse: (who, m, q) => (who === 'fine' && m === 'GRAPHQL' && /deleteIssue/.test(q) ? { status: 200 } : null) });
  const r = await run(w);
  const user = r.lines.find((l) => l.startsWith('STEP f deleteIssue-user-repo'));
  const org = r.lines.find((l) => l.startsWith('STEP f deleteIssue-org-repo'));
  assert.match(user, /YES.*readback_status=404/);
  assert.match(org, /worked_with=classic.*fine-grained=refused/);
  assert.match(org, /readback_status=404/);
});

test('U cleanup deletes only the probe project', async () => {
  const w = world();
  await run(w);
  const dels = w.calls.filter((c) => c.method === 'GRAPHQL' && /deleteProjectV2/.test(c.query));
  assert.equal(dels.length, 1);
  assert.deepEqual(dels[0].vars, { projectId: 'P_new' });
  assert.ok(!w.calls.some((c) => /deleteRepository|DELETE \/repos/.test(c.query || '')));
});

test('U a lone cleanup finds the probe project by exact title and leaves others', async () => {
  const w = world();
  await run(w, { args: { ...ARGS, step: 'cleanup' } });
  const dels = w.calls.filter((c) => c.method === 'GRAPHQL' && /deleteProjectV2/.test(c.query));
  assert.deepEqual(dels.map((d) => d.vars.projectId), ['P_probe']);
});

test('U writes are spaced through the injected sleep', async () => {
  const w = world();
  const r = await run(w);
  const writes = w.calls.filter((c) => c.method && c.method !== 'GET' && !/viewer/.test(c.query || ''));
  assert.ok(writes.length > 10);
  assert.equal(r.sleeps.length, writes.length - 1);
  assert.ok(r.sleeps.every((ms) => ms === 1000));
  // every write after the first is directly preceded by a sleep
  const seq = w.calls.filter((c) => c.sleep !== undefined || (c.method && c.method !== 'GET' && !/viewer/.test(c.query || '')));
  seq.forEach((c, i) => { if (i > 0 && c.sleep === undefined) assert.equal(seq[i - 1].sleep, 1000); });
});

test('U every object is created through the classic client and step 0 states the fine-grained reach', async () => {
  const w = world({ refuse: (who, m, p) => (who === 'fine' && /^\/repos\/acme\/one$/.test(p) ? { status: 404, kind: 'not-found' } : null) });
  const r = await run(w);
  const creates = w.calls.filter((c) => c.method === 'POST' && /\/(issues|milestones)$/.test(c.path));
  assert.ok(creates.length >= 8);
  assert.ok(creates.every((c) => c.who === 'classic'));
  assert.equal(r.lines[0], 'STEP 0 token-reach: fine-grained GET /repos/acme/one → 404');
});

test('U step c creates its own issue when step b did not run', async () => {
  const w = world();
  const r = await run(w, { args: { ...ARGS, step: 'c' } });
  assert.ok(r.lines.some((l) => l.startsWith('STEP c write-number: YES')));
  assert.ok(!r.lines.some((l) => /SKIPPED/.test(l)));
});

test('U a list read that lags is polled every 10 s through the injected sleep until the item appears', async () => {
  const w = world();
  let reads = 0;
  const orig = w.httpUser.get;
  w.httpUser.get = async (p) => {
    if (/\/items\?fields=/.test(p)) { reads += 1; return { status: 200, json: reads <= 2 ? [] : [{ id: 77, fields: [{ id: 55, name: 'Score', value: 7 }] }] }; }
    return orig(p);
  };
  const r = await run(w, { args: { ...ARGS, step: 'c' } });
  const line = r.lines.find((l) => l.startsWith('STEP c readback'));
  assert.match(line, /FOUND — after=20s item_listed=yes/);
  assert.match(line, /value=7/);
  assert.equal(r.sleeps.filter((ms) => ms === 10000).length, 2);
  assert.equal(reads, 3);
});

test('U polling gives up after 15 tries and says so', async () => {
  const w = world();
  const orig = w.httpUser.get;
  w.httpUser.get = async (p) => (/\/items\?fields=/.test(p) ? { status: 200, json: [] } : orig(p));
  const r = await run(w, { args: { ...ARGS, step: 'c' } });
  assert.match(r.lines.find((l) => l.startsWith('STEP c readback')), /NOT FOUND — after=140s item_listed=no/);
});
