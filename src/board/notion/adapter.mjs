// The Notion adapter: the four data sources (Projects, Tasks, Goals, Habit log) behind the back-end-neutral interface (cp9-interface §4; contract R142, R143).
// R155: a settings file with no `projects` list is handed on with the open Projects rows as that list, so the model never knows (R150).
// The seven config files come from the settings folder (BOARD_CONFIG_DIR), as the GitHub adapter's configHttp serves them.
import path from 'node:path';
import { assertAdapter } from '../model/adapter.mjs';
import { createStore, readNotion } from './read.mjs';
import { notionVerbs } from './write.mjs';

const FILES = {
  settings: 'board.config.json',
  theme: 'theme.json',
  brief: 'state/brief.json',
  calendar: 'state/calendar.json',
  inbox: 'state/inbox.json',
  log: 'state/log.json',
  proposals: 'state/proposals.json',
};

async function readText(readFile, configDir, name) {
  try {
    return await readFile(path.join(configDir, name));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export function createNotionAdapter({ http, configDir, readFile }) {
  const store = createStore();
  let settings = null;
  const verbs = notionVerbs({ http, store, settingsOf: () => settings });

  async function read({ full, now } = {}) {
    const names = Object.keys(FILES);
    const got = await Promise.all(names.map((k) => readText(readFile, configDir, FILES[k])));
    const t = Object.fromEntries(names.map((k, i) => [k, got[i]]));
    const texts = {
      settings: t.settings,
      theme: t.theme,
      state: { brief: t.brief, calendar: t.calendar, inbox: t.inbox, log: t.log, proposals: t.proposals },
    };
    let parsed = null;
    if (t.settings !== null) {
      try { parsed = JSON.parse(t.settings); } catch { parsed = null; }
    }
    if (parsed === null) {
      // nothing to read without settings: the loader gives its own notice, and no request is made
      settings = null;
      const raw = {
        fetchedAt: now, partial: { issues: false, items: false }, repo: 'notion', repoPrivate: true, ownerType: 'user',
        source: 'notion', issues: [], milestones: [], projects: [],
      };
      return { raw, texts, warnings: [] };
    }
    settings = parsed;
    const got1 = await readNotion(http, store, { settings: parsed, full: full === true, now });
    // R155: the filled settings are what the writer and the loader see; the file on disk is never written.
    settings = got1.settings;
    if (got1.settings !== parsed) texts.settings = JSON.stringify(got1.settings);
    return { raw: got1.raw, texts, warnings: got1.warnings };
  }

  return assertAdapter({ kind: 'notion', read, ...verbs });
}
