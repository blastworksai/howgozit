// The feed's own settings (R163): feed.config.json in the board's config folder. Never written to the data repo.
import { join, isAbsolute, win32, posix } from 'node:path';

export const CONFIG_FILE = 'feed.config.json';

const bad = (sentence) => ({ ok: false, sentence });
const absolute = (p) => typeof p === 'string' && p !== '' && (isAbsolute(p) || win32.isAbsolute(p) || posix.isAbsolute(p));

export async function readFeedConfig(dir, { fs }) {
  const path = join(dir, CONFIG_FILE);
  let text;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (e) {
    return bad(e && e.code === 'ENOENT'
      ? `The feed settings file ${CONFIG_FILE} was not found in ${dir}.`
      : `The feed settings file ${CONFIG_FILE} in ${dir} could not be read.`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return bad(`The feed settings file ${CONFIG_FILE} is not valid JSON.`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return bad(`${CONFIG_FILE} must hold one JSON object.`);
  const { mailboxes, frequency, glitch } = json;
  if (Array.isArray(mailboxes) && mailboxes.some((m) => typeof m === 'string' && /@|:\/\/|[\u0000-\u001f\u007f-\u009f]/.test(m))) {
    return bad(`${CONFIG_FILE}: a mailbox label may not hold an address, a link or a control character; use the label Glitch shows.`);
  }
  if (!Array.isArray(mailboxes) || mailboxes.length < 1 || mailboxes.length > 10
    || !mailboxes.every((m) => typeof m === 'string' && m.trim() !== '')) {
    return bad(`${CONFIG_FILE}: "mailboxes" must be a list of 1 to 10 Glitch mailbox labels.`);
  }
  if (frequency !== 'morning' && frequency !== 'hourly') return bad(`${CONFIG_FILE}: "frequency" must be "morning" or "hourly".`);
  if (!absolute(glitch)) return bad(`${CONFIG_FILE}: "glitch" must be the absolute path to the Glitch folder.`);
  return { ok: true, config: { mailboxes: [...mailboxes], frequency, glitch } };
}

export const ENV_FILE = 'feed.env';
const ENV_KEYS = ['BOARD_REPO', 'BOARD_GITHUB_TOKEN', 'BOARD_CONFIG_DIR'];

// Reads feed.env beside the config: KEY=VALUE lines, # comments, blank lines ignored; only the three board keys are taken.
// A variable already in `env` wins. The result is for targetFrom only, never for a spawned process.
export async function readFeedEnv(dir, { fs, env = {}, platform = process.platform }) {
  const path = join(dir, ENV_FILE);
  let text;
  try {
    if (platform !== 'win32' && typeof fs.stat === 'function') {
      const st = await fs.stat(path);
      if ((st.mode & 0o077) !== 0) return { ok: false, sentence: `${ENV_FILE} can be read by other people on this machine; run chmod 600 on ${path} and try again.` };
    }
    text = await fs.readFile(path, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, env: { ...env } };
    return { ok: false, sentence: `${ENV_FILE} could not be read; check it with chmod 600 and try again.` };
  }
  const merged = { ...env };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    if (!ENV_KEYS.includes(key)) continue;
    if (merged[key] !== undefined && merged[key] !== '') continue;
    merged[key] = line.slice(i + 1).trim();
  }
  return { ok: true, env: merged };
}
