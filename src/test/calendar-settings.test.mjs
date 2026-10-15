// Contract R104 (the calendar settings block), the environment part of R102, the stale flag of R52,
// and the six calendar sentences. Written from the contract and the calendar spec, not from the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCalendarSetting, withDefaults, checkSettings } from '../board/shape-settings.mjs';
import { readIcloud, readEnv } from '../board/env.mjs';
import { checkState } from '../board/shape-data.mjs';
import { warningText, renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { board, settings, state } from '../fixtures/build.mjs';

const warn = (b, code) => (b.meta?.warnings ?? []).find((w) => w.code === code);
const source = (b, id) => b.meta?.sources?.find((s) => s.id === id);

function baseSettings() {
  return { version: 1, name: 'Sam', timezone: 'UTC', projects: [], focus: [] };
}

// ---------- R104: readCalendarSetting ----------

test('R104 the contract example keeps Home as personal, Work and Gym as meeting, and counts 3 problems', () => {
  const r = readCalendarSetting({
    source: 'icloud',
    calendars: [
      { name: 'Home', kind: 'personal' },
      { name: 'Work' },
      { name: ' ' },
      { name: 'home' },
      { name: 'Gym', kind: 'sport' },
    ],
  });
  assert.deepEqual(r, {
    setting: {
      source: 'icloud',
      calendars: [
        { name: 'Home', kind: 'personal' },
        { name: 'Work', kind: 'meeting' },
        { name: 'Gym', kind: 'meeting' },
      ],
    },
    invalid: 3,
  });
});

test('R104 a source other than icloud gives no setting and one problem', () => {
  assert.deepEqual(readCalendarSetting({ source: 'yahoo', calendars: [{ name: 'Home' }] }), { setting: null, invalid: 1 });
});

test('R104 an absent block gives no setting and no problem', () => {
  assert.deepEqual(readCalendarSetting(undefined), { setting: null, invalid: 0 });
});

test('R104 25 good entries keep 20 and count 5', () => {
  const calendars = Array.from({ length: 25 }, (_, i) => ({ name: `Cal ${i + 1}`, kind: 'focus' }));
  const r = readCalendarSetting({ source: 'icloud', calendars });
  assert.equal(r.setting.calendars.length, 20);
  assert.equal(r.invalid, 5);
  assert.deepEqual(r.setting.calendars.map((c) => c.name), calendars.slice(0, 20).map((c) => c.name));
});

test('U exactly 20 good entries keep 20 and count 0', () => {
  const calendars = Array.from({ length: 20 }, (_, i) => ({ name: `Cal ${i + 1}` }));
  const r = readCalendarSetting({ source: 'icloud', calendars });
  assert.equal(r.setting.calendars.length, 20);
  assert.equal(r.invalid, 0);
});

test('U a block that is not an object gives no setting and one problem', () => {
  for (const v of [null, 'icloud', 5, true, ['icloud']]) {
    assert.deepEqual(readCalendarSetting(v), { setting: null, invalid: 1 }, JSON.stringify(v));
  }
});

test('U calendars that is not a list gives no setting and one problem', () => {
  for (const calendars of [undefined, 'Home', { name: 'Home' }, 3, null]) {
    assert.deepEqual(readCalendarSetting({ source: 'icloud', calendars }), { setting: null, invalid: 1 }, JSON.stringify(calendars));
  }
});

test('U a name of 101 characters is dropped and counted, and 100 is kept', () => {
  const long = 'x'.repeat(101);
  const ok = 'y'.repeat(100);
  const r = readCalendarSetting({ source: 'icloud', calendars: [{ name: long }, { name: ok }] });
  assert.deepEqual(r, { setting: { source: 'icloud', calendars: [{ name: ok, kind: 'meeting' }] }, invalid: 1 });
});

test('U a name is trimmed', () => {
  const r = readCalendarSetting({ source: 'icloud', calendars: [{ name: '  Home  ', kind: 'habit' }] });
  assert.deepEqual(r, { setting: { source: 'icloud', calendars: [{ name: 'Home', kind: 'habit' }] }, invalid: 0 });
});

test('U an entry that is a string is dropped and counted', () => {
  const r = readCalendarSetting({ source: 'icloud', calendars: ['Home', { name: 'Work' }] });
  assert.deepEqual(r, { setting: { source: 'icloud', calendars: [{ name: 'Work', kind: 'meeting' }] }, invalid: 1 });
});

test('U an entry whose name is not a string is dropped and counted', () => {
  const r = readCalendarSetting({ source: 'icloud', calendars: [{ name: 5 }, { name: null }, {}, null, { name: 'Work' }] });
  assert.deepEqual(r, { setting: { source: 'icloud', calendars: [{ name: 'Work', kind: 'meeting' }] }, invalid: 4 });
});

test('U all four kinds are kept as given', () => {
  const kinds = ['meeting', 'focus', 'personal', 'habit'];
  const r = readCalendarSetting({ source: 'icloud', calendars: kinds.map((kind, i) => ({ name: `C${i}`, kind })) });
  assert.deepEqual(r.setting.calendars.map((c) => c.kind), kinds);
  assert.equal(r.invalid, 0);
});

test('U all entries bad gives no setting and the count', () => {
  const r = readCalendarSetting({ source: 'icloud', calendars: [{ name: '' }, 'Home', { name: '   ' }] });
  assert.deepEqual(r, { setting: null, invalid: 3 });
});

test('U an empty list gives no setting and no problem', () => {
  assert.deepEqual(readCalendarSetting({ source: 'icloud', calendars: [] }), { setting: null, invalid: 0 });
});

test('U the returned setting source is icloud', () => {
  const r = readCalendarSetting({ source: 'icloud', calendars: [{ name: 'Home' }] });
  assert.equal(r.setting.source, 'icloud');
});

test('U a repeated name differing only by case and spaces is dropped, the first spelling kept', () => {
  const r = readCalendarSetting({ source: 'icloud', calendars: [{ name: 'Home' }, { name: ' HOME ' }] });
  assert.deepEqual(r.setting.calendars, [{ name: 'Home', kind: 'meeting' }]);
  assert.equal(r.invalid, 1);
});

// ---------- R104: withDefaults and buildBoard ----------

test('R104 withDefaults drops a bad block and warns once per problem', () => {
  const calls = [];
  const s = { ...baseSettings(), calendar: { source: 'icloud', calendars: [{ name: 'Home' }, { name: ' ' }, { name: 'home' }, { name: 'Gym', kind: 'sport' }] } };
  const out = withDefaults(s, (c) => calls.push(c));
  assert.deepEqual(calls, ['setting-invalid', 'setting-invalid', 'setting-invalid']);
  assert.deepEqual(out.calendar, {
    source: 'icloud',
    calendars: [{ name: 'Home', kind: 'meeting' }, { name: 'Gym', kind: 'meeting' }],
  });
});

test('R104 withDefaults removes the calendar key when the block switches the connector off', () => {
  const calls = [];
  const s = { ...baseSettings(), calendar: { source: 'yahoo', calendars: [{ name: 'Home' }] } };
  const out = withDefaults(s, (c) => calls.push(c));
  assert.deepEqual(calls, ['setting-invalid']);
  assert.equal('calendar' in out, false);
});

test('R104 withDefaults with the block absent adds no key and no warning', () => {
  const calls = [];
  const out = withDefaults(baseSettings(), (c) => calls.push(c));
  assert.deepEqual(calls, []);
  assert.equal('calendar' in out, false);
});

test('R104 withDefaults keeps a good block cleaned, silently', () => {
  const calls = [];
  const s = { ...baseSettings(), calendar: { source: 'icloud', calendars: [{ name: ' Home ', kind: 'personal' }] } };
  const out = withDefaults(s, (c) => calls.push(c));
  assert.deepEqual(calls, []);
  assert.deepEqual(out.calendar, { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }] });
});

