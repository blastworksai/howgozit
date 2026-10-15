// R86 tab title: the person's name then the product name; the product name nowhere else;
// a notice page's tab title is its own heading and nothing more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPage, renderNotice } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const loadJson = (rel) => JSON.parse(readFileSync(here(rel), 'utf8'));

const FULL = loadJson('../fixtures/board/page.board.json');
const MIN = loadJson('../fixtures/board/page-min.board.json');
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };

const DOT = '·';
const PRODUCT = 'Howgozit';
const FIXTURES = { full: FULL, minimal: MIN };

function withName(base, name, mode = 'set') {
  const b = structuredClone(base);
  b.meta = b.meta || {};
  if (mode === 'delete') delete b.meta.name;
  else b.meta.name = name;
  return b;
}
const page = (b) => renderPage(b, THEME, OPTS);
const titles = (html) => [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1]);
const count = (s, re) => (s.match(re) || []).length;
const product = (s) => count(s, /howgozit/gi);

for (const [label, base] of Object.entries(FIXTURES)) {
  test(`R86 the tab title is the name then the product name (${label} page)`, () => {
    const html = page(withName(base, 'Sam'));
    assert.equal(count(html, /<title\b/gi), 1);
    assert.deepEqual(titles(html), [`Sam ${DOT} ${PRODUCT}`]);
  });

  test(`R86 the product name appears exactly once on the page (${label} page, name Sam)`, () => {
    assert.equal(product(page(withName(base, 'Sam'))), 1);
  });

  test(`R86 a missing name gives the product name alone (${label} page)`, () => {
    const html = page(withName(base, undefined, 'delete'));
    assert.equal(count(html, /<title\b/gi), 1);
    assert.ok(html.includes(`<title>${PRODUCT}</title>`), 'expected <title>Howgozit</title>');
    assert.equal(product(html), 1);
  });

  test(`R86 an empty name gives the product name alone (${label} page)`, () => {
    const html = page(withName(base, ''));
    assert.equal(count(html, /<title\b/gi), 1);
    assert.ok(html.includes(`<title>${PRODUCT}</title>`), 'expected <title>Howgozit</title>');
    assert.equal(product(html), 1);
  });

  test(`R86 a hostile name is escaped inside the title (${label} page)`, () => {
    const hostile = `"><script>alert(1)</script>&'`;
    const html = page(withName(base, hostile));
    assert.equal(count(html, /<title\b/gi), 1);
    const t = titles(html)[0] ?? '';
    assert.ok(!t.includes('<script>'), 'raw script tag inside the title');
    assert.ok(!t.includes('<') && !t.includes('>'), 'raw angle bracket inside the title');
    assert.equal(
      t,
      `&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39; ${DOT} ${PRODUCT}`,
    );
    assert.equal(product(html), 1);
  });

  test(`R86 the old tab word is gone (${label} page)`, () => {
    for (const name of ['Sam', '']) {
      const t = titles(page(withName(base, name)))[0] ?? '';
      assert.notEqual(t, 'Board');
      assert.ok(!t.endsWith(`${DOT} Board`), 'title still ends in the old tab word');
    }
  });
}

test('R86 a notice page titles itself with its own heading and nothing more', () => {
  const html = renderNotice({ title: 'No settings file found', message: 'Add one.', status: 404 });
  assert.equal(count(html, /<title\b/gi), 1);
  assert.ok(html.includes('<title>No settings file found</title>'));
  assert.deepEqual(titles(html), ['No settings file found']);
  assert.equal(product(html), 0);
});
