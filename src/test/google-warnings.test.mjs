// Tests of R125 (each reason has its own warning, said in plain words with the calendar's name and never its address)
// and R127 (with the agent's file, Google works as iCloud does: R109 to R115 re-run with source `google`),
// written from the contract before the code exists, against the invented Google of fixtures/fake-google-ical.mjs.
// board/calendar/google.mjs, readGoogleIcal and the loader's googleCalendar option do not exist yet and are reached
// lazily, so each test fails by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../board/load.mjs';
import { buildBoard } from '../board/model.mjs';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { settings } from '../fixtures/build.mjs';
import { fakeGoogleIcal, icsFeed } from '../fixtures/fake-google-ical.mjs';

const OWNER = 'sam-life';
const REPO = 'sam-life/life';
const R = '/repos/' + REPO;
const AT = '2026-10-12T06:10:00.900Z'; // 08:10 on 12 October in Europe/Brussels (UTC+2)
const TODAY = '2026-10-12';
const TZ = 'Europe/Brussels';
const MIN = 60 * 1000;
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const HOSTILE = '"><script>alert(1)</script>&\'';
const FILE_UNREADABLE_TEXT = 'The calendar file from the agent could not be read, so its events are not shown.';
const GOOGLE_SENTENCE = 'The calendar could not be read from Google. See the note at the foot of the page.';
const ICLOUD_CODES = ['calendar-no-login', 'calendar-login-refused', 'calendar-unreachable'];
const SIX = [
  'calendar-google-no-address', 'calendar-google-address-refused', 'calendar-google-address-rejected',
  'calendar-google-unreachable', 'calendar-google-not-a-calendar', 'calendar-google-too-large',
];

// The exact page text of R125, for the names already written as `"Home", "Work"`.
const SENTENCE = {
  'calendar-google-no-address': (n) => `No secret address was set for these Google calendars, so they are not shown: ${n}. Copy the address from Google Calendar and set it where the board starts.`,
  'calendar-google-address-refused': (n) => `The secret address set for these Google calendars is not one the board will use, so they are not shown: ${n}. Copy the address from Google Calendar again.`,
  'calendar-google-address-rejected': (n) => `Google did not accept the secret address for these calendars, so they could not be read: ${n}. The address may have been reset. Copy it from Google Calendar again.`,
  'calendar-google-unreachable': (n) => `Google did not answer for these calendars, so they may be out of date: ${n}.`,
  'calendar-google-not-a-calendar': (n) => `Google sent something that is not a calendar for these calendars, so they could not be read: ${n}. Copy the secret address from Google Calendar again.`,
  'calendar-google-too-large': (n) => `These Google calendars are too large for the board to read, so they are not shown: ${n}.`,
};
const quoted = (names) => names.map((n) => `"${n}"`).join(', ');

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

// ---- givens ----

const two = (n) => String(n).padStart(2, '0');
const gz = (min, day = '20261012') => `${day}T${two(Math.floor(min / 60))}${two(min % 60)}00Z`;
// Minutes after 00:00 Brussels (UTC+2) on 12 October, written as the UTC instant a feed holds.
const gEv = (title, startMin, endMin, day) => ({ title, start: gz(startMin - 120, day), end: gz(endMin - 120, day) });
const gDay = (title) => ({ title, start: '20261012', end: '20261013', allDay: true });
const hm = (min) => `${two(Math.floor(min / 60))}:${two(min % 60)}`;
const fEv = (title, startMin, endMin, kind = 'meeting') => ({ title, start: hm(startMin), end: hm(endMin), kind });
const entry = (name, place, kind = 'meeting') => ({ name, kind, place });