test('R104 buildBoard turns a bad block into setting-invalid in the warnings with the right count', () => {
  const b = board({
    settings: settings({
      calendar: { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }, { name: 'Work' }, { name: ' ' }, { name: 'home' }, { name: 'Gym', kind: 'sport' }] },
    }),
  });
  assert.deepEqual(warn(b, 'setting-invalid'), { code: 'setting-invalid', count: 3 });
});

test('R104 buildBoard with a source other than icloud counts 1', () => {
  const b = board({ settings: settings({ calendar: { source: 'yahoo', calendars: [{ name: 'Home' }] } }) });
  assert.deepEqual(warn(b, 'setting-invalid'), { code: 'setting-invalid', count: 1 });
});

test('R104 buildBoard with a good block raises no setting-invalid', () => {
  const b = board({ settings: settings({ calendar: { source: 'icloud', calendars: [{ name: 'Home', kind: 'personal' }, { name: 'Work' }] } }) });
  assert.equal(warn(b, 'setting-invalid'), undefined);
});

test('R104 buildBoard with the block absent raises no setting-invalid', () => {
  assert.equal(warn(board({ settings: settings() }), 'setting-invalid'), undefined);
});

test('R104 buildBoard with 25 good entries counts 5', () => {
  const calendars = Array.from({ length: 25 }, (_, i) => ({ name: `Cal ${i + 1}` }));
  const b = board({ settings: settings({ calendar: { source: 'icloud', calendars } }) });
  assert.deepEqual(warn(b, 'setting-invalid'), { code: 'setting-invalid', count: 5 });
});

