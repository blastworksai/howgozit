import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttp } from '../board/github/http.mjs';

const SENTINEL = 'SENTINEL-TOKEN-123';
const API = 'https://api.github.com';

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

function make(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  const etags = (() => { const m = new Map(); return { get: (u) => m.get(u), set: (u, etag, body) => m.set(u, { etag, body }) }; })();
  return { http: createHttp({ token: SENTINEL, fetch, etags }), calls };
}

async function fails(p) {
  try { await p; } catch (e) { return e; }
  assert.fail('expected a rejection');
}

function assertFailure(err, kind, status) {
  assert.equal(err.name, 'GitHubError');
  assert.equal(err.kind, kind);
  if (status !== undefined) assert.equal(err.status, status);
  assert.ok(!String(err.message).includes(SENTINEL), 'token leaked into the message');
}

const redirect = (status, location) => reply(status, { headers: { location } });

test('R68 every request is sent with redirects switched off', async () => {
  const { http, calls } = make((url) => (url.endsWith('/graphql') ? reply(200, { json: { data: {} } }) : reply(200, { json: [] })));
  await http.get('/a');
  await http.paged('/b', { maxPages: 1 });
  await http.send('POST', '/c', {});
  await http.graphql('query { x }', {});
  assert.equal(calls.length, 4);
  for (const c of calls) assert.equal(c.init.redirect, 'manual');
});

test('R68 a read redirected to another host is not followed and fails', async () => {
  const { http, calls } = make(() => redirect(302, 'https://evil.example/x'));
  const err = await fails(http.get('/repos/o/r'));
  assertFailure(err, 'server', 302);
  assert.ok(calls.every((c) => !c.url.includes('evil.example')));
});

test('R68 a read redirected to an absolute same-origin address is followed by the client', async () => {
  const { http, calls } = make((url) => (url === `${API}/repos/o/r`
    ? redirect(301, `${API}/repositories/123`)
    : reply(200, { json: { id: 123 } })));
  const out = await http.get('/repos/o/r');
  assert.deepEqual(out.json, { id: 123 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${API}/repositories/123`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${SENTINEL}`);
  assert.equal(calls[1].init.redirect, 'manual');
});

test('R68 a read redirected to a relative address is resolved against the address just asked', async () => {
  const { http, calls } = make((url) => (url === `${API}/repos/o/r`
    ? redirect(301, '/repositories/123')
    : reply(200, { json: { id: 123 } })));
  const out = await http.get('/repos/o/r');
  assert.deepEqual(out.json, { id: 123 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${API}/repositories/123`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${SENTINEL}`);
});

test('R68 four same-origin redirects in a row fail the read after exactly four requests', async () => {
  const { http, calls } = make((url, init, n) => redirect(301, `${API}/hop/${n}`));
  const err = await fails(http.get('/start'));
  assertFailure(err, 'server');
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.url.startsWith(API)));
});

test('R68 three same-origin redirects then an answer still succeed', async () => {
  const { http, calls } = make((url, init, n) => (n <= 3 ? redirect(302, `${API}/hop/${n}`) : reply(200, { json: { ok: true } })));
  const out = await http.get('/start');
  assert.deepEqual(out.json, { ok: true });
  assert.equal(calls.length, 4);
});

test('R68 a write answered with a redirect fails and is not repeated', async () => {
  const { http, calls } = make(() => redirect(307, `${API}/elsewhere`));
  const err = await fails(http.send('POST', '/repos/o/r/issues', { title: 't' }));
  assertFailure(err, 'server', 307);
  assert.equal(calls.length, 1);
});

test('R68 an address on another host handed to the client sends no request', async () => {
  const cases = [
    (h) => h.get('https://evil.example/a'),
    (h) => h.send('POST', 'https://evil.example/a', {}),
    (h) => h.paged('https://evil.example/a', { maxPages: 2 }),
  ];
  for (const run of cases) {
    const { http, calls } = make(() => reply(200, { json: [] }));
    const err = await fails(run(http));
    assertFailure(err, 'invalid');
    assert.equal(calls.length, 0);
  }
});

test('R68 a wrong scheme or a look-alike host sends no request', async () => {
  for (const addr of ['http://api.github.com/x', 'https://api.github.com.evil.example/x']) {
    const { http, calls } = make(() => reply(200, { json: {} }));
    const err = await fails(http.get(addr));
    assertFailure(err, 'invalid');
    assert.equal(calls.length, 0);
  }
});

test('R68 a normal read still makes one request to the API address', async () => {
  const { http, calls } = make(() => reply(200, { json: { name: 'r' } }));
  const out = await http.get('/repos/o/r');
  assert.deepEqual(out.json, { name: 'r' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}/repos/o/r`);
});

test('R68 a next link on the API origin is still followed', async () => {
  const { http, calls } = make((url) => (url === `${API}/items`
    ? reply(200, { json: [1], headers: { link: `<${API}/items?page=2>; rel="next"` } })
    : reply(200, { json: [2] })));
  const out = await http.paged('/items', { maxPages: 5 });
  assert.deepEqual(out.items, [1, 2]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${API}/items?page=2`);
});

test('R68 the token appears in no error message', async () => {
  const runs = [
    [() => redirect(302, 'https://evil.example/x'), (h) => h.get('/a')],
    [() => redirect(301, `${API}/n`), (h) => h.get('/a')],
    [() => redirect(307, `${API}/n`), (h) => h.send('POST', '/a', {})],
    [() => reply(200, { json: {} }), (h) => h.get('https://evil.example/a')],
  ];
  for (const [handler, run] of runs) {
    const { http } = make(handler);
    const err = await fails(run(http));
    assert.ok(!String(err.message).includes(SENTINEL));
  }
});

const gql = (body) => make(() => reply(200, { json: body }));

test('U a graphql NOT_FOUND error maps to not-found', async () => {
  const { http } = gql({
    data: { deleteProjectV2: null },
    errors: [{ type: 'NOT_FOUND', path: ['deleteProjectV2'], message: "Could not resolve to a node with the global id of 'PVT_x'." }],
  });
  const err = await fails(http.graphql('mutation { x }', {}));
  assert.equal(err.name, 'GitHubError');
  assert.equal(err.kind, 'not-found');
});

test('U other graphql errors stay invalid and a clean answer returns data', async () => {
  for (const errors of [[{ type: 'FORBIDDEN', message: 'no' }], [{ message: 'plain' }]]) {
    const { http } = gql({ data: null, errors });
    const err = await fails(http.graphql('query { x }', {}));
    assert.equal(err.name, 'GitHubError');
    assert.equal(err.kind, 'invalid');
  }
  const { http } = gql({ data: { viewer: { id: 1 } } });
  assert.deepEqual(await http.graphql('query { x }', {}), { viewer: { id: 1 } });
});
