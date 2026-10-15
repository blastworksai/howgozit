import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../board/guard.mjs';

const SECRET = 'SENTINEL-TOKEN-123';
const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);
const HOUR = 3600 * 1000;

function make(over = {}) {
  const clock = { t: T0, now() { return this.t; } };
  const guard = createGuard({
    token: SECRET,
    allowedHosts: ['board.example'],
    identityHeader: null,
    clock,
    ...over,
  });
  return { guard, clock };
}

const req = (headers = {}) => ({ method: 'POST', url: '/actions/idea', headers: { host: 'board.example', ...headers } });

test('R55 a same-site post with its own token is accepted', () => {
  const { guard } = make();
  const t = guard.formToken('idea', 'new');
  assert.deepEqual(guard.checkPost(req({ origin: 'https://board.example' }), 'idea', 'new', t), { ok: true });
});

test('R55 a cross-site Origin is refused', () => {
  const { guard } = make();
  const t = guard.formToken('idea', 'new');
  const r = guard.checkPost(req({ origin: 'https://evil.example' }), 'idea', 'new', t);
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, 'string');
});

test('R55 Sec-Fetch-Site cross-site is refused', () => {
  const { guard } = make();
  const t = guard.formToken('idea', 'new');
  assert.equal(guard.checkPost(req({ 'sec-fetch-site': 'cross-site' }), 'idea', 'new', t).ok, false);
  assert.equal(guard.checkPost(req({ 'sec-fetch-site': 'same-site' }), 'idea', 'new', t).ok, false);
});

test('R55 a missing token is refused', () => {
  const { guard } = make();
  assert.equal(guard.checkPost(req(), 'idea', 'new', undefined).ok, false);
  assert.equal(guard.checkPost(req(), 'idea', 'new', '').ok, false);
});

test('R55 a token signed for another target is refused', () => {
  const { guard } = make();
  const t = guard.formToken('close', '12');
  assert.equal(guard.checkPost(req(), 'close', '12', t).ok, true);
  assert.equal(guard.checkPost(req(), 'close', '13', t).ok, false);
});

test('R55 a token signed for another action is refused', () => {
  const { guard } = make();
  const t = guard.formToken('close', '12');
  assert.equal(guard.checkPost(req(), 'sort', '12', t).ok, false);
});

test('R55 a token 13 hours old is refused and one 11 hours 59 minutes old is accepted', () => {
  const { guard, clock } = make();
  const t = guard.formToken('idea', 'new');
  clock.t = T0 + 11 * HOUR + 59 * 60 * 1000;
  assert.equal(guard.checkPost(req(), 'idea', 'new', t).ok, true);
  clock.t = T0 + 13 * HOUR;
  assert.equal(guard.checkPost(req(), 'idea', 'new', t).ok, false);
});

test('R55 a token issued by one guard survives a restart and is refused under another GitHub token', () => {
  const a = make();
  const t = a.guard.formToken('habit', 'h1:2026-10-13:on');
  const b = make();
  assert.equal(b.guard.checkPost(req(), 'habit', 'h1:2026-10-13:on', t).ok, true);
  const c = make({ token: 'another-token' });
  assert.equal(c.guard.checkPost(req(), 'habit', 'h1:2026-10-13:on', t).ok, false);
});

test('R55 remember then remembered is true and an unknown token is false', () => {
  const { guard } = make();
  const t = guard.formToken('idea', 'new');
  assert.equal(guard.remembered(t), false);
  guard.remember(t);
  assert.equal(guard.remembered(t), true);
  assert.equal(guard.remembered(guard.formToken('idea', 'new')), false);
});

test('U two tokens for the same action and target differ', () => {
  const { guard } = make();
  assert.notEqual(guard.formToken('idea', 'new'), guard.formToken('idea', 'new'));
});

test('U a token holds neither the GitHub token nor the target text', () => {
  const { guard } = make();
  const target = 'h1:2026-10-13:on';
  const t = guard.formToken('habit', target);
  assert.equal(t.includes(SECRET), false);
  assert.equal(t.includes(target), false);
  assert.equal(t.split('.').length, 3);
  const r = guard.checkPost(req({ origin: 'https://evil.example' }), 'habit', target, t);
  assert.equal(JSON.stringify(r).includes(SECRET), false);
  assert.equal(JSON.stringify(r).includes(t), false);
});

test('U the returned object does not expose the GitHub token', () => {
  const { guard } = make();
  assert.deepEqual(Object.keys(guard).sort(), ['checkPost', 'formToken', 'hostOk', 'identityOk', 'proxyOk', 'remember', 'remembered']);
  assert.equal(JSON.stringify(guard).includes(SECRET), false);
});