// Sentinel-flavoured invented addresses, one per place; the page must show no part of them.
const addrOf = (p) => `https://calendar.google.com/calendar/ical/SENTINEL-CAL-ID-${p}/private-SENTINEL-TOKEN-${p}/basic.ics`;
const refusedOf = (p) => `http://calendar.google.com/calendar/ical/SENTINEL-CAL-ID-${p}/private-SENTINEL-TOKEN-${p}/basic.ics`;
const HOME = addrOf(1);
const WORK = addrOf(2);
const HTML_ANSWER = { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>Sign in to continue</body></html>' };

// The six conditions of R125, numbered as the rule numbers them. `give(place)` says what a calendar at that place has.
const COND = {
  1: { code: SIX[0], give: () => ({}) },
  2: { code: SIX[1], give: (p) => ({ address: refusedOf(p) }) },
  3: { code: SIX[2], give: (p) => ({ address: addrOf(p), feed: { status: 404 } }) },
  4: { code: SIX[3], give: (p) => ({ address: addrOf(p), feed: { status: 503 } }) },
  5: { code: SIX[4], give: (p) => ({ address: addrOf(p), feed: HTML_ANSWER }) },
  6: { code: SIX[5], give: (p) => ({ address: addrOf(p), feed: { stream: 10000001 } }) },
};

// ---- a fake GitHub world and one loader session ----

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

// block: the settings' calendar block as written. includeFile: put into the block (null = leave the key out).
// vars: the BOARD_GOOGLE_ICAL_<n> environment; feeds: the stand-in's answers.
async function session({ block, includeFile = null, vars = {}, feeds = {}, file = null, at = AT, tz = TZ } = {}) {
  const fake = fakeGoogleIcal({ feeds });
  const { createGoogleSource } = await googleModule();
  const googleCalendar = createGoogleSource({ fetch: fake, addresses: (await readGoogleIcal(vars)) ?? {}, budgetMs: 800, requestMs: 400 });
  const githubCalls = [];
  const calendar = block === undefined ? undefined : (includeFile === null ? { ...block } : { ...block, includeFile });
  const fileText = file === null ? null : typeof file === 'string' ? file : JSON.stringify(file);
  const files = {
    'board.config.json': JSON.stringify(settings({ timezone: tz, ...(calendar === undefined ? {} : { calendar }) })),
    'theme.json': null,
    'state/brief.json': null,
    'state/calendar.json': fileText,
    'state/inbox.json': null,
    'state/log.json': null,
    'state/proposals.json': null,
  };
  const cache = { async readLastGood() { return null; }, async writeLastGood() {}, etags: { get() {}, set() {} } };
  const clock = { t: Date.parse(at), now() { return clock.t; } };
  const env = { repo: REPO, readOnly: false, configDir: null, token: 'SENTINEL-GH-TOKEN-1' };
  const loader = createLoader({ http: makeHttp(files, githubCalls), env, cache, clock, googleCalendar });
  return {
    fake, githubCalls, files, clock,
    async load() {
      const out = await loader.load();
      assert.equal(out.ok, true, 'the board did not load (the harness is wrong, not the rule)');
      const board = buildBoard({ ...out.bundle, now: new Date(clock.t).toISOString() });
      const html = renderPage(board, THEME, OPTS);
      const warns = board.meta.warnings || [];
      return {
        out, board, html, panel: board.panels.calendar, warns,
        calSource: (board.meta.sources || []).find((x) => x.id === 'calendar'),
        google: warns.filter((w) => SIX.includes(w.code)),
        calWarnings: warns.filter((w) => w.code.startsWith('calendar-')),
        requests: fake.calls.map((c) => c.method + ' ' + c.url),
      };
    },
  };
}
const run = async (opts) => (await session(opts)).load();

// ---- reading the page ----

const strip = (s) => s.replace(/<[^>]*>/g, '');
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const count = (s, re) => (s.match(re) || []).length;
const hrefs = (html) => [...html.matchAll(/\shref\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);

// The warnings of the page's footer, one string each, escapes undone.
function footerItems(html) {
  const m = html.match(/<ul class="warnings">([\s\S]*?)<\/ul>/);
  return m ? [...m[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => unesc(x[1])) : [];
}
function calendarSection(html) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ name: m[1], start: html.lastIndexOf('<', m.index) }));
  const i = marks.findIndex((m) => m.name === 'calendar');
  assert.ok(i >= 0, 'the page has no calendar section');
  return html.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].start : html.length);
}
const ATTR = (name) => new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\s${name}(?=[\\s=>/])[^>]*>([\\s\\S]*?)</\\1>`, 'g');
const elementsWith = (html, name) => [...html.matchAll(ATTR(name))].map((m) => ({ inner: m[2], text: unesc(strip(m[2])) }));
const SOURCE_EL = /<[a-zA-Z][a-zA-Z0-9]*\b[^>]*\sdata-source(?=[\s=>/])[^>]*>([^<]*)</g;
const ALLDAY_EL = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\sdata-allday(?=[\s=>/])[^>]*>([\s\S]*?)<\/\1>/;
function pageEvents(html) {
  const section = calendarSection(html).replace(ALLDAY_EL, '');
  const titles = [...section.matchAll(/class="cal-event__title">([^<]*)</g)].map((m) => unesc(m[1]));
  const words = [...section.matchAll(SOURCE_EL)].map((m) => unesc(m[1]));
  assert.equal(words.length, titles.length, 'every event of the page needs exactly one data-source element');
  return titles.map((t, i) => [t, words[i]]);
}
function pageAllDay(html) {
  const m = calendarSection(html).match(ALLDAY_EL);
  assert.ok(m, 'no data-allday element');
  const inner = m[2].replace(/<span class="cal-allday-label">[^<]*<\/span>/, '');
  return inner.split(' · ').map((seg) => {
    const word = [...seg.matchAll(SOURCE_EL)].map((x) => unesc(x[1]));
    assert.equal(word.length, 1, 'each all-day title needs one data-source element: ' + seg);
    return [unesc(seg.replace(/<[^>]*>/g, '').trim().slice(0, -word[0].length).trim()), word[0]];
  });
}
const head = (html) => {
  const m = calendarSection(html).match(/card__note">(\d+) events?</);
  assert.ok(m, 'no event count in the head of the calendar card');
  return Number(m[1]);
};
const rows = (panel) => panel.events.map((e) => [e.title, e.source]);

// ======================= R125 =======================

// What one run of the board must show for `names` (their settings names), all in condition `cond`.
function assertWarning(v, code, names, why) {
  const found = v.google;
  assert.deepEqual(found, [{ code, count: names.length, names }], `${why}: expected exactly ${code} at ${names.length} with names ${JSON.stringify(names)}; the board raised ${JSON.stringify(v.warns)}`);
  for (const c of ICLOUD_CODES) assert.equal(v.warns.some((w) => w.code === c), false, `${why}: the iCloud warning ${c} was raised for the Google source`);
  const sum = found.reduce((a, w) => a + w.count, 0);
  assert.equal(sum, names.length, `${why}: each calendar raises at most one of the six, so the counts must add up to ${names.length}`);
  const sentence = SENTENCE[code](quoted(names));
  const items = footerItems(v.html);
  assert.ok(items.includes(sentence), `${why}: the page lacks the exact sentence\n  ${sentence}\nthe footer holds ${JSON.stringify(items)}`);
  assert.equal(items.filter((i) => i === sentence).length, 1, `${why}: the sentence must appear once`);
  assert.equal(v.html.includes('SENTINEL-CAL-ID') || v.html.includes('SENTINEL-TOKEN'), false, `${why}: a part of the address is on the page`);
}

async function runCondition(cond, names) {
  const vars = {}; const feeds = {};
  names.forEach((_, i) => {
    const g = COND[cond].give(i + 1);
    if (g.address) vars[`BOARD_GOOGLE_ICAL_${i + 1}`] = g.address;
    if (g.feed !== undefined) feeds[g.address] = g.feed;
  });
  const s = await session({ block: { source: 'google', calendars: names.map((name) => ({ name })) }, vars, feeds });
  const v = await s.load();
  return { s, v };
}

for (const cond of [1, 2, 3, 4, 5, 6]) {
  const { code } = COND[cond];
  test(`R125 ${code} on Home alone: count 1, names ["Home"], and the exact page sentence with "Home"`, async () => {
    const { s, v } = await runCondition(cond, ['Home']);
    assertWarning(v, code, ['Home'], code + ' / one calendar');
    if (cond === 1 || cond === 2) assert.equal(s.fake.calls.length, 0, 'a calendar with no usable address must not be requested');
  });
  test(`R125 ${code} on Home and Work together: count 2, names in settings order, and the exact page sentence with "Home", "Work"`, async () => {
    const { v } = await runCondition(cond, ['Home', 'Work']);
    assertWarning(v, code, ['Home', 'Work'], code + ' / two calendars');
  });
}

test('R125 names keep the order of the settings, not the order in which the answers arrive', async () => {
  // Home answers late, Work at once: both fail with 404; names must still be Home, Work.
  const s = await session({
    block: { source: 'google', calendars: [{ name: 'Home' }, { name: 'Work' }] },
    vars: { BOARD_GOOGLE_ICAL_1: HOME, BOARD_GOOGLE_ICAL_2: WORK },
    feeds: { [HOME]: { status: 404, delayMs: 150 }, [WORK]: { status: 404 } },
  });
  const v = await s.load();
  assertWarning(v, 'calendar-google-address-rejected', ['Home', 'Work'], 'late answer');
});

test('R125 the status table: 401, 403, 404 and 410 give address-rejected; 429, 500, 503 and any other status give unreachable', async () => {
  const { createGoogleSource } = await googleModule();
  const table = [[401, SIX[2]], [403, SIX[2]], [404, SIX[2]], [410, SIX[2]], [429, SIX[3]], [500, SIX[3]], [503, SIX[3]], [418, SIX[3]], [502, SIX[3]]];
  for (const [status, code] of table) {
    const fake = fakeGoogleIcal({ feeds: { [HOME]: icsFeed([gEv('Dentist', 480, 540)]), [WORK]: { status } } });
    const source = createGoogleSource({ fetch: fake, addresses: { 1: HOME, 2: WORK }, budgetMs: 800, requestMs: 400 });
    const out = await source.read({ calendars: [entry('Home', 1), entry('Work', 2)], tz: TZ, now: AT });
    const raised = out.warnings.filter((w) => SIX.includes(w.code));
    assert.deepEqual(raised, [{ code, count: 1, names: ['Work'] }], `status ${status} on Work with Home read well: expected ${code} naming only Work`);
    assert.equal(out.value.events.some((e) => e.title === 'Dentist'), true, `status ${status}: Home was read and must be shown`);
  }
});

test('R125 other ways of not being read: a refused redirect, a fourth redirect in a row, no Location, no connection and a time limit', async () => {
  const { createGoogleSource } = await googleModule();
  const a = (k) => addrOf(10 + k);
  const cases = [
    ['a redirect to accounts.google.com', { [HOME]: { redirect: 'https://accounts.google.com/ServiceLogin' } }, SIX[2]],
    ['a redirect to another host', { [HOME]: { redirect: 'https://evil.example/x' } }, SIX[2]],
    ['a redirect to http:', { [HOME]: { redirect: refusedOf(5) } }, SIX[2]],
    ['four redirects in a row', { [HOME]: { redirect: a(1) }, [a(1)]: { redirect: a(2) }, [a(2)]: { redirect: a(3) }, [a(3)]: { redirect: a(4) }, [a(4)]: icsFeed([gEv('Late', 480, 540)]) }, SIX[3]],
    ['a redirect with no Location', { [HOME]: { redirect: '' } }, SIX[3]],
    ['an address the network cannot reach', {}, SIX[3]],
    ['an answer that never comes', { [HOME]: { never: true } }, SIX[3]],
    ['status 204 with no body', { [HOME]: { status: 204 } }, SIX[4]],
    ['a 200 that stops before END:VCALENDAR', { [HOME]: { status: 200, body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' } }, SIX[4]],
  ];
  for (const [label, feeds, code] of cases) {
    const fake = fakeGoogleIcal({ feeds });
    const source = createGoogleSource({ fetch: fake, addresses: { 1: HOME }, budgetMs: 800, requestMs: 400 });
    const out = await source.read({ calendars: [entry('Home', 1)], tz: TZ, now: AT });
    assert.deepEqual(out.warnings.filter((w) => SIX.includes(w.code)), [{ code, count: 1, names: ['Home'] }], `${label}: expected ${code} once, naming Home`);
    for (const c of ICLOUD_CODES) assert.deepEqual(out.warnings.filter((w) => w.code === c), [], `${label}: ${c} raised`);
  }
});

test('R125 a calendar name with markup is escaped on the page and makes no script or link', async () => {
  const baseline = await run({ block: { source: 'google', calendars: [{ name: 'Home' }] } });
  const v = await run({ block: { source: 'google', calendars: [{ name: HOSTILE }] } });
  const sentence = SENTENCE[SIX[0]](quoted([HOSTILE]));
  const items = footerItems(v.html);
  assert.ok(items.includes(sentence), `the footer lacks the sentence with the name escaped and shown as text; it holds ${JSON.stringify(items)}`);
  assert.equal(v.html.includes('<script>alert(1)</script>'), false, 'the name reached the page unescaped');
  assert.equal(count(v.html, /<script/gi), count(baseline.html, /<script/gi), 'a script element came from the name');
  assert.deepEqual(hrefs(v.html), hrefs(baseline.html), 'the name added or changed a link');
  assert.deepEqual(v.google.map((w) => w.names), [[HOSTILE]], 'the warning must carry the name as written, escaping being the page\'s business');
});

const FIVE = ['Home', 'Work', 'Gym', 'Club', 'Kids'];
for (const first of [1, 2]) {
  test(`R125 five calendars in five different conditions (${first}, 3, 4, 5, 6): five distinct warnings at one each, each naming its own calendar, no part of an address on the page`, async () => {
    const conds = [first, 3, 4, 5, 6];
    const vars = {}; const feeds = {};
    conds.forEach((c, i) => {
      const g = COND[c].give(i + 1);
      if (g.address) vars[`BOARD_GOOGLE_ICAL_${i + 1}`] = g.address;
      if (g.feed !== undefined) feeds[g.address] = g.feed;
    });
    const s = await session({ block: { source: 'google', calendars: FIVE.map((name) => ({ name })) }, vars, feeds });
    const v = await s.load();
    const want = conds.map((c, i) => ({ code: COND[c].code, count: 1, names: [FIVE[i]] }));
    const byCode = (a, b) => (a.code < b.code ? -1 : 1);
    assert.deepEqual([...v.google].sort(byCode), [...want].sort(byCode), `expected five distinct warnings at one each; the board raised ${JSON.stringify(v.warns)}`);
    assert.equal(new Set(v.google.map((w) => w.code)).size, 5);
    const items = footerItems(v.html);
    for (const w of want) assert.ok(items.includes(SENTENCE[w.code](quoted(w.names))), `the page lacks the sentence for ${w.code} naming ${w.names[0]}`);
    assert.equal(/SENTINEL-(CAL-ID|TOKEN)/i.test(v.html), false, 'a part of an address is on the page');
    for (const c of ICLOUD_CODES) assert.equal(v.warns.some((w) => w.code === c), false, c + ' raised');
  });
}

test('U the footer reader and the sentence builder agree with a hand-written page', () => {
  const html = '<ul class="warnings"><li>Google did not answer for these calendars, so they may be out of date: &quot;Home&quot;, &quot;Work&quot;.</li></ul>';
  assert.deepEqual(footerItems(html), [SENTENCE[SIX[3]](quoted(['Home', 'Work']))]);
  assert.deepEqual(footerItems('<p>none</p>'), []);
  assert.equal(quoted(['Home', 'Work']), '"Home", "Work"');
});

// ======================= R127 =======================
//
// R109 to R115 with source `google`: the stand-in holds the Google events of one calendar, `Home`, and the word is `Google`.

const GBLOCK = { source: 'google', calendars: [{ name: 'Home', kind: 'personal' }] };
const GHOME = { BOARD_GOOGLE_ICAL_1: HOME };

// `events`: plain descriptions of Google's events; `feed` overrides the feed outright.
function gsession({ block = GBLOCK, includeFile = true, events = [], feed, file, at, tz, vars = GHOME } = {}) {
  return session({ block, includeFile, vars, feeds: { [HOME]: feed === undefined ? icsFeed(events) : feed }, file: file === undefined ? null : file, at, tz });
}
const grun = async (o) => (await gsession(o)).load();
const goodFile = (extra = {}) => ({ date: TODAY, events: [fEv('Standup', 540, 570), fEv('Review notes', 840, 870, 'focus')], ...extra });
const DENTIST = () => gEv('Dentist', 630, 660);
const timed = (panel) => panel.events.map((e) => [e.start, e.title, e.source]);

// ---- R109 ----

test('R127 [R109] absent, false and "yes" show the Google event only, with no merged, fileDate or source and no data-source or data-filedate', async () => {
  const given = { events: [DENTIST()], file: { date: TODAY, events: [fEv('Standup', 540, 570)] } };
  const r = { absent: await grun({ ...given, includeFile: null }), off: await grun({ ...given, includeFile: false }), yes: await grun({ ...given, includeFile: 'yes' }) };
  for (const [name, x] of Object.entries(r)) {
    assert.deepEqual(x.panel.events.map((e) => e.title), ['Dentist'], name + ': the Google event only');
    assert.equal(JSON.stringify(x.panel).includes('Standup'), false, name + ': the file event must not be in the panel');
    for (const key of ['merged', 'fileDate', 'source']) assert.equal(Object.hasOwn(x.panel, key), false, `${name}: the panel has ${key}`);
    for (const e of x.panel.events) assert.equal(Object.hasOwn(e, 'source'), false, name + ': an event has a source');
    assert.equal(calendarSection(x.html).includes('Dentist'), true, name + ': the page shows the Google event');
    assert.equal(x.html.includes('Standup'), false, name + ': the page shows the file event');
    assert.equal(x.html.includes('data-source'), false, name + ': data-source in the page');
    assert.equal(x.html.includes('data-filedate'), false, name + ': data-filedate in the page');
  }
  assert.ok(r.absent.requests.length > 0, 'Google was never asked, so the comparison proves nothing');
  assert.deepEqual(r.off.board, r.absent.board, 'false and absent give different boards');
  assert.equal(r.off.html, r.absent.html);
  assert.deepEqual(r.off.requests, r.absent.requests);
  assert.deepEqual(r.off.warns, r.absent.warns);
  assert.equal(r.absent.warns.some((w) => w.code === 'setting-invalid'), false);
  assert.deepEqual(r.yes.warns, [...r.absent.warns, { code: 'setting-invalid', count: 1 }].sort((a, b) => (a.code < b.code ? -1 : 1)), '"yes" must add setting-invalid at 1 and nothing else');
  assert.deepEqual(r.yes.panel, r.absent.panel);
  assert.deepEqual(r.yes.requests, r.absent.requests);
});

test('R127 [R109] includeFile true on a block R104 drops as a whole: the file\'s panel as before, no merged, no request to Google', async () => {
  const given = { events: [DENTIST()], file: { date: TODAY, events: [fEv('Standup', 540, 570)] } };
  const withKey = await grun({ ...given, block: { source: 'yahoo', calendars: GBLOCK.calendars }, includeFile: true });
  const without = await grun({ ...given, block: { source: 'yahoo', calendars: GBLOCK.calendars }, includeFile: null });
  assert.deepEqual(withKey.panel.events.map((e) => e.title), ['Standup']);
  assert.equal(Object.hasOwn(withKey.panel, 'merged'), false);
  assert.equal(withKey.html.includes('data-source'), false);
  assert.deepEqual(withKey.board, without.board);
  assert.equal(withKey.requests.length, 0, 'a request went to Google although the block is dropped');
});

// ---- R110 ----

test('R127 [R110] includeFile true, a usable block and a present file: merged true, both sources shown', async () => {
  const v = await grun({ block: GBLOCK, events: [DENTIST()], file: { date: TODAY, events: [fEv('Standup', 540, 570)] } });
  assert.equal(v.panel.merged, true);
  assert.deepEqual(v.panel.events.map((e) => e.title), ['Standup', 'Dentist']);
  assert.equal(v.html.includes('data-source'), true);
});

test('R127 [R110] a present file of the wrong shape or with unreadable JSON still makes the panel merged', async () => {
  for (const file of [{ date: TODAY, events: 'not a list' }, '{broken']) {
    const v = await grun({ events: [DENTIST()], file });
    assert.equal(v.panel.merged, true, JSON.stringify(file));
    assert.deepEqual(v.panel.events.map((e) => e.title), ['Dentist']);
  }
});

test('R127 [R110] includeFile true with the file absent equals the panel built with includeFile false: no merged, no warning for the missing file', async () => {
  const on = await grun({ events: [DENTIST()], file: null, includeFile: true });
  const off = await grun({ events: [DENTIST()], file: null, includeFile: false });
  assert.equal(Object.hasOwn(on.panel, 'merged'), false);
  assert.deepEqual(on.panel, off.panel);
  assert.deepEqual(on.board, off.board);
  assert.equal(on.html, off.html);
  assert.equal(on.warns.some((w) => w.code === 'calendar-file-unreadable'), false);
});

test('R127 [R110] includeFile true and a block whose only entry has no usable name: the file\'s events only, no merged, no request to Google', async () => {
  const v = await grun({ block: { source: 'google', calendars: [{ name: ' ' }] }, events: [DENTIST()], file: { date: TODAY, events: [fEv('Standup', 540, 570)] } });
  assert.deepEqual(v.panel.events.map((e) => e.title), ['Standup']);
  assert.equal(Object.hasOwn(v.panel, 'merged'), false);
  assert.equal(v.html.includes('data-source'), false);
  assert.equal(v.requests.length, 0);
});

// ---- R111 ----

test('R127 [R111] timed events from Google and the file are one list in start, end, title order, a tie going to Google first: Y, Z, A, B (Google), B (file)', async () => {
  const v = await grun({
    events: [gEv('B', 540, 600), gEv('Z', 480, 510)],
    file: { date: TODAY, events: [fEv('A', 540, 600), fEv('B', 540, 600), fEv('Y', 420, 435)] },
  });
  const want = [['Y', 'File'], ['Z', 'Google'], ['A', 'File'], ['B', 'Google'], ['B', 'File']];
  assert.equal(v.panel.merged, true);
  assert.deepEqual(rows(v.panel), want);
  assert.deepEqual(pageEvents(v.html), want);
  assert.equal(head(v.html), 5);
});

test('R127 [R111] 20 timed events from each source: 30 shown, the first 30 in order, and the head says 30', async () => {
  const events = []; const fileEvents = [];
  for (let k = 0; k < 20; k++) {
    events.push(gEv('G' + two(k), 360 + 40 * k, 375 + 40 * k));
    fileEvents.push(fEv('F' + two(k), 380 + 40 * k, 395 + 40 * k));
  }
  const v = await grun({ events, file: { date: TODAY, events: fileEvents } });
  const want = [];
  for (let k = 0; k < 15; k++) { want.push(['G' + two(k), 'Google']); want.push(['F' + two(k), 'File']); }
  assert.equal(v.panel.events.length, 30);
  assert.deepEqual(rows(v.panel), want);
  assert.deepEqual(pageEvents(v.html), want);
  assert.equal(head(v.html), 30);
});

test('R127 [R111] all-day entries are one list by title, a tie to Google first: Day off, Trip (Google), Trip (file); 8 from each give 10', async () => {
  const v = await grun({ events: [gDay('Trip')], file: { date: TODAY, events: [], allDay: [{ title: 'Trip' }, { title: 'Day off' }] } });
  const want = [['Day off', 'File'], ['Trip', 'Google'], ['Trip', 'File']];
  assert.equal(v.panel.merged, true);
  assert.deepEqual(v.panel.allDay.map((a) => [a.title, a.source]), want);
  assert.deepEqual(pageAllDay(v.html), want);

  const days = []; const allDay = [];
  for (let k = 1; k <= 16; k++) {
    const title = 'Day ' + two(k);
    if (k % 2 === 1) days.push(gDay(title)); else allDay.push({ title });
  }
  const many = await grun({ events: days, file: { date: TODAY, events: [], allDay } });
  const wantMany = Array.from({ length: 10 }, (_, k) => ['Day ' + two(k + 1), (k + 1) % 2 === 1 ? 'Google' : 'File']);
  assert.equal(many.panel.allDay.length, 10);
  assert.deepEqual(many.panel.allDay.map((a) => [a.title, a.source]), wantMany);
});

// ---- R112 ----

const THIRTY = 'abcdefghijklmnopqrstuvwxyzabcd';
const LABELS = [
  ['absent', undefined, 'File'],
  ['Work diary', 'Work diary', 'Work diary'],
  ['whitespace and a line break around and inside', '  Work\n   diary  ', 'Work diary'],
  ['30 letters cut to the first 20', THIRTY, THIRTY.slice(0, 20)],
  ['the script payload cut to 20 characters', HOSTILE, Array.from(HOSTILE).slice(0, 20).join('')],
  ['empty text', '', 'File'],
  ['a number', 7, 'File'],
];
for (const [name, label, word] of LABELS) {
  test(`R127 [R112] file label ${name}: the file's events say ${JSON.stringify(word)} and the Google event says Google, in the panel and on the page`, async () => {
    const file = goodFile();
    if (label !== undefined) file.source = label;
    const v = await grun({ events: [DENTIST()], file });
    assert.deepEqual(timed(v.panel), [['09:00', 'Standup', word], ['10:30', 'Dentist', 'Google'], ['14:00', 'Review notes', word]]);
    const words = elementsWith(calendarSection(v.html), 'data-source');
    assert.deepEqual(words.map((w) => w.text), [word, 'Google', word], 'the data-source elements, in page order');
    for (const w of words) assert.equal(/[<>]/.test(w.inner), false, 'a data-source element holds markup: ' + w.inner);
  });
}

