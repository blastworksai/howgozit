// Checkpoint 4: the skin on the page and on the notice (R171, R172, R74, R77 policies, R173 as far as testable).
// Written from the contract text alone. renderPage and renderNotice are called directly; the headers go through the
// real server (the harness mirrors server.test.mjs and proxy-secret.test.mjs, whose helpers are not exported).
//
// Assumptions the contract leaves open:
//  - the skin link is written as one line `<link rel="stylesheet" href="/skin/skin.css">` (R171 gives the exact element),
//    so the skin-on diff removes that element plus its line break, and the root mark ` data-skin`;
//  - a notice reached through the real server is the 503 for a missing settings file.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPage, renderNotice } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { routes as worldRoutes, issues as worldIssues, apiIssue, R } from '../fixtures/github/world.mjs';

const { start } = await import('../board/server.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SKIN = path.join(HERE, '..', 'fixtures', 'skin');
const loadJson = (rel) => JSON.parse(fs.readFileSync(path.join(HERE, rel), 'utf8'));
const FULL = loadJson('../fixtures/board/page.board.json');
const MIN = loadJson('../fixtures/board/page-min.board.json');
const SYSTEM = resolveTheme(null).theme;
const GOOGLE = resolveTheme({ fonts: { source: 'google' } }).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => `tok-${action}-${target}` };
const SKIN_LINK = '<link rel="stylesheet" href="/skin/skin.css">';
const ROOT_SKIN = '<html lang="en" data-skin>';
const ROOT_PLAIN = '<html lang="en">';
const copy = (b) => JSON.parse(JSON.stringify(b));
const count = (s, needle) => s.split(needle).length - 1;
const countRe = (s, re) => (s.match(re) || []).length;

const READONLY = (() => { const b = copy(FULL); b.meta.readOnly = true; return b; })();
const STALE = (() => { const b = copy(FULL); b.meta.stale = { since: '2026-10-12T05:00:00Z', reason: 'GitHub did not answer' }; return b; })();
const BOARDS = [['full', FULL], ['minimal', MIN], ['read-only', READONLY], ['stale', STALE]];
const THEMES = [['system', SYSTEM], ['google', GOOGLE]];

const render = (board, theme, skin) => renderPage(board, theme, skin === undefined ? OPTS : { ...OPTS, skin });
const NOTICES = [
  { title: 'No settings file found', message: 'Run the setup step.', status: 503 },
  { title: 'That did not work', message: 'Try again.', status: 400 },
  { title: 'GitHub did not answer', message: 'Wait a minute.', status: 502 },
];
const notice = (n, skin) => renderNotice(n, skin === undefined ? { styleNonce: 'nn' } : { styleNonce: 'nn', skin });

// ================================================================ R171 the board page

for (const [bn, board] of BOARDS) {
  for (const [tn, theme] of THEMES) {
    test(`R171 with a skin (${bn} board, ${tn} fonts) the head holds the elements in the fixed order and the root is marked`, () => {
      const html = render(board, theme, true);
      assert.ok(html.includes(ROOT_SKIN), 'root element');
      assert.equal(count(html, 'data-skin'), 1, 'data-skin once');
      assert.equal(count(html, SKIN_LINK), 1, 'the skin link once');
      assert.equal(count(html, 'skin.css'), 1);
      assert.equal(countRe(html, /<style\b/g), 1, 'exactly one <style');
      const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
      const at = (s) => head.indexOf(s);
      const order = [
        at('<meta charset'), at('name="viewport"'), at('<title>'), at('<link rel="stylesheet" href="/static/board.css">'),
        ...(tn === 'google' ? [at('href="https://fonts.googleapis.com/css2')] : []),
        at(SKIN_LINK), at('<style nonce="testnonce">'),
      ];
      for (const i of order) assert.ok(i >= 0, 'every element is there');
      assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the stated order');
      // nothing else in the head between the board stylesheet and the style block
      const between = head.slice(at('<link rel="stylesheet" href="/static/board.css">'), at('<style nonce="testnonce">'));
      const links = [...between.matchAll(/<[a-z]+\b[^>]*>/g)].map((m) => m[0]);
      assert.equal(links.length, tn === 'google' ? 3 : 2, 'the board stylesheet, the font link when Google, the skin link');
      assert.equal(links[links.length - 1], SKIN_LINK, 'the skin link is the last link');
      assert.match(head, /<style nonce="testnonce">/);
    });
  }
}

