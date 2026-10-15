import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSettings, withDefaults, checkTheme, isHexColor, DEFAULT_THEME,
} from '../board/shape-settings.mjs';

const SETTINGS = () => ({
  version: 1,
  name: 'Sam',
  timezone: 'Europe/Brussels',
  weekStart: 'monday',
  agentName: 'Agent',
  projects: [
    { key: 'house', number: 3, color: '#7FE7D3' },
    { key: 'side', number: 4 },
  ],
  focus: ['house'],
  labels: { idea: 'idea', habitPrefix: 'habit:', ignore: ['weekly-review'] },
  habits: [{ id: 'move', title: 'Move', start: '2026-10-12', project: 'house' }],
  streak: { tokenEvery: 6, flameTiers: [1, 3, 7, 14, 21] },
  next: { count: 5 },
  season: {
    name: 'Autumn', start: '2026-10-12', end: '2026-12-31',
    goals: [{ title: 'Finish the kitchen', project: 'house' }],
  },
  refresh: { dailyAt: '05:00' },
});

const THEME = () => JSON.parse(JSON.stringify(DEFAULT_THEME));

function broken(mutate) {
  const s = SETTINGS();
  mutate(s);
  return checkSettings(s);
}

function failsNaming(mutate, field) {
  const r = broken(mutate);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith(field)), `${field} in ${JSON.stringify(r.errors)}`);
}

test('U the contract settings example passes', () => {
  assert.deepEqual(checkSettings(SETTINGS()), { ok: true, errors: [] });
});

test('U the contract theme example passes and DEFAULT_THEME is frozen', () => {
  assert.deepEqual(checkTheme(THEME()), { ok: true, errors: [] });
  assert.deepEqual(checkTheme({}), { ok: true, errors: [] });
  assert.ok(Object.isFrozen(DEFAULT_THEME));
  assert.ok(Object.isFrozen(DEFAULT_THEME.colors));
  assert.ok(Object.isFrozen(DEFAULT_THEME.projectColors));
  assert.equal(DEFAULT_THEME.radius, 20);
});

test('U checkSettings never throws, whatever it is given', () => {
  for (const x of [null, undefined, 3, 'x', [], () => 1, { projects: 5 }, { projects: [null, 4] }]) {
    const r = checkSettings(x);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errors));
  }
});

test('U version must be 1', () => {
  failsNaming((s) => { s.version = 2; }, 'version');
  failsNaming((s) => { delete s.version; }, 'version');
});

test('U name must be a string', () => {
  failsNaming((s) => { s.name = 7; }, 'name');
});

test('U timezone must be a zone the runtime knows', () => {
  failsNaming((s) => { s.timezone = 'Mars/Olympus'; }, 'timezone');
  failsNaming((s) => { s.timezone = ''; }, 'timezone');
  failsNaming((s) => { delete s.timezone; }, 'timezone');
  assert.equal(broken((s) => { s.timezone = 'UTC'; }).ok, true);
});

test('U projects must be a list; key pattern, key unique, number positive whole and unique', () => {
  failsNaming((s) => { s.projects = {}; }, 'projects');
  const r = broken((s) => { s.projects[1].key = 'Bad Key'; });
  assert.ok(r.errors.includes('projects[1].key: must match ^[a-z0-9-]{1,30}$'));
  failsNaming((s) => { s.projects[1].key = 'house'; }, 'projects[1].key');
  failsNaming((s) => { s.projects[0].key = 'a'.repeat(31); }, 'projects[0].key');
  failsNaming((s) => { s.projects[0].number = 0; }, 'projects[0].number');
  failsNaming((s) => { s.projects[0].number = 1.5; }, 'projects[0].number');
  failsNaming((s) => { s.projects[1].number = 3; }, 'projects[1].number');
});

test('U focus must be a list of strings, and may be empty', () => {
  failsNaming((s) => { s.focus = 'house'; }, 'focus');
  failsNaming((s) => { s.focus = [1]; }, 'focus');
  assert.equal(broken((s) => { s.focus = []; }).ok, true);
});

