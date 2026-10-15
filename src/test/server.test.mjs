import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { settings } from '../fixtures/build.mjs';

const { start } = await import('../board/server.mjs');

const TOKEN = 'SENTINEL-TOKEN-123';
const CLOCK_MS = Date.parse('2026-10-12T06:10:00Z');

function fakeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// GitHub down: every address answers 503.
function makeDownFetch() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    return fakeResponse(503, { message: 'down' });
  };
  fn.calls = calls;
  return fn;
}

// A small invented GitHub that holds a valid settings file and no issues.
function makeWorldFetch() {
  const calls = [];
  const content = Buffer.from(JSON.stringify(settings())).toString('base64');
  const fn = async (url, init = {}) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url: String(url), method });
    const u = new URL(String(url));
    const p = u.pathname;
    if (p === '/repos/sam-life/life') {
      return fakeResponse(200, { private: true, owner: { login: 'sam-life', type: 'Organization' } });
    }
    if (p === '/repos/sam-life/life/contents/board.config.json') {
      return fakeResponse(200, { encoding: 'base64', content });
    }
    if (p.startsWith('/repos/sam-life/life/contents/')) return fakeResponse(404, { message: 'Not Found' });
    if (p === '/repos/sam-life/life/issues' || p === '/repos/sam-life/life/milestones') return fakeResponse(200, []);
    return fakeResponse(404, { message: 'Not Found' });
  };
  fn.calls = calls;
  return fn;
}

