// Writes the sample pages into src/out/ so they can be opened from disk in a browser.
// Usage: node scripts/render-fixture.mjs [--fonts system|google] [--skin <folder>]

import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { renderPage, renderNotice } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { loadSkin } from '../board/skin.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(SRC, 'out');

const readJson = async (rel) => JSON.parse(await readFile(path.join(SRC, rel), 'utf8'));

// The pages are opened from disk, so the two absolute asset references become relative.
export function relativeAssets(html) {
  return html
    .replaceAll('href="/static/board.css"', 'href="static/board.css"')
    .replaceAll('src="/static/board.js"', 'src="static/board.js"')
    .replaceAll('href="/skin/skin.css"', 'href="skin/skin.css"');
}

export async function renderFixtures({ fonts, skin: skinDir, out = OUT } = {}) {
  // --skin: the folder goes through the board's own loader, so a file the board would refuse is never copied.
  let skin = null;
  if (skinDir !== undefined) {
    skin = loadSkin(skinDir);
    if (!skin.loaded) throw new Error('The skin folder could not be read, so no pages were written.');
  }
  if (fonts !== undefined && fonts !== 'system' && fonts !== 'google') throw new Error('--fonts must be system or google.');
  const theme = (fonts === undefined ? resolveTheme(null) : resolveTheme({ fonts: { source: fonts } })).theme;
  const opts = skin ? { styleNonce: 'fixture', formToken: () => 'fixture', skin: true } : { styleNonce: 'fixture', formToken: () => 'fixture' };

  const page = await readJson('fixtures/board/page.board.json');
  const min = await readJson('fixtures/board/page-min.board.json');

  const stale = structuredClone(page);
  stale.meta.stale = { since: '2026-10-12T05:00:00Z', reason: 'GitHub did not answer' };
  for (const s of stale.meta.sources || []) if (s.id === 'github') s.state = 'stale';

  const readOnly = structuredClone(page);
  readOnly.meta.readOnly = true;

  const files = {
    'page.html': renderPage(page, theme, opts),
    'page-min.html': renderPage(min, theme, opts),
    'page-stale.html': renderPage(stale, theme, opts),
    'page-readonly.html': renderPage(readOnly, theme, opts),
    'notice.html': renderNotice({
      title: 'Board not set up yet',
      message: 'No settings file was found in the data repo. Run the setup step first.',
      status: 503,
    }),
  };
  if (skin) {
    // A Notion board's page, the one other look a skin has to wear.
    const notion = structuredClone(page);
    notion.meta.sources[0].id = 'notion';
    files['page-notion.html'] = renderPage(notion, theme, opts);
    files['notice-skin.html'] = renderNotice({
      title: 'Board not set up yet',
      message: 'No settings file was found in the data repo. Run the setup step first.',
      status: 503,
    }, { styleNonce: 'fixture', skin: true });
  }

  // The only deletions this script makes, all inside the chosen out folder: the folder `skin/` (the copy of an earlier
  // run, so a file the loader now rejects cannot render from an old copy) and, without --skin, the two skinned pages.
  // rm never follows a link, so a link named skin/ is removed as a link and its target is left alone.
  await rm(path.join(out, 'skin'), { recursive: true, force: true });
  if (!skin) {
    for (const stale of ['page-notion.html', 'notice-skin.html']) await rm(path.join(out, stale), { force: true });
  }
  await mkdir(path.join(out, 'static'), { recursive: true });
  const written = [];
  for (const [name, html] of Object.entries(files)) {
    const data = relativeAssets(html);
    await writeFile(path.join(out, name), data);
    written.push([`out/${name}`, Buffer.byteLength(data)]);
  }
  if (skin) {
    // Keys are /skin/skin.css, /skin/fonts/<name>, /skin/img/<name>: the same relative places the pages name.
    for (const [key, f] of skin.files) {
      const rel = key.slice(1);
      await mkdir(path.dirname(path.join(out, rel)), { recursive: true });
      await writeFile(path.join(out, rel), f.body);
      written.push([`out/${rel}`, f.body.length]);
    }
  }
  for (const name of ['board.css', 'board.js']) {
    const data = await readFile(path.join(SRC, 'board', 'static', name));
    await writeFile(path.join(out, 'static', name), data);
    written.push([`out/static/${name}`, data.length]);
  }
  return written;
}

async function main(argv) {
  const i = argv.indexOf('--fonts');
  const fonts = i >= 0 ? argv[i + 1] ?? '' : undefined;
  const k = argv.indexOf('--skin');
  const skin = k >= 0 ? argv[k + 1] : undefined;
  if (k >= 0 && (skin === undefined || skin.startsWith('--'))) throw new Error('--skin needs a folder.');
  for (const [name, size] of await renderFixtures({ fonts, skin })) console.log(`${name} ${size} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  });
}
