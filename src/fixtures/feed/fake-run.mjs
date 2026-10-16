// A scripted fake of the feed's runner contract (feed-interfaces.md, src/feed/doors.mjs):
//   run(argv, { timeoutMs, cwd?, env? }) -> Promise<{ code, stdout, timedOut }>
// It answers by argv, records every call with its timeoutMs and the injected clock's time, and simulates a slow call by
// advancing the injected clock. Invented names only.

export function makeClock(startMs = Date.parse('2026-10-16T06:00:00Z')) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; }, start: startMs };
}

export const isGoogleDoctor = (argv) => argv.includes('integrations/connections.py') && argv.includes('doctor');
export const isMsDoctor = (argv) => argv.includes('integrations/ms_connections.py') && argv.includes('doctor');
export const isTriage = (argv, accountId) =>
  argv.includes('email_triage.py') && (accountId === undefined || argv[argv.indexOf('--account') + 1] === accountId);

// rules are tried in order; the first whose `match(argv)` is true answers.
// A reply is { code = 0, stdout = '', takes = 0 } or a function (argv, opts) -> that.
// `takes` is how long the call would run, in ms: over the call's timeoutMs, the clock advances by timeoutMs and the
// call comes back { code: null, stdout: '', timedOut: true }, as the real runner does.
export function makeFakeRun({ clock, rules = [] } = {}) {
  const calls = [];
  const all = [...rules];
  async function run(argv, opts = {}) {
    const rule = all.find((r) => r.match(argv));
    const reply = rule ? (typeof rule.reply === 'function' ? rule.reply(argv, opts) : rule.reply) : { code: 1, stdout: '' };
    const takes = reply.takes ?? 0;
    calls.push({ argv: [...argv], timeoutMs: opts.timeoutMs, startedAt: clock ? clock.now() : 0, opts });
    if (takes > opts.timeoutMs) {
      clock?.advance(opts.timeoutMs);
      return { code: null, stdout: '', timedOut: true };
    }
    clock?.advance(takes);
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', timedOut: false };
  }
  run.calls = calls;
  run.on = (match, reply) => { all.push({ match, reply }); return run; };
  run.callsMatching = (pred) => calls.filter((c) => pred(c.argv));
  return run;
}

// ---- answer builders: the real shapes (feed-doors.md (a), (d), (e)), invented values ----
export const json = (v) => JSON.stringify(v, null, 2);

export const googleRow = (id, label, status = 'connected', surfaces = ['calendar', 'gmail']) => ({
  id, label, login: `${label}@example.invalid`, default: false, surfaces, client: 'own', client_present: true,
  health: { status, last_verified_at: null, drops: [] },
});
export const googleDoctor = (accounts) => ({
  credentials_present: true, accounts, legacy_tokens: [], enable_flags: { gmail: true }, first_time: false, guide: null,
});
export const msRow = (id, label, status = 'connected', signedIn = true) => ({
  id, label, login: `${label}@example.invalid`, tenant: 'tenant-invented', personal: true, default: false, client: 'own',
  signed_in: signedIn, levers: {}, health: { status, last_verified_at: null, drops: [] },
});
export const msDoctor = (accounts, enabled = true) => ({ enabled, accounts, first_time: false, application_id: 'app-invented' });

export const item = (n, extra = {}) => ({
  from: `Sender ${n} <sender${n}@example.invalid>`, subject: `Subject ${n}`, subject_raw: `Subject ${n}`,
  snippet: `SNIPPET-SENTINEL-${n}`, thread_id: `t${n}`, message_id: `m${n}`, known_person: false, person_id: null,
  last_contacted: null, display_name: `Sender ${n}`, date: `2026-10-15T0${n}:00:00+00:00`, address: `sender${n}@example.invalid`,
  domain: 'example.invalid', disposition: null, action: 'none', read_state: 'unread', label: 'INBOX', source: 'gmail',
  attachments_mode: 'none', automated: false, ...extra,
});
export const triageOk = (accountId, label, items = [item(1)]) => ({
  status: 'ok', account: { id: accountId, label, login: `${label}@example.invalid` }, surface: items, suppressed: [],
  counts: { total: items.length, surfaced: items.length, suppressed: 0 }, people: {},
});
export const triageAsk = (reason) => ({ status: 'ask', reason });
export const triageDormant = (reason) => ({ status: 'dormant', reason });

// Wire a fake run with both doctors and a triage answer per account id.
export function scriptedGlitch({ clock, google = [], microsoft = [], triage = {}, msEnabled = true }) {
  const run = makeFakeRun({ clock });
  run.on(isGoogleDoctor, { stdout: json(googleDoctor(google)) });
  run.on(isMsDoctor, { stdout: json(msDoctor(microsoft, msEnabled)) });
  for (const [id, reply] of Object.entries(triage)) run.on((a) => isTriage(a, id), reply);
  return run;
}
