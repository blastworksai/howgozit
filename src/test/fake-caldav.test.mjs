import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeCalDav } from '../fixtures/fake-caldav.mjs';

const USER = 'sam@example.com';
const PASS = 'abcd-efgh-ijkl-mnop';
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

const ROOT = 'https://caldav.icloud.com/';
const PRINCIPAL = 'https://caldav.icloud.com/123456789/principal/';
const HOME = 'https://p99-caldav.icloud.com/123456789/calendars/';
const CAL1 = 'https://p99-caldav.icloud.com/123456789/calendars/cal-1/';
const CAL2 = 'https://p99-caldav.icloud.com/123456789/calendars/cal-2/';

const PRINCIPAL_BODY = '<?xml version="1.0" encoding="utf-8"?>\n<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>';
const HOME_BODY = '<?xml version="1.0" encoding="utf-8"?>\n<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>';
const CALENDARS_BODY = '<?xml version="1.0" encoding="utf-8"?>\n<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:displayname/><D:resourcetype/><C:supported-calendar-component-set/></D:prop></D:propfind>';
const REPORT_BODY = '<?xml version="1.0" encoding="utf-8"?>\n<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20261011T220000Z" end="20261012T220000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';

const ICS_A = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Standup & sync <daily>\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const ICS_B = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b1\r\nSUMMARY:Walk\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

function make(extras) {
  return fakeCalDav({
    user: USER,
    password: PASS,
    calendars: [
      { name: 'Home', ics: [ICS_A, ICS_B] },
      { name: 'Work', ics: [ICS_B], components: ['VEVENT', 'VTODO'] },
    ],
    extras,
  });
}

async function call(fake, method, url, { body, depth, auth = AUTH, extra = {} } = {}) {
  const headers = { ...extra };
  if (auth) headers.Authorization = auth;
  if (depth !== undefined) headers.Depth = depth;
  const res = await fake.fetch(url, { method, headers, body, redirect: 'manual' });
  return { res, text: await res.text() };
}

const principal = (f, o) => call(f, 'PROPFIND', ROOT, { body: PRINCIPAL_BODY, depth: '0', ...o });
const home = (f, o) => call(f, 'PROPFIND', PRINCIPAL, { body: HOME_BODY, depth: '0', ...o });
const listing = (f, o) => call(f, 'PROPFIND', HOME, { body: CALENDARS_BODY, depth: '1', ...o });
const report = (f, url = CAL1, o) => call(f, 'REPORT', url, { body: REPORT_BODY, depth: '1', ...o });

test('U principal step answers 207 with the principal address', async () => {
  const { res, text } = await principal(make());
  assert.equal(res.status, 207);
  assert.match(text, /<D:current-user-principal><D:href>\/123456789\/principal\/<\/D:href><\/D:current-user-principal>/);
});

test('U home step answers 207 with the home written with port 443', async () => {
  const { res, text } = await home(make());
  assert.equal(res.status, 207);
  assert.ok(text.includes('<D:href>https://p99-caldav.icloud.com:443/123456789/calendars/</D:href>'));
});

test('U home listing holds the home, each calendar, the inbox and Reminders', async () => {
  const { res, text } = await listing(make());
  assert.equal(res.status, 207);
  assert.equal((text.match(/<D:response>/g) || []).length, 5);
  assert.ok(text.includes('<D:href>/123456789/calendars/</D:href>'));
  assert.ok(text.includes('<D:href>/123456789/calendars/cal-1/</D:href>'));
  assert.ok(text.includes('<D:displayname>Home</D:displayname>'));
  assert.ok(text.includes('<D:displayname>Work</D:displayname>'));
  assert.ok(text.includes('<D:displayname>inbox</D:displayname>'));
  assert.ok(text.includes('<D:displayname>Reminders</D:displayname>'));
  assert.ok(text.includes('<C:comp name="VTODO"/>'));
});

test('U home listing marks calendars with a calendar type and the inbox without one', async () => {
  const { text } = await listing(make());
  assert.equal((text.match(/<C:calendar\/>/g) || []).length, 3);
  assert.equal((text.match(/<C:schedule-inbox\/>/g) || []).length, 1);
  assert.equal((text.match(/<C:comp name="VEVENT"\/>/g) || []).length, 2);
});

