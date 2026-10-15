// A small in-memory Notion for tests: one workspace, the `fetch` of the real client.
// Every value here is invented. Timestamps come from a counter, never from the clock.
// It follows reference/mapping-redesign/cp9-interface.md §6 and the facts in notion-api.md, nothing more:
// anything notion-api.md does not state (the property-item shape, its page size) is the interface's reading
// and is proven live in CP10, not assumed.
//
//   const fake = createFakeNotion({ token: 'ntn_fake', dataSources: { [CARDS]: { properties: { Name: { type: 'title' }, ... } } } });
//   http = createNotionHttp({ token: 'ntn_fake', fetch: fake.fetch, sleep });
//   fake.calls          // every request, as { method, path, body }; a header is never logged
//   fake.state          // the live world: state.dataSources[id] = { properties, pages }
//   fake.maxInFlight    // the most requests that were ever open at the same moment
//   fake.limit({ times: 2, retryAfter: 1 })   // the next two requests answer 429 with Retry-After: 1
//   fake.addPage(CARDS, { Name: 'Paint the hallway', Status: 'In progress' }, { id, created, edited })
//   fake.trash(pageId)  // as PATCH in_trash:true, without a call being logged
//   fake.fail(match, errorOrStatus)   // additive: the next matching request throws the Error or answers that status

const HOST = 'https://api.notion.com';
const VERSION = '2026-03-11';
const RELATION_CUT = 25;
const MAX_PAGE_SIZE = 100;
const MINUTE = 60 * 1000;
const COLOURS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const TYPES = ['title', 'status', 'select', 'date', 'number', 'checkbox', 'relation', 'unique_id'];

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalid = (message) => new ApiError(400, 'validation_error', message || 'body failed validation');
const notFound = (what) => new ApiError(404, 'object_not_found', 'Could not find ' + (what || 'that object') + '.');

const copy = (v) => structuredClone(v);
const iso = (ms) => new Date(ms).toISOString();

// A 32-hex id and its dashed form are the same id; anything else is kept as given (lower-cased).
function canon(id) {
  const s = String(id).toLowerCase();
  const bare = s.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/.test(bare)) {
    return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
  }
  return s;
}

const encodeCursor = (offset) => 'cur_' + Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith('cur_')) throw invalid('start_cursor is not valid');
  const n = Number(Buffer.from(cursor.slice(4), 'base64url').toString('utf8'));
  if (!Number.isInteger(n) || n < 0) throw invalid('start_cursor is not valid');
  return n;
}

function pageSizeOf(raw) {
  if (raw === undefined || raw === null) return MAX_PAGE_SIZE;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_PAGE_SIZE) throw invalid('page_size must be a whole number from 1 to 100');
  return raw;
}

