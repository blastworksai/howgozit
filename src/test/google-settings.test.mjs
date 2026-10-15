// Tests of the settings side of the Google calendar source: R118 (the block), R119 (the environment) and R120
// (the accept/refuse table of an address), written from the contract before the code exists.
// The modules that do not exist yet (board/calendar/google.mjs) and the names that do not exist yet
// (readGoogleIcal, the loader's googleCalendar option, `place`) are reached lazily, so each test fails by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCalendarSetting, withDefaults, checkSettings } from '../board/shape-settings.mjs';
import { readEnv } from '../board/env.mjs';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { board, settings } from '../fixtures/build.mjs';
import { fakeGoogleIcal, icsFeed } from '../fixtures/fake-google-ical.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const AT = '2026-10-12T06:10:00.900Z';
const TZ = 'Europe/Brussels';
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };

const GOOD = 'https://calendar.google.com/calendar/ical/home%40example.invalid/private-0123456789abcdef/basic.ics';
const addressFor = (name) => `https://calendar.google.com/calendar/ical/${name}%40example.invalid/private-0123456789abcdef/basic.ics`;
const SENTINEL = 'https://calendar.google.com/calendar/ical/SENTINEL-CAL-ID/private-SENTINEL-TOKEN/basic.ics';
const PARTS = [SENTINEL, 'SENTINEL-CAL-ID', 'SENTINEL-TOKEN', 'private-SENTINEL', 'basic.ics', 'calendar.google.com', '/calendar/ical/'];

// ---- lazy reach into what does not exist yet ----

async function googleModule() {
  const mod = await import('../board/calendar/google.mjs');
  assert.equal(typeof mod.createGoogleSource, 'function', 'board/calendar/google.mjs does not export createGoogleSource');
  return mod;
}
async function readGoogleIcal(vars) {
  const mod = await import('../board/env.mjs');
  assert.equal(typeof mod.readGoogleIcal, 'function', 'board/env.mjs does not export readGoogleIcal');
  return mod.readGoogleIcal(vars);
}

// ---- small givens ----

const MIN = 60 * 1000;
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const two = (n) => String(n).padStart(2, '0');
// Minutes after 00:00 UTC on 12 October 2026 (Brussels is UTC+2), as an iCalendar UTC time.
const z = (min) => `20261012T${two(Math.floor(min / 60))}${two(min % 60)}00Z`;
const feedOf = (title, startMin, endMin) => icsFeed([{ title, start: z(startMin), end: z(endMin) }]);
const entry = (name, place, kind = 'meeting') => ({ name, kind, place });
const warnOf = (b, code) => (b.meta?.warnings ?? []).find((w) => w.code === code);

async function readOnce(address, { calendars = [entry('Home', 1)], feeds, extra = {} } = {}) {
  const { createGoogleSource } = await googleModule();
  const fake = fakeGoogleIcal({ feeds: feeds ?? { [address]: feedOf('Standup', 420, 450) } });
  const source = createGoogleSource({ fetch: fake, addresses: { 1: address, ...extra }, budgetMs: 500, requestMs: 300 });
  const out = await source.read({ calendars, tz: TZ, now: AT });
  return { fake, out };
}

// ---- a fake GitHub world and one loader session (as test/calendar-merge-sources.test.mjs does for iCloud) ----

function makeHttp(files, calls) {
  const answer = (method, p) => {
    calls.push({ method, path: p });
    if (p === R) return { private: true, owner: { login: OWNER, type: 'Organization' } };
    if (p.startsWith(R + '/contents/')) {
      const f = p.slice((R + '/contents/').length);
      if (!Object.hasOwn(files, f) || files[f] === null) throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
      return { content: Buffer.from(files[f], 'utf8').toString('base64'), encoding: 'base64' };
    }
    if (p.startsWith(R + '/issues?') || p.startsWith(R + '/milestones?')) return { items: [], partial: false };
    if (p === '/orgs/' + OWNER + '/projectsV2?per_page=100') return { items: [], partial: false };
    throw new GitHubError('not-found', 404, 'Nothing is stored at ' + p + '.');
  };
  return {
    async get(p) { return { status: 200, json: answer('get', p), notModified: false, link: null }; },
    async paged(p) { return answer('paged', p); },
  };
}

