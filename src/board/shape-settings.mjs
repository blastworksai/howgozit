// Shape checks for the settings file and the theme file. Pure: no clock, no file, no network, no environment.
// checkSettings: hard values only. withDefaults: soft values. checkTheme: shape problems of the theme.

const KEY_RE = /^[a-z0-9-]{1,30}$/;
const KEY_TEXT = '^[a-z0-9-]{1,30}$';
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FONT_RE = /^[A-Za-z0-9 ]+$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const FORBIDDEN = new Set(['token', 'secret', 'password']);
const MAX_DEPTH = 50;

function deepFreeze(o) {
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(o);
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const DEFAULT_THEME = deepFreeze({
  colors: {
    ground: '#E9ECEF', dot: '#D3D8DE', card: '#FFFFFF', border: '#D5D9DE',
    ink: '#111418', muted: '#5B6470', faint: '#7A8390',
    agentBg: '#111418', agentInk: '#F1F3F5',
    accent: '#D4F25A', hot: '#FF5B1F', hotInk: '#B23A0A', ok: '#2F9E6B',
  },
  projectColors: ['#7FE7D3', '#FFC94D', '#C9B6FF', '#FF9E80', '#8FB8FF', '#B7E38A'],
  fonts: { source: 'google', heading: 'Bricolage Grotesque', body: 'Geist', mono: 'Geist Mono' },
  radius: 20,
});

const HOME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODES_MAX = 8;
const MODE_MAX_LEN = 40;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

// owner/name, no segment made only of dots.
export function isHome(v) {
  return typeof v === 'string' && HOME_RE.test(v) && !v.split('/').some((seg) => /^\.+$/.test(seg));
}

export function isHexColor(s) {
  return typeof s === 'string' && HEX_RE.test(s);
}

function isRealDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= len;
}

function isKnownZone(tz) {
  if (!nonEmpty(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Walks every depth; reports the path of a forbidden key, never its value.
function findForbidden(value, path, errors, depth) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findForbidden(v, `${path}[${i}]`, errors, depth + 1));
    return;
  }
  for (const k of Object.keys(value)) {
    const p = path ? `${path}.${k}` : k;
    if (FORBIDDEN.has(k.toLowerCase())) errors.push(`${p}: key not allowed`);
    findForbidden(value[k], p, errors, depth + 1);
  }
}

// R119: any text at any depth (a value, a key) that holds the start of a Google Calendar secret address.
const GOOGLE_ADDRESS_PART = 'calendar.google.com/calendar/ical/';
function holdsGoogleAddress(value) {
  if (typeof value === 'string') return value.toLowerCase().includes(GOOGLE_ADDRESS_PART);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(holdsGoogleAddress);
  for (const k of Object.keys(value)) {
    if (holdsGoogleAddress(k) || holdsGoogleAddress(value[k])) return true;
  }
  return false;
}

