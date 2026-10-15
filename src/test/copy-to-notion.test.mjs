// CP3: the GitHub -> Notion copier (contract R153), written from reference/notion-native/interface.md section 6 and the copy world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/copy-to-notion.mjs';
import { createCopyWorld, unknownStatusWorld, twinCardsWorld } from '../fixtures/copy-world.mjs';
import { createFakeNotion } from '../fixtures/fake-notion.mjs';
import { seedHowgozit } from '../fixtures/notion-howgozit.mjs';
import { createNotionHttp } from '../board/notion/http.mjs';
import { createNotionAdapter } from '../board/notion/adapter.mjs';
import { copyDigest } from '../scripts/lib/copy-plan.mjs';
import { runCopy, emptyCopyRecord } from '../scripts/lib/copy-apply.mjs';

// A clock that stands at noon on 15 Oct and moves forward only when something sleeps, so the pacer never waits for real.
function makeClock() {
  let t = Date.parse('2026-10-15T12:00:00Z');
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}
const GH = 'https://api.github.com';
const GH_SEEN = [];   // every GitHub request any test made, recorded where the world's fetch is called
const LEAKS = [];     // any token found in an output line or a written file
const WRITES = [];    // the count of files read back for the sweep
const NO_CONFIRM = 'Apply writes to Notion, so it needs --confirm; nothing was written.';

// Every secret in the env: the values of the TOKEN variables (the owner and repo names are not secrets).
const tokensOf = (env) => Object.entries(env).filter(([k]) => /TOKEN/.test(k)).map(([, v]) => v);

async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await filesUnder(p)); else out.push(p);
  }
  return out;
}

async function withSession(fn, { unknown = false, twins = false } = {}) {
  const w = unknown ? await unknownStatusWorld() : twins ? await twinCardsWorld() : await createCopyWorld();
  const dir = await mkdtemp(join(tmpdir(), 'copy-to-notion-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'ids.json'), JSON.stringify(w.notionIds));
  const lines = [];
  const clock = makeClock();
  const s = { w, dir, lines, inner: w.fetch };
  s.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (url.startsWith(GH)) GH_SEEN.push({ method: String(init.method || 'GET').toUpperCase(), url });
    return s.inner(input, init);
  };
  s.run = async (cmd, extra = []) => {
    lines.length = 0;
    const code = await main([cmd, '--notion', 'ids.json', '--out', 'o', ...extra], {
      env: w.env, fetch: s.fetch, cwd: dir, clock, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`),
    });
    for (const l of lines) for (const t of tokensOf(w.env)) if (String(l).includes(t)) LEAKS.push(`line: ${l}`);
    return code;
  };
  s.read = async (rel) => readFile(join(dir, 'o', rel), 'utf8');
  s.json = async (rel) => JSON.parse(await s.read(rel));
  s.pagePosts = () => w.notion.calls.filter((c) => c.method === 'POST' && c.path === '/v1/pages').length;
  s.titles = async (ds, prop) => {
    const res = await w.notion.fetch(`https://api.notion.com/v1/data_sources/${ds}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${w.env.BOARD_NOTION_TOKEN}`, 'Notion-Version': '2026-03-11', 'Content-Type': 'application/json' }, body: JSON.stringify({ page_size: 100 }),
    });
    const j = await res.json();
    return (j.results || []).map((p) => ({ title: p.properties[prop].title.map((t) => t.plain_text ?? t.text?.content).join(''), number: p.properties.ID?.unique_id?.number, props: p.properties }));
  };
  s.allTitles = async () => {
    const ids = w.notionIds;
    return [
      ...(await s.titles(ids.projects, 'Project name')).map((x) => `P:${x.title}`),
      ...(await s.titles(ids.goals, 'Goal name')).map((x) => `G:${x.title}`),
      ...(await s.titles(ids.tasks, 'Task name')).map((x) => `T:${x.title}`),
      ...(await s.titles(ids.habitLog, 'Name')).map((x) => `H:${x.title}`),
    ];
  };
  try {
    return await fn(s);
  } finally {
    try {
      for (const f of await filesUnder(dir)) {
        const text = await readFile(f, 'utf8');
        WRITES.push(f);
        for (const t of tokensOf(w.env)) if (text.includes(t)) LEAKS.push(`file: ${f}`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

test('R153 plan prints its counts line and saves a plan.json with a digest', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0, s.lines.join('\n'));
    assert.ok(s.lines.includes('Copy plan: 4 projects, 5 goals, 6 cards, 1 blocker, 1 idea, 5 check-ins.'), s.lines.join('\n'));
    const plan = await s.json('plan.json');
    assert.match(plan.digest, /^[0-9a-f]{64}$/);
    assert.ok(s.lines.some((l) => l === `Plan digest ${plan.digest.slice(0, 12)}.`), s.lines.join('\n'));
    assert.equal(s.pagePosts(), 0);
  });
});

test('R153 plan keeps the goal of a card whose home repo is its project, and gives a milestone with no copied card no project', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    const plan = await s.json('plan.json');
    const task = (title) => plan.tasks.find((t) => t.title === title);
    assert.equal(task('Sand the bench').goalKey, 'goal:brightcraft/woodshop#2');
    assert.deepEqual(plan.goals.find((g) => g.key === 'goal:brightcraft/woodshop#2').projectKeys, ['project:woodshop', 'project:carpentry']);
    assert.equal(task('Set the type').goalKey, 'goal:inkPress/press#1');
    assert.equal(task('Oil the saw').goalKey, null);
    const tour = plan.goals.find((g) => g.title === 'Shop tour');
    assert.deepEqual(tour.projectKeys, []);
    assert.ok(plan.notes.some((n) => n.includes('Shop tour') && n.includes('without a project')), plan.notes.join('\n'));
    assert.ok(s.lines.some((l) => l.startsWith('Note: Goal "Shop tour"')), s.lines.join('\n'));
  });
});

