// Tests of R117, written from the contract before the code exists: a thread of the inbox may say which mailbox it
// came to. Level: the board model (panels.inbox.threads) and the rendered page. Invented names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { board, settings, raw, state, task, project, resetNumbers } from '../fixtures/build.mjs';

const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const UPDATED = '2026-10-12T07:45:00+02:00';
const COUNTS = { reply: 8, decide: 0, fyi: 0 };
const THIRTY = 'abcdefghijklmnopqrstuvwxyzabcd';
const PAYLOAD = '"><script>alert(1)</script>';
// Characters, the way R112's cut counts them (code points, not UTF-16 units).
const first20 = (s) => Array.from(s).slice(0, 20).join('');

const count = (s, re) => (s.match(re) || []).length;
const has = (o, k) => Object.hasOwn(o, k);

function input() {
  resetNumbers();
  return {
    raw: raw({ issues: [task({ number: 1, title: 'Paint the hall' })], projects: [project(3, 'House', [1])] }),
    settings: settings({ projects: [{ key: 'house', number: 3 }], focus: ['house'] }),
  };
}

const thread = (i, account, extra = {}) => {
  const t = { bucket: 'reply', from: `Sender ${i}`, subject: `Subject ${i}`, why: `Because ${i}`, draft: false, ...extra };
  if (account !== undefined) t.account = account;
  return t;
};
const inboxOf = (threads, counts = COUNTS) => ({ updated: UPDATED, counts, threads });
const build = (inbox) => {
  const b = board({ ...input(), state: state({ inbox }) });
  return { b, html: renderPage(b, THEME, OPTS), threads: b.panels.inbox?.threads };
};
const strip = (inbox) => ({ ...inbox, threads: inbox.threads.map(({ account, ...rest }) => rest) });

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0*39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

// The <li> of one thread, found by its subject; the foot is the nearest <div> before its why.
function threadPart(html, i) {
  const at = html.indexOf(`Subject ${i}<`);
  assert.ok(at >= 0, `thread ${i} is not on the page`);
  const start = html.lastIndexOf('<li', at);
  const end = html.indexOf('</li>', at);
  const li = html.slice(start, end + 5);
  const whyAt = li.indexOf(`Because ${i}<`);
  assert.ok(whyAt >= 0, `the why of thread ${i} is not in its thread`);
  const footAt = li.lastIndexOf('<div', whyAt);
  return { li, whyAt, footAt };
}
function accountElements(s) {
  const out = [];
  for (const m of s.matchAll(/<(\w+)\b[^>]*\bdata-account\b[^>]*>([\s\S]*?)<\/\1>/g)) out.push({ inner: m[2], text: unescape(m[2]), index: m.index });
  return out;
}
const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).sort();

const EIGHT = () => [
  thread(1, 'Work'),
  thread(2, '  Work\n  mail  '),
  thread(3, THIRTY),
  thread(4, PAYLOAD),
  thread(5, ''),
  thread(6, 7),
  thread(7, 'me@example.test'),
  thread(8),
];
const WORDS = ['Work', 'Work mail', first20(THIRTY), first20(PAYLOAD)];

// ---------------------------------------------------------------- the board

test('R117 the board carries the cleaned and cut label on the four usable threads and no key on the other four', () => {
  const { threads } = build(inboxOf(EIGHT()));
  assert.equal(threads?.length, 8, 'a label made a thread disappear');
  assert.deepEqual(threads.slice(0, 4).map((t) => t.account), WORDS);
  assert.equal(WORDS[2].length, 20);
  assert.equal(WORDS[3].length, 20);
  for (const t of threads.slice(4)) assert.equal(has(t, 'account'), false, `thread ${t.subject} has an account key`);
});

test('R117 a label of exactly 20 characters is kept whole and one of 21 loses its last character, no ellipsis', () => {
  const twenty = THIRTY.slice(0, 20);
  const { threads } = build(inboxOf([thread(1, twenty), thread(2, twenty + 'x'), thread(3, '…'.repeat(25))]));
  assert.equal(threads[0].account, twenty);
  assert.equal(threads[1].account, twenty);
  assert.equal(threads[2].account, '…'.repeat(20));
  assert.equal(threads.map((t) => t.account).join('').includes('...'), false);
});

