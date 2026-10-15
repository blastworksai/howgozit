// R147: Notion's rate limit is waited out, not fought. Written from the rule text (references/contract.md) and
// reference/mapping-redesign/cp9-interface.md section 0 (decision 5) and section 5, never from board/notion/http.mjs.
// The stand-in Notion (fixtures/fake-notion.mjs) answers 429 on request and counts the requests open at one moment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { BackendError } from '../board/model/adapter.mjs';

const TOKEN = 'ntn_SENTINEL_token_4711';
const DS = '0123456789abcdef0123456789abcdef';
const PATH = '/v1/data_sources/' + DS;

function world() {
  const fake = createFakeNotion({ token: TOKEN, dataSources: { [DS]: { properties: { Name: { type: 'title' } } } } });
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const http = createNotionHttp({ token: TOKEN, fetch: fake.fetch, sleep });
  return { fake, sleeps, http };
}

async function fails(p) {
  try { await p; } catch (e) { return e; }
  assert.fail('expected a rejection');
}

test('R147 one 429 with Retry-After 2 is waited out once, for 2 seconds, then the read is good', async () => {
  const { fake, sleeps, http } = world();
  fake.limit({ times: 1, retryAfter: 2 });
  const out = await http.request('GET', PATH);
  assert.equal(out.object, 'data_source');
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fake.calls.length, 2, 'the refused request and its resend');
  assert.deepEqual(fake.calls[1], fake.calls[0], 'the resend is the same request');
});

test('R147 four 429s in a row make three retries and a failed read', async () => {
  const { fake, sleeps, http } = world();
  fake.limit({ times: 4, retryAfter: 1 });
  const err = await fails(http.request('GET', PATH));
  assert.ok(err instanceof BackendError, 'the failure is a BackendError');
  assert.equal(err.code, 'rate-limited');
  assert.deepEqual(sleeps, [1000, 1000, 1000], 'three waits, no fourth');
  assert.equal(fake.calls.length, 4, 'one request and three retries');
});

test('R147 three 429s and then a good answer is a good read', async () => {
  const { fake, sleeps, http } = world();
  fake.limit({ times: 3, retryAfter: 1 });
  const out = await http.request('GET', PATH);
  assert.equal(out.object, 'data_source');
  assert.equal(sleeps.length, 3);
  assert.equal(fake.calls.length, 4);
});

test('R147 a Retry-After of 10 seconds is waited for', async () => {
  const { fake, sleeps, http } = world();
  fake.limit({ times: 1, retryAfter: 10 });
  const out = await http.request('GET', PATH);
  assert.equal(out.object, 'data_source');
  assert.deepEqual(sleeps, [10000]);
});

test('R147 a Retry-After of more than 10 seconds is not waited for: the read fails with no wait', async () => {
  const { fake, sleeps, http } = world();
  fake.limit({ times: 1, retryAfter: 11 });
  const err = await fails(http.request('GET', PATH));
  assert.equal(err.code, 'rate-limited');
  assert.deepEqual(sleeps, []);
  assert.equal(fake.calls.length, 1, 'no retry');
});

test('R147 a 429 with no usable Retry-After is not retried', async () => {
  const sleeps = [];
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 429 });
  };
  const http = createNotionHttp({ token: TOKEN, fetch, sleep: async (ms) => { sleeps.push(ms); } });
  const err = await fails(http.request('GET', PATH));
  assert.equal(err.code, 'rate-limited');
  assert.deepEqual(sleeps, []);
  assert.equal(calls, 1);
});

test('R147 requests go one at a time: never more than one in flight, however many are asked together', async () => {
  const { fake, http } = world();
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => http.request('GET', PATH)));
  assert.equal(all.length, 5);
  assert.equal(fake.calls.length, 5);
  assert.equal(fake.maxInFlight, 1);
});

test('R147 the measure is real: the stand-in sees two requests open when they are not queued', async () => {
  const fake = createFakeNotion({ token: TOKEN, dataSources: { [DS]: { properties: { Name: { type: 'title' } } } } });
  const init = { method: 'GET', headers: { Authorization: 'Bearer ' + TOKEN, 'Notion-Version': '2026-03-11' } };
  await Promise.all([fake.fetch('https://api.notion.com' + PATH, init), fake.fetch('https://api.notion.com' + PATH, init)]);
  assert.ok(fake.maxInFlight >= 2, 'a control that would catch a queue that does not queue');
});

test('R147 a second request waits behind the first one, retries included', async () => {
  const { fake, http } = world();
  fake.limit({ times: 1, retryAfter: 1 });
  const other = '/v1/data_sources/' + DS + '?second=1';
  const [a, b] = await Promise.all([http.request('GET', PATH), http.request('GET', other)]);
  assert.equal(a.object, 'data_source');
  assert.equal(b.object, 'data_source');
  assert.deepEqual(fake.calls.map((c) => c.path), [PATH, PATH, other], 'the first request and its retry both run before the second starts');
  assert.equal(fake.maxInFlight, 1);
});

test('R147 a request that failed does not stop the queue behind it', async () => {
  const { fake, http } = world();
  fake.limit({ times: 4, retryAfter: 1 });
  const first = http.request('GET', PATH);
  const second = http.request('GET', PATH);
  const err = await fails(first);
  assert.equal(err.code, 'rate-limited');
  const out = await second;
  assert.equal(out.object, 'data_source');
});

test('R147 no failure carries the token, a request body or a response body', async () => {
  const { fake } = world();
  const wrong = createNotionHttp({ token: 'ntn_WRONG_value_999', fetch: fake.fetch, sleep: async () => {} });
  const auth = await fails(wrong.request('GET', PATH));
  assert.equal(auth.code, 'auth');
  assert.equal(auth.message, 'Notion did not accept the token.');
  const missing = await fails(world().http.request('GET', '/v1/data_sources/ffffffffffffffffffffffffffffffff'));
  assert.equal(missing.code, 'not-found');
  const body = { parent: { data_source_id: DS }, properties: { Name: 'SECRET-BODY-TEXT' }, bogus: true };
  const bad = await fails(world().http.request('POST', '/v1/pages', { ...body, parent: { data_source_id: 'ffffffffffffffffffffffffffffffff' } }));
  for (const e of [auth, missing, bad]) {
    assert.ok(e instanceof BackendError);
    const shown = [e.message, String(e), JSON.stringify({ ...e, message: e.message })].join('\n');
    assert.ok(!shown.includes('ntn_'), 'no token');
    assert.ok(!shown.includes('SECRET-BODY-TEXT'), 'no request body');
    assert.ok(!shown.includes('Invented') && !shown.includes('Could not find'), 'no response text');
  }
});

test('R147 only paths under /v1/ ever leave: anything else is refused before a request', async () => {
  let called = 0;
  const http = createNotionHttp({ token: TOKEN, fetch: async () => { called += 1; return new Response('{}'); }, sleep: async () => {} });
  for (const p of ['https://evil.example/v1/x', '/other', '//evil.example/v1/x', '/v1/../etc']) {
    const err = await fails(http.request('GET', p));
    assert.ok(err instanceof BackendError);
    assert.equal(err.code, 'invalid');
  }
  assert.equal(called, 0);
});
