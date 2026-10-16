// Tests of R157 and R158, written from the contract before the code exists: the Glitch feed maps a triage answer to the
// board's inbox document. Level: src/feed/map.mjs (buildInbox, cleanText, scrubText, dump, logEntry). Invented names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInbox, cleanText, scrubText, dump, logEntry } from '../feed/map.mjs';
import { accountWord } from '../board/stages/panels.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/feed/triage-${name}.json`, import.meta.url), 'utf8'));
const NOW = new Date('2026-10-16T04:00:00Z');
const TZ = { timeZone: 'Europe/Brussels' };
const THIRTY = 'abcdefghijklmnopqrstuvwxyzabcd';
const PAYLOAD = '"><script>alert(1)</script>';

const has = (o, k) => Object.hasOwn(o, k);
const ok = (surface) => ({ status: 'ok', surface });
const item = (i, extra = {}) => ({
  display_name: `Sender ${i}`, from: `Sender ${i}`, subject: `Subject ${i}`, automated: false,
  disposition: 'allow', date: '2026-10-16T05:00:00Z', ...extra,
});
const one = (it, label = 'Work') => buildInbox(NOW, [{ label, triage: ok([it]) }], TZ).threads;
const sweep = (text, where) => {
  assert.equal(text.includes('@'), false, `${where} holds an @`);
  assert.equal(/http/i.test(text), false, `${where} holds http`);
  assert.equal(/www\./i.test(text), false, `${where} holds www.`);
  assert.equal(/SENTINEL/.test(text), false, `${where} holds a sentinel`);
};

// ---------------------------------------------------------------- R157: clean and scrub

test('R157 cleanText turns control characters into spaces, collapses whitespace and trims', () => {
  assert.equal(cleanText('Wo\u0007rk'), 'Wo rk');
  assert.equal(cleanText('\t Ada \r\n\t  Example \u0000'), 'Ada Example');
  assert.equal(cleanText('  one   two  '), 'one two');
  assert.equal(cleanText('a\u0001\u0002b'), 'a b');
});

test('R157 cleanText gives an empty string for anything that is not text', () => {
  for (const v of [null, undefined, 7, 0, true, false, ['a'], { a: 1 }]) assert.equal(cleanText(v), '', `${JSON.stringify(v)} was kept`);
});

test('R157 scrubText removes every run holding an @, wherever it sits and however many there are', () => {
  assert.equal(scrubText('write to jo@example.test today'), 'write to today');
  assert.equal(scrubText('a@b.c d@e.f'), '');
  assert.equal(scrubText('jo@example.test'), '');
  assert.equal(scrubText('@'), '');
  assert.equal(scrubText('x@'), '');
  assert.equal(scrubText('mailto:jo@example.test,'), '');
  assert.equal(scrubText('no address here'), 'no address here');
});

test('R157 scrubText leaves nothing behind for <a@b.c>, ("a@b.c") and www.x.y/z', () => {
  assert.equal(scrubText('<a@b.c>'), '');
  assert.equal(scrubText('("a@b.c")'), '');
  assert.equal(scrubText('www.x.y/z'), '');
  assert.equal(scrubText('Jo Bloggs <jo@example.test>'), 'Jo Bloggs');
  assert.equal(scrubText('Jo [jo@example.test] (jo@example.test) "jo@example.test" \'jo@example.test\' Bloggs'), 'Jo Bloggs');
});

test('R157 scrubText removes http://, https:// and www. runs up to the next whitespace so nothing becomes a link', () => {
  assert.equal(scrubText('see http://evil.example.test/a?b=1 now'), 'see now');
  assert.equal(scrubText('see https://evil.example.test/a now'), 'see now');
  assert.equal(scrubText('see www.evil.example.test/a now'), 'see now');
  assert.equal(scrubText('https://evil.example.test/a http://evil.example.test/b'), '');
  assert.equal(/https?:\/\/|www\./.test(scrubText('a https://x.test/y b www.z.test c')), false);
});