export function checkSettings(x) {
  const errors = [];
  try {
    if (!isObj(x)) return { ok: false, errors: ['settings: must be an object'] };
    findForbidden(x, '', errors, 0);
    // R119: names the top-level key only, never the text found.
    for (const k of Object.keys(x)) {
      if (holdsGoogleAddress(k) || holdsGoogleAddress(x[k])) {
        errors.push(`${holdsGoogleAddress(k) ? 'a key' : k}: the settings file holds a Google Calendar address, and the address belongs in the board's environment and never in this file`);
      }
    }

    if (x.version !== 1) errors.push('version: must be 1');
    if (!isStr(x.name)) errors.push('name: must be a string');
    if (!isKnownZone(x.timezone)) errors.push('timezone: must be a time zone the runtime knows');

    if (!Array.isArray(x.projects)) {
      errors.push('projects: must be a list');
    } else {
      const keys = new Set();
      const numbers = new Set();
      x.projects.forEach((p, i) => {
        const at = `projects[${i}]`;
        if (!isObj(p)) { errors.push(`${at}: must be an object`); return; }
        if (!isStr(p.key) || !KEY_RE.test(p.key)) errors.push(`${at}.key: must match ${KEY_TEXT}`);
        else if (keys.has(p.key)) errors.push(`${at}.key: must be unique`);
        else keys.add(p.key);
        if (p.owner !== undefined && !(isStr(p.owner) && OWNER_RE.test(p.owner))) errors.push(`${at}.owner: must be a GitHub login`);
        // CP4: `home` is the repository whose milestones are this project's goals.
        if (p.home !== undefined && !isHome(p.home)) errors.push(`${at}.home: must be owner/name`);
        if (!isInt(p.number) || p.number < 1) errors.push(`${at}.number: must be a positive whole number`);
        else {
          // R6: unique as the pair (owner, number); no owner means the data repo's owner
          const pair = `${isStr(p.owner) ? p.owner.toLowerCase() : ''}#${p.number}`;
          if (numbers.has(pair)) errors.push(`${at}.number: must be unique`);
          else numbers.add(pair);
        }
      });
    }

    if (!Array.isArray(x.focus) || !x.focus.every(isStr)) errors.push('focus: must be a list of strings');

    if (x.habits !== undefined) {
      if (!Array.isArray(x.habits)) {
        errors.push('habits: must be a list');
      } else {
        const ids = new Set();
        x.habits.forEach((h, i) => {
          const at = `habits[${i}]`;
          if (!isObj(h)) { errors.push(`${at}: must be an object`); return; }
          if (!isStr(h.id) || !KEY_RE.test(h.id)) errors.push(`${at}.id: must match ${KEY_TEXT}`);
          else if (ids.has(h.id)) errors.push(`${at}.id: must be unique`);
          else ids.add(h.id);
          if (!nonEmpty(h.title)) errors.push(`${at}.title: must be a non-empty string`);
          if (h.start !== undefined && !isRealDate(h.start)) errors.push(`${at}.start: must be a real date YYYY-MM-DD`);
        });
      }
    }

    if (x.season !== undefined) {
      const s = x.season;
      if (!isObj(s)) {
        errors.push('season: must be an object');
      } else {
        if (!isStr(s.name)) errors.push('season.name: must be a string');
        const startOk = isRealDate(s.start);
        const endOk = isRealDate(s.end);
        if (!startOk) errors.push('season.start: must be a real date YYYY-MM-DD');
        if (!endOk) errors.push('season.end: must be a real date YYYY-MM-DD');
        if (startOk && endOk && s.end < s.start) errors.push('season.end: must not be before season.start');
        if (!Array.isArray(s.goals)) {
          errors.push('season.goals: must be a list');
        } else {
          s.goals.forEach((g, i) => {
            const at = `season.goals[${i}]`;
            if (!isObj(g)) errors.push(`${at}: must be an object`);
            else if (!nonEmpty(g.title)) errors.push(`${at}.title: must be a non-empty string`);
          });
        }
      }
    }
  } catch {
    errors.push('settings: could not be read');
  }
  return { ok: errors.length === 0, errors };
}

const DEFAULT_TIERS = [1, 3, 7, 14, 21];

function validTiers(v) {
  if (!Array.isArray(v) || v.length !== 5) return false;
  for (let i = 0; i < 5; i++) {
    if (!isInt(v[i]) || v[i] < 1) return false;
    if (i > 0 && v[i] <= v[i - 1]) return false;
  }
  return true;
}