test('U report returns one response per text with an etag and escaped calendar-data', async () => {
  const { res, text } = await report(make());
  assert.equal(res.status, 207);
  assert.equal((text.match(/<D:response>/g) || []).length, 2);
  assert.equal((text.match(/<D:getetag>/g) || []).length, 2);
  assert.ok(text.includes('SUMMARY:Standup &amp; sync &lt;daily&gt;'));
  assert.ok(!text.includes('<daily>'));
  assert.ok(!text.includes('CDATA'));
});

test('U report on the second calendar returns that calendar only', async () => {
  const { text } = await report(make(), CAL2);
  assert.equal((text.match(/<D:response>/g) || []).length, 1);
  assert.ok(text.includes('SUMMARY:Walk'));
  assert.ok(!text.includes('Standup'));
});

test('U a call with no sign-in answers 401', async () => {
  const fake = make();
  const { res } = await principal(fake, { auth: null });
  assert.equal(res.status, 401);
});

test('U a call with a wrong sign-in answers 401, and a right one answers 207', async () => {
  const fake = make();
  const wrong = await principal(fake, { auth: `Basic ${Buffer.from(`${USER}:nope`).toString('base64')}` });
  assert.equal(wrong.res.status, 401);
  const right = await principal(fake);
  assert.equal(right.res.status, 207);
});

test('U principal PROPFIND without current-user-principal answers 400', async () => {
  const bad = await call(make(), 'PROPFIND', ROOT, { body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>', depth: '0' });
  assert.equal(bad.res.status, 400);
});

test('U home PROPFIND without calendar-home-set answers 400', async () => {
  const bad = await call(make(), 'PROPFIND', PRINCIPAL, { body: PRINCIPAL_BODY, depth: '0' });
  assert.equal(bad.res.status, 400);
});

test('U home listing without displayname answers 400', async () => {
  const bad = await call(make(), 'PROPFIND', HOME, { body: HOME_BODY, depth: '1' });
  assert.equal(bad.res.status, 400);
});

test('U home listing without Depth 1 answers 400, with Depth 0 too', async () => {
  const fake = make();
  assert.equal((await call(fake, 'PROPFIND', HOME, { body: CALENDARS_BODY })).res.status, 400);
  assert.equal((await call(fake, 'PROPFIND', HOME, { body: CALENDARS_BODY, depth: '0' })).res.status, 400);
  assert.equal((await listing(fake)).res.status, 207);
});

test('U a PROPFIND with no body answers 400', async () => {
  const bad = await call(make(), 'PROPFIND', ROOT, { depth: '0' });
  assert.equal(bad.res.status, 400);
});

test('U report missing each required part answers 400', async () => {
  const fake = make();
  const cases = {
    'calendar-query': REPORT_BODY.replaceAll('calendar-query', 'something'),
    filter: REPORT_BODY.replaceAll('filter', 'sieve'),
    'time-range': REPORT_BODY.replaceAll('time-range', 'span'),
    'calendar-data': REPORT_BODY.replaceAll('calendar-data', 'payload'),
    start: REPORT_BODY.replace(' start="20261011T220000Z"', ''),
    end: REPORT_BODY.replace(' end="20261012T220000Z"', ''),
  };
  for (const [label, body] of Object.entries(cases)) {
    const out = await call(fake, 'REPORT', CAL1, { body, depth: '1' });
    assert.equal(out.res.status, 400, label);
  }
  assert.equal((await report(fake)).res.status, 207);
});

test('U report with instants not in UTC basic format answers 400', async () => {
  const fake = make();
  const iso = REPORT_BODY.replace('20261011T220000Z', '2026-10-11T22:00:00Z');
  assert.equal((await call(fake, 'REPORT', CAL1, { body: iso, depth: '1' })).res.status, 400);
  const local = REPORT_BODY.replace('20261012T220000Z', '20261012T220000');
  assert.equal((await call(fake, 'REPORT', CAL1, { body: local, depth: '1' })).res.status, 400);
});

test('U report returns every resource whatever range is asked', async () => {
  const other = REPORT_BODY.replace('20261011T220000Z', '19990101T000000Z').replace('20261012T220000Z', '19990102T000000Z');
  const { res, text } = await call(make(), 'REPORT', CAL1, { body: other, depth: '1' });
  assert.equal(res.status, 207);
  assert.equal((text.match(/<D:response>/g) || []).length, 2);
});

test('U an unknown address answers 404', async () => {
  const fake = make();
  assert.equal((await call(fake, 'PROPFIND', 'https://caldav.icloud.com/other/', { body: PRINCIPAL_BODY, depth: '0' })).res.status, 404);
  assert.equal((await call(fake, 'REPORT', 'https://p99-caldav.icloud.com/123456789/calendars/cal-9/', { body: REPORT_BODY, depth: '1' })).res.status, 404);
  assert.equal((await call(fake, 'PROPFIND', 'https://elsewhere.example.com/', { body: PRINCIPAL_BODY, depth: '0' })).res.status, 404);
});

test('U PUT, DELETE, POST, PROPPATCH and MKCALENDAR answer 404 and are recorded', async () => {
  const fake = make();
  for (const method of ['PUT', 'DELETE', 'POST', 'PROPPATCH', 'MKCALENDAR']) {
    const out = await call(fake, method, CAL1, { body: 'x' });
    assert.equal(out.res.status, 404, method);
  }
  assert.deepEqual(fake.calls.map((c) => c.method), ['PUT', 'DELETE', 'POST', 'PROPPATCH', 'MKCALENDAR']);
});

test('U a refused call is still recorded with lower-cased header names', async () => {
  const fake = make();
  await principal(fake, { auth: null, extra: { 'X-Probe': 'one' } });
  await call(fake, 'PROPFIND', ROOT, { body: '<nothing/>', depth: '0' });
  await call(fake, 'PROPFIND', 'https://caldav.icloud.com/nowhere', { body: PRINCIPAL_BODY });
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0].headers['x-probe'], 'one');
  assert.equal(fake.calls[0].headers.authorization, undefined);
  assert.equal(fake.calls[1].headers.authorization, AUTH);
  assert.equal(fake.calls[1].body, '<nothing/>');
  assert.equal(fake.calls[1].headers.depth, '0');
  assert.deepEqual(fake.calls.map((c) => c.method), ['PROPFIND', 'PROPFIND', 'PROPFIND']);
  assert.equal(fake.calls[2].url, 'https://caldav.icloud.com/nowhere');
});