test('R157 scrubText trims stray <, >, quotes and apostrophes from both ends but keeps an inner apostrophe', () => {
  assert.equal(scrubText('"Quoted Person"'), 'Quoted Person');
  assert.equal(scrubText('<Jo>'), 'Jo');
  assert.equal(scrubText("'Jo'"), 'Jo');
  assert.equal(scrubText(">>Jo<<"), 'Jo');
  assert.equal(scrubText("Sinead O'Brien"), "Sinead O'Brien");
});

test('R157 scrubText collapses the spaces that removals leave', () => {
  assert.equal(scrubText('a  x@y.test   b'), 'a b');
  assert.equal(scrubText('a <> () [] "" \'\' b'), 'a b');
});

// ---------------------------------------------------------------- R157: what the thread keeps

test('R157 the display name and subject are kept, scrubbed, as from and subject', () => {
  const [t] = one(item(1, { display_name: 'Jo Bloggs <jo.bloggs@example.test>', subject: 'Re: call https://evil.example.test/x?t=1 tomorrow' }));
  assert.equal(t.from, 'Jo Bloggs');
  assert.equal(t.subject, 'Re: call tomorrow');
});

test('R157 a name that is only an address gives (unknown sender) even when from holds a real name', () => {
  const [t] = one(item(1, { display_name: 'ceo@example.test', from: 'Real Looking Name' }));
  assert.equal(t.from, '(unknown sender)');
});

test('R157 a missing, null, blank or non-text display name gives (unknown sender), with no fallback to from', () => {
  const base = { from: 'Real Looking Name' };
  for (const display_name of [undefined, null, '', '   ', '<a@b.c>', 7, ['Real'], { a: 1 }]) {
    const it = item(1, { ...base, display_name });
    if (display_name === undefined) delete it.display_name;
    const [t] = one(it);
    assert.equal(t.from, '(unknown sender)', `display_name ${JSON.stringify(display_name)}`);
    assert.equal(t.from.includes('Real'), false);
  }
});

test('R157 a missing, blank, non-text or all-address subject gives (no subject)', () => {
  for (const subject of [undefined, null, '', ' \n\t ', 7, 'www.x.y/z', '<a@b.c>', '("a@b.c")', 'https://evil.example.test/x']) {
    const it = item(1, { subject });
    if (subject === undefined) delete it.subject;
    assert.equal(one(it)[0].subject, '(no subject)', `subject ${JSON.stringify(subject)}`);
  }
});

test('R157 a 300-character name and subject are cut to 200 characters', () => {
  const [t] = one(item(1, { display_name: 'N'.repeat(300), subject: 'S'.repeat(300) }));
  assert.equal(t.from, 'N'.repeat(200));
  assert.equal(t.subject, 'S'.repeat(200));
  const [exact] = one(item(2, { display_name: 'N'.repeat(200), subject: 'S'.repeat(201) }));
  assert.equal(exact.from, 'N'.repeat(200));
  assert.equal(exact.subject, 'S'.repeat(200));
});

test('R157 the scrub runs before the cut: an address inside a long name does not survive as a fragment', () => {
  const [t] = one(item(1, { display_name: 'N'.repeat(190) + ' someone@example.test', subject: 'ok' }));
  assert.equal(t.from, 'N'.repeat(190));
});

test('R157 text is cleaned: line breaks and control characters in a name or subject become single spaces', () => {
  const [t] = one(item(1, { display_name: ' Ada\n\tExample ', subject: 'Two\nlines\tand\u0007bell' }));
  assert.equal(t.from, 'Ada Example');
  assert.equal(t.subject, 'Two lines and bell');
});

test('R157 only the five fields are read: from, address, domain, snippet, subject_raw, ids and attachments change nothing', () => {
  const clean = item(1);
  const noisy = { ...clean, from: 'FROM-SENTINEL', address: 'x@example.test', domain: 'example.test', snippet: 'SNIPPET-SENTINEL-1',
    subject_raw: 'SUBJECTRAW-SENTINEL', thread_id: 'T-1', message_id: 'M-1', attachments_mode: 'A', known_person: true, person_id: 9, label: 'Inbox' };
  const a = buildInbox(NOW, [{ label: 'Work', triage: ok([clean]) }], TZ);
  const b = buildInbox(NOW, [{ label: 'Work', triage: ok([noisy]) }], TZ);
  assert.deepEqual(b, a);
});

