// Tests of R164, written from the contract before the code exists: a mailbox may have a colour.
// Level: the board model (panels.inbox.threads[i].colour), the rendered page (data-colour) and board.css.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderPage } from '../board/render/page.mjs';
import * as themeMod from '../board/theme.mjs';
const { resolveTheme, themeCss } = themeMod;
// mailboxVars and MAILBOX_COLOURS are read lazily so a missing export fails the tests that need it, not the whole file.
const mailboxVars = (c) => themeMod.mailboxVars(c);
const allVars = () => themeMod.mailboxVars(Object.keys(themeMod.MAILBOX_COLOURS));
import { board, settings, raw, state, task, project, resetNumbers } from '../fixtures/build.mjs';

const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const UPDATED = '2026-10-12T07:45:00+02:00';
const COLOURS = ['green', 'amber', 'orange', 'charcoal', 'blue', 'purple', 'red', 'grey'];
const PAYLOAD = '"><script>alert(1)</script>';
const CSS = readFileSync(new URL('../board/static/board.css', import.meta.url), 'utf8');

const count = (s, re) => (s.match(re) || []).length;
const has = (o, k) => Object.hasOwn(o, k);
const warn = (b, code) => (b.meta?.warnings ?? []).find((w) => w.code === code);

const thread = (i, account) => {
  const t = { bucket: 'reply', from: `Sender ${i}`, subject: `Subject ${i}`, why: `Because ${i}`, draft: false };
  if (account !== undefined) t.account = account;
  return t;
};
const inboxOf = (threads) => ({ updated: UPDATED, counts: { reply: threads.length, decide: 0, fyi: 0 }, threads });

// mailboxes === undefined means the key is left out of the settings entirely.
function build(threads, mailboxes) {
  resetNumbers();
  const over = { projects: [{ key: 'house', number: 3 }], focus: ['house'] };
  if (mailboxes !== undefined) over.mailboxes = mailboxes;
  const b = board({
    raw: raw({ issues: [task({ number: 1, title: 'Paint the hall' })], projects: [project(3, 'House', [1])] }),
    settings: settings(over),
    state: state({ inbox: inboxOf(threads) }),
  });
  return { b, html: renderPage(b, THEME, OPTS), threads: b.panels.inbox?.threads };
}

// The data-account span of thread i, as the opening tag text.
function accountTag(html, i) {
  const at = html.indexOf(`Subject ${i}<`);
  assert.ok(at >= 0, `thread ${i} is not on the page`);
  const li = html.slice(html.lastIndexOf('<li', at), html.indexOf('</li>', at));
  const m = li.match(/<span\b[^>]*\bdata-account\b[^>]*>/);
  assert.ok(m, `thread ${i} has no data-account span`);
  return m[0];
}

// ------------------------------------------------ byte-equality without the block

test('R164 settings without mailboxes give the same board and page as before, with no data-colour', () => {
  const threads = [thread(1, 'Work'), thread(2, 'Home'), thread(3)];
  const a = build(threads);
  const b = build(threads, undefined);
  assert.deepEqual(b.b, a.b);
  assert.equal(b.html, a.html);
  assert.equal(a.html.includes('data-colour'), false);
  assert.equal(count(a.html, /data-account/g), 2);
  for (const t of a.threads) assert.equal(has(t, 'colour'), false);
});

test('R164 an empty mailboxes object gives the same board and page as no block at all', () => {
  const threads = [thread(1, 'Work'), thread(2, 'Home')];
  const a = build(threads);
  const e = build(threads, {});
  assert.deepEqual(e.b.panels, a.b.panels);
  assert.equal(e.html, a.html);
  assert.equal(e.html.includes('data-colour'), false);
  assert.equal(warn(e.b, 'setting-invalid'), undefined);
});

test('R164 a mailboxes block whose label matches no thread leaves the page byte-identical', () => {
  const threads = [thread(1, 'Work'), thread(2)];
  const a = build(threads);
  const b = build(threads, { Elsewhere: 'green' });
  assert.deepEqual(b.b.panels, a.b.panels);
  assert.equal(b.html, a.html);
});

