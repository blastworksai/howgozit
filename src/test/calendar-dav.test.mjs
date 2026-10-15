import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT,
  principalBody,
  homeBody,
  calendarsBody,
  reportBody,
  parseMultistatus,
  allowedUrl,
  resolveHref,
} from '../board/calendar/dav.mjs';

const DECL = '<?xml version="1.0" encoding="utf-8"?>';
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';

/** The props of a response that found nothing (every key present). */
const EMPTY = {
  displayName: null,
  isCalendar: false,
  components: null,
  principal: null,
  home: null,
  calendarData: null,
};
const props = (over) => ({ ...EMPTY, ...over });

// ---------------------------------------------------------------- constants and bodies

test('U ROOT is the iCloud CalDAV entry address', () => {
  assert.equal(ROOT, 'https://caldav.icloud.com/');
});

test('U principalBody is the declaration line then one line, exactly', () => {
  const body = principalBody();
  assert.ok(body.startsWith(DECL));
  const rest = body.slice(DECL.length).replace(/^\r?\n/, '');
  assert.equal(
    rest,
    '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
  );
});

test('U homeBody is the declaration line then one line, exactly', () => {
  const body = homeBody();
  assert.ok(body.startsWith(DECL));
  const rest = body.slice(DECL.length).replace(/^\r?\n/, '');
  assert.equal(
    rest,
    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>',
  );
});

test('U calendarsBody is the declaration line then one line, exactly', () => {
  const body = calendarsBody();
  assert.ok(body.startsWith(DECL));
  const rest = body.slice(DECL.length).replace(/^\r?\n/, '');
  assert.equal(
    rest,
    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:displayname/><D:resourcetype/><C:supported-calendar-component-set/></D:prop></D:propfind>',
  );
});

test('U the three PROPFIND bodies use one line ending after the declaration', () => {
  for (const body of [principalBody(), homeBody(), calendarsBody()]) {
    assert.match(body, /^<\?xml version="1\.0" encoding="utf-8"\?>\r?\n<D:propfind /);
    assert.equal(body.split('\n').length, 2);
  }
});

test('U reportBody equals the spec text for a one-day window', () => {
  const body = reportBody({
    start: '2026-10-11T22:00:00.000Z',
    end: '2026-10-12T22:00:00.000Z',
  });
  assert.ok(body.startsWith(DECL));
  const rest = body.slice(DECL.length).replace(/^\r?\n/, '');
  assert.equal(
    rest,
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="20261011T220000Z" end="20261012T220000Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>',
  );
});

test('U reportBody writes the instants in UTC basic format', () => {
  const body = reportBody({
    start: '2027-01-02T03:04:05.000Z',
    end: '2027-01-03T03:04:05.000Z',
  });
  assert.ok(body.includes('<C:time-range start="20270102T030405Z" end="20270103T030405Z"/>'));
});

test('U reportBody never asks the server to expand repeats', () => {
  const body = reportBody({
    start: '2026-10-11T22:00:00.000Z',
    end: '2026-10-12T22:00:00.000Z',
  });
  assert.equal(body.includes('expand'), false);
  assert.ok(body.includes('time-range'));
});

test('U reportBody gives null for an instant it cannot read', () => {
  const good = '2026-10-12T22:00:00.000Z';
  assert.equal(reportBody({ start: 'not a date', end: good }), null);
  assert.equal(reportBody({ start: good, end: 'tomorrow' }), null);
  assert.equal(reportBody({ start: '', end: '' }), null);
  assert.equal(reportBody({}), null);
  assert.equal(reportBody({ start: 12345, end: good }), null);
  assert.equal(typeof reportBody({ start: good, end: '2026-10-13T22:00:00.000Z' }), 'string');
});

// ---------------------------------------------------------------- samples

const OK = 'HTTP/1.1 200 OK';
const NOT_FOUND = 'HTTP/1.1 404 Not Found';

const PRINCIPAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/1234567890/principal/</D:href></D:current-user-principal></D:prop><D:status>${OK}</D:status></D:propstat></D:response></D:multistatus>`;

const HOME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="${CALDAV_NS}"><D:response><D:href>/1234567890/principal/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>https://p99-caldav.icloud.com:443/1234567890/calendars/</D:href></C:calendar-home-set></D:prop><D:status>${OK}</D:status></D:propstat></D:response></D:multistatus>`;

/** The calendar-list answer, with the three prefix styles produced from one shape. */
function listPrefixed(d, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<${d}:multistatus xmlns:${d}="DAV:" xmlns:${c}="${CALDAV_NS}">
<${d}:response><${d}:href>/1234567890/calendars/</${d}:href><${d}:propstat><${d}:prop><${d}:resourcetype><${d}:collection/></${d}:resourcetype></${d}:prop><${d}:status>${OK}</${d}:status></${d}:propstat></${d}:response>
<${d}:response><${d}:href>/1234567890/calendars/home/</${d}:href><${d}:propstat><${d}:prop><${d}:displayname>Home</${d}:displayname><${d}:resourcetype><${d}:collection/><${c}:calendar/></${d}:resourcetype><${c}:supported-calendar-component-set><${c}:comp name="VEVENT"/></${c}:supported-calendar-component-set></${d}:prop><${d}:status>${OK}</${d}:status></${d}:propstat></${d}:response>
<${d}:response><${d}:href>/1234567890/calendars/work/</${d}:href><${d}:propstat><${d}:prop><${d}:displayname>Work</${d}:displayname><${d}:resourcetype><${d}:collection/><${c}:calendar/></${d}:resourcetype><${c}:supported-calendar-component-set><${c}:comp name="VEVENT"/><${c}:comp name="VJOURNAL"/></${c}:supported-calendar-component-set></${d}:prop><${d}:status>${OK}</${d}:status></${d}:propstat></${d}:response>
<${d}:response><${d}:href>/1234567890/inbox/</${d}:href><${d}:propstat><${d}:prop><${d}:displayname>Inbox</${d}:displayname><${d}:resourcetype><${d}:collection/><${c}:schedule-inbox/></${d}:resourcetype></${d}:prop><${d}:status>${OK}</${d}:status></${d}:propstat></${d}:response>
<${d}:response><${d}:href>/1234567890/reminders/</${d}:href><${d}:propstat><${d}:prop><${d}:displayname>Reminders</${d}:displayname><${d}:resourcetype><${d}:collection/><${c}:calendar/></${d}:resourcetype><${c}:supported-calendar-component-set><${c}:comp name="VTODO"/></${c}:supported-calendar-component-set></${d}:prop><${d}:status>${OK}</${d}:status></${d}:propstat></${d}:response>
<${d}:response><${d}:href>/1234567890/misc/</${d}:href><${d}:propstat><${d}:prop><${d}:displayname>Misc</${d}:displayname><${d}:resourcetype><${d}:collection/><${c}:calendar/></${d}:resourcetype></${d}:prop><${d}:status>${OK}</${d}:status></${d}:propstat></${d}:response>
</${d}:multistatus>`;
}

/** Default namespace on the root for DAV:, a prefixed CalDAV namespace. */
const LIST_DEFAULT_NS = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:cal="${CALDAV_NS}">
<response><href>/1234567890/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>${OK}</status></propstat></response>
<response><href>/1234567890/calendars/home/</href><propstat><prop><displayname>Home</displayname><resourcetype><collection/><cal:calendar/></resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set></prop><status>${OK}</status></propstat></response>
<response><href>/1234567890/calendars/work/</href><propstat><prop><displayname>Work</displayname><resourcetype><collection/><cal:calendar/></resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VJOURNAL"/></cal:supported-calendar-component-set></prop><status>${OK}</status></propstat></response>
<response><href>/1234567890/inbox/</href><propstat><prop><displayname>Inbox</displayname><resourcetype><collection/><cal:schedule-inbox/></resourcetype></prop><status>${OK}</status></propstat></response>
<response><href>/1234567890/reminders/</href><propstat><prop><displayname>Reminders</displayname><resourcetype><collection/><cal:calendar/></resourcetype><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set></prop><status>${OK}</status></propstat></response>
<response><href>/1234567890/misc/</href><propstat><prop><displayname>Misc</displayname><resourcetype><collection/><cal:calendar/></resourcetype></prop><status>${OK}</status></propstat></response>
</multistatus>`;

const LIST_EXPECTED = [
  { href: '/1234567890/calendars/', props: props({}) },
  {
    href: '/1234567890/calendars/home/',
    props: props({ displayName: 'Home', isCalendar: true, components: ['VEVENT'] }),
  },
  {
    href: '/1234567890/calendars/work/',
    props: props({ displayName: 'Work', isCalendar: true, components: ['VEVENT', 'VJOURNAL'] }),
  },
  { href: '/1234567890/inbox/', props: props({ displayName: 'Inbox' }) },
  {
    href: '/1234567890/reminders/',
    props: props({ displayName: 'Reminders', isCalendar: true, components: ['VTODO'] }),
  },
  { href: '/1234567890/misc/', props: props({ displayName: 'Misc', isCalendar: true }) },
];

const ICS_ONE = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:one@example.test\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const ICS_TWO = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:two@example.test\r\nSUMMARY:Lunch with Sam\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const asEntities = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;');

const REPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="${CALDAV_NS}">
<D:response><D:href>/1234567890/calendars/home/one.ics</D:href><D:propstat><D:prop><D:getetag>"etag-1"</D:getetag><C:calendar-data>${asEntities(ICS_ONE)}</C:calendar-data></D:prop><D:status>${OK}</D:status></D:propstat></D:response>
<D:response><D:href>/1234567890/calendars/home/two.ics</D:href><D:propstat><D:prop><D:getetag>"etag-2"</D:getetag><C:calendar-data><![CDATA[${ICS_TWO}]]></C:calendar-data></D:prop><D:status>${OK}</D:status></D:propstat></D:response>
</D:multistatus>`;

// ---------------------------------------------------------------- parseMultistatus: shapes

test('U parseMultistatus reads a principal answer', () => {
  assert.deepEqual(parseMultistatus(PRINCIPAL_XML), [
    { href: '/', props: props({ principal: '/1234567890/principal/' }) },
  ]);
});

test('U parseMultistatus reads a home answer', () => {
  assert.deepEqual(parseMultistatus(HOME_XML), [
    {
      href: '/1234567890/principal/',
      props: props({ home: 'https://p99-caldav.icloud.com:443/1234567890/calendars/' }),
    },
  ]);
});

test('U parseMultistatus reads a calendar-list answer, every field, in document order', () => {
  assert.deepEqual(parseMultistatus(listPrefixed('D', 'C')), LIST_EXPECTED);
});

test('U parseMultistatus reads a report answer with two resources', () => {
  assert.deepEqual(parseMultistatus(REPORT_XML), [
    { href: '/1234567890/calendars/home/one.ics', props: props({ calendarData: ICS_ONE }) },
    { href: '/1234567890/calendars/home/two.ics', props: props({ calendarData: ICS_TWO }) },
  ]);
});

test('U a calendar whose only component is VTODO is a calendar with components VTODO', () => {
  const out = parseMultistatus(listPrefixed('D', 'C'));
  const reminders = out.find((r) => r.href === '/1234567890/reminders/');
  assert.equal(reminders.props.isCalendar, true);
  assert.deepEqual(reminders.props.components, ['VTODO']);
});

test('U an inbox collection is not a calendar and a calendar with no component set has null components', () => {
  const out = parseMultistatus(listPrefixed('D', 'C'));
  const inbox = out.find((r) => r.href === '/1234567890/inbox/');
  const misc = out.find((r) => r.href === '/1234567890/misc/');
  assert.equal(inbox.props.isCalendar, false);
  assert.equal(misc.props.isCalendar, true);
  assert.equal(misc.props.components, null);
});

// ---------------------------------------------------------------- prefixes

test('U the calendar list reads the same with D: and C: prefixes', () => {
  assert.deepEqual(parseMultistatus(listPrefixed('D', 'C')), LIST_EXPECTED);
});

test('U the calendar list reads the same with lower-case d: and cal: prefixes', () => {
  assert.deepEqual(parseMultistatus(listPrefixed('d', 'cal')), LIST_EXPECTED);
});

test('U the calendar list reads the same with a default namespace and a prefixed CalDAV namespace', () => {
  assert.deepEqual(parseMultistatus(LIST_DEFAULT_NS), LIST_EXPECTED);
});

// ---------------------------------------------------------------- status

const wrap = (inner) =>
  `<D:multistatus xmlns:D="DAV:" xmlns:C="${CALDAV_NS}">${inner}</D:multistatus>`;

test('U a 404 propstat listing displayname gives displayName null', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href><D:propstat><D:prop><D:displayname>Ghost</D:displayname></D:prop><D:status>${NOT_FOUND}</D:status></D:propstat></D:response>`,
  );
  assert.deepEqual(parseMultistatus(xml), [{ href: '/a/', props: props({}) }]);
});

