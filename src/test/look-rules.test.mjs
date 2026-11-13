// The look rules of the signed board: R175 (the text on the accent is derived), R176 (timeline labels are
// placed so that none covers another label, a dot or the Today line), R177 (brief lines in capitals by the
// stylesheet, a long name is one highlight per word). Written from references/contract.md, before the
// renderer, the stylesheet and the theme module follow it. R178 is below as well.
//
// The checks here are independent of the renderer: R175 recomputes the WCAG contrast itself, and R176
// re-derives every guarantee from the classes, positions and label texts the page writes, never by running
// the placement algorithm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderPage } from '../board/render/page.mjs';
import { resolveTheme, themeCss } from '../board/theme.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const loadJson = (rel) => JSON.parse(readFileSync(here(rel), 'utf8'));
const FULL = loadJson('../fixtures/board/page.board.json');
const CSS = readFileSync(here('../board/static/board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const copy = (b) => JSON.parse(JSON.stringify(b));
const count = (s, re) => (s.match(re) || []).length;

const render = (b, themeInput = null) => renderPage(b, resolveTheme(themeInput).theme, OPTS);
const styleBlock = (html) => (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i) || [, ''])[1];
const rootVars = (html) => {
  const root = (styleBlock(html).match(/:root\s*\{([^}]*)\}/) || [, ''])[1];
  return Object.fromEntries([...root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]*);/g)].map((m) => [m[1], m[2].trim()]));
};

// ---------- R175 ----------

// The WCAG ratio of the contract, written out here on purpose.
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const DEFAULT_GROUND = '#131415';
const DEFAULT_INK = '#ECEDED';
const onAccent = (colors) => {
  const theme = resolveTheme({ colors }).theme;
  return themeCss(theme).vars['--on-accent'];
};

test('R175 the contract\'s two example accents are worked out by the WCAG formula and agree with the contract', () => {
  // Hand values of the contract: #1D3557 is very dark so the ink wins, #F2B632 is light so the ground wins.
  assert.ok(ratio('#1D3557', DEFAULT_INK) > ratio('#1D3557', DEFAULT_GROUND));
  assert.ok(ratio('#F2B632', DEFAULT_GROUND) > ratio('#F2B632', DEFAULT_INK));
  // The default accent: ground 9.77 to 1 against ink 1.61 to 1.
  assert.equal(ratio('#4FD1B5', DEFAULT_GROUND).toFixed(2), '9.77');
  assert.equal(ratio('#4FD1B5', DEFAULT_INK).toFixed(2), '1.61');
});

test('R175 the default theme gives --on-accent the ground colour', () => {
  assert.equal(themeCss(resolveTheme(null).theme).vars['--on-accent'], '#131415');
  assert.equal(rootVars(render(FULL))['--on-accent'], '#131415');
});

test('R175 a very dark accent gives the ink colour', () => {
  assert.equal(onAccent({ accent: '#1D3557' }), '#ECEDED');
});

test('R175 a light accent gives the ground colour', () => {
  assert.equal(onAccent({ accent: '#F2B632' }), '#131415');
});

test('R175 the choice follows the colour values and not the key names', () => {
  // ground and ink swapped in value: the light value now sits under the key ground
  const swapped = { ground: DEFAULT_INK, ink: DEFAULT_GROUND };
  assert.equal(onAccent({ ...swapped, accent: '#4FD1B5' }), DEFAULT_GROUND, 'light accent against swapped keys');
  assert.equal(onAccent({ ...swapped, accent: '#1D3557' }), DEFAULT_INK, 'dark accent against swapped keys');
  // the page carries the same value as the module
  const html = render(FULL, { colors: { ...swapped, accent: '#1D3557' } });
  assert.equal(rootVars(html)['--on-accent'], DEFAULT_INK);
});

test('R175 the value is the chosen colour exactly as the resolved theme holds it', () => {
  assert.equal(onAccent({ ground: '#FFF', ink: '#000', accent: '#00F' }), '#FFF');
  assert.equal(onAccent({ ground: '#fff', ink: '#000', accent: '#00f' }), '#fff');
  assert.equal(onAccent({ ground: '#000', ink: '#abcdef', accent: '#101010' }), '#abcdef');
});

