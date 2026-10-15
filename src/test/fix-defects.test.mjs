// Three defects found by running the real board: the no-saved-data text, the double full stop
// in the stale banner, and read-once resolving its data folder against the wrong place.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLoader } from '../board/load.mjs';
import { createCache } from '../board/cache.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { settings } from '../fixtures/build.mjs';

const { start } = await import('../board/server.mjs');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'SENTINEL-TOKEN-123';
const TITLE = 'No saved data yet';
const UNREACHABLE_TEXT = 'The board has no saved data yet and GitHub did not answer. Check the connection and try again in a minute.';

// The reason sentences of board/github/http.mjs (its MESSAGES table, not exported): one per error kind.
// Taken from the real GitHubError so the test follows the file.
const KINDS = ['auth', 'not-found', 'rate-limit', 'network', 'invalid', 'server'];
const REASONS = KINDS.map((k) => ({ kind: k, text: new GitHubError(k, 0).message }));

function emptyCache() {
  return { async readLastGood() { return null; }, async writeLastGood() {}, etags: { get() {}, set() {} } };
}
function failingLoader(err) {
  const failing = { async get() { throw err; }, async paged() { throw err; } };
  return createLoader({
    http: failing,
    env: { repo: 'sam-life/life', readOnly: false, configDir: null, token: TOKEN },
    cache: emptyCache(),
    clock: { now: () => Date.parse('2026-10-12T06:10:00Z') },
  });
}

test('U the reason sentences are read from the real error class and each is a non-empty sentence', () => {
  assert.equal(REASONS.length, 6);
  for (const r of REASONS) assert.match(r.text, /^GitHub .+\.$/, r.kind);
  assert.equal(REASONS.find((r) => r.kind === 'auth').text, 'GitHub did not accept the token.');
});

// ---------- defect 1: the no-saved-data text carries the real reason ----------

test('R67 with nothing saved and a refused token the notice says GitHub did not accept the token and not that it did not answer', async () => {
  const out = await failingLoader(new GitHubError('auth', 401)).load();
  assert.equal(out.ok, false);
  assert.equal(out.notice.status, 503);
  assert.equal(out.notice.title, TITLE);
  assert.ok(out.notice.message.length > 0);
  assert.ok(out.notice.message.includes('GitHub did not accept the token.'), out.notice.message);
  assert.ok(!out.notice.message.includes('did not answer'), out.notice.message);
  assert.ok(!out.notice.message.includes('Check the connection'), out.notice.message);
});

test('R67 with nothing saved and GitHub unreachable the notice keeps its exact sentence', async () => {
  for (const err of [new GitHubError('network', 0), new TypeError('boom with details')]) {
    const out = await failingLoader(err).load();
    assert.equal(out.ok, false);
    assert.equal(out.notice.title, TITLE);
    assert.equal(out.notice.message, UNREACHABLE_TEXT);
  }
});

test('R67 with nothing saved every other reason shows its own sentence and never claims GitHub did not answer', async () => {
  for (const r of REASONS.filter((x) => x.kind !== 'auth' && x.kind !== 'network')) {
    const out = await failingLoader(new GitHubError(r.kind, 500)).load();
    assert.equal(out.ok, false, r.kind);
    assert.equal(out.notice.title, TITLE, r.kind);
    assert.ok(out.notice.message.includes(r.text), r.kind + ': ' + out.notice.message);
    assert.ok(!out.notice.message.includes('did not answer'), r.kind + ': ' + out.notice.message);
  }
});