test('U twin: the same displayname in a 200 propstat is read', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href><D:propstat><D:prop><D:displayname>Ghost</D:displayname></D:prop><D:status>${OK}</D:status></D:propstat></D:response>`,
  );
  assert.deepEqual(parseMultistatus(xml), [{ href: '/a/', props: props({ displayName: 'Ghost' }) }]);
});

test('U a response with a 200 and a 404 propstat keeps the 200 values only', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href>` +
      `<D:propstat><D:prop><D:displayname>Kept</D:displayname></D:prop><D:status>${OK}</D:status></D:propstat>` +
      `<D:propstat><D:prop><C:calendar-home-set><D:href>/lost/</D:href></C:calendar-home-set></D:prop><D:status>${NOT_FOUND}</D:status></D:propstat>` +
      `</D:response>`,
  );
  assert.deepEqual(parseMultistatus(xml), [{ href: '/a/', props: props({ displayName: 'Kept' }) }]);
});

test('U the 200 propstat counts when it comes after the 404 one', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href>` +
      `<D:propstat><D:prop><C:calendar-home-set><D:href>/lost/</D:href></C:calendar-home-set></D:prop><D:status>${NOT_FOUND}</D:status></D:propstat>` +
      `<D:propstat><D:prop><D:displayname>Kept</D:displayname></D:prop><D:status>${OK}</D:status></D:propstat>` +
      `</D:response>`,
  );
  assert.deepEqual(parseMultistatus(xml), [{ href: '/a/', props: props({ displayName: 'Kept' }) }]);
});

// ---------------------------------------------------------------- decoding

const ICS_TEXT = 'BEGIN:VCALENDAR\r\nSUMMARY:A & B <x>\r\nNOTE:A\r\nEND:VCALENDAR';
const dataResponse = (inner) =>
  wrap(
    `<D:response><D:href>/r.ics</D:href><D:propstat><D:prop><C:calendar-data>${inner}</C:calendar-data></D:prop><D:status>${OK}</D:status></D:propstat></D:response>`,
  );

test('U calendar-data written with entities is decoded', () => {
  const xml = dataResponse(
    'BEGIN:VCALENDAR&#13;&#10;SUMMARY:A &amp; B &lt;x&gt;&#13;&#10;NOTE:&#x41;&#13;&#10;END:VCALENDAR',
  );
  assert.equal(parseMultistatus(xml)[0].props.calendarData, ICS_TEXT);
});

test('U calendar-data written in a CDATA section is taken as written', () => {
  const xml = dataResponse(`<![CDATA[${ICS_TEXT}]]>`);
  assert.equal(parseMultistatus(xml)[0].props.calendarData, ICS_TEXT);
});

test('U entities and CDATA give the same calendar-data text', () => {
  const a = parseMultistatus(
    dataResponse('BEGIN:VCALENDAR&#13;&#10;SUMMARY:A &amp; B &lt;x&gt;&#13;&#10;NOTE:&#x41;&#13;&#10;END:VCALENDAR'),
  );
  const b = parseMultistatus(dataResponse(`<![CDATA[${ICS_TEXT}]]>`));
  assert.deepEqual(a, b);
});

test('U a CDATA section is not entity-decoded', () => {
  const xml = dataResponse('<![CDATA[a &amp; b]]>');
  assert.equal(parseMultistatus(xml)[0].props.calendarData, 'a &amp; b');
});

test('U a display name with named entities decodes', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href><D:propstat><D:prop><D:displayname>Tom &amp;amp; Sam&amp;apos;s</D:displayname></D:prop><D:status>${OK}</D:status></D:propstat></D:response>`,
  );
  // one level of decoding only: &amp;amp; -> &amp;
  assert.equal(parseMultistatus(xml)[0].props.displayName, 'Tom &amp; Sam&apos;s');
});

