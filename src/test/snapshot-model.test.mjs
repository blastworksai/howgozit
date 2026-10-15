import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normRepo, cardRef, sameRepo, itemRef, shortRef, parseShortRef, goalKey, projectKey, checkSnapshot } from '../board/model/snapshot.mjs';
import { CODES, BackendError, codeOfStatus, VERBS, assertAdapter } from '../board/model/adapter.mjs';
import { checkRaw } from '../board/shape-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = 'Sam-Life/Life';

test('U normRepo lower-cases owner/name and gives empty for non-strings', () => {
  assert.equal(normRepo('Sam-Life/Life'), 'sam-life/life');
  assert.equal(normRepo(null), '');
  assert.equal(normRepo(5), '');
});

test('U sameRepo is case-insensitive and rejects non-strings', () => {
  assert.equal(sameRepo('A/B', 'a/b'), true);
  assert.equal(sameRepo('a/x', 'a/y'), false);
  assert.equal(sameRepo('a/b', undefined), false);
});

test('U cardRef prefers ref, then repo, then the data repo and keeps spelling', () => {
  assert.equal(cardRef({ ref: 'o/r#3', number: 3 }, DATA), 'o/r#3');
  assert.equal(cardRef({ repo: 'Org/Home', number: 4 }, DATA), 'Org/Home#4');
  assert.equal(cardRef({ number: 5 }, DATA), `${DATA}#5`);
  assert.equal(cardRef(null, DATA), null);
});

test('U cardRef of a.x#5 and a/y#5 differ', () => {
  assert.notEqual(cardRef({ repo: 'a/x', number: 5 }, DATA), cardRef({ repo: 'a/y', number: 5 }, DATA));
});

test('U itemRef uses ref, else repo and number, else null', () => {
  assert.equal(itemRef({ ref: 'o/r#1' }), 'o/r#1');
  assert.equal(itemRef({ repo: 'o/r', number: 2 }), 'o/r#2');
  assert.equal(itemRef({ repo: 'o/r' }), null);
  assert.equal(itemRef({ number: 2 }), null);
  assert.equal(itemRef({ repo: null, number: 2 }), null);
  assert.equal(itemRef(undefined), null);
});

test('U shortRef is the bare number in the data repo (any case) and the ref elsewhere', () => {
  assert.equal(shortRef({ number: 7 }, DATA), '7');
  assert.equal(shortRef({ repo: 'sam-life/LIFE', number: 7 }, DATA), '7');
  assert.equal(shortRef({ repo: 'a/x', number: 7 }, DATA), 'a/x#7');
  assert.equal(shortRef({ ref: 'a/x#7', number: 7 }, DATA), 'a/x#7');
  assert.equal(shortRef({ ref: `${DATA}#7`, number: 7 }, DATA), '7');
  assert.equal(shortRef(null, DATA), null);
});

test('U parseShortRef reads a bare number, a full ref and a notion id', () => {
  assert.equal(parseShortRef('5', DATA), `${DATA}#5`);
  assert.equal(parseShortRef('a/b#12', DATA), 'a/b#12');
  const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.equal(parseShortRef(`notion:${hex}`, DATA), `notion:${hex}`);
  const dashed = 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90';
  assert.equal(parseShortRef(`notion:${dashed}`, DATA), `notion:${dashed}`);
});

test('U parseShortRef refuses everything else', () => {
  for (const bad of ['../x#1', 'a/b#0', ' 5', '5abc', '0', '-3', '', 'a/b', 'a/b#', 'a/b#05', 'notion:abc', `notion:${'g'.repeat(32)}`, 'notion:a1b2c3d4e5f60718293a4b5c6d7e8f9', 5, null, undefined, 'a/b#12345678901'])
    assert.equal(parseShortRef(bad, DATA), null, String(bad));
});

test('U goalKey and projectKey lower-case their owner side', () => {
  assert.equal(goalKey('Org/Home', 3), 'org/home|3');
  assert.equal(goalKey('org/home', 3), goalKey('ORG/HOME', 3));
  assert.notEqual(goalKey('a/x', 3), goalKey('a/y', 3));
  assert.equal(projectKey('Sam-Life', 4), 'sam-life#4');
});

