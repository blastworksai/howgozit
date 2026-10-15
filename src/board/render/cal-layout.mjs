// Calendar day layout: window, box geometry and lanes. Pure, never throws.

const DEFAULT_START = 420;
const MIN_BOX = 30;
const MAX_LANES = 8;

export function clockMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  const total = h * 60 + mi;
  return total > 1440 ? null : total;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function compute(events) {
  const spans = events.map((ev) => {
    const o = ev !== null && typeof ev === 'object' ? ev : {};
    let s = clockMinutes(o.start);
    if (s === null) s = DEFAULT_START;
    let e = clockMinutes(o.end);
    if (e === null) e = s;
    else if (e < s) e = 1440;
    return { s, e };
  });
  let lo = 7;
  let hi = 19;
  if (spans.length > 0) {
    lo = Math.min(7, Math.floor(Math.min(...spans.map((x) => x.s)) / 60));
    hi = Math.min(24, Math.max(19, Math.ceil(Math.max(...spans.map((x) => x.e)) / 60)));
  }
  const base = lo * 60;
  const span = (hi - lo) * 60;
  const shown = spans.map((x) => {
    let ds = x.s;
    let de = Math.max(x.e, x.s + MIN_BOX);
    if (de > hi * 60) {
      de = hi * 60;
      ds = de - MIN_BOX;
    }
    return { ds, de };
  });
  const items = spans.map((x, i) => ({
    top: round1((shown[i].ds - base) / span * 100),
    height: round1((shown[i].de - shown[i].ds) / span * 100),
    short: (x.e - x.s) < 60,
    lane: 1,
    lanes: 1,
  }));
  const order = shown.map((_, i) => i).sort((a, b) => shown[a].ds - shown[b].ds || a - b);
  let cluster = [];
  let ends = [];
  let clusterMax = 0;
  const close = () => {
    for (const i of cluster) items[i].lanes = ends.length;
    cluster = [];
    ends = [];
  };
  for (const i of order) {
    const { ds, de } = shown[i];
    if (cluster.length > 0 && ds >= clusterMax) close();
    if (cluster.length === 0) clusterMax = 0;
    let lane = ends.findIndex((last) => last <= ds);
    if (lane === -1) {
      ends.push(de);
      lane = ends.length - 1;
    } else {
      ends[lane] = de;
    }
    items[i].lane = lane + 1;
    cluster.push(i);
    clusterMax = Math.max(clusterMax, de);
  }
  close();
  for (const it of items) {
    it.lane = Math.min(MAX_LANES, it.lane);
    it.lanes = Math.min(MAX_LANES, it.lanes);
  }
  return { startHour: lo, endHour: hi, items };
}

export function layoutDay(events) {
  if (!Array.isArray(events)) return { startHour: 7, endHour: 19, items: [] };
  try {
    return compute(events);
  } catch {
    return {
      startHour: 7,
      endHour: 19,
      items: events.map(() => ({ top: 0, height: 100, short: false, lane: 1, lanes: 1 })),
    };
  }
}
