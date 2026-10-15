import test from 'node:test';
import assert from 'node:assert/strict';
import { readAll } from '../board/github/read.mjs';
import { GitHubError } from '../board/github/http.mjs';
import { fakeHttp } from '../fixtures/github/fake-http.mjs';
import { REPO, OWNER, NOW, routes, projectFields } from '../fixtures/github/world.mjs';

// The seam is the `http` object readAll takes (`get`, `paged`), as in test/github-read.test.mjs.
// Here its `paged` is wrapped: every request for a project's fields or items address is counted
// while it is in flight, delayed by a few real milliseconds, and recorded.

const P = '/orgs/' + OWNER + '/projectsV2';
const PROJECT_ADDRESS = /\/projectsV2\/(\d+)\/(fields|items)\?/;
const MILESTONE_ADDRESS = /^\/repos\/([^/]+\/[^/]+)\/milestones\?/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// delayFor(projectNumber, kind) -> milliseconds
function measured(inner, delayFor = () => 8, milestoneDelay = () => 8) {
  const m = { inFlight: 0, max: 0, asked: [], started: [], msInFlight: 0, msMax: 0, msAsked: [] };
  const http = {
    get: (p) => inner.get(p),
    async paged(p, options) {
      const ms = MILESTONE_ADDRESS.exec(p);
      if (ms) {
        m.msAsked.push(p);
        m.msInFlight += 1;
        m.msMax = Math.max(m.msMax, m.msInFlight);
        try {
          await sleep(milestoneDelay(ms[1]));
          return await inner.paged(p, options);
        } finally {
          m.msInFlight -= 1;
        }
      }
      const hit = PROJECT_ADDRESS.exec(p);
      if (!hit) return inner.paged(p, options);
      m.asked.push(p);
      m.started.push(p);
      m.inFlight += 1;
      m.max = Math.max(m.max, m.inFlight);
      try {
        await sleep(delayFor(Number(hit[1]), hit[2]));
        return await inner.paged(p, options);
      } finally {
        m.inFlight -= 1;
      }
    },
  };
  return { http, m };
}

const range = (count) => Array.from({ length: count }, (_, i) => i + 1);

// Routes for `order.length` projects. GitHub lists them 1..count; settings list them in `order`.
function world(count, { order = range(count), items = {}, extra = {}, homes = {} } = {}) {
  const numbers = range(count);
  const fields = Object.fromEntries(numbers.map((n) => [n, projectFields()]));
  const defaults = Object.fromEntries(numbers.map((n) => [n, [
    { id: n, content_type: 'Issue', content: { number: 100 + n, repository: { full_name: REPO } },
      fields: [{ id: 101, name: 'Status', data_type: 'single_select', value: { id: 'a', name: { raw: 'Todo ' + n, html: 'x' }, color: 'GRAY' } }] },
  ]]));
  return routes({
    files: { 'board.config.json': JSON.stringify({ projects: order.map((number) => (homes[number] ? { number, home: homes[number] } : { number })) }) },
    projectList: numbers.map((number) => ({ id: 9000 + number, number, title: 'Project ' + number, state: 'open' })),
    fields,
    items: { ...defaults, ...items },
    extra,
  });
}

const itemsAddress = (n) => P + '/' + n + '/items?per_page=100&fields=101,102';
const fieldsAddress = (n) => P + '/' + n + '/fields?per_page=100';

// What a one-by-one read asks, computed from the fixture itself, not from the code under test:
// per project in the settings, its fields page, then its items page.
const expectedAddresses = (order) => order.flatMap((n) => [fieldsAddress(n), itemsAddress(n)]);

const read = (http) => readAll(http, { repo: REPO, full: true, now: NOW });

test('U the in-flight counter sees two requests started together as 2', async () => {
  const { http, m } = measured(fakeHttp(world(2)));
  await Promise.all([http.paged(fieldsAddress(1), {}), http.paged(fieldsAddress(2), {})]);
  assert.equal(m.max, 2);
  assert.equal(m.inFlight, 0);
  assert.deepEqual(m.asked, [fieldsAddress(1), fieldsAddress(2)]);
  const solo = measured(fakeHttp(world(2)));
  await solo.http.paged(fieldsAddress(1), {});
  await solo.http.paged(fieldsAddress(2), {});
  assert.equal(solo.m.max, 1);
});

test('R116 16 projects with a slow GitHub: more than one in flight, never more than four, the addresses of a one-by-one read each once, fields before items', async () => {
  const order = range(16);
  const { http, m } = measured(fakeHttp(world(16)));
  await read(http);
  assert.ok(m.max > 1, 'max in flight was ' + m.max);
  assert.ok(m.max <= 4, 'max in flight was ' + m.max);
  const want = expectedAddresses(order);
  assert.equal(m.asked.length, want.length, 'asked ' + m.asked.length + ' addresses, expected ' + want.length);
  assert.equal(new Set(m.asked).size, m.asked.length, 'an address was asked twice');
  assert.deepEqual([...m.asked].sort(), [...want].sort());
  for (const n of order) {
    assert.ok(m.started.indexOf(fieldsAddress(n)) < m.started.indexOf(itemsAddress(n)), 'project ' + n + ': items asked before fields');
  }
});