test('R67 the 503 page for a refused token with nothing saved carries the token sentence', async () => {
  const fetch = async () => ({
    status: 401, ok: false, headers: { get: () => null },
    json: async () => ({ message: 'Bad credentials' }), text: async () => '{"message":"Bad credentials"}',
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-fix-page-'));
  let running = null;
  try {
    running = await start({
      processEnv: { BOARD_GITHUB_TOKEN: TOKEN, BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: dir },
      fetch, clock: { now: () => Date.parse('2026-10-12T06:10:00Z') }, log: () => {},
    });
    const port = running.address.port;
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { host: `localhost:${port}` }, agent: false }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 503);
    assert.ok(res.body.length > 0);
    assert.ok(res.body.includes(TITLE));
    assert.ok(res.body.includes('GitHub did not accept the token.'), res.body);
    assert.ok(!res.body.includes('did not answer'));
  } finally {
    if (running) await running.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------- defect 2: one full stop in the stale banner ----------

const FULL = JSON.parse(readFileSync(path.join(SRC, 'fixtures/board/page.board.json'), 'utf8'));
function bannerText(reason) {
  const b = JSON.parse(JSON.stringify(FULL));
  b.meta.stale = { since: '2026-10-12T05:00:00Z', reason };
  const html = renderPage(b, resolveTheme(null).theme, { styleNonce: 'n', formToken: () => 't' });
  const m = /<p class="banner" data-banner[^>]*>([\s\S]*?)<\/p>/.exec(html);
  assert.ok(m, 'a banner is present');
  const text = m[1].replace(/<[^>]*>/g, '');
  assert.ok(text.length > 0);
  return text;
}

for (const r of REASONS) {
  test(`R67 the stale banner for the "${r.kind}" reason ends that sentence with exactly one full stop`, () => {
    const text = bannerText(r.text);
    assert.ok(text.includes(r.text + ' Data from'), text);
    assert.ok(!text.includes('..'), text);
  });
}

test('R67 the stale banner adds one full stop to a reason that has none', () => {
  const text = bannerText('GitHub did not answer');
  assert.ok(text.includes('GitHub did not answer. Data from'), text);
  assert.ok(!text.includes('..'), text);
});

// ---------- defect 3: read-once finds the board's saved copy from any folder ----------

// A stand-in fetch loaded into the child with --import: every request answers 503 and is recorded,
// so the child never reaches the network and a saved copy is served as stale.
const STUB = `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  appendFileSync(process.env.STUB_LOG, String(url) + '\\n');
  return { status: 503, ok: false, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' };
};
appendFileSync(process.env.STUB_LOG, 'loaded\\n');
`;

async function runReadOnce(dataDirValue, savedDir) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'board-readonce-'));
  try {
    await fs.mkdir(savedDir, { recursive: true });
    await createCache(savedDir).writeLastGood({
      savedAt: '2026-10-12T05:00:00Z',
      raw: { repo: 'sam-life/life', issues: [], milestones: [], projects: [], partial: { issues: false, items: false } },
      settings: settings(), theme: resolveTheme(null).theme, state: {},
    });
    const elsewhere = path.join(work, 'a', 'b', 'c', 'd', 'e', 'f'); // deep, so ".." cannot climb back to the saved copy by luck
    await fs.mkdir(elsewhere, { recursive: true });
    const stub = path.join(work, 'stub.mjs');
    const log = path.join(work, 'stub.log');
    await fs.writeFile(stub, STUB);
    // --import takes a module address, and on Windows a plain C:\ path is not one.
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, path.join(SRC, 'scripts/read-once.mjs')], {
      cwd: elsewhere, encoding: 'utf8', timeout: 20000,
      env: { PATH: process.env.PATH, STUB_LOG: log, BOARD_GITHUB_TOKEN: TOKEN, BOARD_REPO: 'sam-life/life', BOARD_DATA_DIR: dataDirValue },
    });
    const logged = await fs.readFile(log, 'utf8').catch(() => '');
    assert.ok(logged.startsWith('loaded'), 'the stand-in fetch was in place, so nothing reached the network: ' + logged);
    return r.stdout + r.stderr;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

test('U read-once resolves a relative data folder against the project folder, so it finds the saved copy from another folder', async () => {
  const saved = await fs.mkdtemp(path.join(os.tmpdir(), 'board-readonce-data-'));
  try {
    const relative = path.relative(SRC, saved); // relative to the project folder, as the server resolves it
    assert.ok(!path.isAbsolute(relative) && relative.length > 0);
    const out = await runReadOnce(relative, saved);
    assert.ok(out.startsWith('stale:'), 'expected the saved copy to be found, got: ' + out);
    assert.ok(!out.includes('No saved data yet'), out);
  } finally {
    await fs.rm(saved, { recursive: true, force: true });
  }
});

test('U read-once uses an absolute data folder as given', async () => {
  const saved = await fs.mkdtemp(path.join(os.tmpdir(), 'board-readonce-data-'));
  try {
    const out = await runReadOnce(saved, saved);
    assert.ok(out.startsWith('stale:'), out);
  } finally {
    await fs.rm(saved, { recursive: true, force: true });
  }
});
