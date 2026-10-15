// Shape validators for raw input, agent state files and the board.
// Pure: no clock, no file, no network, no environment. Never throws.
// Extra keys are tolerated; missing or wrongly typed required keys are errors.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const isBool = (x) => typeof x === 'boolean';
const isInt = (x) => Number.isInteger(x);
const isNat = (x) => Number.isInteger(x) && x >= 0;
const isPos = (x) => Number.isInteger(x) && x > 0;

const W = {
  str: 'must be a string',
  bool: 'must be true or false',
  int: 'must be a whole number',
  nat: 'must be a whole number, zero or more',
  pos: 'must be a positive whole number',
};

function join(p, k) {
  return p ? `${p}.${k}` : k;
}

// field(o, p, k, errs, test, why, nullable): checks o[k] with a predicate.
function field(o, p, k, errs, test, why, nullable = false) {
  const v = o[k];
  const path = join(p, k);
  if (v === undefined) {
    errs.push(`${path}: is required`);
    return false;
  }
  if (v === null) {
    if (nullable) return true;
    errs.push(`${path}: ${why}`);
    return false;
  }
  if (!test(v)) {
    errs.push(`${path}: ${why}`);
    return false;
  }
  return true;
}

function oneOf(values) {
  return Object.assign((v) => values.includes(v), { why: `must be one of ${values.join(', ')}` });
}

function enumField(o, p, k, errs, values, nullable = false) {
  const t = oneOf(values);
  return field(o, p, k, errs, t, t.why, nullable);
}

function strField(o, p, k, errs, nullable = false) {
  return field(o, p, k, errs, isStr, W.str, nullable);
}
function boolField(o, p, k, errs) {
  return field(o, p, k, errs, isBool, W.bool);
}
function intField(o, p, k, errs, nullable = false) {
  return field(o, p, k, errs, isInt, W.int, nullable);
}
function natField(o, p, k, errs, nullable = false) {
  return field(o, p, k, errs, isNat, W.nat, nullable);
}
function posField(o, p, k, errs, nullable = false) {
  return field(o, p, k, errs, isPos, W.pos, nullable);
}

// objectAt(x, path, errs): true when x is an object; otherwise records the error.
function objectAt(x, path, errs) {
  if (x === undefined) {
    errs.push(`${path}: is required`);
    return false;
  }
  if (!isObj(x)) {
    errs.push(`${path}: must be an object`);
    return false;
  }
  return true;
}

// listAt(x, path, errs, rowCheck, length): checks every row; rowCheck(row, rowPath, errs).
function listAt(x, path, errs, rowCheck, length) {
  if (x === undefined) {
    errs.push(`${path}: is required`);
    return false;
  }
  if (!Array.isArray(x)) {
    errs.push(`${path}: must be a list`);
    return false;
  }
  if (length !== undefined && x.length !== length) {
    errs.push(`${path}: must have exactly ${length} entries (has ${x.length})`);
  }
  x.forEach((row, i) => {
    if (rowCheck) rowCheck(row, `${path}[${i}]`, errs);
  });
  return true;
}

function objRow(fn) {
  return (row, path, errs) => {
    if (!isObj(row)) {
      errs.push(`${path}: must be an object`);
      return;
    }
    fn(row, path, errs);
  };
}

function strRow(row, path, errs) {
  if (!isStr(row)) errs.push(`${path}: ${W.str}`);
}

function listField(o, p, k, errs, rowCheck, length) {
  return listAt(o[k], join(p, k), errs, rowCheck, length);
}

function objField(o, p, k, errs, fn, nullable = false) {
  const v = o[k];
  const path = join(p, k);
  if (v === null && nullable) return true;
  if (!objectAt(v, path, errs)) return false;
  fn(v, path, errs);
  return true;
}

function finish(errors) {
  return { ok: errors.length === 0, errors };
}

function guard(fn) {
  const errors = [];
  try {
    fn(errors);
  } catch (e) {
    errors.push('check failed unexpectedly');
  }
  return finish(errors);
}

/* ---------------------------------- raw ---------------------------------- */

const ITEM_TYPES = ['Issue', 'PullRequest', 'DraftIssue', 'REDACTED'];

const rawIssue = objRow((o, p, e) => {
  posField(o, p, 'number', e);
  strField(o, p, 'title', e);
  enumField(o, p, 'state', e, ['open', 'closed']);
  strField(o, p, 'state_reason', e, true);
  boolField(o, p, 'is_pr', e);
  listField(o, p, 'labels', e, strRow);
  posField(o, p, 'milestone', e, true);
  strField(o, p, 'created_at', e);
  strField(o, p, 'updated_at', e);
  strField(o, p, 'closed_at', e, true);
  strField(o, p, 'html_url', e);
});