function sendRequest(port, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `localhost:${port}`, ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function withServer(opts, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-server-test-'));
  const fetch = opts.fetch || makeDownFetch();
  const log = [];
  const processEnv = {
    BOARD_GITHUB_TOKEN: TOKEN,
    BOARD_REPO: 'sam-life/life',
    BOARD_PORT: '0',
    BOARD_DATA_DIR: dir,
    ...(opts.env || {}),
  };
  let running = null;
  try {
    running = await start({ processEnv, fetch, clock: { now: () => CLOCK_MS }, log: (line) => log.push(line) });
    const port = running.address.port;
    return await fn({ port, running, fetch, log, dir });
  } finally {
    if (running) await running.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function startRejection(env) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-server-test-'));
  try {
    const processEnv = {
      BOARD_GITHUB_TOKEN: TOKEN,
      BOARD_REPO: 'sam-life/life',
      BOARD_PORT: '0',
      BOARD_DATA_DIR: dir,
      ...env,
    };
    let running = null;
    try {
      running = await start({ processEnv, fetch: makeDownFetch(), clock: { now: () => CLOCK_MS }, log: () => {} });
    } catch (err) {
      return err;
    } finally {
      if (running) await running.close();
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertPlainSentence(err) {
  assert.ok(err instanceof Error, 'start rejects with an Error');
  assert.ok(err.message.length > 0);
  assert.ok(!/\n/.test(err.message), 'one line');
  assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(err.message), 'no stack in the message');
  assert.ok(!err.message.includes(TOKEN));
}

function assertLockedHeaders(res, label) {
  assert.match(res.headers['content-security-policy'] || '', /default-src 'none'/, `${label} csp`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', `${label} nosniff`);
  assert.equal(res.headers['referrer-policy'], 'no-referrer', `${label} referrer`);
  assert.equal(res.headers['cache-control'], 'no-store', `${label} cache`);
}

const PROXY = { BOARD_MODE: 'proxy', BOARD_IDENTITY_HEADER: 'x-board-user', BOARD_HOST: '127.0.0.1' };

test('R81 the health check answers 200 ok with GitHub down, a foreign host and no identity header', async () => {
  await withServer({ env: PROXY }, async ({ port, fetch }) => {
    const res = await sendRequest(port, { reqPath: '/healthz', headers: { host: 'evil.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
    assert.equal(fetch.calls.length, 0);
  });
});

test('R81 the health check answers ok in local mode with the normal host', async () => {
  await withServer({}, async ({ port }) => {
    const res = await sendRequest(port, { reqPath: '/healthz' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
  });
});

test('R78 a foreign host gets three 421s with empty bodies and no GitHub request', async () => {
  await withServer({}, async ({ port, fetch }) => {
    const evil = { host: 'evil.example' };
    const a = await sendRequest(port, { reqPath: '/', headers: evil });
    const b = await sendRequest(port, { reqPath: '/static/board.css', headers: evil });
    const c = await sendRequest(port, { method: 'POST', reqPath: '/actions/idea', headers: { ...evil, ...FORM }, body: 'title=x&token=y' });
    for (const r of [a, b, c]) {
      assert.equal(r.status, 421);
      assert.equal(r.body, '');
    }
    assert.equal(fetch.calls.length, 0);
  });
});

test('R78 both loopback names with the bound port are accepted', async () => {
  await withServer({}, async ({ port }) => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const res = await sendRequest(port, { reqPath: '/static/board.css', headers: { host } });
      assert.equal(res.status, 200, host);
    }
  });
});

test('R78 the right name on the wrong port is refused', async () => {
  await withServer({}, async ({ port }) => {
    const res = await sendRequest(port, { reqPath: '/static/board.css', headers: { host: `localhost:${port + 1}` } });
    assert.equal(res.status, 421);
    assert.equal(res.body, '');
  });
});

test('R79 proxy mode with no identity header configured refuses to start with one plain sentence', async () => {
  const err = await startRejection({ BOARD_MODE: 'proxy', BOARD_HOST: '127.0.0.1' });
  assert.ok(err, 'start rejected');
  assertPlainSentence(err);
  assert.match(err.message, /BOARD_IDENTITY_HEADER/);
});

test('R79 hosted mode with no identity header configured refuses to start too', async () => {
  const err = await startRejection({ BOARD_MODE: 'hosted', BOARD_HOST: '127.0.0.1' });
  assert.ok(err, 'start rejected');
  assertPlainSentence(err);
  assert.match(err.message, /BOARD_IDENTITY_HEADER/);
});

test('R79 with the identity header configured a request without it gets 401 and one with it does not', async () => {
  await withServer({ env: PROXY }, async ({ port }) => {
    const without = await sendRequest(port, { reqPath: '/' });
    assert.equal(without.status, 401);
    assert.ok(!/<form/i.test(without.body));
    const withIt = await sendRequest(port, { reqPath: '/', headers: { 'x-board-user': 'sam' } });
    assert.notEqual(withIt.status, 401);
  });
});

test('R79 hosted mode behaves as proxy mode', async () => {
  await withServer({ env: { ...PROXY, BOARD_MODE: 'hosted' } }, async ({ port }) => {
    const without = await sendRequest(port, { reqPath: '/static/board.css' });
    assert.equal(without.status, 401);
    const withIt = await sendRequest(port, { reqPath: '/static/board.css', headers: { 'x-board-user': 'sam' } });
    assert.equal(withIt.status, 200);
    const health = await sendRequest(port, { reqPath: '/healthz' });
    assert.equal(health.status, 200);
  });
});

test('R79 an empty identity header value does not let a request in', async () => {
  await withServer({ env: PROXY }, async ({ port }) => {
    const res = await sendRequest(port, { reqPath: '/static/board.css', headers: { 'x-board-user': '' } });
    assert.equal(res.status, 401);
  });
});

test('R79 local mode listens on a loopback address and needs no identity header', async () => {
  await withServer({ env: { BOARD_MODE: 'local' } }, async ({ running, port }) => {
    assert.equal(running.address.address, '127.0.0.1');
    const res = await sendRequest(port, { reqPath: '/static/board.css' });
    assert.equal(res.status, 200);
  });
});

test('R79 there is no login route', async () => {
  await withServer({}, async ({ port }) => {
    for (const p of ['/login', '/auth/login', '/static/login']) {
      const res = await sendRequest(port, { reqPath: p });
      assert.equal(res.status, 404, p);
    }
  });
});

test('R80 the eight routes answer something other than 404 or 405', async () => {
  await withServer({}, async ({ port }) => {
    for (const p of ['/', '/static/board.css', '/static/board.js', '/healthz']) {
      const res = await sendRequest(port, { reqPath: p });
      assert.ok(res.status !== 404 && res.status !== 405, `GET ${p} gave ${res.status}`);
    }
    for (const p of ['/actions/idea', '/actions/habit', '/actions/sort', '/actions/close']) {
      const res = await sendRequest(port, { method: 'POST', reqPath: p, headers: FORM, body: 'token=x' });
      assert.ok(res.status !== 404 && res.status !== 405, `POST ${p} gave ${res.status}`);
    }
  });
});

test('R80 path tricks and unknown paths are 404 with no file content', async () => {
  await withServer({}, async ({ port }) => {
    for (const p of ['/static/../server.mjs', '/static/%2e%2e/x', '/admin']) {
      const res = await sendRequest(port, { reqPath: p });
      assert.equal(res.status, 404, p);
      assert.ok(!/\bimport /.test(res.body), `${p} body has import`);
      assert.ok(!/\bexport /.test(res.body), `${p} body has export`);
    }
  });
});

test('R80 a known path with another method answers 405', async () => {
  await withServer({}, async ({ port }) => {
    const put = await sendRequest(port, { method: 'PUT', reqPath: '/', headers: FORM, body: 'a=b' });
    assert.equal(put.status, 405);
    const get = await sendRequest(port, { reqPath: '/actions/idea' });
    assert.equal(get.status, 405);
    const post = await sendRequest(port, { method: 'POST', reqPath: '/', headers: FORM, body: 'a=b' });
    assert.equal(post.status, 405);
  });
});

test('R80 the stylesheet and the script are served with the right content type', async () => {
  await withServer({}, async ({ port }) => {
    const css = await sendRequest(port, { reqPath: '/static/board.css' });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /^text\/css/);
    assert.ok(css.body.length > 0);
    const js = await sendRequest(port, { reqPath: '/static/board.js' });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^(text|application)\/javascript/);
    assert.ok(js.body.length > 0);
  });
});

test('R77 the notice page, a static file, the health check and an error page carry the four headers', async () => {
  await withServer({}, async ({ port }) => {
    const page = await sendRequest(port, { reqPath: '/' });
    assert.equal(page.status, 503);
    assertLockedHeaders(page, 'notice page');
    assertLockedHeaders(await sendRequest(port, { reqPath: '/static/board.css' }), 'static');
    assertLockedHeaders(await sendRequest(port, { reqPath: '/static/board.js' }), 'script');
    assertLockedHeaders(await sendRequest(port, { reqPath: '/healthz' }), 'health');
    const missing = await sendRequest(port, { reqPath: '/admin' });
    assert.equal(missing.status, 404);
    assertLockedHeaders(missing, 'error page');
    const refused = await sendRequest(port, { reqPath: '/', headers: { host: 'evil.example' } });
    assert.equal(refused.status, 421);
    assertLockedHeaders(refused, '421');
  });
});

test('R77 the real page has no inline style or handler, one external script and a matching nonce', async () => {
  await withServer({ fetch: makeWorldFetch() }, async ({ port }) => {
    const res = await sendRequest(port, { reqPath: '/' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assertLockedHeaders(res, 'page');
    const html = res.body;
    assert.equal((html.match(/style="/g) || []).length, 0, 'style attribute');
    assert.equal((html.match(/ on[a-z]+="/g) || []).length, 0, 'on-handler attribute');
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], /\bsrc="/);
    assert.match(html, /<script\b[^>]*><\/script>/i);
    const csp = res.headers['content-security-policy'];
    const cspNonce = csp.match(/'nonce-([^']+)'/);
    assert.ok(cspNonce, 'csp has a nonce');
    const styleNonce = html.match(/<style[^>]*\bnonce="([^"]+)"/);
    assert.ok(styleNonce, 'style block has a nonce');
    assert.equal(styleNonce[1], cspNonce[1]);
    assert.ok(!html.includes(TOKEN));
  });
});

test('R77 the page nonce differs from one request to the next', async () => {
  await withServer({ fetch: makeWorldFetch() }, async ({ port }) => {
    const a = await sendRequest(port, { reqPath: '/' });
    const b = await sendRequest(port, { reqPath: '/' });
    const na = a.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
    const nb = b.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
    assert.notEqual(na, nb);
  });
});

test('U a POST body over 16 KB is 413', async () => {
  await withServer({}, async ({ port, fetch }) => {
    const big = 'title=' + 'a'.repeat(17 * 1024) + '&token=x';
    const res = await sendRequest(port, { method: 'POST', reqPath: '/actions/idea', headers: FORM, body: big });
    assert.equal(res.status, 413);
    assertLockedHeaders(res, '413');
    assert.equal(fetch.calls.length, 0);
  });
});

test('U a POST with a JSON content type is 400', async () => {
  await withServer({}, async ({ port }) => {
    const res = await sendRequest(port, {
      method: 'POST', reqPath: '/actions/idea', headers: { 'content-type': 'application/json' }, body: '{"title":"x"}',
    });
    assert.equal(res.status, 400);
    assertLockedHeaders(res, '400');
  });
});

test('U a POST to an action with a bad token is 403 and nothing is written to GitHub', async () => {
  await withServer({ fetch: makeWorldFetch() }, async ({ port, fetch }) => {
    const res = await sendRequest(port, {
      method: 'POST', reqPath: '/actions/idea', headers: FORM, body: 'title=Buy+milk&token=bad.token.value',
    });
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes(TOKEN));
    const writes = fetch.calls.filter((c) => c.method !== 'GET');
    assert.deepEqual(writes, []);
  });
});

test('U the log has one METHOD path status line per request with no query string and no token', async () => {
  await withServer({}, async ({ port, log }) => {
    await sendRequest(port, { reqPath: '/healthz' });
    await sendRequest(port, { reqPath: '/?secret=abc&x=1' });
    await sendRequest(port, { reqPath: '/admin' });
    await sendRequest(port, { method: 'POST', reqPath: '/actions/close', headers: FORM, body: 'number=1&token=zzz' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(log.length, 4);
    for (const line of log) {
      assert.match(line, /^[A-Z]+ \/\S* \d{3} \d+ms$/);
      assert.ok(!line.includes('?'));
      assert.ok(!line.includes('secret'));
      assert.ok(!line.includes(TOKEN));
    }
    assert.ok(log.some((l) => /^GET \/healthz 200 \d+ms$/.test(l)));
    assert.ok(log.some((l) => /^GET \/admin 404 \d+ms$/.test(l)));
    assert.ok(log.some((l) => l.startsWith('GET / ')));
  });
});

test('U the request log line ends with the whole milliseconds the request took', async () => {
  await withServer({}, async ({ port, log }) => {
    await sendRequest(port, { reqPath: '/healthz' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(log.length, 1);
    assert.match(log[0], /^GET \/healthz 200 \d+ms$/);
  });
});

test('U a query string on the root still reaches the page route', async () => {
  await withServer({ fetch: makeWorldFetch() }, async ({ port }) => {
    const res = await sendRequest(port, { reqPath: '/?x=1' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
  });
});

test('U close ends the server so a later request cannot connect', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-server-test-'));
  try {
    const running = await start({
      processEnv: { BOARD_GITHUB_TOKEN: TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: dir },
      fetch: makeDownFetch(),
      clock: { now: () => CLOCK_MS },
      log: () => {},
    });
    const port = running.address.port;
    const before = await sendRequest(port, { reqPath: '/healthz' });
    assert.equal(before.status, 200);
    await running.close();
    await assert.rejects(sendRequest(port, { reqPath: '/healthz' }), (err) => err.code === 'ECONNREFUSED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('U a missing token rejects start with one sentence and no stack', async () => {
  const err = await startRejection({ BOARD_GITHUB_TOKEN: '' });
  assert.ok(err, 'start rejected');
  assertPlainSentence(err);
  assert.match(err.message, /BOARD_GITHUB_TOKEN/);
});

test('U a missing repository rejects start with one sentence and no stack', async () => {
  const err = await startRejection({ BOARD_REPO: '' });
  assert.ok(err, 'start rejected');
  assertPlainSentence(err);
});