test('R175 a #RGB colour is read as #RRGGBB', () => {
  // #1d3557 written short cannot be formed; use a short colour with a known long form
  assert.equal(onAccent({ ground: '#000', ink: '#FFF', accent: '#ffcc00' }), '#000');
  assert.equal(onAccent({ ground: '#000', ink: '#FFF', accent: '#fc0' }), '#000');
  assert.equal(onAccent({ ground: '#000', ink: '#FFF', accent: '#006' }), '#FFF');
  assert.equal(onAccent({ ground: '#000', ink: '#FFF', accent: '#000066' }), '#FFF');
});

test('R175 on a tie the ink wins: equal contrasts take the ink colour, whichever key holds which spelling', () => {
  // A tie needs two colours of exactly one relative luminance; two spellings of one colour are such a pair.
  assert.equal(ratio('#abc', '#4FD1B5'), ratio('#AABBCC', '#4FD1B5'), 'the two spellings really tie');
  assert.equal(onAccent({ ground: '#abc', ink: '#AABBCC', accent: '#4FD1B5' }), '#AABBCC');
  assert.equal(onAccent({ ground: '#AABBCC', ink: '#abc', accent: '#4FD1B5' }), '#abc');
  // the same on a dark accent, where the tie is at the low end
  assert.equal(ratio('#789', '#1D3557'), ratio('#778899', '#1D3557'));
  assert.equal(onAccent({ ground: '#789', ink: '#778899', accent: '#1D3557' }), '#778899');
  // the same colour in both keys is a tie too and gives that colour
  assert.equal(onAccent({ ground: '#808080', ink: '#808080', accent: '#4FD1B5' }), '#808080');
});

test('R175 a bad colour that fell back counts as its default', () => {
  // a bad accent is the default accent (light teal), so the ground wins; a bad ground is the default ground
  assert.equal(onAccent({ accent: 'red' }), '#131415');
  assert.equal(onAccent({ ground: 'url(x)', ink: '#FFFFFF', accent: '#4FD1B5' }), '#131415');
  assert.equal(onAccent({ ink: 'blue', accent: '#1D3557' }), '#ECEDED');
});

test('R175 a key of that name in a theme file is ignored and the page holds one --on-accent', () => {
  const res = resolveTheme({ onAccent: '#FF0000', colors: { onAccent: '#FF0000', accent: '#1D3557' }, '--on-accent': '#FF0000' });
  const css = themeCss(res.theme);
  assert.equal(css.vars['--on-accent'], '#ECEDED');
  assert.equal(res.warnings.length, 0, 'no warning for an ignored key');
  const html = render(FULL, { onAccent: '#FF0000', colors: { onAccent: '#FF0000' } });
  assert.equal(count(styleBlock(html), /--on-accent\s*:/g), 1);
  assert.equal(rootVars(html)['--on-accent'], '#131415');
  assert.ok(!html.includes('#FF0000'), 'the ignored colour is written nowhere');
});

// ---------- R176 ----------

const PX = (n) => (n / 772) * 100;
const clash = (a, b, margin = 3) => a[0] < b[1] + PX(margin) && b[0] < a[1] + PX(margin);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// A window of exactly 100 days, so a milestone d days after the start sits at x-d.
const WINDOW = { start: '2026-09-01', end: '2026-12-09' };
const dayOf = (d) => {
  const t = Date.UTC(2026, 8, 1) + d * 86400000;
  return new Date(t).toISOString().slice(0, 10);
};
const ms = (n, d, title, over = {}) => ({
  number: n, shortTitle: title, url: 'https://github.com/sam-life/life/milestone/' + n,
  due: dayOf(d), state: 'open', done: 1, total: 4, pct: 25, ...over,
});

// A board whose timeline holds exactly the given lane milestones and Today at day `today`.
function timelineBoard(milestones, today, extra = {}) {
  const b = copy(FULL);
  const lane = copy(FULL.timeline.lanes[0]);
  lane.milestones = milestones;
  lane.undated = [];
  lane.beforeWindow = 0;
  lane.beyondWindow = 0;
  b.timeline = { ...WINDOW, today: dayOf(today), lanes: [lane], other: [], ...extra };
  return b;
}