test('R153 plan gives a data-repo "<Project> · <goal>" milestone that project and drops the prefix', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    const plan = await s.json('plan.json');
    const g = plan.goals.find((x) => x.key === 'goal:Elmwood/howgozit#1');
    assert.equal(g.title, 'First beds');
    assert.deepEqual(g.projectKeys, ['project:garden']);
    assert.ok(!plan.goals.some((x) => x.title.includes('Road to a garden')));
  });
});

test('R153 plan leaves a closed card out and tags a card with both modes in a fixed order', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    const plan = await s.json('plan.json');
    assert.ok(!plan.tasks.some((t) => t.title === 'Old chore'));
    assert.ok(!JSON.stringify(plan).includes('Old chore'));
    assert.deepEqual(plan.tasks.find((t) => t.title === 'Plan the beds').tags, ['DO', 'THINK']);
  });
});

test('R153 plan copies every check-in, including those older than 120 days, with done and score', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    const plan = await s.json('plan.json');
    const by = (title) => plan.checkins.find((c) => c.title === title);
    assert.equal(plan.checkins.length, 5);
    assert.ok(by('Mood · 2026-05-01'), 'older than 120 days is copied');
    assert.ok(by('Walk · 2026-05-02'));
    const same = by('Mood · 2026-10-01');
    assert.equal(same.done, true, 'closed on the day it is for');
    assert.equal(same.score, 7);
    assert.equal(by('Walk · 2026-09-30').done, false, 'closed on a later day');
    assert.equal(by('Mood · 2026-10-14').done, false);
    assert.equal(by('Mood · 2026-10-14').score, null);
  });
});

test('R153 apply then verify passes and writes the Notion board settings, theme and state', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    assert.equal(await s.run('apply', ['--confirm']), 0, s.lines.join('\n'));
    assert.equal(s.pagePosts(), 21);
    assert.equal(await s.run('verify'), 0, s.lines.join('\n'));
    const v = await s.json('copy-verify.json');
    assert.equal(v.pass, true);
    const cfg = await s.json('config/board.config.json');
    const projects = await s.titles(s.w.notionIds.projects, 'Project name');
    const idOf = (title) => projects.find((p) => p.title === title).number;
    const want = { garden: 'Road to a garden', woodshop: 'Woodshop', carpentry: 'Carpentry', press: 'Press' };
    assert.deepEqual(cfg.projects.map((p) => p.key), ['garden', 'woodshop', 'carpentry', 'press']);
    for (const p of cfg.projects) {
      assert.equal(p.owner, 'notion');
      assert.equal(p.number, idOf(want[p.key]));
      assert.ok(!('home' in p), `${p.key} has no home`);
    }
    assert.deepEqual(cfg.ideas, { owner: 'notion', number: 998 });
    assert.deepEqual(cfg.habitsProject, { owner: 'notion', number: 999 });
    assert.equal(await s.read('config/theme.json'), '{"radius":8,"accent":"#1d76db"}\n');
    assert.equal(await s.read('config/state/log.json'), '{"entries":[{"at":"2026-10-01","text":"first note"}]}\n');
  });
});

