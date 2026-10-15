import { mkdir, writeFile, rename, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const FILE = 'last-good.json';
const MAX_ETAGS = 600;

function createEtags() {
  const map = new Map();
  return {
    get(url) {
      const entry = map.get(url);
      return entry === undefined ? undefined : entry;
    },
    set(url, etag, body) {
      map.delete(url);
      map.set(url, { etag, body });
      while (map.size > MAX_ETAGS) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}

export function createCache(dir) {
  const file = path.join(dir, FILE);

  async function readLastGood() {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeLastGood(bundle) {
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, FILE + '.tmp-' + randomBytes(6).toString('hex'));
    try {
      await writeFile(tmp, JSON.stringify(bundle), { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  return { readLastGood, writeLastGood, etags: createEtags() };
}