test('U a display name Tom &amp; Sam&apos;s decodes to Tom & Sam\'s', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href><D:propstat><D:prop><D:displayname>Tom &amp; Sam&apos;s</D:displayname></D:prop><D:status>${OK}</D:status></D:propstat></D:response>`,
  );
  assert.equal(parseMultistatus(xml)[0].props.displayName, "Tom & Sam's");
});

test('U &quot; and &gt; decode', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href><D:propstat><D:prop><D:displayname>&quot;Q&quot; &gt; R</D:displayname></D:prop><D:status>${OK}</D:status></D:propstat></D:response>`,
  );
  assert.equal(parseMultistatus(xml)[0].props.displayName, '"Q" > R');
});

test('U an invalid numeric reference is dropped and nothing throws', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href><D:propstat><D:prop><D:displayname>A&#x110000;B</D:displayname></D:prop><D:status>${OK}</D:status></D:propstat></D:response>`,
  );
  let out;
  assert.doesNotThrow(() => {
    out = parseMultistatus(xml);
  });
  assert.equal(out[0].props.displayName, 'AB');
});

test('U twin: a valid numeric reference in the same place is kept', () => {
  const xml = wrap(
    `<D:response><D:href>/a/</D:href><D:propstat><D:prop><D:displayname>A&#x42;C</D:displayname></D:prop><D:status>${OK}</D:status></D:propstat></D:response>`,
  );
  assert.equal(parseMultistatus(xml)[0].props.displayName, 'ABC');
});