test('R157 the hostile fixture: no @, http, www. or sentinel survives in the document, the dump or the log entry', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: fixture('hostile') }], TZ);
  assert.equal(doc.threads.length, 6);
  sweep(JSON.stringify(doc), 'the document');
  sweep(dump(doc), 'the dump');
  sweep(JSON.stringify(logEntry(NOW, doc.threads.length, TZ)), 'the log entry');
});

test('R157 the hostile fixture gives the named results thread by thread', () => {
  const t = buildInbox(NOW, [{ label: 'Work', triage: fixture('hostile') }], TZ).threads;
  assert.deepEqual(t.map((x) => x.from), ['Jo Bloggs', '(unknown sender)', '(unknown sender)', 'Quoted Person', "Sinead O'Brien", 'Pat Plain']);
  assert.deepEqual(t.map((x) => x.subject), ['Re: call tomorrow', '(no subject)', '(no subject)', 'Lunch ok', 'Two lines and bell', 'Plain subject']);
});

test('R157 the hostile fixture gives no thread any key beyond bucket, from, subject, why and account', () => {
  const t = buildInbox(NOW, [{ label: 'Work', triage: fixture('hostile') }], TZ).threads;
  for (const x of t) for (const k of Object.keys(x)) assert.ok(['bucket', 'from', 'subject', 'why', 'account'].includes(k), `key ${k}`);
});

test('R157 the suppressed list and the people section of an answer are never read', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: fixture('hostile') }], TZ);
  assert.equal(JSON.stringify(doc).includes('Muted'), false);
  assert.equal(doc.threads.length, 6);
});

test('R157 the account login, id and label of the answer are not copied: only the config label, as accountWord, reaches a thread', () => {
  const doc = buildInbox(NOW, [{ label: 'Home', triage: fixture('Work') }], TZ);
  const text = JSON.stringify(doc);
  assert.equal(text.includes('acct-work-1'), false);
  assert.equal(text.includes('example.test'), false);
  for (const t of doc.threads) assert.equal(t.account, 'Home');
});

// ---------------------------------------------------------------- R158: buckets and counts

test('R158 automated true goes to fyi, false and a missing flag go to reply, and none go to decide', () => {
  const threads = one(item(1, { automated: true }));
  assert.equal(threads[0].bucket, 'fyi');
  assert.equal(one(item(2, { automated: false }))[0].bucket, 'reply');
  const it = item(3);
  delete it.automated;
  assert.equal(one(it)[0].bucket, 'reply');
  const doc = buildInbox(NOW, [{ label: 'Work', triage: ok([item(1, { automated: true }), item(2), item(3, { automated: 'yes' }), item(4, { automated: 1 })]) }], TZ);
  assert.equal(doc.threads.some((t) => t.bucket === 'decide'), false);
});

test('R158 only an answer whose status is ok contributes: ask, dormant and a missing status give nothing', () => {
  const surface = [item(1), item(2)];
  const accounts = [
    { label: 'Work', triage: { status: 'ask', surface } },
    { label: 'Home', triage: { status: 'dormant', surface } },
    { label: 'Other', triage: { surface } },
    { label: 'Fine', triage: { status: 'ok', surface: [item(3)] } },
  ];
  const doc = buildInbox(NOW, accounts, TZ);
  assert.deepEqual(doc.threads.map((t) => t.subject), ['Subject 3']);
  assert.deepEqual(doc.counts, { reply: 1, decide: 0, fyi: 0 });
});

test('R158 an answer that is not ok at all gives an empty document with zero counts', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: { status: 'ask', surface: [item(1)] } }], TZ);
  assert.deepEqual(doc.threads, []);
  assert.deepEqual(doc.counts, { reply: 0, decide: 0, fyi: 0 });
});