test('R153 a second apply creates no page', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    assert.equal(await s.run('apply', ['--confirm']), 0);
    const before = s.pagePosts();
    assert.equal(before, 21);
    assert.equal(await s.run('apply', ['--confirm']), 0, s.lines.join('\n'));
    assert.equal(s.pagePosts(), before);
    assert.equal((await s.allTitles()).length, 21);
  });
});

test('R153 a crash after the third Notion write then a resume leaves no duplicate title in any table', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    let n = 0;
    s.w.notion.fail((c) => c.method === 'POST' && c.path === '/v1/pages' && (n += 1) === 3, new Error('connection lost'));
    assert.equal(await s.run('apply', ['--confirm']), 1);
    assert.equal((await s.allTitles()).length, 2, 'two pages landed before the crash');
    assert.equal(await s.run('apply', ['--confirm']), 0, s.lines.join('\n'));
    const titles = await s.allTitles();
    assert.equal(titles.length, 21);
    assert.equal(new Set(titles).size, titles.length, titles.join('\n'));
    assert.equal(await s.run('verify'), 0, s.lines.join('\n'));
  });
});

test('R153 a pending row whose page landed before the crash is adopted, not created again', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    let n = 0;
    s.inner = async (input, init = {}) => { // the eighth page lands in Notion, then the answer is lost
      const hit = String(init.method || 'GET').toUpperCase() === 'POST' && String(input).endsWith('/v1/pages');
      const res = await s.w.fetch(input, init);
      if (hit && (n += 1) === 8) throw new TypeError('fetch failed');
      return res;
    };
    assert.equal(await s.run('apply', ['--confirm']), 1);
    const rec = await s.json('copy-record.json');
    assert.ok(Object.values(rec.rows).some((r) => r.state === 'pending'), 'the lost answer left a pending row');
    s.inner = s.w.fetch;
    assert.equal(await s.run('apply', ['--confirm']), 0, s.lines.join('\n'));
    const titles = await s.allTitles();
    assert.equal(titles.length, 21);
    assert.equal(new Set(titles).size, titles.length, titles.join('\n'));
    assert.equal(s.pagePosts(), 21, 'the landed page was adopted, so 21 creates in all');
    assert.equal(await s.run('verify'), 0, s.lines.join('\n'));
  });
});

test('R153 apply refuses a plan whose GitHub data has changed since and writes nothing', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    s.w.github.Elmwood.direct.request('PATCH', '/repos/Elmwood/howgozit/issues/1', { title: 'Plan the beds again' });
    assert.equal(await s.run('apply', ['--confirm']), 1);
    assert.ok(s.lines.includes('ERR GitHub changed after the plan was made; run plan again.'), s.lines.join('\n'));
    assert.equal(s.w.notion.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/query')).length, 0);
    assert.equal(await exists(join(s.dir, 'o', 'copy-record.json')), false);
    assert.equal(await exists(join(s.dir, 'o', 'config')), false);
  });
});

test('R153 a card with a status Notion has no match for refuses the plan and names the status', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 1);
    assert.ok(s.lines.some((l) => l.startsWith('ERR ') && l.includes('Blocked')), s.lines.join('\n'));
    assert.equal(await exists(join(s.dir, 'o', 'plan.json')), false);
    assert.equal(await s.run('apply', ['--confirm']), 1);
    assert.equal(s.pagePosts(), 0);
  }, { unknown: true });
});

test('R153 apply without --confirm writes nothing', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    const before = s.w.notion.calls.length;
    assert.equal(await s.run('apply'), 1);
    assert.deepEqual(s.lines, [`ERR ${NO_CONFIRM}`]);
    assert.equal(s.w.notion.calls.length, before);
    assert.equal(await exists(join(s.dir, 'o', 'copy-record.json')), false);
  });
});

test('R153 the copier refuses to send GitHub anything but a read, whatever asks', async () => {
  await withSession(async (s) => {
    const { guardGithubFetch } = await import('../scripts/copy-to-notion.mjs');
    let reached = 0;
    const g = guardGithubFetch(async () => { reached += 1; return new Response('{}'); });
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assert.throws(() => g(`${GH}/repos/a/b/issues`, { method }), /nothing but reads/);
    }
    assert.equal(reached, 0);
    await g(`${GH}/repos/a/b/issues`, { method: 'GET' });
    await g('https://api.notion.com/v1/pages', { method: 'POST' });
    assert.equal(reached, 2);
  });
});

// ---------- review findings C1-C5 ----------

