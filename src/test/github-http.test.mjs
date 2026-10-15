import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, GitHubError, API_BASE } from '../board/github/http.mjs';

const SENTINEL = 'SENTINEL-TOKEN-123';

function reply(status, { json, text, headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (h[n.toLowerCase()] ?? null) },
    json: async () => { if (json === undefined && text !== undefined) throw new SyntaxError('bad json'); return json; },
    text: async () => (text !== undefined ? text : json === undefined ? '' : JSON.stringify(json)),
  };
}

function fake(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = await handler(url, init, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

function mapStore() {
  const m = new Map();
  return { get: (u) => m.get(u), set: (u, etag, body) => m.set(u, { etag, body }), m };
}

function make(handler, etags = mapStore()) {
  const f = fake(handler);
  return { http: createHttp({ token: SENTINEL, fetch: f.fetch, etags }), calls: f.calls, etags };
}

async function fails(p) {
  try { await p; } catch (e) { return e; }
  assert.fail('expected a rejection');
}

test('R64 a second request to the same address carries If-None-Match', async () => {
  const { http, calls } = make(() => reply(200, { json: [1], headers: { etag: 'W/"a"' } }));
  await http.get('/repos/x/y/issues');
  await http.get('/repos/x/y/issues');
  assert.equal(calls[0].init.headers['If-None-Match'], undefined);
  assert.equal(calls[1].init.headers['If-None-Match'], 'W/"a"');
  assert.equal(calls[1].url, API_BASE + '/repos/x/y/issues');
});

test('R64 a 304 hands back the stored body', async () => {
  const { http } = make((url, init) => (init.headers['If-None-Match']
    ? reply(304)
    : reply(200, { json: { a: 1 }, headers: { etag: '"e1"' } })));
  const first = await http.get('/thing');
  const second = await http.get('/thing');
  assert.equal(first.notModified, false);
  assert.equal(second.notModified, true);
  assert.deepEqual(second.json, { a: 1 });
  assert.equal(second.status, 200);
});

test('R64 a different address does not borrow another address ETag', async () => {
  const { http, calls } = make(() => reply(200, { json: [], headers: { etag: '"z"' } }));
  await http.get('/one');
  await http.get('/two');
  assert.equal(calls[1].init.headers['If-None-Match'], undefined);
});

test('R68 a Link next on another origin is never requested', async () => {
  const { http, calls } = make(() => reply(200, {
    json: [1], headers: { link: '<https://evil.example/x?page=2>; rel="next"' },
  }));
  const out = await http.paged('/list', { maxPages: 5 });
  assert.equal(calls.length, 1);
  assert.deepEqual(out, { items: [1], partial: false });
  assert.ok(calls.every((c) => c.url.startsWith(API_BASE)));
});

test('R68 a lookalike origin is never requested', async () => {
  const { http, calls } = make(() => reply(200, {
    json: [], headers: { link: '<https://api.github.com.evil.example/x>; rel="next"' },
  }));
  await http.paged('/list', { maxPages: 5 });
  assert.equal(calls.length, 1);
});

test('R68 an endless next stops after exactly maxPages requests with partial true', async () => {
  const { http, calls } = make((url, init, n) => reply(200, {
    json: [n], headers: { link: `<${API_BASE}/list?page=${n + 1}>; rel="next"` },
  }));
  const out = await http.paged('/list', { maxPages: 7 });
  assert.equal(calls.length, 7);
  assert.equal(out.partial, true);
  assert.equal(out.items.length, 7);
});

test('R68 a normal three-page list is joined in order with partial false', async () => {
  const { http, calls } = make((url) => {
    if (url.endsWith('page=3')) return reply(200, { json: [5, 6] });
    if (url.endsWith('page=2')) {
      return reply(200, { json: [3, 4], headers: { link: `<${API_BASE}/list?page=3>; rel="next", <${API_BASE}/list?page=3>; rel="last"` } });
    }
    return reply(200, { json: [1, 2], headers: { link: `<${API_BASE}/list?page=2>; rel="last", <${API_BASE}/list?page=2>; rel="next"` } });
  });
  const out = await http.paged('/list', { maxPages: 100 });
  assert.deepEqual(out.items, [1, 2, 3, 4, 5, 6]);
  assert.equal(out.partial, false);
  assert.equal(calls.length, 3);
});

test('R68 a list that ends exactly at maxPages is not partial', async () => {
  const { http } = make((url) => (url.includes('page=2')
    ? reply(200, { json: [2] })
    : reply(200, { json: [1], headers: { link: `<${API_BASE}/l?page=2>; rel="next"` } })));
  const out = await http.paged('/l', { maxPages: 2 });
  assert.deepEqual(out, { items: [1, 2], partial: false });
});

test('U every request carries the four headers', async () => {
  const { http, calls } = make(() => reply(200, { json: { data: {} } }));
  await http.get('/a');
  await http.send('POST', '/b', { x: 1 });
  await http.graphql('query { x }', {});
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.init.headers.Accept, 'application/vnd.github+json');
    assert.equal(c.init.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(c.init.headers.Authorization, `Bearer ${SENTINEL}`);
    assert.equal(c.init.headers['User-Agent'], 'board');
    assert.ok(c.init.signal instanceof AbortSignal);
  }
});

test('U get accepts a full api address and returns the link header', async () => {
  const { http, calls } = make(() => reply(200, { json: [], headers: { link: '<x>; rel="last"' } }));
  const out = await http.get(`${API_BASE}/full?page=2`);
  assert.equal(calls[0].url, `${API_BASE}/full?page=2`);
  assert.equal(out.link, '<x>; rel="last"');
  assert.equal(out.notModified, false);
});

test('U send posts JSON and returns the parsed answer', async () => {
  const { http, calls } = make(() => reply(201, { json: { id: 9 } }));
  const out = await http.send('PATCH', '/issues/1', { state: 'closed' });
  assert.deepEqual(out, { id: 9 });
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, JSON.stringify({ state: 'closed' }));
  assert.equal(calls[0].url, API_BASE + '/issues/1');
});

