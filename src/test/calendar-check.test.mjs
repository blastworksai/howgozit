import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../scripts/calendar-check.mjs';
import { fakeCalDav } from '../fixtures/fake-caldav.mjs';
import { vevent, vcalendar } from '../fixtures/ics.mjs';
import { warningText } from '../board/render/page.mjs';

const USER = 'sentinel-user-7f3a@example.com';
const PASS = 'sentinel-pass-9c2e';
const NOW = '2026-10-12T06:10:00.000Z';
const ZONE = ['--timezone', 'Europe/Brussels'];

const TITLES = [
  'Zebra tasting 4417',
  'Quartz review 8820',
  'Holiday lantern 3306',
  'Tomorrow kite 5159',
];

function homeText() {
  return vcalendar(
    vevent({ uid: 'h1', summary: TITLES[0], start: '20261012T080000Z', end: '20261012T090000Z' }),
    vevent({ uid: 'h2', summary: TITLES[1], start: '20261012T120000Z', end: '20261012T130000Z' }),
    vevent({ uid: 'h3', summary: TITLES[2], start: '20261012', end: '20261013', allDay: true }),
    vevent({ uid: 'h4', summary: TITLES[3], start: '20261013T090000Z', end: '20261013T100000Z' }),
  );
}

function makeFake() {
  return fakeCalDav({
    user: USER,
    password: PASS,
    calendars: [
      { name: 'Home', ics: [homeText()] },
      { name: 'Work', ics: [] },
      { name: 'Family', ics: [] },
    ],
  });
}

async function drive(fake, argv, env = { BOARD_ICLOUD_USER: USER, BOARD_ICLOUD_APP_PASSWORD: PASS }) {
  const lines = [];
  const code = await run({ argv, env, fetch: fake.fetch, now: NOW, out: (line) => lines.push(line) });
  return { lines, code };
}

// No title, no user name, no password in any printed line.
function assertClean(lines, extraSecrets = []) {
  const all = lines.join('\n');
  for (const secret of [...TITLES, USER, PASS, ...extraSecrets]) {
    assert.ok(!all.includes(secret), `output must not contain ${secret}`);
  }
}

test('U lists the found calendars, then one count line per asked name', async () => {
  const fake = makeFake();
  const { lines, code } = await drive(fake, [...ZONE, '--calendar', 'Home', '--calendar', 'Work', '--calendar', 'Gym']);
  assert.equal(code, 0);
  assert.equal(lines.length, 7);
  assert.equal(lines[0], 'Calendars found in iCloud:');
  const names = ['Home', 'Work', 'Family'];
  names.forEach((name, i) => {
    assert.ok(lines[i + 1].includes(name), `line ${i + 1} names ${name}`);
    assert.ok(!lines[i + 1].includes(':'), 'a name line is not a count line');
  });
  assert.equal(lines[4], 'Home: 2 timed, 1 all-day today');
  assert.equal(lines[5], 'Work: 0 timed, 0 all-day today');
  assert.equal(lines[6], 'Gym: not found');
  assertClean(lines);
});

test('U the inbox and the Reminders task list are not listed as calendars', async () => {
  const { lines } = await drive(makeFake(), [...ZONE, '--calendar', 'Home']);
  const all = lines.join('\n');
  assert.ok(all.includes('Home') && all.includes('Work') && all.includes('Family'));
  assert.ok(!/inbox/i.test(all));
  assert.ok(!all.includes('Reminders'));
});

test('U without --calendar only the found names are printed', async () => {
  const { lines, code } = await drive(makeFake(), [...ZONE]);
  assert.equal(code, 0);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'Calendars found in iCloud:');
  ['Home', 'Work', 'Family'].forEach((name, i) => assert.ok(lines[i + 1].includes(name)));
  assert.ok(!lines.join('\n').includes('today'));
  assertClean(lines);
});

test('U the calendar names appear in the output while no event title does', async () => {
  const { lines } = await drive(makeFake(), [...ZONE, '--calendar', 'Home']);
  const all = lines.join('\n');
  for (const name of ['Home', 'Work', 'Family']) assert.ok(all.includes(name));
  assertClean(lines);
});