// ------------------------------------------------ the eight colours

for (const c of COLOURS) {
  test(`R164 colour ${c} on a matching thread: colour in the model, data-colour="${c}" on that span only`, () => {
    const { threads, html } = build([thread(1, 'Work'), thread(2, 'Home'), thread(3)], { Work: c });
    assert.equal(threads[0].colour, c);
    assert.equal(threads[0].account, 'Work');
    assert.equal(has(threads[1], 'colour'), false);
    assert.equal(has(threads[2], 'colour'), false);
    const tag = accountTag(html, 1);
    assert.match(tag, new RegExp(`\\bdata-colour="${c}"`));
    assert.match(tag, /\bclass="thread__account"/);
    assert.equal(accountTag(html, 2).includes('data-colour'), false);
    assert.equal(count(html, /data-colour/g), 1);
  });
}

test('R164 two mailboxes with two colours colour their own threads', () => {
  const { threads, html } = build([thread(1, 'Work'), thread(2, 'Home'), thread(3, 'Work')], { Work: 'blue', Home: 'amber' });
  assert.deepEqual(threads.map((t) => t.colour), ['blue', 'amber', 'blue']);
  assert.equal(count(html, /data-colour="blue"/g), 2);
  assert.equal(count(html, /data-colour="amber"/g), 1);
});

test('R164 the coloured thread is otherwise as it was: the model without colour equals the plain model', () => {
  const threads = [thread(1, 'Work'), thread(2, 'Home')];
  const plain = build(threads);
  const coloured = build(threads, { Work: 'red' });
  assert.deepEqual(coloured.threads.map(({ colour, ...rest }) => rest), plain.threads);
  assert.deepEqual(coloured.b.panels.inbox.counts, plain.b.panels.inbox.counts);
  const fill = /--mbx-red:\s*#[0-9a-fA-F]{3,6};/g;
  const ink = /--mbx-red-ink:\s*#[0-9a-fA-F]{3,6};/g;
  assert.equal(count(coloured.html, fill), 1, '--mbx-red declaration is not present exactly once');
  assert.equal(count(coloured.html, ink), 1, '--mbx-red-ink declaration is not present exactly once');
  assert.equal(count(coloured.html, / data-colour="red"/g), 1);
  assert.equal(coloured.html.replace(' data-colour="red"', '').replace(fill, '').replace(ink, ''), plain.html);
});

// ------------------------------------------------ matching after R117 cleaning

test('R164 a key with extra spaces and control characters matches the cleaned account', () => {
  const { threads, html } = build([thread(1, 'Work mail')], { '  Wo\u0007rk \n  mail ': 'purple' });
  assert.equal(threads[0].account, 'Work mail');
  assert.equal(threads[0].colour, 'purple');
  assert.match(accountTag(html, 1), /data-colour="purple"/);
});

test('R164 an account with extra spaces and control characters matches a clean key', () => {
  const { threads } = build([thread(1, '  Work\n  mail\u0001 ')], { 'Work mail': 'green' });
  assert.equal(threads[0].account, 'Work mail');
  assert.equal(threads[0].colour, 'green');
});

test('R164 a key and an account both cut at 20 characters meet on the cut', () => {
  const long = 'abcdefghijklmnopqrstuvwxyzabcd';
  const { threads } = build([thread(1, long)], { [long]: 'orange' });
  assert.equal(threads[0].account, long.slice(0, 20));
  assert.equal(threads[0].colour, 'orange');
});

// ------------------------------------------------ plain tag cases

test('R164 an unknown colour gives the plain tag and no colour key', () => {
  const plain = build([thread(1, 'Work')]);
  for (const bad of ['pink', 'Green', '', ' green', 'green ', 'GREEN', 'blue;red', 'var(--x)']) {
    const r = build([thread(1, 'Work')], { Work: bad });
    assert.equal(has(r.threads[0], 'colour'), false, `colour kept for ${JSON.stringify(bad)}`);
    assert.equal(r.threads[0].account, 'Work');
    assert.equal(r.html.includes('data-colour'), false);
    assert.equal(r.html, plain.html, `page differs for ${JSON.stringify(bad)}`);
  }
});

