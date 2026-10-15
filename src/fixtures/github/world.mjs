// Invented GitHub answers for the reader tests. Owner `sam-life`, repo `sam-life/life`.
// Every id and number is made up; extra keys are there on purpose, to prove they are ignored.

export const OWNER = 'sam-life';
export const REPO = 'sam-life/life';
export const R = '/repos/' + REPO;
export const ISSUES_FULL = R + '/issues?state=all&per_page=100';
export const MILESTONES = R + '/milestones?state=all&per_page=100';

export const FILE_PATHS = [
  'board.config.json', 'theme.json',
  'state/brief.json', 'state/calendar.json', 'state/inbox.json', 'state/log.json', 'state/proposals.json',
];

export const SETTINGS_TEXT = JSON.stringify({ projects: [{ number: 3, extra: 'x' }, { number: 7 }], zone: 'UTC' });

// base64 with a line break every 60 characters, like GitHub's contents answers
export function b64(text) {
  const s = Buffer.from(text, 'utf8').toString('base64');
  return (s.match(/.{1,60}/g) || []).join('\n') + '\n';
}

export function fileAnswer(text) {
  return { name: 'file', type: 'file', encoding: 'base64', size: text.length, content: b64(text) };
}

export const TEXTS = {
  'board.config.json': SETTINGS_TEXT,
  'theme.json': '{"radius":12,"note":"Hallway · warm"}',
  'state/brief.json': '{"generated":"2026-10-12T06:00:00+02:00","lines":[{"src":"CAL","text":"Four events · one early."},{"src":"INB","text":"Eleven threads, none urgent, all of them waiting for the weekend."}]}',
  'state/calendar.json': '{"date":"2026-10-12","events":[]}',
  'state/inbox.json': '{"updated":"2026-10-12T07:45:00+02:00","counts":{"reply":1,"decide":0,"fyi":2},"threads":[]}',
  'state/log.json': '[{"t":"06:00","agent":"brief-agent","what":"Wrote the brief"}]',
  'state/proposals.json': '{"updated":"2026-10-12T06:00:00+02:00"}',
};

export function apiIssue(number, extra = {}) {
  return {
    id: number * 10, node_id: 'N' + number, number, title: 'Task ' + number, state: 'open', state_reason: null,
    labels: [], milestone: null, comments: 0, user: { login: 'someone', id: 1 },
    created_at: '2026-09-30T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', closed_at: null,
    html_url: 'https://github.com/' + REPO + '/issues/' + number,
    ...extra,
  };
}

export function issues() {
  return [
    apiIssue(12, {
      title: 'Paint the hallway',
      labels: [{ id: 1, name: 'home', color: 'aaaaaa' }, { id: 2, name: 'urgent', color: 'bbbbbb' }],
      milestone: { id: 50, number: 5, title: 'House · Hallway', state: 'open' },
    }),
    apiIssue(13, {
      title: 'Renew the permit', state: 'closed', state_reason: 'completed', labels: ['paperwork', 'done'],
      closed_at: '2026-10-02T09:00:00Z', updated_at: '2026-10-02T09:00:00Z',
    }),
    apiIssue(14, { title: 'Fix the gate', pull_request: { url: 'https://api.github.com/repos/' + REPO + '/pulls/14' } }),
  ];
}

export function milestones() {
  return [
    { id: 500, number: 5, title: 'House · Hallway', state: 'open', due_on: '2026-10-20T07:00:00Z', closed_at: null,
      html_url: 'https://github.com/' + REPO + '/milestone/5', open_issues: 1, closed_issues: 0 },
    { id: 600, number: 6, title: 'Garden', state: 'closed', due_on: null, closed_at: '2026-09-01T10:00:00Z',
      html_url: 'https://github.com/' + REPO + '/milestone/6', open_issues: 0, closed_issues: 2 },
  ];
}

export function projectsList() {
  return [
    { id: 9003, number: 3, title: 'House', state: 'open', public: false, owner: { login: OWNER, id: 1 } },
    { id: 9004, number: 4, title: 'Old', state: 'closed', public: false },
  ];
}

export function projectFields() {
  return [
    { id: 100, name: 'Title', data_type: 'title' },
    { id: 101, name: 'Status', data_type: 'single_select' },
    { id: 102, name: 'Due', data_type: 'date' },
    { id: 103, name: 'Labels', data_type: 'labels' },
  ];
}

const status = (name) => ({ id: 101, name: 'Status', data_type: 'single_select', value: { id: 'abc', name: { raw: name, html: name }, color: 'GREEN' } });
const due = (value) => ({ id: 102, name: 'Due', data_type: 'date', value });
const title = { id: 100, name: 'Title', data_type: 'title', value: { raw: 'x', html: 'x' } };

export function projectItems() {
  return [
    { id: 1, content_type: 'Issue', content: { number: 12, title: 'Paint the hallway', repository: { full_name: REPO, private: true } },
      fields: [title, status('In Progress'), due('2026-10-18T00:00:00+00:00')] },
    { id: 2, content_type: 'PullRequest', content: { number: 14, repository: { full_name: REPO } },
      fields: [title, { id: 101, name: 'Status', data_type: 'single_select', value: null }] },
    { id: 3, content_type: 'DraftIssue', content: { title: 'Buy paint' }, fields: [title, status('Todo'), due(null)] },
    { id: 4, content_type: 'Surprise', content: { number: 99, repository: { full_name: REPO } }, fields: [title] },
    { id: 5, content_type: 'REDACTED', content: null, fields: [title] },
  ];
}

// All routes for one default read. opts: ownerType ('Organization' | 'User'), files (path -> text | null | Error | raw answer),
// issues, milestones, projectList, fields (project number -> list), items (project number -> list | { items, partial }),
// extra (merged last).
export function routes(opts = {}) {
  const ownerType = opts.ownerType || 'Organization';
  const P = (ownerType === 'User' ? '/users/' : '/orgs/') + OWNER + '/projectsV2';
  const out = {};
  out[R] = { id: 1, name: 'life', private: opts.private ?? true, default_branch: 'main', owner: { login: OWNER, type: ownerType, id: 2 } };
  const files = { ...TEXTS, ...(opts.files || {}) };
  for (const p of FILE_PATHS) {
    const v = files[p];
    if (v === null || v === undefined) continue;
    out[R + '/contents/' + p] = typeof v === 'string' ? fileAnswer(v) : v;
  }
  out[ISSUES_FULL] = opts.issues ?? issues();
  out[MILESTONES] = opts.milestones ?? milestones();
  out[P + '?per_page=100'] = opts.projectList ?? projectsList();
  const fields = opts.fields ?? { 3: projectFields() };
  const items = opts.items ?? { 3: projectItems() };
  for (const [n, list] of Object.entries(fields)) out[P + '/' + n + '/fields?per_page=100'] = list;
  for (const [n, list] of Object.entries(items)) {
    const ids = (fields[n] || []).filter((f) => f.name === 'Status' || f.name === 'Due')
      .sort((a, b) => (a.name === 'Status' ? -1 : 1) - (b.name === 'Status' ? -1 : 1)).map((f) => f.id);
    out[P + '/' + n + '/items?per_page=100' + (ids.length ? '&fields=' + ids.join(',') : '')] = list;
  }
  Object.assign(out, opts.extra || {});
  return out;
}

export const NOW = '2026-10-12T06:10:00Z';
export const SINCE = '2026-10-12T06:05:00Z';
