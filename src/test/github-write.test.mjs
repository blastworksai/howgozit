import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssue, patchIssue, addProjectItem } from '../board/github/write.mjs';

function recorder(answer = { ok: 1 }) {
  const calls = [];
  return {
    calls,
    send: async (method, path, body) => {
      calls.push([method, path, body]);
      return answer;
    },
  };
}

const REPO = 'acme/things';
const PROJECT = { owner: 'acme', ownerType: 'organization', projectNumber: 3, repo: REPO, issueNumber: 12 };

async function refuses(fn) {
  const http = recorder();
  await assert.rejects(() => fn(http), (err) => err instanceof Error);
  assert.equal(http.calls.length, 0);
}

test('U createIssue posts title and labels to the issues path', async () => {
  const http = recorder();
  await createIssue(http, REPO, { title: 'Hello', labels: ['a', 'b'] });
  assert.deepEqual(http.calls, [['POST', '/repos/acme/things/issues', { title: 'Hello', labels: ['a', 'b'] }]]);
});

test('U createIssue defaults labels to an empty array', async () => {
  const http = recorder();
  await createIssue(http, REPO, { title: 'Hello' });
  assert.deepEqual(http.calls[0][2], { title: 'Hello', labels: [] });
});

test('U createIssue returns the JSON untouched', async () => {
  const answer = { number: 5, extra: { deep: [1] } };
  const out = await createIssue(recorder(answer), REPO, { title: 'x' });
  assert.equal(out, answer);
});

test('U createIssue refuses bad input and sends nothing', async () => {
  for (const repo of ['', 'nope', 'a/b/c', 'a/', '/b', null, 5]) {
    await refuses((http) => createIssue(http, repo, { title: 'x' }));
  }
  for (const title of ['', '   ', null, undefined, 4]) {
    await refuses((http) => createIssue(http, REPO, { title }));
  }
  for (const labels of ['a', [1], [null], {}, null]) {
    await refuses((http) => createIssue(http, REPO, { title: 'x', labels }));
  }
  await refuses((http) => createIssue(http, REPO));
});

test('U patchIssue sends the patch as given to the numbered path', async () => {
  const http = recorder();
  const patch = { state: 'closed', state_reason: 'completed', labels: ['x'] };
  await patchIssue(http, REPO, 7, patch);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0][0], 'PATCH');
  assert.equal(http.calls[0][1], '/repos/acme/things/issues/7');
  assert.equal(http.calls[0][2], patch);
});

test('U patchIssue returns the JSON untouched', async () => {
  const answer = { number: 7, state: 'closed' };
  assert.equal(await patchIssue(recorder(answer), REPO, 7, { state: 'closed' }), answer);
});

test('U patchIssue refuses bad input and sends nothing', async () => {
  for (const repo of ['', 'nope', 'a/b/c', null]) {
    await refuses((http) => patchIssue(http, repo, 1, {}));
  }
  for (const number of [0, -1, 1.5, '3', NaN, null, undefined, Infinity]) {
    await refuses((http) => patchIssue(http, REPO, number, {}));
  }
  for (const patch of [null, undefined, 'x', [], 4]) {
    await refuses((http) => patchIssue(http, REPO, 1, patch));
  }
});

test('U addProjectItem posts to the orgs path with the repo parts', async () => {
  const http = recorder();
  await addProjectItem(http, PROJECT);
  assert.deepEqual(http.calls, [[
    'POST',
    '/orgs/acme/projectsV2/3/items',
    { type: 'Issue', owner: 'acme', repo: 'things', number: 12 },
  ]]);
});

test('U addProjectItem posts to the users path for a user project', async () => {
  const http = recorder();
  await addProjectItem(http, { ...PROJECT, owner: 'sam', ownerType: 'user', repo: 'acme/things' });
  assert.equal(http.calls[0][1], '/users/sam/projectsV2/3/items');
  assert.deepEqual(http.calls[0][2], { type: 'Issue', owner: 'acme', repo: 'things', number: 12 });
});

test('U addProjectItem returns the JSON untouched', async () => {
  const answer = { id: 'x', nested: { a: 1 } };
  assert.equal(await addProjectItem(recorder(answer), PROJECT), answer);
});

test('U addProjectItem refuses bad input and sends nothing', async () => {
  for (const ownerType of ['org', 'users', '', null, undefined]) {
    await refuses((http) => addProjectItem(http, { ...PROJECT, ownerType }));
  }
  for (const projectNumber of [0, -2, 1.2, '3', null, undefined]) {
    await refuses((http) => addProjectItem(http, { ...PROJECT, projectNumber }));
  }
  for (const issueNumber of [0, -2, 1.2, '12', null, undefined]) {
    await refuses((http) => addProjectItem(http, { ...PROJECT, issueNumber }));
  }
  for (const repo of ['', 'nope', 'a/b/c', null]) {
    await refuses((http) => addProjectItem(http, { ...PROJECT, repo }));
  }
  for (const owner of ['', 'a/b', '..x/', null, undefined]) {
    await refuses((http) => addProjectItem(http, { ...PROJECT, owner }));
  }
  await refuses((http) => addProjectItem(http));
});

test('U an error thrown by http.send propagates unchanged', async () => {
  const boom = new Error('boom');
  const http = { send: async () => { throw boom; } };
  await assert.rejects(() => createIssue(http, REPO, { title: 'x' }), (err) => err === boom);
  await assert.rejects(() => patchIssue(http, REPO, 1, {}), (err) => err === boom);
  await assert.rejects(() => addProjectItem(http, PROJECT), (err) => err === boom);
});
