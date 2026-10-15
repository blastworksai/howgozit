// Card and goal identities and the board snapshot's optional fields (contract R129, R142, R150). Pure: no clock, no file, no network, no environment.
import { checkRaw } from '../shape-data.mjs';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const isPos = (x) => Number.isInteger(x) && x > 0;

// normRepo(s): the comparison form of owner/name (lower case); '' when not a string.
export function normRepo(s) {
  return isStr(s) ? s.toLowerCase() : '';
}

export function sameRepo(a, b) {
  return isStr(a) && isStr(b) && a.toLowerCase() === b.toLowerCase();
}

// cardRef(issue, dataRepo): the card's ref, keeping GitHub's spelling.
export function cardRef(issue, dataRepo) {
  if (!isObj(issue)) return null;
  if (isStr(issue.ref)) return issue.ref;
  return `${isStr(issue.repo) ? issue.repo : dataRepo}#${issue.number}`;
}

// itemRef(item): a project item's card ref, or null when it cannot be built.
export function itemRef(item) {
  if (!isObj(item)) return null;
  if (isStr(item.ref) && item.ref !== '') return item.ref;
  if (isStr(item.repo) && item.repo !== '' && isPos(item.number)) return `${item.repo}#${item.number}`;
  return null;
}

// shortRef(issue, dataRepo): the bare number in the data repo, else the full ref (R129).
export function shortRef(issue, dataRepo) {
  const ref = cardRef(issue, dataRepo);
  if (ref === null) return null;
  const home = isStr(issue.repo) ? issue.repo : isStr(issue.ref) && issue.ref.includes('#') ? issue.ref.split('#')[0] : dataRepo;
  return sameRepo(home, dataRepo) ? String(issue.number) : ref;
}

const FULL_REF = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}#[1-9]\d{0,9}$/;
const BARE = /^[1-9]\d{0,9}$/;
const NOTION = /^notion:([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

// parseShortRef(value, dataRepo): a ref string, or null for anything else.
export function parseShortRef(value, dataRepo) {
  if (!isStr(value)) return null;
  if (BARE.test(value)) return isStr(dataRepo) && dataRepo !== '' ? `${dataRepo}#${value}` : null;
  if (FULL_REF.test(value) && !value.split('#')[0].split('/').some((seg) => /^\.+$/.test(seg))) return value;
  if (NOTION.test(value)) return value;
  return null;
}

// refKey(ref): the comparison key every join uses (the ref lower-cased); '' when not a string.
export function refKey(ref) {
  return isStr(ref) ? ref.toLowerCase() : '';
}

export function goalKey(repo, number) {
  return `${normRepo(repo)}|${number}`;
}

export function projectKey(owner, number) {
  return `${String(owner).toLowerCase()}#${number}`;
}

/* ------------------------------ checkSnapshot ------------------------------ */

const REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function optStr(o, p, k, e) {
  if (o[k] !== undefined && !isStr(o[k])) e.push(`${p}${k}: must be a string`);
}
function rows(list, path, e, fn) {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    e.push(`${path}: must be a list`);
    return;
  }
  list.forEach((row, i) => {
    if (!isObj(row)) e.push(`${path}[${i}]: must be an object`);
    else fn(row, `${path}[${i}].`);
  });
}

// checkSnapshot(raw): what checkRaw reports plus a problem for each optional field present with a wrong type.
export function checkSnapshot(raw) {
  const base = checkRaw(raw);
  const e = [...base.errors];
  if (isObj(raw)) {
    if (raw.source !== undefined && raw.source !== 'github' && raw.source !== 'notion') e.push('source: must be one of github, notion');
    rows(raw.repos, 'repos', e, (r, p) => {
      if (!isStr(r.repo) || !REPO_NAME.test(r.repo)) e.push(`${p}repo: must be owner/name`);
      if (typeof r.private !== 'boolean') e.push(`${p}private: must be true or false`);
      if (r.role !== 'data' && r.role !== 'home') e.push(`${p}role: must be one of data, home`);
    });
    rows(raw.owners, 'owners', e, (r, p) => {
      if (!isStr(r.owner)) e.push(`${p}owner: must be a string`);
      if (typeof r.ok !== 'boolean') e.push(`${p}ok: must be true or false`);
      else if (!r.ok && !isStr(r.reason)) e.push(`${p}reason: must be a string`);
    });
    if (raw.labelColors !== undefined) {
      if (!isObj(raw.labelColors)) e.push('labelColors: must be an object');
      else for (const [k, v] of Object.entries(raw.labelColors)) if (!isStr(v) || !/^#[0-9a-fA-F]{6}$/.test(v)) e.push(`labelColors.${k}: must be #rrggbb`);
    }
    rows(raw.issues, 'issues', e, (r, p) => {
      optStr(r, p, 'repo', e);
      optStr(r, p, 'ref', e);
      rows(r.waitingOn, `${p}waitingOn`, e, (w, wp) => {
        if (!isStr(w.ref)) e.push(`${wp}ref: must be a string`);
        if (w.title !== undefined && w.title !== null && !isStr(w.title)) e.push(`${wp}title: must be a string`);
        if (w.url !== undefined && w.url !== null && !isStr(w.url)) e.push(`${wp}url: must be a string`);
      });
    });
    rows(raw.milestones, 'milestones', e, (r, p) => optStr(r, p, 'repo', e));
    rows(raw.projects, 'projects', e, (r, p) => {
      optStr(r, p, 'owner', e);
      if (r.role !== undefined && r.role !== 'ideas' && r.role !== 'habits') e.push(`${p}role: must be one of ideas, habits`);
      rows(r.items, `${p}items`, e, (it, ip) => {
        optStr(it, ip, 'ref', e);
        if (it.score !== undefined && it.score !== null && !(typeof it.score === 'number' && Number.isFinite(it.score))) e.push(`${ip}score: must be a number`);
      });
    });
  }
  return { ok: e.length === 0, errors: e };
}
