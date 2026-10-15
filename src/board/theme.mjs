// Turns a theme file into a complete, safe theme and then into CSS variables.
// Pure: no clock, no file, no network, no environment. Never throws, never changes its input.
import { DEFAULT_THEME, isHexColor } from './shape-settings.mjs';

const FONT_RE = /^[A-Za-z0-9 ]{1,40}$/;
const COLOR_KEYS = Object.keys(DEFAULT_THEME.colors);
const FONT_ROLES = ['heading', 'body', 'mono'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const isFontName = (v) => typeof v === 'string' && FONT_RE.test(v) && v.trim().length > 0;

function defaults() {
  return {
    colors: { ...DEFAULT_THEME.colors },
    projectColors: [...DEFAULT_THEME.projectColors],
    fonts: { ...DEFAULT_THEME.fonts },
    radius: DEFAULT_THEME.radius,
  };
}

function finish(theme, counts) {
  return { theme, warnings: [...counts].map(([code, count]) => ({ code, count })) };
}

export function resolveTheme(input) {
  const theme = defaults();
  const counts = new Map();
  const warn = (code, n = 1) => counts.set(code, (counts.get(code) || 0) + n);
  try {
    if (input === null || input === undefined) return finish(theme, counts);
    if (!isObj(input)) { warn('theme-unreadable'); return finish(theme, counts); }
    if (Object.hasOwn(input, 'error') && input.error === 'unreadable') {
      warn('theme-unreadable');
      return finish(theme, counts);
    }

    const colors = own(input, 'colors');
    if (colors !== undefined) {
      if (!isObj(colors)) warn('setting-invalid');
      else {
        for (const k of COLOR_KEYS) {
          const v = own(colors, k);
          if (v === undefined) continue;
          if (isHexColor(v)) theme.colors[k] = v;
          else warn('color-invalid');
        }
      }
    }

    const pc = own(input, 'projectColors');
    if (pc !== undefined) {
      if (!Array.isArray(pc) || pc.length === 0) warn('setting-invalid');
      else {
        const bad = pc.filter((c) => !isHexColor(c)).length;
        if (bad > 0) warn('color-invalid', bad);
        else theme.projectColors = [...pc];
      }
    }

    const fonts = own(input, 'fonts');
    if (fonts !== undefined) {
      if (!isObj(fonts)) warn('setting-invalid');
      else {
        const source = own(fonts, 'source');
        if (source !== undefined) {
          if (source === 'google' || source === 'system') theme.fonts.source = source;
          else warn('setting-invalid');
        }
        for (const role of FONT_ROLES) {
          const v = own(fonts, role);
          if (v === undefined) continue;
          if (isFontName(v)) theme.fonts[role] = v;
          else warn('font-invalid');
        }
      }
    }

    const radius = own(input, 'radius');
    if (radius !== undefined) {
      if (typeof radius === 'number' && Number.isInteger(radius) && radius >= 0 && radius <= 40) theme.radius = radius;
      else warn('setting-invalid');
    }
  } catch {
    return finish(defaults(), new Map([['theme-unreadable', 1]]));
  }
  return finish(theme, counts);
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

const WEIGHTS = { heading: 'wght@800', body: 'wght@400;500;600', mono: 'wght@400;500' };
const FALLBACK = { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif', mono: 'ui-monospace, monospace' };

export function themeCss(theme) {
  const t = isObj(theme) ? theme : {};
  const colors = own(t, 'colors');
  const fonts = own(t, 'fonts');
  const vars = {};

  for (const k of COLOR_KEYS) {
    const v = own(colors, k);
    vars['--' + kebab(k)] = isHexColor(v) ? v : DEFAULT_THEME.colors[k];
  }

  const system = own(fonts, 'source') === 'system';
  const names = {};
  for (const role of FONT_ROLES) {
    const v = own(fonts, role);
    names[role] = isFontName(v) ? v : DEFAULT_THEME.fonts[role];
    vars['--font-' + role] = system ? FALLBACK[role] : `"${names[role]}", ${FALLBACK[role]}`;
  }

  const r = own(t, 'radius');
  const radius = typeof r === 'number' && Number.isInteger(r) && r >= 0 && r <= 40 ? r : DEFAULT_THEME.radius;
  vars['--radius'] = `${radius}px`;

  let fontHref = null;
  if (!system) {
    const fam = FONT_ROLES.map((role) => `family=${names[role].replace(/ /g, '+')}:${WEIGHTS[role]}`);
    fontHref = `https://fonts.googleapis.com/css2?${fam.join('&')}&display=swap`;
  }
  return { vars, fontHref, fontHosts: fontHref !== null };
}