test('R117 the cut counts characters, not UTF-16 units: 19 letters and two emoji give 19 letters and one emoji', () => {
  const label = THIRTY.slice(0, 19) + '\u{1F600}\u{1F600}';
  const { threads } = build(inboxOf([thread(1, label)]));
  assert.equal(threads[0].account, THIRTY.slice(0, 19) + '\u{1F600}');
  assert.equal(Array.from(threads[0].account).length, 20);
});

test('R117 control characters are removed and whitespace of every kind collapses to one space', () => {
  const { threads } = build(inboxOf([thread(1, 'Wo\u0007rk'), thread(2, '\t Work \r\n\t  diary \u0000'), thread(3, 'A\u0001\u0002B')]));
  assert.deepEqual(threads.map((t) => t.account), ['Work', 'Work diary', 'AB']);
});

test('R117 a label that is empty once cleaned, or not text, is absent: no key and the thread is still shown', () => {
  const odd = ['\u0007\u0001', ' \t\n ', null, true, false, ['Work'], { a: 1 }, 0];
  const { threads, b } = build(inboxOf(odd.map((v, i) => thread(i + 1, v))));
  assert.notDeepEqual(b.panels.inbox, { error: 'unreadable' }, 'an odd label made the file wrong shape (R50)');
  assert.equal(threads?.length, odd.length);
  for (const t of threads) assert.equal(has(t, 'account'), false, `${t.subject} kept an account key`);
});

test('R117 a label holding an @ is absent, wherever the @ sits in the cleaned text', () => {
  const late = THIRTY.slice(0, 25) + '@x';
  const { threads } = build(inboxOf([thread(1, 'me@example.test'), thread(2, '@'), thread(3, ' a @ b '), thread(4, late)]));
  assert.equal(threads.length, 4);
  for (const t of threads) assert.equal(has(t, 'account'), false, `${t.subject} kept an account key`);
});

test('R117 a thread with a label is otherwise as it was: bucket, from, subject, why, draft', () => {
  const plain = [
    thread(1, undefined, { bucket: 'decide', draft: true }),
    thread(2, undefined, { bucket: 'fyi' }),
    thread(3, undefined),
  ];
  const labelled = plain.map((t) => ({ ...t, account: 'Work' }));
  const a = build(inboxOf(plain, { reply: 1, decide: 1, fyi: 1 }));
  const w = build(inboxOf(labelled, { reply: 1, decide: 1, fyi: 1 }));
  assert.deepEqual(w.threads.map(({ account, ...rest }) => rest), a.threads);
  assert.deepEqual(w.b.panels.inbox.counts, a.b.panels.inbox.counts);
  assert.equal(w.b.panels.inbox.stale, a.b.panels.inbox.stale);
});

test('R117 the 30-thread cap and the dropped unknown bucket are unchanged with labels, and the file counts pass through', () => {
  const threads = [thread('x1', 'Work', { bucket: 'spam' })];
  for (let i = 1; i <= 35; i++) threads.push(thread(i, i % 2 ? 'Work' : 'Home'));
  const counts = { reply: 1, decide: 0, fyi: 1 };
  const out = build(inboxOf(threads, counts));
  assert.equal(out.threads.length, 30);
  assert.deepEqual(out.threads.map((t) => t.subject), threads.slice(1, 31).map((t) => t.subject));
  assert.equal(out.threads.every((t) => t.account === 'Work' || t.account === 'Home'), true);
  assert.deepEqual(out.b.panels.inbox.counts, counts);
  assert.equal(count(out.html, /data-account/g), 30);
});

test('R117 a wrong-shape inbox is still the broken panel, with or without labels', () => {
  const bad = { updated: UPDATED, counts: 'many', threads: [thread(1, 'Work')] };
  const { b } = build(bad);
  assert.deepEqual(b.panels.inbox, { error: 'unreadable' });
  const worse = build(inboxOf([thread(1, 'Work'), { bucket: 'reply', from: 7, subject: 'S', why: 'W', account: 'Work' }]));
  assert.deepEqual(worse.b.panels.inbox, { error: 'unreadable' });
  assert.equal(count(worse.html, /data-account/g), 0);
});

