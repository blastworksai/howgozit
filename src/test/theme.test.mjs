import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, themeCss } from '../board/theme.mjs';
import { DEFAULT_THEME } from '../board/shape-settings.mjs';

const count = (res, code) => (res.warnings.find((w) => w.code === code) || { count: 0 }).count;

test('R76 four bad theme colours give four fallbacks and color-invalid 4', () => {
  const res = resolveTheme({
    colors: { ground: 'red', card: '#12345', ink: 'url(x)', accent: '#abc;}body{display:none' },
  });
  assert.equal(res.theme.colors.ground, DEFAULT_THEME.colors.ground);
  assert.equal(res.theme.colors.card, DEFAULT_THEME.colors.card);
  assert.equal(res.theme.colors.ink, DEFAULT_THEME.colors.ink);
  assert.equal(res.theme.colors.accent, DEFAULT_THEME.colors.accent);
  assert.equal(count(res, 'color-invalid'), 4);
});

test('R76 valid #RGB and #RRGGBB colours are kept without a warning', () => {
  const res = resolveTheme({ colors: { ground: '#abc', card: '#A1B2C3' } });
  assert.equal(res.theme.colors.ground, '#abc');
  assert.equal(res.theme.colors.card, '#A1B2C3');
  assert.deepEqual(res.warnings, []);
});

test('R76 a project colour list with a bad entry falls back whole and counts the bad ones', () => {
  const res = resolveTheme({ projectColors: ['#111', 'red', 'blue'] });
  assert.deepEqual(res.theme.projectColors, DEFAULT_THEME.projectColors);
  assert.equal(count(res, 'color-invalid'), 2);
  const ok = resolveTheme({ projectColors: ['#111', '#222222'] });
  assert.deepEqual(ok.theme.projectColors, ['#111', '#222222']);
  assert.deepEqual(resolveTheme({ projectColors: [] }).theme.projectColors, DEFAULT_THEME.projectColors);
});

test('R82 an accent colour reaches the variables', () => {
  const res = resolveTheme({ colors: { accent: '#123456' } });
  assert.equal(themeCss(res.theme).vars['--accent'], '#123456');
});

test('R82 a bad radius takes the default and no variable holds a closing brace', () => {
  const res = resolveTheme({ radius: '9px;}' });
  assert.equal(res.theme.radius, DEFAULT_THEME.radius);
  assert.equal(count(res, 'setting-invalid'), 1);
  const { vars } = themeCss(res.theme);
  assert.equal(vars['--radius'], `${DEFAULT_THEME.radius}px`);
  for (const v of Object.values(vars)) assert.ok(!v.includes('}'));
});

test('R82 radius accepts whole numbers 0 to 40 and nothing else', () => {
  assert.equal(themeCss(resolveTheme({ radius: 0 }).theme).vars['--radius'], '0px');
  assert.equal(themeCss(resolveTheme({ radius: 40 }).theme).vars['--radius'], '40px');
  for (const bad of [41, -1, 3.5, '12', null, NaN]) {
    assert.equal(resolveTheme({ radius: bad }).theme.radius, DEFAULT_THEME.radius, String(bad));
  }
});

test('R82 the variables carry exactly the pinned names and a complete theme', () => {
  const res = resolveTheme(null);
  assert.deepEqual(res.theme, {
    colors: { ...DEFAULT_THEME.colors },
    projectColors: [...DEFAULT_THEME.projectColors],
    fonts: { ...DEFAULT_THEME.fonts },
    radius: 20,
  });
  const { vars } = themeCss(res.theme);
  assert.deepEqual(Object.keys(vars).sort(), [
    '--accent', '--agent-bg', '--agent-ink', '--border', '--card', '--dot', '--faint',
    '--font-body', '--font-heading', '--font-mono', '--ground', '--hot', '--hot-ink',
    '--ink', '--muted', '--ok', '--radius',
  ]);
  assert.equal(vars['--font-heading'], '"Bricolage Grotesque", system-ui, sans-serif');
  assert.equal(vars['--font-body'], '"Geist", system-ui, sans-serif');
  assert.equal(vars['--font-mono'], '"Geist Mono", ui-monospace, monospace');
});

