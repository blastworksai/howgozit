// Runs the checks for named contract rules and fails when a named rule has no test.
// Usage: node scripts/rules.mjs 17 R18 S3 R1-R52 1-52 S1-S8 [--dir <test folder>] [--contract <file>]
// With no IDs it runs every test and still checks every test name.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC_ROOT = path.resolve(HERE, '..');
export const DEFAULT_TEST_DIR = path.join(SRC_ROOT, 'test');
export const DEFAULT_CONTRACT = path.join(SRC_ROOT, 'references', 'contract.md');

export const NAME_OK = /^(R\d+|S\d+|U) /;
const TEST_CALL = /\btest(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

// Rules that have tests: R1 to R150 and S1 to S8 (S9 and the V lines have none).
export function contractRules(text) {
  const ids = new Set();
  for (const m of text.matchAll(/^\*\*R(\d+)\. /gm)) if (Number(m[1]) <= 150) ids.add('R' + m[1]);
  for (const m of text.matchAll(/^\*\*S(\d+)\.\*\*/gm)) if (Number(m[1]) <= 8) ids.add('S' + m[1]);
  return ids;
}

export function testFilesIn(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f));
}

// Every test name written as a plain string literal, with the file it is in.
export function testNamesIn(dir) {
  const out = [];
  for (const file of testFilesIn(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(TEST_CALL)) out.push({ file: path.basename(file), name: m[2] });
  }
  return out;
}

export function idOf(name) {
  const m = /^(R\d+|S\d+)\b/.exec(name);
  return m ? m[1] : null;
}

// Problems with names: badly named, or naming a rule the contract does not have.
export function nameProblems(entries, known) {
  const problems = [];
  for (const { file, name } of entries) {
    if (!NAME_OK.test(name)) {
      problems.push(`badly named test in ${file}: "${name}" (must start with R<n>, S<n> or U and a space)`);
      continue;
    }
    const id = idOf(name);
    if (id && !known.has(id)) problems.push(`unknown rule ${id} in ${file}: "${name}"`);
  }
  return problems;
}

export function parseIds(args) {
  const ids = [];
  const bad = [];
  for (const a of args) {
    let m = /^(R|S)?(\d+)-(R|S)?(\d+)$/i.exec(a);
    if (m) {
      const p = (m[1] || 'R').toUpperCase();
      const q = (m[3] || p).toUpperCase();
      const lo = Number(m[2]);
      const hi = Number(m[4]);
      if (p !== q || lo > hi) { bad.push(a); continue; }
      for (let i = lo; i <= hi; i++) ids.push(p + i);
      continue;
    }
    m = /^(R|S)?(\d+)$/i.exec(a);
    if (m) { ids.push((m[1] || 'R').toUpperCase() + Number(m[2])); continue; }
    bad.push(a);
  }
  return { ids: [...new Set(ids)], bad };
}

function main(argv) {
  let dir = DEFAULT_TEST_DIR;
  let contract = DEFAULT_CONTRACT;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--contract') contract = path.resolve(argv[++i] ?? '');
    else rest.push(argv[i]);
  }
  const failures = [];
  const { ids, bad } = parseIds(rest);
  for (const b of bad) failures.push(`cannot read rule id "${b}"`);

  let known;
  try { known = contractRules(readFileSync(contract, 'utf8')); }
  catch { console.error(`cannot read the contract at ${contract}`); return 1; }

  let entries = [];
  let files = [];
  try { entries = testNamesIn(dir); files = testFilesIn(dir); }
  catch { console.error(`cannot read the test folder ${dir}`); return 1; }

  failures.push(...nameProblems(entries, known));
  for (const id of ids) {
    if (!known.has(id)) failures.push(`unknown rule ${id}`);
    else if (!entries.some((e) => e.name.startsWith(id + ' '))) failures.push(`no test for ${id}`);
  }
  if (files.length === 0) failures.push('no test files found');

  if (files.length) {
    const args = ['--test', '--test-reporter=tap'];
    for (const id of ids) args.push('--test-name-pattern', `^${id} `);
    args.push(...files);
    const r = spawnSync(process.execPath, args, { cwd: SRC_ROOT, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    const notOk = out.split(/\r?\n/).filter((l) => /^\s*not ok /.test(l));
    for (const l of notOk) failures.push('failed: ' + l.trim());
    if (r.error) failures.push('could not start the test runner: ' + r.error.message);
    else if (r.status !== 0 && notOk.length === 0) failures.push(`test runner exited with status ${r.status}`);
    const pass = out.split(/\r?\n/).find((l) => /^# pass /.test(l));
    const fail = out.split(/\r?\n/).find((l) => /^# fail /.test(l));
    console.log(`${pass ?? '# pass ?'}  ${fail ?? '# fail ?'}`);
  }

  if (failures.length) {
    for (const f of failures) console.error('FAIL ' + f);
    return 1;
  }
  console.log('ok');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
