// Page-side checks of the board contract: section order, panels, read-only, banner,
// phone layout, source tags, focus mark, project colour, forms.
// Written before the renderer exists; the renderer must satisfy these as written.
//
// Markup these tests require (and nothing more):
//  - every section's outer element has the attribute data-section="<name>" (double quotes)
//  - the stale banner is an element with the attribute data-banner
//  - source tags are elements with data-src="<tag>"
//  - the focus mark is the exact text data-focus="true"
//  - a project's colour class is the token pc-<key> in a class attribute
//  - forms are <form ...> with method="post" and action="<path>" (double quotes)
//  - the token of a form is the value of a hidden <input> (type="hidden")
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const loadJson = (rel) => JSON.parse(readFileSync(here(rel), 'utf8'));

const FULL = loadJson('../fixtures/board/page.board.json');
const MIN = loadJson('../fixtures/board/page-min.board.json');
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };

const render = (b, theme = THEME) => renderPage(b, theme, OPTS);
const copy = (b) => JSON.parse(JSON.stringify(b));
const count = (s, re) => (s.match(re) || []).length;

// Section names in document order.
function sectionNames(html) {
  return [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
}

// name -> html of that section (from its opening tag to the opening tag of the next section).
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

function styleBlock(html) {
  const m = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
  return m ? m[1] : '';
}
const withoutStyle = (html) => html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

const attr = (tag, name) => {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : null;
};

const forms = (html) => [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
const formTag = (f) => f.match(/^<form\b[^>]*>/i)[0];
const inputs = (f) => [...f.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]);
const hiddenInputs = (f) => inputs(f).filter((t) => (attr(t, 'type') || '').toLowerCase() === 'hidden');

test('R86 the full board renders sixteen sections in the fixed order, once each', () => {
  const names = sectionNames(render(FULL));
  assert.deepEqual(names, [
    'header', 'capture', 'brief', 'season', 'focus', 'timeline', 'calendar', 'inbox',
    'next', 'habits', 'heatmap', 'projects', 'log', 'ideas', 'standalone', 'footer',
  ]);
});

test('R86 the minimal board renders exactly the always-present sections, in order', () => {
  const html = render(MIN);
  assert.deepEqual(sectionNames(html), ['header', 'capture', 'focus', 'next', 'heatmap', 'projects', 'ideas', 'footer']);
  const focus = need(cut(html), 'focus');
  assert.ok(focus.includes('No focus set'), 'empty focus row says "No focus set"');
});

test('R86 a focus row with focus projects does not say "No focus set"', () => {
  const focus = need(cut(render(FULL)), 'focus');
  assert.ok(focus.length > 0);
  assert.ok(!focus.includes('No focus set'));
});

test('R49 with the four panels null the page has no brief, calendar, inbox or log section', () => {
  const names = sectionNames(render(MIN));
  for (const n of ['brief', 'calendar', 'inbox', 'log']) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('next') && names.includes('projects'), 'other sections are there');
});

test('R49 with the four panels present the page has those four sections', () => {
  const names = sectionNames(render(FULL));
  for (const n of ['brief', 'calendar', 'inbox', 'log']) assert.equal(count(names.join(','), new RegExp('(^|,)' + n + '(,|$)', 'g')), 1, n);
});

test('R63 read-only renders no form and no capture section', () => {
  const b = copy(FULL);
  b.meta.readOnly = true;
  const html = render(b);
  assert.equal(count(html, /<form\b/gi), 0);
  const names = sectionNames(html);
  assert.ok(!names.includes('capture'));
  assert.ok(names.includes('next') && names.includes('ideas') && names.includes('habits'), 'rest of the page is there');
});

test('R63 not read-only renders forms and the capture section', () => {
  const b = copy(FULL);
  b.meta.readOnly = false;
  const html = render(b);
  assert.ok(count(html, /<form\b/gi) > 0);
  assert.ok(sectionNames(html).includes('capture'));
});