test('U send returns null for an empty 204', async () => {
  const { http } = make(() => reply(204));
  assert.equal(await http.send('DELETE', '/x', {}), null);
});

test('U graphql posts to /graphql and returns data', async () => {
  const { http, calls } = make(() => reply(200, { json: { data: { viewer: 1 } } }));
  const out = await http.graphql('query { viewer }', { a: 1 });
  assert.deepEqual(out, { viewer: 1 });
  assert.equal(calls[0].url, API_BASE + '/graphql');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'query { viewer }', variables: { a: 1 } });
});

test('U graphql errors throw invalid with the first message', async () => {
  const { http } = make(() => reply(200, { json: { errors: [{ message: 'Bad field' }, { message: 'other' }] } }));
  const e = await fails(http.graphql('q', {}));
  assert.ok(e instanceof GitHubError);
  assert.equal(e.kind, 'invalid');
  assert.equal(e.message, 'Bad field');
});

test('U error kinds follow the status mapping', async () => {
  const cases = [
    [401, {}, 'auth'],
    [403, {}, 'auth'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limit'],
    [403, { 'retry-after': '30' }, 'rate-limit'],
    [429, { 'retry-after': '5' }, 'rate-limit'],
    [429, { 'x-ratelimit-remaining': '0' }, 'rate-limit'],
    [404, {}, 'not-found'],
    [422, {}, 'invalid'],
    [400, {}, 'invalid'],
    [500, {}, 'server'],
    [503, {}, 'server'],
  ];
  for (const [status, headers, kind] of cases) {
    const { http } = make(() => reply(status, { json: {}, headers }));
    const e = await fails(http.get('/x'));
    assert.ok(e instanceof GitHubError, String(status));
    assert.equal(e.kind, kind, `${status} ${JSON.stringify(headers)}`);
    assert.equal(e.status, status);
    assert.ok(e.message.length > 0);
  }
});

test('U send maps errors the same way', async () => {
  const { http } = make(() => reply(422, { json: {} }));
  const e = await fails(http.send('POST', '/x', {}));
  assert.equal(e.kind, 'invalid');
});

test('U a rejecting fetch becomes a network error with status 0', async () => {
  const { http } = make(() => new Error('timed out'));
  const e = await fails(http.get('/x'));
  assert.equal(e.kind, 'network');
  assert.equal(e.status, 0);
  const abort = make(() => Object.assign(new Error('x'), { name: 'TimeoutError' }));
  assert.equal((await fails(abort.http.get('/x'))).kind, 'network');
});

test('U a 304 with nothing stored is a server error', async () => {
  const { http } = make(() => reply(304));
  const e = await fails(http.get('/x'));
  assert.equal(e.kind, 'server');
  assert.equal(e.status, 304);
});

test('U pages may be an object with an items array; other shapes count as empty', async () => {
  const objects = make(() => reply(200, { json: { total_count: 2, items: [1, 2] } }));
  assert.deepEqual((await objects.http.paged('/s', { maxPages: 3 })).items, [1, 2]);
  for (const json of [{ foo: 1 }, null, 'str', 5, { items: 'no' }]) {
    const { http } = make(() => reply(200, { json }));
    assert.deepEqual(await http.paged('/s', { maxPages: 3 }), { items: [], partial: false });
  }
});

test('U the token never appears in an error or its fields', async () => {
  const handlers = [
    () => reply(401, { json: { message: `bad ${SENTINEL}` } }),
    () => reply(403, { json: {}, headers: { 'retry-after': '1' } }),
    () => reply(404, { json: {} }),
    () => reply(500, { json: {} }),
    () => new Error(`socket closed for Bearer ${SENTINEL}`),
    () => reply(304),
    () => reply(200, { text: '{', json: undefined }),
  ];
  for (const h of handlers) {
    const { http } = make(h);
    const e = await fails(http.get('/x'));
    const dump = JSON.stringify(e, Object.getOwnPropertyNames(e)) + String(e) + String(e.stack);
    assert.ok(!dump.includes(SENTINEL));
  }
});

test('U works without an etag store', async () => {
  const f = fake(() => reply(200, { json: [1], headers: { etag: '"q"' } }));
  const http = createHttp({ token: SENTINEL, fetch: f.fetch });
  const out = await http.get('/x');
  assert.deepEqual(out.json, [1]);
});
