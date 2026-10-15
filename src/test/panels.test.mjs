// Contract R49 to R52: panels that switch on, broken state, caps, staleness. Model side only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { board, raw, settings, state, project, task, idea, resetNumbers } from '../fixtures/build.mjs';

const good = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/state/good/${name}.json`, import.meta.url)), 'utf8'));

const PANELS = ['brief', 'calendar', 'inbox', 'log'];
// NOW is 2026-10-12T06:10:00Z, which is 2026-10-12 08:10 in Europe/Brussels.
const THIRTY_HOURS_BEFORE = '2026-10-11T00:10:00Z';
const TWENTY_THREE_HOURS_BEFORE = '2026-10-11T07:10:00Z';
const ELLIPSIS = '…';

const panel = (b, id) => b.panels?.[id];
const source = (b, id) => b.meta?.sources?.find((s) => s.id === id);

function allFour() {
  return state({ brief: good('brief'), calendar: good('calendar'), inbox: good('inbox'), log: good('log') });
}

// A raw with a real shown project and tasks, so comparisons are not empty against empty.
function realInput() {
  resetNumbers();
  const cfg = settings({
    projects: [{ key: 'house', number: 3 }, { key: 'side', number: 4 }],
    focus: ['house'],
  });
  const r = raw({
    issues: [task({ number: 1, title: 'Paint the hall' }), task({ number: 2, title: 'Fix the tap' }), task({ number: 3, title: 'Plan the garden' })],
    projects: [project(3, 'House', [1, 2]), project(4, 'Side', [3])],
  });
  return { raw: r, settings: cfg };
}

test('R49 all four state keys null gives four null panels and only the github source', () => {
  const b = board({ ...realInput(), state: state() });
  assert.deepEqual(b.panels, { brief: null, calendar: null, inbox: null, log: null });
  assert.deepEqual(b.meta.sources.map((s) => s.id), ['github']);
});

test('R49 all four state keys present gives four panels and five sources', () => {
  const b = board({ ...realInput(), state: allFour() });
  for (const id of PANELS) assert.ok(panel(b, id) && typeof panel(b, id) === 'object', `${id} panel present`);
  for (const id of PANELS) assert.equal(panel(b, id)?.error, undefined, `${id} not an error`);
  assert.equal(b.meta.sources.length, 5);
  assert.deepEqual([...b.meta.sources.map((s) => s.id)].sort(), ['brief', 'calendar', 'github', 'inbox', 'log']);
});

test('R49 one present key switches on only its own panel and source', () => {
  const b = board({ ...realInput(), state: state({ calendar: good('calendar') }) });
  assert.ok(panel(b, 'calendar') && typeof panel(b, 'calendar') === 'object');
  assert.equal(panel(b, 'brief'), null);
  assert.equal(panel(b, 'inbox'), null);
  assert.equal(panel(b, 'log'), null);
  assert.deepEqual([...b.meta.sources.map((s) => s.id)].sort(), ['calendar', 'github']);
});

test('R49 panel content has the documented shape', () => {
  const b = board({ ...realInput(), state: allFour() });
  const f = (id) => good(id);
  // brief generated 06:00+02:00 is 06:00 on the board clock
  assert.deepEqual(panel(b, 'brief'), { stale: false, generated: '06:00', lines: f('brief').lines });
  // NOW is 08:10 in Europe/Brussels
  assert.deepEqual(panel(b, 'calendar'), { stale: false, date: '2026-10-12', now: '08:10', events: f('calendar').events });
  assert.deepEqual(panel(b, 'inbox')?.counts, f('inbox').counts);
  assert.equal(panel(b, 'inbox')?.stale, false);
  assert.deepEqual(panel(b, 'inbox')?.threads, f('inbox').threads);
  assert.deepEqual(panel(b, 'log'), { stale: false, entries: f('log') });
});

test('R50 an unreadable brief and a wrong-shape inbox give error panels and error sources', () => {
  const inbox = { updated: '2026-10-12T07:45:00+02:00', counts: 'many', threads: [] };
  const b = board({ ...realInput(), state: state({ brief: { error: 'unreadable' }, inbox }) });
  assert.deepEqual(panel(b, 'brief'), { error: 'unreadable' });
  assert.deepEqual(panel(b, 'inbox'), { error: 'unreadable' });
  assert.equal(source(b, 'brief')?.state, 'error');
  assert.equal(source(b, 'inbox')?.state, 'error');
  assert.equal(source(b, 'github')?.state, 'ok');
});

test('R50 the rest of the board equals the board built without those state files', () => {
  const input = realInput();
  const plain = board({ ...input, state: state() });
  assert.ok(plain.projects.length === 2 && plain.next.length > 0, 'comparison is not empty against empty');
  const broken = board({
    ...input,
    state: state({ brief: { error: 'unreadable' }, inbox: { updated: 'x', counts: 'many', threads: [] } }),
  });
  assert.deepEqual(broken.projects, plain.projects);
  assert.deepEqual(broken.next, plain.next);
  assert.deepEqual(broken.focus, plain.focus);
  assert.deepEqual(panel(broken, 'brief'), { error: 'unreadable' });
});

test('R50 a wrong-shape calendar and a wrong-shape log are errors too', () => {
  const b = board({
    ...realInput(),
    state: state({ calendar: { date: '2026-10-12', events: 'none' }, log: { not: 'a list' } }),
  });
  assert.deepEqual(panel(b, 'calendar'), { error: 'unreadable' });
  assert.deepEqual(panel(b, 'log'), { error: 'unreadable' });
  assert.equal(source(b, 'calendar')?.state, 'error');
  assert.equal(source(b, 'log')?.state, 'error');
});

test('R50 a brief with the right shape is not an error (twin)', () => {
  const b = board({ ...realInput(), state: state({ brief: good('brief') }) });
  assert.equal(panel(b, 'brief')?.error, undefined);
  assert.ok(Array.isArray(panel(b, 'brief')?.lines));
  assert.equal(source(b, 'brief')?.state, 'ok');
});

test('R51 caps: 8 brief lines, 40 events, 50 threads and 25 log entries give 5, 30, 30 and 10', () => {
  const lines = Array.from({ length: 8 }, (_, i) => ({ src: 'CAL', text: `Line ${i + 1}` }));
  lines[0] = { src: 'CAL', text: 'a'.repeat(300) };
  const events = Array.from({ length: 40 }, (_, i) => ({
    title: `Event ${i + 1}`, start: '09:00', end: '09:30', kind: 'meeting',
  }));
  const threads = Array.from({ length: 50 }, (_, i) => ({
    bucket: 'fyi', from: `Sender ${i + 1}`, subject: `Subject ${i + 1}`, why: 'Because', draft: false,
  }));
  const entries = Array.from({ length: 25 }, (_, i) => ({ t: '06:00', agent: 'brief-agent', what: `Did thing ${i + 1}` }));
  const counts = { reply: 4, decide: 2, fyi: 11 };
  const b = board({
    ...realInput(),
    state: state({
      brief: { generated: '2026-10-12T06:00:00+02:00', lines },
      calendar: { date: '2026-10-12', events },
      inbox: { updated: '2026-10-12T07:45:00+02:00', counts, threads },
      log: entries,
    }),
  });
  assert.equal(panel(b, 'brief')?.lines?.length, 5);
  assert.equal(panel(b, 'calendar')?.events?.length, 30);
  assert.equal(panel(b, 'inbox')?.threads?.length, 30);
  assert.equal(panel(b, 'log')?.entries?.length, 10);
  // the first entries are the kept ones, in file order
  assert.deepEqual(panel(b, 'brief')?.lines?.slice(1), lines.slice(1, 5));
  assert.deepEqual(panel(b, 'calendar')?.events, events.slice(0, 30));
  assert.deepEqual(panel(b, 'inbox')?.threads, threads.slice(0, 30));
  // the log keeps the FIRST 10 entries of the file, the first one unchanged
  assert.deepEqual(panel(b, 'log')?.entries, entries.slice(0, 10));
  assert.deepEqual(panel(b, 'log')?.entries?.[0], entries[0]);
  // the file's counts pass through unchanged
  assert.deepEqual(panel(b, 'inbox')?.counts, counts);
});

test('R51 a 300-character brief line is cut to at most 200 characters ending in one ellipsis', () => {
  const long = 'a'.repeat(300);
  const b = board({
    ...realInput(),
    state: state({ brief: { generated: '2026-10-12T06:00:00+02:00', lines: [{ src: 'CAL', text: long }, { src: 'GH', text: 'Short line' }] } }),
  });
  const cut = panel(b, 'brief')?.lines?.[0]?.text;
  assert.equal(typeof cut, 'string');
  // Both readings of "cut to 200" (199 plus the ellipsis, or 200 total) agree on all of this.
  assert.ok(cut.length <= 200, `length ${cut?.length}`);
  assert.ok(cut.length >= 199, `length ${cut?.length}`);
  assert.ok(cut.endsWith(ELLIPSIS));
  assert.ok(!cut.slice(0, -1).includes(ELLIPSIS));
  assert.equal(cut.slice(0, 198), 'a'.repeat(198));
  // twin: a short line is left exactly as it was
  assert.equal(panel(b, 'brief')?.lines?.[1]?.text, 'Short line');
  assert.equal(panel(b, 'brief')?.lines?.[1]?.src, 'GH');
});

test('R51 a brief line of exactly 200 characters is not cut', () => {
  const exact = 'b'.repeat(200);
  const b = board({
    ...realInput(),
    state: state({ brief: { generated: '2026-10-12T06:00:00+02:00', lines: [{ src: 'CAL', text: exact }] } }),
  });
  assert.equal(panel(b, 'brief')?.lines?.[0]?.text, exact);
});

test('R51 a calendar event with an unknown kind reads as meeting', () => {
  const events = [
    { title: 'Odd one', start: '09:00', end: '09:30', kind: 'party' },
    { title: 'Standup', start: '08:30', end: '08:45', kind: 'meeting' },
  ];
  const b = board({ ...realInput(), state: state({ calendar: { date: '2026-10-12', events } }) });
  const out = panel(b, 'calendar')?.events;
  assert.equal(out?.length, 2);
  assert.deepEqual(out?.[0], { title: 'Odd one', start: '09:00', end: '09:30', kind: 'meeting' });
  assert.deepEqual(out?.[1], events[1]);
});

test('R51 a thread with an unknown bucket is dropped and does not count toward the 30', () => {
  const mk = (i, bucket) => ({ bucket, from: `Sender ${i}`, subject: `Subject ${i}`, why: 'Because', draft: false });
  // 3 unknown first, then 35 valid: 30 valid threads must remain, none unknown
  const threads = [mk('x1', 'spam'), mk('x2', 'spam'), mk('x3', 'later')];
  for (let i = 1; i <= 35; i++) threads.push(mk(i, i % 2 ? 'reply' : 'fyi'));
  const counts = { reply: 1, decide: 0, fyi: 1 };
  const b = board({
    ...realInput(),
    state: state({ inbox: { updated: '2026-10-12T07:45:00+02:00', counts, threads } }),
  });
  const out = panel(b, 'inbox')?.threads;
  assert.equal(out?.length, 30);
  assert.ok(out?.every((t) => ['reply', 'decide', 'fyi'].includes(t.bucket)));
  assert.deepEqual(out, threads.slice(3, 33));
  assert.deepEqual(panel(b, 'inbox')?.counts, counts);
});

test('R51 short lists are kept whole (twin)', () => {
  const b = board({ ...realInput(), state: allFour() });
  assert.equal(panel(b, 'brief')?.lines?.length, good('brief').lines.length);
  assert.equal(panel(b, 'calendar')?.events?.length, good('calendar').events.length);
  assert.equal(panel(b, 'inbox')?.threads?.length, good('inbox').threads.length);
  assert.equal(panel(b, 'log')?.entries?.length, good('log').length);
});

function staleInput(updated, generated, date) {
  resetNumbers();
  const cfg = settings({ projects: [{ key: 'house', number: 3 }, { key: 'side', number: 4 }], focus: ['house'] });
  const r = raw({
    issues: [task({ number: 1, title: 'Paint the hall' }), idea({ number: 41, title: 'Shelves' }), idea({ number: 42, title: 'Lamp' })],
    projects: [project(3, 'House', [1]), project(4, 'Side', [])],
  });
  const proposals = {
    updated,
    focus: { add: ['side'], remove: [], why: 'Two milestones fall due this week' },
    ideas: [
      { number: 41, project: 'house', milestone: null, newProject: null, why: 'Same room' },
      { number: 42, project: 'side', milestone: null, newProject: null, why: 'Fits the side work' },
    ],
  };
  const st = state({
    brief: { generated, lines: [{ src: 'CAL', text: 'One line.' }] },
    calendar: { date, events: [{ title: 'Standup', start: '08:30', end: '08:45', kind: 'meeting' }] },
    inbox: { updated, counts: { reply: 1, decide: 0, fyi: 0 }, threads: [{ bucket: 'reply', from: 'Accountant', subject: 'Q3', why: 'Question', draft: false }] },
    log: [{ t: '06:00', agent: 'brief-agent', what: 'Wrote the brief' }],
    proposals,
  });
  return board({ raw: r, settings: cfg, state: st });
}

const FRESH = '2026-10-12T06:00:00+02:00';
const FRESH_DATE = '2026-10-12';

test('R52 yesterday brief and calendar and 30-hour-old inbox and proposals are stale everywhere', () => {
  const b = staleInput(THIRTY_HOURS_BEFORE, '2026-10-11T06:00:00+02:00', '2026-10-11');
  assert.equal(panel(b, 'brief')?.stale, true);
  assert.equal(panel(b, 'calendar')?.stale, true);
  assert.equal(panel(b, 'inbox')?.stale, true);
  assert.equal(source(b, 'brief')?.state, 'stale');
  assert.equal(source(b, 'calendar')?.state, 'stale');
  assert.equal(source(b, 'inbox')?.state, 'stale');
  assert.ok(b.focus.proposal, 'focus proposal present');
  assert.equal(b.focus.proposal?.stale, true);
  const items = b.ideas.items;
  assert.equal(items.length, 2);
  for (const it of items) {
    assert.ok(it.suggestion, `idea ${it.number} has a suggestion`);
    assert.equal(it.suggestion?.stale, true);
  }
});

test('R52 the log panel is never stale', () => {
  const b = staleInput(THIRTY_HOURS_BEFORE, '2026-10-11T06:00:00+02:00', '2026-10-11');
  assert.equal(panel(b, 'log')?.stale, false);
  assert.equal(source(b, 'log')?.state, 'ok');
});

test('R52 the same files made fresh are stale nowhere (twin)', () => {
  const b = staleInput(FRESH, FRESH, FRESH_DATE);
  for (const id of ['brief', 'calendar', 'inbox', 'log']) {
    assert.equal(panel(b, id)?.stale, false, `${id} fresh`);
    assert.equal(source(b, id)?.state, 'ok', `${id} source ok`);
  }
  assert.ok(b.focus.proposal, 'focus proposal present');
  assert.equal(b.focus.proposal?.stale, false);
  assert.equal(b.ideas.items.length, 2);
  for (const it of b.ideas.items) {
    assert.ok(it.suggestion);
    assert.equal(it.suggestion?.stale, false);
  }
});

test('R52 an inbox and proposals file updated 23 hours before now is not stale', () => {
  const b = staleInput(TWENTY_THREE_HOURS_BEFORE, FRESH, FRESH_DATE);
  assert.equal(panel(b, 'inbox')?.stale, false);
  assert.equal(source(b, 'inbox')?.state, 'ok');
  assert.ok(b.focus.proposal);
  assert.equal(b.focus.proposal?.stale, false);
  assert.ok(b.ideas.items[0]?.suggestion);
  assert.equal(b.ideas.items[0]?.suggestion?.stale, false);
});

test('R52 a stale brief alone does not make a fresh calendar stale', () => {
  const b = staleInput(FRESH, '2026-10-11T06:00:00+02:00', FRESH_DATE);
  assert.equal(panel(b, 'brief')?.stale, true);
  assert.equal(panel(b, 'calendar')?.stale, false);
  assert.equal(source(b, 'calendar')?.state, 'ok');
});