const rawMilestone = objRow((o, p, e) => {
  posField(o, p, 'number', e);
  strField(o, p, 'title', e);
  enumField(o, p, 'state', e, ['open', 'closed']);
  strField(o, p, 'due_on', e, true);
  strField(o, p, 'closed_at', e, true);
  strField(o, p, 'html_url', e);
});

const rawItem = objRow((o, p, e) => {
  enumField(o, p, 'type', e, ITEM_TYPES);
  strField(o, p, 'repo', e, true);
  posField(o, p, 'number', e, true);
  strField(o, p, 'status', e, true);
  strField(o, p, 'due', e, true);
});

const rawProject = objRow((o, p, e) => {
  posField(o, p, 'number', e);
  strField(o, p, 'title', e);
  boolField(o, p, 'closed', e);
  strField(o, p, 'url', e);
  listField(o, p, 'items', e, rawItem);
});

export function checkRaw(x) {
  return guard((e) => {
    if (!objectAt(x, 'raw', e)) return;
    strField(x, '', 'fetchedAt', e);
    objField(x, '', 'partial', e, (o, p, er) => {
      boolField(o, p, 'issues', er);
      boolField(o, p, 'items', er);
    });
    strField(x, '', 'repo', e);
    boolField(x, '', 'repoPrivate', e);
    enumField(x, '', 'ownerType', e, ['organization', 'user']);
    listField(x, '', 'issues', e, rawIssue);
    listField(x, '', 'milestones', e, rawMilestone);
    listField(x, '', 'projects', e, rawProject);
  });
}

/* --------------------------------- state --------------------------------- */

const lineRow = objRow((o, p, e) => {
  strField(o, p, 'src', e);
  strField(o, p, 'text', e);
});
const eventRow = objRow((o, p, e) => {
  strField(o, p, 'title', e);
  strField(o, p, 'start', e);
  strField(o, p, 'end', e);
  strField(o, p, 'kind', e);
});
const allDayRow = objRow((o, p, e) => {
  strField(o, p, 'title', e);
});
const threadRow = objRow((o, p, e) => {
  strField(o, p, 'bucket', e);
  strField(o, p, 'from', e);
  strField(o, p, 'subject', e);
  strField(o, p, 'why', e);
  if (o.draft !== undefined) boolField(o, p, 'draft', e);
});
const logRow = objRow((o, p, e) => {
  strField(o, p, 't', e);
  strField(o, p, 'agent', e);
  strField(o, p, 'what', e);
});
const counts = (o, p, e) => {
  natField(o, p, 'reply', e);
  natField(o, p, 'decide', e);
  natField(o, p, 'fyi', e);
};
const ideaSuggestionRow = objRow((o, p, e) => {
  posField(o, p, 'number', e);
  strField(o, p, 'project', e, true);
  posField(o, p, 'milestone', e, true);
  strField(o, p, 'newProject', e, true);
  strField(o, p, 'why', e);
});
const focusProposal = (o, p, e) => {
  listField(o, p, 'add', e, strRow);
  listField(o, p, 'remove', e, strRow);
  strField(o, p, 'why', e);
};

const STATE_CHECKS = {
  brief(x, e) {
    if (!objectAt(x, 'brief', e)) return;
    strField(x, 'brief', 'generated', e);
    listField(x, 'brief', 'lines', e, lineRow);
  },
  calendar(x, e) {
    if (!objectAt(x, 'calendar', e)) return;
    if (Object.prototype.hasOwnProperty.call(x, 'error')) {
      if (!isBrokenCalendar(x)) e.push('calendar: a broken calendar must be exactly { "error": "unreadable" } or { "error": "unreadable", "from": "icloud" } or { "error": "unreadable", "from": "google" }');
      return;
    }
    strField(x, 'calendar', 'date', e);
    listField(x, 'calendar', 'events', e, eventRow);
    if (x.allDay !== undefined) listField(x, 'calendar', 'allDay', e, allDayRow);
    if (x.stale !== undefined) boolField(x, 'calendar', 'stale', e);
  },
  inbox(x, e) {
    if (!objectAt(x, 'inbox', e)) return;
    strField(x, 'inbox', 'updated', e);
    objField(x, 'inbox', 'counts', e, counts);
    listField(x, 'inbox', 'threads', e, threadRow);
  },
  log(x, e) {
    listAt(x, 'log', e, logRow);
  },
  proposals(x, e) {
    if (!objectAt(x, 'proposals', e)) return;
    strField(x, 'proposals', 'updated', e);
    if (x.focus !== undefined && x.focus !== null) objField(x, 'proposals', 'focus', e, focusProposal);
    if (x.ideas !== undefined && x.ideas !== null) listField(x, 'proposals', 'ideas', e, ideaSuggestionRow);
  },
};