test('R158 an item that is not an object is skipped and the others are kept', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: ok([null, 7, 'text', true, item(1), undefined, item(2)]) }], TZ);
  assert.deepEqual(doc.threads.map((t) => t.subject), ['Subject 1', 'Subject 2']);
});

test('R158 the counts are over the kept threads', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: fixture('hostile') }], TZ);
  assert.deepEqual(doc.counts, { reply: 5, decide: 0, fyi: 1 });
  assert.equal(doc.counts.reply + doc.counts.fyi, doc.threads.length);
});

test('R158 the good fixtures of two mailboxes merge newest first with the right buckets and counts', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: fixture('Work') }, { label: 'Home', triage: fixture('Home') }], TZ);
  assert.deepEqual(doc.threads.map((t) => t.subject), ['Dinner Friday', 'Quarterly numbers', 'Your receipt', 'Weekly digest', 'Server down']);
  assert.deepEqual(doc.threads.map((t) => t.account), ['Home', 'Work', 'Work', 'Home', 'Work']);
  assert.deepEqual(doc.threads.map((t) => t.bucket), ['reply', 'reply', 'fyi', 'fyi', 'reply']);
  assert.deepEqual(doc.counts, { reply: 3, decide: 0, fyi: 2 });
});

// ---------------------------------------------------------------- R158: why

test('R158 why: a missing, null, blank or non-text disposition gives No rule for this sender yet', () => {
  for (const disposition of [undefined, null, '', '   ', '\n\t', 7, ['allow']]) {
    const it = item(1, { disposition });
    if (disposition === undefined) delete it.disposition;
    assert.equal(one(it)[0].why, 'No rule for this sender yet', `disposition ${JSON.stringify(disposition)}`);
  }
});

test('R158 why: watch_important, live_issue and allow give their three fixed sentences', () => {
  assert.equal(one(item(1, { disposition: 'watch_important' }))[0].why, 'You marked this sender important');
  assert.equal(one(item(1, { disposition: 'live_issue' }))[0].why, 'You marked this as a live issue');
  assert.equal(one(item(1, { disposition: 'allow' }))[0].why, 'You allow this sender');
});

test('R158 why: any other disposition gives "Rule: " and the disposition with underscores turned into spaces', () => {
  assert.equal(one(item(1, { disposition: 'block_sender_now' }))[0].why, 'Rule: block sender now');
  assert.equal(one(item(1, { disposition: 'newsletter' }))[0].why, 'Rule: newsletter');
  assert.equal(one(item(1, { disposition: '  mute_for_a_week \n' }))[0].why, 'Rule: mute for a week');
});

test('R158 why: an other-disposition is scrubbed like R157 text, so no address or link reaches the board', () => {
  assert.equal(one(item(1, { disposition: 'send_to_bin_x@evil.test' }))[0].why, 'Rule: send to bin');
  assert.equal(one(item(1, { disposition: 'see_https://evil.test/a_now' }))[0].why, 'Rule: see now');
});

test('R158 why: the whole why text, prefix included, is cut to 200 characters', () => {
  const why = one(item(1, { disposition: 'r'.repeat(300) }))[0].why;
  assert.equal(why, ('Rule: ' + 'r'.repeat(300)).slice(0, 200).trimEnd());
  assert.equal(why.length, 200);
});

test('R158 why: the named dispositions match exactly, so a different case or spelling is an other-disposition', () => {
  assert.equal(one(item(1, { disposition: 'Allow' }))[0].why, 'Rule: Allow');
  assert.equal(one(item(1, { disposition: 'live issue' }))[0].why, 'Rule: live issue');
});

// ---------------------------------------------------------------- R158: dates and order

test('R158 the date: an offset date, a no-offset date (read as UTC), a missing date and an unparseable date order as UTC instants', () => {
  const surface = [
    item('A', { date: '2026-10-16T08:00:00+02:00' }), // 06:00Z
    item('B', { date: '2026-10-16T07:00:00' }),       // 07:00Z, no offset reads as UTC
    item('C', { date: undefined }),                   // 1970
    item('D', { date: 'not a date' }),                // 1970
    item('E', { date: '2026-10-16T05:30:00Z' }),
  ];
  delete surface[2].date;
  const doc = buildInbox(NOW, [{ label: 'Work', triage: ok(surface) }], TZ);
  assert.deepEqual(doc.threads.map((t) => t.subject), ['Subject B', 'Subject A', 'Subject E', 'Subject C', 'Subject D']);
});

