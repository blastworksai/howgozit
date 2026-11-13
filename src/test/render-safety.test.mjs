// Output-safety checks of the board contract: escaping, links, no inline code, no colours
// outside the theme, the static script. Written before the renderer exists.
//
// Markup these tests require (and nothing more):
//  - every section's outer element has data-section="<name>" (double quotes)
//  - links are written as href="..." with double quotes, and no other quoting style is used for href
//  - a board page holds one <script src="/static/board.js"></script> with nothing between the tags;
//    a notice page holds no script (R172) and one nonce <style> block
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
const GOOGLE = resolveTheme({ fonts: { source: 'google' } }).theme;
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

test('R74 every href of the full page is GitHub or the stylesheet, and with the default theme (system fonts, R84) no font stylesheet', () => {
  const html = render(FULL);
  const all = hrefs(html);
  assert.equal(hrefAttrCount(html), all.length, 'every href is double-quoted');
  assert.ok(all.length > 0);
  for (const h of all) {
    const ok = h.startsWith('https://github.com/') || h === '/static/board.css';
    assert.ok(ok, 'unexpected href ' + h);
  }
  assert.ok(all.some((h) => h.startsWith('https://github.com/')), 'a GitHub link is present');
  assert.ok(all.includes('/static/board.css'), 'the stylesheet link is present');
  assert.ok(!all.some((h) => h.includes('fonts.googleapis.com')), 'no font link with the default theme');
});

test('R74 with google fonts the page links GitHub, its stylesheet and the one font stylesheet, and nothing else', () => {
  const html = render(FULL, GOOGLE);
  const all = hrefs(html);
  assert.equal(hrefAttrCount(html), all.length, 'every href is double-quoted');
  for (const h of all) {
    const ok = h.startsWith('https://github.com/') || h === '/static/board.css' || h.startsWith('https://fonts.googleapis.com/css2?');
    assert.ok(ok, 'unexpected href ' + h);
  }
  assert.equal(all.filter((h) => h.startsWith('https://fonts.googleapis.com/css2?')).length, 1, 'one font link');
  assert.ok(!all.includes('/skin/skin.css'), 'no skin link without a skin (R171)');
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
  const html = render(FULL, GOOGLE);
  assert.equal(count(html, /https:\/\/fonts\.googleapis\.com\/css2/g), 1);
});

const STACK_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const STACK_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const rootRule = (html) => html.match(/<style\b[^>]*>\s*:root\{([^}]*)\}/)?.[1] ?? '';