test('R84 source system gives no font address and no font hosts', () => {
  const css = themeCss(resolveTheme({ fonts: { source: 'system' } }).theme);
  assert.equal(css.fontHref, null);
  assert.equal(css.fontHosts, false);
  assert.equal(css.vars['--font-heading'], 'system-ui, sans-serif');
  assert.equal(css.vars['--font-body'], 'system-ui, sans-serif');
  assert.equal(css.vars['--font-mono'], 'ui-monospace, monospace');
});

test('R84 source google builds one address from the three validated families', () => {
  const css = themeCss(resolveTheme(null).theme);
  assert.equal(
    css.fontHref,
    'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@800&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap',
  );
  assert.equal(css.fontHosts, true);
});

test('R84 a family that tries to add a parameter falls back and font-invalid counts it', () => {
  const res = resolveTheme({ fonts: { heading: 'X&family=Evil' } });
  assert.equal(res.theme.fonts.heading, DEFAULT_THEME.fonts.heading);
  assert.equal(count(res, 'font-invalid'), 1);
  const css = themeCss(res.theme);
  assert.ok(!css.fontHref.includes('Evil'));
  assert.ok(!JSON.stringify(css.vars).includes('Evil'));
});

test('R84 a family over 40 characters or an unknown source falls back', () => {
  const res = resolveTheme({ fonts: { body: 'A'.repeat(41), source: 'cdn' } });
  assert.equal(res.theme.fonts.body, DEFAULT_THEME.fonts.body);
  assert.equal(res.theme.fonts.source, 'google');
  assert.equal(count(res, 'font-invalid'), 1);
  assert.equal(count(res, 'setting-invalid'), 1);
});

test('R85 an unreadable theme gives the default theme and one theme-unreadable', () => {
  const res = resolveTheme({ error: 'unreadable' });
  assert.deepEqual(res.theme, resolveTheme(null).theme);
  assert.deepEqual(res.warnings, [{ code: 'theme-unreadable', count: 1 }]);
});

test('R85 an absent theme gives the default theme and no warning', () => {
  const res = resolveTheme(null);
  assert.equal(res.theme.radius, 20);
  assert.deepEqual(res.warnings, []);
});

test('U hostile strings in every theme key leave no dangerous character in any output', () => {
  const hostile = [
    '"><script>alert(1)</script>', 'red;}body{display:none', 'url(http://evil.example/x)',
    'a\nb', 'x\\y', '{}', '9px;}', '#abc\n', 'X&family=Evil',
  ];
  const bad = /[<>{};()\\\n]/;
  for (const h of hostile) {
    const input = {
      colors: Object.fromEntries(Object.keys(DEFAULT_THEME.colors).map((k) => [k, h])),
      projectColors: [h, h],
      fonts: { source: h, heading: h, body: h, mono: h },
      radius: h,
    };
    const res = resolveTheme(input);
    const css = themeCss(res.theme);
    for (const [k, v] of Object.entries(css.vars)) assert.ok(!bad.test(v), `${k}=${v}`);
    // the pinned weights hold a ';' of their own, so only the rest of the address is swept
    assert.ok(!/[<>{}()\\\n]/.test(css.fontHref), css.fontHref);
    assert.ok(!css.fontHref.includes('Evil'));
  }
  // a hostile theme handed straight to themeCss is cleaned too
  const direct = themeCss({
    colors: { ground: 'url(x)' }, fonts: { heading: '};x', body: 'a\nb', mono: '<', source: 'google' }, radius: '};',
  });
  for (const v of Object.values(direct.vars)) assert.ok(!bad.test(v), v);
  assert.ok(!/[<>{}()\\\n]/.test(direct.fontHref));
});

test('U neither function throws or changes its input for odd values', () => {
  const frozen = Object.freeze({ colors: Object.freeze({ accent: '#123' }), radius: 5 });
  assert.doesNotThrow(() => resolveTheme(frozen));
  assert.equal(frozen.colors.accent, '#123');
  for (const odd of [undefined, 7, 'x', [], [1], { colors: 5, fonts: 'x', projectColors: 'y' }]) {
    assert.doesNotThrow(() => resolveTheme(odd));
    assert.doesNotThrow(() => themeCss(odd));
    assert.equal(Object.keys(resolveTheme(odd).theme).length, 4);
  }
  assert.equal(themeCss(undefined).vars['--radius'], '20px');
});