test('R127 [R112] a hostile label adds no script and no link, and an event\'s own source is ignored', async () => {
  const baseline = await grun({ events: [DENTIST()], file: goodFile({ source: 'Work diary' }) });
  const hostile = await grun({ events: [DENTIST()], file: goodFile({ source: HOSTILE }) });
  assert.equal(count(hostile.html, /<script/gi), count(baseline.html, /<script/gi));
  assert.deepEqual(hrefs(hostile.html), hrefs(baseline.html));
  const own = goodFile({ source: 'Work diary' });
  own.events[0].source = 'Elsewhere';
  const v = await grun({ events: [DENTIST()], file: own });
  assert.deepEqual(v.panel.events.map((e) => e.source), ['Work diary', 'Google', 'Work diary']);
  assert.equal(v.html.includes('Elsewhere'), false);
});

test('R127 [R112] the Google word is Google whatever the label of the file, even the label "Google"', async () => {
  for (const label of [undefined, 'Work diary', '', 7, 'Google']) {
    const file = goodFile();
    if (label !== undefined) file.source = label;
    const v = await grun({ events: [DENTIST()], file });
    assert.deepEqual(v.panel.events.filter((e) => e.title === 'Dentist').map((e) => e.source), ['Google'], 'label ' + JSON.stringify(label));
  }
});

