// R174: the shipped tree holds no font or image but the neutral test skin.
// The folder is walked, git is not asked: every file under src/ except out/, node_modules/ and .board-data/.
// The test skin (fixtures/skin/) is built in a later checkpoint, so these checks hold both before it exists
// and after it is complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SKIP = new Set(['out', 'node_modules', '.board-data']);

const BINARY_EXT = new Set([
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.avif', '.ico', '.bmp', '.svg', '.pdf', '.zip', '.gz',
]);
const ALLOWED = [
  'fixtures/skin/fonts/neutral.woff2',
  'fixtures/skin/img/neutral.png',
  'fixtures/skin/img/neutral.svg',
];
const SKIN_FILES = [...ALLOWED, 'fixtures/skin/skin.css'];

function walk(root) {
  const files = [];
  (function go(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) go(full);
      else if (e.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  return files;
}

// A file is binary when its first 8,000 bytes hold a zero byte.
function hasZeroByte(file) {
  const fd = openSync(path.join(ROOT, file), 'r');
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, 8000, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

const FILES = walk(ROOT);

test('R174 every binary or image file in the shipped tree is one of the three neutral test skin paths', () => {
  const binary = FILES.filter((f) => BINARY_EXT.has(path.extname(f).toLowerCase()) || hasZeroByte(f));
  const stray = binary.filter((f) => !ALLOWED.includes(f));
  assert.deepEqual(stray, []);
});

test('R174 no file with a font or image extension exists under board/', () => {
  const found = FILES.filter((f) => f.startsWith('board/') && BINARY_EXT.has(path.extname(f).toLowerCase()));
  assert.deepEqual(found, []);
});

test('R174 the test skin is all there or not there at all: its four files exist once fixtures/skin/ does', () => {
  const inSkin = FILES.filter((f) => f.startsWith('fixtures/skin/'));
  if (inSkin.length === 0) return;
  const missing = SKIN_FILES.filter((f) => !FILES.includes(f));
  assert.deepEqual(missing, []);
});

test('R174 the walk reads this folder and sees the stylesheet, so an empty walk cannot pass the checks above', () => {
  assert.ok(FILES.includes('board/static/board.css'));
  assert.ok(FILES.includes('test/tree-binaries.test.mjs'));
  assert.ok(readFileSync(path.join(ROOT, 'package.json'), 'utf8').length > 0);
});