async function session({ calendar, settingsExtra = {}, vars = {}, feeds = {}, at = AT } = {}) {
  const { createGoogleSource } = await googleModule();
  const fake = fakeGoogleIcal({ feeds });
  const addresses = (await readGoogleIcal(vars)) ?? {};
  const googleCalendar = createGoogleSource({ fetch: fake, addresses, budgetMs: 500, requestMs: 300 });
  const githubCalls = [];
  const files = {
    'board.config.json': JSON.stringify(settings({ timezone: TZ, ...settingsExtra, ...(calendar === undefined ? {} : { calendar }) })),
    'theme.json': null,
    'state/brief.json': null,
    'state/calendar.json': null,
    'state/inbox.json': null,
    'state/log.json': null,
    'state/proposals.json': null,
  };
  const cache = { async readLastGood() { return null; }, async writeLastGood() {}, etags: { get() {}, set() {} } };
  const clock = { t: Date.parse(at), now() { return clock.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-GH-TOKEN-1', googleIcal: addresses };
  const loader = createLoader({ http: makeHttp(files, githubCalls), env, cache, clock, googleCalendar });
  return {
    fake, githubCalls, clock,
    async load() {
      const out = await loader.load();
      if (!out.ok) return { out };
      const b = out.bundle;
      const built = buildBoard({ ...b, now: new Date(clock.t).toISOString() });
      return { out, board: built, html: renderPage(built, THEME, OPTS), panel: built.panels.calendar };
    },
  };
}

// ======================= R118: the settings side =======================

test('R118 a google block is usable: source google, the entries with their kinds and their place', () => {
  const r = readCalendarSetting({ source: 'google', calendars: [{ name: 'Home', kind: 'personal' }, { name: 'Work' }] });
  assert.deepEqual(r, {
    setting: { source: 'google', calendars: [entry('Home', 1, 'personal'), entry('Work', 2, 'meeting')] },
    invalid: 0,
  });
});

test('R118 all four kinds are kept for google and an unknown kind becomes meeting, counted once', () => {
  const kinds = ['meeting', 'focus', 'personal', 'habit'];
  const r = readCalendarSetting({ source: 'google', calendars: kinds.map((kind, i) => ({ name: `C${i}`, kind })) });
  assert.deepEqual(r.setting.calendars.map((c) => c.kind), kinds);
  assert.equal(r.invalid, 0);
  const bad = readCalendarSetting({ source: 'google', calendars: [{ name: 'Gym', kind: 'sport' }] });
  assert.deepEqual(bad.setting.calendars, [entry('Gym', 1, 'meeting')]);
  assert.equal(bad.invalid, 1);
});

test('R118 the name of a google entry is trimmed and kept as a label, whatever it says', () => {
  const r = readCalendarSetting({ source: 'google', calendars: [{ name: '  Family trips  ', kind: 'habit' }] });
  assert.deepEqual(r, { setting: { source: 'google', calendars: [entry('Family trips', 1, 'habit')] }, invalid: 0 });
});

test('R118 a google block naming 7 calendars keeps 5 and counts 2', () => {
  const calendars = Array.from({ length: 7 }, (_, i) => ({ name: `Cal ${i + 1}` }));
  const r = readCalendarSetting({ source: 'google', calendars });
  assert.deepEqual(r.setting.calendars.map((c) => c.name), calendars.slice(0, 5).map((c) => c.name));
  assert.deepEqual(r.setting.calendars.map((c) => c.place), [1, 2, 3, 4, 5]);
  assert.equal(r.invalid, 2);
});

test('R118 exactly 5 google entries keep 5 and count 0, and an icloud block still keeps 20 of 25', () => {
  const five = readCalendarSetting({ source: 'google', calendars: Array.from({ length: 5 }, (_, i) => ({ name: `Cal ${i + 1}` })) });
  assert.equal(five.setting.calendars.length, 5);
  assert.equal(five.invalid, 0);
  const many = readCalendarSetting({ source: 'icloud', calendars: Array.from({ length: 25 }, (_, i) => ({ name: `Cal ${i + 1}` })) });
  assert.equal(many.setting.calendars.length, 20);
  assert.equal(many.invalid, 5);
});

test('R118 an entry whose name holds :// is dropped and counted, wherever the text sits in the name', () => {
  const r = readCalendarSetting({ source: 'google', calendars: [{ name: 'https://example.invalid/x' }, { name: 'My ftp://x list' }, { name: 'Home' }] });
  assert.deepEqual(r, { setting: { source: 'google', calendars: [entry('Home', 3)] }, invalid: 2 });
});

test('R118 the place counts entries that were dropped: Home, a blank name and Work are places 1 and 3', () => {
  const r = readCalendarSetting({ source: 'google', calendars: [{ name: 'Home' }, { name: ' ' }, { name: 'Work' }] });
  assert.deepEqual(r, { setting: { source: 'google', calendars: [entry('Home', 1), entry('Work', 3)] }, invalid: 1 });
});

test('R118 the place counts every kind of dropped entry: a repeated name, a non-object, a name with :// and a long name', () => {
  const r = readCalendarSetting({
    source: 'google',
    calendars: [{ name: 'Home' }, { name: ' HOME ' }, 'Work', { name: 'a://b' }, { name: 'x'.repeat(101) }, { name: 'Gym' }],
  });
  // The sixth entry as written is beyond the fifth: dropped and counted, and no variable could be numbered 6.
  assert.deepEqual(r.setting.calendars, [entry('Home', 1)]);
  assert.equal(r.invalid, 5);
});

test('R118 an entry beyond the fifth as written is dropped even when earlier entries were dropped', () => {
  const calendars = [{ name: 'A' }, { name: ' ' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }, { name: 'F' }];
  const r = readCalendarSetting({ source: 'google', calendars });
  assert.deepEqual(r.setting.calendars.map((c) => [c.name, c.place]), [['A', 1], ['B', 3], ['C', 4], ['D', 5]]);
  assert.equal(r.invalid, 3); // the blank one, and the 6th and 7th as written
});

test('R118 an icloud block is unchanged: no place key on its entries', () => {
  const r = readCalendarSetting({ source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }, { name: 'Work' }] });
  assert.deepEqual(r, {
    setting: { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }, { name: 'Work', kind: 'meeting' }] },
    invalid: 0,
  });
  assert.equal(r.setting.calendars.some((c) => Object.hasOwn(c, 'place')), false);
});