test('U habits: list, id pattern and unique, title non-empty, start a real date', () => {
  failsNaming((s) => { s.habits = 'x'; }, 'habits');
  failsNaming((s) => { s.habits[0].id = 'Move!'; }, 'habits[0].id');
  failsNaming((s) => { s.habits.push({ id: 'move', title: 'Again' }); }, 'habits[1].id');
  failsNaming((s) => { s.habits[0].title = ''; }, 'habits[0].title');
  failsNaming((s) => { s.habits[0].start = '2026-02-30'; }, 'habits[0].start');
  assert.equal(broken((s) => { delete s.habits; }).ok, true);
  assert.equal(broken((s) => { delete s.habits[0].start; }).ok, true);
  assert.equal(broken((s) => { s.habits[0].start = '2028-02-29'; }).ok, true);
});

test('U season: name, real dates, end not before start, goals with a title', () => {
  failsNaming((s) => { delete s.season.name; }, 'season.name');
  failsNaming((s) => { s.season.start = 'soon'; }, 'season.start');
  failsNaming((s) => { s.season.end = '2026-13-01'; }, 'season.end');
  failsNaming((s) => { s.season.end = '2026-10-11'; }, 'season.end');
  failsNaming((s) => { s.season.goals = null; }, 'season.goals');
  failsNaming((s) => { s.season.goals = [{ project: 'house' }]; }, 'season.goals[0].title');
  assert.equal(broken((s) => { delete s.season; }).ok, true);
  assert.equal(broken((s) => { s.season.end = s.season.start; }).ok, true);
});

test('U a forbidden key at any depth is named, and its value is not', () => {
  const secretValue = 'SENTINEL-VALUE-987';
  for (const [place, key] of [
    [(s) => { s.token = secretValue; }, 'token'],
    [(s) => { s.projects[1].secret = secretValue; }, 'projects[1].secret'],
    [(s) => { s.season.goals[0].password = secretValue; }, 'season.goals[0].password'],
    [(s) => { s.labels.Token = secretValue; }, 'labels.Token'],
  ]) {
    const r = broken(place);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith(key)), JSON.stringify(r.errors));
    assert.ok(!JSON.stringify(r.errors).includes(secretValue));
  }
});

test('U withDefaults does not mutate its input and returns a new object', () => {
  const s = SETTINGS();
  s.projects[0].color = 'red';
  s.next.count = 0;
  delete s.refresh;
  const before = JSON.stringify(s);
  const out = withDefaults(s, () => {});
  assert.equal(JSON.stringify(s), before);
  assert.notEqual(out, s);
  assert.notEqual(out.projects, s.projects);
  assert.equal(s.projects[0].color, 'red');
  assert.equal('color' in out.projects[0], false);
});

test('U withDefaults fills every soft value of a minimal settings object, silently', () => {
  const calls = [];
  const out = withDefaults({ version: 1, name: 'Sam', timezone: 'UTC', projects: [], focus: [] }, (c) => calls.push(c));
  assert.deepEqual(calls, []);
  assert.equal(out.weekStart, 'monday');
  assert.equal(out.agentName, 'Agent');
  assert.deepEqual(out.labels, { idea: 'idea', habitPrefix: 'habit:', ignore: ['weekly-review'] });
  assert.deepEqual(out.streak, { tokenEvery: 6, flameTiers: [1, 3, 7, 14, 21] });
  assert.deepEqual(out.next, { count: 5 });
  assert.deepEqual(out.refresh, { dailyAt: '05:00' });
});

test('U withDefaults keeps good soft values and flags the other bad ones', () => {
  const calls = [];
  const s = SETTINGS();
  s.weekStart = 'sunday';
  s.agentName = 'Robo';
  s.refresh.dailyAt = '25:00';
  s.labels.idea = '';
  s.labels.ignore = 'x';
  s.habits[0].project = 7;
  s.season.goals[0].project = false;
  const out = withDefaults(s, (c) => calls.push(c));
  assert.equal(out.weekStart, 'sunday');
  assert.equal(out.agentName, 'Robo');
  assert.equal(out.refresh.dailyAt, '05:00');
  assert.equal(out.labels.idea, 'idea');
  assert.deepEqual(out.labels.ignore, ['weekly-review']);
  assert.equal('project' in out.habits[0], false);
  assert.equal('project' in out.season.goals[0], false);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c === 'setting-invalid'));
});

