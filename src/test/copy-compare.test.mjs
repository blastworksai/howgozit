// R153 review fixes C6 (verify must see a copied idea still showing as an idea) and C7 (compare-boards compares structured lists).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/copy-to-notion.mjs';
import { compareBoards } from '../scripts/compare-boards.mjs';
import { createCopyWorld } from '../fixtures/copy-world.mjs';

function makeClock() {
  let t = Date.parse('2026-10-15T12:00:00Z');
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

async function withApplied(fn) {
  const w = await createCopyWorld();
  const dir = await mkdtemp(join(tmpdir(), 'copy-compare-'));
  await writeFile(join(dir, 'ids.json'), JSON.stringify(w.notionIds));
  const lines = [];
  const clock = makeClock();
  const run = async (cmd, extra = []) => {
    lines.length = 0;
    return main([cmd, '--notion', 'ids.json', '--out', 'o', ...extra], {
      env: w.env, fetch: w.fetch, cwd: dir, clock, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`),
    });
  };
  try {
    assert.equal(await run('plan'), 0, lines.join('\n'));
    assert.equal(await run('apply', ['--confirm']), 0, lines.join('\n'));
    const plan = JSON.parse(await readFile(join(dir, 'o', 'plan.json'), 'utf8'));
    const rec = JSON.parse(await readFile(join(dir, 'o', 'copy-record.json'), 'utf8'));
    const idea = plan.ideas[0];
    const patch = async (props) => {
      const res = await w.notion.fetch(`https://api.notion.com/v1/pages/${rec.rows[idea.key].pageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${w.env.BOARD_NOTION_TOKEN}`, 'Notion-Version': '2026-03-11', 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: props }),
      });
      assert.equal(res.status, 200, await res.text());
    };
    const projectPage = rec.rows[plan.projects[0].key].pageId;
    return await fn({ w, run, lines, idea, patch, projectPage });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('R153 verify passes an untouched copied idea', async () => {
  await withApplied(async ({ run, lines }) => {
    assert.equal(await run('verify'), 0, lines.join('\n'));
  });
});

test('R153 verify fails a copied idea that was given a Project, naming the idea and no token', async () => {
  await withApplied(async ({ w, run, lines, idea, patch, projectPage }) => {
    await patch({ Project: { relation: [{ id: projectPage }] } });
    assert.equal(await run('verify'), 1, lines.join('\n'));
    const text = lines.join('\n');
    assert.ok(text.includes(idea.key), text);
    assert.ok(!text.includes(w.env.BOARD_NOTION_TOKEN));
  });
});

test('R153 verify fails a copied idea whose Status moved to the Complete group', async () => {
  await withApplied(async ({ run, lines, idea, patch }) => {
    await patch({ Status: { status: { name: 'Done' } } });
    assert.equal(await run('verify'), 1, lines.join('\n'));
    assert.ok(lines.join('\n').includes(idea.key), lines.join('\n'));
  });
});

const board = (over = {}) => ({
  projects: [], next: [], ideas: { items: [] }, habits: [],
  timeline: { lanes: [{ milestones: [{ shortTitle: 'G', pct: 10 }], undated: [] }], other: [] },
  ...over,
});

test('R153 compare keeps ["A","B"] and ["A | B"] apart for What is next, ideas and goals', () => {
  const t = (...xs) => xs.map((title) => ({ title }));
  const r = compareBoards(board({ next: t('A', 'B') }), board({ next: t('A | B') }));
  assert.ok(r.differ.some((d) => d.item === 'next'), JSON.stringify(r));
  const i = compareBoards(board({ ideas: { items: t('A', 'B') } }), board({ ideas: { items: t('A | B') } }));
  assert.ok(i.differ.some((d) => d.item === 'ideas'), JSON.stringify(i));
  const m = (shortTitle) => ({ shortTitle, pct: 5 });
  const g = compareBoards(board({ timeline: { lanes: [{ milestones: [m('A'), m('B')], undated: [] }], other: [] } }),
    board({ timeline: { lanes: [{ milestones: [m('A / 5% | B')], undated: [] }], other: [] } }));
  // genuine collision under the old joined-string form: goal 'A / 5% | B' at 5% and goals 'A' + 'B' at 5% both joined to 'A / 5% | B / 5%'
  assert.ok(g.differ.some((d) => d.item === 'goals'), JSON.stringify(g));
});

test('R153 compare reports the differing element, orders What is next, ignores goal and idea order', () => {
  const t = (...xs) => xs.map((title) => ({ title }));
  const r = compareBoards(board({ next: t('A', 'B') }), board({ next: t('B', 'A') }));
  assert.ok(r.differ.some((d) => d.item === 'next'));
  const s = compareBoards(board({ next: t('A', 'B'), ideas: { items: t('X', 'Y') } }), board({ next: t('A', 'B'), ideas: { items: t('Y', 'X') } }));
  assert.ok(s.same.includes('next') && s.same.includes('ideas'), JSON.stringify(s));
  const u = compareBoards(board({ next: t('A', 'B') }), board({ next: t('A', 'C') }));
  const d = u.differ.find((x) => x.item === 'next');
  assert.deepEqual(d.github, ['A', 'B']);
  assert.deepEqual(d.notion, ['A', 'C']);
  assert.ok(u.expected.length > 0);
});

test('R153 compare: the same goals in different lanes are not the same; the move is reported as ruled', () => {
  const m = (shortTitle) => ({ shortTitle, pct: 5 });
  const gh = board({ timeline: { lanes: [], other: [m('A'), m('B')] } });
  const nt = board({ timeline: { lanes: [{ project: { key: 'garden' }, milestones: [m('A')], undated: [m('B')] }], other: [] } });
  const r = compareBoards(gh, nt);
  assert.ok(!r.same.includes('goal-placement'));
  assert.equal(r.ruled.length, 1, JSON.stringify(r));
  assert.equal(r.ruled[0].count, 2);
  assert.deepEqual(r.ruled[0].onlyGithub, ['A / 5% @ other', 'B / 5% @ other']);
  assert.deepEqual(r.ruled[0].onlyNotion, ['A / 5% @ garden', 'B / 5% @ garden']);
  assert.deepEqual(r.differ.filter((d) => d.item === 'goals'), []);
  const same = compareBoards(gh, gh);
  assert.deepEqual(same.ruled, []);
});

test('R153 compare: a goal missing entirely is a real difference, not a ruled one', () => {
  const m = (shortTitle) => ({ shortTitle, pct: 5 });
  const gh = board({ timeline: { lanes: [], other: [m('A'), m('B')] } });
  const nt = board({ timeline: { lanes: [{ project: { key: 'garden' }, milestones: [m('A')], undated: [] }], other: [] } });
  const r = compareBoards(gh, nt);
  assert.ok(r.differ.some((d) => d.item === 'goals' && d.onlyGithub.includes('B / 5%')), JSON.stringify(r));
  assert.ok(r.ruled.every((x) => !JSON.stringify(x).includes('B / 5%')), JSON.stringify(r.ruled));
});
