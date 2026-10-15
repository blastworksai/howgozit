import test from 'node:test';
import assert from 'node:assert/strict';
import { readEnv } from '../board/env.mjs';

const SECRET = 'SENTINEL-TOKEN-123';
const base = { BOARD_GITHUB_TOKEN: SECRET, BOARD_REPO: 'owner/data' };

function sentence(msg) {
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 10);
  assert.ok(!msg.includes('\n'));
  assert.ok(!msg.includes(SECRET));
  assert.ok(/[.]$/.test(msg));
}

test('R79 proxy mode with no identity header refuses to start with one plain sentence', () => {
  const r = readEnv({ ...base, BOARD_MODE: 'proxy' });
  assert.equal(r.ok, false);
  sentence(r.message);
  assert.match(r.message, /BOARD_IDENTITY_HEADER/);
});

test('R79 hosted mode with no identity header refuses to start too', () => {
  const r = readEnv({ ...base, BOARD_MODE: 'hosted' });
  assert.equal(r.ok, false);
  assert.match(r.message, /BOARD_IDENTITY_HEADER/);
});

test('R79 proxy mode with an identity header starts, lower-cased', () => {
  const r = readEnv({ ...base, BOARD_MODE: 'proxy', BOARD_IDENTITY_HEADER: 'X-Forwarded-User' });
  assert.equal(r.ok, true);
  assert.equal(r.env.identityHeader, 'x-forwarded-user');
  assert.equal(r.env.host, '0.0.0.0');
});

test('R79 local mode gives a loopback host', () => {
  const r = readEnv(base);
  assert.equal(r.ok, true);
  assert.equal(r.env.mode, 'local');
  assert.equal(r.env.host, '127.0.0.1');
  assert.equal(r.env.identityHeader, null);
});

test('U every default is applied', () => {
  const r = readEnv(base);
  assert.deepEqual(r.env, {
    token: SECRET,
    repo: 'owner/data',
    mode: 'local',
    host: '127.0.0.1',
    port: 8787,
    allowedHosts: ['localhost:8787', '127.0.0.1:8787'],
    identityHeader: null,
    proxySecret: null,
    dataDir: '.board-data',
    readOnly: false,
    configDir: null,
    icloud: null,
    googleIcal: null,
    githubTokens: [],
    formKey: null,
    startWarnings: [],
  });
});

test('U hosted mode keeps its word and binds like proxy', () => {
  const r = readEnv({ ...base, BOARD_MODE: 'hosted', BOARD_IDENTITY_HEADER: 'x-user' });
  assert.equal(r.ok, true);
  assert.equal(r.env.mode, 'hosted');
  assert.equal(r.env.host, '0.0.0.0');
});

test('U an explicit host wins over the mode default', () => {
  const r = readEnv({ ...base, BOARD_HOST: '10.0.0.5' });
  assert.equal(r.env.host, '10.0.0.5');
});

test('U a missing token is refused by name', () => {
  const r = readEnv({ BOARD_REPO: 'owner/data' });
  assert.equal(r.ok, false);
  sentence(r.message);
  assert.match(r.message, /BOARD_GITHUB_TOKEN/);
  assert.equal(readEnv({ ...base, BOARD_GITHUB_TOKEN: '  ' }).ok, false);
});

test('U a missing or malformed repo is refused by name', () => {
  for (const repo of [undefined, '', 'noslash', 'a/b/c', '/name', 'owner/', 'ow ner/x']) {
    const r = readEnv({ ...base, BOARD_REPO: repo });
    assert.equal(r.ok, false, String(repo));
    sentence(r.message);
    assert.match(r.message, /BOARD_REPO/);
  }
});

test('U an unknown mode is refused by name', () => {
  const r = readEnv({ ...base, BOARD_MODE: 'open' });
  assert.equal(r.ok, false);
  sentence(r.message);
  assert.match(r.message, /BOARD_MODE/);
});

test('U port comes from BOARD_PORT, then PORT, then 8787', () => {
  assert.equal(readEnv({ ...base, BOARD_PORT: '9000', PORT: '9100' }).env.port, 9000);
  assert.equal(readEnv({ ...base, PORT: '9100' }).env.port, 9100);
  assert.equal(readEnv(base).env.port, 8787);
});

test('U the default allowed hosts follow the port', () => {
  const r = readEnv({ ...base, PORT: '3000' });
  assert.deepEqual(r.env.allowedHosts, ['localhost:3000', '127.0.0.1:3000']);
});

test('U a bad port is refused by name', () => {
  for (const p of ['0', '65536', '-1', '80.5', 'abc', '8e3', '0x50']) {
    const r = readEnv({ ...base, BOARD_PORT: p });
    assert.equal(r.ok, false, p);
    sentence(r.message);
    assert.match(r.message, /BOARD_PORT/);
  }
  assert.equal(readEnv({ ...base, PORT: 'x' }).ok, false);
  assert.equal(readEnv({ ...base, BOARD_PORT: '1' }).env.port, 1);
  assert.equal(readEnv({ ...base, BOARD_PORT: '65535' }).env.port, 65535);
});

test('U allowed hosts split on commas and trim', () => {
  const r = readEnv({ ...base, BOARD_ALLOWED_HOSTS: ' board.example.com , other.example.com:8443,, ' });
  assert.deepEqual(r.env.allowedHosts, ['board.example.com', 'other.example.com:8443']);
});

test('U an empty allowed hosts value falls back to the default', () => {
  const r = readEnv({ ...base, BOARD_ALLOWED_HOSTS: ' , ' });
  assert.deepEqual(r.env.allowedHosts, ['localhost:8787', '127.0.0.1:8787']);
});

test('U read-only is true only for 1', () => {
  assert.equal(readEnv({ ...base, BOARD_READ_ONLY: '1' }).env.readOnly, true);
  for (const v of ['0', 'true', 'yes', '', undefined]) {
    assert.equal(readEnv({ ...base, BOARD_READ_ONLY: v }).env.readOnly, false, String(v));
  }
});

test('U data and config folders are read as given', () => {
  const r = readEnv({ ...base, BOARD_DATA_DIR: '/var/board', BOARD_CONFIG_DIR: './fixtures' });
  assert.equal(r.env.dataDir, '/var/board');
  assert.equal(r.env.configDir, './fixtures');
});

test('U the token never appears in any refusal message', () => {
  const cases = [
    { BOARD_REPO: 'bad' },
    { BOARD_MODE: 'nope' },
    { BOARD_PORT: 'nope' },
    { BOARD_MODE: 'proxy' },
    { BOARD_REPO: undefined },
  ];
  for (const c of cases) {
    const r = readEnv({ ...base, ...c });
    assert.equal(r.ok, false);
    assert.ok(!r.message.includes(SECRET));
  }
});

test('U it reads only the object passed in', () => {
  const before = process.env.BOARD_GITHUB_TOKEN;
  process.env.BOARD_GITHUB_TOKEN = 'FROM-PROCESS';
  try {
    assert.equal(readEnv({}).ok, false);
    assert.equal(readEnv(base).env.token, SECRET);
  } finally {
    if (before === undefined) delete process.env.BOARD_GITHUB_TOKEN;
    else process.env.BOARD_GITHUB_TOKEN = before;
  }
});

test('U non-object input is a refusal, not a throw', () => {
  for (const v of [undefined, null, 'x', 5]) assert.equal(readEnv(v).ok, false);
});