export function checkState(name, x) {
  return guard((e) => {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(STATE_CHECKS, name)) {
      e.push(`state: unknown file name`);
      return;
    }
    STATE_CHECKS[name](x, e);
  });
}

/* --------------------------------- board --------------------------------- */

const projectRef = (o, p, e) => {
  strField(o, p, 'key', e);
  strField(o, p, 'title', e);
  strField(o, p, 'color', e);
};

const boardMilestone = objRow((o, p, e) => {
  posField(o, p, 'number', e);
  strField(o, p, 'shortTitle', e);
  strField(o, p, 'url', e);
  strField(o, p, 'due', e, true);
  enumField(o, p, 'state', e, ['done', 'overdue', 'open']);
  natField(o, p, 'done', e);
  natField(o, p, 'total', e);
  natField(o, p, 'pct', e);
});

const metaCheck = (o, p, e) => {
  for (const k of ['generatedAt', 'today', 'timezone', 'name', 'greeting', 'agentName', 'repoUrl']) {
    strField(o, p, k, e);
  }
  natField(o, p, 'weekNumber', e);
  objField(
    o,
    p,
    'stale',
    e,
    (s, sp, er) => {
      strField(s, sp, 'since', er);
      strField(s, sp, 'reason', er);
    },
    true,
  );
  boolField(o, p, 'readOnly', e);
  listField(
    o,
    p,
    'sources',
    e,
    objRow((s, sp, er) => {
      strField(s, sp, 'id', er);
      enumField(s, sp, 'state', er, ['ok', 'stale', 'error']);
      strField(s, sp, 'at', er, true);
    }),
  );
  listField(
    o,
    p,
    'warnings',
    e,
    objRow((s, sp, er) => {
      strField(s, sp, 'code', er);
      natField(s, sp, 'count', er);
      if (s.names !== undefined) listField(s, sp, 'names', er, strRow);
    }),
  );
};

const focusCheck = (o, p, e) => {
  listField(o, p, 'projects', e, objRow(projectRef));
  objField(
    o,
    p,
    'proposal',
    e,
    (s, sp, er) => {
      listField(s, sp, 'add', er, strRow);
      listField(s, sp, 'remove', er, strRow);
      strField(s, sp, 'why', er);
      boolField(s, sp, 'stale', er);
    },
    true,
  );
};

const nextRow = objRow((o, p, e) => {
  posField(o, p, 'number', e);
  strField(o, p, 'title', e);
  strField(o, p, 'url', e);
  objField(o, p, 'project', e, projectRef);
  objField(
    o,
    p,
    'milestone',
    e,
    (s, sp, er) => {
      strField(s, sp, 'shortTitle', er);
    },
    true,
  );
  strField(o, p, 'due', e, true);
  enumField(o, p, 'urgency', e, ['overdue', 'dated', 'undated']);
  natField(o, p, 'overdueDays', e);
  // CP4 (R129, R132): optional; absent is today's row.
  if (o.ref !== undefined) strField(o, p, 'ref', e);
  if (o.modes !== undefined) {
    listField(o, p, 'modes', e, objRow((m, mp, er) => {
      strField(m, mp, 'name', er);
      field(m, mp, 'n', er, (v) => isInt(v) && v >= 1 && v <= 8, 'must be a whole number from 1 to 8');
    }));
  }
});

const timelineCheck = (o, p, e) => {
  strField(o, p, 'start', e);
  strField(o, p, 'end', e);
  strField(o, p, 'today', e);
  listField(
    o,
    p,
    'lanes',
    e,
    objRow((l, lp, er) => {
      objField(l, lp, 'project', er, (s, sp, e2) => {
        projectRef(s, sp, e2);
        boolField(s, sp, 'focus', e2);
      });
      listField(l, lp, 'milestones', er, boardMilestone);
      listField(l, lp, 'undated', er, boardMilestone);
      natField(l, lp, 'beforeWindow', er);
      natField(l, lp, 'beyondWindow', er);
    }),
  );
  listField(o, p, 'other', e, boardMilestone);
};