test('R84 given no theme file the page makes no outside request and the three font variables are the system stacks', () => {
  const html = render(FULL, THEME);
  const urls = html.match(/https:\/\/[^\s"'<>]*/g) || [];
  for (const u of urls) assert.ok(u.startsWith('https://github.com/'), 'outside address ' + u);
  assert.equal(count(html, /fonts\.googleapis|fonts\.gstatic/g), 0);
  const root = rootRule(html);
  assert.ok(root.includes('--font-heading:' + STACK_SANS + ';'), 'heading stack');
  assert.ok(root.includes('--font-body:' + STACK_SANS + ';'), 'body stack');
  assert.ok(root.includes('--font-mono:' + STACK_MONO + ';'), 'mono stack');
});

test('R84 given google fonts each variable is the family in double quotes, a comma and that role\'s system stack', () => {
  const root = rootRule(render(FULL, GOOGLE));
  assert.ok(root.includes('--font-heading:"Bricolage Grotesque", ' + STACK_SANS + ';'), 'heading');
  assert.ok(root.includes('--font-body:"Geist", ' + STACK_SANS + ';'), 'body');
  assert.ok(root.includes('--font-mono:"Geist Mono", ' + STACK_MONO + ';'), 'mono');
});

test('R82 given no theme file the page holds the thirteen default colours and --radius:20px', () => {
  const root = rootRule(render(FULL, THEME));
  const WANT = {
    ground: '#131415', dot: '#2C2E30', card: '#1F2123', border: '#38393C', ink: '#ECEDED', muted: '#A9ACAF', faint: '#93979A',
    'agent-bg': '#2C3A3C', 'agent-ink': '#EAF2F2', accent: '#4FD1B5', hot: '#EF6A52', 'hot-ink': '#FF9C88', ok: '#5FCB8A',
  };
  for (const [k, v] of Object.entries(WANT)) {
    const m = root.match(new RegExp('--' + k + ':([^;]*);'));
    assert.ok(m, '--' + k + ' is in the page');
    assert.equal(m[1].toLowerCase(), v.toLowerCase(), '--' + k);
  }
  assert.ok(root.includes('--radius:20px;'));
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
    // R83: a numeric character reference is not a colour; remove every one (the &#8288; of R177) before the check.
    const text = readFileSync(f, 'utf8').replace(/&#(?:[0-9]+|[xX][0-9a-fA-F]+);/g, '');
    assert.equal(count(text, /#[0-9a-fA-F]{3,8}/g), 0, 'hex colour in ' + f);
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
  const html = renderNotice({ title: 'Plain title ' + P, message: 'Plain message ' + P, status: 503 }, NOTICE_OPTS);
  assert.equal(typeof html, 'string');
  assert.ok(html.includes('Plain title') && html.includes('Plain message'));
  assert.ok(count(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) >= 2, 'payload escaped in title and message');
  assert.equal(count(html, /<script>alert\(1\)/gi), 0);
  assert.equal(count(html, /data-section/g), 0);
});

const NOTICE_OPTS = { styleNonce: 'noticenonce' };
const noticePage = (status = 404) => renderNotice({ title: 'No settings file found', message: 'Add one.', status }, NOTICE_OPTS);

test('R77 a notice page carries no script, no style attribute, no event attribute and one nonce style block', () => {
  const html = noticePage();
  assert.equal(count(html, /<script\b/gi), 0, 'a notice page has no script (R172)');
  assert.equal(count(html, /style="/g), 0);
  for (const tag of tagsOf(html)) {
    assert.ok(!/\sstyle\s*=/i.test(tag), 'style attribute in ' + tag);
    assert.ok(!/\son[a-z]+\s*=/i.test(tag), 'event attribute in ' + tag);
  }
  assert.equal(count(html, /<style\b/gi), 1, 'exactly one <style');
  assert.match(html.match(/<style\b[^>]*>/i)[0], /\snonce="noticenonce"/);
});

test('R172 a notice page has the head: charset, viewport, title, board stylesheet, then the one nonce style block with the default variables only', () => {
  const html = noticePage();
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(!html.includes('data-skin') && !html.includes('/skin/'), 'no skin without a skin');
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };
  const order = [at('<meta charset="utf-8">'), at('<meta name="viewport"'), at('<title>No settings file found</title>'), at('<link rel="stylesheet" href="/static/board.css">'), at('<style nonce="noticenonce">')];
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'head order');
  assert.deepEqual(hrefs(html), ['/static/board.css']);
  const style = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i)[1].trim();
  assert.match(style, /^:root\{[^{}]*\}$/, 'one :root rule and nothing else');
  const names = [...style.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['--accent', '--agent-bg', '--agent-ink', '--border', '--card', '--dot', '--faint', '--font-body', '--font-heading', '--font-mono', '--ground', '--hot', '--hot-ink', '--ink', '--muted', '--ok', '--on-accent', '--radius']);
  assert.match(style, /--ground:#131415;/i, 'default ground');
  assert.ok(style.includes('--font-body:' + STACK_SANS + ';'), 'system stacks, so no font host');
  assert.equal(count(html, /fonts\.googleapis|fonts\.gstatic/g), 0);
});

test('R172 a notice page is the emp block: four fixings, a lab line with a pad by status, a cap headline, the message', () => {
  const warn = noticePage(404);
  assert.ok(warn.includes('<main class="notice"><div class="emp emp--block"><span class="fix fix--tl"></span><span class="fix fix--tr"></span><span class="fix fix--bl"></span><span class="fix fix--br"></span>'));
  assert.ok(warn.includes('<p class="lab"><span class="pad warn"></span></p><h1 class="bk-h cap">No settings file found</h1><p>Add one.</p></div></main>'));
  assert.ok(noticePage(503).includes('<p class="lab"><span class="pad err"></span></p>'), 'status 500 and above gets the err pad');
  assert.ok(noticePage(500).includes('<span class="pad err">'));
  assert.ok(noticePage(499).includes('<span class="pad warn">'));
});