test('R164 a label not in the map gives the plain tag and the other thread keeps its colour', () => {
  const { threads, html } = build([thread(1, 'Work'), thread(2, 'Other')], { Work: 'green' });
  assert.equal(threads[0].colour, 'green');
  assert.equal(has(threads[1], 'colour'), false);
  assert.equal(accountTag(html, 2).includes('data-colour'), false);
});

test('R164 a thread without an account never gets a colour, whatever the map holds', () => {
  const { threads, html } = build([thread(1), thread(2, '')], { '': 'green', undefined: 'red', Work: 'blue' });
  for (const t of threads) assert.equal(has(t, 'colour'), false);
  assert.equal(html.includes('data-colour'), false);
});

// ------------------------------------------------ invalid blocks

test('R164 a non-object mailboxes block is dropped with a settings warning, the rest of the board unchanged', () => {
  const threads = [thread(1, 'Work'), thread(2, 'Home')];
  const plain = build(threads);
  for (const bad of ['green', 5, true, null, ['Work', 'green'], [{ Work: 'green' }]]) {
    const r = build(threads, bad);
    assert.deepEqual(r.b.panels, plain.b.panels, `panels changed for ${JSON.stringify(bad)}`);
    assert.equal(r.html.includes('data-colour'), false);
    assert.equal(warn(r.b, 'setting-invalid')?.code, 'setting-invalid', `no setting-invalid for ${JSON.stringify(bad)}`);
  }
});

test('R164 a non-string colour is dropped without a crash, the valid entries and the rest unchanged', () => {
  const threads = [thread(1, 'Work'), thread(2, 'Home'), thread(3, 'Bank'), thread(4, 'Misc')];
  const r = build(threads, { Work: 5, Home: null, Bank: 'blue', Misc: { c: 'red' } });
  assert.equal(has(r.threads[0], 'colour'), false);
  assert.equal(has(r.threads[1], 'colour'), false);
  assert.equal(r.threads[2].colour, 'blue');
  assert.equal(has(r.threads[3], 'colour'), false);
  assert.equal(count(r.html, /data-colour/g), 1);
  const plain = build(threads);
  assert.deepEqual(r.threads.map(({ colour, ...rest }) => rest), plain.threads);
  assert.deepEqual(r.b.panels.inbox.counts, plain.b.panels.inbox.counts);
});

test('R164 a bad mailboxes block never makes the inbox the broken panel', () => {
  const r = build([thread(1, 'Work')], { Work: 7 });
  assert.notDeepEqual(r.b.panels.inbox, { error: 'unreadable' });
  assert.equal(r.threads.length, 1);
});

// ------------------------------------------------ injection

test('R164 an attribute-injection payload as a key or a colour never reaches the page', () => {
  const evil = 'green" onclick="alert(1)';
  const threads = [thread(1, PAYLOAD), thread(2, 'Work')];
  const plain = build(threads);
  const r = build(threads, { [PAYLOAD]: 'blue', Work: evil, '" data-colour="red': 'green' });
  assert.equal(count(r.html, /<script/gi), count(plain.html, /<script/gi));
  assert.equal(r.html.includes('onclick'), false);
  assert.equal(r.html.includes('<script>alert'), false);
  assert.equal(r.html.includes(evil), false);
  assert.equal(has(r.threads[1], 'colour'), false);
  assert.equal(r.threads[0].colour, 'blue');
  const tag = accountTag(r.html, 1);
  assert.match(tag, /data-colour="blue"/);
  assert.equal(count(tag, /data-colour/g), 1);
  assert.equal(count(r.html, /data-colour/g), 1);
  assert.equal(count(r.html, /data-colour="red"/g), 0);
});

// ------------------------------------------------ CSS

