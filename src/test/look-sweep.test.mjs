// A sweep over every page the fixtures produce, for the look of the signed board (frozen part map
// 4-howgozit/PART-MAP.md, sections C3, D and F4): the frame classes on every section's outer element, no
// `style=` and no `on...=` attribute, the script rule, no removed class anywhere, one 480px block.
// Written before the renderer and the stylesheet follow it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPage, renderNotice } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const loadJson = (rel) => JSON.parse(readFileSync(here(rel), 'utf8'));
const FULL = loadJson('../fixtures/board/page.board.json');
const MIN = loadJson('../fixtures/board/page-min.board.json');
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const CSS = readFileSync(here('../board/static/board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const copy = (b) => JSON.parse(JSON.stringify(b));
const count = (s, re) => (s.match(re) || []).length;

const staleBoard = () => {
  const b = copy(FULL);
  b.meta.stale = { since: '2026-10-12T05:00:00Z', reason: 'GitHub did not answer' };
  for (const k of ['brief', 'calendar', 'inbox', 'log']) if (b.panels?.[k]) b.panels[k].stale = true;
  return b;
};
const readOnlyBoard = () => {
  const b = copy(FULL);
  b.meta.readOnly = true;
  return b;
};
const errorBoard = () => {
  const b = copy(FULL);
  for (const k of ['brief', 'calendar', 'inbox', 'log']) if (b.panels?.[k]) b.panels[k] = { error: true };
  return b;
};

const BOARD_PAGES = {
  'page.board.json': () => renderPage(FULL, THEME, OPTS),
  'page-min.board.json': () => renderPage(MIN, THEME, OPTS),
  'a stale board': () => renderPage(staleBoard(), THEME, OPTS),
  'a read-only board': () => renderPage(readOnlyBoard(), THEME, OPTS),
  'a board with four unreadable panels': () => renderPage(errorBoard(), THEME, OPTS),
};
const NOTICE_PAGES = {
  'a notice (404)': () => renderNotice({ title: 'No settings file found', message: 'Add one.', status: 404 }, { styleNonce: 'testnonce' }),
  'a notice (503)': () => renderNotice({ title: 'The board could not start', message: 'Try again.', status: 503 }, { styleNonce: 'testnonce' }),
};
const ALL_PAGES = { ...BOARD_PAGES, ...NOTICE_PAGES };

// The outer element of every section: tag name, class tokens, the text right after its opening tag.
function sections(html) {
  const out = [];
  for (const m of html.matchAll(/data-section="([^"]+)"/g)) {
    const start = html.lastIndexOf('<', m.index);
    const end = html.indexOf('>', m.index) + 1;
    const tag = html.slice(start, end);
    out.push({
      name: m[1],
      tag,
      el: /^<([a-z0-9]+)/i.exec(tag)[1],
      classes: ((/\sclass="([^"]*)"/.exec(tag) || [])[1] || '').split(/\s+/).filter(Boolean),
      after: html.slice(end),
    });
  }
  return out;
}

// The twelve framed sections of R86; header, capture, habits and footer are not frames.
const FRAMED = ['brief', 'season', 'focus', 'timeline', 'calendar', 'inbox', 'next', 'heatmap', 'projects', 'log', 'ideas', 'standalone'];
// PART-MAP D: the element and the extra classes of each section's outer element.
const OUTER = {
  header: { el: 'header', classes: ['header'] },
  capture: { el: 'section', classes: ['capture'] },
  brief: { el: 'section', classes: ['card', 'card--agent', 'card--wide'] },
  log: { el: 'section', classes: ['card', 'card--agent'] },
  habits: { el: 'section', classes: ['habit-section'] },
  footer: { el: 'footer', classes: ['ft', 'footer'] },
};
for (const n of FRAMED) if (!OUTER[n]) OUTER[n] = { el: 'section', classes: ['card'] };

// The element children of the element that opens at `from` (an index of its '<'): [{ el, tag, classes }], and
// whether any text other than whitespace sits directly in it.
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'col', 'wbr', 'source']);
function children(html, from) {
  const re = /<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi;
  re.lastIndex = from;
  const kids = [];
  let depth = 0;
  let last = from;
  let text = false;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (depth === 1 && html.slice(last, m.index).trim() !== '') text = true;
    const closing = m[1] === '/';
    const el = m[2].toLowerCase();
    if (!closing && !VOID.has(el) && m[3] !== '/') {
      if (depth === 1) kids.push({ el, tag: m[0], classes: ((/\sclass="([^"]*)"/.exec(m[0]) || [])[1] || '').split(/\s+/).filter(Boolean) });
      depth += 1;
    } else if (!closing && depth === 1) {
      kids.push({ el, tag: m[0], classes: ((/\sclass="([^"]*)"/.exec(m[0]) || [])[1] || '').split(/\s+/).filter(Boolean) });
    } else if (closing) {
      depth -= 1;
      if (depth === 0) return { kids, text };
    }
    last = m.index + m[0].length;
  }
  return { kids, text };
}
const openAt = (html, s) => html.lastIndexOf('<', html.indexOf(`data-section="${s.name}"`));

function frameProblems(html, label) {
  const problems = [];
  const secs = sections(html);
  for (const s of secs) {
    const want = OUTER[s.name];
    if (!want) { problems.push(`${label}: unknown section ${s.name}`); continue; }
    if (s.el !== want.el) problems.push(`${label}: ${s.name} is a ${s.el}, expected ${want.el}`);
    for (const c of want.classes) if (!s.classes.includes(c)) problems.push(`${label}: ${s.name} lacks class ${c}: ${s.tag}`);
    const framed = FRAMED.includes(s.name);
    if (framed && s.classes[0] !== 'card') problems.push(`${label}: ${s.name} class list does not start with card: ${s.tag}`);
    if (!framed && s.classes.some((c) => c === 'card' || /^card--/.test(c))) problems.push(`${label}: ${s.name} must not be a frame: ${s.tag}`);
    if (!framed && s.name !== 'brief' && s.classes.some((c) => c === 'card-f')) problems.push(`${label}: ${s.name} holds card-f on its outer element`);
    if (!framed && s.classes.includes('card--agent')) problems.push(`${label}: ${s.name} carries card--agent`);
    if (framed) {
      const { kids, text } = children(html, openAt(html, s));
      if (kids.length !== 1 || kids[0].el !== 'div' || kids[0].classes.join(' ') !== 'card-f' || text) {
        problems.push(`${label}: ${s.name} must hold exactly one <div class="card-f"> and nothing else, found ${JSON.stringify(kids.map((k) => k.tag))}${text ? ' and loose text' : ''}`);
      }
    }
    if (s.name === 'habits') {
      // a wrapper whose tiles are each a card with one card-f, class habit
      const body = html.slice(openAt(html, s));
      const tiles = [...body.matchAll(/<([a-z0-9]+)\s+class="([^"]*\bhabit\b[^"]*)"[^>]*>/g)].filter((m) => m[2].split(/\s+/).includes('habit'));
      if (tiles.length === 0) problems.push(`${label}: habits holds no habit tile`);
      for (const t of tiles) {
        const cls = t[2].split(/\s+/);
        if (cls[0] !== 'card') problems.push(`${label}: habit tile does not start with card: ${t[0]}`);
        const { kids } = children(html, openAt(html, s) + body.indexOf(t[0]));
        if (kids.length !== 1 || kids[0].classes.join(' ') !== 'card-f') problems.push(`${label}: habit tile must hold one card-f: ${t[0]}`);
      }
    }
  }
  return problems;
}

test('R86 the twelve framed sections of every board page start with card and hold only one card-f; header, capture, habits and footer are not frames', () => {
  const all = [];
  for (const [label, build] of Object.entries(BOARD_PAGES)) {
    const html = build();
    assert.ok(sections(html).length >= 8, label + ' has sections');
    all.push(...frameProblems(html, label));
  }
  assert.deepEqual(all, []);
});

test('R86 a stale section keeps data-stale="true" on the same outer element as its frame classes', () => {
  const html = renderPage(staleBoard(), THEME, OPTS);
  const brief = sections(html).find((s) => s.name === 'brief');
  assert.ok(brief, 'brief is there');
  assert.ok(/\sdata-stale="true"/.test(brief.tag), brief.tag);
  assert.ok(brief.classes.includes('card') && brief.classes.includes('card--agent') && brief.classes.includes('card--wide'), brief.tag);
  const stale = sections(html).filter((s) => /\sdata-stale="true"/.test(s.tag));
  assert.ok(stale.length >= 2, 'more than one stale section in the stale fixture');
  for (const s of stale) assert.ok(s.classes.includes('card'), `${s.name} stale outer element is a card: ${s.tag}`);
});

test('R86 a section whose panel could not be read keeps the same outer element and frame', () => {
  const html = renderPage(errorBoard(), THEME, OPTS);
  const secs = sections(html);
  for (const name of ['brief', 'calendar', 'inbox', 'log']) assert.ok(secs.find((x) => x.name === name), name + ' still has its section');
  assert.deepEqual(frameProblems(html, 'unreadable panels'), []);
});

test('R77 no page the fixtures produce carries a style attribute', () => {
  for (const [label, build] of Object.entries(ALL_PAGES)) {
    const hits = [...build().matchAll(/<[a-z][^>]*\sstyle\s*=[^>]*>/gi)].map((m) => m[0]);
    assert.deepEqual(hits, [], label);
  }
});

test('R77 no page the fixtures produce carries an on... attribute', () => {
  for (const [label, build] of Object.entries(ALL_PAGES)) {
    const hits = [...build().matchAll(/<[a-z][^>]*\son[a-z]+\s*=[^>]*>/gi)].map((m) => m[0]);
    assert.deepEqual(hits, [], label);
  }
});

test('R77 a board page holds exactly one script element and it has a src, a notice page holds none', () => {
  for (const [label, build] of Object.entries(BOARD_PAGES)) {
    const html = build();
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    assert.equal(scripts.length, 1, label + ' script count');
    assert.ok(/\ssrc="[^"]+"/.test(scripts[0]), label + ' script has a src: ' + scripts[0]);
    assert.ok(/<script\b[^>]*><\/script>/i.test(html), label + ' the script holds no inline code');
  }
  for (const [label, build] of Object.entries(NOTICE_PAGES)) {
    assert.equal(count(build(), /<script\b/gi), 0, label + ' holds no script');
  }
});

// PART-MAP F4: classes the new look removes, by exact token.
const REMOVED = [
  'btn', 'btn--primary', 'btn--accent', 'btn--done', 'btn--small',
  'dot', 'dot--ok', 'dot--stale', 'dot--error', 'dot--agent',
  'badge', 'badge--accent', 'badge--hot', 'badge--ok', 'badge--stale',
  'chip--focus', 'chip--small',
  'empty', 'bar__fill', 'bar__fill--ink', 'bar__fill--hot', 'mono',
  'tl', 'cal',
];

test('R86 no page the fixtures produce carries a class the part map removed (F4)', () => {
  for (const [label, build] of Object.entries(ALL_PAGES)) {
    const tokens = new Set();
    for (const m of build().matchAll(/\sclass="([^"]*)"/g)) for (const t of m[1].split(/\s+/)) if (t) tokens.add(t);
    const found = REMOVED.filter((c) => tokens.has(c));
    assert.deepEqual(found, [], label);
  }
});

test('R83 board.css holds no rule for a class, variable or look the part map removed (F4)', () => {
  const found = [];
  for (const c of [...REMOVED, 'panel-error']) {
    if (new RegExp('\\.' + c.replace(/[-_]/g, (x) => '\\' + x) + '(?![\\w-])').test(CSS)) found.push('.' + c);
  }
  for (const v of [/--r-[a-z]+/, /--shadow\b/, /--link-hover\b/]) if (v.test(CSS)) found.push(String(v));
  if (/body[^{}]*\{[^{}]*radial-gradient/.test(CSS)) found.push('the body dot grid');
  if (/data-stale[^{}]*\{[^{}]*border-style\s*:\s*dashed/.test(CSS)) found.push('the dashed stale border');
  assert.deepEqual(found, []);
});

// The text between the braces of the one `@media (max-width: 480px)` block, or null.
function phoneBlock(css) {
  const m = /@media\s*\(\s*max-width\s*:\s*480px\s*\)\s*\{/.exec(css);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < css.length && depth > 0; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
  }
  return css.slice(start, i - 1);
}
// declarations of every rule in `block` whose selector list holds exactly `sel`
function declsFor(block, sel) {
  const out = [];
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim()).includes(sel)) {
      for (const d of m[2].split(';')) {
        const k = d.indexOf(':');
        if (k > 0) out.push([d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim()]);
      }
    }
  }
  return out;
}
const lastDecl = (decls, prop) => decls.filter(([k]) => k === prop).map(([, v]) => v).pop();
// the number of tracks in a grid-template-columns value
function tracks(v) {
  const rep = /^repeat\(\s*(\d+)\s*,/.exec(v);
  if (rep) return Number(rep[1]);
  let depth = 0;
  let n = 0;
  let inTok = false;
  for (const ch of v) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) inTok = false;
    else if (!inTok) { inTok = true; n += 1; }
  }
  return n;
}
const PHONE = phoneBlock(CSS);

test('R87 board.css holds exactly one @media (max-width: 480px) block', () => {
  assert.equal(count(CSS, /@media\s*\(\s*max-width\s*:\s*480px\s*\)/g), 1);
  assert.ok(PHONE !== null);
});

test('R87 the phone block sets one column on .row-brief, .row-trio, .row-low and .row-ideas', () => {
  assert.ok(PHONE !== null, 'the block exists');
  for (const sel of ['.row-brief', '.row-trio', '.row-low', '.row-ideas']) {
    const v = lastDecl(declsFor(PHONE, sel), 'grid-template-columns');
    assert.ok(v !== undefined, `${sel} sets grid-template-columns inside the 480px block`);
    assert.ok(/^(1fr|minmax\(\s*0\s*,\s*1fr\s*\))$/.test(v), `${sel} is a single track: ${v}`);
  }
});

test('R87 the phone block sets exactly two tracks on .habit-grid', () => {
  assert.ok(PHONE !== null, 'the block exists');
  const v = lastDecl(declsFor(PHONE, '.habit-grid'), 'grid-template-columns');
  assert.ok(v !== undefined, '.habit-grid sets grid-template-columns inside the 480px block');
  assert.equal(tracks(v), 2, v);
});

test('R87 the phone block gives .capture position: sticky and bottom: 0', () => {
  assert.ok(PHONE !== null, 'the block exists');
  const d = declsFor(PHONE, '.capture');
  assert.equal(lastDecl(d, 'position'), 'sticky');
  assert.equal(lastDecl(d, 'bottom'), '0');
});

// R83, with the contract's exact exclusion of numeric character references applied first.
test('R83 board.css and every file under board/render/ hold no colour literal once numeric character references are removed', () => {
  const REF = /&#(?:[0-9]+|[xX][0-9a-fA-F]+);/g;
  const dir = here('../board/render/');
  const files = [['board/static/board.css', readFileSync(here('../board/static/board.css'), 'utf8')]];
  for (const f of readdirSync(dir)) if (statSync(dir + f).isFile()) files.push(['board/render/' + f, readFileSync(dir + f, 'utf8')]);
  const found = [];
  for (const [name, raw] of files) {
    const text = raw.replace(REF, '');
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}/g)) found.push(`${name}: ${m[0]}`);
    for (const m of text.matchAll(/\b(?:rgba?|hsla?)\(/g)) found.push(`${name}: ${m[0]}`);
  }
  assert.deepEqual(found, []);
});