for (const [bn, board] of BOARDS) {
  for (const [tn, theme] of THEMES) {
    test(`R171 without a skin (${bn} board, ${tn} fonts) the page is byte for byte the one rendered without the option`, () => {
      const plain = render(board, theme);
      assert.equal(render(board, theme, false), plain, 'skin: false');
      assert.equal(render(board, theme, undefined), plain, 'skin: undefined');
      assert.ok(plain.startsWith(`<!doctype html>\n${ROOT_PLAIN}\n<head>\n`), 'the plain root element');
      assert.ok(!plain.includes('data-skin'));
      assert.ok(!plain.includes('skin.css'));
      assert.ok(!plain.includes('/skin/'));
    });
    test(`R171 skin on changes nothing but the root mark and the link (${bn} board, ${tn} fonts)`, () => {
      const plain = render(board, theme);
      const skinned = render(board, theme, true);
      assert.notEqual(skinned, plain);
      const back = skinned.replace(ROOT_SKIN, ROOT_PLAIN).replace(`${SKIN_LINK}\n`, '');
      assert.equal(back, plain, 'removing the mark and the link gives today\'s page');
    });
  }
}

test('R171 the skin link comes after the font link when the theme has Google fonts', () => {
  const html = render(FULL, GOOGLE, true);
  assert.ok(html.indexOf('fonts.googleapis.com/css2') < html.indexOf(SKIN_LINK));
  assert.ok(html.indexOf('/static/board.css') < html.indexOf('fonts.googleapis.com/css2'));
});

// ================================================================ R172 the notice page

for (const n of NOTICES) {
  test(`R172 a notice (${n.status}) with a skin has the head, one nonce style block with the default theme's variables, and no script`, () => {
    const html = notice(n, true);
    assert.ok(html.includes(ROOT_SKIN));
    assert.equal(count(html, 'data-skin'), 1);
    assert.equal(count(html, SKIN_LINK), 1);
    assert.equal(countRe(html, /<style\b/g), 1, 'one <style');
    assert.equal(countRe(html, /<script/gi), 0, 'zero <script');
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    const at = (s) => head.indexOf(s);
    const order = [at('<meta charset'), at('name="viewport"'), at(`<title>${n.title}</title>`), at('<link rel="stylesheet" href="/static/board.css">'), at(SKIN_LINK), at('<style nonce="nn">')];
    for (const i of order) assert.ok(i >= 0);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    const style = /<style nonce="nn">([\s\S]*?)<\/style>/.exec(html)[1];
    for (const v of ['--ground', '--dot', '--card', '--border', '--ink', '--muted', '--faint', '--agent-bg', '--agent-ink', '--accent', '--hot', '--hot-ink', '--ok', '--on-accent', '--radius', '--font-heading', '--font-body', '--font-mono']) {
      assert.ok(style.includes(`${v}:`), `${v} in the notice's style block`);
    }
    assert.ok(!html.includes('data-section'), 'no section hook');
  });
  test(`R172 a notice (${n.status}) without a skin is byte for byte the one rendered without the option`, () => {
    const plain = notice(n);
    assert.equal(notice(n, false), plain);
    assert.equal(notice(n, undefined), plain);
    assert.ok(plain.includes(ROOT_PLAIN) && !plain.includes('data-skin') && !plain.includes('skin.css'));
    assert.equal(countRe(plain, /<script/gi), 0);
    assert.equal(notice(n, true).replace(ROOT_SKIN, ROOT_PLAIN).replace(`${SKIN_LINK}\n`, ''), plain, 'skin on changes only the mark and the link');
  });
}

// ================================================================ R74 allowed addresses

const addressesOf = (html) => [...html.matchAll(/(?<![-\w])(?:href|src)="([^"]*)"/g)].map((m) => m[1]).filter((a) => !a.startsWith('https://github.com/'));