// The dots of the first lane of the timeline: position, band, side, label, title, aria-label.
function laneDots(html) {
  const sec = html.slice(html.indexOf('data-section="timeline"'));
  const laneStart = sec.indexOf('class="tl-lane');
  assert.ok(laneStart > 0, 'the timeline has a lane');
  const rest = sec.slice(laneStart);
  const laneEnd = rest.indexOf('<p class="tl-legend');
  const lane = laneEnd > 0 ? rest.slice(0, laneEnd) : rest;
  const dots = [];
  const re = /<(a|span)\s+class="([^"]*\btl-dot\b[^"]*)"([^>]*)>(?:<span class="tl-dot__label">([^<]*)<\/span>)?<\/\1>/g;
  for (const m of lane.matchAll(re)) {
    const cls = m[2].split(/\s+/);
    const x = cls.find((c) => /^x-\d/.test(c));
    assert.ok(x, 'a dot carries x-<n>: ' + m[0]);
    const band = cls.map((c) => /^tl-dot--b(\d)$/.exec(c)).find(Boolean);
    const title = (/\stitle="([^"]*)"/.exec(m[3]) || [])[1];
    const aria = (/\saria-label="([^"]*)"/.exec(m[3]) || [])[1];
    dots.push({
      tag: m[1], cls, attrs: m[3], p: Number(x.slice(2).replace('_', '.')),
      band: band ? Number(band[1]) : 0, left: cls.includes('tl-dot--left'), bare: cls.includes('tl-dot--bare'),
      label: m[4] === undefined ? null : decode(m[4]), title: title === undefined ? null : decode(title),
      aria: aria === undefined ? null : decode(aria), raw: m[0],
    });
  }
  const today = (/<i class="tl-today (x-[0-9_]+)"/.exec(lane) || [])[1];
  const plot = (/class="(tl-plot[^"]*)"/.exec(lane) || [])[1] || '';
  return { dots, todayP: today ? Number(today.slice(2).replace('_', '.')) : null, plot, lane };
}

// The label box of a dot, or null when it has none.
function labelBox(d) {
  if (d.label === null) return null;
  const w = Math.min(150, 8 * d.label.length + 8);
  return d.left ? [d.p - PX(22 + w), d.p - PX(22)] : [d.p + PX(22), d.p + PX(22 + w)];
}
const dotBox = (d) => [d.p - PX(7), d.p + PX(7)];

test('R176 four milestones within 5 percent, two on one date, Today 20 percent away: every dot is labelled or bare, and nothing is covered', () => {
  const milestones = [
    ms(1, 61, 'Alpha'), ms(2, 61, 'Beta'), ms(3, 62, 'Gamma'), ms(4, 64, 'Delta'),
  ];
  const b = timelineBoard(milestones, 42);
  const html = render(b);
  const { dots, todayP } = laneDots(html);
  assert.equal(dots.length, 4, 'every milestone has a dot');
  assert.ok(todayP !== null && Math.abs(todayP - 61) >= 18 && Math.abs(todayP - 61) <= 22, 'today is about 20 percent away');
  for (const d of dots) {
    assert.ok(d.label !== null || d.bare, 'a dot has a label element or is bare: ' + d.raw);
    if (d.bare) assert.equal(d.label, null, 'a bare dot has no label element');
    assert.ok(d.title && d.aria, 'every dot carries title and aria-label: ' + d.raw);
    assert.ok(/^(Alpha|Beta|Gamma|Delta)/.test(d.title) && d.title.includes('2026-'), 'title holds the short title and the date: ' + d.title);
    assert.ok(/^(Alpha|Beta|Gamma|Delta)/.test(d.aria) && d.aria.includes('2026-'), 'aria-label holds the short title and the date: ' + d.aria);
  }
  // placement order of the contract: position, then date, then label text
  const order = [...dots].sort((a, c) => a.p - c.p || String(a.title).localeCompare(String(c.title)));
  const seen = [];
  for (const d of order) {
    for (const o of seen) {
      if (o.band !== d.band) continue;
      const lb = labelBox(d);
      const olb = labelBox(o);
      if (lb && olb) assert.ok(!clash(lb, olb), `labels of ${d.title} and ${o.title} clash in band ${d.band}`);
      if (lb) assert.ok(!clash(lb, dotBox(o)), `label of ${d.title} covers the dot of ${o.title}`);
      if (!d.bare || d.band < 3) assert.ok(!(Math.abs(d.p - o.p) < 1e-9 && o.band === d.band), `two dots at one position in band ${d.band}`);
    }
    const lb = labelBox(d);
    if (lb) {
      assert.ok(lb[0] >= 0 && lb[1] <= 100, `label of ${d.title} lies inside the plot`);
      const today = [todayP - PX(5), todayP + PX(5)];
      assert.ok(!(lb[0] < today[1] && today[0] < lb[1]), `label of ${d.title} overlaps the Today line`);
    }
    seen.push(d);
  }
  // the same band bookkeeping, as the page states it
  const top = Math.max(...dots.map((d) => d.band));
  const { plot } = laneDots(html);
  if (top > 0) assert.ok(plot.split(/\s+/).includes('tl-bands-' + (top + 1)), `the plot carries tl-bands-${top + 1}: ${plot}`);
  else assert.ok(!/tl-bands-/.test(plot));
});

