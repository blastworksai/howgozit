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
//
// Notion-native additions (reference/notion-native/interface.md §5): multi_select, people and rollup properties,
// multi_select / relation / `or` filters, POST /v1/databases, PATCH /v1/data_sources/<id>, plain pages under a page or the
// workspace, GET /v1/blocks/<id>/children, GET /v1/databases/<id>, POST /v1/search, two-way relations kept in sync,
// and createFakeNotion({ tokenKind: 'internal' | 'personal' }). Fixtures/notion-howgozit.mjs builds the four-table schema on top.

const HOST = 'https://api.notion.com';
const VERSION = '2026-03-11';
const RELATION_CUT = 25;
const MAX_PAGE_SIZE = 100;
const MINUTE = 60 * 1000;
const COLOURS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
// Notion's rollup functions (property object, rollup).
const ROLLUP_FUNCTIONS = ['count', 'count_values', 'empty', 'not_empty', 'unique', 'show_unique', 'percent_empty', 'percent_not_empty', 'sum', 'average', 'median', 'min', 'max', 'range', 'earliest_date', 'latest_date', 'date_range', 'checked', 'unchecked', 'percent_checked', 'percent_unchecked', 'count_per_group', 'percent_per_group', 'show_original'];
const TYPES = ['title', 'status', 'select', 'multi_select', 'people', 'rollup', 'date', 'number', 'checkbox', 'relation', 'unique_id'];
const OPTION_TYPES = ['select', 'multi_select', 'status'];

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