test('R127 [R112] all-day entries: each title is followed by its own data-source inside the one data-allday element', async () => {
  const v = await grun({ events: [DENTIST(), gDay('Day off')], file: goodFile({ source: 'Work diary', allDay: [{ title: 'Trip to the coast' }] }) });
  assert.deepEqual(v.panel.allDay.map((a) => [a.title, a.source]), [['Day off', 'Google'], ['Trip to the coast', 'Work diary']]);
  assert.deepEqual(pageAllDay(v.html), [['Day off', 'Google'], ['Trip to the coast', 'Work diary']]);
  assert.equal(elementsWith(calendarSection(v.html), 'data-allday').length, 1);
});

// ---- R113 ----

const googleOnly = [['10:30', 'Dentist', 'Google']];
const fileOnly = [['09:00', 'Standup', 'File'], ['14:00', 'Review notes', 'File']];
const both = [['09:00', 'Standup', 'File'], ['10:30', 'Dentist', 'Google'], ['14:00', 'Review notes', 'File']];

test('R127 [R113] good Google and an unreadable file (not JSON, wrong shape): Google\'s events, stale, source stale, calendar-file-unreadable once and no Google warning', async () => {
  for (const file of ['{ not json', { date: TODAY, events: 'nope' }, { events: [] }]) {
    const v = await grun({ events: [DENTIST()], file });
    const why = JSON.stringify(file);
    assert.deepEqual(timed(v.panel), googleOnly, why);
    assert.equal(v.panel.stale, true, why);
    assert.equal(v.calSource.state, 'stale', why);
    assert.deepEqual(v.calWarnings, [{ code: 'calendar-file-unreadable', count: 1 }], why);
    assert.equal(footerItems(v.html).filter((i) => i === FILE_UNREADABLE_TEXT).length, 1, why);
    assert.equal(calendarSection(v.html).includes('class="panel-error"'), false, why);
  }
});

