// CP4 (SKILLS-76): work-mode chips. Written from R132 and R76 (references/contract.md) and
// reference/mapping-redesign/cp4-interface.md section 3e and 4b. Hand-made raw only; fixed now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, project, task, raw, resetNumbers, board } from '../fixtures/build.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme, } from '../board/theme.mjs';

const THEME = resolveTheme(null).theme;
const MUTED = THEME.colors.muted;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };

const warn = (b, code) => (b?.meta?.warnings ?? []).find((w) => w.code === code)?.count ?? 0;
const MODES = ['DO', 'THINK', 'REVIEW', 'LAUNCH'];

function make({ modes = MODES, labels = [], labelColors, theme = THEME, extraSettings = {} } = {}) {
  resetNumbers();
  const s = settings({ projects: [{ key: 'house', number: 3 }], ...(modes ? { modes } : {}), ...extraSettings });
  return board({
    settings: s,
    theme,
    raw: raw({
      projects: [project(3, 'House', [1])],
      issues: [task({ number: 1, title: 'Paint', labels })],
      ...(labelColors ? { labelColors } : {}),
    }),
  });
}
const render = (b) => renderPage(b, THEME, OPTS);
const unesc = (s) => s.replace(/&#x2F;/g, '/').replace(/&amp;/g, '&');
function chips(html) {
  return [...html.matchAll(/<span class="[^"]*\bmode-chip\b[^"]*\bmode-(\d+)\b[^"]*">([^<]*)<\/span>/g)]
    .map((m) => [Number(m[1]), m[2]]);
}
const styleBlock = (html) => (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i) ?? [])[1] ?? '';

// ---------- R132 on the board ----------

test('R132 a task\'s mode labels become next[].modes in the order of settings modes, as written there', () => {
  const b = make({ labels: ['think', ' do '] });
  assert.deepEqual(b.next[0].modes, [{ name: 'DO', n: 1 }, { name: 'THINK', n: 2 }]);
});

test('R132 a mode label repeated in other cases gives one chip', () => {
  const b = make({ labels: ['think', 'THINK', 'Think'] });
  assert.deepEqual(b.next[0].modes, [{ name: 'THINK', n: 2 }]);
});

test('R132 a label that is not a mode gives no chip', () => {
  const b = make({ labels: ['errands'] });
  assert.deepEqual(b.next[0].modes ?? [], []);
});

test('R132 the board lists every mode in order with its colour from labelColors', () => {
  const b = make({ labels: ['think'], labelColors: { think: '#1d76db' } });
  assert.deepEqual(b.modes.map((m) => [m.n, m.name]), [[1, 'DO'], [2, 'THINK'], [3, 'REVIEW'], [4, 'LAUNCH']]);
  assert.equal(b.modes[1].color, '#1d76db');
  for (const i of [0, 2, 3]) assert.equal(b.modes[i].color, MUTED, 'no colour known: the theme muted colour');
  assert.equal(warn(b, 'color-invalid'), 0, 'a missing colour falls back silently');
});

test('R132 a mode colour falls back to the resolved theme\'s muted colour', () => {
  const theme = resolveTheme({ colors: { muted: '#334455' } }).theme;
  const b = make({ labels: ['think'], theme });
  assert.equal(b.modes[0].color, '#334455');
});

test('R132 with no modes in settings the board has no modes key and no row has modes', () => {
  const b = make({ modes: null, labels: ['think'] });
  assert.equal('modes' in b, false);
  assert.equal('modes' in b.next[0], false);
});

// ---------- R76 ----------

test('R76 label colours 1d76db and zzz on two modes: #1d76db is used, the other falls back, color-invalid is 1', () => {
  const b = make({ modes: ['DO', 'THINK'], labels: ['think', 'do'], labelColors: { think: '#1d76db', do: '#zzz' } });
  assert.equal(b.modes.find((m) => m.name === 'THINK').color, '#1d76db');
  assert.equal(b.modes.find((m) => m.name === 'DO').color, MUTED);
  assert.equal(warn(b, 'color-invalid'), 1);
});

test('R76 a label colour that is not hex is never written into the page', () => {
  const b = make({ modes: ['DO'], labels: ['do'], labelColors: { do: '#zzz' } });
  const html = render(b);
  assert.ok(!html.includes('zzz'));
  assert.match(styleBlock(html), new RegExp('\\.mode-1\\{--mc:' + MUTED.replace('#', '#') + '\\}', 'i'));
});

// ---------- R132 on the page ----------

test('R132 What\'s next shows one chip per mode after the title, in modes order, with the mode name', () => {
  const b = make({ labels: ['think', 'do'], labelColors: { think: '#1d76db' } });
  const html = render(b);
  assert.deepEqual(chips(html), [[1, 'DO'], [2, 'THINK']]);
  assert.ok(html.indexOf('Paint') < html.indexOf('mode-chip'), 'chips sit after the title');
  assert.ok(html.includes('class="seat__line"'), 'title and chips share the seat__line wrapper');
});

test('R132 the nonce style block carries .mode-<n>{--mc:#hex} rules and the page has no inline style for them', () => {
  const b = make({ labels: ['think'], labelColors: { think: '#1d76db' } });
  const html = render(b);
  const css = styleBlock(html);
  assert.ok(css.includes('.mode-2{--mc:#1d76db}'), css);
  assert.ok(css.includes('.mode-1{--mc:' + MUTED + '}') || css.toLowerCase().includes('.mode-1{--mc:' + MUTED.toLowerCase() + '}'));
  assert.ok(!/style="[^"]*--mc/.test(html), 'no inline style');
  assert.ok(css.indexOf('.mode-2') > css.indexOf(':root'), 'after the root rule');
});

test('R132 a chip name is escaped', () => {
  const b = make({ modes: ['A&B', '<b>'], labels: ['a&b', '<b>'] });
  const html = render(b);
  assert.ok(html.includes('A&amp;B'));
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(!html.includes('<b>'));
});

test('R132 a task with no mode label has no chip even when settings name modes', () => {
  const b = make({ labels: [] });
  assert.deepEqual(chips(render(b)), []);
});

test('R132 with no modes the page equals the page without the label, and has no mode markup', () => {
  const withLabel = render(make({ modes: null, labels: ['think'] }));
  const without = render(make({ modes: null, labels: [] }));
  assert.equal(withLabel, without);
  assert.ok(!withLabel.includes('mode-chip'));
  assert.ok(!/\.mode-\d/.test(styleBlock(withLabel)));
});
