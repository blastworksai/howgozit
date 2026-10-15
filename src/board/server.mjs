// The HTTP server (R65, R77 to R81). Routes on the path part only, never joins a request path to a folder.
// `console`, `process.env` and `Date.now` appear only in the start-up code at the bottom of the file.

import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnv } from './env.mjs';
import { createCache } from './cache.mjs';
import { createOwnerHttp } from './github/owners.mjs';
import { createIssue, patchIssue, addProjectItem, getIssue, getRepo, listComments, addComment, transferIssue, deleteProjectItem, setItemNumber, listIssuesIn, listProjectIssues } from './github/write.mjs';
import { createLoader } from './load.mjs';
import { createCalendarSource } from './calendar/icloud.mjs';
import { createGoogleSource } from './calendar/google.mjs';
import { createGuard } from './guard.mjs';
import { createHandlers, securityHeaders } from './handlers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const MAX_BODY = 16 * 1024;
const ACTIONS = { '/actions/idea': 'idea', '/actions/habit': 'habit', '/actions/sort': 'sort', '/actions/close': 'close', '/actions/score': 'score' };
const STATIC_NAMES = {
  '/static/board.css': { file: 'board.css', type: 'text/css; charset=utf-8' },
  '/static/board.js': { file: 'board.js', type: 'text/javascript; charset=utf-8' },
};
const FAILURE = 'Something went wrong on the board, so nothing was changed.';

function loadStaticFiles() {
  const out = {};
  for (const [url, { file, type }] of Object.entries(STATIC_NAMES)) {
    out[url] = { type, body: readFileSync(path.join(HERE, 'static', file)) };
  }
  return out;
}

function send(res, status, headers, body) {
  const buf = Buffer.from(body ?? '', 'utf8');
  res.writeHead(status, { ...headers, 'content-length': String(buf.length) });
  res.end(buf);
}

function plain(res, status, text, extra = {}) {
  send(res, status, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8', ...extra }, text);
}

class TooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new TooLarge('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function parseForm(text) {
  const form = {};
  for (const [k, v] of new URLSearchParams(text)) {
    if (!Object.prototype.hasOwnProperty.call(form, k)) form[k] = v;
  }
  return form;
}

export function createApp({ handlers, guard, log = () => {}, staticFiles } = {}) {
  let files = staticFiles || null;
  const getFiles = () => (files ??= loadStaticFiles());

  async function route(req, res) {
    const method = req.method || 'GET';
    const full = req.url || '/';
    const q = full.indexOf('?');
    const p = q === -1 ? full : full.slice(0, q);
    const reqInfo = { method, url: full, headers: req.headers || {} };

    if (p === '/healthz' && method === 'GET') {
      plain(res, 200, 'ok');
      return;
    }
    if (!guard.hostOk(reqInfo)) {
      send(res, 421, { ...securityHeaders() }, '');
      return;
    }
    if (!guard.proxyOk(reqInfo) || !guard.identityOk(reqInfo)) {
      plain(res, 401, 'Sign in through the login in front of this board.');
      return;
    }

    if (p === '/') {
      if (method !== 'GET') return plain(res, 405, 'That method is not allowed here.', { allow: 'GET' });
      const out = await handlers.page(reqInfo);
      return send(res, out.status, out.headers, out.body);
    }
    if (p === '/healthz') return plain(res, 405, 'That method is not allowed here.', { allow: 'GET' });

    if (Object.prototype.hasOwnProperty.call(STATIC_NAMES, p)) {
      if (method !== 'GET') return plain(res, 405, 'That method is not allowed here.', { allow: 'GET' });
      const f = getFiles()[p];
      if (!f) return plain(res, 404, 'Not found.');
      return send(res, 200, { ...securityHeaders(), 'content-type': f.type }, f.body);
    }

    if (Object.prototype.hasOwnProperty.call(ACTIONS, p)) {
      if (method !== 'POST') return plain(res, 405, 'That method is not allowed here.', { allow: 'POST' });
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/x-www-form-urlencoded') {
        req.resume();
        return plain(res, 400, 'The form must be sent as application/x-www-form-urlencoded.');
      }
      let text;
      try {
        text = await readBody(req);
      } catch (err) {
        if (err instanceof TooLarge) {
          res.setHeader('connection', 'close');
          plain(res, 413, 'That request is too large.');
          req.resume();
          return;
        }
        throw err;
      }
      const out = await handlers.action(ACTIONS[p], reqInfo, parseForm(text));
      return send(res, out.status, out.headers, out.body);
    }

    return plain(res, 404, 'Not found.');
  }

  return async (req, res) => {
    const method = req.method || 'GET';
    const full = req.url || '/';
    const q = full.indexOf('?');
    const shown = q === -1 ? full : full.slice(0, q);
    try {
      await route(req, res);
    } catch {
      try {
        if (!res.headersSent) plain(res, 500, FAILURE);
        else res.end();
      } catch {
        // the connection is gone; nothing more to do
      }
    }
    try {
      log(`${method} ${shown} ${res.statusCode}`);
    } catch {
      // a failing log never breaks a request
    }
  };
}

