// R161: where the Glitch feed writes. A local folder (atomic temp + rename) or the board's repo
// through the GitHub contents API. The token is only ever put in a request header; it is never
// returned, printed or thrown, and error text from the transport is never passed on.
import path from 'node:path';

const INBOX = 'state/inbox.json';
const LOG = 'state/log.json';
const LOG_KEEP = 30;
const NAMED = "the board's repo changed during the write; the next run catches up";
const UNREACHABLE = "the board's repo could not be written; the next run tries again";

export function targetFrom(env = {}) {
  if (env.BOARD_CONFIG_DIR) return { kind: 'local', dir: env.BOARD_CONFIG_DIR };
  if (env.BOARD_REPO && env.BOARD_GITHUB_TOKEN) return { kind: 'github', repo: env.BOARD_REPO, token: env.BOARD_GITHUB_TOKEN };
  return null;
}

const logText = (entries) => JSON.stringify(entries, null, 2) + '\n';
const withEntry = (old, entry) => [entry, ...(Array.isArray(old) ? old : [])].slice(0, LOG_KEEP);
const parseList = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

async function readIfThere(fs, file) {
  try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}
async function atomic(fs, file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

async function writeLocal(target, { inboxText, entry }, fs) {
  const dir = path.join(target.dir, 'state');
  const inboxFile = path.join(dir, 'inbox.json');
  const logFile = path.join(dir, 'log.json');
  if ((await readIfThere(fs, inboxFile)) === inboxText) return { wrote: false, line: 'inbox unchanged' };
  await fs.mkdir(dir, { recursive: true });
  const old = await readIfThere(fs, logFile);
  await atomic(fs, inboxFile, inboxText);
  await atomic(fs, logFile, logText(withEntry(old === null ? [] : parseList(old), entry)));
  return { wrote: true, line: 'inbox written' };
}

class Conflict extends Error {}
class Failed extends Error {}
class Late extends Error {}
const LATE = 'GitHub did not answer in time; the next run catches up.';

// Settles with `work`, or rejects with Late when the signal fires first (even if the transport ignores it).
function bound(work, signal) {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Late());
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, (e) => (signal.aborted ? stop() : reject(e)));
  });
}

function api(target, apiBase, fetch, signal) {
  const headers = { Authorization: `Bearer ${target.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'howgozit-feed' };
  const url = (file) => `${apiBase}/repos/${target.repo}/contents/${file}`;
  return {
    async get(file) {
      const res = await bound(fetch(url(file), { method: 'GET', headers, signal }), signal);
      if (res.status === 404) return null;
      if (!res.ok) throw new Failed();
      const j = await bound(res.json(), signal);
      return { text: Buffer.from(String(j.content || ''), 'base64').toString('utf8'), sha: j.sha };
    },
    async put(file, text, message, sha) {
      const body = { message, content: Buffer.from(text, 'utf8').toString('base64') };
      if (sha) body.sha = sha;
      const res = await bound(fetch(url(file), { method: 'PUT', headers, body: JSON.stringify(body), signal }), signal);
      if (res.status === 409 || res.status === 422) throw new Conflict();
      if (!res.ok) throw new Failed();
    },
  };
}

async function writeGithub(target, { inboxText, entry }, fetch, apiBase, deadline) {
  const signal = typeof deadline === 'number' ? AbortSignal.timeout(Math.max(0, deadline - Date.now())) : undefined;
  const gh = api(target, apiBase, fetch, signal);
  let wrote = false;
  try {
    const cur = await gh.get(INBOX);
    if (cur && cur.text === inboxText) return { wrote: false, line: 'inbox unchanged' };
    await gh.put(INBOX, inboxText, 'Glitch feed: inbox', cur ? cur.sha : undefined);
    wrote = true;
    const log = await gh.get(LOG);
    await gh.put(LOG, logText(withEntry(log ? parseList(log.text) : [], entry)), 'Glitch feed: log', log ? log.sha : undefined);
    return { wrote: true, line: 'inbox written' };
  } catch (e) {
    if (e instanceof Conflict) return { wrote, line: NAMED };
    if (e instanceof Late || (signal && signal.aborted)) return { wrote, line: LATE };
    return { wrote, line: UNREACHABLE };
  }
}

export async function writeState(target, body, { fetch, fs, apiBase = 'https://api.github.com', deadline } = {}) {
  if (!target) return { wrote: false, line: 'no place to write the feed is set' };
  if (target.kind === 'local') return writeLocal(target, body, fs);
  return writeGithub(target, body, fetch, apiBase, deadline);
}