const projectRow = objRow((o, p, e) => {
  strField(o, p, 'key', e);
  posField(o, p, 'number', e);
  strField(o, p, 'title', e);
  strField(o, p, 'url', e);
  strField(o, p, 'color', e);
  boolField(o, p, 'focus', e);
  natField(o, p, 'done', e);
  natField(o, p, 'total', e);
  natField(o, p, 'pct', e);
  boolField(o, p, 'empty', e);
  natField(o, p, 'doing', e);
  natField(o, p, 'overdueMilestones', e);
  objField(
    o,
    p,
    'nextMilestone',
    e,
    (s, sp, er) => {
      strField(s, sp, 'shortTitle', er);
      strField(s, sp, 'due', er, true);
    },
    true,
  );
  listField(
    o,
    p,
    'habits',
    e,
    objRow((h, hp, er) => {
      strField(h, hp, 'id', er);
      strField(h, hp, 'title', er);
      natField(h, hp, 'streak', er);
    }),
  );
  // R134: present only when a task of the project waits on an open blocker.
  if (o.waiting !== undefined) {
    objField(o, p, 'waiting', e, (w, wp, er) => {
      listField(w, wp, 'items', er, (s, sp, e2) => {
        if (!isStr(s)) e2.push(`${sp}: ${W.str}`);
      });
      if (Array.isArray(w.items) && (w.items.length < 1 || w.items.length > 3)) {
        er.push(`${join(wp, 'items')}: must have 1 to 3 entries (has ${w.items.length})`);
      }
      natField(w, wp, 'more', er);
    });
  }
});

const habitRow = objRow((o, p, e) => {
  strField(o, p, 'id', e);
  strField(o, p, 'title', e);
  objField(
    o,
    p,
    'project',
    e,
    (s, sp, er) => {
      strField(s, sp, 'key', er);
      strField(s, sp, 'color', er);
    },
    true,
  );
  natField(o, p, 'streak', e);
  natField(o, p, 'best', e);
  natField(o, p, 'tokens', e);
  natField(o, p, 'toNextToken', e);
  natField(o, p, 'flamesLit', e);
  listField(o, p, 'flames', e, (v, vp, er) => {
    if (!isBool(v)) er.push(`${vp}: ${W.bool}`);
  }, 5);
  natField(o, p, 'toNextFlame', e, true);
  listField(
    o,
    p,
    'recent',
    e,
    objRow((r, rp, er) => {
      strField(r, rp, 'date', er);
      enumField(r, rp, 'status', er, ['done', 'token', 'missed', 'pending', 'before']);
      if (r.score !== undefined) {
        field(r, rp, 'score', er, (v) => typeof v === 'number' && Number.isFinite(v), 'must be a number or null', true);
      }
    }),
    14,
  );
  boolField(o, p, 'doneToday', e);
  // CP6 (R136, R139): present only for a scored habit.
  if (o.score !== undefined) {
    objField(o, p, 'score', e, (s, sp, er) => {
      const range = (v) => isInt(v) && v >= 1 && v <= 10;
      field(s, sp, 'min', er, range, 'must be a whole number from 1 to 10');
      field(s, sp, 'max', er, range, 'must be a whole number from 1 to 10');
      field(s, sp, 'today', er, range, 'must be a whole number from 1 to 10 or null', true);
      if (isInt(s.min) && isInt(s.max) && s.min >= s.max) er.push(`${sp}: min must be less than max`);
    });
  }
});

const ideasCheck = (o, p, e) => {
  natField(o, p, 'count', e);
  natField(o, p, 'shown', e);
  listField(
    o,
    p,
    'items',
    e,
    objRow((r, rp, er) => {
      posField(r, rp, 'number', er);
      if (r.ref !== undefined) strField(r, rp, 'ref', er);
      strField(r, rp, 'title', er);
      strField(r, rp, 'url', er);
      strField(r, rp, 'createdAt', er);
      objField(
        r,
        rp,
        'suggestion',
        er,
        (s, sp, e2) => {
          strField(s, sp, 'project', e2, true);
          strField(s, sp, 'projectTitle', e2, true);
          posField(s, sp, 'milestone', e2, true);
          strField(s, sp, 'milestoneTitle', e2, true);
          strField(s, sp, 'newProject', e2, true);
          strField(s, sp, 'why', e2);
          boolField(s, sp, 'stale', e2);
          boolField(s, sp, 'acceptable', e2);
        },
        true,
      );
    }),
  );
};

const sortTargetRow = objRow((o, p, e) => {
  strField(o, p, 'key', e);
  strField(o, p, 'title', e);
  listField(
    o,
    p,
    'milestones',
    e,
    objRow((m, mp, er) => {
      posField(m, mp, 'number', er);
      strField(m, mp, 'shortTitle', er);
    }),
  );
});

