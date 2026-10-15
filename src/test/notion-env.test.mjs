// R142, R143 and R130 on a Notion board: what the environment must hold, and the one plain sentence of each refusal.
// Written from the rule text (references/contract.md) and reference/mapping-redesign/cp9-interface.md section 0
// (decision 4) and section 5 (env.mjs), never from board/env.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readEnv } from '../board/env.mjs';

const NOTION_TOKEN = 'ntn_SENTINEL_notion_token_4711';
const GITHUB_TOKEN = 'ghp_SENTINEL_github_token_9090';
const FORM_KEY = 'k'.repeat(16) + 'FORM-KEY-SENTINEL' + 'z'.repeat(8);
const CONFIG = '/srv/board-config-sentinel';
const VALUES = [NOTION_TOKEN, GITHUB_TOKEN, FORM_KEY, CONFIG];

const good = {
  BOARD_BACKEND: 'notion',
  BOARD_NOTION_TOKEN: NOTION_TOKEN,
  BOARD_CONFIG_DIR: CONFIG,
  BOARD_FORM_KEY: FORM_KEY,
};
const without = (...names) => Object.fromEntries(Object.entries(good).filter(([k]) => !names.includes(k)));

// One plain sentence: a string, one line, ends with a full stop, and holds none of the values the env carried.
function sentence(msg, values = VALUES) {
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 10, 'is a sentence');
  assert.ok(!msg.includes('\n'), 'one line');
  assert.match(msg, /^[A-Z]/, 'starts like a sentence');
  assert.ok(/\.$/.test(msg), 'ends with a full stop');
  assert.equal((msg.match(/[.!?](\s|$)/g) || []).length, 1, 'one sentence');
  for (const v of values) assert.ok(!msg.includes(v), 'no value in the message');
}

test('R142 BOARD_BACKEND=notion with its token, config folder and form key starts, as a Notion env', () => {
  const r = readEnv(good);
  assert.equal(r.ok, true);
  assert.equal(r.env.backend, 'notion');
  assert.equal(r.env.notionToken, NOTION_TOKEN);
  assert.equal(r.env.configDir, CONFIG);
  assert.equal(r.env.formKey, FORM_KEY);
  assert.equal(r.env.repo, 'notion');
  assert.equal(r.env.token, null);
  assert.deepEqual(r.env.githubTokens, []);
  assert.deepEqual(r.env.startWarnings, []);
});

test('R142 a GitHub token and BOARD_REPO on a Notion board are ignored, not used and not refused', () => {
  const r = readEnv({
    ...good,
    BOARD_GITHUB_TOKEN: GITHUB_TOKEN,
    BOARD_REPO: 'owner/data',
    BOARD_GITHUB_TOKEN_1: 'ghp_other_token_1',
    BOARD_GITHUB_OWNER_1: 'someone',
  });
  assert.equal(r.ok, true);
  assert.equal(r.env.token, null);
  assert.equal(r.env.repo, 'notion');
  assert.deepEqual(r.env.githubTokens, []);
  assert.deepEqual(r.env.startWarnings, []);
  assert.ok(!JSON.stringify(r.env).includes(GITHUB_TOKEN), 'the GitHub token is not carried');
});

test('R142 the GitHub back-end env gains no key for the Notion back-end', () => {
  const r = readEnv({ BOARD_GITHUB_TOKEN: GITHUB_TOKEN, BOARD_REPO: 'owner/data' });
  assert.equal(r.ok, true);
  assert.ok(!('backend' in r.env), 'no backend key');
  assert.ok(!('notionToken' in r.env), 'no notionToken key');
});

test('R142 BOARD_BACKEND gitlab is still refused, naming the two choices, as one plain sentence', () => {
  const r = readEnv({ ...good, BOARD_BACKEND: 'gitlab' });
  assert.equal(r.ok, false);
  assert.match(r.message, /github/);
  assert.match(r.message, /notion/);
  sentence(r.message);
});

test('R143 a Notion board with no config folder refuses to start with one plain sentence naming BOARD_CONFIG_DIR', () => {
  const r = readEnv(without('BOARD_CONFIG_DIR'));
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_CONFIG_DIR/);
  sentence(r.message);
});

