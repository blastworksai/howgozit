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
  const html = renderNotice({ title: 'No settings file found', message: 'Add one.', status: 404 }, { styleNonce: 'noticenonce' });
  assert.equal(count(html, /<title\b/gi), 1);
  assert.ok(html.includes('<title>No settings file found</title>'));
  assert.deepEqual(titles(html), ['No settings file found']);
  assert.equal(product(html), 0);
});

// ---- R177: the greeting's name is one hl element per word for a long name, and the full stop follows U+2060 ----

const h1 = (html) => html.match(/<h1 class="header__title(?: cap)?(?: fit-\d+)?">([\s\S]*?)<\/h1>/)?.[1] ?? null;
const WJ = '&#8288;';

for (const [label, base] of Object.entries(FIXTURES)) {
  test(`R177 a short name is one hl element and the full stop follows the word joiner (${label} page)`, () => {
    const t = h1(page(withName(base, 'Sam')));
    assert.ok(t !== null, 'the page has a header__title h1');
    assert.ok(t.endsWith(`<span class="hl">Sam</span>${WJ}.`), t);
    assert.equal(count(t, /class="hl"/g), 1);
  });

  test(`R177 a name over 14 characters with spaces is one hl element per word, joined by single spaces (${label} page)`, () => {
    const t = h1(page(withName(base, 'Anna Maria Van Der Berg')));
    assert.ok(t !== null);
    const hls = '<span class="hl">Anna</span> <span class="hl">Maria</span> <span class="hl">Van</span> <span class="hl">Der</span> <span class="hl">Berg</span>';
    assert.ok(t.endsWith(`, ${hls}${WJ}.`), t);
    assert.equal(count(t, /class="hl"/g), 5);
  });

  test(`R177 a name over 14 characters with no space is one hl element (${label} page)`, () => {
    const name = 'Wolfeschlegelsteinhausenbergerdorff';
    const t = h1(page(withName(base, name)));
    assert.ok(t !== null);
    assert.ok(t.endsWith(`<span class="hl">${name}</span>${WJ}.`), t);
    assert.equal(count(t, /class="hl"/g), 1);
  });

  test(`R177 the length limit is exact: 14 characters stay one hl element, 15 split (${label} page)`, () => {
    assert.equal('Anna Maria Van'.length, 14);
    assert.equal(count(h1(page(withName(base, 'Anna Maria Van'))), /class="hl"/g), 1);
    assert.equal('Anna Maria Vand'.length, 15);
    assert.equal(count(h1(page(withName(base, 'Anna Maria Vand'))), /class="hl"/g), 3);
  });

  test(`R177 empty words are dropped when a long name is split (${label} page)`, () => {
    const t = h1(page(withName(base, 'Anna  Maria  Van Der')));
    assert.ok(t !== null);
    assert.ok(t.endsWith(`<span class="hl">Anna</span> <span class="hl">Maria</span> <span class="hl">Van</span> <span class="hl">Der</span>${WJ}.`), t);
  });

  test(`R177 every word is escaped inside its hl element (${label} page)`, () => {
    const t = h1(page(withName(base, '<b> and Co of Long')));
    assert.ok(t !== null);
    assert.ok(t.includes('<span class="hl">&lt;b&gt;</span>'), t);
    assert.ok(!t.includes('<b>'), 'no raw angle bracket from the name');
    assert.equal(count(t, /class="hl"/g), 5);
  });
}

test('R177 the greeting text before the name is unchanged and the stop is the last character of the h1', () => {
  const t = h1(page(withName(FULL, 'Sam')));
  assert.ok(t !== null);
  assert.ok(t.startsWith('Good morning, <span class="hl">'), t);
  assert.ok(t.endsWith('.'));
  assert.ok(!t.includes('⁠'), 'the joiner is written as the reference &#8288;, never the raw character');
});

const nonceBlock = (html) => html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i)[1];
const fitRule = (lw, f) => `@media (max-width:480px){.header__title.fit-${lw}{font-size:max(18px,min(40px,calc((100vw - 32px) / ${f})))}}`;

test('R177 a longest word of 35 characters gives class fit-35 on the title and exactly one rule with 23.10 in the nonce block', () => {
  const html = page(withName(FULL, 'Wolfeschlegelsteinhausenbergerdorff'));
  assert.ok(/<h1 class="header__title cap fit-35">/.test(html), 'fit-35 on the h1');
  const rule = fitRule(35, '23.10');
  assert.equal(count(nonceBlock(html), /@media/g), 1, 'one @media in the nonce block');
  assert.equal(nonceBlock(html).split(rule).length - 1, 1, 'exactly the contract rule, once');
  assert.equal(count(html, /\.header__title\.fit-/g), 1);
});

test('R177 the fit rule follows lw: 14 characters give fit-14 and / 9.24; 13 characters and fewer give no class and no rule', () => {
  const t14 = page(withName(FULL, 'Abcdefghijklmn'));
  assert.ok(/<h1 class="header__title cap fit-14">/.test(t14));
  assert.equal(nonceBlock(t14).split(fitRule(14, '9.24')).length - 1, 1);
  for (const name of ['Abcdefghijklm', 'Sam', 'Anna Maria Van Der Berg']) {
    const html = page(withName(FULL, name));
    assert.ok(!/fit-\d+/.test(html), 'no fit- class or rule for ' + name);
    assert.equal(count(html, /@media/g), 0, 'no @media in the page for ' + name);
  }
});

test('R177 lw is the longest hl word as written: a split name takes its longest word', () => {
  const html = page(withName(FULL, 'Ann Wolfeschlegelsteinhausen Berg'));
  assert.ok(/<h1 class="header__title cap fit-24">/.test(html), 'Wolfeschlegelsteinhausen has 24 characters');
  assert.equal(nonceBlock(html).split(fitRule(24, '15.84')).length - 1, 1);
});

test('R177 two pages with different names each hold only their own fit rule', () => {
  const a = page(withName(FULL, 'Wolfeschlegelsteinhausenbergerdorff'));
  const b = page(withName(FULL, 'Abcdefghijklmn'));
  assert.ok(a.includes('.fit-35{') && !a.includes('.fit-14{'));
  assert.ok(b.includes('.fit-14{') && !b.includes('.fit-35{'));
});
