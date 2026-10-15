// core-projects: which projects are shown, which issues are items of them, and progress (contract R4 to R13).
// Pure: no clock, no file, no network, no environment. Never mutates its inputs; never throws for odd data.

import { itemRef, refKey } from './model/snapshot.mjs';
import { isHome } from './shape-settings.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const nullOr = (check) => (v) => v === null || v === undefined || check(v);

function projectRowOk(p) {
  return isObj(p) && isInt(p.number) && isStr(p.title) && typeof p.closed === 'boolean' && isStr(p.url);
}

// A project item row: type must be a string; repo, number, status, due may be absent or null, else well typed.
function itemRowOk(it) {
  return (
    isObj(it) && isStr(it.type) &&
    nullOr(isStr)(it.repo) && nullOr(isInt)(it.number) && nullOr(isStr)(it.status) && nullOr(isStr)(it.due)
  );
}

export function addProjects(ctx, raw) {
  const rawObj = isObj(raw) ? raw : {};
  const settings = ctx.settings || {};
  const listed = Array.isArray(settings.projects) ? settings.projects.filter(isObj) : [];
  const focusKeys = new Set(Array.isArray(settings.focus) ? settings.focus : []);
  const palette = Array.isArray(ctx.theme?.projectColors) && ctx.theme.projectColors.length > 0
    ? ctx.theme.projectColors
    : ['#7FE7D3'];
  const dataRepo = isStr(rawObj.repo) ? rawObj.repo.toLowerCase() : null;

  // R6: a project is (owner, number); a missing owner on either side is the data repo's owner.
  const dataOwner = isStr(rawObj.repo) ? rawObj.repo.split('/')[0].toLowerCase() : '';
  const pairKey = (owner, number) => `${isStr(owner) && owner !== '' ? owner.toLowerCase() : dataOwner}#${number}`;
  const failedOwners = new Set(
    (Array.isArray(rawObj.owners) ? rawObj.owners : []).filter((o) => isObj(o) && o.ok === false && isStr(o.owner)).map((o) => o.owner.toLowerCase()),
  );

  // Raw projects by (owner, number): a bad row is skipped and counted; the first row of a pair wins.
  const byNumber = new Map();
  for (const p of Array.isArray(rawObj.projects) ? rawObj.projects : []) {
    if (!projectRowOk(p)) {
      ctx.warn('row-skipped');
      continue;
    }
    // R7: the Ideas and Habits Projects (rows with a role) are never matched to a listed entry.
    if (p.role !== undefined && p.role !== null) continue;
    if (!byNumber.has(pairKey(p.owner, p.number))) byNumber.set(pairKey(p.owner, p.number), p);
  }

  const issueByRef = ctx.issueByRef instanceof Map ? ctx.issueByRef : new Map();
  const dataRepoName = isStr(rawObj.repo) ? rawObj.repo : '';
  // A ref string, or a bare number (the data repo's card): the compatibility shim for callers still on numbers.
  const keyOf = (x) => {
    if (typeof x === 'number') return refKey(`${dataRepoName}#${x}`);
    if (isStr(x)) return /^[1-9]\d*$/.test(x) ? refKey(`${dataRepoName}#${x}`) : refKey(x);
    return '';
  };

  // R6, R9: shown projects in settings order first, then reordered by R8.
  const inSettingsOrder = [];
  listed.forEach((entry, position) => {
    // R67: a failed owner's projects are left out silently; the read already counted them
    if (isStr(entry.owner) && failedOwners.has(entry.owner.toLowerCase())) return;
    const p = byNumber.get(pairKey(entry.owner, entry.number));
    if (!p) {
      ctx.warn('project-missing');
      return;
    }
    if (p.closed) {
      ctx.warn('project-closed');
      return;
    }
    const color = isStr(entry.color) && entry.color !== '' ? entry.color : palette[position % palette.length];
    inSettingsOrder.push({
      row: { key: entry.key, number: p.number, title: p.title, url: p.url, color, focus: focusKeys.has(entry.key) },
      raw: p,
      home: isHome(entry.home) ? entry.home : null,
    });
  });
  const ordered = [...inSettingsOrder.filter((s) => s.row.focus), ...inSettingsOrder.filter((s) => !s.row.focus)];

  // R4: items. itemMaps: key -> Map(refKey -> { status, due }).
  const itemMaps = new Map();
  const projectKeysOf = new Map(); // refKey -> [keys] in R8 order
  const homes = new Map(); // key -> the entry's valid `home`, or null
  for (const s of ordered) {
    const map = new Map();
    itemMaps.set(s.row.key, map);
    homes.set(s.row.key, s.home);
    const items = Array.isArray(s.raw.items) ? s.raw.items : [];
    for (const it of items) {
      if (!itemRowOk(it)) {
        ctx.warn('row-skipped');
        continue;
      }
      if (it.type === 'REDACTED') {
        ctx.warn('items-hidden');
        continue;
      }
      if (it.type !== 'Issue') continue;
      // R4: with a `home`, an Issue item of any repo counts when its card is known; without, the data repo only.
      if (s.home === null && (!isStr(it.repo) || dataRepo === null || it.repo.toLowerCase() !== dataRepo)) continue;
      const rk = refKey(itemRef(it));
      if (rk === '' || !isInt(it.number) || !issueByRef.has(rk)) continue;
      if (map.has(rk)) continue;
      map.set(rk, {
        status: isStr(it.status) ? it.status : null,
        due: isStr(it.due) ? it.due : null,
      });
      const list = projectKeysOf.get(rk) || [];
      list.push(s.row.key);
      projectKeysOf.set(rk, list);
    }
  }

  // Tasks per shown project (R11): kind 'task' only, sorted by number.
  const tasksByKey = new Map();
  for (const s of ordered) {
    const map = itemMaps.get(s.row.key);
    const list = [];
    for (const rk of map.keys()) {
      const issue = issueByRef.get(rk);
      if (issue && issue.kind === 'task') list.push(issue);
    }
    list.sort((a, b) => a.number - b.number);
    tasksByKey.set(s.row.key, list);
  }

  const progressOf = (key) => {
    const list = tasksByKey.get(key) || [];
    const total = list.length;
    const done = list.filter((t) => t.state === 'closed').length;
    return { done, total, pct: total === 0 ? 0 : Math.floor((100 * done) / total), empty: total === 0 };
  };

  ctx.shown = ordered.map((s) => s.row);
  ctx.projectsOf = (x) => (projectKeysOf.get(keyOf(x)) || []).slice();
  ctx.itemOf = (key, x) => {
    const it = itemMaps.get(key)?.get(keyOf(x));
    return it ? { status: it.status, due: it.due } : null;
  };
  ctx.progress = progressOf;
  // Extra lookups for later jobs.
  ctx.tasksOf = (key) => (tasksByKey.get(key) || []).slice();
  ctx.issueByNumber = (x) => issueByRef.get(keyOf(x)) || null;
  ctx.keyOf = keyOf;
  ctx.homeOf = (key) => homes.get(key) ?? null;
}