test('R118 a google block with no usable entry gives no setting and the count; an empty list gives none and no count', () => {
  assert.deepEqual(readCalendarSetting({ source: 'google', calendars: [{ name: '' }, 'Home'] }), { setting: null, invalid: 2 });
  assert.deepEqual(readCalendarSetting({ source: 'google', calendars: [] }), { setting: null, invalid: 0 });
  assert.deepEqual(readCalendarSetting({ source: 'google' }), { setting: null, invalid: 1 });
});

test('R118 a source other than icloud or google is still dropped as a whole with one problem (R104 with yahoo)', () => {
  assert.deepEqual(readCalendarSetting({ source: 'yahoo', calendars: [{ name: 'Home' }] }), { setting: null, invalid: 1 });
  assert.deepEqual(readCalendarSetting({ source: 'Google', calendars: [{ name: 'Home' }] }), { setting: null, invalid: 1 });
});

test('R118 withDefaults keeps a cleaned google block with its places, and warns once per problem', () => {
  const calls = [];
  const s = { version: 1, name: 'Sam', timezone: 'UTC', projects: [], focus: [], calendar: { source: 'google', calendars: [{ name: ' Home ', kind: 'personal' }, { name: 'a://b' }, { name: 'Work' }] } };
  const out = withDefaults(s, (c) => calls.push(c));
  assert.deepEqual(calls, ['setting-invalid']);
  assert.deepEqual(out.calendar, { source: 'google', calendars: [entry('Home', 1, 'personal'), entry('Work', 3)] });
});