test('R143 an empty or blank BOARD_CONFIG_DIR is no config folder', () => {
  for (const v of ['', '   ']) {
    const r = readEnv({ ...good, BOARD_CONFIG_DIR: v });
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.match(r.message, /BOARD_CONFIG_DIR/);
  }
});

test('R143 a Notion board with no Notion token refuses to start with one plain sentence naming BOARD_NOTION_TOKEN', () => {
  const r = readEnv(without('BOARD_NOTION_TOKEN'));
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_NOTION_TOKEN/);
  sentence(r.message);
});

test('R143 a GitHub token is not a Notion token: with only a GitHub token set the board still refuses', () => {
  const r = readEnv({ ...without('BOARD_NOTION_TOKEN'), BOARD_GITHUB_TOKEN: GITHUB_TOKEN, BOARD_REPO: 'owner/data' });
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_NOTION_TOKEN/);
  sentence(r.message);
});

test('R130 given only a Notion token and no form key, a Notion board refuses to start naming BOARD_FORM_KEY', () => {
  const r = readEnv(without('BOARD_FORM_KEY'));
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_FORM_KEY/);
  sentence(r.message);
});

test('R130 a GitHub token does not stand in for the form key on a Notion board (the key is required, the token ignored)', () => {
  const r = readEnv({ ...without('BOARD_FORM_KEY'), BOARD_GITHUB_TOKEN: GITHUB_TOKEN, BOARD_REPO: 'owner/data' });
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_FORM_KEY/);
  sentence(r.message);
});

test('R130 a 31-character form key is refused on a Notion board, a 32-character one is accepted', () => {
  const short = readEnv({ ...good, BOARD_FORM_KEY: 'k'.repeat(31) });
  assert.equal(short.ok, false);
  assert.match(short.message, /BOARD_FORM_KEY/);
  sentence(short.message, [...VALUES, 'k'.repeat(31)]);
  assert.equal(readEnv({ ...good, BOARD_FORM_KEY: 'k'.repeat(32) }).ok, true);
});

test('R130 a form key with whitespace is refused on a Notion board without being shown', () => {
  const key = 'a'.repeat(20) + ' ' + 'b'.repeat(20);
  const r = readEnv({ ...good, BOARD_FORM_KEY: key });
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_FORM_KEY/);
  sentence(r.message, [...VALUES, key]);
});

test('R143 every Notion refusal is one plain sentence and shows no value', () => {
  const cases = [
    without('BOARD_NOTION_TOKEN'),
    without('BOARD_CONFIG_DIR'),
    without('BOARD_FORM_KEY'),
    { ...good, BOARD_FORM_KEY: 'k'.repeat(31) },
    { ...good, BOARD_BACKEND: 'gitlab' },
    { ...good, BOARD_MODE: 'proxy' },
    { ...good, BOARD_PORT: 'abc' },
  ];
  for (const env of cases) {
    const r = readEnv(env);
    assert.equal(r.ok, false);
    sentence(r.message, [...VALUES, 'k'.repeat(31)]);
  }
});

test('R143 the shared checks still hold on a Notion board: proxy mode needs its identity header', () => {
  const r = readEnv({ ...good, BOARD_MODE: 'proxy' });
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_IDENTITY_HEADER/);
  const ok = readEnv({ ...good, BOARD_MODE: 'proxy', BOARD_IDENTITY_HEADER: 'X-User' });
  assert.equal(ok.ok, true);
  assert.equal(ok.env.identityHeader, 'x-user');
  assert.equal(ok.env.backend, 'notion');
});

test('R143 the Notion env carries the shared defaults a GitHub env does', () => {
  const g = readEnv({ BOARD_GITHUB_TOKEN: GITHUB_TOKEN, BOARD_REPO: 'owner/data' }).env;
  const n = readEnv(good).env;
  for (const k of ['mode', 'host', 'port', 'allowedHosts', 'identityHeader', 'proxySecret', 'dataDir', 'readOnly', 'icloud', 'googleIcal']) {
    assert.deepEqual(n[k], g[k], k);
  }
});
