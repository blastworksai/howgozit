const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function checkRepo(repo) {
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new Error('repo must look like owner/name');
}

function checkPositive(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive whole number`);
}

export function createIssue(http, repo, { title, body, labels = [] } = {}) {
  try {
    checkRepo(repo);
    if (typeof title !== 'string' || title.trim() === '') throw new Error('title must be a non-empty string');
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
      throw new Error('labels must be an array of strings');
    }
    if (body !== undefined && typeof body !== 'string') throw new Error('body must be a string');
  } catch (err) {
    return Promise.reject(err);
  }
  return http.send('POST', `/repos/${repo}/issues`, body === undefined ? { title, labels } : { title, body, labels });
}

export function patchIssue(http, repo, number, patch) {
  try {
    checkRepo(repo);
    checkPositive(number, 'number');
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('patch must be an object');
    }
  } catch (err) {
    return Promise.reject(err);
  }
  return http.send('PATCH', `/repos/${repo}/issues/${number}`, patch);
}

export function addProjectItem(http, { owner, ownerType, projectNumber, repo, issueNumber } = {}) {
  try {
    if (typeof owner !== 'string' || !SEGMENT.test(owner)) throw new Error('owner is not valid');
    if (ownerType !== 'organization' && ownerType !== 'user') {
      throw new Error('ownerType must be organization or user');
    }
    checkPositive(projectNumber, 'projectNumber');
    checkRepo(repo);
    checkPositive(issueNumber, 'issueNumber');
  } catch (err) {
    return Promise.reject(err);
  }
  const [repoOwner, repoName] = repo.split('/');
  const base = ownerType === 'organization' ? 'orgs' : 'users';
  return http.send('POST', `/${base}/${owner}/projectsV2/${projectNumber}/items`, {
    type: 'Issue',
    owner: repoOwner,
    repo: repoName,
    number: issueNumber,
  });
}

export function getIssue(http, repo, number) {
  try {
    checkRepo(repo);
    checkPositive(number, 'number');
  } catch (err) {
    return Promise.reject(err);
  }
  return http.send('GET', `/repos/${repo}/issues/${number}`);
}

export function getRepo(http, repo) {
  try {
    checkRepo(repo);
  } catch (err) {
    return Promise.reject(err);
  }
  return http.send('GET', `/repos/${repo}`);
}

export function listComments(http, repo, number) {
  try {
    checkRepo(repo);
    checkPositive(number, 'number');
  } catch (err) {
    return Promise.reject(err);
  }
  return http.send('GET', `/repos/${repo}/issues/${number}/comments?per_page=100`);
}

export function addComment(http, repo, number, body) {
  try {
    checkRepo(repo);
    checkPositive(number, 'number');
    if (typeof body !== 'string' || body.trim() === '') throw new Error('body must be a non-empty string');
  } catch (err) {
    return Promise.reject(err);
  }
  return http.send('POST', `/repos/${repo}/issues/${number}/comments`, { body });
}

const TRANSFER = 'mutation($i:ID!,$r:ID!){transferIssue(input:{issueId:$i,repositoryId:$r,createLabelsIfMissing:false}){issue{number repository{nameWithOwner}}}}';

export function transferIssue(http, { issueId, repositoryId } = {}) {
  try {
    if (typeof issueId !== 'string' || issueId === '') throw new Error('issueId must be a non-empty string');
    if (typeof repositoryId !== 'string' || repositoryId === '') throw new Error('repositoryId must be a non-empty string');
  } catch (err) {
    return Promise.reject(err);
  }
  return http.graphql(TRANSFER, { i: issueId, r: repositoryId });
}

function checkProject({ owner, ownerType, projectNumber }) {
  if (typeof owner !== 'string' || !SEGMENT.test(owner)) throw new Error('owner is not valid');
  if (ownerType !== 'organization' && ownerType !== 'user') throw new Error('ownerType must be organization or user');
  checkPositive(projectNumber, 'projectNumber');
}

export function deleteProjectItem(http, { owner, ownerType, projectNumber, itemId } = {}) {
  try {
    checkProject({ owner, ownerType, projectNumber });
    checkPositive(itemId, 'itemId');
  } catch (err) {
    return Promise.reject(err);
  }
  const base = ownerType === 'organization' ? 'orgs' : 'users';
  return http.send('DELETE', `/${base}/${owner}/projectsV2/${projectNumber}/items/${itemId}`);
}

export function setItemNumber(http, { owner, ownerType, projectNumber, itemId, fieldId, value } = {}) {
  try {
    checkProject({ owner, ownerType, projectNumber });
    checkPositive(itemId, 'itemId');
    if (!(Number.isInteger(fieldId) && fieldId > 0) && !(typeof fieldId === 'string' && fieldId !== '')) {
      throw new Error('fieldId is not valid');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('value must be a number');
  } catch (err) {
    return Promise.reject(err);
  }
  const base = ownerType === 'organization' ? 'orgs' : 'users';
  return http.send('PATCH', `/${base}/${owner}/projectsV2/${projectNumber}/items/${itemId}`, { fields: [{ id: fieldId, value }] });
}

// B9-B11: a repo's issues, paged (open by default), with the fields the adapter's look-ups read.
export async function listIssuesIn(http, repo, { state = 'open' } = {}) {
  checkRepo(repo);
  if (state !== 'open' && state !== 'closed' && state !== 'all') throw new Error('state must be open, closed or all');
  const res = await http.paged(`/repos/${repo}/issues?state=${state}&per_page=100`, { maxPages: 20 });
  return (res.items || [])
    .filter((i) => i !== null && typeof i === 'object')
    .map((i) => ({ number: i.number, title: i.title, body: i.body ?? null, labels: i.labels || [], created_at: i.created_at, pull_request: i.pull_request }));
}

// B11: the Issue items of a Project, as [{ repo, number }].
export async function listProjectIssues(http, { owner, ownerType, projectNumber } = {}) {
  checkProject({ owner, ownerType, projectNumber });
  const base = ownerType === 'organization' ? 'orgs' : 'users';
  const res = await http.paged(`/${base}/${owner}/projectsV2/${projectNumber}/items?per_page=100`, { maxPages: 20 });
  const out = [];
  for (const it of res.items || []) {
    if (!it || it.content_type !== 'Issue' || !it.content || typeof it.content !== 'object') continue;
    const repo = it.content.repository && it.content.repository.full_name;
    if (typeof repo === 'string' && Number.isInteger(it.content.number)) out.push({ repo, number: it.content.number });
  }
  return out;
}