// ---------------------------------------------------------------- syntax variety

test('U a declaration, a comment before the root, self-closing elements and single-quoted attributes read', () => {
  const xml =
    `<?xml version='1.0' encoding='utf-8'?>\n<!-- <D:displayname>decoy</D:displayname> -->\n` +
    `<D:multistatus xmlns:D='DAV:' xmlns:C='${CALDAV_NS}'>` +
    `<D:response><D:href>/a/</D:href><D:propstat><D:prop><D:displayname>Sam</D:displayname>` +
    `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
    `<C:supported-calendar-component-set><C:comp name='VEVENT'/></C:supported-calendar-component-set>` +
    `</D:prop><D:status>${OK}</D:status></D:propstat></D:response></D:multistatus>`;
  assert.deepEqual(parseMultistatus(xml), [
    { href: '/a/', props: props({ displayName: 'Sam', isCalendar: true, components: ['VEVENT'] }) },
  ]);
});

// ---------------------------------------------------------------- null and empty

test('U parseMultistatus gives null for a number, undefined and an empty string', () => {
  assert.equal(parseMultistatus(42), null);
  assert.equal(parseMultistatus(undefined), null);
  assert.equal(parseMultistatus(''), null);
});

test('U parseMultistatus gives null for an HTML page', () => {
  assert.equal(
    parseMultistatus('<!DOCTYPE html><html><head><title>Sign in</title></head><body><p>Hello</p></body></html>'),
    null,
  );
});

test('U parseMultistatus gives null for a document whose root is error', () => {
  assert.equal(
    parseMultistatus(`${DECL}<D:error xmlns:D="DAV:"><D:no-such-thing/></D:error>`),
    null,
  );
});

test('U parseMultistatus gives an empty list for an empty multistatus', () => {
  assert.deepEqual(parseMultistatus('<D:multistatus xmlns:D="DAV:"></D:multistatus>'), []);
  assert.deepEqual(parseMultistatus('<D:multistatus xmlns:D="DAV:"/>'), []);
});

test('U parseMultistatus gives null for a text of 2,000,001 characters and a list at 2,000,000', () => {
  const open = '<D:multistatus xmlns:D="DAV:">';
  const close = '</D:multistatus>';
  const exact = open + ' '.repeat(2_000_000 - open.length - close.length) + close;
  assert.equal(exact.length, 2_000_000);
  assert.deepEqual(parseMultistatus(exact), []);
  const over = open + ' '.repeat(2_000_001 - open.length - close.length) + close;
  assert.equal(over.length, 2_000_001);
  assert.equal(parseMultistatus(over), null);
});

// ---------------------------------------------------------------- hostile input

for (const [name, text] of [
  ['<', '<'.repeat(2_000_000)],
  ['<a', '<a'.repeat(1_000_000)],
  ['&', '&'.repeat(2_000_000)],
]) {
  test(`U 2,000,000 characters of ${name} come back within a second without throwing`, () => {
    assert.equal(text.length, 2_000_000);
    const t0 = performance.now();
    let out;
    assert.doesNotThrow(() => {
      out = parseMultistatus(text);
    });
    const ms = performance.now() - t0;
    assert.ok(out === null || Array.isArray(out), 'null or an array');
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  });
}

// ---------------------------------------------------------------- allowedUrl

test('U allowedUrl is true for Apple https addresses', () => {
  for (const u of [
    'https://caldav.icloud.com/',
    'https://p99-caldav.icloud.com:443/1/calendars/',
    'https://icloud.com/x',
    'HTTPS://CALDAV.ICLOUD.COM/',
  ]) {
    assert.equal(allowedUrl(u), true, u);
  }
});

test('U allowedUrl is false for everything else', () => {
  for (const u of [
    'http://caldav.icloud.com/',
    'https://icloud.com.evil.example/',
    'https://evilicloud.com/',
    'https://user:pw@caldav.icloud.com/',
    'https://caldav.icloud.com:8443/',
    '/relative/path',
    '',
    null,
    42,
    'javascript:alert(1)',
  ]) {
    assert.equal(allowedUrl(u), false, String(u));
  }
});

// ---------------------------------------------------------------- resolveHref

test('U resolveHref resolves a path against the root', () => {
  assert.equal(resolveHref(ROOT, '/1234567890/principal/'), 'https://caldav.icloud.com/1234567890/principal/');
});

test('U resolveHref resolves a path against another Apple base', () => {
  assert.equal(
    resolveHref('https://p99-caldav.icloud.com/1234567890/calendars/', '/1234567890/calendars/home/'),
    'https://p99-caldav.icloud.com/1234567890/calendars/home/',
  );
});

test('U resolveHref keeps an absolute Apple address on another Apple host with :443', () => {
  assert.equal(
    resolveHref(ROOT, 'https://p99-caldav.icloud.com:443/1234567890/calendars/'),
    'https://p99-caldav.icloud.com/1234567890/calendars/',
  );
});

test('U resolveHref gives null for an absolute address on a foreign host', () => {
  assert.equal(resolveHref(ROOT, 'https://evil.example/1234567890/calendars/'), null);
  assert.equal(resolveHref(ROOT, 'https://icloud.com.evil.example/x'), null);
});

test('U resolveHref gives null for a protocol-relative foreign address', () => {
  assert.equal(resolveHref(ROOT, '//evil.example/x'), null);
});

test('U resolveHref gives null for junk', () => {
  assert.equal(resolveHref(ROOT, 'http://'), null);
  assert.equal(resolveHref(ROOT, 'javascript:alert(1)'), null);
  assert.equal(resolveHref('not a base', 'also not'), null);
  assert.equal(resolveHref(ROOT, null), null);
  assert.equal(resolveHref(ROOT, undefined), null);
});
