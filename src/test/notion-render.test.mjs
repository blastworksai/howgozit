// R88 and R148 on a Notion board: the source tag reads NT where GH stood, and a card links to Notion (and GitHub) only there.
// Written from the rule text (references/contract.md) and reference/mapping-redesign/cp9-interface.md section 0 (decision 7)
// and section 5 (Render), never from the render files. A Notion board is one whose read says source: 'notion'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../board/render/page.mjs';
import { resolveTheme } from '../board/theme.mjs';
import { board, settings, raw, state, task, project, resetNumbers } from '../fixtures/build.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const FULL = JSON.parse(readFileSync(here('../fixtures/board/page.board.json'), 'utf8'));
const THEME = resolveTheme(null).theme;
const OPTS = { styleNonce: 'testnonce', formToken: (action, target) => 'tok-' + action + '-' + target };
const render = (b) => renderPage(b, THEME, OPTS);
const copy = (b) => JSON.parse(JSON.stringify(b));
const count = (s, re) => (s.match(re) || []).length;

function cut(html) {
  const marks = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ name: m[1], start: html.lastIndexOf('<', m.index) }));
  const out = {};
  marks.forEach((m, i) => {
    out[m.name] = html.slice(m.start, i + 1 < marks.length ? marks[i + 1].start : html.length);
  });
  return out;
}
function need(sections, name) {
  assert.ok(typeof sections[name] === 'string', 'section ' + name + ' is missing');
  return sections[name];
}
const hrefs = (html) => [...html.matchAll(/\shref\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
const tags = (html) => [...html.matchAll(/data-src="([^"]*)"/g)].map((m) => m[1]);

const NOTION = 'https://www.notion.so/';
const GOOD = NOTION + '0123456789abcdef0123456789abcdef';
const EVIL = 'https://www.notion.so.evil.example/x';
const GH_URL = 'https://github.com/sam-life/life/issues/4';

// The page-board fixture, read as a Notion board's board: the backend is the first source (meta.sources[0].id).
function notionFixture(agentName = 'Robo') {
  const b = copy(FULL);
  b.meta.sources[0].id = 'notion';
  b.meta.repoUrl = NOTION;
  b.meta.agentName = agentName;
  return b;
}

// A board built from a raw read, github or notion, whose four seats carry the given addresses.
function seatsBoard(source, urls, over = {}) {
  resetNumbers();
  const tasks = urls.map((u, i) => task({ number: i + 1, title: 'Seat ' + (i + 1), html_url: u }));
  return board({
    raw: raw({ issues: tasks, projects: [project(3, 'House', tasks.map((t) => t.number))], ...(source === 'notion' ? { source: 'notion' } : {}) }),
    settings: settings({ projects: [{ key: 'house', number: 3 }], ...over }),
    state: state(),
  });
}

const CARDS = ['next', 'timeline', 'projects', 'habits', 'ideas', 'standalone', 'heatmap'];

test('R88 given a Notion board, NT stands where GH stood on every card that said GH', () => {
  const s = cut(render(notionFixture()));
  for (const sec of CARDS) {
    const html = need(s, sec);
    assert.ok(html.includes('data-src="NT"'), sec + ' has data-src="NT"');
    assert.ok(!html.includes('data-src="GH"'), sec + ' has no data-src="GH"');
  }
});

test('R88 given a Notion board, the other tags are unchanged: the agent name, CAL and MAIL', () => {
  const s = cut(render(notionFixture('Robo')));
  assert.ok(need(s, 'brief').includes('data-src="Robo"'));
  assert.ok(need(s, 'log').includes('data-src="Robo"'));
  assert.ok(need(s, 'calendar').includes('data-src="CAL"'));
  assert.ok(need(s, 'inbox').includes('data-src="MAIL"'));
});

test('R88 given a Notion board, GH appears nowhere as a tag (data-src or its text)', () => {
  const html = render(seatsBoard('notion', [GOOD, GOOD + 'a', GOOD + 'b', GOOD + 'c']));
  assert.ok(!tags(html).includes('GH'), 'no data-src="GH"');
  assert.ok(!/>\s*GH\s*</.test(html), 'no GH as the text of an element');
  assert.ok(tags(html).includes('NT'), 'NT is there');
});

test('R88 given a Notion board built from a Notion read, NT is on the cards', () => {
  const s = cut(render(seatsBoard('notion', [GOOD, GOOD + 'a', GOOD + 'b', GOOD + 'c'])));
  assert.ok(need(s, 'next').includes('data-src="NT"'));
  assert.ok(need(s, 'projects').includes('data-src="NT"'));
});

test('R88 given a GitHub board, GH is still on the cards and NT is nowhere', () => {
  const html = render(seatsBoard('github', [GH_URL, GH_URL + '1', GH_URL + '2', GH_URL + '3']));
  assert.ok(tags(html).includes('GH'));
  assert.ok(!tags(html).includes('NT'));
  assert.ok(!/>\s*NT\s*</.test(html));
  const f = render(copy(FULL));
  assert.equal(count(f, /data-src="NT"/g), 0, 'the fixture page, a GitHub board, has no NT');
});

test('R88 an agent whose name is GH keeps that name on a Notion board; the card tags still read NT', () => {
  const s = cut(render(notionFixture('GH')));
  assert.ok(need(s, 'brief').includes('data-src="GH"'), 'the agent tag is the agent name');
  assert.ok(need(s, 'log').includes('data-src="GH"'));
  assert.ok(need(s, 'next').includes('data-src="NT"'));
  assert.ok(!need(s, 'next').includes('data-src="GH"'));
});

test('R148 given a Notion board, a task url of https://www.notion.so/x gets an href and the .evil.example lookalike gets none', () => {
  const html = render(seatsBoard('notion', [GOOD, EVIL, 'http://www.notion.so/x', 'javascript:alert(1)']));
  const next = need(cut(html), 'next');
  assert.ok(next.includes('Seat 1') && next.includes('Seat 2'), 'the seats are shown');
  const all = hrefs(html);
  assert.ok(all.includes(GOOD), 'the Notion address is a link');
  assert.ok(!all.some((h) => h.includes('evil.example')), 'the lookalike is not a link');
  assert.ok(!all.some((h) => h.startsWith('http://')), 'a plain http address is not a link');
  assert.ok(!all.some((h) => /javascript:/i.test(h)));
  assert.equal(count(html, /\shref\s*=/gi), all.length, 'every href is double-quoted');
});

test('R148 given a GitHub board, a Notion task url gets no href', () => {
  const html = render(seatsBoard('github', [GOOD, GOOD + 'a', GOOD + 'b', GOOD + 'c']));
  const next = need(cut(html), 'next');
  assert.ok(next.includes('Seat 1'), 'the seat is shown');
  assert.ok(!hrefs(html).some((h) => h.startsWith(NOTION)), 'no Notion link on a GitHub board');
  assert.ok(!hrefs(html).some((h) => h.includes('notion.so')));
});

test('R148 given a Notion board, a GitHub address still gets an href (Notion and GitHub are the two allowed starts)', () => {
  const html = render(seatsBoard('notion', [GH_URL, GOOD, 'https://github.com.evil.example/x', 'https://example.com/x']));
  const all = hrefs(html);
  assert.ok(all.includes(GH_URL), 'the GitHub address is a link');
  assert.ok(all.includes(GOOD), 'the Notion address is a link');
  assert.ok(!all.some((h) => h.includes('evil.example')));
  assert.ok(!all.some((h) => h.startsWith('https://example.com')));
});

test('R148 every href of a Notion page is Notion, GitHub, the stylesheet or the font stylesheet', () => {
  const html = render(notionFixture());
  const all = hrefs(html);
  assert.ok(all.length > 0);
  for (const h of all) {
    const ok = h.startsWith(NOTION) || h.startsWith('https://github.com/') || h === '/static/board.css' || h.startsWith('https://fonts.googleapis.com/css2?');
    assert.ok(ok, 'unexpected href ' + h);
  }
});

test('R148 the Notion address prefix is exact: the host must end at the slash', () => {
  const lookalikes = ['https://www.notion.so', 'https://www.notion.sox/x', 'https://notion.so/x', 'https://www.notion.so@evil.example/x'];
  const html = render(seatsBoard('notion', lookalikes));
  const all = hrefs(html);
  for (const l of lookalikes) assert.ok(!all.includes(l), 'no link for ' + l);
});
