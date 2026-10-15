// Output-safety checks of the board contract: escaping, links, no inline code, no colours
// outside the theme, the static script. Written before the renderer exists.
//
// Markup these tests require (and nothing more):
//  - every section's outer element has data-section="<name>" (double quotes)
//  - links are written as href="..." with double quotes, and no other quoting style is used for href
//  - the page holds one <script src="/static/board.js"></script> with nothing between the tags
//  - the page holds one <style nonce="testnonce"> element
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPage, renderNotice } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { board, settings, raw, state, task, project, resetNumbers } from '../fixtures/build.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const loadJson = (rel) => JSON.parse(readFileSync(here(rel), 'utf8'));

const FULL = loadJson('../fixtures/board/page.board.json');
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const render = (b, theme = THEME) => renderPage(b, theme, OPTS);
const count = (s, re) => (s.match(re) || []).length;

const PAYLOAD_ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;';
const SIXTEEN = [
  'header', 'capture', 'brief', 'season', 'focus', 'timeline', 'calendar', 'inbox',
  'next', 'habits', 'heatmap', 'projects', 'log', 'ideas', 'standalone', 'footer',
];

function sectionNames(html) {
  return [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
}
function cut(html) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({
    name: m[1],
    start: html.lastIndexOf('<', m.index),
  }));
  const out = {};
  marks.forEach((m, i) => {
    out[m.name] = html.slice(m.start, i + 1 < marks.length ? marks[i + 1].start : html.length);
  });
  return out;
}
// A section by name; fails with an assertion when the page has no such section.
function need(sections, name) {
  assert.ok(typeof sections[name] === 'string', 'section ' + name + ' is missing');
  return sections[name];
}
// Every href attribute value (double-quoted) in the html, and how many href attributes exist at all.
const hrefs = (html) => [...html.matchAll(/\shref\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
const hrefAttrCount = (html) => count(html, /\shref\s*=/gi);
const tagsOf = (html) => html.match(/<[a-zA-Z][^>]*>/g) || [];

function hostileBoard() {
  const s = {};
  for (const k of ['brief', 'calendar', 'inbox', 'log', 'proposals']) s[k] = loadJson('../fixtures/state/hostile/' + k + '.json');
  return board({
    raw: loadJson('../fixtures/raw/hostile.json'),
    settings: loadJson('../fixtures/settings/hostile.json'),
    state: s,
  });
}

test('R73 the hostile fixtures render all sixteen sections with the payload escaped', () => {
  const html = render(hostileBoard());
  assert.deepEqual(sectionNames(html), SIXTEEN);
  assert.ok(count(html, new RegExp(PAYLOAD_ESCAPED.replace(/[()/]/g, '\\$&'), 'g')) >= 20, 'at least twenty escaped copies');
  assert.equal(count(html, /<script>alert\(1\)/gi), 0, 'no raw payload script');
  assert.equal(count(html, /<script\b/gi), 1, 'only the board script tag');
});

test('R73 the same page without hostile data has no escaped payload (so the count means something)', () => {
  const html = render(FULL);
  assert.equal(count(html, /&lt;script&gt;/g), 0);
  assert.equal(count(html, /<script\b/gi), 1);
  assert.deepEqual(sectionNames(html), SIXTEEN);
});

function nextBoard() {
  resetNumbers();
  const tasks = [
    task({ title: 'Seat alpha', html_url: 'javascript:alert(1)' }),
    task({ title: 'Seat beta', html_url: 'http://github.com/x' }),
    task({ title: 'Seat gamma', html_url: 'https://github.com.evil.example/x' }),
    task({ title: 'Seat delta', html_url: 'https://github.com/sam-life/life/issues/4' }),
  ];
  return board({
    raw: raw({ issues: tasks, projects: [project(3, 'House', [1, 2, 3, 4])] }),
    settings: settings({ projects: [{ key: 'house', number: 3 }], focus: ['house'] }),
  });
}

test('R74 only addresses starting https://github.com/ become links in What\'s next', () => {
  const b = nextBoard();
  assert.equal(b.next.length, 4, 'the built board has four seats');
  const html = render(b);
  const next = need(cut(html), 'next');
  for (const t of ['Seat alpha', 'Seat beta', 'Seat gamma', 'Seat delta']) assert.ok(next.includes(t), t + ' is shown');
  const all = hrefs(html);
  for (const bad of ['javascript:alert(1)', 'http://github.com/x', 'https://github.com.evil.example/x']) {
    assert.ok(!all.some((h) => h.includes(bad)), 'no href holds ' + bad);
  }
  assert.ok(!/javascript:/i.test(all.join('\n')));
  assert.equal(hrefAttrCount(html), all.length, 'every href is double-quoted');
});

test('R74 a good GitHub address on a seat does get an href', () => {
  const html = render(nextBoard());
  assert.ok(hrefs(need(cut(html), 'next')).some((h) => h === 'https://github.com/sam-life/life/issues/4'));
});

test('R74 every href of the full page is GitHub, the stylesheet or the font stylesheet', () => {
  const html = render(FULL);
  const all = hrefs(html);
  assert.equal(hrefAttrCount(html), all.length, 'every href is double-quoted');
  assert.ok(all.length > 0);
  for (const h of all) {
    const ok = h.startsWith('https://github.com/') || h === '/static/board.css' || h.startsWith('https://fonts.googleapis.com/css2?');
    assert.ok(ok, 'unexpected href ' + h);
  }
  assert.ok(all.some((h) => h.startsWith('https://github.com/')), 'a GitHub link is present');
  assert.ok(all.includes('/static/board.css'), 'the stylesheet link is present');
  assert.ok(all.some((h) => h.startsWith('https://fonts.googleapis.com/css2?')), 'the font link is present');
});

function stateBoard() {
  return board({
    raw: raw(),
    settings: settings(),
    state: state({
      brief: { generated: '2026-10-12T06:00:00+02:00', lines: [{ src: 'CAL', text: 'See https://evil.example/x-brief today.' }] },
      calendar: { date: '2026-10-12', events: [{ title: 'Call https://evil.example/x-cal', start: '08:30', end: '08:45', kind: 'meeting' }] },
      inbox: {
        updated: '2026-10-12T07:45:00+02:00',
        counts: { reply: 2, decide: 0, fyi: 0 },
        threads: [
          { bucket: 'reply', from: 'Accountant', subject: 'Open https://evil.example/x-subject', why: 'Read https://evil.example/x-why', draft: true },
          { bucket: 'reply', from: 'Alex', subject: 'Saturday plans', why: 'Waiting on your answer', draft: false },
        ],
      },
      log: [{ t: '06:00', agent: 'brief-agent', what: 'Fetched https://evil.example/x-log' }],
    }),
  });
}

test('R53 a URL in a state file stays text and never becomes a link', () => {
  const b = stateBoard();
  for (const k of ['brief', 'calendar', 'inbox', 'log']) assert.ok(b.panels[k] && !b.panels[k].error, k + ' panel is on');
  const html = render(b);
  for (const m of ['x-brief', 'x-cal', 'x-subject', 'x-why', 'x-log']) {
    assert.ok(html.includes('https://evil.example/' + m), 'the text ' + m + ' still shows');
  }
  assert.ok(!hrefs(html).some((h) => h.includes('evil.example')), 'no href holds evil.example');
  assert.ok(hrefAttrCount(html) === hrefs(html).length);
  const s = cut(html);
  for (const sec of ['brief', 'calendar', 'inbox', 'log']) assert.equal(count(need(s, sec), /\shref\s*=/gi), 0, sec + ' holds no link');
});

test('R53 a draft thread shows "Draft ready" and no anchor; a non-draft thread does not', () => {
  const html = render(stateBoard());
  const inbox = need(cut(html), 'inbox');
  assert.equal(count(inbox, /Draft ready/g), 1, 'one badge for one draft thread');
  assert.equal(count(inbox, /<a[\s>]/gi), 0, 'no anchor in the inbox');
  assert.ok(inbox.includes('Saturday plans') && inbox.includes('Open https://evil.example/x-subject'));
});

test('R77 the full page carries no style attribute, no event attribute, one script and one nonce style', () => {
  checkNoInlineCode(render(FULL));
});

test('R77 the hostile page carries no style attribute, no event attribute, one script and one nonce style', () => {
  checkNoInlineCode(render(hostileBoard()));
});

function checkNoInlineCode(html) {
  assert.ok(sectionNames(html).length >= 8, 'a real page, not an empty string');
  assert.equal(count(html, /style="/g), 0, 'no style="');
  for (const tag of tagsOf(html)) {
    assert.ok(!/\sstyle\s*=/i.test(tag), 'style attribute in ' + tag);
    assert.ok(!/\son[a-z]+\s*=/i.test(tag), 'event attribute in ' + tag);
  }
  assert.equal(count(html, /<script\b/gi), 1, 'exactly one <script');
  const m = html.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
  assert.ok(m, 'the script element is closed');
  assert.equal(m[2], '', 'no content between the script tags');
  assert.equal(/\ssrc\s*=\s*"([^"]*)"/i.exec(m[1])?.[1], '/static/board.js');
  assert.equal(count(html, /<style\b/gi), 1, 'exactly one <style');
  const st = html.match(/<style\b[^>]*>/i)[0];
  assert.match(st, /\snonce="testnonce"/);
}

test('R84 fonts.source system leaves no outside font address in the page', () => {
  const sys = resolveTheme({ fonts: { source: 'system' } }).theme;
  const html = render(FULL, sys);
  assert.ok(sectionNames(html).length >= 8, 'a real page');
  assert.equal(count(html, /https:\/\/fonts\./g), 0);
  const urls = html.match(/https:\/\/[^\s"'<>]*/g) || [];
  for (const u of urls) assert.ok(u.startsWith('https://github.com/'), 'outside address ' + u);
  assert.ok(urls.length > 0, 'GitHub links are still there');
});

test('R84 fonts.source google links the font stylesheet', () => {
  const html = render(FULL, THEME);
  assert.ok(count(html, /https:\/\/fonts\.googleapis\.com\/css2/g) >= 1);
});

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('R83 no colour is written in the stylesheet or the render folder', () => {
  const cssPath = here('../board/static/board.css');
  let mjs = [];
  try {
    mjs = walk(here('../board/render')).filter((p) => p.endsWith('.mjs'));
  } catch (e) {
    assert.fail('board/render is missing: ' + e.code);
  }
  assert.ok(mjs.length >= 4, 'at least four .mjs files in board/render, found ' + mjs.length);
  const files = [cssPath, ...mjs];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.equal(count(text, /#[0-9a-fA-F]{3,8}\b/g), 0, 'hex colour in ' + f);
    assert.equal(count(text, /\b(?:rgb|rgba|hsl|hsla)\(/gi), 0, 'colour function in ' + f);
  }
});

test('R83 every colour declaration in the stylesheet uses a variable or a keyword', () => {
  const css = readFileSync(here('../board/static/board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /(?:^|[;{\s])(color|background|background-color|border-color|fill|stroke|outline-color)\s*:\s*([^;}]+)/g;
  let n = 0;
  for (const m of css.matchAll(re)) {
    n++;
    const value = m[2].replace(/!important/i, '').trim();
    const ok = value.includes('var(') || /^(none|transparent|currentcolor|inherit)$/i.test(value);
    assert.ok(ok, m[1] + ': ' + value);
  }
  assert.ok(n > 5, 'the stylesheet does declare colours (found ' + n + ')');
});

test('R95 the static script has no eval, Function(, document.write, innerHTML or outside address', () => {
  const js = readFileSync(here('../board/static/board.js'), 'utf8');
  assert.ok(js.length > 200, 'the script is not empty');
  assert.ok(!/\beval\b/.test(js), 'eval');
  assert.ok(!js.includes('Function('), 'Function(');
  assert.ok(!js.includes('document.write'), 'document.write');
  assert.ok(!js.includes('innerHTML'), 'innerHTML');
  assert.ok(!js.includes('http:'), 'http:');
  assert.ok(!js.includes('https:'), 'https:');
  assert.ok(!js.includes('//'), '//');
});

test('U renderNotice returns a small escaped page with no board section', () => {
  const P = '"><script>alert(1)</script>&\'';
  const html = renderNotice({ title: 'Plain title ' + P, message: 'Plain message ' + P, status: 503 });
  assert.equal(typeof html, 'string');
  assert.ok(html.includes('Plain title') && html.includes('Plain message'));
  assert.ok(count(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) >= 2, 'payload escaped in title and message');
  assert.equal(count(html, /<script>alert\(1\)/gi), 0);
  assert.equal(count(html, /data-section/g), 0);
});