test('U same-origin Origin and Sec-Fetch-Site same-origin or none pass', () => {
  const { guard } = make();
  const t = guard.formToken('idea', 'new');
  assert.equal(guard.checkPost(req({ origin: 'http://board.example' }), 'idea', 'new', t).ok, true);
  assert.equal(guard.checkPost(req({ 'sec-fetch-site': 'same-origin' }), 'idea', 'new', t).ok, true);
  assert.equal(guard.checkPost(req({ 'sec-fetch-site': 'none' }), 'idea', 'new', t).ok, true);
});

test('U no Origin at all passes', () => {
  const { guard } = make();
  const t = guard.formToken('idea', 'new');
  assert.equal(guard.checkPost(req(), 'idea', 'new', t).ok, true);
});

test('U a malformed Origin is refused', () => {
  const { guard } = make();
  const t = guard.formToken('idea', 'new');
  for (const o of ['null', 'not a url', '', 'board.example']) {
    assert.equal(guard.checkPost(req({ origin: o }), 'idea', 'new', t).ok, false, o);
  }
});

test('U odd token values never throw', () => {
  const { guard } = make();
  const odd = [undefined, null, 42, {}, [], '', 'x', 'a.b', 'a.b.c.d', 'zz!.nonce.mac', '..', 'a.b.', 'ÿ.ÿ.ÿ', '1.2.3'];
  for (const v of odd) {
    const r = guard.checkPost(req(), 'idea', 'new', v);
    assert.equal(r.ok, false);
    assert.equal(guard.remembered(v), false);
    guard.remember(v);
  }
  assert.equal(guard.checkPost({}, 'idea', 'new', 'a.b.c').ok, false);
  assert.equal(guard.checkPost(undefined, 'idea', 'new', 'a.b.c').ok, false);
});

test('U a token with a non-base-36 time is refused', () => {
  const { guard } = make();
  const t = guard.formToken('idea', 'new');
  const [, nonce, mac] = t.split('.');
  assert.equal(guard.checkPost(req(), 'idea', 'new', `!!.${nonce}.${mac}`).ok, false);
});

test('U a token up to a minute from the future is accepted, further is refused', () => {
  const a = make();
  const t = a.guard.formToken('idea', 'new');
  const b = make();
  b.clock.t = T0 - 30 * 1000;
  assert.equal(b.guard.checkPost(req(), 'idea', 'new', t).ok, true);
  b.clock.t = T0 - 5 * 60 * 1000;
  assert.equal(b.guard.checkPost(req(), 'idea', 'new', t).ok, false);
});

test('U remembered entries older than 12 hours are dropped', () => {
  const { guard, clock } = make();
  guard.remember('old');
  clock.t = T0 + 11 * HOUR;
  assert.equal(guard.remembered('old'), true);
  clock.t = T0 + 12 * HOUR + 1000;
  guard.remember('new');
  assert.equal(guard.remembered('old'), false);
  assert.equal(guard.remembered('new'), true);
});

test('U at most 5000 remembered entries are kept', () => {
  const { guard } = make();
  for (let i = 0; i < 5100; i++) guard.remember(`t${i}`);
  assert.equal(guard.remembered('t0'), false);
  assert.equal(guard.remembered('t99'), false);
  assert.equal(guard.remembered('t100'), true);
  assert.equal(guard.remembered('t5099'), true);
});

test('R78 hostOk accepts an allowed host', () => {
  const { guard } = make();
  assert.equal(guard.hostOk({ headers: { host: 'board.example' } }), true);
});

test('R78 hostOk refuses a foreign host', () => {
  const { guard } = make();
  assert.equal(guard.hostOk({ headers: { host: 'evil.example' } }), false);
});

test('R78 hostOk ignores case', () => {
  const { guard } = make();
  assert.equal(guard.hostOk({ headers: { host: 'BOARD.Example' } }), true);
});

test('R78 hostOk refuses a missing header', () => {
  const { guard } = make();
  assert.equal(guard.hostOk({ headers: {} }), false);
  assert.equal(guard.hostOk({}), false);
});

test('R79 identityOk is true when no header is configured', () => {
  const { guard } = make();
  assert.equal(guard.identityOk({ headers: {} }), true);
});

test('R79 identityOk is true when the configured header is present', () => {
  const { guard } = make({ identityHeader: 'x-user' });
  assert.equal(guard.identityOk({ headers: { 'x-user': 'someone' } }), true);
});

test('R79 identityOk is false when the configured header is absent', () => {
  const { guard } = make({ identityHeader: 'x-user' });
  assert.equal(guard.identityOk({ headers: {} }), false);
});

test('R79 identityOk is false when the configured header is empty', () => {
  const { guard } = make({ identityHeader: 'x-user' });
  assert.equal(guard.identityOk({ headers: { 'x-user': '' } }), false);
});