test('U isHexColor accepts only #RGB and #RRGGBB', () => {
  for (const ok of ['#abc', '#ABC', '#7FE7D3', '#7fe7d3']) assert.equal(isHexColor(ok), true, ok);
  for (const bad of ['red', '#12345', '#1234', '#12345678', 'url(x)', '#abc;}body{display:none', '#abc\n', '', null, 5, undefined]) {
    assert.equal(isHexColor(bad), false, String(bad));
  }
});

test('U checkTheme names each broken field', () => {
  const cases = [
    [(t) => { t.colors.accent = 'red'; }, 'colors.accent'],
    [(t) => { t.colors = []; }, 'colors'],
    [(t) => { t.projectColors = []; }, 'projectColors'],
    [(t) => { t.projectColors[2] = '#12345'; }, 'projectColors[2]'],
    [(t) => { t.fonts.source = 'cdn'; }, 'fonts.source'],
    [(t) => { t.fonts.body = 'X&family=Evil'; }, 'fonts.body'],
    [(t) => { t.fonts.mono = ''; }, 'fonts.mono'],
    [(t) => { t.radius = '9px;}'; }, 'radius'],
    [(t) => { t.radius = 41; }, 'radius'],
  ];
  for (const [mutate, field] of cases) {
    const t = THEME();
    mutate(t);
    const r = checkTheme(t);
    assert.equal(r.ok, false, field);
    assert.ok(r.errors.some((e) => e.startsWith(field)), `${field} in ${JSON.stringify(r.errors)}`);
  }
  for (const x of [null, 3, 'x', []]) assert.equal(checkTheme(x).ok, false);
  const t = THEME();
  t.radius = 0;
  assert.equal(checkTheme(t).ok, true);
});

test('R92 a present bad soft value takes its default and adds one setting-invalid each', () => {
  const s = SETTINGS();
  s.next.count = 0;
  s.streak.tokenEvery = 1;
  s.streak.flameTiers = [3, 1];
  s.weekStart = 'friday';
  const calls = [];
  const out = withDefaults(s, (code) => calls.push(code));
  assert.equal(out.next.count, 5);
  assert.equal(out.streak.tokenEvery, 6);
  assert.deepEqual(out.streak.flameTiers, [1, 3, 7, 14, 21]);
  assert.equal(out.weekStart, 'monday');
  assert.deepEqual(calls, ['setting-invalid', 'setting-invalid', 'setting-invalid', 'setting-invalid']);
});

test('R92 a missing soft value takes its default with zero warnings', () => {
  const s = SETTINGS();
  delete s.next;
  delete s.streak.tokenEvery;
  delete s.streak.flameTiers;
  delete s.weekStart;
  const calls = [];
  const out = withDefaults(s, (code) => calls.push(code));
  assert.equal(out.next.count, 5);
  assert.equal(out.streak.tokenEvery, 6);
  assert.deepEqual(out.streak.flameTiers, [1, 3, 7, 14, 21]);
  assert.equal(out.weekStart, 'monday');
  assert.equal(calls.length, 0);
});

test('R92 the edges of each soft range are accepted', () => {
  const s = SETTINGS();
  s.next.count = 10;
  s.streak.tokenEvery = 2;
  s.streak.flameTiers = [2, 4, 6, 8, 10];
  const calls = [];
  const out = withDefaults(s, (c) => calls.push(c));
  assert.equal(calls.length, 0);
  assert.equal(out.next.count, 10);
  assert.equal(out.streak.tokenEvery, 2);
  assert.deepEqual(out.streak.flameTiers, [2, 4, 6, 8, 10]);
  s.streak.tokenEvery = 31;
  s.next.count = 11;
  s.streak.flameTiers = [1, 2, 3, 4, 4];
  const again = [];
  withDefaults(s, (c) => again.push(c));
  assert.equal(again.length, 3);
});

test('R76 a bad project colour is removed and flagged color-invalid, not setting-invalid', () => {
  const s = SETTINGS();
  s.projects[0].color = 'red';
  s.projects[1].color = '#abc';
  const calls = [];
  const out = withDefaults(s, (c) => calls.push(c));
  assert.deepEqual(calls, ['color-invalid']);
  assert.equal('color' in out.projects[0], false);
  assert.equal(out.projects[1].color, '#abc');
});