test('U checkSnapshot accepts a raw with every optional field right and flags wrong types', () => {
  const raw = JSON.parse(readFileSync(path.join(HERE, '../fixtures/raw/base.json'), 'utf8'));
  raw.source = 'notion';
  raw.repos = [{ repo: 'a/b', private: true, role: 'data' }];
  raw.owners = [{ owner: 'a', ok: true }, { owner: 'b', ok: false, reason: 'auth' }];
  raw.labelColors = { do: '#aabbcc' };
  assert.deepEqual(checkSnapshot(raw).errors, []);
  const bad = structuredClone(raw);
  bad.source = 'gitlab';
  bad.repos = [{ repo: 'nope', private: 'y', role: 'x' }];
  bad.owners = 'a';
  bad.labelColors = { do: 'red' };
  bad.issues[0].repo = 5;
  bad.issues[0].waitingOn = [{ ref: 3 }];
  bad.projects[0].role = 'zzz';
  bad.projects[0].items[0].score = 'high';
  const errs = checkSnapshot(bad).errors;
  for (const k of ['source', 'repos[0].repo', 'repos[0].private', 'repos[0].role', 'owners', 'labelColors.do', 'issues[0].repo', 'issues[0].waitingOn[0].ref', 'projects[0].role', 'projects[0].items[0].score'])
    assert.ok(errs.some((m) => m.startsWith(k)), `${k} in ${errs.join(' | ')}`);
});

test('U checkSnapshot of a non-object reports what checkRaw reports', () => {
  assert.deepEqual(checkSnapshot(null).errors, checkRaw(null).errors);
});

test('U checkSnapshot accepts every raw fixture', () => {
  for (const f of ['base.json', 'hostile.json']) {
    const raw = JSON.parse(readFileSync(path.join(HERE, '../fixtures/raw', f), 'utf8'));
    assert.deepEqual(checkSnapshot(raw).errors, checkRaw(raw).errors, f);
  }
});

test('U codeOfStatus maps every status class to a closed code', () => {
  const table = [[401, 'auth'], [403, 'auth'], [404, 'not-found'], [410, 'not-found'], [422, 'conflict'], [409, 'conflict'], [429, 'rate-limited'], [500, 'unavailable'], [503, 'unavailable'], [undefined, 'unavailable'], [null, 'unavailable'], [400, 'invalid'], [418, 'invalid']];
  for (const [s, c] of table) assert.equal(codeOfStatus(s), c, String(s));
  assert.equal(CODES.length, 6);
  for (const [, c] of table) assert.ok(CODES.includes(c));
});

test('U BackendError carries code, status and message', () => {
  const e = new BackendError('auth', 401, 'no');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'BackendError');
  assert.equal(e.code, 'auth');
  assert.equal(e.status, 401);
  assert.equal(e.message, 'no');
});

test('U assertAdapter names the first missing verb and a bad kind', () => {
  const ok = { kind: 'github', ...Object.fromEntries(VERBS.map((v) => [v, () => {}])) };
  assert.equal(assertAdapter(ok), ok);
  assert.deepEqual(VERBS, ['read', 'logIdea', 'setCheckin', 'fileIdea', 'closeCard', 'setScore']);
  const { setCheckin, closeCard, ...partial } = ok;
  assert.throws(() => assertAdapter(partial), /setCheckin/);
  assert.throws(() => assertAdapter({ ...ok, kind: 'gitlab' }), /kind/);
  assert.throws(() => assertAdapter(null), Error);
});

function mjsUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? mjsUnder(path.join(dir, d.name)) : d.name.endsWith('.mjs') ? [path.join(dir, d.name)] : []));
}

test('R150 no stage or render module imports from board/github or board/notion', () => {
  const files = [...mjsUnder(path.join(HERE, '../board/stages')), ...mjsUnder(path.join(HERE, '../board/render'))];
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const specs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specs) assert.ok(!s.includes('/github/') && !s.includes('/notion/'), `${f} imports ${s}`);
  }
});

test('R129 a bare number is a data-repo card and a full ref is not', () => {
  const dataCard = { repo: DATA, number: 5 };
  const homeCard = { repo: 'Org/Home', number: 5 };
  assert.equal(shortRef(dataCard, DATA), '5');
  assert.equal(shortRef(homeCard, DATA), 'Org/Home#5');
  assert.equal(parseShortRef(shortRef(dataCard, DATA), DATA), cardRef(dataCard, DATA));
  assert.equal(parseShortRef(shortRef(homeCard, DATA), DATA), cardRef(homeCard, DATA));
  assert.notEqual(parseShortRef(shortRef(dataCard, DATA), DATA), parseShortRef(shortRef(homeCard, DATA), DATA));
});