test('R153 the board config the copier writes opens the real Notion board with every copied project and its goals', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    assert.equal(await s.run('apply', ['--confirm']), 0, s.lines.join('\n'));
    const cfg = await s.json('config/board.config.json');
    assert.deepEqual(cfg.notion, s.w.notionIds, 'the four data source ids are in the config');
    const http = createNotionHttp({ token: s.w.env.BOARD_NOTION_TOKEN, fetch: s.w.notion.fetch, sleep: async () => {} });
    const configDir = join(s.dir, 'o', 'config');
    const adapter = createNotionAdapter({ http, configDir, readFile: (p) => readFile(p, 'utf8') });
    const { raw, warnings } = await adapter.read({ full: true, now: '2026-10-15T12:00:00Z' });
    assert.deepEqual(warnings, []);
    const listed = raw.projects.filter((p) => p.role === undefined).map((p) => p.title).sort();
    assert.deepEqual(listed, ['Carpentry', 'Press', 'Road to a garden', 'Woodshop']);
    const goals = raw.milestones.map((m) => m.title).sort();
    assert.deepEqual(goals, ['Press · First print', 'Road to a garden · First beds', 'Road to a garden · Someday', 'Shop tour', 'Woodshop · Bench']);
    const garden = raw.projects.find((p) => p.title === 'Road to a garden');
    assert.equal(garden.items.length, 3, 'the garden cards sit on the board');
  });
});

test('R153 two cards with the same title, Project and Goal each get their own page when a resume finds one already copied', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    const plan = await s.json('plan.json');
    const twins = plan.tasks.filter((t) => t.title === 'Plan the beds');
    assert.equal(twins.length, 2);
    const all = plan.projects.length + plan.goals.length + plan.tasks.length + plan.ideas.length + plan.checkins.length;
    let n = 0;
    const at = plan.projects.length + plan.goals.length + plan.tasks.findIndex((t) => t.key === twins[1].key) + 1;
    s.w.notion.fail((c) => c.method === 'POST' && c.path === '/v1/pages' && (n += 1) === at, new Error('connection lost'));
    assert.equal(await s.run('apply', ['--confirm']), 1);
    const rec = await s.json('copy-record.json');
    assert.equal(rec.rows[twins[0].key].state, 'done');
    assert.equal(rec.rows[twins[1].key].state, 'pending');
    assert.equal(await s.run('apply', ['--confirm']), 0, s.lines.join('\n'));
    const rec2 = await s.json('copy-record.json');
    assert.notEqual(rec2.rows[twins[0].key].pageId, rec2.rows[twins[1].key].pageId, 'the twin did not adopt its sibling\'s page');
    assert.equal((await s.titles(s.w.notionIds.tasks, 'Task name')).filter((x) => x.title === 'Plan the beds').length, 2);
    assert.equal((await s.allTitles()).length, all);
  }, { twins: true });
});

// Safety control for existing behaviour (it passes on the old code too); the twin-card test above is the regression evidence.
test('R153 two unassigned pages matching one pending card stop the copy with nothing guessed', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    const plan = await s.json('plan.json');
    const twins = plan.tasks.filter((t) => t.title === 'Plan the beds');
    const at = plan.projects.length + plan.goals.length + plan.tasks.findIndex((t) => t.key === twins[0].key) + 1;
    let n = 0;
    s.w.notion.fail((c) => c.method === 'POST' && c.path === '/v1/pages' && (n += 1) === at, new Error('connection lost'));
    assert.equal(await s.run('apply', ['--confirm']), 1);
    // both twin pages now exist in Notion although the record knows neither
    const rec = await s.json('copy-record.json');
    const ids = plan.projects.map((p) => rec.rows[p.key].pageId);
    const goal = rec.rows['goal:Elmwood/howgozit#1'].pageId;
    const mk = (title) => s.w.notion.addPage(s.w.notionIds.tasks, { 'Task name': title, Status: 'Not started', Project: [rec.rows['project:garden'].pageId], Goal: [goal] });
    mk('Plan the beds'); mk('Plan the beds');
    const before = s.pagePosts();
    assert.equal(await s.run('apply', ['--confirm']), 1);
    assert.ok(s.lines.some((l) => l.includes('nothing was guessed')), s.lines.join('\n'));
    assert.equal(s.pagePosts(), before, 'no page was created');
    assert.ok(ids.length > 0);
  }, { twins: true });
});