test('R117 a label never makes a file wrong shape: a thread whose account is 7 is shown', () => {
  const { b, threads, html } = build(inboxOf([thread(1, 7)]));
  assert.notDeepEqual(b.panels.inbox, { error: 'unreadable' });
  assert.equal(threads.length, 1);
  assert.equal(html.includes('Subject 1<'), true);
  assert.equal(html.includes('data-account'), false);
});

// ---------------------------------------------------------------- the page

test('R117 the page writes the label once per usable thread, in that thread\'s foot, before its why, holding the label alone', () => {
  const { html } = build(inboxOf(EIGHT()));
  assert.equal(count(html, /data-account/g), 4, 'data-account appears other than four times');
  for (let i = 1; i <= 4; i++) {
    const { li, whyAt, footAt } = threadPart(html, i);
    const els = accountElements(li);
    assert.equal(els.length, 1, `thread ${i} has ${els.length} data-account elements`);
    assert.ok(els[0].index > footAt, `thread ${i}: the label is not inside the foot`);
    assert.ok(els[0].index < whyAt, `thread ${i}: the label is not before the why`);
    assert.equal(els[0].text, WORDS[i - 1], `thread ${i}: the element does not hold the label alone`);
    assert.equal(/[<>]/.test(els[0].inner), false, `thread ${i}: markup inside the element: ${els[0].inner}`);
  }
  for (let i = 5; i <= 8; i++) assert.equal(accountElements(threadPart(html, i).li).length, 0, `thread ${i} has a label`);
});

test('R117 the payload label is escaped: no script beyond the board\'s own, no link gained, no @ from a label', () => {
  const withLabels = build(inboxOf(EIGHT()));
  const plain = build(strip(inboxOf(EIGHT())));
  assert.equal(count(withLabels.html, /<script/gi), count(plain.html, /<script/gi), 'a script element came from a label');
  assert.equal(withLabels.html.includes('alert(1)</s'), false);
  assert.equal(withLabels.html.includes('<script>alert'), false);
  assert.deepEqual(hrefs(withLabels.html), hrefs(plain.html), 'a label added or changed a link');
  assert.equal(withLabels.html.includes('me@example.test'), false, 'the address label is on the page');
  assert.equal(count(withLabels.html, /@/g), count(plain.html, /@/g), 'an @ came from a label');
  const payloadEl = accountElements(threadPart(withLabels.html, 4).li)[0];
  assert.ok(payloadEl, 'the payload label has no data-account element');
  assert.equal(payloadEl.inner.includes('script'), true, 'the payload text is not shown (escaped) at all');
});

test('R117 the page outside the inbox threads is unchanged by labels', () => {
  const withLabels = build(inboxOf(EIGHT())).html;
  const plain = build(strip(inboxOf(EIGHT()))).html;
  const cutOut = (h) => h.replace(/<(\w+)\b[^>]*\bdata-account\b[^>]*>[\s\S]*?<\/\1>/g, '');
  assert.equal(cutOut(withLabels), plain, 'labels changed more of the page than the data-account elements');
});

// ---------------------------------------------------------------- no label: as before, byte for byte

test('R117 the same inbox with every account removed gives the same board and page as the inbox built without the key', () => {
  const withoutKey = EIGHT().map(({ account, ...rest }) => rest);
  const stripped = strip(inboxOf(EIGHT()));
  const a = build(inboxOf(withoutKey));
  const b = build(stripped);
  assert.deepEqual(b.b, a.b);
  assert.equal(b.html, a.html);
  assert.equal(b.html.includes('data-account'), false);
  assert.equal(a.threads.every((t) => !has(t, 'account')), true);
});

test('R117 an inbox in which every label is unusable gives the same board and page as the inbox without the key', () => {
  const unusable = [thread(1, ''), thread(2, 7), thread(3, 'me@example.test'), thread(4, '  \n '), thread(5, null)];
  const none = unusable.map(({ account, ...rest }) => rest);
  const a = build(inboxOf(none));
  const b = build(inboxOf(unusable));
  assert.deepEqual(b.b, a.b);
  assert.equal(b.html, a.html);
  assert.equal(b.html.includes('data-account'), false);
  for (const t of b.threads) assert.equal(has(t, 'account'), false);
});
