// R173 (and the guide's hard facts): references/skins.md is read as data and held against the product.
// Nothing in the guide is copied into this file except what the contract itself lists (R86 section names, the R173 lists).
// The allowance is the one R173's Check states: a variable is defined in the nonce style block of a fixture page; a hook or a
// part class is present in at least one fixture page or in board/static/board.css. The render sources are NOT searched.
// "Fixture pages" are the renders of the two fixture boards (src/fixtures/board), plain, read-only and stale, with system and
// Google fonts, plus the notice page. If the guide lists something no fixture page holds, the test says so: that is a finding.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPage, renderNotice } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { loadSkin } from '../board/skin.mjs';
import { checkBoard } from '../board/shape-data.mjs';
import { routes as worldRoutes, issues as worldIssues, apiIssue, R } from '../fixtures/github/world.mjs';

const { start } = await import('../board/server.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..');
const GUIDE = fs.readFileSync(path.join(SRC, 'references', 'skins.md'), 'utf8');
const GUIDE_LINES = GUIDE.split('\n');
const CSS = fs.readFileSync(path.join(SRC, 'board', 'static', 'board.css'), 'utf8');
const loadJson = (rel) => JSON.parse(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const FULL = loadJson('fixtures/board/page.board.json');
const MIN = loadJson('fixtures/board/page-min.board.json');
const copy = (b) => JSON.parse(JSON.stringify(b));
const READONLY = (() => { const b = copy(FULL); b.meta.readOnly = true; return b; })();
const STALE = (() => { const b = copy(FULL); b.meta.stale = { since: '2026-10-12T05:00:00Z', reason: 'GitHub did not answer' }; return b; })();
const OPTS = { styleNonce: 'testnonce', formToken: () => 'tok', skin: true };

// One board that exercises what the two fixture boards do not: an all-day entry, entries that carry a source (a merged
// calendar), a file from an earlier day, an inbox thread with a mailbox label and colour, and a project that waits on
// blockers. The shapes are those the renderer reads (calendar-allday, calendar-merge-sources, inbox-account, inbox-colour
// and mapping-waiting tests); it is not a fixture file, it is built here, and it must pass the board validator.
const EXERCISING = (() => {
  const b = copy(FULL);
  const cal = b.panels.calendar;
  cal.allDay = [{ title: 'Public holiday', source: 'Work diary' }, { title: 'Birthday' }];
  cal.events = cal.events.map((e, i) => (i === 0 ? { ...e, source: 'iCloud' } : { ...e, source: 'Work diary' }));
  cal.fileDate = '2026-10-11';
  cal.fileSource = 'Work diary';
  const inbox = b.panels.inbox;
  inbox.threads[0] = { ...inbox.threads[0], account: 'Work', colour: 'teal' };
  inbox.threads[1] = { ...inbox.threads[1], account: 'Home' };
  b.projects[0] = { ...b.projects[0], waiting: { items: ['the permit', 'the plumber'], more: 2 } };
  return b;
})();
const PAGES = [];
for (const board of [FULL, MIN, READONLY, STALE, EXERCISING]) for (const theme of [resolveTheme(null).theme, resolveTheme({ fonts: { source: 'google' } }).theme]) PAGES.push(renderPage(board, theme, OPTS));
PAGES.push(renderNotice({ title: 'No settings file found', message: 'Run the setup step.', status: 503 }, { styleNonce: 'nn', skin: true }));
const ALL_PAGES = PAGES.join('\n');
const STYLE_BLOCKS = PAGES.flatMap((p) => [...p.matchAll(/<style nonce="[^"]*">([\s\S]*?)<\/style>/g)].map((m) => m[1])).join('\n');
const PAGE_CLASSES = new Set([...ALL_PAGES.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inCss = (cls) => new RegExp(`\\.${esc(cls)}(?![\\w-])`).test(CSS);
const classExists = (cls) => PAGE_CLASSES.has(cls) || inCss(cls);
const hookExists = (hook) => new RegExp(`(?<![\\w-])${esc(hook)}(?![\\w-])`).test(ALL_PAGES) || CSS.includes(`[${hook}`);

test('R173 the exercising board built in this file passes the board validator and carries the data the missing names need', () => {
  const r = checkBoard(EXERCISING);
  assert.deepEqual(r, { ok: true, errors: [] }, 'the validator accepts it');
  assert.deepEqual(checkBoard({ ...EXERCISING, projects: [{ ...EXERCISING.projects[0], waiting: { items: [], more: 1 } }] }).ok, false, 'witness: the validator does reject a wrong waiting block');
  for (const mark of ['data-allday', 'data-source', 'data-filedate', 'data-account', 'data-colour', 'data-waiting', 'cal-allday-label']) {
    assert.ok(PAGES.some((p) => p.includes(mark)), `${mark} is rendered from the exercising board`);
  }
});

// ---------------------------------------------------------------- reading the guide

function sectionText(heading) {
  const level = heading.match(/^#+/)[0].length;
  const at = GUIDE_LINES.findIndex((l) => l === heading);
  assert.ok(at >= 0, `the guide has the heading "${heading}"`);
  let end = GUIDE_LINES.length;
  for (let i = at + 1; i < GUIDE_LINES.length; i++) {
    const m = /^(#+) /.exec(GUIDE_LINES[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { start: at + 1, text: GUIDE_LINES.slice(at + 1, end).join('\n'), lines: GUIDE_LINES.slice(at + 1, end) };
}
// the line number (1-based) of the first line in the guide that holds `needle`
const lineOf = (needle) => GUIDE_LINES.findIndex((l) => l.includes(needle)) + 1;

function expand(cell) {
  const out = [];
  for (const m of cell.matchAll(/`([^`]+)`(?: to `([^`]+)`)?/g)) {
    if (!m[2]) { out.push({ name: m[1] }); continue; }
    const a = /^(.*?)(\d+)$/.exec(m[1]);
    const b = /^(.*?)(\d+)$/.exec(m[2]);
    assert.ok(a && b && a[1] === b[1], `a range "${m[1]} to ${m[2]}" the test can expand`);
    for (let i = Number(a[2]); i <= Number(b[2]); i++) out.push({ name: `${a[1]}${i}` });
  }
  return out;
}
function tableNames(sec) {
  const names = [];
  sec.lines.forEach((l, i) => {
    if (!l.startsWith('| ') || /^\| (Class|Hook|Variable|Part) /.test(l) || l.startsWith('| ---')) return;
    const cell = l.split('|')[1];
    for (const e of expand(cell)) names.push({ ...e, line: sec.start + i + 1 });
  });
  return names;
}

const guideSections = (() => {
  const line = GUIDE_LINES.find((l) => l.includes('in this order on the page:'));
  assert.ok(line, 'the guide lists the sections in order');
  return [...line.slice(line.indexOf('in this order on the page:')).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
})();
const guideHooks = tableNames(sectionText('### Data hooks'));
const guideVars = tableNames(sectionText('### Theme variables'));
const guideParts = tableNames(sectionText('### Part classes'));
const frames = (() => {
  const line = GUIDE_LINES.find((l) => l.startsWith('The twelve sections'));
  return [...line.slice(0, line.indexOf(' are frames')).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
})();

// ---------------------------------------------------------------- what the contract itself lists (R86, R173)

const CONTRACT_SECTIONS = ['header', 'capture', 'brief', 'season', 'focus', 'timeline', 'calendar', 'inbox', 'next', 'habits', 'heatmap', 'projects', 'log', 'ideas', 'standalone', 'footer'];
const CONTRACT_HOOKS = ['data-src', 'data-focus', 'data-stale', 'data-banner', 'data-message', 'data-waiting', 'data-done', 'data-allday', 'data-account', 'data-colour', 'data-source', 'data-filedate'];
const CONTRACT_VARS = ['--ground', '--dot', '--card', '--border', '--ink', '--muted', '--faint', '--agent-bg', '--agent-ink', '--accent', '--hot', '--hot-ink', '--ok', '--on-accent', '--radius', '--font-heading', '--font-body', '--font-mono'];
const PER_ITEM = [['pc-<key>', '--pc', 'pc-'], ['mode-<n>', '--mc', 'mode-'], ['x-<n>', '--x', 'x-'], ['w-<n>', '--w', 'w-']];

// ================================================================ the guide lists, the product holds

test('R173 the guide lists every section name of R86, in the order of the page, and the fixture page has exactly those sections in that order', () => {
  assert.deepEqual(guideSections, CONTRACT_SECTIONS, `skins.md:${lineOf('in this order on the page:')}`);
  const rendered = [...renderPage(FULL, resolveTheme(null).theme, OPTS).matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rendered, guideSections);
});

test('R173 every hook of the contract list appears in the guide, and the guide lists no other hook', () => {
  assert.deepEqual(guideHooks.map((h) => h.name).sort(), [...CONTRACT_HOOKS].sort());
  for (const h of CONTRACT_HOOKS) assert.ok(GUIDE.includes(h), h);
});

test('R173 every theme variable of the contract list appears in the guide, and the guide lists no other variable', () => {
  assert.deepEqual(guideVars.map((v) => v.name).sort(), [...CONTRACT_VARS].sort());
  for (const [pat, v] of PER_ITEM) { assert.ok(GUIDE.includes(`\`${pat}\``), `${pat} in the guide`); assert.ok(GUIDE.includes(`\`${v}\``), `${v} in the guide`); }
});

for (const name of CONTRACT_HOOKS) {
  test(`R173 the data hook ${name} the guide lists is present in a fixture page or in board.css`, () => {
    const g = guideHooks.find((h) => h.name === name);
    assert.ok(g, `${name} is in the guide's table`);
    assert.ok(hookExists(name), `skins.md:${g.line} lists ${name}, but no fixture page and no rule in board.css holds it`);
  });
}

for (const v of CONTRACT_VARS) {
  test(`R173 the theme variable ${v} the guide lists is defined in the nonce style block of a fixture page`, () => {
    const g = guideVars.find((x) => x.name === v);
    assert.ok(g, `${v} is in the guide's table`);
    assert.ok(new RegExp(`${esc(v)}:`).test(STYLE_BLOCKS), `skins.md:${g.line} lists ${v}, but no nonce style block defines it`);
    assert.ok(new RegExp(`${esc(v)}:`).test(PAGES[PAGES.length - 1].match(/<style[\s\S]*?<\/style>/)[0]), `${v} is defined in the notice page's block as well`);
  });
}

for (const [pat, v, prefix] of PER_ITEM) {
  test(`R173 the per-item class ${pat} the guide lists is present in a fixture page or in board.css, with ${v}`, () => {
    const inPage = [...PAGE_CLASSES].some((c) => c.startsWith(prefix));
    const inRules = new RegExp(`\\.${esc(prefix)}[\\w_-]`).test(CSS) || CSS.includes(`[class*="${prefix}`);
    assert.ok(inPage || inRules, `no class beginning ${prefix} in any fixture page or in board.css`);
    assert.ok(ALL_PAGES.includes(v) || CSS.includes(v), `${v} is used in a fixture page or in board.css`);
  });
}

test('R173 the guide lists part classes, each only once', () => {
  assert.ok(guideParts.length > 100, `read ${guideParts.length} part classes from the guide`);
  const seen = new Map();
  for (const p of guideParts) {
    if (seen.has(p.name)) assert.fail(`skins.md:${p.line} lists "${p.name}" again (first at line ${seen.get(p.name)})`);
    seen.set(p.name, p.line);
  }
});

test('R173 every part class the guide lists is present in a fixture page or in board.css (all findings in one list)', () => {
  const missing = guideParts.filter((p) => !classExists(p.name)).map((p) => `skins.md:${p.line} ${p.name}`);
  assert.deepEqual(missing, [], `listed but in no fixture page and not in board.css:\n${missing.join('\n')}`);
});

test('R173 the twelve frame sections have the card frame and one card-f face, and the other four do not (as the guide says)', () => {
  assert.equal(frames.length, 12);
  const html = renderPage(FULL, resolveTheme(null).theme, OPTS);
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ name: m[1], at: html.lastIndexOf('<', m.index) }));
  marks.forEach((m, i) => {
    const part = html.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : html.length);
    const tag = /^<[^>]*>/.exec(part)[0];
    const cls = ((/class="([^"]*)"/.exec(tag) || [])[1] || '').split(/\s+/);
    if (frames.includes(m.name)) {
      assert.ok(cls.includes('card'), `${m.name}: the outer element has class card`);
      assert.equal((part.match(/class="[^"]*\bcard-f\b/g) || []).length, 1, `${m.name}: one card-f`);
    } else {
      assert.ok(!cls.includes('card'), `${m.name}: not a frame`);
    }
  });
});

test('R173 the exact page markers the guide quotes in its troubleshooting are what a skinned page carries', () => {
  const line = GUIDE_LINES.find((l) => l.includes('with a skin loaded it has'));
  const quoted = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(quoted, ['<link rel="stylesheet" href="/skin/skin.css">', '<html lang="en" data-skin>']);
  for (const q of quoted) assert.ok(PAGES[0].includes(q), q);
});

// ================================================================ the limits table against the loader's behaviour

const made = [];
after(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });
function mk(files, { css = 'html[data-skin]{}\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-guide-'));
  made.push(root);
  const dir = path.join(root, 'skin');
  fs.mkdirSync(dir);
  if (css !== null) fs.writeFileSync(path.join(dir, 'skin.css'), css);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}
const skipped = (s) => (s.warnings.find((w) => w.code === 'skin-file-skipped') || { count: 0 }).count;
const served = (s) => [...s.files.keys()].sort();

// the numbers, read from the guide's own table and prose
const limits = (() => {
  const rows = sectionText('## The folder').lines.filter((l) => l.startsWith('| `'));
  const kb = (cell) => Number(/(\d+) KB/.exec(cell)[1]) * 1024;
  const count = (cell) => Number(/up to (\d+) files/.exec(cell)[1]);
  const cells = rows.map((r) => r.split('|').map((c) => c.trim()));
  const byPart = Object.fromEntries(cells.map((c) => [c[1], c]));
  const total = Number(/\((\d[\d,]*) bytes\)/.exec(GUIDE)[1].replace(/,/g, ''));
  const entries = Number(/no more than (\d+) entries/.exec(GUIDE)[1]);
  const nameLen = Number(/at most (\d+) characters before the dot/.exec(GUIDE)[1]);
  return {
    css: kb(byPart['`skin.css`'][3]),
    fontBytes: kb(byPart['`fonts/`'][3]), fontCount: count(byPart['`fonts/`'][2]),
    imgBytes: kb(byPart['`img/`'][3]), imgCount: count(byPart['`img/`'][2]),
    total, entries, nameLen,
  };
})();

test("R173 the guide's limits table gives the numbers the contract states (R166)", () => {
  assert.deepEqual(limits, { css: 262144, fontBytes: 307200, fontCount: 6, imgBytes: 512000, imgCount: 12, total: 3145728, entries: 64, nameLen: 40 });
});

test("R173 skin.css at the guide's limit loads, one byte over is no skin, an empty one is valid", () => {
  assert.equal(loadSkin(mk({}, { css: 'a'.repeat(limits.css) })).loaded, true);
  const over = loadSkin(mk({}, { css: 'a'.repeat(limits.css + 1) }));
  assert.equal(over.loaded, false);
  assert.ok(over.warnings.some((w) => w.code === 'skin-unreadable'));
  assert.equal(loadSkin(mk({}, { css: '' })).loaded, true);
});

test("R173 a font at the guide's limit is served, one byte over is skipped; the same for an image", () => {
  const s = loadSkin(mk({ 'fonts/a.woff2': Buffer.alloc(limits.fontBytes), 'fonts/b.woff2': Buffer.alloc(limits.fontBytes + 1), 'img/a.png': Buffer.alloc(limits.imgBytes), 'img/b.png': Buffer.alloc(limits.imgBytes + 1) }));
  assert.deepEqual(served(s), ['/skin/fonts/a.woff2', '/skin/img/a.png', '/skin/skin.css']);
  assert.equal(skipped(s), 2);
});

test("R173 the guide's counts: the first six fonts and twelve images by name are served, the next is skipped", () => {
  const files = {};
  for (let i = 0; i <= limits.fontCount; i++) files[`fonts/f${i}.woff2`] = 'x';
  for (let i = 0; i <= limits.imgCount; i++) files[`img/i${String(i).padStart(2, '0')}.png`] = 'x';
  const s = loadSkin(mk(files));
  assert.equal([...s.files.keys()].filter((k) => k.startsWith('/skin/fonts/')).length, limits.fontCount);
  assert.equal([...s.files.keys()].filter((k) => k.startsWith('/skin/img/')).length, limits.imgCount);
  assert.ok(!s.files.has(`/skin/fonts/f${limits.fontCount}.woff2`) && !s.files.has(`/skin/img/i${String(limits.imgCount).padStart(2, '0')}.png`), 'the last by name is the one left out');
  assert.equal(skipped(s), 2);
});

test("R173 the guide's total: files up to the total exactly are served, the next byte is skipped, in the order the guide states", () => {
  const rest = limits.total - limits.css - limits.fontBytes * limits.fontCount;
  const tail = rest - 2 * limits.imgBytes;
  assert.ok(tail > 0 && tail <= limits.imgBytes);
  const files = { 'img/a.png': Buffer.alloc(limits.imgBytes), 'img/b.png': Buffer.alloc(limits.imgBytes), 'img/c.png': Buffer.alloc(tail), 'img/d.png': Buffer.alloc(1) };
  for (let i = 0; i < limits.fontCount; i++) files[`fonts/f${i}.woff2`] = Buffer.alloc(limits.fontBytes);
  const s = loadSkin(mk(files, { css: 'a'.repeat(limits.css) }));
  const sum = [...s.files.values()].reduce((n, f) => n + f.body.length, 0);
  assert.equal(sum, limits.total, 'everything up to the total is served');
  assert.ok(s.files.has('/skin/img/c.png') && !s.files.has('/skin/img/d.png'), 'the file that would cross is the skipped one');
  assert.equal(skipped(s), 1);
});

test("R173 the guide's 64 entries: 65 files in img/ serve twelve and the cut is counted", () => {
  const files = {};
  for (let i = 0; i < limits.entries + 1; i++) files[`img/${String(i).padStart(2, '0')}.png`] = 'x';
  const s = loadSkin(mk(files));
  assert.equal([...s.files.keys()].filter((k) => k.startsWith('/skin/img/')).length, limits.imgCount);
  // 64 looked at: 12 served, 52 over the count skipped, plus one for the cut
  assert.equal(skipped(s), limits.entries - limits.imgCount + 1);
});

test('R173 the guide says a README.txt, a folder of notes and a dot name cause no warning', () => {
  const s = loadSkin(mk({ 'README.txt': 'x', 'notes/a.txt': 'x', '.DS_Store': 'x', 'img/.hidden.png': 'x', 'img/grid.png': 'x' }));
  assert.equal(skipped(s), 0);
  assert.equal(s.warnings.length, 0);
});

// ---------------------------------------------------------------- the file names of the guide

const bulletNames = (heading) => {
  const lines = sectionText('## File names').lines;
  const from = lines.findIndex((l) => l.startsWith(heading));
  const out = [];
  for (let i = from + 2; i < lines.length && lines[i].startsWith('- '); i++) out.push(lines[i]);
  return out;
};
const folderFor = (name) => (/\.(woff2|ttf)$/i.test(name) ? 'fonts' : 'img');

test('R173 every good file name the guide lists is served by the loader without a warning', () => {
  const good = bulletNames('Good names').map((l) => /^- `([^`]+)`/.exec(l)[1]);
  assert.ok(good.length >= 5);
  const files = {};
  for (const n of good) files[`${folderFor(n)}/${n}`] = 'x';
  const s = loadSkin(mk(files));
  for (const n of good) assert.ok(s.files.has(`/skin/${folderFor(n)}/${n}`), `${n} is served`);
  assert.equal(skipped(s), 0);
});

test('R173 every bad file name the guide lists is skipped with one warning, and 40 characters before the dot pass where 41 do not', () => {
  const bad = bulletNames('Bad names').map((l) => /^- `([^`]+)`/.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.ok(bad.length >= 9);
  for (const n of bad) {
    const s = loadSkin(mk({ [`${folderFor(n)}/${n}`]: 'x' }));
    assert.ok(!s.files.has(`/skin/${folderFor(n)}/${n}`), `${n} is not served`);
    assert.equal(skipped(s), 1, `${n} adds one warning`);
  }
  assert.ok(GUIDE.includes('a name of 41 or more characters before the dot'));
  const ok40 = `${'a'.repeat(limits.nameLen)}.png`;
  const bad41 = `${'a'.repeat(limits.nameLen + 1)}.png`;
  const s = loadSkin(mk({ [`img/${ok40}`]: 'x', [`img/${bad41}`]: 'x' }));
  assert.ok(s.files.has(`/skin/img/${ok40}`) && !s.files.has(`/skin/img/${bad41}`));
});

// ---------------------------------------------------------------- the worked example, built from the guide's own blocks

function codeBlocks() {
  const blocks = [];
  let open = null;
  for (const l of GUIDE_LINES) {
    const m = /^```(\w*)$/.exec(l.trim());
    if (m && open === null) { open = { lang: m[1], lines: [] }; continue; }
    if (l.trim() === '```' && open !== null) { blocks.push(open); open = null; continue; }
    if (open) open.lines.push(l);
  }
  return blocks;
}
const example = (() => {
  const ex = sectionText('## A worked example').text;
  const tree = codeBlocks().find((b) => b.lang === '' && b.lines.join('\n').includes('grid.png'));
  const css = codeBlocks().find((b) => b.lang === 'css');
  assert.ok(tree && css, 'the example has a folder tree and a css block');
  const names = []; let dir = '';
  for (const l of tree.lines.slice(1)) {
    const m = /^(\s*)(\S+)$/.exec(l);
    if (!m) continue;
    if (m[2].endsWith('/')) dir = m[2]; else names.push(dir + m[2]);
  }
  assert.ok(ex.includes('written out in full'));
  return { names, css: css.lines.join('\n') + '\n' };
})();

// The two binary files are the ones the guide says you supply yourself; stand-in bytes are used for them.
function buildExample() {
  const files = {};
  for (const n of example.names) if (n !== 'skin.css') files[n] = n.startsWith('fonts/') ? Buffer.from('wOF2-stand-in') : Buffer.from('PNG-stand-in');
  return mk(files, { css: example.css });
}

test("R173 the worked example: its folder tree and css block give a skin that loads with every file served and no warning", () => {
  assert.deepEqual([...example.names].sort(), ['fonts/panel-sans.woff2', 'img/grid.png', 'skin.css']);
  const s = loadSkin(buildExample());
  assert.equal(s.loaded, true);
  assert.equal(s.warnings.length, 0);
  assert.deepEqual(served(s), ['/skin/fonts/panel-sans.woff2', '/skin/img/grid.png', '/skin/skin.css']);
  assert.equal(s.hasFonts, true);
});

test("R173 every url() in the worked example's css is relative to skin.css and names a served file; every rule starts with html[data-skin]", () => {
  const s = loadSkin(buildExample());
  const urls = [...example.css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 2);
  for (const u of urls) {
    assert.ok(!u.startsWith('/') && !/^[a-z]+:/.test(u), `${u} is relative`);
    assert.ok(s.files.has(new URL(u, 'http://x/skin/skin.css').pathname), `${u} resolves to a served file`);
  }
  const stripped = example.css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@font-face\s*\{[^}]*\}/g, '');
  const rules = [...stripped.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
  assert.ok(rules.length >= 3);
  for (const r of rules) assert.ok(r.startsWith('html[data-skin]'), `rule "${r}" starts with html[data-skin]`);
});

test("R173 every variable, section and class the worked example's css uses is on the stable surface the guide lists", () => {
  for (const v of new Set([...example.css.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]))) assert.ok(CONTRACT_VARS.includes(v), `${v} is a listed variable`);
  for (const m of example.css.matchAll(/\[data-section="([^"]+)"\]/g)) assert.ok(guideSections.includes(m[1]), m[1]);
  const body = example.css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\("[^"]*"\)/g, '').replace(/"[^"]*"/g, '');
  const classes = [...body.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]);
  assert.ok(classes.length >= 2);
  for (const c of classes) assert.ok(guideParts.some((p) => p.name === c), `.${c} is a listed part class`);
});

// ---------------------------------------------------------------- the footer sentences, the setting and the URL shapes

const quotedBold = (needle) => {
  const line = GUIDE_LINES.find((l) => l.startsWith('**`') && l.includes(needle));
  assert.ok(line, `a bold quoted line holding "${needle}"`);
  return /^\*\*`([^`]+)`\*\*$/.exec(line)[1];
};
function pageFooter(warnings) {
  const b = copy(FULL);
  b.meta.warnings = warnings;
  const html = renderPage(b, resolveTheme(null).theme, OPTS);
  return html.slice(html.indexOf('data-section="footer"'));
}

test('R173 the footer sentences the guide quotes are the ones the page renders for skin-file-skipped (1 and 3) and skin-unreadable', () => {
  const one = quotedBold('1 skin file could not');
  const unreadable = quotedBold('The skin folder could not be read');
  const pluralLine = GUIDE_LINES.find((l) => l.includes('<n> skin files could not be used and were skipped.'));
  assert.ok(pluralLine, 'the guide gives the plural form');
  const plural = /`(<n> skin files[^`]+)`/.exec(pluralLine)[1];
  assert.ok(pageFooter([{ code: 'skin-file-skipped', count: 1 }]).includes(one), `skins.md:${lineOf('1 skin file could not')} singular`);
  assert.ok(pageFooter([{ code: 'skin-file-skipped', count: 3 }]).includes(plural.replace('<n>', '3')), 'plural with 3');
  assert.ok(pageFooter([{ code: 'skin-unreadable', count: 1 }]).includes(unreadable), 'unreadable');
  assert.ok(!pageFooter([{ code: 'skin-file-skipped', count: 3 }]).includes(one));
});

function fakeResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}
function makeFetch() {
  const s = loadJson('fixtures/settings/base.json');
  s.projects = [{ key: 'house', number: 3 }]; s.focus = ['house']; s.habits = [{ id: 'move', title: 'Move', start: '2026-09-22' }];
  s.season.goals = [{ title: 'Finish the kitchen and bathroom', project: 'house' }];
  const list = [...worldIssues(), apiIssue(20, { title: 'Plan the garden', labels: [{ id: 3, name: 'idea', color: 'cccccc' }] })];
  const table = worldRoutes({ issues: list, files: { 'board.config.json': JSON.stringify(s), 'theme.json': null, 'state/brief.json': null, 'state/calendar.json': null, 'state/inbox.json': null, 'state/log.json': null, 'state/proposals.json': null } });
  return async (url, init = {}) => {
    if (((init && init.method) || 'GET') !== 'GET') return fakeResponse(404, {});
    const u = new URL(String(url)); const key = u.pathname + u.search;
    if (key === `${R}/issues?state=all&per_page=100` || key.startsWith(`${R}/issues?state=all&per_page=100&since=`)) return fakeResponse(200, list);
    if (Object.prototype.hasOwnProperty.call(table, key)) return fakeResponse(200, table[key]);
    return fakeResponse(404, {});
  };
}
function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: reqPath, headers: { host: `localhost:${port}` }, agent: false }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(c) }));
    }).on('error', reject);
  });
}
async function withBoard(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-guide-data-'));
  let running = null;
  try {
    running = await start({ processEnv: { BOARD_GITHUB_TOKEN: 'SENTINEL-TOKEN-123', BOARD_REPO: 'sam-life/life', BOARD_PORT: '0', BOARD_DATA_DIR: dir, ...env }, fetch: makeFetch(), clock: { now: () => Date.parse('2026-10-12T06:10:00Z') }, log: () => {} });
    return await fn(running.address.port);
  } finally { if (running) await running.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("R173 the setting name and the three address shapes the guide names are the ones the server uses, with the guide's cache and 404 claims", async () => {
  const setting = /one setting, `([A-Z_]+)`/.exec(GUIDE)[1];
  const shapes = /serves your stylesheet at `([^`]+)`, your fonts under `([^`]+)` and your images under `([^`]+)`/.exec(GUIDE);
  assert.ok(shapes, 'the guide names the three shapes');
  const [, cssUrl, fontPrefix, imgPrefix] = shapes;
  assert.equal(setting, 'BOARD_SKIN_DIR');
  const dir = buildExample();
  await withBoard({ [setting]: dir }, async (port) => {
    const css = await get(port, cssUrl);
    assert.equal(css.status, 200);
    assert.equal(css.bytes.toString('utf8'), example.css, "the guide's css, served exactly");
    assert.equal(css.headers['cache-control'], 'no-store', 'the guide: the stylesheet is never kept');
    for (const [prefix, name] of [[fontPrefix, 'panel-sans.woff2'], [imgPrefix, 'grid.png']]) {
      const r = await get(port, prefix + name);
      assert.equal(r.status, 200, prefix + name);
      assert.equal(r.headers['cache-control'], 'private, max-age=3600', 'the guide: up to an hour');
    }
    assert.equal((await get(port, '/skin/other.css')).status, 404, 'the guide: any other address under /skin/ answers 404');
    const page = (await get(port, '/')).bytes.toString('utf8');
    assert.ok(page.includes('<link rel="stylesheet" href="/skin/skin.css">') && page.includes('<html lang="en" data-skin>'));
  });
  await withBoard({}, async (port) => {
    assert.equal((await get(port, cssUrl)).status, 404, 'the guide: with no skin loaded the address answers 404');
  });
  for (const blank of ['', '   ']) {
    await withBoard({ [setting]: blank }, async (port) => assert.equal((await get(port, cssUrl)).status, 404, 'unset, empty or only spaces means no skin'));
  }
});
