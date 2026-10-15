// Focus (contract R23 to R26): the focused projects and the agent's focus proposal.
// Pure: no clock, no file, no network, no environment. Never mutates inputs.
import { checkState } from '../shape-data.mjs';
import { proposalsStale } from './panels.mjs';

function strList(x) {
  return Array.isArray(x) ? x.filter((k) => typeof k === 'string') : [];
}

function proposal(ctx, shownKeys) {
  const file = ctx?.state?.proposals;
  if (file === null || typeof file !== 'object' || Array.isArray(file)) return null;
  if (file.error !== undefined) return null;
  let ok = false;
  try { ok = checkState('proposals', file).ok === true; } catch { ok = false; }
  if (!ok) return null;
  const f = file.focus;
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return null;
  const add = strList(f.add).filter((k) => shownKeys.has(k));
  const remove = strList(f.remove).filter((k) => shownKeys.has(k));
  if (add.length === 0 && remove.length === 0) return null;
  let stale = false;
  try { stale = proposalsStale(ctx) === true; } catch { stale = false; }
  return { add, remove, why: typeof f.why === 'string' ? f.why : '', stale };
}

export default function focus(ctx) {
  const shown = Array.isArray(ctx?.shown) ? ctx.shown : [];
  const wanted = strList(ctx?.settings?.focus);
  const wantedSet = new Set(wanted);
  const shownKeys = new Set(shown.map((p) => p.key));
  const projects = shown
    .filter((p) => wantedSet.has(p.key))
    .map((p) => ({ key: p.key, title: p.title, color: p.color }));
  for (const k of wanted) {
    if (!shownKeys.has(k) && typeof ctx.warn === 'function') ctx.warn('focus-unknown');
  }
  return { focus: { projects, proposal: proposal(ctx, shownKeys) } };
}