test('R127 [R113] failing Google (404) and a good file: the file\'s events, stale, source stale, the rejected warning once, no file warning', async () => {
  const v = await grun({ feed: { status: 404 }, file: goodFile() });
  assert.deepEqual(timed(v.panel), fileOnly);
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assert.deepEqual(v.calWarnings, [{ code: SIX[2], count: 1, names: ['Home'] }]);
  assert.equal(v.html.includes(FILE_UNREADABLE_TEXT), false);
  assert.equal(calendarSection(v.html).includes('class="panel-error"'), false);
});

test('R127 [R113] Google failing after a good read earlier today, and a good file: the kept Google events and the file\'s, stale, unreachable once', async () => {
  const s = await gsession({ events: [DENTIST()], file: goodFile() });
  const first = await s.load();
  assert.deepEqual(timed(first.panel), both);
  assert.equal(first.panel.stale, false);
  assert.deepEqual(first.calWarnings, []);
  s.fake.feeds[HOME] = { status: 503 };
  s.clock.t += 6 * MIN;
  const v = await s.load();
  assert.deepEqual(timed(v.panel), both);
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assert.deepEqual(v.calWarnings, [{ code: SIX[3], count: 1, names: ['Home'] }]);
  assert.equal(v.html.includes(FILE_UNREADABLE_TEXT), false);
});