test('R176 one milestone at 50 percent with room is in band 0 with its label on the right', () => {
  const html = render(timelineBoard([ms(1, 50, 'Alpha')], 10));
  const { dots, plot } = laneDots(html);
  assert.equal(dots.length, 1);
  const d = dots[0];
  assert.equal(d.p, 50);
  assert.ok(!d.cls.some((c) => /^tl-dot--b\d$/.test(c)), 'no tl-dot--b class');
  assert.ok(!d.cls.includes('tl-dot--left'), 'no tl-dot--left class');
  assert.equal(d.label, 'Alpha 25%');
  assert.ok(!/tl-bands-/.test(plot), 'a lane of one band carries no tl-bands class');
});

test('R176 one milestone at 98 percent has its label on the left', () => {
  const { dots } = laneDots(render(timelineBoard([ms(1, 98, 'Alpha')], 10)));
  assert.equal(dots.length, 1);
  assert.equal(dots[0].p, 98);
  assert.ok(dots[0].cls.includes('tl-dot--left'));
  assert.equal(dots[0].label, 'Alpha 25%');
  assert.ok(!dots[0].cls.some((c) => /^tl-dot--b\d$/.test(c)));
});

test('R176 Today at 52 percent and a milestone at 49 percent: the label goes on the left, clear of the Today line', () => {
  const { dots, todayP } = laneDots(render(timelineBoard([ms(1, 49, 'Alpha')], 52)));
  assert.equal(todayP, 52);
  assert.equal(dots.length, 1);
  assert.ok(dots[0].cls.includes('tl-dot--left'));
  assert.ok(!dots[0].cls.some((c) => /^tl-dot--b\d$/.test(c)), 'still in band 0');
  assert.equal(dots[0].label, 'Alpha 25%');
});

test('R176 two milestones on one date: the second is in band 1 (tl-dot--b1) with its label on the right', () => {
  const { dots, plot } = laneDots(render(timelineBoard([ms(1, 50, 'Alpha'), ms(2, 50, 'Beta')], 10)));
  assert.equal(dots.length, 2);
  const [first, second] = [...dots].sort((a, c) => String(a.title).localeCompare(String(c.title)));
  assert.ok(first.title.startsWith('Alpha') && second.title.startsWith('Beta'));
  assert.equal(first.band, 0);
  assert.equal(second.band, 1);
  assert.ok(second.cls.includes('tl-dot--b1'));
  assert.ok(!second.cls.includes('tl-dot--left'), 'label on the right');
  assert.equal(second.label, 'Beta 25%');
  assert.ok(plot.split(/\s+/).includes('tl-bands-2'), 'the plot carries tl-bands-2: ' + plot);
});

test('R176 five milestones on one date: four in bands 0 to 3 with labels, the fifth tl-dot--bare in band 3 with its text in title and aria-label', () => {
  const titles = ['Alpha', 'Beta', 'Cedar', 'Delta', 'Ember'];
  const { dots, plot } = laneDots(render(timelineBoard(titles.map((t, i) => ms(i + 1, 50, t)), 10)));
  assert.equal(dots.length, 5);
  const byTitle = Object.fromEntries(dots.map((d) => [d.title.split(' ')[0], d]));
  titles.slice(0, 4).forEach((t, i) => {
    assert.equal(byTitle[t].band, i, t + ' band');
    assert.equal(byTitle[t].label, t + ' 25%', t + ' label');
    assert.ok(!byTitle[t].bare);
  });
  const fifth = byTitle.Ember;
  assert.ok(fifth.bare, 'tl-dot--bare');
  assert.equal(fifth.band, 3);
  assert.ok(fifth.cls.includes('tl-dot--b3'));
  assert.equal(fifth.label, null, 'no label element');
  assert.ok(!/tl-dot__label/.test(fifth.raw));
  assert.ok(fifth.title.includes('Ember') && fifth.title.includes('2026-'));
  assert.ok(fifth.aria.includes('Ember') && fifth.aria.includes('2026-'));
  assert.ok(plot.split(/\s+/).includes('tl-bands-4'), 'the plot carries tl-bands-4: ' + plot);
});