test('R158 a date-only value reads as UTC midnight and a non-text date sorts as 1970', () => {
  const surface = [item('A', { date: '2026-10-15' }), item('B', { date: 12345 }), item('C', { date: null }), item('D', { date: '2026-10-14T23:59:59Z' })];
  const doc = buildInbox(NOW, [{ label: 'Work', triage: ok(surface) }], TZ);
  assert.deepEqual(doc.threads.map((t) => t.subject), ['Subject A', 'Subject D', 'Subject B', 'Subject C']);
});

test('R158 newest first even when the answer lists oldest first', () => {
  const surface = [1, 2, 3, 4].map((i) => item(i, { date: `2026-10-1${i}T05:00:00Z` }));
  const doc = buildInbox(NOW, [{ label: 'Work', triage: ok(surface) }], TZ);
  assert.deepEqual(doc.threads.map((t) => t.subject), ['Subject 4', 'Subject 3', 'Subject 2', 'Subject 1']);
});

test('R158 ties keep read order: mailboxes in config order, then items in answer order', () => {
  const same = '2026-10-16T05:00:00Z';
  const accounts = [
    { label: 'Work', triage: ok([item('W1', { date: same }), item('W2', { date: same })]) },
    { label: 'Home', triage: ok([item('H1', { date: same }), item('H2', { date: same })]) },
  ];
  const doc = buildInbox(NOW, accounts, TZ);
  assert.deepEqual(doc.threads.map((t) => t.subject), ['Subject W1', 'Subject W2', 'Subject H1', 'Subject H2']);
  const swapped = buildInbox(NOW, [accounts[1], accounts[0]], TZ);
  assert.deepEqual(swapped.threads.map((t) => t.subject), ['Subject H1', 'Subject H2', 'Subject W1', 'Subject W2']);
});

test('R158 the same instant written with different offsets is a tie and keeps read order', () => {
  const surface = [item('A', { date: '2026-10-16T07:00:00+02:00' }), item('B', { date: '2026-10-16T05:00:00Z' })];
  const doc = buildInbox(NOW, [{ label: 'Work', triage: ok(surface) }], TZ);
  assert.deepEqual(doc.threads.map((t) => t.subject), ['Subject A', 'Subject B']);
});

test('R158 31 items keep 30, the newest, and the counts are over the kept 30', () => {
  const surface = [];
  for (let i = 1; i <= 31; i++) {
    const day = String(i).padStart(2, '0');
    surface.push(item(i, { date: `2026-09-${day}T05:00:00Z`.replace('2026-09-31', '2026-10-01'), automated: i === 1 }));
  }
  // item 1 is the oldest (1 Sep) and the only fyi, so it is the one that falls off
  const doc = buildInbox(NOW, [{ label: 'Work', triage: ok(surface) }], TZ);
  assert.equal(doc.threads.length, 30);
  assert.equal(doc.threads.some((t) => t.subject === 'Subject 1'), false);
  assert.equal(doc.threads[0].subject, 'Subject 31');
  assert.deepEqual(doc.counts, { reply: 30, decide: 0, fyi: 0 });
});

test('R158 30 items keep all 30 and 0 items give an empty document', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => item(i + 1, { date: `2026-10-${String(i + 1).padStart(2, '0')}T05:00:00Z` }));
  assert.equal(buildInbox(NOW, [{ label: 'Work', triage: ok(thirty) }], TZ).threads.length, 30);
  const none = buildInbox(NOW, [{ label: 'Work', triage: ok([]) }], TZ);
  assert.deepEqual(none.threads, []);
  assert.deepEqual(none.counts, { reply: 0, decide: 0, fyi: 0 });
  assert.deepEqual(buildInbox(NOW, [], TZ).threads, []);
});