test('R104 checkSettings stays ok for a nonsense calendar block, the block being soft', () => {
  for (const calendar of ['nonsense', 5, null, { source: 'yahoo' }, { source: 'icloud', calendars: 'x' }, { source: 'icloud', calendars: [1, { name: '' }] }]) {
    assert.deepEqual(checkSettings({ ...baseSettings(), calendar }), { ok: true, errors: [] }, JSON.stringify(calendar));
  }
});

test('R104 checkSettings fails for a key named password inside the block, naming the key and not the value', () => {
  const VALUE = 'SENTINEL-PASSWORD-VALUE-9';
  const r = checkSettings({ ...baseSettings(), calendar: { source: 'icloud', calendars: [{ name: 'Home' }], password: VALUE } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('password')), JSON.stringify(r.errors));
  assert.ok(!JSON.stringify(r.errors).includes(VALUE));
});

test('R104 checkSettings fails for a password key nested in a calendar entry too', () => {
  const VALUE = 'SENTINEL-NESTED-VALUE-7';
  const r = checkSettings({ ...baseSettings(), calendar: { source: 'icloud', calendars: [{ name: 'Home', password: VALUE }] } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('password')));
  assert.ok(!JSON.stringify(r.errors).includes(VALUE));
});

// ---------- R102: the sign-in in the environment ----------

const USER = 'sentinel-apple-user@example.com';
const PASS = 'SENTINEL-APP-PASSWORD-abcd';

test('R102 both variables set give the sign-in, trimmed', () => {
  const r = readIcloud({ BOARD_ICLOUD_USER: `  ${USER} `, BOARD_ICLOUD_APP_PASSWORD: ` ${PASS}  ` });
  assert.deepEqual(r, { ok: true, icloud: { user: USER, password: PASS } });
});

test('R102 neither variable set gives null', () => {
  assert.deepEqual(readIcloud({}), { ok: true, icloud: null });
  assert.deepEqual(readIcloud({ BOARD_ICLOUD_USER: '  ', BOARD_ICLOUD_APP_PASSWORD: '' }), { ok: true, icloud: null });
});

test('R102 only the user is a refusal naming both variables and holding neither value', () => {
  const r = readIcloud({ BOARD_ICLOUD_USER: USER });
  assert.equal(r.ok, false);
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.includes('BOARD_ICLOUD_USER'));
  assert.ok(r.message.includes('BOARD_ICLOUD_APP_PASSWORD'));
  assert.ok(!r.message.includes(USER));
  assert.ok(!r.message.includes(PASS));
  assert.ok(!r.message.includes('\n'));
});

test('R102 only the password is a refusal naming both variables and holding neither value', () => {
  const r = readIcloud({ BOARD_ICLOUD_APP_PASSWORD: PASS });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('BOARD_ICLOUD_USER'));
  assert.ok(r.message.includes('BOARD_ICLOUD_APP_PASSWORD'));
  assert.ok(!r.message.includes(PASS));
  assert.ok(!r.message.includes(USER));
});

test('R102 a whitespace-only variable counts as not set', () => {
  const r = readIcloud({ BOARD_ICLOUD_USER: USER, BOARD_ICLOUD_APP_PASSWORD: '   ' });
  assert.equal(r.ok, false);
  assert.ok(!r.message.includes(USER));
});

const GH = { BOARD_GITHUB_TOKEN: 'SENTINEL-GH-TOKEN', BOARD_REPO: 'owner/data' };

test('R102 readEnv carries the sign-in through as env.icloud', () => {
  const r = readEnv({ ...GH, BOARD_ICLOUD_USER: USER, BOARD_ICLOUD_APP_PASSWORD: PASS });
  assert.equal(r.ok, true);
  assert.deepEqual(r.env.icloud, { user: USER, password: PASS });
});

test('R102 readEnv without the variables gives env.icloud null', () => {
  const r = readEnv(GH);
  assert.equal(r.ok, true);
  assert.equal(r.env.icloud, null);
});

test('R102 readEnv passes the refusal on, holding neither value', () => {
  for (const extra of [{ BOARD_ICLOUD_USER: USER }, { BOARD_ICLOUD_APP_PASSWORD: PASS }]) {
    const r = readEnv({ ...GH, ...extra });
    assert.equal(r.ok, false);
    assert.ok(r.message.includes('BOARD_ICLOUD_USER'));
    assert.ok(r.message.includes('BOARD_ICLOUD_APP_PASSWORD'));
    assert.ok(!r.message.includes(USER));
    assert.ok(!r.message.includes(PASS));
    assert.ok(!r.message.includes('SENTINEL-GH-TOKEN'));
  }
});

