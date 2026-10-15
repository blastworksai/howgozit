// R142: the back-end choice in the environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readEnv } from '../board/env.mjs';

const base = { BOARD_GITHUB_TOKEN: 'ghp_x', BOARD_REPO: 'me/data' };

test('R142 BOARD_BACKEND gitlab is refused naming the two choices', () => {
  const r = readEnv({ ...base, BOARD_BACKEND: 'gitlab' });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'BOARD_BACKEND must be github or notion.');
});

test('R142 BOARD_BACKEND absent or github starts as before', () => {
  assert.equal(readEnv({ ...base }).ok, true);
  assert.equal(readEnv({ ...base, BOARD_BACKEND: 'github' }).ok, true);
  assert.equal(readEnv({ ...base, BOARD_BACKEND: '  ' }).ok, true);
});

test('U BOARD_BACKEND notion with a form key and no BOARD_NOTION_TOKEN is refused with one plain sentence', () => {
  const key = 'k'.repeat(32);
  const r = readEnv({ ...base, BOARD_BACKEND: 'notion', BOARD_FORM_KEY: key });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Set BOARD_NOTION_TOKEN to a Notion token that can read your five data sources.');
  assert.equal(r.message.includes(key), false, 'no value appears in the sentence');
});