test('R118 buildBoard counts setting-invalid at 2 for a google block naming 7 calendars, and at 1 for a name holding ://', () => {
  const seven = board({ settings: settings({ calendar: { source: 'google', calendars: Array.from({ length: 7 }, (_, i) => ({ name: `Cal ${i + 1}` })) } }) });
  assert.deepEqual(warnOf(seven, 'setting-invalid'), { code: 'setting-invalid', count: 2 });
  const url = board({ settings: settings({ calendar: { source: 'google', calendars: [{ name: 'https://example.invalid/x' }, { name: 'Home' }] } }) });
  assert.deepEqual(warnOf(url, 'setting-invalid'), { code: 'setting-invalid', count: 1 });
  const clean = board({ settings: settings({ calendar: { source: 'google', calendars: [{ name: 'Home' }] } }) });
  assert.equal(warnOf(clean, 'setting-invalid'), undefined);
});

test('R118 checkSettings stays ok for a google block (soft), and still refuses a password key inside it', () => {
  const base = { version: 1, name: 'Sam', timezone: 'UTC', projects: [], focus: [] };
  assert.deepEqual(checkSettings({ ...base, calendar: { source: 'google', calendars: [{ name: 'Home' }] } }), { ok: true, errors: [] });
  const r = checkSettings({ ...base, calendar: { source: 'google', calendars: [{ name: 'Home' }], password: 'SENTINEL-PW-1' } });
  assert.equal(r.ok, false);
});

test('R118 a google entry named https://example.invalid/x is dropped and no request is made for it (through the loader)', async () => {
  const s = await session({
    calendar: { source: 'google', calendars: [{ name: 'https://example.invalid/x' }, { name: 'Home' }] },
    vars: { BOARD_GOOGLE_ICAL_1: addressFor('url'), BOARD_GOOGLE_ICAL_2: GOOD },
    feeds: { [addressFor('url')]: feedOf('Wrong', 420, 450), [GOOD]: feedOf('Standup', 420, 450) },
  });
  const v = await s.load();
  assert.equal(v.out.ok, true);
  assert.deepEqual(warnOf(v.board, 'setting-invalid'), { code: 'setting-invalid', count: 1 });
  assert.deepEqual(s.fake.calls.map((c) => c.url), [GOOD], 'only the second entry (place 2) is requested');
  assert.deepEqual(v.panel.events.map((e) => e.title), ['Standup']);
});

// ======================= R119: the environment =======================

test('R119 readGoogleIcal reads _1 to _5, trimmed, and only the places that have a value', async () => {
  const r = await readGoogleIcal({
    BOARD_GOOGLE_ICAL_1: `  ${addressFor('a')} `,
    BOARD_GOOGLE_ICAL_3: addressFor('c'),
    BOARD_GOOGLE_ICAL_5: `${addressFor('e')}\n`,
  });
  assert.deepEqual(r, { 1: addressFor('a'), 3: addressFor('c'), 5: addressFor('e') });
});

test('R119 readGoogleIcal: a value that is empty once trimmed is not set', async () => {
  assert.equal(await readGoogleIcal({ BOARD_GOOGLE_ICAL_1: '   ', BOARD_GOOGLE_ICAL_2: '' }), null);
  assert.deepEqual(await readGoogleIcal({ BOARD_GOOGLE_ICAL_1: '  ', BOARD_GOOGLE_ICAL_2: GOOD }), { 2: GOOD });
});