test('R176 a dot with a link is an a and one without is a span with role="img"', () => {
  const linked = ms(1, 30, 'Alpha');
  const bare = ms(2, 70, 'Beta', { url: null });
  const { dots } = laneDots(render(timelineBoard([linked, bare], 10)));
  const a = dots.find((d) => d.title.startsWith('Alpha'));
  const s = dots.find((d) => d.title.startsWith('Beta'));
  assert.equal(a.tag, 'a');
  assert.ok(/\shref="https:\/\/github\.com\//.test(a.attrs));
  assert.equal(s.tag, 'span');
  assert.ok(/\srole="img"/.test(s.attrs), 'span dot carries role="img": ' + s.raw);
  assert.ok(a.aria && s.aria, 'both carry aria-label');
});

test('R176 the stylesheet hides .tl-dot__label in one @container (max-width: 961px) rule and the renderer, not the stylesheet, places labels', () => {
  const blocks = [...CSS.matchAll(/@container\s*\(\s*max-width\s*:\s*961px\s*\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  assert.equal(blocks.length, 1, 'exactly one @container (max-width: 961px)');
  assert.ok(/\.tl-dot__label\s*\{[^}]*display\s*:\s*none/.test(blocks[0][1]), 'it hides .tl-dot__label');
});

// R176 geometry. The renderer's constants are not exported, so they are pinned by behaviour on a window of
// 1000 days (a milestone d days after the start sits at x-<d/10>, a step of 0.1 percent = 0.772 px).
const WIDE = { start: '2026-01-01', end: '2028-09-26' };
const dayN = (d) => new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10);
const msW = (n, d, title) => ({
  number: n, shortTitle: title, url: 'https://github.com/sam-life/life/milestone/' + n,
  due: dayN(d), state: 'open', done: 1, total: 4, pct: 25,
});
function wideBoard(milestones, todayDay = 100) {
  const b = copy(FULL);
  const lane = copy(FULL.timeline.lanes[0]);
  lane.milestones = milestones;
  lane.undated = [];
  lane.beforeWindow = 0;
  lane.beyondWindow = 0;
  b.timeline = { ...WIDE, today: dayN(todayDay), lanes: [lane], other: [], ...{} };
  return b;
}
const wideDots = (milestones) => laneDots(render(wideBoard(milestones))).dots;

test('R176 the renderer\'s label offset is 22 pixels from the dot centre: a label that fits on the right with 22 goes right, one that would not goes left', () => {
  // label "Alpha 25%" is 9 characters, so 80 px wide; the right label fits when p + (22 + 80) / 7.72 <= 100, p <= 86.79
  const right = wideDots([msW(1, 867, 'Alpha')]);
  assert.equal(right[0].p, 86.7);
  assert.ok(!right[0].left, 'at 86.7 percent a 22 px offset leaves room on the right (a 23 px offset would not)');
  const left = wideDots([msW(1, 868, 'Alpha')]);
  assert.equal(left[0].p, 86.8);
  assert.ok(left[0].left, 'at 86.8 percent a 22 px offset leaves no room on the right (a 21 px offset would)');
});

test('R176 the renderer\'s dot box is 7 pixels each side: two dots 2.3 percent apart share band 0, two 2.1 percent apart do not', () => {
  // clash needs a distance under 14 + 3 = 17 px = 2.202 percent (half 6 gives 1.94 percent, half 8 gives 2.46 percent)
  const apart = wideDots([msW(1, 400, 'Alpha'), msW(2, 423, 'Beta')]);
  assert.deepEqual(apart.map((d) => d.band), [0, 0], '2.3 percent apart: no clash');
  const near = wideDots([msW(1, 400, 'Alpha'), msW(2, 421, 'Beta')]);
  const second = near.find((d) => d.title.startsWith('Beta'));
  assert.equal(second.band, 1, '2.1 percent apart: the second dot goes to band 1');
});

test('R176 the renderer\'s largest label width is 150 pixels', () => {
  // a 40-character label is capped at 150 px; the right label fits when p <= 100 - (22 + 150) / 7.72 = 77.72
  const long = 'abcdefghijklmnopqrstuvwxyzabcdefghij';
  const fits = wideDots([msW(1, 774, long)]);
  assert.equal(fits[0].p, 77.4);
  assert.ok(!fits[0].left, 'at 77.4 percent a 150 px label fits on the right (a 160 px cap would not)');
  const noRoom = wideDots([msW(1, 783, long)]);
  assert.equal(noRoom[0].p, 78.3);
  assert.ok(noRoom[0].left, 'at 78.3 percent a 150 px label does not fit on the right (a 140 px cap would)');
});

// The declarations of every rule in the stylesheet whose selector list holds exactly `sel` (spaces normalised).
function cssDecls(sel) {
  const out = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')).includes(sel)) {
      for (const d of m[2].split(';')) {
        const k = d.indexOf(':');
        if (k > 0) out.push([d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim().replace(/\s+/g, ' ')]);
      }
    }
  }
  return out;
}
const hasDecl = (sel, prop, value) => cssDecls(sel).some(([k, v]) => k === prop && v === value);

test('R176 board.css places the label 22 pixels from the dot centre and gives the dot 14px and the label a 150px cap', () => {
  assert.ok(hasDecl('.tl-dot', 'width', '14px'), '.tl-dot width: 14px');
  assert.ok(hasDecl('.tl-dot__label', 'left', 'calc(50% + 22px)'), '.tl-dot__label left: calc(50% + 22px)');
  assert.ok(hasDecl('.tl-dot__label', 'max-width', '150px'), '.tl-dot__label max-width: 150px');
  assert.ok(hasDecl('.tl-dot--left .tl-dot__label', 'right', 'calc(50% + 22px)'), 'left label: right: calc(50% + 22px)');
  assert.ok(hasDecl('.tl-dot--left .tl-dot__label', 'left', 'auto'), 'left label: left: auto');
});

// ---------- R177 ----------

const briefBoard = (text) => {
  const b = copy(FULL);
  b.panels.brief = { ...b.panels.brief, lines: [{ src: 'CAL', text }] };
  return b;
};
const header = (html) => html.slice(html.indexOf('<header'), html.indexOf('</header>'));
const withName = (name) => {
  const b = copy(FULL);
  b.meta.name = name;
  return header(render(b));
};
const h1Of = (h) => (/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(h) || [, ''])[1];

test('R177 a brief line is written exactly as the agent wrote it and is never upper-cased in the page', () => {
  const html = render(briefBoard('Review the budget'));
  const sec = html.slice(html.indexOf('data-section="brief"'));
  const line = /<span class="brief__text">([^<]*)<\/span>/.exec(sec);
  assert.ok(line, 'the brief line sits in an element of the class brief__text');
  assert.equal(line[1], 'Review the budget');
  assert.ok(!html.includes('REVIEW THE BUDGET'), 'REVIEW THE BUDGET is nowhere in the page');
});

test('R177 the stylesheet shows brief__text in capitals with one text-transform: uppercase declaration', () => {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /brief__text/.test(m[1]) && /text-transform\s*:\s*uppercase/.test(m[2]));
  assert.equal(rules.length, 1, 'one rule whose selector holds brief__text declares text-transform: uppercase');
  assert.equal(count(rules[0][2], /text-transform\s*:\s*uppercase/g), 1);
});