test('U fetch accepts a URL object and a Headers instance', async () => {
  const fake = make();
  const headers = new Headers({ Authorization: AUTH, Depth: '0' });
  const res = await fake.fetch(new URL(ROOT), { method: 'PROPFIND', headers, body: PRINCIPAL_BODY });
  assert.equal(res.status, 207);
  assert.equal(fake.calls[0].url, ROOT);
  assert.equal(fake.calls[0].headers.depth, '0');
});

test('U the default port is ignored in addresses', async () => {
  const fake = make();
  const withPort = await call(fake, 'PROPFIND', 'https://p99-caldav.icloud.com:443/123456789/calendars/', { body: CALENDARS_BODY, depth: '1' });
  const without = await listing(fake);
  assert.equal(withPort.res.status, 207);
  assert.equal(withPort.text, without.text);
  const reportPort = await report(fake, 'https://p99-caldav.icloud.com:443/123456789/calendars/cal-1/');
  assert.equal(reportPort.res.status, 207);
});

test('U a non-default port is another place and answers 404', async () => {
  const out = await call(make(), 'PROPFIND', 'https://p99-caldav.icloud.com:8443/123456789/calendars/', { body: CALENDARS_BODY, depth: '1' });
  assert.equal(out.res.status, 404);
});

test('U state.fail with a number answers that status with a short body, for each step', async () => {
  const fake = make();
  const steps = {
    principal: () => principal(fake),
    home: () => home(fake),
    calendars: () => listing(fake),
    report: () => report(fake),
  };
  for (const [step, run] of Object.entries(steps)) {
    fake.state.fail = { step, status: 503 };
    const out = await run();
    assert.equal(out.res.status, 503, step);
    assert.ok(out.text.length > 0 && out.text.length < 40, step);
    assert.ok(!out.text.includes('multistatus'));
  }
});

test('U state.fail touches only its own step and stays until cleared', async () => {
  const fake = make();
  fake.state.fail = { step: 'home', status: 500 };
  assert.equal((await principal(fake)).res.status, 207);
  assert.equal((await home(fake)).res.status, 500);
  assert.equal((await home(fake)).res.status, 500);
  fake.state.fail = null;
  assert.equal((await home(fake)).res.status, 207);
});