test('R119 readGoogleIcal gives null when none is set, and never reads _6 or any other name of the family', async () => {
  assert.equal(await readGoogleIcal({}), null);
  assert.equal(await readGoogleIcal(undefined), null);
  assert.equal(await readGoogleIcal({ BOARD_GOOGLE_ICAL_6: GOOD }), null);
  assert.equal(await readGoogleIcal({ BOARD_GOOGLE_ICAL_0: GOOD, BOARD_GOOGLE_ICAL: GOOD, BOARD_GOOGLE_ICAL_01: GOOD, BOARD_GOOGLE_ICAL_1X: GOOD, BOARD_GOOGLE_ICAL_10: GOOD }), null);
  assert.deepEqual(await readGoogleIcal({ BOARD_GOOGLE_ICAL_6: GOOD, BOARD_GOOGLE_ICAL_5: addressFor('e') }), { 5: addressFor('e') });
});

test('R119 readGoogleIcal passes a value on as written (the test of R120 is made at the request, not here)', async () => {
  assert.deepEqual(await readGoogleIcal({ BOARD_GOOGLE_ICAL_1: 'not an address' }), { 1: 'not an address' });
});

test('R119 the board starts whatever the variables hold, with no Google setting at all', async () => {
  const GH = { BOARD_GITHUB_TOKEN: 'SENTINEL-GH-TOKEN', BOARD_REPO: 'owner/data' };
  const set = await readEnv({ ...GH, BOARD_GOOGLE_ICAL_1: GOOD, BOARD_GOOGLE_ICAL_3: addressFor('c') });
  assert.equal(set.ok, true);
  assert.deepEqual(set.env.googleIcal, { 1: GOOD, 3: addressFor('c') });
  const junk = await readEnv({ ...GH, BOARD_GOOGLE_ICAL_1: 'not an address', BOARD_GOOGLE_ICAL_2: 'http://evil.example/x', BOARD_GOOGLE_ICAL_6: GOOD });
  assert.equal(junk.ok, true);
  const none = await readEnv(GH);
  assert.equal(none.ok, true);
  assert.equal(none.env.googleIcal, null);
});

test('R119 Home, a blank name and Work with variables 1, 2, 3: Home from the first, Work from the third, none for the second, setting-invalid at 1', async () => {
  const [a1, a2, a3] = [addressFor('home'), addressFor('blank'), addressFor('work')];
  const s = await session({
    calendar: { source: 'google', calendars: [{ name: 'Home', kind: 'personal' }, { name: ' ' }, { name: 'Work' }] },
    vars: { BOARD_GOOGLE_ICAL_1: a1, BOARD_GOOGLE_ICAL_2: a2, BOARD_GOOGLE_ICAL_3: a3 },
    feeds: { [a1]: feedOf('Dentist', 480, 540), [a2]: feedOf('Never', 600, 660), [a3]: feedOf('Standup', 420, 450) },
  });
  const v = await s.load();
  assert.equal(v.out.ok, true);
  assert.deepEqual(s.fake.calls.map((c) => c.url).sort(), [a1, a3].sort());
  assert.deepEqual(v.panel.events.map((e) => [e.title, e.kind]), [['Standup', 'meeting'], ['Dentist', 'personal']]);
  assert.deepEqual(warnOf(v.board, 'setting-invalid'), { code: 'setting-invalid', count: 1 });
});

test('R119 a first value of blanks: calendar-google-no-address at 1 naming Home, and the second calendar is still read', async () => {
  const a2 = addressFor('work');
  const s = await session({
    calendar: { source: 'google', calendars: [{ name: 'Home' }, { name: 'Work' }] },
    vars: { BOARD_GOOGLE_ICAL_1: '  ', BOARD_GOOGLE_ICAL_2: a2 },
    feeds: { [a2]: feedOf('Standup', 420, 450) },
  });
  const v = await s.load();
  assert.deepEqual(warnOf(v.board, 'calendar-google-no-address'), { code: 'calendar-google-no-address', count: 1, names: ['Home'] });
  assert.deepEqual(s.fake.calls.map((c) => c.url), [a2]);
  assert.deepEqual(v.panel.events.map((e) => e.title), ['Standup']);
});