test('R67 a stale board shows exactly one banner inside the header, with the reason', () => {
  const b = copy(FULL);
  b.meta.stale = { since: '2026-10-12T05:00:00Z', reason: 'GitHub did not answer' };
  const html = render(b);
  const hits = [...html.matchAll(/\sdata-banner(?=[\s=>/])/g)];
  assert.equal(hits.length, 1, 'exactly one element with data-banner');
  const headerStart = html.lastIndexOf('<', html.indexOf('data-section="header"'));
  const captureStart = html.lastIndexOf('<', html.indexOf('data-section="capture"'));
  assert.ok(headerStart >= 0 && captureStart > headerStart, 'header comes before capture');
  assert.ok(hits[0].index > headerStart && hits[0].index < captureStart, 'banner is inside the header section');
  assert.ok(html.includes('GitHub did not answer'));
});

test('R67 a board that is not stale has no banner', () => {
  const b = copy(FULL);
  b.meta.stale = null;
  const html = render(b);
  assert.equal(count(html, /data-banner/g), 0);
  assert.ok(sectionNames(html).includes('header'));
});

test('R87 the stylesheet has one 480px block: one column on the four row classes, two columns on the habit grid, sticky bottom capture', () => {
  const css = readFileSync(here('../board/static/board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /@media\s*\(\s*max-width\s*:\s*480px\s*\)/g;
  assert.equal(count(css, re), 1, 'exactly one @media (max-width: 480px) in board.css');
  const open = css.search(re);
  const brace = css.indexOf('{', open);
  assert.ok(brace > open);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > brace, 'block is closed');
  const block = css.slice(brace + 1, end);
  // the plain rules at the top level of the block: later rules win, a selector counts only when it is the whole selector
  const decls = new Map();
  let at = 0;
  while (at < block.length) {
    const o = block.indexOf('{', at);
    if (o < 0) break;
    let d = 1;
    let k = o + 1;
    while (k < block.length && d > 0) { if (block[k] === '{') d++; else if (block[k] === '}') d--; k++; }
    const sel = block.slice(at, o).trim();
    const body = block.slice(o + 1, k - 1);
    if (!sel.startsWith('@') && !body.includes('{')) {
      for (const one of sel.split(',').map((x) => x.trim())) {
        const m = decls.get(one) || {};
        for (const part of body.split(';')) {
          const c = part.indexOf(':');
          if (c > 0) m[part.slice(0, c).trim().toLowerCase()] = part.slice(c + 1).replace(/!important/i, '').trim();
        }
        decls.set(one, m);
      }
    }
    at = k;
  }
  const tracks = (v) => { const t = (v || '').replace(/\s+/g, ' ').replace(/,\s*/g, ',').trim(); return t; };
  for (const sel of ['.row-brief', '.row-trio', '.row-low', '.row-ideas']) {
    const v = tracks(decls.get(sel)?.['grid-template-columns']);
    assert.ok(v === '1fr' || v === 'minmax(0,1fr)', sel + ' is one column inside the 480px block, found "' + v + '"');
  }
  const hg = tracks(decls.get('.habit-grid')?.['grid-template-columns']);
  const two = /^repeat\(\s*2\s*,\s*(?:1fr|minmax\(0,1fr\))\s*\)$/.test(hg) || /^(?:1fr|minmax\(0,1fr\)) (?:1fr|minmax\(0,1fr\))$/.test(hg);
  assert.ok(two, '.habit-grid has exactly two tracks inside the 480px block, found "' + hg + '"');
  assert.equal(decls.get('.capture')?.position, 'sticky', '.capture is sticky');
  assert.match(decls.get('.capture')?.bottom ?? '', /^0(?:px)?$/, '.capture sticks to bottom: 0');
});

test('R88 every card carries its source tag', () => {
  const b = copy(FULL);
  b.meta.agentName = 'Robo';
  const s = cut(render(b));
  const has = (sec, tag) => assert.ok(need(s, sec).includes('data-src="' + tag + '"'), sec + ' has data-src="' + tag + '"');
  has('brief', 'Robo');
  has('log', 'Robo');
  has('calendar', 'CAL');
  has('inbox', 'MAIL');
  for (const sec of ['next', 'timeline', 'projects', 'habits', 'ideas', 'standalone', 'heatmap']) has(sec, 'GH');
});

test('R88 the agent tag follows the agent name, not a fixed word', () => {
  const s = cut(render(FULL)); // agentName is "Agent"
  assert.ok(need(s, 'brief').includes('data-src="Agent"'));
  assert.ok(need(s, 'log').includes('data-src="Agent"'));
  assert.ok(!s.brief.includes('data-src="Robo"'));
});

test('R89 two focus projects are marked six times: chip, lane and row each', () => {
  assert.equal(FULL.focus.projects.length, 2);
  assert.equal(count(render(FULL), /data-focus="true"/g), 6);
});

test('R89 a board with no focus has no mark', () => {
  const html = render(MIN);
  assert.equal(count(html, /data-focus="true"/g), 0);
  assert.ok(sectionNames(html).includes('projects'), 'the project rows are there');
});

test('R90 one project colour: class pc-house on lane, row, seats and linked habit; one rule', () => {
  const b = copy(FULL);
  const COLOR = '#123456';
  for (const p of b.projects) if (p.key === 'house') p.color = COLOR;
  for (const p of b.focus.projects) if (p.key === 'house') p.color = COLOR;
  for (const l of b.timeline.lanes) if (l.project.key === 'house') l.project.color = COLOR;
  for (const n of b.next) if (n.project.key === 'house') n.project.color = COLOR;
  for (const h of b.habits) if (h.project && h.project.key === 'house') h.project.color = COLOR;
  const houseSeats = b.next.filter((n) => n.project.key === 'house').length;
  const healthSeats = b.next.filter((n) => n.project.key === 'health').length;
  assert.equal(houseSeats, 3);
  assert.equal(healthSeats, 2);

  const html = render(b);
  const body = withoutStyle(html);
  const token = (k) => new RegExp('(?<![\\w-])pc-' + k + '(?![\\w-])', 'g');
  const s = cut(html);
  assert.ok(count(body, token('house')) >= 4, 'pc-house on at least four elements');
  for (const sec of ['timeline', 'projects', 'next', 'habits']) {
    assert.ok(count(need(s, sec), token('house')) >= 1, 'pc-house inside ' + sec);
  }
  assert.equal(count(need(s, 'next'), token('house')), houseSeats, 'one pc-house per house seat');
  assert.equal(count(need(s, 'next'), token('health')), healthSeats, 'one pc-health per health seat');

  const css = styleBlock(html);
  assert.ok(css.length > 0, 'a nonce style block exists');
  const rules = css.match(/\.pc-house(?![\w-])[^{}]*\{[^}]*\}/g) || [];
  assert.equal(rules.length, 1, 'exactly one rule for .pc-house');
  assert.match(rules[0], /#123456/i);
});

test('R91 every form posts to one of the four action paths, each path is used', () => {
  const html = render(FULL);
  const all = forms(html);
  assert.ok(all.length > 0);
  assert.equal(all.length, count(html, /<form\b/gi), 'every <form has a closing </form>');
  const PATHS = ['/actions/idea', '/actions/habit', '/actions/sort', '/actions/close'];
  const seen = new Set();
  for (const f of all) {
    const tag = formTag(f);
    assert.equal((attr(tag, 'method') || '').toLowerCase(), 'post', tag);
    const action = attr(tag, 'action');
    assert.ok(PATHS.includes(action), 'action ' + action);
    seen.add(action);
  }
  for (const p of PATHS) assert.ok(seen.has(p), 'a form for ' + p);
});

test('R91 accepting the suggestion of idea 41 posts to /actions/sort with accept=1', () => {
  const html = render(FULL);
  const mine = forms(html).filter((f) => attr(formTag(f), 'action') === '/actions/sort'
    && hiddenInputs(f).some((t) => attr(t, 'value') === 'tok-sort-41'));
  assert.ok(mine.length >= 1, 'a sort form for idea 41');
  const accept = mine.filter((f) => hiddenInputs(f).some((t) => attr(t, 'name') === 'accept' && attr(t, 'value') === '1'));
  assert.ok(accept.length >= 1, 'an accept form for idea 41');
});

test('R91 every form holds a hidden input with the token for its action and target', () => {
  const html = render(FULL);
  const NAME = { '/actions/idea': 'idea', '/actions/habit': 'habit', '/actions/sort': 'sort', '/actions/close': 'close' };
  for (const f of forms(html)) {
    const name = NAME[attr(formTag(f), 'action')];
    const toks = hiddenInputs(f).map((t) => attr(t, 'value')).filter((v) => v && v.startsWith('tok-' + name + '-'));
    assert.equal(toks.length, 1, 'one token in the ' + name + ' form');
  }
  const tokens = new Set(forms(html).flatMap((f) => hiddenInputs(f).map((t) => attr(t, 'value'))));
  assert.ok(tokens.has('tok-idea-new'), 'capture form');
  assert.ok(tokens.has('tok-close-12'), 'close form of seat 12');
  for (const n of FULL.next) assert.ok(tokens.has('tok-close-' + n.number), 'close form of seat ' + n.number);
  for (const h of FULL.habits) {
    const re = new RegExp('^tok-habit-' + h.id + ':' + FULL.meta.today + ':(on|off)$');
    assert.ok([...tokens].some((v) => re.test(v)), 'habit form for ' + h.id);
  }
});

// ---- Pack rebuild (part map C1, C2, C3, C5, C6, D1, D2, D16, F4): the page frame and its shared helpers ----

const classTokens = (html) => [...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean));