test('R158 the cap of 30 holds across two mailboxes, not per mailbox', () => {
  const mk = (p, n) => Array.from({ length: n }, (_, i) => item(`${p}${i + 1}`, { date: '2026-10-16T05:00:00Z' }));
  const doc = buildInbox(NOW, [{ label: 'Work', triage: ok(mk('W', 20)) }, { label: 'Home', triage: ok(mk('H', 20)) }], TZ);
  assert.equal(doc.threads.length, 30);
  assert.equal(doc.threads.filter((t) => t.account === 'Work').length, 20);
  assert.equal(doc.threads.filter((t) => t.account === 'Home').length, 10);
});

// ---------------------------------------------------------------- R158: account and contract drift

const LABELS = ['Work', '  Work\n  mail  ', THIRTY, PAYLOAD, '', '   ', 'me@example.test', ' a @ b ', '\u0007\u0001', 'A\u0001\u0002B',
  THIRTY.slice(0, 19) + '\u{1F600}\u{1F600}', '…'.repeat(25), THIRTY.slice(0, 20), THIRTY.slice(0, 21)];

test('R158 contract drift: the same labels give the feed\'s account the very word accountWord gives, or no key when it gives null', () => {
  for (const label of LABELS) {
    const threads = buildInbox(NOW, [{ label, triage: ok([item(1)]) }], TZ).threads;
    assert.equal(threads.length, 1, `label ${JSON.stringify(label)} made the thread disappear`);
    const want = accountWord(label);
    if (want === null) assert.equal(has(threads[0], 'account'), false, `label ${JSON.stringify(label)} kept an account key`);
    else assert.equal(threads[0].account, want, `label ${JSON.stringify(label)}`);
  }
});

test('R158 a label that gives null leaves out the account key altogether, and a usable one is present', () => {
  for (const label of ['', ' \n ', 'me@example.test', '\u0007']) {
    const [t] = one(item(1), label);
    assert.equal(has(t, 'account'), false);
    assert.equal(Object.keys(t).includes('account'), false);
  }
  assert.equal(one(item(1), 'Work')[0].account, 'Work');
});

test('R158 the label word is cut at 20 characters, counted as characters, with no ellipsis', () => {
  assert.equal(one(item(1), THIRTY)[0].account, THIRTY.slice(0, 20));
  assert.equal(Array.from(one(item(1), THIRTY.slice(0, 19) + '\u{1F600}\u{1F600}')[0].account).length, 20);
});

// ---------------------------------------------------------------- R158: the document, its order, its dump

test('R158 the document has exactly the keys updated, counts, threads in that order, and counts has reply, decide, fyi in that order', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: fixture('Work') }], TZ);
  assert.deepEqual(Object.keys(doc), ['updated', 'counts', 'threads']);
  assert.deepEqual(Object.keys(doc.counts), ['reply', 'decide', 'fyi']);
});

test('R158 each thread has the keys bucket, from, subject, why, account in that order, and account is the last key or absent', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: fixture('Work') }], TZ);
  for (const t of doc.threads) assert.deepEqual(Object.keys(t), ['bucket', 'from', 'subject', 'why', 'account']);
  const [bare] = one(item(1), '');
  assert.deepEqual(Object.keys(bare), ['bucket', 'from', 'subject', 'why']);
});

test('R158 updated is now in ISO 8601 with seconds and the offset of the time zone, and no milliseconds', () => {
  assert.equal(buildInbox(NOW, [], { timeZone: 'Europe/Brussels' }).updated, '2026-10-16T06:00:00+02:00');
  assert.equal(buildInbox(new Date('2026-12-01T12:00:07.456Z'), [], { timeZone: 'Europe/Brussels' }).updated, '2026-12-01T13:00:07+01:00');
  assert.equal(buildInbox(NOW, [], { timeZone: 'America/New_York' }).updated, '2026-10-16T00:00:00-04:00');
});

test('R158 updated defaults to UTC and written as +00:00 (assumed spelling, see report)', () => {
  assert.equal(buildInbox(NOW, []).updated, '2026-10-16T04:00:00+00:00');
  assert.equal(buildInbox(NOW, [], {}).updated, '2026-10-16T04:00:00+00:00');
});

