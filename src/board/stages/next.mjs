// next stage: the "what's next" seats (contract R10, R13, R25, R27 to R31, R93).
// Pure: no clock, no file, no network, no environment. Never mutates its inputs; never throws for odd data.
import { diffDays, isDate } from '../days.mjs';

// One candidate task, with its urgency worked out (R28, R93).
function describe(ctx, issue) {
  const raw = ctx.dueOf(ctx.refOf(issue));
  const due = isDate(raw) ? raw : null;
  let urgency = 'undated';
  let overdueDays = 0;
  if (due !== null) {
    const gap = diffDays(due, ctx.today);
    if (gap !== null && gap > 0) {
      urgency = 'overdue';
      overdueDays = gap;
    } else {
      urgency = 'dated';
    }
  }
  return { issue, due, urgency, overdueDays };
}

const RANK = { overdue: 0, dated: 1, undated: 2 };

function compare(a, b) {
  if (a.urgency !== b.urgency) return RANK[a.urgency] - RANK[b.urgency];
  if (a.urgency === 'overdue' && a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
  if (a.urgency === 'dated' && a.due !== b.due) return a.due < b.due ? -1 : 1;
  return a.issue.number - b.issue.number;
}

// Deal seats in rounds over the given projects (each: { project, queue }); returns the seats taken.
function deal(groups, room) {
  const seats = [];
  const pos = groups.map(() => 0);
  let progressed = true;
  while (seats.length < room && progressed) {
    progressed = false;
    for (let g = 0; g < groups.length && seats.length < room; g++) {
      if (pos[g] < groups[g].queue.length) {
        seats.push({ project: groups[g].project, entry: groups[g].queue[pos[g]] });
        pos[g] += 1;
        progressed = true;
      }
    }
  }
  return seats;
}

export default function next(ctx) {
  const count = Number.isInteger(ctx.settings?.next?.count) && ctx.settings.next.count >= 1 ? ctx.settings.next.count : 5;
  const shown = Array.isArray(ctx.shown) ? ctx.shown : [];

  // R10: a task belongs, for seating, to its first project in R8 order; it appears once.
  const taken = new Set();
  const groups = [];
  for (const project of shown) {
    const queue = [];
    for (const issue of ctx.tasksOf(project.key)) {
      if (!issue || issue.state === 'closed' || taken.has(ctx.refOf(issue))) continue;
      // R27: an open task with an open blocker is never a candidate (and takes no seat).
      if (typeof ctx.waitingOn === 'function' && ctx.waitingOn(issue).length > 0) continue;
      if (ctx.projectsOf(ctx.refOf(issue))[0] !== project.key) continue;
      taken.add(ctx.refOf(issue));
      queue.push(describe(ctx, issue));
    }
    queue.sort(compare);
    groups.push({ project, queue });
  }

  const focus = groups.filter((g) => g.project.focus === true);
  const rest = groups.filter((g) => g.project.focus !== true);
  const seats = deal(focus, count);
  if (seats.length < count) seats.push(...deal(rest, count - seats.length));

  return {
    next: seats.map(({ project, entry }) => {
      const m = ctx.milestoneOf(ctx.refOf(entry.issue));
      const row = {
        number: entry.issue.number,
        title: entry.issue.title,
        url: entry.issue.html_url,
        project: { key: project.key, title: project.title, color: project.color },
        milestone: m && typeof m.shortTitle === 'string' ? { shortTitle: m.shortTitle } : null,
        due: entry.due,
        urgency: entry.urgency,
        overdueDays: entry.overdueDays,
      };
      // R129: the full ref only when the short ref is not the bare number; R132: modes only when the settings name them.
      const short = typeof ctx.shortRef === 'function' ? ctx.shortRef(entry.issue) : null;
      if (short !== null && short !== String(entry.issue.number)) row.ref = short;
      const modes = typeof ctx.modesOf === 'function' ? ctx.modesOf(entry.issue) : null;
      if (modes !== null) row.modes = modes;
      return row;
    }),
  };
}