function clone(v) {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

const CALENDAR_KINDS = ['meeting', 'focus', 'personal', 'habit'];
const CALENDAR_MAX = 20;
const CALENDAR_NAME_MAX = 100;

const GOOGLE_MAX = 5;

// R118: the google block. `place` is the entry's number in the file as written, dropped entries counted (R119).
function readGoogleCalendarSetting(value) {
  let invalid = 0;
  const calendars = [];
  const seen = new Set();
  value.calendars.forEach((entry, i) => {
    if (i >= GOOGLE_MAX) { invalid += 1; return; }
    const name = isObj(entry) && isStr(entry.name) ? entry.name.trim() : '';
    if (name === '' || name.length > CALENDAR_NAME_MAX || name.includes('://')) { invalid += 1; return; }
    const id = name.toLowerCase();
    if (seen.has(id)) { invalid += 1; return; }
    seen.add(id);
    let kind = 'meeting';
    if (entry.kind !== undefined) {
      if (CALENDAR_KINDS.includes(entry.kind)) kind = entry.kind;
      else invalid += 1;
    }
    calendars.push({ name, kind, place: i + 1 });
  });
  if (calendars.length === 0) return { setting: null, invalid };
  const setting = { source: 'google', calendars };
  if (value.includeFile === true) setting.includeFile = true;
  else if (value.includeFile !== undefined && value.includeFile !== false) invalid += 1;
  return { setting, invalid };
}

// The optional calendar block, soft as a whole. Returns the cleaned setting (or null: connector off) and the problems counted.
export function readCalendarSetting(value) {
  if (value === undefined) return { setting: null, invalid: 0 };
  if (isObj(value) && value.source === 'google' && Array.isArray(value.calendars)) return readGoogleCalendarSetting(value);
  if (!isObj(value) || value.source !== 'icloud' || !Array.isArray(value.calendars)) {
    return { setting: null, invalid: 1 };
  }
  let invalid = 0;
  const calendars = [];
  const seen = new Set();
  for (const entry of value.calendars) {
    const name = isObj(entry) && isStr(entry.name) ? entry.name.trim() : '';
    if (name === '' || name.length > CALENDAR_NAME_MAX) { invalid += 1; continue; }
    const id = name.toLowerCase();
    if (seen.has(id)) { invalid += 1; continue; }
    if (calendars.length >= CALENDAR_MAX) { invalid += 1; continue; }
    seen.add(id);
    let kind = 'meeting';
    if (entry.kind !== undefined) {
      if (CALENDAR_KINDS.includes(entry.kind)) kind = entry.kind;
      else invalid += 1;
    }
    calendars.push({ name, kind });
  }
  if (calendars.length === 0) return { setting: null, invalid };
  const setting = { source: 'icloud', calendars };
  // includeFile (R109): soft; only `true` is kept, so a board with it off or absent is exactly the board without the key.
  if (value.includeFile === true) setting.includeFile = true;
  else if (value.includeFile !== undefined && value.includeFile !== false) invalid += 1;
  return { setting, invalid };
}

// Returns a new settings object with every soft value filled.
// Missing soft value: default, silently. Present and bad: default, and warn('setting-invalid') once.
export function withDefaults(settings, warn) {
  // The second argument of a warn is a count in the model, so only the code is passed on.
  const w = (code) => { if (typeof warn === 'function') warn(code); };
  const out = isObj(settings) ? clone(settings) : {};

  const soft = (value, ok, fallback, label) => {
    if (value === undefined) return fallback;
    if (ok(value)) return value;
    w('setting-invalid', label);
    return fallback;
  };

  out.weekStart = soft(out.weekStart, (v) => v === 'monday' || v === 'sunday', 'monday', 'weekStart');
  out.agentName = soft(out.agentName, nonEmpty, 'Agent', 'agentName');

  let labels = out.labels;
  if (labels !== undefined && !isObj(labels)) { w('setting-invalid', 'labels'); labels = undefined; }
  labels = labels || {};
  out.labels = {
    ...labels,
    idea: soft(labels.idea, nonEmpty, 'idea', 'labels.idea'),
    habitPrefix: soft(labels.habitPrefix, nonEmpty, 'habit:', 'labels.habitPrefix'),
    ignore: soft(labels.ignore, (v) => Array.isArray(v) && v.every(isStr), ['weekly-review'], 'labels.ignore'),
  };

  let streak = out.streak;
  if (streak !== undefined && !isObj(streak)) { w('setting-invalid', 'streak'); streak = undefined; }
  streak = streak || {};
  out.streak = {
    ...streak,
    tokenEvery: soft(streak.tokenEvery, (v) => isInt(v) && v >= 2 && v <= 30, 6, 'streak.tokenEvery'),
    flameTiers: soft(streak.flameTiers, validTiers, DEFAULT_TIERS.slice(), 'streak.flameTiers'),
  };

  let next = out.next;
  if (next !== undefined && !isObj(next)) { w('setting-invalid', 'next'); next = undefined; }
  next = next || {};
  out.next = { ...next, count: soft(next.count, (v) => isInt(v) && v >= 1 && v <= 10, 5, 'next.count') };

  let refresh = out.refresh;
  if (refresh !== undefined && !isObj(refresh)) { w('setting-invalid', 'refresh'); refresh = undefined; }
  refresh = refresh || {};
  out.refresh = {
    ...refresh,
    dailyAt: soft(refresh.dailyAt, (v) => typeof v === 'string' && TIME_RE.test(v), '05:00', 'refresh.dailyAt'),
  };

  // CP4 soft keys (absent changes nothing; present and wrong is dropped and counted once).
  if (out.modes !== undefined) {
    const seen = new Set();
    const ok = Array.isArray(out.modes) && out.modes.length >= 1 && out.modes.length <= MODES_MAX && out.modes.every((m) => {
      if (!isStr(m)) return false;
      const t = m.trim().toLowerCase();
      if (t.length < 1 || m.trim().length > MODE_MAX_LEN || seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    if (!ok) { delete out.modes; w('setting-invalid', 'modes'); }
  }
  for (const label of ['ideas', 'habitsProject']) {
    const v = out[label];
    if (v === undefined) continue;
    if (!(isObj(v) && isStr(v.owner) && OWNER_RE.test(v.owner) && isInt(v.number) && v.number >= 1)) {
      delete out[label];
      w('setting-invalid', label);
    }
  }

  const cal = readCalendarSetting(out.calendar);
  if (cal.setting) out.calendar = cal.setting;
  else delete out.calendar;
  for (let i = 0; i < cal.invalid; i++) w('setting-invalid', 'calendar');

  if (Array.isArray(out.projects)) {
    out.projects.forEach((p, i) => {
      if (isObj(p) && p.color !== undefined && !isHexColor(p.color)) {
        delete p.color;
        w('color-invalid', `projects[${i}].color`);
      }
    });
  }
  if (Array.isArray(out.habits)) {
    out.habits.forEach((h, i) => {
      if (isObj(h) && h.project !== undefined && !nonEmpty(h.project)) {
        delete h.project;
        w('setting-invalid', `habits[${i}].project`);
      }
      // CP6 (R136): a score needs the Habits Project and a whole 1..10 range; otherwise the habit is a tick habit.
      if (isObj(h) && h.score !== undefined) {
        const sc = h.score;
        const okRange = isObj(sc) && isInt(sc.min) && isInt(sc.max) && sc.min >= 1 && sc.min < sc.max && sc.max <= 10;
        if (!okRange || !isObj(out.habitsProject)) {
          delete h.score;
          w('setting-invalid', `habits[${i}].score`);
        }
      }
    });
  }
  if (isObj(out.season) && Array.isArray(out.season.goals)) {
    out.season.goals.forEach((g, i) => {
      if (isObj(g) && g.project !== undefined && !nonEmpty(g.project)) {
        delete g.project;
        w('setting-invalid', `season.goals[${i}].project`);
      }
    });
  }
  return out;
}

export function checkTheme(x) {
  const errors = [];
  try {
    if (!isObj(x)) return { ok: false, errors: ['theme: must be an object'] };
    if (x.colors !== undefined) {
      if (!isObj(x.colors)) {
        errors.push('colors: must be an object');
      } else {
        for (const [k, v] of Object.entries(x.colors)) {
          if (!isHexColor(v)) errors.push(`colors.${k}: must be #RGB or #RRGGBB`);
        }
      }
    }
    if (x.projectColors !== undefined) {
      if (!Array.isArray(x.projectColors) || x.projectColors.length === 0) {
        errors.push('projectColors: must be a non-empty list');
      } else {
        x.projectColors.forEach((c, i) => {
          if (!isHexColor(c)) errors.push(`projectColors[${i}]: must be #RGB or #RRGGBB`);
        });
      }
    }
    if (x.fonts !== undefined) {
      if (!isObj(x.fonts)) {
        errors.push('fonts: must be an object');
      } else {
        const f = x.fonts;
        if (f.source !== undefined && f.source !== 'google' && f.source !== 'system') {
          errors.push('fonts.source: must be google or system');
        }
        for (const name of ['heading', 'body', 'mono']) {
          if (f[name] !== undefined && !(isStr(f[name]) && FONT_RE.test(f[name]))) {
            errors.push(`fonts.${name}: must hold only letters, digits and spaces`);
          }
        }
      }
    }
    if (x.radius !== undefined && !(isInt(x.radius) && x.radius >= 0 && x.radius <= 40)) {
      errors.push('radius: must be a whole number from 0 to 40');
    }
  } catch {
    errors.push('theme: could not be read');
  }
  return { ok: errors.length === 0, errors };
}