test('R127 [R113] both sources failing: { error: "unreadable", from: "google" }, source error, calendar-file-unreadable once and one of the six, the Google sentence on the page', async () => {
  const v = await grun({ feed: { status: 404 }, file: '{ nope' });
  assert.deepEqual(v.panel, { error: 'unreadable', from: 'google' });
  assert.equal(v.calSource.state, 'error');
  assert.deepEqual(v.calWarnings, [{ code: 'calendar-file-unreadable', count: 1 }, { code: SIX[2], count: 1, names: ['Home'] }].sort((a, b) => (a.code < b.code ? -1 : 1)));
  assert.ok(calendarSection(v.html).includes(GOOGLE_SENTENCE), 'the card lacks the Google sentence');
  assert.equal(calendarSection(v.html).includes('iCloud'), false);
  assert.ok(footerItems(v.html).includes(FILE_UNREADABLE_TEXT));
  assert.ok(footerItems(v.html).includes(SENTENCE[SIX[2]](quoted(['Home']))));
});

test('R127 [R113] Google failing after a good read and an unreadable file: the kept Google events are shown, both warnings once', async () => {
  const s = await gsession({ events: [DENTIST()], file: goodFile() });
  await s.load();
  s.fake.feeds[HOME] = { status: 503 };
  s.files['state/calendar.json'] = '{ broken';
  s.clock.t += 6 * MIN;
  const v = await s.load();
  assert.deepEqual(timed(v.panel), googleOnly);
  assert.equal(v.panel.stale, true);
  assert.equal(v.calSource.state, 'stale');
  assert.deepEqual(v.calWarnings.map((w) => w.code).sort(), ['calendar-file-unreadable', SIX[3]].sort());
});