export function createFakeNotion({ token = 'ntn_fake_token', dataSources = {}, tokenKind = 'personal' } = {}) {
  if (tokenKind !== 'internal' && tokenKind !== 'personal') throw new Error('fake-notion: tokenKind is internal or personal');
  const calls = [];
  const state = { tick: 0, dataSources: {}, pages: [], databases: {} };
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
  let propSeq = 0;
  const newPropId = () => {
    propSeq += 1;
    return 'np' + propSeq;
  };

  // A route definition ({ select: { options } }) or a test definition ({ type: 'select', options }) becomes { type, ...fields }.
  function flatten(name, def) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw invalid('Property "' + name + '" is not a valid definition.');
    if (typeof def.type === 'string') return copy(def);
    const k = TYPES.find((t) => def[t] !== undefined);
    if (!k) throw invalid('Property "' + name + '" has no type.');
    const inner = def[k] && typeof def[k] === 'object' ? copy(def[k]) : {};
    const out = { type: k };
    if (k === 'relation') {
      out.data_source_id = inner.data_source_id;
      out.dual = inner.type === 'dual_property';
    } else Object.assign(out, inner);
    if (def.id) out.id = def.id;
    return out;
  }

  const DEFAULT_STATUS = {
    options: [{ name: 'Not started', color: 'gray' }, { name: 'In progress', color: 'blue' }, { name: 'Done', color: 'green' }],
    groups: [{ name: 'To-do', option_ids: ['Not started'] }, { name: 'In progress', option_ids: ['In progress'] }, { name: 'Complete', option_ids: ['Done'] }],
  };

  // fresh: a property made through a route; a status with no options then gets Notion's defaults.
  function makeProp(name, cfg, id, fresh = false) {
    if (!cfg || !TYPES.includes(cfg.type)) throw new Error('fake-notion: unknown property type for ' + name);
    const p = copy(cfg);
    p.name = name;
    p.id = id;
    if (fresh && p.type === 'status' && !(p.options && p.options.length)) Object.assign(p, copy(DEFAULT_STATUS));
    if (OPTION_TYPES.includes(p.type)) {
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
    return p;
  }

  for (const [key, def] of Object.entries(dataSources)) {
    const props = {};
    let n = 0;
    for (const [name, cfg] of Object.entries((def && def.properties) || {})) {
      if (!cfg || !TYPES.includes(cfg.type)) throw new Error('fake-notion: unknown property type for ' + name);
      n += 1;
      props[name] = makeProp(name, cfg, cfg.id || (cfg.type === 'title' ? 'title' : 'pr' + n));
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

  const twinOf = (p) => {
    const tds = p.twin && dsByKey.get(p.twin.ds);
    return tds ? Object.values(tds.properties).find((x) => x.id === p.twin.id) : undefined;
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
      else if (p.type === 'multi_select') out.multi_select = { options: copy(p.options) };
      else if (p.type === 'people') out.people = {};
      else if (p.type === 'rollup') {
        const rel = p.relation_property_id && Object.values(ds.properties).find((x) => x.id === p.relation_property_id);
        const tds = rel && dsByKey.get(canon(rel.data_source_id));
        const tgt = tds && Object.values(tds.properties).find((x) => x.id === p.rollup_property_id);
        out.rollup = {
          relation_property_name: rel ? rel.name : p.relation_property_name ?? null, relation_property_id: p.relation_property_id ?? null,
          rollup_property_name: tgt ? tgt.name : p.rollup_property_name ?? null, rollup_property_id: p.rollup_property_id ?? null,
          function: p.function || 'percent_per_group',
        };
      } else if (p.type === 'status') out.status = { options: copy(p.options), groups: copy(p.groups) };
      else if (p.type === 'relation') {
        const target = dsByKey.get(canon(p.data_source_id));
        out.relation = { database_id: (target && target.databaseId) || 'db-' + canon(p.data_source_id), data_source_id: canon(p.data_source_id) };
        if (p.dual) {
          const tw = twinOf(p);
          out.relation.type = 'dual_property';
          out.relation.dual_property = { synced_property_id: tw ? tw.id : null, synced_property_name: tw ? tw.name : null };
        } else Object.assign(out.relation, { type: 'single_property', single_property: {} });
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
        if (typeof inner === 'string' && internal) return inner; // only the seeding helper (addPage) may pass bare text
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
      case 'multi_select': {
        if (inner === null && internal) return [];
        if (!Array.isArray(inner)) throw invalid('multi_select is expected to be an array of options.');
        if (inner.length > 100) throw invalid('multi_select can hold at most 100 options per request.');
        const ids = [];
        for (const e of inner) {
          if (typeof e === 'string' && internal) { /* bare name: seeding helper only */ } else if (!e || typeof e !== 'object' || Array.isArray(e) || (typeof e.name !== 'string' && typeof e.id !== 'string')) {
            throw invalid('multi_select entries are expected to be { name } or { id }.');
          }
          if (e && typeof e === 'object' && typeof e.name !== 'string') {
            const byId = p.options.find((x) => x.id === e.id);
            if (!byId) throw invalid('multi_select option id "' + e.id + '" does not exist.');
            if (!ids.includes(byId.id)) ids.push(byId.id);
            continue;
          }
          const name = typeof e === 'string' ? e : e.name;
          if (!name || name.includes(',')) throw invalid('multi_select names are expected to be names without commas.');
          let o = optionByName(p, name);
          if (!o) {
            o = { id: newOptionId(), name, color: 'default' };
            p.options.push(o);
          }
          if (!ids.includes(o.id)) ids.push(o.id);
        }
        return ids;
      }
      case 'people': {
        if (!Array.isArray(inner)) throw invalid('people is expected to be an array.');
        return inner.map((u) => {
          const id = typeof u === 'string' ? u : u && u.id;
          if (typeof id !== 'string' || !id) throw invalid('people entries are expected to be { id }.');
          return { object: 'user', id };
        });
      }
      case 'rollup':
        throw invalid('A rollup cannot be set through the API.');
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
        const target = dsByKey.get(canon(p.data_source_id));
        return inner.map((r) => {
          if (typeof r === 'string' && !internal) throw invalid('relation entries are expected to be { id }.');
          const id = typeof r === 'string' ? r : r && r.id;
          if (typeof id !== 'string' || !id) throw invalid('relation entries are expected to be { id }.');
          const c = canon(id);
          if (!internal && !(target && target.pages.some((x) => x.id === c))) throw invalid('relation page "' + id + '" is not a page of the related data source.');
          return c;
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
    if (p.type === 'relation' || p.type === 'multi_select' || p.type === 'people') return [];
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
    } else if (p.type === 'multi_select') out.multi_select = raw.map((id) => p.options.find((x) => x.id === id)).filter(Boolean).map((o) => ({ id: o.id, name: o.name, color: o.color }));
    else if (p.type === 'people') out.people = copy(raw);
    else if (p.type === 'rollup') out.rollup = { type: 'number', number: null, function: p.function || 'percent_per_group' };
    else if (p.type === 'date') out.date = raw === null ? null : copy(raw);
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
    syncRelations(ds, page, {});
    return page;
  }

  // A two-way relation lists the page on both sides: after a write, the twin property of every page that was added or removed follows.
  function syncRelations(ds, page, before) {
    for (const p of Object.values(ds.properties)) {
      if (p.type !== 'relation' || !p.twin) continue;
      const old = before[p.name] || [];
      const now = page.values[p.name] || [];
      const tds = dsByKey.get(p.twin.ds);
      const tp = twinOf(p);
      if (!tds || !tp) continue;
      const touch = (id, change) => {
        const target = tds.pages.find((x) => x.id === id);
        if (!target) return;
        target.values[tp.name] = change(target.values[tp.name] || []);
        target.edited = stamp();
      };
      for (const id of old.filter((x) => !now.includes(x))) touch(id, (arr) => arr.filter((x) => x !== page.id));
      for (const id of now.filter((x) => !old.includes(x))) touch(id, (arr) => (arr.includes(page.id) ? arr : [...arr, page.id]));
    }
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

  // Depth is checked on the filter alone, before any page is looked at, so a source with no live pages refuses a too-deep filter too.
  function checkDepth(filter, depth = 1) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return;
    for (const k of ['and', 'or']) {
      if (filter[k] === undefined) continue;
      if (depth > 2) throw invalid('Compound filters can be nested two levels deep at most.');
      if (Array.isArray(filter[k])) filter[k].forEach((f) => checkDepth(f, depth + 1));
    }
  }

  function matches(ds, page, filter, depth = 1) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw invalid('filter is expected to be an object.');
    if ((filter.and !== undefined || filter.or !== undefined) && depth > 2) throw invalid('Compound filters can be nested two levels deep at most.');
    if (filter.and !== undefined) {
      if (!Array.isArray(filter.and) || !filter.and.length) throw invalid('and is expected to be a non-empty array.');
      return filter.and.map((f) => matches(ds, page, f, depth + 1)).every(Boolean); // every branch is validated, none short-circuits past a bad one
    }
    if (filter.or !== undefined) {
      if (!Array.isArray(filter.or) || !filter.or.length) throw invalid('or is expected to be a non-empty array.');
      return filter.or.map((f) => matches(ds, page, f, depth + 1)).some(Boolean);
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
      if (p.type === 'title' || p.type === 'rich_text') {
        if (!cond || typeof cond !== 'object' || Array.isArray(cond)) throw invalid(p.type + ' condition expected.');
        const raw = page.values[p.name] === undefined ? defaultRaw(p) : page.values[p.name];
        const text = typeof raw === 'string' ? raw : '';
        if (typeof cond.equals === 'string') return text === cond.equals;
        if (typeof cond.contains === 'string') return text.includes(cond.contains);
        if (cond.is_empty === true) return text === '';
        if (cond.is_not_empty === true) return text !== '';
        throw invalid('Unknown ' + p.type + ' condition.');
      }
      if (p.type === 'multi_select') {
        if (!cond || typeof cond !== 'object') throw invalid('multi_select condition expected.');
        const raw = page.values[p.name] === undefined ? defaultRaw(p) : page.values[p.name];
        const names = raw.map((id) => (p.options.find((o) => o.id === id) || {}).name);
        if (typeof cond.contains === 'string') return names.includes(cond.contains);
        if (typeof cond.does_not_contain === 'string') return !names.includes(cond.does_not_contain);
        throw invalid('Unknown multi_select condition.');
      }
      if (p.type === 'relation') {
        if (!cond || typeof cond !== 'object') throw invalid('relation condition expected.');
        const raw = page.values[p.name] === undefined ? defaultRaw(p) : page.values[p.name];
        if (cond.is_empty === true) return raw.length === 0;
        if (cond.is_not_empty === true) return raw.length > 0;
        if (typeof cond.contains === 'string') return raw.includes(canon(cond.contains));
        throw invalid('Unknown relation condition.');
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

  // ---- schema routes: databases, data sources, plain pages, search ----
  const plainPage = (id) => state.pages.find((x) => x.id === canon(id));
  function knownPage(id) {
    if (plainPage(id)) return true;
    try { findPage(id); return true; } catch { return false; }
  }

  // Runs a schema change and puts every data source back as it was if it throws.
  function atomically(fn) {
    const snap = copy(state.dataSources);
    const dbSnap = copy(state.databases);
    try {
      return fn();
    } catch (err) {
      for (const id of Object.keys(state.dataSources)) {
        if (snap[id]) Object.assign(state.dataSources[id], snap[id]);
        else { delete state.dataSources[id]; dsByKey.delete(id); }
      }
      state.databases = dbSnap;
      throw err;
    }
  }

  const textOf = (v, what) => {
    if (Array.isArray(v) && v.every((t) => t && ((t.text && typeof t.text.content === 'string') || typeof t.plain_text === 'string'))) {
      return v.map((t) => (t.text ? t.text.content : t.plain_text)).join('');
    }
    throw invalid(what + ' is expected to be an array of rich text.');
  };
  const richText = (text) => (text === '' ? [] : [{ type: 'text', text: { content: text, link: null }, plain_text: text }]);

  const uniqueName = (ds, name) => {
    let out = name;
    for (let i = 2; Object.values(ds.properties).some((p) => p.name === out); i += 1) out = name + ' ' + i;
    return out;
  };

  // names unique case-insensitively, no commas (notion-api §4)
  function checkOptionNames(options) {
    const seen = new Set();
    for (const o of options) {
      if (typeof o.name !== 'string' || !o.name) throw invalid('An option needs a name.');
      if (o.name.includes(',')) throw invalid('Option names cannot contain commas.');
      const k = o.name.toLowerCase();
      if (seen.has(k)) throw invalid('Option "' + o.name + '" is a duplicate (names are unique case-insensitively).');
      seen.add(k);
    }
  }

  // A rollup names a relation on this data source and a property on the related one, by name or id, and a function.
  function resolveRollup(ds, flat) {
    const find = (d, name, id) => Object.values(d.properties).find((x) => (typeof id === 'string' && id ? x.id === id : x.name === name));
    const rel = find(ds, flat.relation_property_name, flat.relation_property_id);
    if (!rel || rel.type !== 'relation') throw invalid('rollup.relation_property_name must name a relation property of this data source.');
    const tds = dsByKey.get(canon(rel.data_source_id));
    const target = tds && find(tds, flat.rollup_property_name, flat.rollup_property_id);
    if (!target) throw invalid('rollup.rollup_property_name must name a property of the related data source.');
    if (typeof flat.function !== 'string' || !flat.function) throw invalid('rollup.function is required.');
    if (!ROLLUP_FUNCTIONS.includes(flat.function)) throw invalid('rollup.function is not a supported rollup function.');
    return {
      type: 'rollup', relation_property_id: rel.id, relation_property_name: rel.name,
      rollup_property_id: target.id, rollup_property_name: target.name, function: flat.function,
    };
  }

  function addProperty(ds, name, def) {
    if (typeof name !== 'string' || !name) throw invalid('A property needs a name.');
    if (Object.values(ds.properties).some((x) => x.name === name)) throw invalid('Property "' + name + '" already exists.');
    const flat = flatten(name, def);
    if (!TYPES.includes(flat.type)) throw invalid('Unsupported property type "' + flat.type + '".');
    if (flat.type === 'title' && Object.values(ds.properties).some((x) => x.type === 'title')) throw invalid('A data source has exactly one title property.');
    if (OPTION_TYPES.includes(flat.type) && flat.options !== undefined) {
      if (!Array.isArray(flat.options)) throw invalid('options is expected to be an array.');
      checkOptionNames(flat.options);
    }
    const resolved = flat.type === 'rollup' ? resolveRollup(ds, flat) : null;
    const p = makeProp(name, resolved || flat, flat.id || (flat.type === 'title' ? 'title' : newPropId()), true);
    let target;
    if (p.type === 'relation') {
      // Notion needs a real data source id; a self relation is made by PATCH once the id exists
      if (typeof p.data_source_id !== 'string' || !p.data_source_id) throw invalid('relation.data_source_id is required.');
      target = canon(p.data_source_id) === ds.id ? ds : dsByKey.get(canon(p.data_source_id));
      if (!target) throw invalid('relation.data_source_id "' + p.data_source_id + '" is not a data source this connection can see.');
      p.data_source_id = target.id;
    }
    ds.properties[name] = p;
    if (p.type === 'relation' && p.dual) {
      const twin = {
        id: newPropId(), name: uniqueName(target, 'Related to ' + (ds.dbTitle || ds.id) + ' (' + name + ')'), type: 'relation',
        data_source_id: ds.id, dual: true, twin: { ds: ds.id, id: p.id },
      };
      p.twin = { ds: target.id, id: twin.id };
      target.properties[twin.name] = twin;
    }
    return p;
  }

  function removeProperty(ds, p) {
    if (p.type === 'title') throw invalid('The title property cannot be removed.');
    const gone = [[ds, p]];
    const tw = p.type === 'relation' ? twinOf(p) : undefined;
    if (tw) gone.push([dsByKey.get(p.twin.ds), tw]);
    for (const [d, q] of gone) {
      delete d.properties[q.name];
      for (const pg of d.pages) delete pg.values[q.name];
    }
  }

  function renameProperty(ds, p, name) {
    if (typeof name !== 'string' || !name) throw invalid('A property needs a name.');
    if (name === p.name) return;
    if (Object.values(ds.properties).some((x) => x.name === name)) throw invalid('Property "' + name + '" already exists.');
    const old = p.name;
    ds.properties = Object.fromEntries(Object.entries(ds.properties).map(([k, v]) => (k === old ? [name, v] : [k, v])));
    p.name = name;
    for (const pg of ds.pages) if (old in pg.values) { pg.values[name] = pg.values[old]; delete pg.values[old]; }
  }

  function patchSchema(ds, props) {
    if (!props || typeof props !== 'object' || Array.isArray(props)) throw invalid('properties is expected to be an object.');
    for (const [key, def] of Object.entries(props)) {
      const hit = Object.values(ds.properties).find((x) => x.id === key || x.name === key);
      if (def === null) {
        if (!hit) throw invalid('Property "' + key + '" does not exist.');
        removeProperty(ds, hit);
      } else if (!hit) addProperty(ds, key, def);
      else {
        if (!def || typeof def !== 'object' || Array.isArray(def)) throw invalid('Property "' + key + '" is not a valid definition.');
        if (typeof def.name === 'string') renameProperty(ds, hit, def.name);
        const flat = Object.keys(def).some((k) => TYPES.includes(k)) ? flatten(hit.name, def) : null;
        if (!flat) continue;
        if (flat.type !== hit.type) throw invalid('Property "' + hit.name + '" cannot change type.');
        if (OPTION_TYPES.includes(hit.type) && flat.options) {
          // set options: the given list replaces the old one; a name that was there keeps its id
          // an option is found by id, else by case-insensitive name, and keeps its identity either way
          if (!Array.isArray(flat.options)) throw invalid('options is expected to be an array.');
          const next = flat.options.map((o) => {
            if (!o || typeof o !== 'object') throw invalid('options are expected to be objects.');
            const was = (typeof o.id === 'string' && hit.options.find((x) => x.id === o.id))
              || (typeof o.name === 'string' && hit.options.find((x) => x.name.toLowerCase() === o.name.toLowerCase()));
            const name = typeof o.name === 'string' ? o.name : was && was.name;
            const color = o.color || (was && was.color) || 'default';
            if (!COLOURS.includes(color)) throw invalid('Unknown colour ' + color + '.');
            return { id: (was && was.id) || (typeof o.id === 'string' && o.id) || newOptionId(), name, color };
          });
          checkOptionNames(next);
          hit.options = next;
        }
        if (hit.type === 'rollup') Object.assign(hit, resolveRollup(ds, flat), { id: hit.id, name: hit.name });
      }
    }
  }

  const databaseOut = (db) => ({
    object: 'database', id: db.id, title: richText(db.title), data_sources: db.data_sources.map((id) => ({ id, name: state.dataSources[id].dbTitle })),
    parent: copy(db.parent),
  });

  function createDatabase(b) {
    const parent = b.parent;
    if (!parent || typeof parent.page_id !== 'string') throw invalid('parent.page_id is required.');
    if (!knownPage(parent.page_id)) throw notFound('that parent page');
    const title = textOf(b.title === undefined ? [] : b.title, 'title');
    const raw = b.initial_data_source && b.initial_data_source.properties;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('initial_data_source.properties is expected to be an object.');
    seq += 1;
    const dbId = `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
    seq += 1;
    const dsId = `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
    return atomically(() => {
      const ds = { id: dsId, properties: {}, pages: [], counters: {}, dbTitle: title, databaseId: dbId };
      state.dataSources[dsId] = ds;
      dsByKey.set(dsId, ds);
      const entries = Object.entries(raw);
      // relations last: a self relation and its twin need the rest of the schema to exist
      const isRel = ([, d]) => d && d.relation;
      const isRoll = ([, d]) => d && d.rollup;
      for (const [name, def] of [...entries.filter((e) => !isRel(e) && !isRoll(e)), ...entries.filter(isRel), ...entries.filter(isRoll)]) addProperty(ds, name, def);
      if (!Object.values(ds.properties).some((p) => p.type === 'title')) throw invalid('A data source needs a title property.');
      const db = { id: dbId, title, parent: { type: 'page_id', page_id: canon(parent.page_id) }, data_sources: [dsId], icon: b.icon ?? null, is_inline: Boolean(b.is_inline) };
      state.databases[dbId] = db;
      return databaseOut(db);
    });
  }

  function createPlainPage(b, parent) {
    if (parent.workspace && tokenKind === 'internal') throw invalid('Cannot create a page at the workspace level with an internal connection.');
    const t = b.properties && (b.properties.title ?? b.properties.Name);
    const title = t === undefined ? '' : textOf(t.title !== undefined ? t.title : t, 'title');
    seq += 1;
    const id = `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
    const at = stamp();
    const page = { id, title, parent, created: at, edited: at };
    state.pages.push(page);
    return {
      object: 'page', id, created_time: at, last_edited_time: at, in_trash: false, parent: copy(parent),
      properties: { title: { id: 'title', type: 'title', title: richText(title) } },
    };
  }

  function search(b) {
    const q = typeof b.query === 'string' ? b.query.toLowerCase() : '';
    const want = b.filter && b.filter.value;
    if (b.filter !== undefined && (!b.filter || b.filter.property !== 'object' || (want !== 'page' && want !== 'data_source'))) throw invalid('filter is expected to be { property: "object", value: "page" | "data_source" }.');
    const hit = (t) => !q || t.toLowerCase().includes(q);
    const results = [];
    if (want !== 'data_source') {
      for (const pg of state.pages) if (hit(pg.title)) results.push({ object: 'page', id: pg.id, parent: copy(pg.parent), properties: { title: { id: 'title', type: 'title', title: richText(pg.title) } } });
    }
    if (want !== 'page') {
      for (const ds of Object.values(state.dataSources)) {
        if (ds.dbTitle !== undefined && hit(ds.dbTitle)) results.push({ object: 'data_source', id: ds.id, title: richText(ds.dbTitle), parent: { type: 'database_id', database_id: ds.databaseId } });
      }
    }
    return { object: 'list', results, has_more: false, next_cursor: null };
  }

  // ---- routes ----
  function route(method, path, query, body) {
    const seg = path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (seg[0] !== 'v1') throw notFound('that route');
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (body !== undefined && body !== null && b !== body) throw invalid();

    if (seg[1] === 'data_sources' && seg.length === 3 && method === 'GET') return schemaOf(dsOf(seg[2]));

    if (seg[1] === 'data_sources' && seg.length === 3 && method === 'PATCH') {
      const ds = dsOf(seg[2]);
      atomically(() => patchSchema(ds, b.properties));
      return schemaOf(ds);
    }

    if (seg[1] === 'databases' && seg.length === 2 && method === 'POST') return createDatabase(b);

    if (seg[1] === 'databases' && seg.length === 3 && method === 'GET') {
      const db = state.databases[canon(seg[2])];
      if (!db) throw notFound('that database');
      return databaseOut(db);
    }

    if (seg[1] === 'blocks' && seg.length === 4 && seg[3] === 'children' && method === 'GET') {
      if (!knownPage(seg[2])) throw notFound('that block');
      const id = canon(seg[2]);
      const results = Object.values(state.databases).filter((db) => db.parent.page_id === id).map((db) => ({
        object: 'block', type: 'child_database', id: db.id, child_database: { title: db.title },
      }));
      return { object: 'list', results, has_more: false, next_cursor: null };
    }

    if (seg[1] === 'search' && seg.length === 2 && method === 'POST') return search(b);

    if (seg[1] === 'data_sources' && seg.length === 4 && seg[3] === 'query' && method === 'POST') {
      const ds = dsOf(seg[2]);
      const size = pageSizeOf(b.page_size);
      const start = b.start_cursor === undefined || b.start_cursor === null ? 0 : decodeCursor(b.start_cursor);
      if (b.filter !== undefined) checkDepth(b.filter);
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
      if (parent && parent.workspace === true) return createPlainPage(b, { type: 'workspace', workspace: true });
      if (parent && typeof parent.page_id === 'string') {
        if (!knownPage(parent.page_id)) throw notFound('that parent page');
        return createPlainPage(b, { type: 'page_id', page_id: canon(parent.page_id) });
      }
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
      const before = page.values;
      page.values = staged.values;
      syncRelations(ds, page, before);
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
    token,
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