test('R119 BOARD_GOOGLE_ICAL_6 set: it is never read, whatever the settings name', async () => {
  const s = await session({
    calendar: { source: 'google', calendars: Array.from({ length: 6 }, (_, i) => ({ name: `Cal ${i + 1}` })) },
    vars: { BOARD_GOOGLE_ICAL_6: GOOD },
    feeds: { [GOOD]: feedOf('Never', 420, 450) },
  });
  const v = await s.load();
  assert.equal(s.fake.calls.length, 0);
  const w = warnOf(v.board, 'calendar-google-no-address');
  assert.equal(w.count, 5);
  assert.deepEqual(w.names, ['Cal 1', 'Cal 2', 'Cal 3', 'Cal 4', 'Cal 5']);
  assert.deepEqual(warnOf(v.board, 'setting-invalid'), { code: 'setting-invalid', count: 1 });
});

test('R119 a listed calendar with no variable at all: the board loads, the others are read, nothing is requested for it', async () => {
  const a1 = addressFor('home');
  const s = await session({
    calendar: { source: 'google', calendars: [{ name: 'Home' }, { name: 'Work' }] },
    vars: { BOARD_GOOGLE_ICAL_1: a1 },
    feeds: { [a1]: feedOf('Dentist', 480, 540) },
  });
  const v = await s.load();
  assert.equal(v.out.ok, true);
  assert.deepEqual(s.fake.calls.map((c) => c.url), [a1]);
  assert.deepEqual(warnOf(v.board, 'calendar-google-no-address'), { code: 'calendar-google-no-address', count: 1, names: ['Work'] });
});

const SENTINEL_FILES = [
  ['a url key of a calendar entry', 'calendar', { calendar: { source: 'google', calendars: [{ name: 'Home', url: SENTINEL }] } }, 'calendar'],
  ['the name of a calendar entry', 'calendar', { calendar: { source: 'google', calendars: [{ name: SENTINEL }] } }, 'calendar'],
  ['an unrelated key such as agentName', 'agentName', { agentName: SENTINEL }, 'agentName'],
  ['text around the address in agentName', 'agentName', { agentName: `see ${SENTINEL} for it` }, 'agentName'],
  ['a list of strings (focus)', 'focus', { focus: ['a', SENTINEL] }, 'focus'],
  ['a nested object (labels.idea)', 'labels', { labels: { idea: SENTINEL } }, 'labels'],
  ['the host and path in lower case only', 'agentName', { agentName: 'x calendar.google.com/calendar/ical/ x' }, 'agentName'],
];

for (const [label, , extra, key] of SENTINEL_FILES) {
  test(`R119 a settings file holding the address in ${label} is a 503 notice naming ${key} and no part of the address, and no request to Google`, async () => {
    const s = await session({
      settingsExtra: extra,
      vars: { BOARD_GOOGLE_ICAL_1: GOOD },
      feeds: { [GOOD]: feedOf('Never', 420, 450) },
    });
    const v = await s.load();
    assert.equal(v.out.ok, false, 'the file should be invalid as a whole');
    assert.equal(v.out.notice.status, 503);
    const text = JSON.stringify(v.out.notice);
    assert.ok(text.includes(key), `the notice should name ${key}: ${text}`);
    assert.match(v.out.notice.message, /Google Calendar address/i);
    for (const part of PARTS) assert.equal(text.includes(part), false, `the notice holds ${part}`);
    assert.equal(s.fake.calls.length, 0);
  });
}

test('R119 the same file is invalid with an icloud block too (the sentence applies to every settings file)', async () => {
  const s = await session({
    calendar: { source: 'icloud', calendars: [{ name: 'Home', url: SENTINEL }] },
    feeds: {},
  });
  const v = await s.load();
  assert.equal(v.out.ok, false);
  assert.equal(v.out.notice.status, 503);
  assert.equal(PARTS.some((p) => JSON.stringify(v.out.notice).includes(p)), false);
});

