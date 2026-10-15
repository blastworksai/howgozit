// write: the five Notion write verbs (cp9-interface §4; contract R56 to R61, R140, R143).
// Each verb keeps the argument shape actions.mjs gives the GitHub verbs. A bare number is mapped to a page id through the
// store rows of that verb's own data source, and every page a write returns goes into the store, so the reload after an
// action shows the change even when Notion's query runs behind. A failure is a BackendError; nothing of a response, a
// request body or a token is ever put in a message.

import { BackendError } from '../model/adapter.mjs';
import { normalize } from './read.mjs';

const EMPTY = () => ({ cards: [], items: [] });
const GONE = 'That row is not on the board any more; reload the page.';
const NO_COMPLETE = 'The Status of Cards has no option in its Complete group.';
const UNACCEPTED = 'Notion did not accept the change.';
const NO_BLOCK = 'The settings need a notion block with the five data source ids; see notion-setup.md.';
const DEFAULT_PREFIX = 'habit:';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (content) => ({ title: [{ text: { content } }] });
const relation = (ids) => ({ relation: ids.map((id) => ({ id })) });

export function notionVerbs({ http, store, settingsOf }) {
  const settings = () => {
    try {
      const s = typeof settingsOf === 'function' ? settingsOf() : null;
      return isObj(s) ? s : null;
    } catch {
      return null;
    }
  };
  const prefixOf = () => {
    const s = settings();
    return s && isObj(s.labels) && typeof s.labels.habitPrefix === 'string' && s.labels.habitPrefix !== '' ? s.labels.habitPrefix : DEFAULT_PREFIX;
  };
  const dsOf = (kind) => {
    const s = settings();
    const id = s && isObj(s.notion) ? s.notion[kind] : null;
    if (typeof id !== 'string' || id === '') throw new BackendError('invalid', null, NO_BLOCK);
    return id;
  };

  // The store row of this kind numbered n, else a not-found.
  const rowByNumber = (kind, n) => {
    const want = Number(n);
    for (const r of store.rows[kind].values()) if (r.number === want) return r;
    throw new BackendError('not-found', null, GONE);
  };

  // Takes a page a write returned into the store. A copy older than the held one is not let in; a relation cut at 25 keeps
  // the ids already held, because the write's answer cannot show the rest.
  const take = (kind, page) => {
    const row = normalize(kind, page, store.schema);
    if (row === null) return null;
    const held = store.rows[kind].get(row.id);
    if (held && held.edited > row.edited) return held;
    if (held && row._more) for (const m of row._more) row[m.key] = [...new Set([...row[m.key], ...(held[m.key] || [])])];
    store.rows[kind].set(row.id, row);
    return row;
  };
  const create = async (kind, properties) => take(kind, await http.request('POST', '/v1/pages', { parent: { data_source_id: dsOf(kind) }, properties }));
  const patch = async (kind, id, properties) => take(kind, await http.request('PATCH', `/v1/pages/${id}`, { properties }));

  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw new BackendError('unavailable', null, UNACCEPTED);
    }
  };

  const habitOf = (habitLabel) => {
    const p = prefixOf();
    const l = String(habitLabel);
    return l.startsWith(p) ? l.slice(p.length) : l;
  };
  const checkinProps = (habitTitle, habitLabel, date, extra) => ({
    title: text(`${habitTitle} · ${date}`),
    Habit: { select: { name: habitOf(habitLabel) } },
    Date: { date: { start: date } },
    ...extra,
  });
  const rowsOf = (issues) => (Array.isArray(issues) ? issues : []).map((i) => ({ issue: i, row: rowByNumber('habitLog', i && i.number) }));

  return {
    logIdea: guard(async ({ title }) => {
      await create('ideas', { title: text(title) });
      return EMPTY();
    }),

    setCheckin: guard(async ({ habitTitle, habitLabel, date, on, existing }) => {
      const today = rowsOf(existing);
      if (on) {
        const open = today.filter((t) => t.issue.state === 'open');
        if (open.length > 0) {
          for (const t of open) await patch('habitLog', t.row.id, { Done: { checkbox: true } });
        } else if (today.length === 0) {
          await create('habitLog', checkinProps(habitTitle, habitLabel, date, { Done: { checkbox: true } }));
        }
      } else {
        for (const t of today.filter((x) => x.issue.state === 'closed')) await patch('habitLog', t.row.id, { Done: { checkbox: false } });
      }
      return EMPTY();
    }),

    fileIdea: guard(async (args) => {
      const { plan, step } = args;
      const at = typeof step === 'function' ? step : () => {};
      // the idea: by the page id in plan.idea.ref when it names one the store holds, else by number
      let idea = null;
      const ref = plan && isObj(plan.idea) && typeof plan.idea.ref === 'string' ? plan.idea.ref : null;
      if (ref !== null && ref.startsWith('notion:')) idea = store.rows.ideas.get(ref.slice('notion:'.length)) ?? null;
      if (idea === null) idea = rowByNumber('ideas', plan && isObj(plan.idea) && plan.idea.number !== undefined ? plan.idea.number : args.number);
      const project = rowByNumber('projects', plan && isObj(plan.project) && plan.project.number !== undefined ? plan.project.number : args.projectNumber);
      const goal = args.milestone !== null && args.milestone !== undefined ? rowByNumber('goals', args.milestone) : null;

      at('adding it to the project');
      // A Card is never adopted by title. The store remembers ideaId -> cardId for each Card this adapter made; a retried
      // post finds its first Card only through that map (after a restart the map is empty and a retry makes a new Card).
      store.filed ??= new Map();
      const mapped = store.filed.get(idea.id);
      const card = mapped !== undefined ? store.rows.cards.get(mapped) ?? null : null;
      if (card === null) {
        const props = { title: text(idea.title), Project: relation([project.id]) };
        if (goal !== null) props.Goal = relation([goal.id]);
        const made = await create('cards', props);
        if (made !== null) store.filed.set(idea.id, made.id);
      } else {
        // a retried post: the Card takes the retry's Project and Goal (or none) when they differ
        const same = (ids, want) => ids.length === want.length && want.every((w) => ids.includes(w));
        const props = {};
        if (!same(card.projectIds ?? [], [project.id])) props.Project = relation([project.id]);
        const wantGoal = goal !== null ? [goal.id] : [];
        if (!same(card.goalIds ?? [], wantGoal)) props.Goal = relation(wantGoal);
        if (Object.keys(props).length > 0) await patch('cards', card.id, props);
      }
      at('marking the idea filed');
      await patch('ideas', idea.id, { Filed: { checkbox: true } });
      return EMPTY();
    }),

    closeCard: guard(async ({ card, number }) => {
      const n = isObj(card) && card.number !== undefined ? card.number : number;
      const row = rowByNumber('cards', n);
      const name = store.schema.cards.completeFirst;
      if (typeof name !== 'string' || name === '') throw new BackendError('invalid', null, NO_COMPLETE);
      await patch('cards', row.id, { Status: { status: { name } } });
      return EMPTY();
    }),

    setScore: guard(async ({ habitTitle, habitLabel, date, score, existing, carrier, step }) => {
      const at = typeof step === 'function' ? step : () => {};
      const today = rowsOf(existing);
      if (today.length === 0) {
        at('creating the check-in');
        await create('habitLog', checkinProps(habitTitle, habitLabel, date, { Done: { checkbox: true }, Score: { number: score } }));
        return EMPTY();
      }
      at('setting the score');
      const own = today.find((t) => t.issue.number === carrier) ?? today[0];
      await patch('habitLog', own.row.id, own.issue.state === 'closed' ? { Score: { number: score } } : { Done: { checkbox: true }, Score: { number: score } });
      for (const t of today) {
        if (t === own || t.issue.state !== 'open') continue;
        await patch('habitLog', t.row.id, { Done: { checkbox: true } });
      }
      return EMPTY();
    }),
  };
}
