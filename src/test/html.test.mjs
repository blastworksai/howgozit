import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, githubHref } from '../board/html.mjs';

test('U esc turns the five characters into entities', () => {
  assert.equal(esc('&'), '&amp;');
  assert.equal(esc('<'), '&lt;');
  assert.equal(esc('>'), '&gt;');
  assert.equal(esc('"'), '&quot;');
  assert.equal(esc("'"), '&#39;');
});

test('U esc leaves no raw angle bracket or quote from a hostile payload', () => {
  const out = esc('"><script>alert(1)</script>&\'');
  for (const c of ['<', '>', '"', "'"]) assert.ok(!out.includes(c), `raw ${c} in ${out}`);
  assert.ok(out.includes('&lt;script&gt;'));
});

test('U esc gives empty text for null and undefined and stringifies the rest', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
  assert.equal(esc(42), '42');
});

test('U githubHref returns a good GitHub address unchanged', () => {
  const u = 'https://github.com/sam-life/life/issues/12';
  assert.equal(githubHref(u), u);
});

test('U githubHref refuses every address that is not plainly GitHub', () => {
  const bad = [
    'http://github.com/x',
    'https://github.com.evil.example/x',
    'javascript:alert(1)',
    ' https://github.com/x',
    'https://github.com/x y',
    'https://github.com/x\n',
    'https://github.com/x\u0000',
    'https://github.com/x"onmouseover="1',
    "https://github.com/x'",
    'https://github.com/<x',
    'https://github.com/x>',
    '',
    null,
    undefined,
    42,
    {},
  ];
  for (const b of bad) assert.equal(githubHref(b), null, String(b));
});
