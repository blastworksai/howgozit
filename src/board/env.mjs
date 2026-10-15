// Environment reader. Pure: reads only the object it is given, never process.env itself.
// Returns { ok: true, env } or { ok: false, message }; message is one plain sentence and never holds the token.

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODES = ['local', 'proxy', 'hosted'];
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function pick(src, name) {
  const v = src[name];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function fail(message) {
  return { ok: false, message };
}

// The optional iCloud sign-in: both variables or neither. The message names both and holds neither value.
export function readIcloud(src) {
  const s = src && typeof src === 'object' ? src : {};
  const user = pick(s, 'BOARD_ICLOUD_USER');
  const password = pick(s, 'BOARD_ICLOUD_APP_PASSWORD');
  if (user && password) return { ok: true, icloud: { user, password } };
  if (!user && !password) return { ok: true, icloud: null };
  return fail('Set BOARD_ICLOUD_USER and BOARD_ICLOUD_APP_PASSWORD together, or neither of them.');
}

// R119: the optional Google calendar addresses, BOARD_GOOGLE_ICAL_1 to _5, by place. Values are trimmed and passed on
// as written (the test of R120 is made at the request). Nothing else of the family is read. Treat the result like the token.
export function readGoogleIcal(src) {
  const s = src && typeof src === 'object' ? src : {};
  const out = {};
  let any = false;
  for (let n = 1; n <= 5; n++) {
    const v = pick(s, `BOARD_GOOGLE_ICAL_${n}`);
    if (v) { out[n] = v; any = true; }
  }
  return any ? out : null;
}

// R131: BOARD_GITHUB_TOKEN_<n> with BOARD_GITHUB_OWNER_<n> (n 1 to 5), in n order. A half pair, a bad login or an owner
// already served is ignored with a sentence that names the variable and never holds a value.
function readGithubTokens(src) {
  const tokens = [];
  const warnings = [];
  const served = new Set();
  for (let n = 1; n <= 5; n++) {
    const token = pick(src, `BOARD_GITHUB_TOKEN_${n}`);
    const owner = pick(src, `BOARD_GITHUB_OWNER_${n}`);
    if (!token && !owner) continue;
    if (token && !owner) { warnings.push(`BOARD_GITHUB_TOKEN_${n} is set without BOARD_GITHUB_OWNER_${n}, so it is ignored.`); continue; }
    if (owner && !token) { warnings.push(`BOARD_GITHUB_OWNER_${n} is set without BOARD_GITHUB_TOKEN_${n}, so it is ignored.`); continue; }
    if (!OWNER_RE.test(owner)) { warnings.push(`BOARD_GITHUB_OWNER_${n} is not a GitHub login, so its token is ignored.`); continue; }
    if (served.has(owner.toLowerCase())) { warnings.push(`BOARD_GITHUB_OWNER_${n} names an owner that already has a token, so it is ignored.`); continue; }
    served.add(owner.toLowerCase());
    tokens.push({ owner, token });
  }
  return { tokens, warnings };
}

export function readEnv(processEnv) {
  const src = processEnv && typeof processEnv === 'object' ? processEnv : {};

  // R142: the back-end choice; the Notion back-end arrives in a later version.
  const backend = pick(src, 'BOARD_BACKEND') ?? 'github';
  // R130: read raw like the proxy secret; unset or empty is no key, anything else must be a real one.
  const rawFormKey = typeof src.BOARD_FORM_KEY === 'string' ? src.BOARD_FORM_KEY : '';
  if (rawFormKey !== '' && (rawFormKey.length < 32 || /\s/.test(rawFormKey))) {
    return fail('BOARD_FORM_KEY must be at least 32 characters long and hold no spaces or line breaks.');
  }
  const formKey = rawFormKey === '' ? null : rawFormKey;

  if (backend === 'notion' && formKey === null) {
    return fail('Set BOARD_FORM_KEY to a key of at least 32 characters, because a Notion board has no GitHub token to sign its forms with.');
  }
  if (backend !== 'github' && backend !== 'notion') return fail('BOARD_BACKEND must be github or notion.');

  // R143, R151: a Notion board (four data sources) needs its own token and its settings folder; GitHub tokens and BOARD_REPO are ignored there.
  let token = null;
  let repo = 'notion';
  let notionToken = null;
  if (backend === 'notion') {
    notionToken = pick(src, 'BOARD_NOTION_TOKEN');
    if (!notionToken) return fail('Set BOARD_NOTION_TOKEN to a Notion token that can read your four data sources.');
    if (!pick(src, 'BOARD_CONFIG_DIR')) return fail('Set BOARD_CONFIG_DIR to the folder that holds board.config.json, because a Notion board keeps its settings on this machine.');
  } else {
    token = pick(src, 'BOARD_GITHUB_TOKEN');
    if (!token) return fail('Set BOARD_GITHUB_TOKEN to a GitHub token that can read your data repository.');

    repo = pick(src, 'BOARD_REPO');
    if (!repo) return fail('Set BOARD_REPO to your data repository, written as owner/name.');
    if (!REPO_RE.test(repo)) return fail('BOARD_REPO must be written as owner/name, for example "me/my-board-data".');
  }

  const mode = pick(src, 'BOARD_MODE') ?? 'local';
  if (!MODES.includes(mode)) return fail('BOARD_MODE must be one of local, proxy or hosted.');

  const host = pick(src, 'BOARD_HOST') ?? (mode === 'local' ? '127.0.0.1' : '0.0.0.0');

  const rawPort = pick(src, 'BOARD_PORT') ?? pick(src, 'PORT') ?? '8787';
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail('BOARD_PORT (or PORT) must be a whole number from 1 to 65535.');
  }

  const rawHosts = pick(src, 'BOARD_ALLOWED_HOSTS');
  const listed = rawHosts ? rawHosts.split(',').map((h) => h.trim()).filter(Boolean) : [];
  const allowedHosts = listed.length ? listed : [`localhost:${port}`, `127.0.0.1:${port}`];

  const header = pick(src, 'BOARD_IDENTITY_HEADER');
  const identityHeader = header ? header.toLowerCase() : null;
  if (mode !== 'local' && !identityHeader) {
    return fail('Set BOARD_IDENTITY_HEADER to the header your login sets on every request, because the board will not start open outside local mode.');
  }

  // R107: read raw, never trimmed; whitespace-only or padded values are refused, not read as unset.
  const rawSecret = typeof src.BOARD_PROXY_SECRET === 'string' ? src.BOARD_PROXY_SECRET : '';
  if (rawSecret !== '' && (rawSecret.length < 32 || /\s/.test(rawSecret))) {
    return fail('BOARD_PROXY_SECRET must be at least 32 characters long and hold no spaces or line breaks.');
  }
  const proxySecret = rawSecret === '' ? null : rawSecret;

  const ic = readIcloud(src);
  if (!ic.ok) return ic;

  const gh = backend === 'notion' ? { tokens: [], warnings: [] } : readGithubTokens(src);

  const env = {
    token,
    repo,
    mode,
    host,
    port,
    allowedHosts,
    identityHeader,
    proxySecret,
    dataDir: pick(src, 'BOARD_DATA_DIR') ?? '.board-data',
    readOnly: src.BOARD_READ_ONLY === '1',
    configDir: pick(src, 'BOARD_CONFIG_DIR'),
    icloud: ic.icloud,
    googleIcal: readGoogleIcal(src),
    githubTokens: gh.tokens,
    formKey,
    startWarnings: gh.warnings,
  };
  // The GitHub env object gains no key (the off-path law); only a Notion board carries these two.
  if (backend === 'notion') {
    env.backend = 'notion';
    env.notionToken = notionToken;
  }
  return { ok: true, env };
}
