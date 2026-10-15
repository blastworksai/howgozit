// Writes the sample pages into src/out/ so they can be opened from disk in a browser.
// Usage: node scripts/render-fixture.mjs [--fonts system]

import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { renderPage, renderNotice } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(SRC, 'out');

const readJson = async (rel) => JSON.parse(await readFile(path.join(SRC, rel), 'utf8'));

// The pages are opened from disk, so the two absolute asset references become relative.
export function relativeAssets(html) {
  return html
    .replaceAll('href="/static/board.css"', 'href="static/board.css"')
    .replaceAll('src="/static/board.js"', 'src="static/board.js"');
}

export async function renderFixtures({ fonts } = {}) {
  const theme = (fonts === 'system' ? resolveTheme({ fonts: { source: 'system' } }) : resolveTheme(null)).theme;
  const opts = { styleNonce: 'fixture', formToken: () => 'fixture' };

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

  await mkdir(path.join(OUT, 'static'), { recursive: true });
  const written = [];
  for (const [name, html] of Object.entries(files)) {
    const data = relativeAssets(html);
    await writeFile(path.join(OUT, name), data);
    written.push([`out/${name}`, Buffer.byteLength(data)]);
  }
  for (const name of ['board.css', 'board.js']) {
    const data = await readFile(path.join(SRC, 'board', 'static', name));
    await writeFile(path.join(OUT, 'static', name), data);
    written.push([`out/static/${name}`, data.length]);
  }
  return written;
}

async function main(argv) {
  const i = argv.indexOf('--fonts');
  const fonts = i >= 0 ? argv[i + 1] : undefined;
  for (const [name, size] of await renderFixtures({ fonts })) console.log(`${name} ${size} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  });
}