export function createFakeNotion({ token = 'ntn_fake_token', dataSources = {} } = {}) {
  const calls = [];
  const state = { tick: 0, dataSources: {} };
  let clock = Date.UTC(2026, 9, 1);
  let seq = 0;
  let limited = null;
  let failure = null;
  let inFlight = 0;
  let peak = 0;

  // Monotone: a stamp is always later than every stamp or explicit time seen so far.
  const stamp = () => {
    state.tick += 1;
    clock += MINUTE;
    return iso(clock);
  };
  const seen = (t) => {
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > clock) clock = ms;
  };
  const newPageId = () => {
    seq += 1;
    return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
  };
  let optSeq = 0;
  const newOptionId = () => {
    optSeq += 1;
    return 'opt' + optSeq;
  };

  // ---- the schema ----
  const dsByKey = new Map();
  for (const [key, def] of Object.entries(dataSources)) {
    const props = {};
    let n = 0;
    for (const [name, cfg] of Object.entries((def && def.properties) || {})) {
      if (!cfg || !TYPES.includes(cfg.type)) throw new Error('fake-notion: unknown property type for ' + name);
      n += 1;
      const p = copy(cfg);
      p.name = name;
      p.id = cfg.id || (cfg.type === 'title' ? 'title' : 'pr' + n);
      if (p.type === 'select' || p.type === 'status') {
        p.options = (p.options || []).map((o) => ({ id: o.id || newOptionId(), name: o.name, color: o.color || 'default' }));
        for (const o of p.options) if (!COLOURS.includes(o.color)) throw new Error('fake-notion: unknown colour ' + o.color);
      }
      if (p.type === 'status') {
        const names = ['To-do', 'In progress', 'Complete'];
        p.groups = (p.groups && p.groups.length ? p.groups : names.map((g) => ({ name: g, option_ids: [] }))).map((g, i) => ({
          id: g.id || 'grp' + (i + 1),
          name: g.name,
          // an option may be named in a group by its name as well as by its id
          option_ids: (g.option_ids || []).map((x) => {
            const hit = p.options.find((o) => o.id === x) || p.options.find((o) => o.name === x);
            return hit ? hit.id : x;
          }),
        }));
      }
      props[name] = p;
    }
    if (!Object.values(props).some((p) => p.type === 'title')) props.Name = { id: 'title', name: 'Name', type: 'title' };
    const id = canon(key);
    const ds = { id, properties: props, pages: [], counters: {} };
    state.dataSources[id] = ds;
    dsByKey.set(id, ds);
  }

  const dsOf = (id) => {
    const ds = dsByKey.get(canon(id));
    if (!ds) throw notFound('that data source');
    return ds;
  };
  const findPage = (id) => {
    const c = canon(id);
    for (const ds of dsByKey.values()) {
      const page = ds.pages.find((p) => p.id === c);
      if (page) return { ds, page };
    }
    throw notFound('that page');
  };
  const propOf = (ds, key) => {
    const hit = Object.values(ds.properties).find((p) => p.id === key || p.name === key);
    if (!hit) throw invalid('Property "' + key + '" does not exist.');
    return hit;
  };

  const schemaOf = (ds) => {
    const properties = {};
    for (const p of Object.values(ds.properties)) {
      const out = { id: p.id, name: p.name, type: p.type };
      if (p.type === 'title') out.title = {};
      else if (p.type === 'checkbox') out.checkbox = {};
      else if (p.type === 'date') out.date = {};
      else if (p.type === 'number') out.number = { format: p.format || 'number' };
      else if (p.type === 'select') out.select = { options: copy(p.options) };
      else if (p.type === 'status') out.status = { options: copy(p.options), groups: copy(p.groups) };
      else if (p.type === 'relation') {
        out.relation = { database_id: 'db-' + canon(p.data_source_id), data_source_id: canon(p.data_source_id), type: 'single_property', single_property: {} };
      } else if (p.type === 'unique_id') out.unique_id = { prefix: p.prefix || null };
      properties[p.name] = out;
    }
    return { object: 'data_source', id: ds.id, properties };
  };

  // ---- values: write (loose in, strict stored) and read (Notion's shape out) ----
  const optionByName = (p, name) => p.options.find((o) => o.name.toLowerCase() === String(name).toLowerCase());

  // `v` is either a Notion write value ({ checkbox: true }) or the bare inner value (true).
  function toRaw(ds, p, v, internal) {
    const inner = v !== null && typeof v === 'object' && !Array.isArray(v) && p.type in v ? v[p.type] : v;
    switch (p.type) {
      case 'title': {
        if (typeof inner === 'string') return inner;
        if (Array.isArray(inner) && inner.every((t) => t && ((t.text && typeof t.text.content === 'string') || typeof t.plain_text === 'string'))) {
          return inner.map((t) => (t.text ? t.text.content : t.plain_text)).join('');
        }
        throw invalid('title is expected to be an array of rich text.');
      }
      case 'checkbox':
        if (typeof inner !== 'boolean') throw invalid('checkbox is expected to be a boolean.');
        return inner;
      case 'number':
        if (inner !== null && !(typeof inner === 'number' && Number.isFinite(inner))) throw invalid('number is expected to be a number.');
        return inner;
      case 'date': {
        if (inner === null) return null;
        const d = typeof inner === 'string' ? { start: inner } : inner;
        if (!d || typeof d.start !== 'string' || !Number.isFinite(Date.parse(d.start))) throw invalid('date.start is expected to be an ISO 8601 date.');
        if (d.end !== undefined && d.end !== null && !Number.isFinite(Date.parse(d.end))) throw invalid('date.end is expected to be an ISO 8601 date.');
        return { start: d.start, end: d.end ?? null, time_zone: d.time_zone ?? null };
      }
      case 'select': {
        if (inner === null) return null;
        const name = typeof inner === 'string' ? inner : inner && inner.name;
        if (typeof name !== 'string' || !name || name.includes(',')) throw invalid('select.name is expected to be a name without commas.');
        let o = optionByName(p, name);
        if (!o) {
          o = { id: newOptionId(), name, color: 'default' };
          p.options.push(o); // a new select name adds the option (notion-api §4)
        }
        return o.id;
      }
      case 'status': {
        if (inner === null) return null;
        const name = typeof inner === 'string' ? inner : inner && inner.name;
        const o = typeof name === 'string' ? optionByName(p, name) : null;
        if (!o) throw invalid('Status option "' + name + '" does not exist.'); // a page write never creates a status option
        return o.id;
      }
      case 'relation': {
        if (!Array.isArray(inner)) throw invalid('relation is expected to be an array.');
        if (inner.length > 100) throw invalid('relation can hold at most 100 pages per request.');
        return inner.map((r) => {
          const id = typeof r === 'string' ? r : r && r.id;
          if (typeof id !== 'string' || !id) throw invalid('relation entries are expected to be { id }.');
          return canon(id);
        });
      }
      case 'unique_id': {
        if (!internal) throw invalid('unique_id cannot be set through the API.');
        const num = typeof inner === 'number' ? inner : inner && inner.number;
        if (!Number.isInteger(num) || num < 1) throw invalid('unique_id number is expected to be a positive whole number.');
        return num;
      }
      default:
        throw invalid('Unsupported property type.');
    }
  }

  const defaultRaw = (p) => {
    if (p.type === 'title') return '';
    if (p.type === 'checkbox') return false;
    if (p.type === 'relation') return [];
    if (p.type === 'status') {
      // a new row starts at the first option of the To-do group, as Notion does
      const first = p.groups[0] && p.groups[0].option_ids[0];
      return first || (p.options[0] ? p.options[0].id : null);
    }
    return null;
  };

  function renderValue(ds, p, raw) {
    const out = { id: p.id, type: p.type };
    if (p.type === 'title') out.title = raw === '' ? [] : [{ type: 'text', text: { content: raw, link: null }, plain_text: raw }];
    else if (p.type === 'select' || p.type === 'status') {
      const o = raw === null ? null : p.options.find((x) => x.id === raw);
      out[p.type] = o ? { id: o.id, name: o.name, color: o.color } : null;
    } else if (p.type === 'date') out.date = raw === null ? null : copy(raw);
    else if (p.type === 'relation') {
      out.relation = raw.slice(0, RELATION_CUT).map((id) => ({ id }));
      out.has_more = raw.length > RELATION_CUT;
    } else if (p.type === 'unique_id') out.unique_id = { prefix: p.prefix || null, number: raw };
    else out[p.type] = raw;
    return out;
  }

  const renderPage = (ds, page) => {
    const properties = {};
    for (const p of Object.values(ds.properties)) {
      const raw = p.name in page.values ? page.values[p.name] : defaultRaw(p);
      properties[p.name] = renderValue(ds, p, raw);
    }
    return {
      object: 'page', id: page.id, created_time: page.created, last_edited_time: page.edited, in_trash: page.trashed,
      parent: { type: 'data_source_id', data_source_id: ds.id }, properties,
    };
  };

  // Applies a { name-or-id: value } map to a page's raw values; all or nothing.
  function applyProperties(ds, page, props, internal) {
    if (props === undefined) return;
    if (!props || typeof props !== 'object' || Array.isArray(props)) throw invalid('properties is expected to be an object.');
    const next = {};
    for (const [key, v] of Object.entries(props)) {
      const p = propOf(ds, key);
      next[p.name] = toRaw(ds, p, v, internal);
    }
    Object.assign(page.values, next);
  }

  function assignUniqueIds(ds, page) {
    for (const p of Object.values(ds.properties)) {
      if (p.type !== 'unique_id') continue;
      if (page.values[p.name] === undefined) {
        ds.counters[p.name] = (ds.counters[p.name] || 0) + 1;
        page.values[p.name] = ds.counters[p.name];
      } else if (page.values[p.name] > (ds.counters[p.name] || 0)) ds.counters[p.name] = page.values[p.name];
    }
  }

  function create(ds, props, { id, created, edited } = {}, internal = false) {
    const page = { id: id ? canon(id) : newPageId(), created: null, edited: null, trashed: false, values: {} };
    if (findPageSafe(page.id)) throw invalid('That page id is already in use.');
    applyProperties(ds, page, props, internal);
    assignUniqueIds(ds, page);
    page.created = created || edited || stamp();
    page.edited = edited || page.created;
    seen(page.created);
    seen(page.edited);
    ds.pages.push(page);
    return page;
  }
  function findPageSafe(id) {
    for (const ds of dsByKey.values()) if (ds.pages.some((p) => p.id === id)) return true;
    return false;
  }

  // ---- filters ----
  const DATE_CONDITIONS = {
    on_or_after: (a, b) => a >= b,
    on_or_before: (a, b) => a <= b,
    after: (a, b) => a > b,
    before: (a, b) => a < b,
    equals: (a, b) => a === b,
  };
  const msOf = (v) => {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) throw invalid('The filter date is not an ISO 8601 date.');
    return ms;
  };

  function matches(ds, page, filter) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw invalid('filter is expected to be an object.');
    if (filter.and !== undefined) {
      if (!Array.isArray(filter.and) || !filter.and.length) throw invalid('and is expected to be a non-empty array.');
      return filter.and.map((f) => matches(ds, page, f)).every(Boolean); // every branch is validated, none short-circuits past a bad one
    }
    if (filter.timestamp !== undefined) {
      if (filter.property !== undefined) throw invalid('A timestamp filter takes no property.');
      if (filter.timestamp !== 'last_edited_time' && filter.timestamp !== 'created_time') throw invalid('Unknown timestamp.');
      const cond = filter[filter.timestamp];
      const at = Date.parse(filter.timestamp === 'created_time' ? page.created : page.edited);
      return dateCondition(cond, at);
    }
    if (typeof filter.property === 'string') {
      const p = propOf(ds, filter.property);
      const cond = filter[p.type];
      if (p.type === 'date') {
        const raw = page.values[p.name] === undefined ? defaultRaw(p) : page.values[p.name];
        const hit = dateCondition(cond, raw ? Date.parse(raw.start) : null);
        return hit;
      }
      if (p.type === 'checkbox') {
        if (!cond || typeof cond !== 'object') throw invalid('checkbox condition expected.');
        const raw = page.values[p.name] === undefined ? defaultRaw(p) : page.values[p.name];
        if (typeof cond.equals === 'boolean') return raw === cond.equals;
        if (typeof cond.does_not_equal === 'boolean') return raw !== cond.does_not_equal;
        throw invalid('Unknown checkbox condition.');
      }
    }
    throw invalid('That filter is not supported by this stand-in.');
  }
  function dateCondition(cond, at) {
    if (!cond || typeof cond !== 'object') throw invalid('A date condition is expected.');
    const keys = Object.keys(cond);
    if (keys.length !== 1 || !DATE_CONDITIONS[keys[0]]) throw invalid('Unknown date condition.');
    const against = msOf(cond[keys[0]]);
    return at !== null && Number.isFinite(at) && DATE_CONDITIONS[keys[0]](at, against);
  }

  // ---- routes ----
  function route(method, path, query, body) {
    const seg = path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (seg[0] !== 'v1') throw notFound('that route');
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (body !== undefined && body !== null && b !== body) throw invalid();

    if (seg[1] === 'data_sources' && seg.length === 3 && method === 'GET') return schemaOf(dsOf(seg[2]));

    if (seg[1] === 'data_sources' && seg.length === 4 && seg[3] === 'query' && method === 'POST') {
      const ds = dsOf(seg[2]);
      const size = pageSizeOf(b.page_size);
      const start = b.start_cursor === undefined || b.start_cursor === null ? 0 : decodeCursor(b.start_cursor);
      const rows = ds.pages.filter((pg) => !pg.trashed && (b.filter === undefined || matches(ds, pg, b.filter)));
      if (b.filter !== undefined && !ds.pages.length) matches(ds, { values: {}, created: iso(0), edited: iso(0) }, b.filter); // validate the filter on an empty source too
      const slice = rows.slice(start, start + size);
      const more = start + size < rows.length;
      return {
        object: 'list', results: slice.map((pg) => renderPage(ds, pg)), has_more: more, next_cursor: more ? encodeCursor(start + size) : null,
        request_status: { type: 'complete' },
      };
    }

    if (seg[1] === 'pages' && seg.length === 2 && method === 'POST') {
      const parent = b.parent;
      if (!parent || typeof parent.data_source_id !== 'string') throw invalid('parent.data_source_id is required.');
      const ds = dsOf(parent.data_source_id);
      const page = create(ds, b.properties, {}, false);
      return renderPage(ds, page);
    }

    if (seg[1] === 'pages' && seg.length === 3 && method === 'GET') {
      const { ds, page } = findPage(seg[2]);
      return renderPage(ds, page);
    }
    if (seg[1] === 'pages' && seg.length === 3 && method === 'PATCH') {
      const { ds, page } = findPage(seg[2]);
      if (b.in_trash !== undefined && typeof b.in_trash !== 'boolean') throw invalid('in_trash is expected to be a boolean.');
      if (page.trashed && b.in_trash !== false) throw invalid("Can't edit a page that is in the trash.");
      const staged = { ...page, values: { ...page.values } };
      applyProperties(ds, staged, b.properties, false); // all or nothing
      page.values = staged.values;
      if (b.in_trash !== undefined) page.trashed = b.in_trash;
      page.edited = stamp();
      return renderPage(ds, page);
    }

    if (seg[1] === 'pages' && seg.length === 5 && seg[3] === 'properties' && method === 'GET') {
      const { ds, page } = findPage(seg[2]);
      const p = Object.values(ds.properties).find((x) => x.id === seg[4]);
      if (!p) throw notFound('that property');
      const raw = p.name in page.values ? page.values[p.name] : defaultRaw(p);
      if (p.type !== 'relation') return { object: 'property_item', ...renderValue(ds, p, raw) };
      const start = query.get('start_cursor') === null ? 0 : decodeCursor(query.get('start_cursor'));
      const slice = raw.slice(start, start + RELATION_CUT);
      const more = start + RELATION_CUT < raw.length;
      return {
        object: 'list', results: slice.map((id) => ({ object: 'property_item', type: 'relation', relation: { id } })),
        has_more: more, next_cursor: more ? encodeCursor(start + RELATION_CUT) : null,
      };
    }
    throw notFound('that route');
  }

  // ---- the fetch ----
  const headerMap = (h) => {
    const out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    else for (const [k, v] of Array.isArray(h) ? h : Object.entries(h)) out[String(k).toLowerCase()] = String(v);
    return out;
  };

  const matchesCall = (match, call) => {
    if (typeof match === 'function') return Boolean(match(call));
    if (!match) return true;
    if (match.method && match.method !== call.method) return false;
    const p = match.path;
    if (p === undefined) return true;
    if (p instanceof RegExp) return p.test(call.path);
    return call.path === p || call.path.startsWith(p);
  };

  const answer = (status, body, headers = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
  const errorAnswer = (status, code, message, headers) => answer(status, { object: 'error', status, code, message }, headers);

  async function fetchFake(url, init = {}) {
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    try {
      // Yield, so that two requests started together are really open together.
      await new Promise((resolve) => setImmediate(resolve));
      const u = new URL(String(url && url.url ? url.url : url));
      const method = String(init.method || 'GET').toUpperCase();
      let body;
      let badBody = false;
      if (init.body !== undefined && init.body !== null) {
        try { body = JSON.parse(String(init.body)); } catch { badBody = true; }
      }
      const path = u.origin === HOST ? u.pathname + u.search : String(url);
      const call = { method, path, body: body === undefined ? undefined : copy(body) };
      calls.push(call);
      if (failure && matchesCall(failure.match, call)) {
        const f = failure.how;
        failure = null;
        if (f instanceof Error) throw f;
        return errorAnswer(Number(f), 'internal_server_error', 'Invented failure.');
      }
      if (u.origin !== HOST) throw new TypeError('fetch failed'); // no other host exists for this stand-in
      if (limited && limited.times > 0) {
        limited.times -= 1;
        const seconds = String(limited.retryAfter);
        return errorAnswer(429, 'rate_limited', 'Invented rate limit.', { 'retry-after': seconds });
      }
      const h = headerMap(init.headers);
      if (h.authorization !== 'Bearer ' + token) return errorAnswer(401, 'unauthorized', 'API token is invalid.');
      if (!h['notion-version']) return errorAnswer(400, 'missing_version', 'Notion-Version header failed validation.');
      if (h['notion-version'] !== VERSION) return errorAnswer(400, 'validation_error', 'Notion-Version is not the one this stand-in knows.');
      if (badBody) return errorAnswer(400, 'invalid_json', 'Error parsing JSON body.');
      try {
        return answer(200, route(method, u.pathname, u.searchParams, body));
      } catch (err) {
        if (err instanceof ApiError) return errorAnswer(err.status, err.code, err.message);
        throw err;
      }
    } finally {
      inFlight -= 1;
    }
  }

  return {
    fetch: fetchFake,
    state,
    calls,
    get maxInFlight() { return peak; },
    limit({ times = 1, retryAfter = 1 } = {}) { limited = { times: Number(times), retryAfter: Number(retryAfter) }; },
    fail(match, how) { failure = { match, how }; },
    addPage(dsId, props = {}, opts = {}) {
      const ds = dsOf(dsId);
      const page = create(ds, props, { id: opts.id, created: opts.created, edited: opts.edited }, true);
      return renderPage(ds, page);
    },
    trash(pageId) {
      const { page } = findPage(pageId);
      page.trashed = true;
      page.edited = stamp();
    },
  };
}
