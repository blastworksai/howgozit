import { createHttp } from './http.mjs';

// R131: one client per token, made once; the ETag cache is shared because every URL names its owner.
export function createOwnerHttp({ defaultToken, tokens, fetch, etags }) {
  const def = createHttp({ token: defaultToken, fetch, etags });
  const byOwner = new Map();
  for (const t of tokens ?? []) {
    const key = String(t.owner).toLowerCase();
    if (!byOwner.has(key)) byOwner.set(key, createHttp({ token: t.token, fetch, etags }));
  }
  return {
    default: def,
    forOwner(login) {
      return byOwner.get(String(login ?? '').toLowerCase()) ?? def;
    },
  };
}