test('R158 dump is JSON indented by 2 spaces plus exactly one trailing newline', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: fixture('Work') }], TZ);
  const text = dump(doc);
  assert.equal(text, JSON.stringify(doc, null, 2) + '\n');
  assert.equal(text.endsWith('}\n'), true);
  assert.equal(text.endsWith('\n\n'), false);
  assert.ok(text.includes('\n  "updated": '), 'a top key is not indented by 2 spaces');
  assert.ok(text.includes('\n    {\n      "bucket": '), 'a thread is not indented by 4 and its keys by 6');
  assert.equal(text.includes('\t'), false);
  assert.deepEqual(JSON.parse(text), doc);
});

test('R158 dump writes the keys in the document\'s order', () => {
  const text = dump(buildInbox(NOW, [{ label: 'Work', triage: fixture('Work') }], TZ));
  const at = (s) => text.indexOf(s);
  assert.ok(at('"updated"') < at('"counts"') && at('"counts"') < at('"threads"'));
  assert.ok(at('"reply"') < at('"decide"') && at('"decide"') < at('"fyi"'));
  assert.ok(at('"bucket"') < at('"from"') && at('"from"') < at('"subject"') && at('"subject"') < at('"why"') && at('"why"') < at('"account"'));
});

test('R158 a document under 256 KB is written and one of 256 KB (262144 UTF-8 bytes) or more is refused with a RangeError', () => {
  const make = (pad) => ({ updated: '2026-10-16T06:00:00+02:00', counts: { reply: 1, decide: 0, fyi: 0 }, threads: [{ bucket: 'reply', from: pad, subject: 's', why: 'w' }] });
  const size = (pad) => Buffer.byteLength(JSON.stringify(make(pad), null, 2) + '\n', 'utf8');
  const base = size('');
  const under = 'x'.repeat(262143 - base);
  const exact = 'x'.repeat(262144 - base);
  assert.equal(size(under), 262143);
  assert.equal(size(exact), 262144);
  assert.doesNotThrow(() => dump(make(under)));
  assert.throws(() => dump(make(exact)), RangeError);
  assert.throws(() => dump(make('x'.repeat(400000))), RangeError);
});

test('R158 the 256 KB limit counts UTF-8 bytes, not characters', () => {
  const doc = { updated: 'u', counts: { reply: 1, decide: 0, fyi: 0 }, threads: [{ bucket: 'reply', from: 'é'.repeat(140000), subject: 's', why: 'w' }] };
  assert.ok(JSON.stringify(doc, null, 2).length < 262144, 'the test document is not under 256K characters');
  assert.throws(() => dump(doc), RangeError);
});

test('R158 logEntry is {t, agent, what} with the time in the zone, the agent Glitch and the thread count', () => {
  const e = logEntry(NOW, 5, TZ);
  assert.deepEqual(e, { t: '06:00', agent: 'Glitch', what: 'Updated inbox (5 threads)' });
  assert.deepEqual(Object.keys(e), ['t', 'agent', 'what']);
  assert.equal(logEntry(new Date('2026-12-01T22:05:00Z'), 0, TZ).t, '23:05');
  assert.equal(logEntry(NOW, 0, TZ).what, 'Updated inbox (0 threads)');
});

test('R158 the log entry and the good fixtures\' dump carry no address, link or sentinel', () => {
  const doc = buildInbox(NOW, [{ label: 'Work', triage: fixture('Work') }, { label: 'Home', triage: fixture('Home') }], TZ);
  sweep(dump(doc), 'the dump');
  sweep(JSON.stringify(logEntry(NOW, doc.threads.length, TZ)), 'the log entry');
});

// ---------------------------------------------------------------- R157 regression: a removal must not join characters into a link
// (cross-family review finding 3: htt<x@y.test>ps://... became https://... after the link pass had already run)

