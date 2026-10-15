import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The environment overrides exist only so these checks can be proved against a temp folder.
const ROOT = process.env.TREE_TEST_ROOT ? path.resolve(process.env.TREE_TEST_ROOT) : path.resolve(HERE, '..');
const SITES = process.env.TREE_TEST_SITES || path.join(HERE, 'name-sites.json');

// The working title, built from two pieces so it never appears here.
const TITLE = ['life', 'board'].join('');
const SKIP = new Set(['.board-data', 'out', 'node_modules']);

export function walk(root, skip = SKIP) {
  const files = [];
  const dirs = [];
  (function go(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        dirs.push(path.relative(root, full).split(path.sep).join('/'));
        if (!skip.has(e.name)) go(full);
      } else if (e.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  return { files, dirs };
}

export function treeProblems(root, sites) {
  const problems = [];
  const { files, dirs } = walk(root);
  const pkgFile = path.join(root, 'package.json');
  if (!existsSync(pkgFile)) problems.push('package.json is missing');
  else {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    for (const k of ['dependencies', 'devDependencies']) if (k in pkg) problems.push(`package.json has a ${k} key`);
  }
  for (const d of dirs) if (d === 'node_modules' || d.endsWith('/node_modules')) problems.push(`${d} exists`);
  for (const f of files) {
    if (f.startsWith('board/static/') && !['board/static/board.css', 'board/static/board.js'].includes(f)) {
      problems.push(`unexpected file under board/static/: ${f}`);
    }
  }
  for (const f of files) {
    if (sites.includes(f)) continue;
    const text = readFileSync(path.join(root, f), 'latin1').toLowerCase();
    if (text.includes(TITLE)) problems.push(`working title found in ${f}`);
  }
  return problems;
}

const sites = JSON.parse(readFileSync(SITES, 'utf8'));
const problems = treeProblems(ROOT, sites);
const only = (re) => problems.filter((p) => re.test(p));

test('U package.json has no dependencies or devDependencies', () => {
  assert.deepEqual(only(/package\.json/), []);
});

test('U there is no node_modules folder', () => {
  assert.deepEqual(only(/ exists$/), []);
});

test('U board/static holds only board.css and board.js', () => {
  assert.deepEqual(only(/board\/static/), []);
});

test('U the working title appears only in the files listed in name-sites.json', () => {
  assert.deepEqual(only(/working title/), []);
});
