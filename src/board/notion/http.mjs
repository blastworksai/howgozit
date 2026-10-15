import { BackendError, codeOfStatus } from '../model/adapter.mjs';

export const API_BASE = 'https://api.notion.com';
export const NOTION_VERSION = '2026-03-11';

const MAX_RETRIES = 3;
const MAX_WAIT_SECONDS = 10;
const TIMEOUT_MS = 10000;

// One fixed sentence per closed code (cp9-interface §5). Nothing from a response or a request ever goes in.
const MESSAGES = {
  auth: 'Notion did not accept the token.',
  'not-found': 'Notion could not find that data source or page; check the ids in the settings and what the token can see.',
  conflict: 'Notion refused the change because the page changed at the same time.',
  'rate-limited': 'Notion is limiting requests right now; try again in a minute.',
  unavailable: 'Notion could not be reached.',
  invalid: 'Notion did not accept that request.',
};

function fail(code, status) {
  return new BackendError(code, status, MESSAGES[code]);
}

// A whole number of seconds from 1 to 10, else null (a missing, odd or larger value is not waited for).
function waitOf(res) {
  let raw = null;
  try { raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null; } catch { raw = null; }
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw.trim())) return null;
  const s = Number(raw.trim());
  return s >= 1 && s <= MAX_WAIT_SECONDS ? s : null;
}

export function createNotionHttp({ token, fetch: fetchFn = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let tail = Promise.resolve();

  async function run(method, path, body) {
    if (typeof path !== 'string' || !path.startsWith('/v1/') || path.includes('..') || /[\\\s]/.test(path)) {
      throw fail('invalid', null);
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    };
    const init = { method, headers, redirect: 'manual' };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    for (let retries = 0; ; retries += 1) {
      let res;
      try {
        res = await fetchFn(API_BASE + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw fail('unavailable', null);
      }
      const status = res && res.status;
      if (status === 429) {
        const seconds = waitOf(res);
        if (seconds === null || retries >= MAX_RETRIES) throw fail('rate-limited', 429);
        await sleep(seconds * 1000);
        continue;
      }
      if (!(status >= 200 && status < 300)) throw fail(codeOfStatus(status), Number.isInteger(status) ? status : null);
      try {
        return await res.json();
      } catch {
        throw fail('unavailable', status);
      }
    }
  }

  // One request at a time: each call queues behind the last, whether the last succeeded or failed.
  function request(method, path, body) {
    const result = tail.then(() => run(method, path, body));
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return { request };
}