for (const [bn, board] of BOARDS) {
  for (const [tn, theme] of THEMES) {
    test(`R74 with a skin the one address beyond GitHub links, the two static files and the font stylesheet is /skin/skin.css (${bn}, ${tn})`, () => {
      const skinned = addressesOf(render(board, theme, true));
      const plain = addressesOf(render(board, theme));
      assert.deepEqual([...new Set(skinned.filter((a) => !plain.includes(a)))], ['/skin/skin.css']);
      assert.equal(skinned.filter((a) => a === '/skin/skin.css').length, 1);
      const allowed = new Set(['/static/board.css', '/static/board.js', '/skin/skin.css']);
      for (const a of skinned) {
        if (allowed.has(a)) continue;
        assert.ok(tn === 'google' && /^https:\/\/fonts\.googleapis\.com\/css2\?/.test(a), `unexpected address ${a}`);
      }
      assert.equal(skinned.length, plain.length + 1, 'exactly one address added');
    });
  }
}

test('R74 the skin stylesheet link is never an href on a page without a skin, and a notice without a skin has none', () => {
  assert.ok(!addressesOf(render(FULL, SYSTEM)).includes('/skin/skin.css'));
  assert.deepEqual(addressesOf(notice(NOTICES[0], true)), ['/static/board.css', '/skin/skin.css']);
  assert.deepEqual(addressesOf(notice(NOTICES[0])), ['/static/board.css']);
});

// ================================================================ the sweeps (skin on)