test('R177 a short name is one hl element followed by U+2060 and the full stop', () => {
  assert.ok(h1Of(withName('Sam')).includes('<span class="hl">Sam</span>&#8288;.'), h1Of(withName('Sam')));
  assert.equal(count(h1Of(withName('Sam')), /class="hl"/g), 1);
});

test('R177 a name of more than 14 characters with spaces is one hl element per word, joined by single spaces', () => {
  const h = h1Of(withName('Anna Maria Van Der Berg'));
  const plates = '<span class="hl">Anna</span> <span class="hl">Maria</span> <span class="hl">Van</span> <span class="hl">Der</span> <span class="hl">Berg</span>&#8288;.';
  assert.ok(h.includes(plates), h);
  assert.equal(count(h, /class="hl"/g), 5);
  // empty words are dropped
  const spaced = h1Of(withName('Anna  Maria Van Der Berg'));
  assert.ok(spaced.includes(plates), spaced);
});

test('R177 a long name with no space is one hl element, and the boundary is 14 characters', () => {
  const one = h1Of(withName('Wolfeschlegelsteinhausenbergerdorff'));
  assert.equal(count(one, /class="hl"/g), 1);
  assert.ok(one.includes('<span class="hl">Wolfeschlegelsteinhausenbergerdorff</span>&#8288;.'), one);
  // 14 characters with a space stay whole, 15 split
  assert.equal(count(h1Of(withName('Anna Maria Van')), /class="hl"/g), 1);
  assert.equal(count(h1Of(withName('Anna Maria Vand')), /class="hl"/g), 3);
});