test('U state.fail 401 and 403 answer those statuses', async () => {
  const fake = make();
  fake.state.fail = { step: 'principal', status: 403 };
  assert.equal((await principal(fake)).res.status, 403);
  fake.state.fail = { step: 'principal', status: 401 };
  assert.equal((await principal(fake)).res.status, 401);
});

test('U state.fail garbage answers 207 with text that is not a multistatus, for each step', async () => {
  const fake = make();
  for (const [step, run] of [['principal', () => principal(fake)], ['home', () => home(fake)], ['calendars', () => listing(fake)], ['report', () => report(fake)]]) {
    fake.state.fail = { step, status: 'garbage' };
    const out = await run();
    assert.equal(out.res.status, 207, step);
    assert.ok(!/multistatus/.test(out.text), step);
  }
});

test('U state.fail network rejects with a TypeError, for each step', async () => {
  const fake = make();
  const runs = {
    principal: () => principal(fake),
    home: () => home(fake),
    calendars: () => listing(fake),
    report: () => report(fake),
  };
  for (const [step, run] of Object.entries(runs)) {
    fake.state.fail = { step, status: 'network' };
    await assert.rejects(run(), (err) => err instanceof TypeError, step);
  }
  fake.state.fail = null;
  assert.equal((await principal(fake)).res.status, 207);
});

test('U state.fail hang settles only when the signal aborts', async () => {
  const fake = make();
  fake.state.fail = { step: 'principal', status: 'hang' };
  let settled = false;
  // AbortSignal.timeout is unref'd: hold the loop open until it fires, then release.
  const keep = setInterval(() => {}, 1000);
  const pending = fake
    .fetch(ROOT, { method: 'PROPFIND', headers: { Authorization: AUTH, Depth: '0' }, body: PRINCIPAL_BODY, signal: AbortSignal.timeout(30) })
    .then(() => { settled = 'resolved'; }, (err) => { settled = err; });
  await Promise.resolve();
  assert.equal(settled, false);
  try { await pending; } finally { clearInterval(keep); }
  assert.ok(settled instanceof Error || settled?.name);
  assert.ok(['TimeoutError', 'AbortError'].includes(settled.name));
  assert.equal(fake.calls.length, 1);
});

test('U state.fail hang with a signal already aborted rejects at once with its reason', async () => {
  const fake = make();
  fake.state.fail = { step: 'report', status: 'hang' };
  const ctl = new AbortController();
  ctl.abort(new Error('stop now'));
  await assert.rejects(
    fake.fetch(CAL1, { method: 'REPORT', headers: { Authorization: AUTH, Depth: '1' }, body: REPORT_BODY, signal: ctl.signal }),
    /stop now/,
  );
});

test('U state.fail hang does not apply to a call refused for its sign-in', async () => {
  const fake = make();
  fake.state.fail = { step: 'principal', status: 'hang' };
  const out = await principal(fake, { auth: null });
  assert.equal(out.res.status, 401);
});

test('U state.home replaces the home hand-out and stays in force', async () => {
  const fake = make();
  fake.state.home = 'https://evil.example.net/123456789/calendars/';
  const first = await home(fake);
  assert.ok(first.text.includes('<D:href>https://evil.example.net/123456789/calendars/</D:href>'));
  assert.ok(!first.text.includes('p99-caldav'));
  const second = await home(fake);
  assert.equal(second.text, first.text);
  fake.state.home = null;
  assert.ok((await home(fake)).text.includes('https://p99-caldav.icloud.com:443/123456789/calendars/'));
});

test('U state.redirect answers 302 with the location, only for its step', async () => {
  const fake = make();
  fake.state.redirect = { step: 'calendars', location: 'https://elsewhere.example.com/x' };
  const out = await listing(fake);
  assert.equal(out.res.status, 302);
  assert.equal(out.res.headers.get('location'), 'https://elsewhere.example.com/x');
  assert.equal((await home(fake)).res.status, 207);
  assert.equal((await listing(fake)).res.status, 302);
  fake.state.redirect = null;
  assert.equal((await listing(fake)).res.status, 207);
});

