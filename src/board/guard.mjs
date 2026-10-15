import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const HOUR_MS = 3600 * 1000;
const MAX_AGE_MS = 12 * HOUR_MS;
const FUTURE_MS = 60 * 1000;
const MAX_REMEMBERED = 5000;

function header(req, name) {
  const h = req && req.headers;
  if (!h || typeof h !== 'object') return undefined;
  const v = h[name];
  return typeof v === 'string' ? v : undefined;
}

export function createGuard({ token, formKey, allowedHosts, identityHeader, proxySecret, clock }) {
  const hosts = new Set((allowedHosts || []).map((h) => String(h).toLowerCase()));
  const identity = identityHeader ? String(identityHeader).toLowerCase() : null;
  // R130: the board's own key when set, else the token-derived key exactly as before; never a fixed or empty key.
  let key;
  if (typeof formKey === 'string' && formKey !== '') {
    key = createHmac('sha256', formKey).update('board own form key v1').digest();
  } else if (typeof token === 'string' && token !== '') {
    key = createHmac('sha256', String(token)).update('board form key v1').digest();
  } else {
    throw new Error('The board has no key to sign its forms with.');
  }
  const seen = new Map();

  function mac(action, target, issued, nonce) {
    return createHmac('sha256', key)
      .update(`${action}\n${String(target)}\n${issued}\n${nonce}`)
      .digest('base64url');
  }

  function hostOk(req) {
    const host = header(req, 'host');
    if (host === undefined) return false;
    return hosts.has(host.toLowerCase());
  }

  function identityOk(req) {
    if (identity === null) return true;
    const v = header(req, identity);
    return v !== undefined && v !== '';
  }

  // R107: shared secret from the proxy; compared as SHA-256 digests in constant time, never throws.
  const wantDigest = typeof proxySecret === 'string' && proxySecret !== ''
    ? createHash('sha256').update(proxySecret).digest()
    : null;

  function proxyOk(req) {
    if (wantDigest === null) return true;
    const v = header(req, 'x-board-proxy-secret');
    if (v === undefined) return false;
    return timingSafeEqual(createHash('sha256').update(v).digest(), wantDigest);
  }

  function formToken(action, target) {
    const issued = Math.floor(clock.now() / 1000).toString(36);
    const nonce = randomBytes(8).toString('base64url');
    return `${issued}.${nonce}.${mac(action, target, issued, nonce)}`;
  }

  function checkPost(req, action, target, tokenValue) {
    const host = header(req, 'host');
    const origin = header(req, 'origin');
    if (origin !== undefined) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { originHost = null; }
      if (originHost === null || host === undefined || originHost.toLowerCase() !== host.toLowerCase()) {
        return { ok: false, reason: 'The request came from another site' };
      }
    }
    const site = header(req, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return { ok: false, reason: 'The request came from another site' };
    }
    if (typeof tokenValue !== 'string' || tokenValue === '') {
      return { ok: false, reason: 'The form token is missing' };
    }
    const parts = tokenValue.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'The form token is not valid' };
    const [issued, nonce, given] = parts;
    if (!/^[0-9a-z]+$/.test(issued)) return { ok: false, reason: 'The form token is not valid' };
    const want = Buffer.from(mac(action, target, issued, nonce));
    const got = Buffer.from(given);
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      return { ok: false, reason: 'The form token does not match this form' };
    }
    const age = clock.now() - parseInt(issued, 36) * 1000;
    if (!(age >= -FUTURE_MS && age <= MAX_AGE_MS)) {
      return { ok: false, reason: 'The form token has expired, reload the page' };
    }
    return { ok: true };
  }

  function prune() {
    const cutoff = clock.now() - MAX_AGE_MS;
    for (const [t, at] of seen) {
      if (at < cutoff) seen.delete(t);
      else break;
    }
    while (seen.size > MAX_REMEMBERED) seen.delete(seen.keys().next().value);
  }

  function remember(tokenValue) {
    if (typeof tokenValue !== 'string') return;
    seen.delete(tokenValue);
    seen.set(tokenValue, clock.now());
    prune();
  }

  function remembered(tokenValue) {
    if (typeof tokenValue !== 'string') return false;
    prune();
    return seen.has(tokenValue);
  }

  return { hostOk, proxyOk, identityOk, formToken, checkPost, remember, remembered };
}