test('R119 checkSettings itself refuses the address at any depth, naming the top-level key and no part of it', () => {
  const base = { version: 1, name: 'Sam', timezone: 'UTC', projects: [], focus: [] };
  for (const [extra, key] of [[{ agentName: SENTINEL }, 'agentName'], [{ calendar: { source: 'google', calendars: [{ name: 'Home', url: SENTINEL }] } }, 'calendar'], [{ labels: { idea: SENTINEL } }, 'labels']]) {
    const r = checkSettings({ ...base, ...extra });
    assert.equal(r.ok, false, key);
    const text = JSON.stringify(r.errors);
    assert.ok(text.includes(key), `${key}: ${text}`);
    for (const part of PARTS) assert.equal(text.includes(part), false, `${key}: ${part}`);
  }
  assert.deepEqual(checkSettings({ ...base, calendar: { source: 'google', calendars: [{ name: 'Home' }] } }), { ok: true, errors: [] });
});

test('R119 no request the board makes to GitHub holds a part of any address (googled board, a refused address, a missing address)', async () => {
  const a1 = SENTINEL;
  const s = await session({
    calendar: { source: 'google', calendars: [{ name: 'Home' }, { name: 'Work' }, { name: 'Gym' }] },
    vars: { BOARD_GOOGLE_ICAL_1: a1, BOARD_GOOGLE_ICAL_2: SENTINEL.replace('https:', 'http:') },
    feeds: { [a1]: feedOf('Standup', 420, 450) },
  });
  const v = await s.load();
  assert.equal(v.out.ok, true);
  assert.ok(s.githubCalls.length > 0);
  const text = JSON.stringify(s.githubCalls);
  for (const part of PARTS) assert.equal(text.includes(part), false, `a GitHub request holds ${part}`);
});

// ======================= R120: the address table =======================

test('R120 the accepted addresses are requested: the plain one, the host in capitals and the port 443', async () => {
  for (const address of [GOOD, GOOD.replace('calendar.google.com', 'CALENDAR.GOOGLE.COM'), GOOD.replace('calendar.google.com', 'calendar.google.com:443')]) {
    const { fake, out } = await readOnce(address, { feeds: { [address]: feedOf('Standup', 420, 450) } });
    assert.equal(fake.calls.length, 1, address);
    assert.deepEqual(out.warnings, [], address);
    assert.deepEqual(out.value.events.map((e) => e.title), ['Standup'], address);
  }
});

test('R120 an address of exactly 2000 characters is accepted', async () => {
  const head = 'https://calendar.google.com/calendar/ical/';
  const tail = '/basic.ics';
  const address = head + 'a'.repeat(2000 - head.length - tail.length) + tail;
  assert.equal(address.length, 2000);
  const { fake, out } = await readOnce(address);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(out.warnings, []);
});

const REFUSED = [
  ['http: instead of https:', GOOD.replace('https:', 'http:')],
  ['the host calendar.google.com.evil.example', GOOD.replace('calendar.google.com', 'calendar.google.com.evil.example')],
  ['the host www.google.com', GOOD.replace('calendar.google.com', 'www.google.com')],
  ['the host evil.example', GOOD.replace('calendar.google.com', 'evil.example')],
  ['the host accounts.google.com', GOOD.replace('calendar.google.com', 'accounts.google.com')],
  ['a user name and password before the host', GOOD.replace('//', '//user:pw@')],
  ['a user name only before the host', GOOD.replace('//', '//user@')],
  ['the port 8443', GOOD.replace('calendar.google.com', 'calendar.google.com:8443')],
  ['the port 80', GOOD.replace('calendar.google.com', 'calendar.google.com:80')],
  ['a fragment #top at the end', GOOD + '#top'],
  ['a query ?x=1 before .ics', GOOD.replace('basic.ics', 'basic?x=1.ics')],
  ['a query ?x=1 after .ics', GOOD + '?x=1'],
  ['an empty query mark at the end', GOOD + '?'],
  ['/calendar/render as the path', 'https://calendar.google.com/calendar/render'],
  ['the path ending .ics.html', GOOD.replace('basic.ics', 'basic.ics.html')],
  ['the path ending .ICS in capitals', GOOD.replace('basic.ics', 'basic.ICS')],
  ['nothing between /calendar/ical/ and .ics', 'https://calendar.google.com/calendar/ical/.ics'],
  ['a path of /calendar/ical/../render/x.ics', 'https://calendar.google.com/calendar/ical/../render/x.ics'],
  ['an encoded dot segment /calendar/ical/%2e%2e/render/x.ics', 'https://calendar.google.com/calendar/ical/%2e%2e/render/x.ics'],
  ['a path that is not under /calendar/ical/ (/calendar/ical.ics)', 'https://calendar.google.com/calendar/ical.ics'],
  ['a path in capitals (/CALENDAR/ICAL/x.ics)', 'https://calendar.google.com/CALENDAR/ICAL/x.ics'],
  ['2001 characters', `https://calendar.google.com/calendar/ical/${'a'.repeat(2001 - 'https://calendar.google.com/calendar/ical/'.length - '/basic.ics'.length)}/basic.ics`],
  ['text that is not an address', 'not an address'],
  ['an address with a space', GOOD.replace('home', 'ho me')],
];