const noLink = (s, where) => {
  assert.equal(/http/i.test(s), false, `${where} holds http: ${JSON.stringify(s)}`);
  assert.equal(/www\./i.test(s), false, `${where} holds www.: ${JSON.stringify(s)}`);
  assert.equal(s.includes('://'), false, `${where} holds ://: ${JSON.stringify(s)}`);
  assert.equal(s.includes('@'), false, `${where} holds @: ${JSON.stringify(s)}`);
};

test('R157 regression: an address removed from inside "https" does not leave a link behind', () => {
  const s = scrubText('htt<x@y.test>ps://secret.example.test/path');
  noLink(s, 'scrubText');
  noLink(scrubText(cleanText('see htt<x@y.test>ps://secret.example.test/path now')), 'scrubText with words around');
});

test('R157 regression: the same join in a subject, a display name and a disposition leaves no link in the thread', () => {
  const trick = 'htt<x@y.test>ps://secret.example.test/path';
  const [t] = one(item(1, { display_name: `Jo ${trick}`, subject: `Hi ${trick}`, disposition: `rule_${trick}` }));
  noLink(t.from, 'from');
  noLink(t.subject, 'subject');
  noLink(t.why, 'why');
  noLink(dump(buildInbox(NOW, [{ label: 'Work', triage: ok([item(1, { display_name: trick, subject: trick, disposition: trick })]) }], TZ)), 'the dump');
});

test('R157 regression: an address removed from inside www gives no www. run', () => {
  for (const s of ['ww<a@b.c>w.x.y', 'www<a@b.c>.x.y', 'w<a@b.c>ww.x.y/z', 'www.<a@b.c>x.y']) noLink(scrubText(s), s);
});

test('R157 regression: empty pairs removed from inside http, https and www give no link', () => {
  const glue = ['()', '[]', '""', "''", '<>'];
  const bases = ['h#ttps://secret.example.test/p', 'ht#tp://secret.example.test/p', 'https#://secret.example.test/p', 'https:#//secret.example.test/p', 'ww#w.secret.example.test/p', 'www#.secret.example.test/p'];
  for (const g of glue) for (const b of bases) {
    const s = b.replace('#', g);
    noLink(scrubText(s), s);
    noLink(one(item(1, { subject: s }))[0].subject, `subject ${s}`);
  }
});

test('R157 regression: nested and repeated glue (("") and a pair left empty by another removal) still joins nothing', () => {
  for (const s of ['h(("" ))ttps://x.test', 'h("")ttps://x.test', 'h(<a@b.c>)ttps://x.test', 'h[(x@y.test)]ttps://x.test', 'htt<x@y.test><a@b.c>ps://x.test', 'h<>t<>t<>p<>s<>:<>/<>/<>x.test']) {
    noLink(scrubText(s), s);
  }
});

test('R157 regression: property, 400 generated hostile strings mixing addresses, brackets and link fragments never leave @, http, www. or ://', () => {
  let seed = 20261016;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const glue = ['<a@b.c>', '<x@y.test>', '()', '[]', '""', "''", '<>', '("a@b.c")', '[<>]', '(())', '"<>"', '<(a@b.c)>', '(<>)'];
  const links = ['https://secret.example.test/path', 'http://secret.example.test', 'www.secret.example.test/p', 'HTTPS://SECRET.EXAMPLE.TEST/P', 'Www.x.y/z'];
  const words = ['hello', 'Jo', 'Bloggs', 'invoice', 'a@b.c', 'jo@example.test', '"', "'", '<', '>', '(', ')', '[', ']', '\u0007', '\n'];
  for (let n = 0; n < 400; n++) {
    let link = Array.from(pick(links));
    for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) link.splice(1 + Math.floor(rnd() * (link.length - 1)), 0, pick(glue));
    const parts = [pick(words), link.join(''), pick(words)];
    if (rnd() < 0.5) parts.splice(Math.floor(rnd() * 3), 0, pick(glue));
    const s = parts.join(rnd() < 0.5 ? ' ' : '');
    noLink(scrubText(s), `case ${n} (${JSON.stringify(s)}) via scrubText`);
    noLink(scrubText(cleanText(s)), `case ${n} (${JSON.stringify(s)}) via cleanText then scrubText`);
  }
});