const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
function luminance(hex) {
  const h = hex.length === 3 ? [...hex].map((x) => x + x).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const pair = (vars, c) => [vars[`--mbx-${c}`], vars[`--mbx-${c}-ink`]];
const bare = (v) => String(v).replace(/^#/, '');

test('R164 the contrast helper is right: black on white is 21 and a known grey pair is as published', () => {
  assert.ok(Math.abs(contrast('000000', 'ffffff') - 21) < 1e-9);
  assert.ok(Math.abs(contrast('767676', 'ffffff') - 4.54) < 0.01);
});

for (const c of COLOURS) {
  test(`R164 the theme gives --mbx-${c} and --mbx-${c}-ink as hex and the ink on the fill has contrast of at least 4.5`, () => {
    const [fill, ink] = pair(allVars(), c);
    assert.match(String(fill), HEX, `--mbx-${c} is not a literal hex in themeCss vars`);
    assert.match(String(ink), HEX, `--mbx-${c}-ink is not a literal hex in themeCss vars`);
    const ratio = contrast(bare(fill), bare(ink));
    assert.ok(ratio >= 4.5, `${c}: contrast ${ratio.toFixed(2)} is under 4.5`);
  });

  test(`R164 board.css has a rule for [data-colour="${c}"] using both --mbx-${c} and --mbx-${c}-ink`, () => {
    const rules = [...CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => m[1].includes(`[data-colour="${c}"]`));
    assert.ok(rules.length >= 1, `no rule selects [data-colour="${c}"]`);
    const body = rules.map((m) => m[2]).join(';');
    assert.match(body, new RegExp(`var\\(--mbx-${c}\\)`));
    assert.match(body, new RegExp(`var\\(--mbx-${c}-ink\\)`));
  });
}

test('R164 themeCss vars hold no --mbx- key, so R82\'s pinned list is unchanged', () => {
  const vars = themeCss(resolveTheme(null).theme).vars;
  assert.deepEqual(Object.keys(vars).filter((k) => k.includes('--mbx-')), []);
});

test('R164 a rendered page with no coloured thread holds no --mbx-', () => {
  const { html } = build([thread(1, 'Work'), thread(2)], { Work: 'nope' });
  assert.equal(html.includes('--mbx-'), false);
  assert.equal(build([thread(1, 'Work')]).html.includes('--mbx-'), false);
});

test('R164 a page with one green thread holds --mbx-green and --mbx-green-ink in the nonce style block and no other --mbx- name', () => {
  const { html } = build([thread(1, 'Work'), thread(2, 'Home')], { Work: 'green' });
  const m = html.match(/<style nonce="testnonce">([\s\S]*?)<\/style>/);
  assert.ok(m, 'no nonce style block');
  const names = [...html.matchAll(/--mbx-[a-z-]*/g)].map((x) => x[0]);
  assert.deepEqual([...new Set(names)].sort(), ['--mbx-green', '--mbx-green-ink']);
  assert.match(m[1], /--mbx-green\s*:\s*#[0-9a-fA-F]{3,6}/);
  assert.match(m[1], /--mbx-green-ink\s*:\s*#[0-9a-fA-F]{3,6}/);
  assert.equal(html.replace(m[0], '').includes('--mbx-'), false, '--mbx- outside the nonce style block');
});

test('R164 mailboxVars([green, nope]) gives exactly the two green keys', () => {
  const v = mailboxVars(['green', 'nope']);
  assert.deepEqual(Object.keys(v).sort(), ['--mbx-green', '--mbx-green-ink']);
  assert.deepEqual(mailboxVars([]), {});
});

test('R164 board.css holds no hex colour for the mailbox pairs (R83)', () => {
  assert.equal(/--mbx-[a-z-]+\s*:/.test(CSS), false, 'a --mbx property is defined in board.css');
});

test('R164 no mailbox custom property name holds color, background, fill or stroke (R83 stays green)', () => {
  const names = Object.keys(allVars());
  assert.equal(names.length, 16, 'not sixteen --mbx properties in the theme');
  for (const n of names) assert.equal(/color|background|fill|stroke/.test(n), false, n);
});