test('R67 the stale banner is the alert strip: exactly the contract markup, with the reason and stamp escaped', () => {
  const b = copy(FULL);
  b.meta.stale = { since: '2026-10-12T05:00:00Z', reason: 'GitHub did not answer <i>&"' };
  const html = render(b);
  const m = html.match(/<div class="al ch in banner" data-k="warn" data-banner role="status"><span class="pad warn"><\/span><div class="al-t"><b class="cap banner__title">Showing the last good read\.<\/b><span>([^<]*)\. Data from ([^<]*)\.<\/span><\/div><\/div>/);
  assert.ok(m, 'the banner is the exact C6 markup');
  assert.ok(m[1].includes('GitHub did not answer &lt;i&gt;&amp;&quot;'), 'the reason is escaped: ' + m[1]);
  assert.ok(m[2].length > 0, 'a stamp');
  assert.equal(count(html, /<p class="banner"/g), 0, 'never a p');
  assert.equal(count(html, /\sdata-banner(?=[\s=>/])/g), 1);
});

test('R88 every source tag is the pack tag: class "tag src" with data-src', () => {
  const html = render(FULL);
  const all = count(html, /\sdata-src="/g);
  assert.ok(all >= 10, 'the full page has many source tags, found ' + all);
  assert.equal(count(html, /<span class="tag src" data-src="[^"]*">[^<]*<\/span>/g), all, 'every data-src is on <span class="tag src">');
});

test('R91 a key form ends in one submit button holding b-n, b-z and the label inside b-f; the label is a bare text node', () => {
  const html = render(FULL);
  const seen = new Set();
  for (const f of forms(html)) {
    const action = attr(formTag(f), 'action');
    if (action === '/actions/close') continue;
    assert.equal(count(f, /<button\b/gi), 1, 'one button in the ' + action + ' form');
    const m = f.match(/<button type="submit" class="(b[^"]*)"((?: aria-pressed="true")?)><span class="b-f"><span class="b-n"><\/span><span class="b-z" aria-hidden="true"><\/span>([^<]*)<\/span><\/button><\/form>$/);
    assert.ok(m, 'the ' + action + ' key is the C1 markup and the last child of its form');
    const [, klass, pressed, label] = m;
    if (action === '/actions/idea') { assert.equal(klass, 'b pri'); assert.equal(label, 'Log idea'); }
    else if (hiddenInputs(f).some((t) => attr(t, 'name') === 'accept')) { assert.equal(klass, 'b sm pri'); assert.equal(label, 'Accept'); }
    else if (action === '/actions/sort') { assert.equal(klass, 'b sm'); assert.equal(label, 'Move'); }
    else if (action === '/actions/habit') {
      assert.equal(klass, 'b sm');
      assert.ok(label === 'Mark done' || label === 'Done today', label);
      assert.equal(pressed !== '', label === 'Done today', 'aria-pressed only on the done key');
    }
    seen.add(action + (hiddenInputs(f).some((t) => attr(t, 'name') === 'accept') ? '+accept' : ''));
  }
  for (const k of ['/actions/idea', '/actions/habit', '/actions/sort', '/actions/sort+accept']) assert.ok(seen.has(k), 'a key for ' + k);
});

test('R91 the close form holds one close box button: class ck, a box with a tick, the label in sr-only', () => {
  const html = render(FULL);
  const closes = forms(html).filter((f) => attr(formTag(f), 'action') === '/actions/close');
  assert.ok(closes.length >= 2, 'several close forms');
  for (const f of closes) {
    assert.equal(count(f, /<button\b/gi), 1);
    assert.match(f, /<button type="submit" class="ck"><span class="box" aria-hidden="true"><svg viewBox="0 0 30 30"><polyline points="8,15 13,20 22,10"\/><\/svg><\/span><span class="sr-only">Close<\/span><\/button><\/form>$/);
  }
});

// The inner html of the element of the given open tag regexp, up to its closing tag (these elements do not nest).
function inner(html, openRe, closeTag) {
  const m = openRe.exec(html);
  assert.ok(m, 'no element matches ' + openRe);
  const start = m.index + m[0].length;
  return html.slice(start, html.indexOf(closeTag, start));
}
// True when the html is exactly one <div class="card-f">...</div> (balanced, nothing before or after it).
function isSingleCardF(h) {
  if (!h.startsWith('<div class="card-f">')) return false;
  let depth = 0;
  for (const t of h.matchAll(/<div\b|<\/div>/g)) {
    depth += t[0] === '</div>' ? -1 : 1;
    if (depth === 0) return t.index + t[0].length === h.length;
  }
  return false;
}

test('R86 the twelve framed sections are a card with one card-f as their only child; header, capture, habits and footer are not frames', () => {
  const html = render(FULL);
  const FRAMES = ['brief', 'season', 'focus', 'timeline', 'calendar', 'inbox', 'next', 'heatmap', 'projects', 'log', 'ideas', 'standalone'];
  for (const n of FRAMES) {
    const open = new RegExp('<section class="card(?: [^"]*)?" data-section="' + n + '"[^>]*>');
    assert.ok(isSingleCardF(inner(html, open, '</section>')), n + ': the only child is one <div class="card-f">');
  }
  for (const n of ['brief', 'log']) assert.match(html, new RegExp('<section class="card card--agent(?: card--wide)?" data-section="' + n + '"'));
  assert.match(html, /<header class="header" data-section="header">/);
  assert.match(html, /<section class="capture" data-section="capture">/);
  assert.match(html, /<footer class="ft footer" data-section="footer">/);
  assert.match(html, /<section class="habit-section" data-section="habits">/);
  const tiles = [...html.matchAll(/<article class="card habit[^"]*"[^>]*>/g)];
  assert.ok(tiles.length >= 2, 'habit tiles are cards');
  for (const t of tiles) {
    const h = html.slice(t.index + t[0].length, html.indexOf('</article>', t.index));
    assert.ok(isSingleCardF(h), 'each habit tile has one card-f');
  }
  for (const n of ['header', 'capture', 'habits', 'footer']) assert.doesNotMatch(html, new RegExp('<[a-z]+ class="card[ "][^>]*data-section="' + n + '"'), n + ' is not a frame');
});

test('U the retired class names are gone from the page', () => {
  const RETIRED = ['empty', 'dot', 'dot--ok', 'dot--stale', 'dot--error', 'dot--agent', 'badge', 'badge--accent', 'badge--hot', 'badge--ok', 'badge--stale',
    'bar__fill', 'bar__fill--ink', 'bar__fill--hot', 'chip--focus', 'chip--small', 'btn', 'btn--primary', 'btn--accent', 'btn--done', 'btn--small', 'mono', 'tl', 'cal'];
  for (const b of [FULL, MIN]) {
    const tokens = new Set(classTokens(render(b)));
    for (const r of RETIRED) assert.ok(!tokens.has(r), 'the class ' + r + ' is retired (part map F4, H)');
  }
});

test('U an empty state is the emp frame with four fixings, and the empty focus row keeps focus__empty', () => {
  const focus = need(cut(render(MIN)), 'focus');
  assert.ok(focus.includes('<p class="emp focus__empty"><span class="fix fix--tl"></span><span class="fix fix--tr"></span><span class="fix fix--bl"></span><span class="fix fix--br"></span>'));
  assert.match(focus, /No focus set<\/p>/);
  assert.equal(count(render(MIN), /class="empty"/g), 0);
});

test('U the header: a lab date line with a pad, a cap title, the sources list, a rail, and no brandmark or image', () => {
  const html = render(FULL);
  const header = need(cut(html), 'header');
  assert.ok(header.startsWith('<header class="header" data-section="header">'));
  assert.match(header, /<div class="header__main"><p class="header__date lab"><span class="pad"><\/span>[^<]+<\/p><h1 class="header__title cap(?: fit-\d+)?">/);
  assert.ok(header.includes('<ul class="sources" aria-label="Sources">'));
  assert.match(header, /<li class="chip"><span class="bdg chip__name"><span class="pad (?:ok|warn|err)"><\/span><span class="chip__label">[^<]+<\/span><\/span><span class="lab chip__state">[^<]+<\/span><\/li>/);
  assert.match(header, /<div class="rail" aria-hidden="true"><\/div>\s*<\/header>/);
  assert.ok(!header.includes('brandmark') && !/<img\b/i.test(html), 'the product writes no brandmark and no image (J1)');
});

test('U the capture section: a field wrapper with a floor, the b pri key, then the message paragraph', () => {
  const capture = need(cut(render(FULL)), 'capture');
  assert.ok(capture.includes('<span class="fx"><input id="idea-title" type="text" name="title" maxlength="200" required placeholder="Log an idea. It becomes a GitHub issue."><span class="floor"></span></span>'));
  assert.match(capture, /<\/form>\s*<p data-message><\/p>\s*<\/section>/);
});

test('U the footer: ft footer, a closing rail, and the time line in ft-b lab footer__time around one span', () => {
  const html = render(FULL);
  const footer = need(cut(html), 'footer');
  assert.ok(footer.startsWith('<footer class="ft footer" data-section="footer">'));
  assert.match(footer, /<div class="rail" aria-hidden="true"><\/div>\s*<p class="ft-b lab footer__time"><span>Data from [^<]+ · [^<]+ · (?:<a href="[^"]+">Data repo<\/a>|Data repo)<\/span><\/p>/);
  const b = copy(FULL);
  b.meta.readOnly = true;
  const ro = need(cut(render(b)), 'footer');
  assert.ok(ro.includes('<p class="lab">Read-only: changes are switched off.</p>'));
  assert.match(ro, /<div class="ft-t">/);
});