const heatmapCheck = (o, p, e) => {
  listField(
    o,
    p,
    'weeks',
    e,
    (week, wp, er) => {
      listAt(
        week,
        wp,
        er,
        objRow((d, dp, e2) => {
          strField(d, dp, 'date', e2);
          natField(d, dp, 'count', e2, true);
          field(d, dp, 'level', e2, (v) => isInt(v) && v >= 0 && v <= 4, 'must be a whole number from 0 to 4', true);
        }),
        7,
      );
    },
    12,
  );
};

const seasonCheck = (o, p, e) => {
  strField(o, p, 'name', e);
  strField(o, p, 'start', e);
  strField(o, p, 'end', e);
  natField(o, p, 'daysLeft', e);
  enumField(o, p, 'phase', e, ['before', 'running', 'after']);
  listField(
    o,
    p,
    'goals',
    e,
    objRow((g, gp, er) => {
      strField(g, gp, 'title', er);
      natField(g, gp, 'pct', er, true);
    }),
  );
};

const standaloneCheck = (o, p, e) => {
  natField(o, p, 'count', e);
  listField(
    o,
    p,
    'items',
    e,
    objRow((r, rp, er) => {
      posField(r, rp, 'number', er);
      strField(r, rp, 'title', er);
      strField(r, rp, 'url', er);
      strField(r, rp, 'due', er, true);
    }),
  );
};

function isBrokenCalendar(v) {
  const keys = Object.keys(v);
  if (v.error !== 'unreadable') return false;
  if (keys.length === 1) return true;
  return keys.length === 2 && (v.from === 'icloud' || v.from === 'google');
}

function panel(content, allowFrom = false) {
  return (v, path, e) => {
    if (v === null) return;
    if (!objectAt(v, path, e)) return;
    if (Object.prototype.hasOwnProperty.call(v, 'error')) {
      const keys = Object.keys(v);
      if (!(keys.length === 1 && v.error === 'unreadable') && !(allowFrom && isBrokenCalendar(v))) {
        e.push(`${path}: an error panel must be exactly { "error": "unreadable" }`);
      }
      return;
    }
    boolField(v, path, 'stale', e);
    content(v, path, e);
  };
}

const PANELS = {
  brief: panel((o, p, e) => {
    strField(o, p, 'generated', e);
    listField(o, p, 'lines', e, lineRow);
  }),
  calendar: panel((o, p, e) => {
    strField(o, p, 'date', e);
    strField(o, p, 'now', e);
    listField(o, p, 'events', e, eventRow);
    if (o.allDay !== undefined) listField(o, p, 'allDay', e, allDayRow);
  }, true),
  inbox: panel((o, p, e) => {
    objField(o, p, 'counts', e, counts);
    listField(o, p, 'threads', e, threadRow);
  }),
  log: panel((o, p, e) => {
    listField(o, p, 'entries', e, logRow);
  }),
};

const panelsCheck = (o, p, e) => {
  for (const [k, fn] of Object.entries(PANELS)) {
    const path = join(p, k);
    if (o[k] === undefined) {
      e.push(`${path}: is required`);
      continue;
    }
    fn(o[k], path, e);
  }
};

export function checkBoard(x) {
  return guard((e) => {
    if (!objectAt(x, 'board', e)) return;
    const top = (k, fn) => {
      if (!objectAt(x[k], k, e)) return;
      fn(x[k], k, e);
    };
    top('meta', metaCheck);
    top('focus', focusCheck);
    listAt(x.next, 'next', e, nextRow);
    // CP4 (R132, R76): the top-level modes list, present only when the settings name modes.
    if (x.modes !== undefined) {
      listAt(x.modes, 'modes', e, objRow((m, mp, er) => {
        field(m, mp, 'n', er, (v) => isInt(v) && v >= 1 && v <= 8, 'must be a whole number from 1 to 8');
        strField(m, mp, 'name', er);
        field(m, mp, 'color', er, (v) => isStr(v) && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v), 'must be #RGB or #RRGGBB');
      }));
    }
    top('timeline', timelineCheck);
    listAt(x.projects, 'projects', e, projectRow);
    listAt(x.habits, 'habits', e, habitRow);
    top('ideas', ideasCheck);
    listAt(x.sortTargets, 'sortTargets', e, sortTargetRow);
    top('heatmap', heatmapCheck);
    if (x.season === undefined) e.push('season: is required');
    else if (x.season !== null) top('season', seasonCheck);
    top('standalone', standaloneCheck);
    top('panels', panelsCheck);
  });
}