for (const [bn, board] of BOARDS) {
  for (const [tn, theme] of THEMES) {
    test(`R77 with a skin the page (${bn}, ${tn}) has no style attribute, no inline handler and exactly one script with a src and no content`, () => {
      const html = render(board, theme, true);
      assert.equal(countRe(html, /style="/g), 0, 'style="');
      assert.equal(countRe(html, / on[a-z]+="/g), 0, 'inline handler');
      assert.equal(countRe(html, /<script/g), 1, 'one script');
      assert.match(html, /<script [^>]*src="[^"]+"[^>]*><\/script>/);
      assert.equal(countRe(html, /<style\b/g), 1);
    });
  }
}
for (const n of NOTICES) {
  test(`R77 with a skin a notice (${n.status}) has no style attribute, no inline handler and no script`, () => {
    const html = notice(n, true);
    assert.equal(countRe(html, /style="/g), 0);
    assert.equal(countRe(html, / on[a-z]+="/g), 0);
    assert.equal(countRe(html, /<script/gi), 0);
  });
}

// ================================================================ R173 as far as testable

const STABLE_VARS = ['--ground', '--dot', '--card', '--border', '--ink', '--muted', '--faint', '--agent-bg', '--agent-ink', '--accent', '--hot', '--hot-ink', '--ok', '--on-accent', '--radius', '--font-heading', '--font-body', '--font-mono'];
const STABLE_SECTIONS = ['header', 'capture', 'brief', 'season', 'focus', 'timeline', 'calendar', 'inbox', 'next', 'habits', 'heatmap', 'projects', 'log', 'ideas', 'standalone', 'footer'];
const STABLE_HOOKS = ['data-src', 'data-focus', 'data-stale', 'data-banner', 'data-message', 'data-waiting', 'data-done', 'data-allday', 'data-account', 'data-colour', 'data-source', 'data-filedate'];

test('R173 the skinned page keeps the stable surface: root mark, every section name, every theme variable in the nonce style block', () => {
  const html = render(FULL, SYSTEM, true);
  assert.ok(html.includes(ROOT_SKIN));
  const names = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, STABLE_SECTIONS);
  const style = /<style nonce="testnonce">([\s\S]*?)<\/style>/.exec(html)[1];
  for (const v of STABLE_VARS) assert.ok(new RegExp(`${v}:`).test(style), `${v} defined in the nonce style block`);
});

test('R173 every data hook of the stable list is present in a fixture page (skin on, stale and ordinary) or in board.css', () => {
  const css = fs.readFileSync(path.join(HERE, '..', 'board', 'static', 'board.css'), 'utf8');
  const pages = [render(FULL, SYSTEM, true), render(STALE, SYSTEM, true), render(MIN, SYSTEM, true), notice(NOTICES[0], true)].join('\n');
  // Not every hook shows on the two fixture boards (data-waiting, data-allday, data-account, data-source and data-filedate
  // need data they do not hold), so the renderer's own source stands in for those: the hook is written by the markup.
  const renderDir = path.join(HERE, '..', 'board', 'render');
  const renderSrc = fs.readdirSync(renderDir).map((f) => fs.readFileSync(path.join(renderDir, f), 'utf8')).join('\n');
  for (const hook of STABLE_HOOKS) assert.ok(pages.includes(hook) || css.includes(hook) || renderSrc.includes(hook), `${hook} is in a fixture page, board.css or the markup source`);
  assert.ok(/class="[^"]*\bpc-[a-z0-9-]+/.test(pages), 'a pc- class');
  assert.ok(/class="[^"]*\bx-\d/.test(pages) || /\bx-\d/.test(pages), 'an x- class');
});

// ================================================================ the real server: the four policies (R77)

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
function makeFetch({ theme = null, settings = true } = {}) {
  const list = [...worldIssues(), apiIssue(20, { title: 'Plan the garden', labels: [{ id: 3, name: 'idea', color: 'cccccc' }] })];
  const table = worldRoutes({
    issues: list,
    files: {
      'board.config.json': settings ? settingsText() : null,
      'theme.json': theme === null ? null : JSON.stringify(theme),
      'state/brief.json': null, 'state/calendar.json': null, 'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null,
    },
  });
  return async (url, init = {}) => {
    if (((init && init.method) || 'GET') !== 'GET') return fakeResponse(404, { message: 'Not Found' });
    const u = new URL(String(url));
    const key = u.pathname + u.search;
    if (key === `${R}/issues?state=all&per_page=100` || key.startsWith(`${R}/issues?state=all&per_page=100&since=`)) return fakeResponse(200, list);
    if (Object.prototype.hasOwnProperty.call(table, key)) return fakeResponse(200, table[key]);
    return fakeResponse(404, { message: 'Not Found' });
  };
}
function sendRequest(port, { method = 'GET', reqPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: { host: `localhost:${port}`, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function withBoard({ env = {}, theme = null, settings = true } = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-page-data-'));
  let running = null;
  try {
    running = await start({
      processEnv: { BOARD_GITHUB_TOKEN: 'SENTINEL-TOKEN-123', BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: dir, ...env },
      fetch: makeFetch({ theme, settings }), clock: { now: () => Date.parse('2026-10-12T06:10:00Z') }, log: () => {},
    });
    return await fn({ port: running.address.port });
  } finally {
    if (running) await running.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const made = [];
after(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });
// a skin with a stylesheet and an image but no font
function skinWithoutFont() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-page-'));
  made.push(root);
  const dir = path.join(root, 'skin');
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skin.css'), 'html[data-skin] { --accent: #336699; }\n');
  fs.writeFileSync(path.join(dir, 'img', 'a.png'), 'PNG');
  return dir;
}

const TAIL = "img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const POLICY = {
  1: (n) => `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${n}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; ${TAIL}`,
  2: (n) => `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${n}' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; ${TAIL}`,
  3: (n) => `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${n}'; ${TAIL}`,
  4: (n) => `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${n}'; font-src 'self'; ${TAIL}`,
};
const CSP_PLAIN = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function nonceCheck(res) {
  const inCsp = [...String(res.headers['content-security-policy']).matchAll(/'nonce-([^']+)'/g)].map((m) => m[1]);
  const inBody = [...res.body.matchAll(/<style nonce="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(inCsp.length, 1, 'one nonce in the policy');
  assert.equal(inBody.length, 1, 'one nonce on the style block');
  assert.equal(inBody[0], inCsp[0], 'the same nonce');
  return inCsp[0];
}

// (theme fonts, skin) -> the policy number of R77
const COMBOS = [
  ['google', 'a skin with a font', 2], ['google', 'a skin with no font', 1], ['google', 'no skin', 1],
  ['system', 'a skin with a font', 4], ['system', 'a skin with no font', 3], ['system', 'no skin', 3],
];
const skinFor = (label) => (label === 'a skin with a font' ? FIXTURE_SKIN : label === 'a skin with no font' ? skinWithoutFont() : undefined);

for (const [fonts, skinLabel, num] of COMBOS) {
  test(`R77 the page with ${fonts} fonts and ${skinLabel} carries policy ${num} with its own nonce`, async () => {
    const skin = skinFor(skinLabel);
    await withBoard({ theme: { fonts: { source: fonts } }, env: skin ? { BOARD_SKIN_DIR: skin } : {} }, async ({ port }) => {
      const res = await sendRequest(port, { reqPath: '/' });
      assert.equal(res.status, 200);
      const n = nonceCheck(res);
      assert.equal(res.headers['content-security-policy'], POLICY[num](n));
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.body.includes(ROOT_SKIN), skin !== undefined, 'the root mark follows the skin');
      assert.equal(res.body.includes(SKIN_LINK), skin !== undefined);
      assert.equal(res.body.includes('fonts.googleapis.com/css2'), fonts === 'google');
    });
  });

  test(`R77 a notice page with ${fonts} fonts and ${skinLabel} carries policy ${skinLabel === 'a skin with a font' ? 4 : 3} (a notice counts as system fonts) with its own nonce`, async () => {
    const skin = skinFor(skinLabel);
    await withBoard({ theme: { fonts: { source: fonts } }, settings: false, env: skin ? { BOARD_SKIN_DIR: skin } : {} }, async ({ port }) => {
      const res = await sendRequest(port, { reqPath: '/' });
      assert.ok(res.status >= 400, `a notice answers an error status, got ${res.status}`);
      assert.ok(res.body.includes('<main class="notice">'), 'it is a notice page');
      const n = nonceCheck(res);
      assert.equal(res.headers['content-security-policy'], POLICY[skinLabel === 'a skin with a font' ? 4 : 3](n));
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(countRe(res.body, /<script/gi), 0, 'no script');
      assert.equal(countRe(res.body, /<style\b/g), 1);
      assert.equal(res.body.includes(ROOT_SKIN), skin !== undefined);
      assert.equal(res.body.includes(SKIN_LINK), skin !== undefined);
      if (skin === undefined) assert.ok(!res.body.includes('data-skin') && !res.body.includes('skin.css'));
    });
  });
}

test('R77 every other answer carries the plain policy: no nonce, no font-src and no font host, whatever the theme and the skin', async () => {
  await withBoard({ theme: { fonts: { source: 'google' } }, env: { BOARD_SKIN_DIR: FIXTURE_SKIN } }, async ({ port }) => {
    for (const [method, p] of [['GET', '/static/board.css'], ['GET', '/static/board.js'], ['GET', '/healthz'], ['GET', '/skin/skin.css'], ['GET', '/skin/fonts/neutral.woff2'], ['GET', '/skin/img/neutral.png'], ['GET', '/nonesuch'], ['GET', '/skin/'], ['PUT', '/skin/skin.css'], ['PUT', '/static/board.css']]) {
      const res = await sendRequest(port, { method, reqPath: p });
      assert.equal(res.headers['content-security-policy'], CSP_PLAIN, `${method} ${p}`);
      assert.ok(!res.headers['content-security-policy'].includes('font-src'));
    }
    const foreign = await sendRequest(port, { reqPath: '/skin/skin.css', headers: { host: 'evil.example' } });
    assert.equal(foreign.status, 421);
    assert.equal(foreign.headers['content-security-policy'], CSP_PLAIN);
  });
});

test('R77 two pages and two notices from the real server never share a nonce, and each carries its own', async () => {
  await withBoard({ env: { BOARD_SKIN_DIR: FIXTURE_SKIN } }, async ({ port }) => {
    const a = nonceCheck(await sendRequest(port, { reqPath: '/' }));
    const b = nonceCheck(await sendRequest(port, { reqPath: '/' }));
    assert.notEqual(a, b);
  });
  await withBoard({ settings: false, env: { BOARD_SKIN_DIR: FIXTURE_SKIN } }, async ({ port }) => {
    const a = nonceCheck(await sendRequest(port, { reqPath: '/' }));
    const b = nonceCheck(await sendRequest(port, { reqPath: '/' }));
    assert.notEqual(a, b);
  });
});

test('R77 the page from the real server with a skin has no style attribute, no inline handler, one script; its notice has none', async () => {
  await withBoard({ env: { BOARD_SKIN_DIR: FIXTURE_SKIN } }, async ({ port }) => {
    const page = (await sendRequest(port, { reqPath: '/' })).body;
    assert.equal(countRe(page, /style="/g), 0);
    assert.equal(countRe(page, / on[a-z]+="/g), 0);
    assert.equal(countRe(page, /<script/g), 1);
  });
  await withBoard({ settings: false, env: { BOARD_SKIN_DIR: FIXTURE_SKIN } }, async ({ port }) => {
    const page = (await sendRequest(port, { reqPath: '/' })).body;
    assert.equal(countRe(page, /<script/gi), 0);
    assert.equal(countRe(page, /style="/g), 0);
  });
});
