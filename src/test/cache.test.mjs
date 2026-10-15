import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCache } from '../board/cache.mjs';

async function withDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'board-cache-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const bundleA = { savedAt: '2026-10-12T10:00:00Z', raw: { a: 1 }, settings: 's', theme: 't', state: { brief: 'b' } };

test('R66 a first write into a missing folder creates last-good.json', async () => {
  await withDir(async (root) => {
    const dir = path.join(root, 'data', 'cache');
    await createCache(dir).writeLastGood(bundleA);
    const text = await fs.readFile(path.join(dir, 'last-good.json'), 'utf8');
    assert.deepEqual(JSON.parse(text), bundleA);
  });
});

test('R66 the file holds no sentinel the bundle did not hold', async () => {
  await withDir(async (root) => {
    const cache = createCache(root);
    await cache.writeLastGood(bundleA);
    const text = await fs.readFile(path.join(root, 'last-good.json'), 'utf8');
    assert.equal(text.includes('SENTINEL-TOKEN-123'), false);
  });
});

test('R66 a later write replaces the file whole', async () => {
  await withDir(async (root) => {
    const cache = createCache(root);
    await cache.writeLastGood({ onlyFirst: 1, shared: 'one' });
    await cache.writeLastGood({ shared: 'two', second: true });
    const got = JSON.parse(await fs.readFile(path.join(root, 'last-good.json'), 'utf8'));
    assert.deepEqual(got, { shared: 'two', second: true });
    assert.equal('onlyFirst' in got, false);
  });
});

test('R66 the file is readable by the owner only', async () => {
  await withDir(async (root) => {
    const cache = createCache(root);
    await cache.writeLastGood(bundleA);
    await cache.writeLastGood(bundleA);
    if (process.platform !== 'win32') {
      const st = await fs.stat(path.join(root, 'last-good.json'));
      assert.equal(st.mode & 0o777, 0o600);
    }
  });
});

test('R66 no tmp file is left behind', async () => {
  await withDir(async (root) => {
    const cache = createCache(root);
    await cache.writeLastGood(bundleA);
    await cache.writeLastGood({ again: true });
    const names = await fs.readdir(root);
    assert.deepEqual(names, ['last-good.json']);
  });
});

test('U cold start reads null', async () => {
  await withDir(async (root) => {
    assert.equal(await createCache(path.join(root, 'missing')).readLastGood(), null);
    assert.equal(await createCache(root).readLastGood(), null);
  });
});

test('U a corrupt file reads null', async () => {
  await withDir(async (root) => {
    await fs.writeFile(path.join(root, 'last-good.json'), '{not json');
    assert.equal(await createCache(root).readLastGood(), null);
  });
});

test('U a round trip returns an equal bundle', async () => {
  await withDir(async (root) => {
    const cache = createCache(root);
    await cache.writeLastGood(bundleA);
    assert.deepEqual(await cache.readLastGood(), bundleA);
    assert.deepEqual(await createCache(root).readLastGood(), bundleA);
  });
});

test('U etags get, set and overwrite', async () => {
  const { etags } = createCache('/nonexistent-board-cache-dir');
  assert.equal(etags.get('u1'), undefined);
  etags.set('u1', 'e1', { x: 1 });
  assert.deepEqual(etags.get('u1'), { etag: 'e1', body: { x: 1 } });
  etags.set('u1', 'e2', { x: 2 });
  assert.deepEqual(etags.get('u1'), { etag: 'e2', body: { x: 2 } });
});

test('U the 600 cap drops the oldest and an overwrite refreshes', async () => {
  const { etags } = createCache('/nonexistent-board-cache-dir');
  for (let i = 0; i < 600; i++) etags.set('u' + i, 'e', i);
  etags.set('u0', 'e', 'fresh');
  etags.set('extra', 'e', 'x');
  assert.equal(etags.get('u1'), undefined);
  assert.equal(etags.get('u0').body, 'fresh');
  assert.equal(etags.get('extra').body, 'x');
  assert.equal(etags.size, 600);
});

test('U etags are not written to disk', async () => {
  await withDir(async (root) => {
    const cache = createCache(root);
    cache.etags.set('https://example.test/a', 'ETAG-MARK-77', 'BODY-MARK-88');
    await cache.writeLastGood(bundleA);
    const text = await fs.readFile(path.join(root, 'last-good.json'), 'utf8');
    assert.equal(text.includes('ETAG-MARK-77'), false);
    assert.equal(text.includes('BODY-MARK-88'), false);
    assert.deepEqual(await fs.readdir(root), ['last-good.json']);
  });
});