test('R177 the full stop follows the last hl element after U+2060 and the greeting holds no other stop', () => {
  for (const name of ['Sam', 'Anna Maria Van Der Berg']) {
    const h = h1Of(withName(name));
    assert.ok(/<\/span>&#8288;\.\s*$/.test(h), 'ends with </span>&#8288;. : ' + h);
    assert.equal(count(h, /&#8288;/g), 1);
  }
});

test('R177 every word is escaped and the angle brackets stay inside their hl element', () => {
  const h = h1Of(withName('<b> and Co of Long'));
  assert.ok(h.includes('<span class="hl">&lt;b&gt;</span>'), h);
  assert.equal(count(h, /class="hl"/g), 5);
  assert.ok(!/<b>/.test(h), 'no raw <b>');
});

// R177, the fit rule: lw is the length of the longest hl word as written.
const fitRule = (lw) => `@media (max-width:480px){.header__title.fit-${lw}{font-size:max(18px,min(40px,calc((100vw - 32px) / ${(lw * 0.66).toFixed(2)})))}}`;
const pageWithName = (name) => {
  const b = copy(FULL);
  b.meta.name = name;
  return render(b);
};
const titleClasses = (html) => ((/<h1\b[^>]*\sclass="([^"]*)"/.exec(html) || [, ''])[1]).split(/\s+/);
const fitClasses = (html) => titleClasses(html).filter((c) => /^fit-/.test(c));

test('R177 a name whose longest word is 13 characters or less has no fit- class and the nonce block holds no fit rule', () => {
  for (const name of ['Sam', 'Abcdefghijklm', 'Anna Maria Van Der Berg']) {
    const html = pageWithName(name);
    assert.deepEqual(fitClasses(html), [], name);
    assert.ok(!/fit-/.test(styleBlock(html)), 'no fit rule for ' + name);
    assert.ok(!/@media/.test(styleBlock(html)), 'no @media in the block for ' + name);
  }
});

test('R177 the 35-character name gives fit-35 on the title and exactly one rule in the nonce block, with 23.10', () => {
  const html = pageWithName('Wolfeschlegelsteinhausenbergerdorff');
  assert.deepEqual(fitClasses(html), ['fit-35']);
  const block = styleBlock(html);
  assert.ok(block.includes('@media (max-width:480px){.header__title.fit-35{font-size:max(18px,min(40px,calc((100vw - 32px) / 23.10)))}}'), block);
  assert.equal(count(block, /fit-35\{/g), 1);
  assert.equal(count(block, /@media/g), 1);
});

test('R177 a 14-character name with no space gives fit-14 and the divisor 9.24', () => {
  const html = pageWithName('Abcdefghijklmn');
  assert.deepEqual(fitClasses(html), ['fit-14']);
  assert.ok(styleBlock(html).includes('@media (max-width:480px){.header__title.fit-14{font-size:max(18px,min(40px,calc((100vw - 32px) / 9.24)))}}'));
});

test('R177 a split name takes lw from its longest word and each page holds only its own rule', () => {
  const split = pageWithName('Christopher Wolfeschlegelstein');
  const lw = 'Wolfeschlegelstein'.length;
  assert.deepEqual(fitClasses(split), ['fit-' + lw]);
  assert.ok(styleBlock(split).includes(fitRule(lw)));
  assert.equal(count(styleBlock(split), /@media/g), 1);
  const other = pageWithName('Wolfeschlegelsteinhausenbergerdorff');
  assert.ok(!styleBlock(other).includes('fit-' + lw + '{'), 'the other page holds only its own rule');
  assert.ok(styleBlock(other).includes(fitRule(35)));
  assert.ok(!styleBlock(pageWithName('Sam')).includes('fit-'));
});

test('R177 a name of 200,000 single-letter words renders the page with no fit- class', () => {
  const name = Array(200000).fill('a').join(' ');
  const b = copy(FULL);
  b.meta.name = name;
  const html = render(b);
  assert.equal(typeof html, 'string');
  assert.ok(html.includes('data-section="header"'));
  assert.ok(!html.includes('fit-'), 'the longest word has 1 character: no fit- class and no fit- rule');
});

test('R177 a single word of 5,000 characters gives fit-5000 on the title and one rule in the nonce block', () => {
  const b = copy(FULL);
  b.meta.name = 'a'.repeat(5000);
  const html = render(b);
  assert.deepEqual(fitClasses(html), ['fit-5000']);
  const block = styleBlock(html);
  assert.ok(block.includes(fitRule(5000)));
  assert.equal(block.split('.header__title.fit-5000{').length - 1, 1);
});

// ---------- R178 ----------

// Events at one time: the calendar panel of the fixture, replaced by the given events.
function calendarBoard(events) {
  const b = copy(FULL);
  b.panels.calendar = { ...b.panels.calendar, events };
  return b;
}
const stamp = (i) => ({ title: 'Meeting ' + i, start: '10:00', end: '11:00', kind: 'meeting' });
// A decimal number with at most three decimals and no trailing zeros.
const dec = (n) => String(Number(n.toFixed(3)));
// The contract's one rule form: `.cal-event.cal-lane-<i>of<n>{left:<L>;width:<W>%}`, the first lane's left is `0`.
const laneRule = (i, n) => `.cal-event.cal-lane-${i}of${n}{left:${i === 1 ? '0' : dec(((i - 1) * 100) / n) + '%'};width:${dec(100 / n)}%}`;
// Every lane rule the block holds, and every mention of a lane class in it.
const laneRules = (block) => [...block.matchAll(/[^{}]*cal-lane-[^{}]*\{[^{}]*\}/g)].map((m) => m[0].trim());

test('R178 five events at one time carry cal-lane-1of5 to cal-lane-5of5 and the nonce block holds exactly the five rules of the contract', () => {
  const html = render(calendarBoard([1, 2, 3, 4, 5].map(stamp)));
  const block = styleBlock(html);
  for (let i = 1; i <= 5; i++) assert.ok(new RegExp(`class="[^"]*\\bcal-lane-${i}of5\\b`).test(html), 'event class ' + i);
  assert.deepEqual(laneRules(block), [1, 2, 3, 4, 5].map((i) => laneRule(i, 5)));
  assert.equal(laneRule(1, 5), '.cal-event.cal-lane-1of5{left:0;width:20%}');
  assert.equal(laneRule(5, 5), '.cal-event.cal-lane-5of5{left:80%;width:20%}');
  assert.ok(!/cal-lane-/.test(CSS), 'the stylesheet holds no rule for a lane class');
});

test('R178 three events at one time give left:33.333% and width:33.333% for the second, eight give width:12.5%', () => {
  const three = styleBlock(render(calendarBoard([1, 2, 3].map(stamp))));
  assert.ok(three.includes('.cal-event.cal-lane-2of3{left:33.333%;width:33.333%}'), three);
  assert.deepEqual(laneRules(three), [1, 2, 3].map((i) => laneRule(i, 3)));
  const eight = styleBlock(render(calendarBoard([1, 2, 3, 4, 5, 6, 7, 8].map(stamp))));
  assert.ok(eight.includes('.cal-event.cal-lane-8of8{left:87.5%;width:12.5%}'), eight);
  assert.deepEqual(laneRules(eight), [1, 2, 3, 4, 5, 6, 7, 8].map((i) => laneRule(i, 8)));
});

test('R178 events that do not overlap, or only touch, carry no cal-lane class and the nonce block holds no such rule', () => {
  const apart = [
    { title: 'A', start: '08:00', end: '09:00', kind: 'meeting' },
    { title: 'B', start: '10:00', end: '11:00', kind: 'meeting' },
  ];
  assert.ok(!/cal-lane-/.test(render(calendarBoard(apart))), 'apart');
  const touching = [
    { title: 'A', start: '09:00', end: '10:00', kind: 'meeting' },
    { title: 'B', start: '10:00', end: '11:00', kind: 'meeting' },
  ];
  assert.ok(!/cal-lane-/.test(render(calendarBoard(touching))), 'touching boxes are not one cluster');
});

test('R178 the day body carries cal-h-<N> and the nonce block holds exactly the one rule for it', () => {
  const html = render(calendarBoard([1, 2].map(stamp)));
  const m = /<div class="cal-body cal-h-(\d+)">/.exec(html);
  assert.ok(m, 'the day body is <div class="cal-body cal-h-<N>">');
  const n = m[1];
  const block = styleBlock(html);
  assert.ok(block.includes(`.cal-h-${n}{height:calc(var(--cal-hour) * ${n})}`), block);
  assert.equal(count(block, /\.cal-h-\d+\{/g), 1);
  assert.ok(!/--cal-hour\s*:/.test(block), '--cal-hour is a token of the stylesheet, not of the theme');
});

test('R178 a calendar with no timed event has no day body and no cal-h- class or rule', () => {
  const html = render(calendarBoard([]));
  assert.ok(!/cal-h-/.test(html));
  assert.ok(!/class="cal-body/.test(html));
});