test('R127 [R113] a good Google and a file holding "events": [] is an empty source: not stale, source ok, no warning; a file with "stale": true is ignored', async () => {
  const empty = await grun({ events: [DENTIST()], file: { date: TODAY, events: [] } });
  assert.deepEqual(timed(empty.panel), googleOnly);
  assert.equal(empty.panel.merged, true);
  assert.equal(empty.panel.stale, false);
  assert.equal(empty.calSource.state, 'ok');
  assert.deepEqual(empty.calWarnings, []);
  const flagged = await grun({ events: [DENTIST()], file: goodFile({ stale: true }) });
  assert.deepEqual(timed(flagged.panel), both);
  assert.equal(flagged.panel.stale, false);
  assert.equal(flagged.calSource.state, 'ok');
  assert.deepEqual(flagged.calWarnings, []);
});

// ---- R114 ----

const NOTE = (word, date) => `${word} events are from ${date}.`;

test('R127 [R114] a file dated the day before: fileDate, fileSource, one note "File events are from 2026-10-11.", events shown, not stale; with a label the note says it', async () => {
  const v = await grun({ events: [DENTIST()], file: goodFile({ date: '2026-10-11' }) });
  assert.equal(v.panel.fileDate, '2026-10-11');
  assert.equal(v.panel.fileSource, 'File');
  assert.deepEqual(timed(v.panel), both);
  assert.equal(v.panel.stale, false);
  assert.equal(v.calSource.state, 'ok');
  assert.equal(count(v.html, /data-filedate/g), 1);
  assert.deepEqual(elementsWith(calendarSection(v.html), 'data-filedate').map((e) => e.text), [NOTE('File', '2026-10-11')]);
  const labelled = await grun({ events: [DENTIST()], file: goodFile({ date: '2026-10-11', source: 'Work diary' }) });
  assert.equal(labelled.panel.fileSource, 'Work diary');
  assert.deepEqual(elementsWith(calendarSection(labelled.html), 'data-filedate').map((e) => e.text), [NOTE('Work diary', '2026-10-11')]);
  assert.deepEqual(v.calWarnings, []);
});