// ---------- R52: the stale flag on the calendar ----------

const TODAY_CAL = { date: '2026-10-12', events: [{ title: 'Standup', start: '08:30', end: '08:45', kind: 'meeting' }] };

test('R52 a calendar dated today that carries stale true is a stale panel and a stale source', () => {
  const b = board({ state: state({ calendar: { ...TODAY_CAL, stale: true } }) });
  assert.equal(b.panels.calendar.stale, true);
  assert.equal(source(b, 'calendar')?.state, 'stale');
});

test('R52 the same calendar without stale is neither', () => {
  const b = board({ state: state({ calendar: { ...TODAY_CAL } }) });
  assert.equal(b.panels.calendar.stale, false);
  assert.equal(source(b, 'calendar')?.state, 'ok');
});

test('R52 stale false is the same as no stale', () => {
  const b = board({ state: state({ calendar: { ...TODAY_CAL, stale: false } }) });
  assert.equal(b.panels.calendar.stale, false);
  assert.equal(source(b, 'calendar')?.state, 'ok');
});

test('R52 stale that is not a boolean is a broken panel', () => {
  const b = board({ state: state({ calendar: { ...TODAY_CAL, stale: 'yes' } }) });
  assert.deepEqual(b.panels.calendar, { error: 'unreadable' });
  assert.equal(source(b, 'calendar')?.state, 'error');
});

// ---------- U: checkState for the calendar ----------

test('U checkState calendar accepts stale true, stale false and no stale', () => {
  for (const extra of [{ stale: true }, { stale: false }, {}]) {
    const r = checkState('calendar', { ...TODAY_CAL, ...extra });
    assert.equal(r.ok, true, JSON.stringify(extra) + ' ' + JSON.stringify(r));
  }
});

test('U checkState calendar refuses stale that is not a boolean', () => {
  for (const stale of [1, 0, 'yes', null, {}]) {
    assert.equal(checkState('calendar', { ...TODAY_CAL, stale }).ok, false, JSON.stringify(stale));
  }
});

// ---------- U: the six sentences ----------

const w = (code, count) => ({ code, count });

test('U warningText: calendar-no-login', () => {
  assert.equal(warningText(w('calendar-no-login', 1)),
    'The settings name iCloud calendars, but this board was started without an iCloud sign-in, so the calendar is not shown.');
});

test('U warningText: calendar-login-refused', () => {
  assert.equal(warningText(w('calendar-login-refused', 1)),
    'iCloud did not accept the sign-in, so the calendar could not be read. The app-specific password may have been removed.');
});

test('U warningText: calendar-unreachable', () => {
  assert.equal(warningText(w('calendar-unreachable', 1)), 'iCloud did not answer, so the calendar may be out of date.');
});

test('U warningText: calendar-not-found singular and plural', () => {
  assert.equal(warningText(w('calendar-not-found', 1)), '1 calendar named in the settings was not found in iCloud.');
  assert.equal(warningText(w('calendar-not-found', 3)), '3 calendars named in the settings were not found in iCloud.');
});

test('U warningText: calendar-event-skipped singular and plural', () => {
  assert.equal(warningText(w('calendar-event-skipped', 1)), '1 calendar event could not be read and is not shown.');
  assert.equal(warningText(w('calendar-event-skipped', 2)), '2 calendar events could not be read and are not shown.');
});

test('U warningText: calendar-zone-unknown singular and plural', () => {
  assert.equal(warningText(w('calendar-zone-unknown', 1)),
    '1 calendar event names a time zone this board does not know, so its time may be off.');
  assert.equal(warningText(w('calendar-zone-unknown', 4)),
    '4 calendar events name a time zone this board does not know, so their times may be off.');
});

test('U the page footer shows the sentence of a calendar warning the board carries', () => {
  const b = board({ settings: settings() });
  const withWarn = JSON.parse(JSON.stringify(b));
  withWarn.meta.warnings = [w('calendar-not-found', 2), w('calendar-unreachable', 1)];
  const theme = resolveTheme(null).theme;
  const html = renderPage(withWarn, theme, { styleNonce: 'n', formToken: () => 't' });
  assert.ok(html.includes('2 calendars named in the settings were not found in iCloud.'));
  assert.ok(html.includes('iCloud did not answer, so the calendar may be out of date.'));
  // twin: without the warnings the sentences are absent
  const clean = renderPage(b, theme, { styleNonce: 'n', formToken: () => 't' });
  assert.ok(!clean.includes('not found in iCloud'));
  assert.ok(!clean.includes('iCloud did not answer'));
});