test('U a full run sends only PROPFIND and REPORT requests', async () => {
  const fake = makeFake();
  await drive(fake, [...ZONE, '--calendar', 'Home', '--calendar', 'Work']);
  assert.ok(fake.calls.length > 0);
  const methods = new Set(fake.calls.map((c) => c.method));
  assert.deepEqual([...methods].sort(), ['PROPFIND', 'REPORT']);
});

test('U with neither variable set, one line names both and nothing is sent', async () => {
  const fake = makeFake();
  const { lines, code } = await drive(fake, [...ZONE], {});
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('BOARD_ICLOUD_USER'));
  assert.ok(lines[0].includes('BOARD_ICLOUD_APP_PASSWORD'));
  assert.equal(fake.calls.length, 0);
});

test('U with only the user set, one line names both and nothing is sent', async () => {
  const fake = makeFake();
  const { lines, code } = await drive(fake, [...ZONE], { BOARD_ICLOUD_USER: USER });
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('BOARD_ICLOUD_USER'));
  assert.ok(lines[0].includes('BOARD_ICLOUD_APP_PASSWORD'));
  assert.equal(fake.calls.length, 0);
  assertClean(lines);
});

test('U with only the password set, one line names both and nothing is sent', async () => {
  const fake = makeFake();
  const { lines, code } = await drive(fake, [...ZONE], { BOARD_ICLOUD_APP_PASSWORD: PASS });
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('BOARD_ICLOUD_USER'));
  assert.ok(lines[0].includes('BOARD_ICLOUD_APP_PASSWORD'));
  assert.equal(fake.calls.length, 0);
  assertClean(lines);
});

test('U a wrong password prints the login-refused sentence and returns 1', async () => {
  const wrong = 'sentinel-wrong-1d84';
  const { lines, code } = await drive(
    makeFake(),
    [...ZONE, '--calendar', 'Home'],
    { BOARD_ICLOUD_USER: USER, BOARD_ICLOUD_APP_PASSWORD: wrong },
  );
  assert.equal(code, 1);
  assert.deepEqual(lines, [warningText({ code: 'calendar-login-refused', count: 1 })]);
  assertClean(lines, [wrong]);
});

test('U a dead service prints the unreachable sentence and returns 1', async () => {
  const fake = makeFake();
  fake.state.fail = { step: 'principal', status: 'network' };
  const { lines, code } = await drive(fake, [...ZONE, '--calendar', 'Home']);
  assert.equal(code, 1);
  assert.deepEqual(lines, [warningText({ code: 'calendar-unreachable', count: 1 })]);
  assertClean(lines);
});

test('U an unknown time zone prints one plain line, returns 1 and sends nothing', async () => {
  const fake = makeFake();
  const { lines, code } = await drive(fake, ['--timezone', 'Mars/Olympus', '--calendar', 'Home']);
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /time ?zone/i);
  assert.match(lines[0], /not known|unknown/i);
  assert.equal(fake.calls.length, 0);
  assertClean(lines);
});

test('U an event the board cannot work out gives the skipped warning and still returns 0', async () => {
  const hourly = 'Hourly chime 6072';
  const fake = fakeCalDav({
    user: USER,
    password: PASS,
    calendars: [
      {
        name: 'Home',
        ics: [vcalendar(vevent({
          uid: 'x1', summary: hourly, start: '20261012T080000Z', end: '20261012T090000Z', rrule: 'FREQ=HOURLY',
        }))],
      },
    ],
  });
  const { lines, code } = await drive(fake, [...ZONE, '--calendar', 'Home']);
  assert.equal(code, 0);
  const warning = warningText({ code: 'calendar-event-skipped', count: 1 });
  assert.equal(lines.filter((l) => l === warning).length, 1);
  assert.ok(lines.some((l) => l.startsWith('Home: ')));
  assertClean(lines, [hourly]);
});

test('U a clean run prints no skipped warning', async () => {
  const { lines } = await drive(makeFake(), [...ZONE, '--calendar', 'Home']);
  assert.ok(!lines.includes(warningText({ code: 'calendar-event-skipped', count: 1 })));
});
