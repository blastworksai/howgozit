// The back-end adapter interface and its six closed error codes (contract R142, R150). Pure: no I/O.

export const CODES = ['auth', 'not-found', 'conflict', 'rate-limited', 'unavailable', 'invalid'];

export class BackendError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.status = status;
  }
}

// codeOfStatus(status): the closed code for an HTTP status; a missing status is a network failure.
export function codeOfStatus(status) {
  if (!Number.isInteger(status)) return 'unavailable';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'not-found';
  if (status === 422 || status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'unavailable';
  return 'invalid';
}

export const VERBS = ['read', 'logIdea', 'setCheckin', 'fileIdea', 'closeCard', 'setScore'];

// assertAdapter(a): throws a plain Error naming the first problem; returns the adapter.
export function assertAdapter(a) {
  if (a === null || typeof a !== 'object') throw new Error('adapter: must be an object');
  if (a.kind !== 'github' && a.kind !== 'notion') throw new Error('adapter: kind must be github or notion');
  for (const v of VERBS) if (typeof a[v] !== 'function') throw new Error(`adapter: missing verb ${v}`);
  return a;
}

/**
 * @typedef {{ cards: object[], items: { project: { owner: string, number: number }, ref: string }[] }} Written
 * @typedef {{ kind: 'github'|'notion',
 *   read(opts: { full: boolean, since: string|null, previous: object|null, now: string })
 *     : Promise<{ raw: object, texts: { settings: string|null, theme: string|null, state: object }, warnings: object[] }>,
 *   logIdea(a: { title: string, ctx: object }): Promise<Written>,
 *   setCheckin(a: { habit: object, date: string, on: boolean, existing: object[], ctx: object }): Promise<Written>,
 *   fileIdea(a: { idea: object, project: { owner: string, number: number, home?: string }, goal: { repo: string, number: number }|null, ctx: object }): Promise<Written>,
 *   closeCard(a: { card: object, ctx: object }): Promise<Written>,
 *   setScore(a: { habit: object, date: string, score: number, existing: object[], ctx: object }): Promise<Written>,
 * }} Adapter
 */