test('R153 a page whose relation the reply cuts at 25 is read in full before it is judged, so a resume does not copy it twice', async () => {
  const token = 'ntn_fake_cut_relation';
  const fake = createFakeNotion({ token });
  const ids = await seedHowgozit(fake);
  const http = createNotionHttp({ token, fetch: fake.fetch, sleep: async () => {} });
  const projects = Array.from({ length: 27 }, (_, i) => ({ key: `project:p${i}`, title: `Project ${i}`, status: 'In progress' }));
  const plan = {
    ok: true, projects, goals: [{ key: 'goal:a#1', title: 'Wide goal', due: null, done: false, projectKeys: projects.map((p) => p.key) }],
    tasks: [], blockers: [], ideas: [], checkins: [], tagColours: [], configFiles: [], digest: 'd',
  };
  const record = emptyCopyRecord('2026-10-15T12:00:00Z');
  let landed = 0;
  const lossy = async (input, init = {}) => {
    const hit = String(init.method || 'GET').toUpperCase() === 'POST' && String(input).endsWith('/v1/pages') && String(init.body).includes('Wide goal');
    const res = await fake.fetch(input, init);
    if (hit && (landed += 1) === 1) throw new TypeError('fetch failed');
    return res;
  };
  const first = await runCopy({ plan, http: createNotionHttp({ token, fetch: lossy, sleep: async () => {} }), notionIds: ids, record, save: async () => {}, writeConfig: async () => {} });
  assert.equal(first.ok, false);
  assert.equal(record.rows['goal:a#1'].state, 'pending');
  const second = await runCopy({ plan, http, notionIds: ids, record, save: async () => {}, writeConfig: async () => {} });
  assert.equal(second.ok, true, second.message);
  const res = await fake.fetch(`https://api.notion.com/v1/data_sources/${ids.goals}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2026-03-11', 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal((await res.json()).results.length, 1, 'one goal page, not two');
});

test('R153 the plan digest changes when the settings to be written or a destination id changes', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    const saved = await s.json('plan.json');
    assert.equal(copyDigest(saved), saved.digest, 'the digest is reproducible from the saved plan');
    const edited = { ...saved, settingsNext: { ...saved.settingsNext, focus: ['woodshop'] } };
    assert.notEqual(copyDigest(edited), saved.digest, 'a settings change moves the digest');
    const moved = { ...saved, notionIds: { ...saved.notionIds, tasks: 'a'.repeat(32) }, settingsNext: { ...saved.settingsNext, notion: { ...saved.settingsNext.notion, tasks: 'a'.repeat(32) } } };
    assert.notEqual(copyDigest(moved), saved.digest, 'a destination id change moves the digest');
    // the CLI: other destination ids after the plan are a changed plan
    const other = await seedHowgozit(s.w.notion);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(s.dir, 'ids.json'), JSON.stringify(other));
    const seeded = s.pagePosts();
    assert.equal(await s.run('apply', ['--confirm']), 1);
    assert.ok(s.lines.includes('ERR GitHub changed after the plan was made; run plan again.'), s.lines.join('\n'));
    assert.equal(s.pagePosts(), seeded, 'apply created nothing');
  });
});

test('R153 a copy record made for other Notion data sources is refused by apply and verify in one sentence', async () => {
  await withSession(async (s) => {
    assert.equal(await s.run('plan'), 0);
    assert.equal(await s.run('apply', ['--confirm']), 0, s.lines.join('\n'));
    const rec = await s.json('copy-record.json');
    assert.deepEqual(rec.notionIds, s.w.notionIds, 'the record names its destination');
    assert.match(rec.planDigests[0], /^[0-9a-f]{64}$/);
    const other = await seedHowgozit(s.w.notion);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(s.dir, 'ids.json'), JSON.stringify(other));
    const SENTENCE = 'ERR The copy record was made for other Notion data sources; move it away or use the ids it was made for.';
    assert.equal(await s.run('plan'), 0);
    const posts = s.pagePosts();
    assert.equal(await s.run('apply', ['--confirm']), 1);
    assert.ok(s.lines.includes(SENTENCE), s.lines.join('\n'));
    assert.equal(s.pagePosts(), posts);
    assert.equal(await s.run('verify'), 1);
    assert.ok(s.lines.includes(SENTENCE), s.lines.join('\n'));
  });
});

test('R153 across every run above, GitHub saw only GET requests and no token reached any output line or written file', async () => {
  assert.ok(GH_SEEN.length > 50, `the world's GitHub fetch was used (${GH_SEEN.length} requests)`);
  assert.equal(tokensOf((await createCopyWorld()).env).length, 4, 'the sweep looks for four tokens');
  assert.deepEqual(GH_SEEN.filter((c) => c.method !== 'GET'), []);
  assert.ok(WRITES.length >= 10, `files were read back (${WRITES.length})`);
  assert.deepEqual(LEAKS, []);
});
