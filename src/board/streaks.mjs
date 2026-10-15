// Streak walk and flames (contract R40 to R43). Pure: no clock, no file, no network, no environment.

// days: one boolean per day from the habit's start to yesterday; todayDone: whether today is done.
export function simulate({ days = [], todayDone = false, tokenEvery = 6 } = {}) {
  const list = Array.isArray(days) ? days : [];
  const every = Number.isInteger(tokenEvery) && tokenEvery >= 1 ? tokenEvery : 6;
  const statuses = [];
  let streak = 0;
  let best = 0;
  let tokens = 0;
  let counter = 0;
  const earn = () => {
    streak += 1;
    counter += 1;
    if (streak > best) best = streak;
    if (counter >= every) {
      tokens += 1;
      counter = 0;
    }
  };
  for (const d of list) {
    if (d === true) {
      earn();
      statuses.push('done');
    } else if (tokens > 0) {
      tokens -= 1;
      statuses.push('token');
    } else {
      streak = 0;
      counter = 0;
      statuses.push('missed');
    }
  }
  if (todayDone === true) {
    earn();
    statuses.push('done');
  } else {
    statuses.push('pending');
  }
  return { statuses, streak, best, tokens, counter };
}

export function flames(streak, tiers) {
  const s = Number.isFinite(streak) ? streak : 0;
  const t = (Array.isArray(tiers) ? tiers : []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const lit = Math.min(5, t.filter((x) => x <= s).length);
  const next = t.find((x) => x > s);
  return {
    lit,
    flames: [0, 1, 2, 3, 4].map((i) => i < lit),
    toNext: next === undefined ? null : next - s,
  };
}