export async function start({ processEnv, fetch = globalThis.fetch, clock = { now: () => Date.now() }, log = () => {} } = {}) {
  const src = processEnv && typeof processEnv === 'object' ? processEnv : {};
  // Port 0 (any free port) is allowed here for tests; readEnv itself wants 1 to 65535.
  const rawPort = [src.BOARD_PORT, src.PORT].map((v) => (typeof v === 'string' ? v.trim() : '')).find((v) => v !== '');
  const anyPort = rawPort === '0';
  const parsed = readEnv(anyPort ? { ...src, BOARD_PORT: '1' } : src);
  if (!parsed.ok) throw new Error(parsed.message);
  const env = { ...parsed.env };
  if (anyPort) env.port = 0;
  env.dataDir = path.resolve(SRC, env.dataDir);

  // R131: each ignored token pair is said once, by name only.
  for (const line of env.startWarnings ?? []) {
    try { log(line); } catch { /* a failing log never stops the start */ }
  }

  const staticFiles = loadStaticFiles();
  let app = (req, res) => plain(res, 503, 'The board is starting.');
  const server = http.createServer((req, res) => app(req, res));
  server.requestTimeout = 30000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.port, env.host, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((err) => {
    throw new Error(`The board could not listen on ${env.host}:${env.port}${err && err.code ? ` (${err.code})` : ''}.`);
  });

  const addr = server.address();
  const port = addr.port;
  if (anyPort && !String(src.BOARD_ALLOWED_HOSTS || '').trim()) {
    env.allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  }
  env.port = port;

  const cache = createCache(env.dataDir);
  const calendar = env.icloud ? createCalendarSource({ fetch, login: env.icloud }) : null;
  const googleCalendar = createGoogleSource({ fetch, addresses: env.googleIcal ?? {} });
  let loader;
  let guard;
  let handlers;
  if (env.backend === 'notion') {
    // CP9: a Notion board has no GitHub client; the adapter is both the loader's reader and the action verbs.
    // Loaded here, so a GitHub board never touches a Notion module.
    const { createNotionHttp } = await import('./notion/http.mjs');
    const { createNotionAdapter } = await import('./notion/adapter.mjs');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const notionHttp = createNotionHttp({ token: env.notionToken, fetch, sleep });
    const adapter = createNotionAdapter({ http: notionHttp, configDir: env.configDir, readFile: (p) => fsReadFile(p, 'utf8') });
    loader = createLoader({ env, cache, clock, calendar, googleCalendar, adapter });
    guard = createGuard({ token: env.token, formKey: env.formKey, allowedHosts: env.allowedHosts, identityHeader: env.identityHeader, proxySecret: env.proxySecret, clock });
    handlers = createHandlers({ loader, gh: null, guard, env, clock, verbsFor: () => adapter });
  } else {
    const owners = createOwnerHttp({ defaultToken: env.token, tokens: env.githubTokens, fetch, etags: cache.etags });
    const client = owners.default;
    loader = createLoader({ http: client, httpFor: owners.forOwner, env, cache, clock, calendar, googleCalendar });
    guard = createGuard({ token: env.token, formKey: env.formKey, allowedHosts: env.allowedHosts, identityHeader: env.identityHeader, proxySecret: env.proxySecret, clock });
    // The data repo's own writes keep the default client; any other owner gets that owner's client.
    const dataOwner = String(env.repo).split('/')[0].toLowerCase();
    const forLogin = (login) => (typeof login !== 'string' || login === '' || login.toLowerCase() === dataOwner ? client : owners.forOwner(login));
    const forRepo = (repo) => owners.forOwner(String(repo).split('/')[0]);
    const gh = {
      createIssue: (x) => createIssue(client, env.repo, x),
      patchIssue: (n, patch) => patchIssue(client, env.repo, n, patch),
      patchIssueIn: (repo, n, patch) => patchIssue(owners.forOwner(repo.split('/')[0]), repo, n, patch),
      listIssuesIn: (repo, o) => listIssuesIn(owners.forOwner(repo.split('/')[0]), repo, o),
      listProjectIssues: (x) => listProjectIssues(forLogin(x.owner), x),
      createIssueIn: (repo, x) => createIssue(forRepo(repo), repo, x),
      getIssueIn: (repo, n) => getIssue(forRepo(repo), repo, n),
      getRepo: (repo) => getRepo(forRepo(repo), repo),
      transferIssue: (x) => transferIssue(forLogin(x && x.owner), x),
      listComments: (repo, n) => listComments(forRepo(repo), repo, n),
      addComment: (repo, n, body) => addComment(forRepo(repo), repo, n, body),
      addProjectItem: (x) => addProjectItem(forLogin(x.owner), { ...x, repo: x.repo ?? env.repo }),
      deleteProjectItem: (x) => deleteProjectItem(forLogin(x.owner), x),
      setItemNumber: (x) => setItemNumber(forLogin(x.owner), x),
    };
    handlers = createHandlers({ loader, gh, guard, env, clock });
  }
  app = createApp({ handlers, guard, log, staticFiles });

  // R65: the daily full read needs no outside scheduler.
  const timer = setInterval(() => {
    try {
      if (loader.fullDue()) loader.load().catch(() => {});
    } catch {
      // the next tick tries again
    }
  }, 60000);
  timer.unref();

  const address = { address: addr.address, family: addr.family, port, host: env.host };

  function close() {
    clearInterval(timer);
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }

  return { server, address, close };
}

// Run directly: node board/server.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start({ processEnv: process.env, log: (line) => console.log(line) }).then(
    (s) => {
      console.log(`Board running at http://${s.address.host}:${s.address.port}`);
    },
    (err) => {
      console.error(err && err.message ? err.message : 'The board could not start.');
      process.exitCode = 1;
    },
  );
}