test('R127 [R114] a file dated today or later has no fileDate and no note', async () => {
  for (const date of ['2026-10-12', '2026-10-13']) {
    const v = await grun({ events: [DENTIST()], file: goodFile({ date }) });
    assert.equal(Object.hasOwn(v.panel, 'fileDate'), false, date);
    assert.equal(v.html.includes('data-filedate'), false, date);
    assert.deepEqual(timed(v.panel), both, date);
  }
});

test('R127 [R114] at 2026-10-12T22:30:00Z in Europe/Brussels (already the 13th) a file dated 2026-10-12 gets the note; in America/New_York it does not', async () => {
  const late = await grun({ events: [gEv('Dentist', 630, 660, '20261013')], file: goodFile({ date: '2026-10-12' }), at: '2026-10-12T22:30:00.000Z', tz: 'Europe/Brussels' });
  assert.equal(late.panel.fileDate, '2026-10-12');
  assert.deepEqual(late.panel.events.map((e) => e.source), ['File', 'Google', 'File']);
  assert.deepEqual(elementsWith(calendarSection(late.html), 'data-filedate').map((e) => e.text), [NOTE('File', '2026-10-12')]);
  const ny = await grun({ events: [{ title: 'Dentist', start: gz(18 * 60), end: gz(19 * 60) }], file: goodFile({ date: '2026-10-12' }), at: '2026-10-12T22:30:00.000Z', tz: 'America/New_York' });
  assert.equal(Object.hasOwn(ny.panel, 'fileDate'), false);
  assert.equal(ny.html.includes('data-filedate'), false);
});

test('R127 [R114] a file from an earlier day that fails its shape has no note', async () => {
  const v = await grun({ events: [DENTIST()], file: { date: '2026-10-11', events: 'nope' } });
  assert.equal(Object.hasOwn(v.panel, 'fileDate'), false);
  assert.equal(v.html.includes('data-filedate'), false);
  assert.deepEqual(v.calWarnings, [{ code: 'calendar-file-unreadable', count: 1 }]);
});

// ---- R115 ----

test('R127 [R115] the same event in Google and in the file is listed twice, words Google and File, and the head counts both', async () => {
  const v = await grun({ events: [gEv('Review', 600, 660)], file: { date: TODAY, events: [fEv('Review', 600, 660)] } });
  const want = [['Review', 'Google'], ['Review', 'File']];
  assert.equal(v.panel.merged, true);
  assert.deepEqual(rows(v.panel), want);
  assert.deepEqual(pageEvents(v.html), want);
  assert.equal(head(v.html), 2);
});

test('R127 [R115] an event in both sources counts twice in the cap of 30, and the same all-day title is listed twice', async () => {
  const events = []; const fileEvents = [];
  for (let k = 0; k < 16; k++) {
    events.push(gEv('Shared ' + two(k), 360 + 40 * k, 375 + 40 * k));
    fileEvents.push(fEv('Shared ' + two(k), 360 + 40 * k, 375 + 40 * k));
  }
  const v = await grun({ events: [...events, gDay('Holiday')], file: { date: TODAY, events: fileEvents, allDay: [{ title: 'Holiday' }] } });
  const want = [];
  for (let k = 0; k < 15; k++) { want.push(['Shared ' + two(k), 'Google']); want.push(['Shared ' + two(k), 'File']); }
  assert.equal(v.panel.events.length, 30);
  assert.deepEqual(rows(v.panel), want);
  assert.equal(head(v.html), 30);
  assert.deepEqual(v.panel.allDay.map((a) => [a.title, a.source]), [['Holiday', 'Google'], ['Holiday', 'File']]);
});

// ---- the wiring of R127 itself ----

test('R127 the six Google warnings replace the three iCloud ones when the merged source fails; the iCloud ones are never raised', async () => {
  for (const [feed, code] of [[{ status: 404 }, SIX[2]], [{ status: 503 }, SIX[3]], [HTML_ANSWER, SIX[4]]]) {
    const v = await grun({ feed, file: goodFile() });
    assert.deepEqual(v.google.map((w) => w.code), [code]);
    for (const c of ICLOUD_CODES) assert.equal(v.warns.some((w) => w.code === c), false, c);
  }
});