test('R116 3 projects: never more than three in flight, six addresses', async () => {
  const { http, m } = measured(fakeHttp(world(3)));
  await read(http);
  assert.ok(m.max <= 3, 'max in flight was ' + m.max);
  assert.equal(m.asked.length, 6);
});

const homesSetup = () => {
  const homes = {};
  const extra = {};
  for (const n of range(10)) {
    const home = OWNER + '/home-' + n;
    homes[n] = home;
    extra['/repos/' + home] = { private: true, owner: { login: OWNER, type: 'Organization' } };
    extra['/repos/' + home + '/milestones?state=all&per_page=100'] = [
      { id: 7000 + n, number: n, title: 'Milestone of ' + n, state: 'open', due_on: null, closed_at: null,
        html_url: 'https://github.com/' + home + '/milestone/' + n, open_issues: 0, closed_issues: 0 },
    ];
  }
  return { homes, extra, order: range(10).map((n) => OWNER + '/home-' + n) };
};

test('R116 ten home repos in one group: more than one milestone request in flight, never more than four, results in the order of the homes', async () => {
  const { homes, extra, order } = homesSetup();
  // later homes answer sooner, so answers arrive in the reverse order of the homes
  const { http, m } = measured(fakeHttp(world(10, { homes, extra })), () => 1, (home) => 5 + (20 - Number(home.split('-')[1]) * 2));
  const out = await read(http);
  assert.ok(m.msMax > 1, 'max milestone requests in flight was ' + m.msMax);
  assert.ok(m.msMax <= 4, 'max milestone requests in flight was ' + m.msMax);
  // the data repo's own milestone list is one more request; each home's is asked once
  const homeAsked = m.msAsked.filter((a) => a.startsWith('/repos/' + OWNER + '/home-'));
  assert.deepEqual([...homeAsked].sort(), order.map((h) => '/repos/' + h + '/milestones?state=all&per_page=100').sort());
  assert.equal(new Set(m.msAsked).size, m.msAsked.length, 'a milestone address was asked twice');
  assert.deepEqual(out.raw.milestones.filter((x) => x.repo).map((x) => x.repo), order);
  assert.deepEqual(out.raw.repos.filter((r) => r.role === 'home').map((r) => r.repo), order);
});

test('R116 delayed, out-of-order answers give the same board raw as a read with no delay', async () => {
  const plain = await read(fakeHttp(world(16)));
  // later projects answer sooner, so answers come back in a different order than they were asked
  const { http } = measured(fakeHttp(world(16)), (n) => 4 + (17 - n));
  const slow = await read(http);
  assert.deepEqual(slow.raw, plain.raw);
  assert.deepEqual(slow.warnings, plain.warnings);
  assert.deepEqual(slow.texts, plain.texts);
  assert.equal(slow.raw.projects.length, 16);
});

test('R116 projects come out in the order of the settings, whatever order GitHub lists and answers in', async () => {
  const order = [9, 2, 14, 5, 16, 1, 12, 7, 3, 15, 10, 4, 13, 6, 11, 8];
  // answers arrive in yet another order: the later in the settings, the shorter the wait
  const { http } = measured(fakeHttp(world(16, { order })), (n) => 5 + (order.length - order.indexOf(n)));
  const out = await read(http);
  assert.deepEqual(out.raw.projects.map((p) => p.number), order);
  assert.deepEqual(out.raw.projects.map((p) => p.title), order.map((n) => 'Project ' + n));
});

test('R116 one project whose item list is answered 503 fails the whole read', async () => {
  const boom = new GitHubError('unavailable', 503);
  const { http } = measured(fakeHttp(world(8, { extra: { [itemsAddress(5)]: boom } })));
  await assert.rejects(read(http), (e) => e === boom);
});

test('R116 one project whose items never end sets partial and too-much-data, and the others are still read', async () => {
  // The cap itself is the HTTP client's (R68); at reader level that is an answer flagged partial.
  const cut = { items: [], partial: true };
  const { http } = measured(fakeHttp(world(8, { items: { 5: cut } })));
  const out = await read(http);
  assert.equal(out.raw.partial.items, true);
  assert.deepEqual(out.warnings, [{ code: 'too-much-data', count: 1 }]);
  assert.deepEqual(out.raw.projects.map((p) => p.number), range(8));
  for (const p of out.raw.projects) assert.equal(p.items.length, p.number === 5 ? 0 : 1, 'project ' + p.number);
});