test('U a calendar added through state.calendars appears in the listing and the report', async () => {
  const fake = make();
  fake.state.calendars.push({ name: 'Gym', ics: [ICS_B] });
  const { text } = await listing(fake);
  assert.ok(text.includes('<D:href>/123456789/calendars/cal-3/</D:href>'));
  assert.ok(text.includes('<D:displayname>Gym</D:displayname>'));
  const rep = await report(fake, 'https://p99-caldav.icloud.com/123456789/calendars/cal-3/');
  assert.equal(rep.res.status, 207);
  assert.ok(rep.text.includes('SUMMARY:Walk'));
});

test('U a renamed calendar keeps its address', async () => {
  const fake = make();
  const before = await listing(fake);
  assert.ok(before.text.includes('<D:displayname>Home</D:displayname>'));
  fake.state.calendars[0].name = 'Family';
  const after = await listing(fake);
  assert.ok(after.text.includes('<D:displayname>Family</D:displayname>'));
  assert.ok(!after.text.includes('<D:displayname>Home</D:displayname>'));
  assert.ok(after.text.includes('<D:href>/123456789/calendars/cal-1/</D:href>'));
  assert.equal((await report(fake, CAL1)).res.status, 207);
});

test('U calendar names with markup characters are escaped in the listing', async () => {
  const fake = make();
  fake.state.calendars[1].name = 'Work & <play>';
  const { text } = await listing(fake);
  assert.ok(text.includes('<D:displayname>Work &amp; &lt;play&gt;</D:displayname>'));
});

test('U calendars default to VEVENT when no components are given', async () => {
  const fake = fakeCalDav({ user: USER, password: PASS, calendars: [{ name: 'Solo', ics: [] }] });
  const { text } = await listing(fake);
  assert.ok(text.includes('<C:comp name="VEVENT"/>'));
  const rep = await report(fake);
  assert.equal(rep.res.status, 207);
  assert.equal((rep.text.match(/<D:response>/g) || []).length, 0);
});

test('U extras.prefix changes the DAV prefix in every step', async () => {
  const fake = make({ prefix: 'd' });
  for (const out of [await principal(fake), await home(fake), await listing(fake), await report(fake)]) {
    assert.equal(out.res.status, 207);
    assert.ok(out.text.includes('<d:multistatus xmlns:d="DAV:"'));
    assert.ok(out.text.includes('<d:href>'));
    assert.ok(!out.text.includes('<D:'));
  }
});

test('U without extras the prefix is D', async () => {
  const { text } = await principal(make());
  assert.ok(text.includes('<D:multistatus xmlns:D="DAV:"'));
  assert.ok(!text.includes('<d:'));
});

test('U extras.cdata wraps calendar-data in CDATA unescaped', async () => {
  const { text } = await report(make({ cdata: true }));
  assert.ok(text.includes('<C:calendar-data><![CDATA[BEGIN:VCALENDAR'));
  assert.ok(text.includes('SUMMARY:Standup & sync <daily>'));
  assert.ok(!text.includes('&amp;'));
});

test('U extras.cdata splits a closing CDATA marker inside the text', async () => {
  const fake = fakeCalDav({
    user: USER,
    password: PASS,
    calendars: [{ name: 'Odd', ics: ['SUMMARY:a]]>b'] }],
    extras: { cdata: true },
  });
  const { text } = await report(fake);
  assert.ok(text.includes('<![CDATA[SUMMARY:a]]]]><![CDATA[>b]]>'));
});

test('U without extras.cdata the closing marker is escaped as text', async () => {
  const fake = fakeCalDav({
    user: USER,
    password: PASS,
    calendars: [{ name: 'Odd', ics: ['SUMMARY:a]]>b'] }],
  });
  const { text } = await report(fake);
  assert.ok(text.includes('SUMMARY:a]]&gt;b'));
  assert.ok(!text.includes('CDATA'));
});

test('U the three discovery steps and the report run in order against the fake', async () => {
  const fake = make();
  assert.equal((await principal(fake)).res.status, 207);
  assert.equal((await home(fake)).res.status, 207);
  assert.equal((await listing(fake)).res.status, 207);
  assert.equal((await report(fake)).res.status, 207);
  assert.deepEqual(fake.calls.map((c) => c.method), ['PROPFIND', 'PROPFIND', 'PROPFIND', 'REPORT']);
  assert.ok(fake.calls.every((c) => c.headers.authorization === AUTH));
});