for (const [label, address] of REFUSED) {
  test(`R120 refused: ${label}; no request to any host, calendar-google-address-refused at 1, and the read still returns`, async () => {
    if (label === '2001 characters') assert.equal(address.length, 2001);
    const { fake, out } = await readOnce(address, { feeds: { [address]: feedOf('Never', 420, 450) } });
    assert.equal(fake.calls.length, 0, `a request was made: ${JSON.stringify(fake.calls.map((c) => c.url))}`);
    assert.deepEqual(out.warnings, [{ code: 'calendar-google-address-refused', count: 1, names: ['Home'] }]);
    assert.equal(out.value.error, 'unreadable');
  });
}

test('R120 one refused and one accepted address in two calendars: the accepted one is read and the refused one is named', async () => {
  const bad = GOOD.replace('calendar.google.com', 'evil.example');
  const good = addressFor('work');
  const { createGoogleSource } = await googleModule();
  const fake = fakeGoogleIcal({ feeds: { [bad]: feedOf('Never', 600, 660), [good]: feedOf('Standup', 420, 450) } });
  const source = createGoogleSource({ fetch: fake, addresses: { 1: bad, 2: good }, budgetMs: 500, requestMs: 300 });
  const out = await source.read({ calendars: [entry('Home', 1, 'personal'), entry('Work', 2)], tz: TZ, now: AT });
  assert.deepEqual(fake.calls.map((c) => c.url), [good]);
  assert.deepEqual(out.value.events, [{ title: 'Standup', start: '09:00', end: '09:30', kind: 'meeting' }]);
  assert.equal(out.value.stale, true);
  assert.deepEqual(out.warnings, [{ code: 'calendar-google-address-refused', count: 1, names: ['Home'] }]);
});

test('R120 a refused address in the environment lets the board start and load (through the loader)', async () => {
  const bad = GOOD.replace('https:', 'http:');
  const s = await session({
    calendar: { source: 'google', calendars: [{ name: 'Home' }] },
    vars: { BOARD_GOOGLE_ICAL_1: bad },
    feeds: { [bad]: feedOf('Never', 420, 450), [GOOD]: feedOf('Never', 420, 450) },
  });
  const v = await s.load();
  assert.equal(v.out.ok, true);
  assert.equal(s.fake.calls.length, 0);
  assert.deepEqual(warnOf(v.board, 'calendar-google-address-refused'), { code: 'calendar-google-address-refused', count: 1, names: ['Home'] });
});

test('R120 the test is applied before every request: a refused address is not retried on a later read', async () => {
  const bad = GOOD.replace('calendar.google.com', 'evil.example');
  const { createGoogleSource } = await googleModule();
  const fake = fakeGoogleIcal({ feeds: { [bad]: feedOf('Never', 420, 450) } });
  const source = createGoogleSource({ fetch: fake, addresses: { 1: bad }, budgetMs: 500, requestMs: 300 });
  const calendars = [entry('Home', 1)];
  await source.read({ calendars, tz: TZ, now: AT });
  await source.read({ calendars, tz: TZ, now: plus(AT, 6 * MIN) });
  assert.equal(fake.calls.length, 0);
});
