import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractRules, testNamesIn, nameProblems, idOf, DEFAULT_CONTRACT, DEFAULT_TEST_DIR } from '../scripts/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Environment overrides exist only so the check can be proved against a temp folder.
const contractPath = process.env.COVERAGE_CONTRACT || DEFAULT_CONTRACT;
const testDir = process.env.COVERAGE_TEST_DIR || DEFAULT_TEST_DIR;
const pendingPath = process.env.COVERAGE_PENDING || path.join(HERE, 'pending-rules.json');

export function coverageProblems({ contractText, entries, pending }) {
  const known = contractRules(contractText);
  const problems = [...nameProblems(entries, known)];
  const have = new Set(entries.map((e) => idOf(e.name)).filter(Boolean));
  for (const id of known) {
    if (!have.has(id) && !pending.includes(id)) problems.push(`no test for ${id}`);
  }
  for (const id of pending) {
    if (!known.has(id)) problems.push(`pending-rules.json lists unknown rule ${id}`);
  }
  return problems;
}

const contractText = readFileSync(contractPath, 'utf8');
const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
const entries = testNamesIn(testDir);

test('U the contract headings give R1 to R156 and S1 to S8', () => {
  const known = contractRules(contractText);
  for (let i = 1; i <= 156; i++) assert.ok(known.has('R' + i), `R${i} missing from the contract`);
  for (let i = 1; i <= 8; i++) assert.ok(known.has('S' + i), `S${i} missing from the contract`);
  assert.equal(known.size, 164);
});

test('U every rule has a test unless it is listed as pending', () => {
  const problems = coverageProblems({ contractText, entries, pending }).filter((p) => p.startsWith('no test for'));
  assert.deepEqual(problems, []);
});

test('U no test is badly named or names a rule the contract does not have', () => {
  const problems = coverageProblems({ contractText, entries, pending }).filter((p) => !p.startsWith('no test for') && !p.startsWith('pending-rules'));
  assert.deepEqual(problems, []);
});

test('U pending-rules.json lists only rules the contract has', () => {
  const problems = coverageProblems({ contractText, entries, pending }).filter((p) => p.startsWith('pending-rules'));
  assert.deepEqual(problems, []);
});
