// A fake of the `http` object from board/github/http.mjs, for tests only.
// routes: path -> JSON value | { items, partial } (for paged paths) | Error (thrown) | function(call) -> any of those.
// Every call is recorded in `calls` as { method: 'get' | 'paged', path, options }.

function notFound(path) {
  return Object.assign(new Error('Nothing is stored at ' + path + '.'), { kind: 'not-found', status: 404 });
}

export function fakeHttp(routes = {}) {
  const calls = [];
  const table = new Map(Object.entries(routes));

  function lookup(method, path, options) {
    calls.push({ method, path, options });
    if (!table.has(path)) throw notFound(path);
    let v = table.get(path);
    if (typeof v === 'function') v = v({ method, path, options });
    if (v instanceof Error) throw v;
    return v;
  }

  return {
    calls,
    routes: table,
    async get(path) {
      const v = lookup('get', path, undefined);
      return { status: 200, json: v, notModified: false, link: null };
    },
    async paged(path, options) {
      const v = lookup('paged', path, options);
      if (Array.isArray(v)) return { items: v, partial: false };
      if (v && Array.isArray(v.items)) return { items: v.items, partial: v.partial === true };
      return { items: [], partial: false };
    },
  };
}

export function callsTo(http, method) {
  return http.calls.filter((c) => c.method === method);
}
