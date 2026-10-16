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
  if (!Array.isArray(mailboxes) || mailboxes.length < 1 || mailboxes.length > 10
    || !mailboxes.every((m) => typeof m === 'string' && m.trim() !== '')) {
    return bad(`${CONFIG_FILE}: "mailboxes" must be a list of 1 to 10 Glitch mailbox labels.`);
  }
  if (frequency !== 'morning' && frequency !== 'hourly') return bad(`${CONFIG_FILE}: "frequency" must be "morning" or "hourly".`);
  if (!absolute(glitch)) return bad(`${CONFIG_FILE}: "glitch" must be the absolute path to the Glitch folder.`);
  return { ok: true, config: { mailboxes: [...mailboxes], frequency, glitch } };
}
