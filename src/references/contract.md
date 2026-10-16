# Board-model contract

This file is the single description of what the board reads, what it shows and what it does.
Every behaviour is one numbered rule, and every rule has a check someone can run.
Code that disagrees with this file is wrong; a rule that turns out wrong is changed here first, then in code.

## How to run a check

Run everything from the repository root.

- All checks: `node --test "test/*.test.mjs"`
- Named rules, failing when a named rule has no test: `node scripts/rules.mjs 17 18 S3`

Every test name starts with the ID of the rule it proves and a space (`R17 …`, `S3 …`), or with `U ` for a helper test that proves no rule.
`test/contract-coverage.test.mjs` fails when a rule R1 to R164 or S1 to S8 has no test, or a test names a rule that is not in this file.
Each check below is written as "Given … expect …"; the test builds the "given" with `fixtures/build.mjs` unless a fixture file is named.

## Words

- **Data repo**: the user's one private GitHub repository that holds every issue, every milestone, the settings file, the theme file and the agent state files.
- **Project**: one GitHub Project (the current Projects, not the classic ones) owned by the same account or organisation as the data repo.
A project may name another `owner` in the settings, and then it is found by its owner and its number together.
- **Home repo**: an optional repository that a project names in the settings as `home`; the project's cards and goals live there instead of in the data repo.
- **Card ref**: the identity of one card, `<owner>/<repo>#<n>` on GitHub; a card is known by its ref, never by its number alone.
- **Short ref**: what a form and a board row carry for a card: the bare number when the card is in the data repo, otherwise the full card ref.
- **Task**: an issue that is not a check-in, not an idea and not ignored.
- **Standalone task**: a task that is an item of no shown project.
- **Idea**: an issue carrying the idea label; when the settings name an Ideas Project, an open card that is an item of that Project.
- **Check-in**: an issue carrying a habit label; it records one habit on one day.
A check-in of a habit with a `score` also carries a score.
- **Work mode**: a label that the settings name in `modes`, shown as a small coloured chip.
- **Shown project**: a project listed in the settings file and found open on GitHub.
- **Board timezone**: `timezone` in the settings file. "Today" always means the calendar date there.
- **Agent**: any outside program that writes state files into the data repo. The board runs without one.

## Where things live

| Thing | Home | Who writes it |
| --- | --- | --- |
| Issues, milestones, Projects, labels | GitHub (or Notion, when `BOARD_BACKEND` says so) | the user, setup, the board's five actions, an agent |
| `board.config.json` (settings) | data repo root | setup, the user, an agent on the user's say |
| `theme.json` | data repo root | the user |
| `state/brief.json`, `state/calendar.json`, `state/inbox.json`, `state/log.json`, `state/proposals.json` | the data repo for a GitHub board, or `<config dir>/state/` when the board is started with `BOARD_CONFIG_DIR` (every Notion board) | an agent, or the Glitch feed (R161) |
| Tokens (GitHub, one per owner; Notion), the form key, the back-end, repo name, port, mode, allowed hosts | environment variables of the running board | whoever deploys it |
| iCloud sign-in (optional, R102) | environment variables of the running board | whoever deploys it |
| Google Calendar secret addresses (optional, R119), one per calendar | environment variables of the running board; never the settings file, the data repo or GitHub | whoever deploys it |
| Today's calendar events, when read from iCloud (R96) | iCloud; a copy in the last good read | the user, in their own calendar; the board only reads |
| Today's calendar events, when read from Google (R118) | Google; a copy in the last good read | the user, in their own calendar; the board only reads |
| The agent's `state/calendar.json`, shown beside iCloud's events when `calendar.includeFile` is on (R109 to R115) | data repo | an agent only |
| Last good read | the board's own data directory | the board |

### Deployment values (environment variables)

| Name | Meaning | Default |
| --- | --- | --- |
| `BOARD_BACKEND` | `github` or `notion`; any other value refuses start (R142) | `github` |
| `BOARD_GITHUB_TOKEN` | the GitHub token for the data repo's owner; never stored anywhere else | none; required with `github` |
| `BOARD_GITHUB_TOKEN_1` to `BOARD_GITHUB_TOKEN_5` | the GitHub token for the owner named in the matching `BOARD_GITHUB_OWNER_<n>` (R131) | none; each optional; ignored with a warning when its partner is missing |
| `BOARD_GITHUB_OWNER_1` to `BOARD_GITHUB_OWNER_5` | the GitHub login that the matching `BOARD_GITHUB_TOKEN_<n>` serves | none; each optional |
| `BOARD_NOTION_TOKEN` | the Notion token, with `notion` | none; required with `notion` |
| `BOARD_FORM_KEY` | the key that signs forms, at least 32 characters, no whitespace (R130) | none; required when no GitHub token is set, otherwise derived from the default GitHub token |
| `BOARD_REPO` | data repo as `owner/name` | none; required with `github` only |
| `BOARD_MODE` | `local`, `proxy` or `hosted`; `hosted` behaves exactly as `proxy` | `local` |
| `BOARD_HOST` | address to bind | `127.0.0.1` in `local`, `0.0.0.0` otherwise |
| `BOARD_PORT` (or `PORT`) | port | `8787` |
| `BOARD_ALLOWED_HOSTS` | comma-separated `Host` values the board answers to | `localhost:<port>,127.0.0.1:<port>` |
| `BOARD_IDENTITY_HEADER` | header the login in front sets on every request it lets through | none; required outside `local` |
| `BOARD_DATA_DIR` | folder for the last good read | `.board-data` beside the server |
| `BOARD_READ_ONLY` | `1` switches the five actions off | off |
| `BOARD_CONFIG_DIR` | read settings, theme and state from this local folder instead of the data repo (development and tests; required with `notion`) | none |
| `BOARD_ICLOUD_USER` | the Apple Account sign-in for the calendar (R96, R102) | none; set together with the next one or not at all |
| `BOARD_ICLOUD_APP_PASSWORD` | an app-specific password for that account, never the account's own password | none |
| `BOARD_GOOGLE_ICAL_1` to `BOARD_GOOGLE_ICAL_5` | the secret address in iCal format of the first to the fifth calendar listed in the settings, for `source` `google` (R119); a secret, never written to a file inside a repository | none; each optional and independent |
| `BOARD_PROXY_SECRET` | a secret the login proxy sends on every request as `X-Board-Proxy-Secret`; when set, the board refuses any request without it (R107) | none; at least 32 characters, no whitespace |

## Shapes

Field names are exact.
A field marked optional may be absent; every other field is required.
Examples are shortened: a list shows one entry where the real thing has many.

### Settings: `board.config.json`

```json
{
  "version": 1,
  "name": "Sam",
  "timezone": "Europe/Brussels",
  "weekStart": "monday",
  "agentName": "Agent",
  "projects": [
    { "key": "house", "number": 3, "color": "#7FE7D3", "owner": "sam-life", "home": "sam-life/house" },
    { "key": "side", "number": 4 }
  ],
  "modes": ["DO", "THINK", "REVIEW", "LAUNCH"],
  "ideas": { "owner": "sam-life", "number": 20 },
  "habitsProject": { "owner": "sam-life", "number": 21 },
  "focus": ["house"],
  "labels": { "idea": "idea", "habitPrefix": "habit:", "ignore": ["weekly-review"] },
  "habits": [
    { "id": "move", "title": "Move", "start": "2026-10-12", "project": "house", "score": { "min": 1, "max": 10 } }
  ],
  "streak": { "tokenEvery": 6, "flameTiers": [1, 3, 7, 14, 21] },
  "next": { "count": 5 },
  "season": {
    "name": "Autumn",
    "start": "2026-10-12",
    "end": "2026-12-31",
    "goals": [{ "title": "Finish the kitchen", "project": "house" }]
  },
  "refresh": { "dailyAt": "05:00" },
  "calendar": { "source": "icloud", "calendars": [{ "name": "Home", "kind": "personal" }, { "name": "Work" }], "includeFile": false }
}
```

Hard values: a settings file that breaks one of these is invalid as a whole (R72).

- `version` is 1; `name` is a string; `timezone` is a zone the runtime knows.
- `projects` is a list; each `key` matches `^[a-z0-9-]{1,30}$` and is unique; each `number` is a positive whole number, and the pair (`owner`, `number`) is unique; `number` alone no longer has to be.
- `focus` is a list of strings; it may be empty.
- `habits`, when present, is a list; each `id` matches `^[a-z0-9-]{1,30}$` and is unique; each `title` is a non-empty string; `start`, when present, is a real date.
- `season`, when present, has a `name`, a real `start` and `end` with `end` not before `start`, and `goals` as a list of objects with a `title`.
- No key named `token`, `secret` or `password` exists at any depth.
- No text anywhere in the file holds `calendar.google.com/calendar/ical/` (R119).

Soft values: a bad one falls back to its default and is flagged (R92).
`modes` (absent: no chips; a list of 1 to 8 label names), `ideas` (absent: the idea label decides, R2), `habitsProject` (required for any habit with `score`; without it a scored habit is a tick habit and adds one to `setting-invalid`), a habit's `score` (absent: a tick habit; otherwise `{ "min", "max" }` of whole numbers with `1 <= min < max <= 10`), a project's `owner` (the data repo's owner) and `home` (absent: R14 title matching), `weekStart` (`monday`), `agentName` (`Agent`), `labels.idea` (`idea`), `labels.habitPrefix` (`habit:`), `labels.ignore` (`["weekly-review"]`), `streak.tokenEvery` (6; a whole number from 2 to 30), `streak.flameTiers` (`[1, 3, 7, 14, 21]`; exactly five rising positive whole numbers), `next.count` (5; a whole number from 1 to 10), `refresh.dailyAt` (`05:00`; `HH:MM`), a project's `color`, a habit's `project`, a goal's `project`.
The `calendar` block is optional and soft as a whole (R104): `source` is `icloud` or `google` (R118); `calendars` lists up to 20 calendars by `name` (up to 5 for `google`), each with an optional `kind` (`meeting`, `focus`, `personal` or `habit`; `meeting` when absent).
With `google` the `name` is a label of the person's choice and the entry holds no address; the address of the n-th entry is in the environment (R119).
`calendar.includeFile` is optional and soft: `true` or `false`, `false` when absent; a value that is neither adds one to `setting-invalid` and reads as `false` (R109).
The order of `projects` is the user's own order.

### Theme: `theme.json`

```json
{
  "colors": {
    "ground": "#E9ECEF", "dot": "#D3D8DE", "card": "#FFFFFF", "border": "#D5D9DE",
    "ink": "#111418", "muted": "#5B6470", "faint": "#7A8390",
    "agentBg": "#111418", "agentInk": "#F1F3F5",
    "accent": "#D4F25A", "hot": "#FF5B1F", "hotInk": "#B23A0A", "ok": "#2F9E6B"
  },
  "projectColors": ["#7FE7D3", "#FFC94D", "#C9B6FF", "#FF9E80", "#8FB8FF", "#B7E38A"],
  "fonts": {
    "source": "google",
    "heading": "Bricolage Grotesque",
    "body": "Geist",
    "mono": "Geist Mono"
  },
  "radius": 20
}
```

The values above are the defaults; the whole file is optional, and so is every key in it.
Every value is soft: a bad colour (R76), an empty or bad `projectColors`, a bad font name (R84), a `fonts.source` other than `google` or `system`, or a `radius` that is not a whole number from 0 to 40 falls back to its default.

### Raw: the board snapshot the reader hands the model

```json
{
  "fetchedAt": "2026-10-12T06:10:00Z",
  "partial": { "issues": false, "items": false },
  "repo": "sam-life/life",
  "repoPrivate": true,
  "ownerType": "organization",
  "issues": [
    {
      "number": 12, "title": "Paint the hallway", "state": "open", "state_reason": null,
      "is_pr": false, "labels": ["home"], "milestone": 5,
      "created_at": "2026-09-30T08:00:00Z", "updated_at": "2026-10-01T08:00:00Z", "closed_at": null,
      "html_url": "https://github.com/sam-life/life/issues/12"
    }
  ],
  "milestones": [
    {
      "number": 5, "title": "House · Hallway", "state": "open",
      "due_on": "2026-10-20T07:00:00Z", "closed_at": null,
      "html_url": "https://github.com/sam-life/life/milestone/5"
    }
  ],
  "projects": [
    {
      "number": 3, "title": "House", "closed": false,
      "url": "https://github.com/orgs/sam-life/projects/3",
      "items": [{ "type": "Issue", "repo": "sam-life/life", "number": 12, "status": "In Progress", "due": "2026-10-18" }]
    }
  ]
}
```

The snapshot is back-end neutral, and every field added for the redesign is optional: a field that is absent means the old behaviour.

- `ownerType` is `organization` or `user`, read from GitHub, never from settings.
- `issues[].labels` are label names; `milestone` is a milestone number or `null`.
- `projects` holds the Projects listed in settings that GitHub returned, each with its items; a Project not listed in settings is not read.
- `items[].type` is `Issue`, `PullRequest`, `DraftIssue` or `REDACTED`; `repo`, `number`, `status` and `due` may be `null`; `due` is the item's value in the Project's `Due` date field as `YYYY-MM-DD`.
- How the reader fills a Project (observed on live GitHub, V1, V2 and V5): `closed` is true when GitHub's `state` for the Project is `closed`; `url` is built from the owner type, the owner and the number (`https://github.com/orgs/<owner>/projects/<n>` or `https://github.com/users/<owner>/projects/<n>`) and is never taken from a response.
- For the items, the reader first asks the Project for its fields, finds the ones named `Status` and `Due`, and lists the items naming those two field ids; without them GitHub returns an item's title only. `status` is the name of the chosen Status option, `due` is the first ten characters of the `Due` value (GitHub sends a timestamp), and a Project without one of the two fields gives `null` for it on every item.

- Optional top-level fields: `source` is `github` or `notion` (absent: `github`; it feeds `meta.sources[0].id` and the tag of R88).
- `repos` lists `{ "repo": "owner/name", "private": true|false, "role": "data"|"home" }` for every repo read on the last full read (absent: only the data repo, from `repoPrivate`).
- `owners` lists `{ "owner": "login", "ok": true }` or `{ "owner": "login", "ok": false, "reason": "<closed code>" }` (absent: one owner, all ok).
- `labelColors` is an object from a lower-cased label name to `#rrggbb`; the first home repo in settings order wins a name clash (absent: no colours known).
- Optional issue fields: `repo` (`owner/name`; absent: the data repo), `ref` (the card ref; absent: the data repo and the number), and `waitingOn`, a list of `{ "ref", "title" | null, "url" | null }` of open blockers only (absent or empty: not waiting).
- Optional milestone field: `repo` (`owner/name`; absent: the data repo). A goal is the pair (`repo`, `number`).
- Optional project fields: `owner` (login), and `role`, `ideas` or `habits`, for the Ideas and Habits Projects, which settings never list in `projects`.
- Optional item fields: `ref` (the card ref; absent: built from `repo` and `number`) and `score` (a number or `null`; only the Habits Project's `Score` field fills it).
- An optional field of the wrong type is ignored and counted in `row-skipped` like any bad row (R5).

The model takes exactly six inputs: `raw`, `settings`, `theme`, `state`, `now` (an instant) and `run`.
`run` is `{ "stale": null | { "since": "<instant>", "reason": "<plain words>" }, "readOnly": false, "warnings": [{ "code": "theme-unreadable", "count": 1 }] }` and carries what only the running board knows.
A warning whose code is one of the six `calendar-google-…` codes (R125) also carries `names`, a list of the settings names of the calendars it counts, in the order of the settings; no other warning carries `names`.
The model reads no clock, no file, no network and no environment.

### State files (agent-written, all optional)

```json
{
  "brief": { "generated": "2026-10-12T06:00:00+02:00", "lines": [{ "src": "CAL", "text": "4 events today." }] },
  "calendar": { "date": "2026-10-12", "source": "Work diary", "events": [{ "title": "Standup", "start": "08:30", "end": "08:45", "kind": "meeting" }],
    "allDay": [{ "title": "Day off" }] },
  "inbox": {
    "updated": "2026-10-12T07:45:00+02:00",
    "counts": { "reply": 4, "decide": 2, "fyi": 11 },
    "threads": [{ "bucket": "reply", "from": "Accountant", "subject": "Q3 documents", "why": "Asked a direct question", "draft": true }]
  },
  "log": [{ "t": "06:00", "agent": "brief-agent", "what": "Wrote this morning's brief" }],
  "proposals": {
    "updated": "2026-10-12T06:00:00+02:00",
    "focus": { "add": ["side"], "remove": [], "why": "Two milestones fall due this week" },
    "ideas": [{ "number": 41, "project": "house", "milestone": 5, "newProject": null, "why": "Same room as the hallway work" }]
  }
}
```

Each top-level key is one file under `state/` in the data repo (`state/brief.json` and so on).
The model receives `state` with a key per file: the parsed value, `null` when the file is absent, or `{ "error": "unreadable" }` when it is present but is not valid JSON or is larger than 256 KB.
`log` is written newest first.
`calendar` may carry an optional `allDay` (a list of all-day events, each with a `title`) and an optional `stale` (a boolean); the board sets it itself when it shows iCloud events it could not refresh (R101) or Google events it could not refresh (R124).
A thread of `inbox` may carry an optional `account`, a short label for the mailbox it came to, never an address (R117).
`calendar` may also carry an optional `source`, a short label for where the file's events come from; it is used only when the file is shown beside iCloud's or Google's events (R112, R127).
When the settings name iCloud calendars, the `calendar` value comes from iCloud and the file is not used (R96), unless `calendar.includeFile` is on (R109 to R115).

### Board: what the model returns

```json
{
  "meta": {
    "generatedAt": "2026-10-12T06:10:05Z", "today": "2026-10-12", "timezone": "Europe/Brussels",
    "name": "Sam", "greeting": "Good morning", "weekNumber": 42, "agentName": "Agent",
    "repoUrl": "https://github.com/sam-life/life",
    "stale": null, "readOnly": false,
    "sources": [{ "id": "github", "state": "ok", "at": "2026-10-12T06:10:00Z" }],
    "warnings": [{ "code": "milestone-unmatched", "count": 1 }]
  },
  "focus": {
    "projects": [{ "key": "house", "title": "House", "color": "#7FE7D3" }],
    "proposal": { "add": ["side"], "remove": [], "why": "Two milestones fall due this week", "stale": false }
  },
  "next": [
    {
      "number": 12, "title": "Paint the hallway", "url": "https://github.com/sam-life/life/issues/12",
      "project": { "key": "house", "title": "House", "color": "#7FE7D3" },
      "milestone": { "shortTitle": "Hallway" },
      "due": "2026-10-18", "urgency": "dated", "overdueDays": 0
    }
  ],
  "timeline": {
    "start": "2026-09-01", "end": "2026-11-30", "today": "2026-10-12",
    "lanes": [
      {
        "project": { "key": "house", "title": "House", "color": "#7FE7D3", "focus": true },
        "milestones": [
          { "number": 5, "shortTitle": "Hallway", "url": "https://github.com/sam-life/life/milestone/5",
            "due": "2026-10-20", "state": "open", "done": 1, "total": 3, "pct": 33 }
        ],
        "undated": [
          { "number": 8, "shortTitle": "Someday", "url": "https://github.com/sam-life/life/milestone/8",
            "due": null, "state": "open", "done": 0, "total": 2, "pct": 0 }
        ],
        "beforeWindow": 0, "beyondWindow": 0
      }
    ],
    "other": [
      { "number": 9, "shortTitle": "Garden · Beds", "url": "https://github.com/sam-life/life/milestone/9",
        "due": "2026-11-02", "state": "open", "done": 0, "total": 1, "pct": 0 }
    ]
  },
  "projects": [
    {
      "key": "house", "number": 3, "title": "House", "url": "https://github.com/orgs/sam-life/projects/3",
      "color": "#7FE7D3", "focus": true, "done": 1, "total": 3, "pct": 33, "empty": false, "doing": 1,
      "overdueMilestones": 0, "nextMilestone": { "shortTitle": "Hallway", "due": "2026-10-20" },
      "habits": [{ "id": "move", "title": "Move", "streak": 9 }]
    }
  ],
  "habits": [
    {
      "id": "move", "title": "Move", "project": { "key": "house", "color": "#7FE7D3" },
      "streak": 9, "best": 12, "tokens": 1, "toNextToken": 3,
      "flamesLit": 3, "flames": [true, true, true, false, false], "toNextFlame": 5,
      "recent": [{ "date": "2026-09-29", "status": "done" }],
      "doneToday": false
    }
  ],
  "ideas": {
    "count": 12, "shown": 12,
    "items": [
      { "number": 41, "title": "Shelves for the hallway", "url": "https://github.com/sam-life/life/issues/41",
        "createdAt": "2026-10-11",
        "suggestion": { "project": "house", "projectTitle": "House", "milestone": 5, "milestoneTitle": "Hallway",
          "newProject": null, "why": "Same room as the hallway work", "stale": false, "acceptable": true } }
    ]
  },
  "sortTargets": [{ "key": "house", "title": "House", "milestones": [{ "number": 5, "shortTitle": "Hallway" }] }],
  "heatmap": { "weeks": [[{ "date": "2026-07-27", "count": 2, "level": 2 }]] },
  "season": { "name": "Autumn", "start": "2026-10-12", "end": "2026-12-31", "daysLeft": 80, "phase": "running",
    "goals": [{ "title": "Finish the kitchen", "pct": 33 }] },
  "standalone": {
    "count": 1,
    "items": [{ "number": 30, "title": "Renew passport", "url": "https://github.com/sam-life/life/issues/30", "due": null }]
  },
  "panels": {
    "brief": { "stale": false, "generated": "06:00", "lines": [{ "src": "CAL", "text": "4 events today." }] },
    "calendar": { "stale": false, "date": "2026-10-12", "now": "08:10",
      "events": [{ "title": "Standup", "start": "08:30", "end": "08:45", "kind": "meeting" }] },
    "inbox": { "stale": false, "counts": { "reply": 4, "decide": 2, "fyi": 11 },
      "threads": [{ "bucket": "reply", "from": "Accountant", "subject": "Q3 documents", "why": "Asked a direct question", "draft": true }] },
    "log": { "stale": false, "entries": [{ "t": "06:00", "agent": "brief-agent", "what": "Wrote this morning's brief" }] }
  }
}
```

- `focus.proposal`, an idea's `suggestion`, `season`, `nextMilestone` and each panel may be `null`.
- A panel is `null` (off), `{ "error": "unreadable" }`, or its content with `stale`; the calendar's broken panel alone may also carry `"from": "icloud"` (R101) or `"from": "google"` (R124).
- The calendar panel carries `allDay` (a list of `{ "title": "…" }`) only when there is at least one all-day event today.
- Only a merged calendar panel (R110) carries `"merged": true`, a `source` word on every event and every `allDay` entry (R112), and, when R114 applies, `"fileDate": "YYYY-MM-DD"` together with `"fileSource"`, the file's source word (R112); any other calendar panel has none of these four keys.
- `meta.sources` holds one entry for `github` (`ok` or `stale`) and one for each panel that is not `null` (`calendar`, `inbox`, `brief`, `log`; each `ok`, `stale` or `error`).
- `recent[].status` is `done`, `token`, `missed`, `pending` or `before`; `recent` always has 14 entries.
- `heatmap.weeks` always has 12 weeks of 7 days; a day after today is `{ "date": "…", "count": null, "level": null }`.
- A milestone's `state` is `done`, `overdue` or `open`; `next[].urgency` is `overdue`, `dated` or `undated`.
- `season.phase` is `before`, `running` or `after`.
- `board/shape-data.mjs` validates raw, state and board, including those list lengths; `board/shape-settings.mjs` validates settings and theme. The model's output and the page fixtures both pass the board validator.

## Rules

### Reading the input

**R1. A pull request is never an issue.**
A raw issue with `is_pr: true` is dropped before any other rule runs; it appears nowhere on the board and in no count.
Check: given a board with tasks, and the same input plus a pull request that is open, sits in a milestone, is an item of a shown project and carries the idea label, expect the two boards to be equal, the first to be non-empty, and the pull request's number nowhere in the second.

**R2. Every issue has exactly one kind.**
Ignored if it carries a label listed in `labels.ignore`; otherwise check-in if it carries a label starting with the habit prefix; otherwise idea if it carries the idea label; otherwise task.
Labels are compared trimmed and case-insensitively.
An ignored issue appears nowhere except the 12-week map.
When `settings.ideas` names a Project, an open or closed issue that is an item of that Project is an idea instead, and the idea label then no longer makes an idea.
Check: given an issue with both `habit:move` and `idea`, expect a check-in only; given `IDEA ` (upper case, trailing space), expect an idea; given an open issue labelled `weekly-review`, expect it in no list and no count.
Check: given `settings.ideas` naming a Project, an issue without the idea label that is an item of it and an issue labelled `idea` that is not, expect the first an idea and the second a task.

**R3. A check-in that cannot be read is ignored, never promoted.**
A check-in for a habit that is not in settings is ignored without a warning (a retired habit is normal).
A check-in for a known habit whose title does not end in ` · YYYY-MM-DD` with a real calendar date counts for nothing and adds one to the `checkin-unreadable` warning.
Check: given a check-in labelled `habit:ghost` and one for a known habit titled `Move · 2026-02-30`, expect `checkin-unreadable` at 1 and neither issue among tasks, ideas or habit days.

**R4. Only issues of the data repo count as project items.**
A project item of type `PullRequest` or `DraftIssue`, or of another repository, is ignored; a `REDACTED` item is ignored and adds one to the `items-hidden` warning.
When a shown project has a `home`, an `Issue` item of that project counts whatever repo it is in, and its card is built from the item's issue.
Two cards are the same only when their refs are equal: `a/x#5` and `a/y#5` are two cards.
Check: given a shown project with two real tasks and one item of each ignored sort, expect `total` 2 and `items-hidden` at 1.
Check: given a shown project with a `home` and an `Issue` item in that home repo, expect it counted with its card built from the item's issue; given items `a/x#5` and `a/y#5`, expect two cards.

**R5. Odd data never takes the board down.**
A row with a missing or wrongly typed field is skipped and adds one to `row-skipped`.
A part of the board that fails while being built is left empty with a `part-failed` warning.
The model never throws for inputs that are objects.
Check: given `fixtures/raw/broken.json` (four bad issues, two bad milestones, three bad items among good rows), expect a valid board, `row-skipped` at 9, and the good rows counted.

**R129. A card is known by its ref, never by its number alone.**
A card's ref is `<owner>/<repo>#<n>` and its short ref is the bare number when the card is in the data repo, otherwise the full ref.
Forms, URL targets and board rows carry the short ref, and a bare number therefore always means a card in the data repo.
Check: given two home repos each holding an open task `#5` on two shown projects, expect two seats in What's next, two forms with different targets, and closing one sends exactly one close, to the right repo.

**R142. One back-end, chosen by the environment.**
`BOARD_BACKEND` is `github` (the default) or `notion`; any other value refuses start with one plain sentence.
Check: given `gitlab`, expect a refusal naming the two choices.

**R150. The model never knows its back-end.**
Nothing after `prepare` reads `source` except `meta` (R88).
Check: given the source files of every stage and render module, expect none to import from `board/github/` or `board/notion/`.

### Projects

**R6. The board shows the projects listed in settings and found open on GitHub.**
A listed number that GitHub did not return is left out with a `project-missing` warning; a listed project that is closed is left out with `project-closed`.
A listed project is found by its owner and its number together; `owner` defaults to the data repo's owner.
A project whose owner could not be read (R67) is left out with a `project-owner-unreadable` warning, not `project-missing`.
Check: given settings listing numbers 3, 4 and 99 with 4 closed, expect one shown project and one of each warning.
Check: given a project listed with another `owner` whose owner could not be read, expect it left out with `project-owner-unreadable` at 1 and `project-missing` absent; given number 3 listed under owners a and b with only a's returned, expect b's left out with `project-missing`.

**R7. A Project that settings do not list does not exist for the board.**
It is not read, and items of it give an issue no project.
The Ideas Project and the Habits Project, when the settings name them, are read but are never shown projects.
Check: given a task that is only an item of unlisted project 7 (present in raw), expect no project 7 in `projects`, `timeline` or `sortTargets`, and the task under `standalone`.
Check: given settings naming an Ideas Project and a Habits Project, expect neither in `projects`, `timeline` or `sortTargets`.

**R8. Projects are ordered focus first, then the user's own order.**
Inside each group the order is the order of `projects` in settings; this one order is used for project rows, timeline lanes, sort targets and seats.
Check: given settings order a, b, c, d with focus on c and d, expect c, d, a, b in project rows, lanes and sort targets.

**R9. A project's title and link come from GitHub; its key and colour come from settings and theme.**
The colour is the project's `color` when that is a valid colour (R76), otherwise `projectColors[i mod length]` where `i` is its position in settings.
Two projects with the same number under two owners are two projects.
Check: given the second listed project with no colour, expect the second theme colour, also when focus moves it to first place; given colour `red`, expect the same fallback and `color-invalid` at 1.
Check: given number 3 listed under owners a and b, expect two projects, each with its own title and link.

**R10. A task belongs to every shown project it is an item of.**
It counts in the progress of each; wherever a task needs a single project (a seat in What's next), that is its first project in the order of R8.
Membership is decided by card ref, not by number.
Check: given a task that is an item of a (not focus, listed first) and c (focus), expect both totals to include it and What's next to show it once, under c.
Check: given tasks `a/x#5` and `a/y#5` of which only `a/x#5` is an item of project a, expect project a's total to count one.

**R11. Progress is closed tasks over all tasks.**
`total` is the project's tasks, open and closed; `done` is the closed ones, whatever the close reason; `pct` is `floor(100 × done ÷ total)`.
With no tasks, `pct` is 0 and `empty` is true.
Ideas, check-ins and ignored issues never count, and GitHub's own milestone counters are never read.
Check: given three tasks (one closed as completed, one closed as not planned, one open), one idea and one check-in in a project, expect done 2, total 3, pct 66, empty false; given a project with none, expect `empty` true.

**R12. "Doing" is read from the Project's Status.**
`doing` counts the project's open tasks whose item status equals `In Progress` or `Doing`, case-insensitively.
Check: given statuses `in progress`, `Doing`, `Todo` and `null` on four open tasks, expect doing 2.

**R13. Standalone tasks have their own list and nothing else.**
`standalone` holds the count of open standalone tasks and the first 20 by number; they are in no project's progress and never take a seat in What's next.
Standalone tasks are tasks of the data repo only, because a card in a home repo is always a project item (R4).
Check: given 23 open standalone tasks and two closed ones, expect count 23, 20 items lowest number first, and none of them in `next`.
Check: given a home-repo card that is an item of a shown project, expect it in that project's total and not among `standalone`.

### Milestones and timeline

**R14. A milestone belongs to a project through its title.**
The title is split at the first ` · ` (space, middle dot U+00B7, space); the left part, trimmed and Unicode-normalised, must equal a shown project's title case-insensitively; the right part is the `shortTitle`.
A milestone with no separator or no matching project goes to `timeline.other` with its whole title as `shortTitle`, and adds one to `milestone-unmatched`.
For a project with a `home`, a milestone of the home repo belongs to the project or projects whose tasks sit in it, and its `shortTitle` is its whole title: no separator is needed and none is stripped.
A home-repo milestone with no task goes to `timeline.other`, and `milestone-unmatched` is not raised for it.
Milestones of the data repo keep title matching.
Check: given `house · Hallway`, `House · A · B`, `Hallway` and `Garden · Beds` with one shown project titled `House`, expect the first two in its lane (short titles `Hallway` and `A · B`), two in `other`, and `milestone-unmatched` at 2.
Check: given a project with a `home` and a home-repo milestone titled `Hallway · Paint` that holds one of its tasks, expect it in the lane with `shortTitle` `Hallway · Paint` and no `milestone-unmatched`; given a home-repo milestone with no task, expect it in `other` and no `milestone-unmatched`; given a data-repo milestone `House · Hallway`, expect title matching as before.

**R15. A milestone's progress is counted from its tasks.**
`done`, `total` and `pct` follow R11 over the tasks whose `milestone` is its number, whichever project they are items of.
A task's goal is found by the pair (`repo`, `milestone`) and the milestone's by (`repo`, `number`); a task counts for a milestone only when the two pairs are equal.
Check: given a milestone with two closed tasks, one open task, one idea and one pull request, expect done 2, total 3, pct 66.
Check: given a milestone 5 of repo a/x and a task of repo a/y whose `milestone` is 5, expect that task not counted for it.

**R16. A milestone's date is the UTC calendar date of `due_on`.**
A `null` `due_on` means undated.
Check: given `2026-10-20T07:00:00Z` and `2026-10-20T23:59:59Z`, expect `2026-10-20` for both, with the process timezone set to `Pacific/Kiritimati` and again to `America/Adak`.

**R17. A milestone is done when it is closed on GitHub, or when it has at least one task and none are open.**
Wherever this rule says a milestone's tasks, it means the tasks whose pair (`repo`, `milestone`) equals the milestone's (`repo`, `number`).
Check: given (closed, one open task), (open, two closed tasks), (open, no tasks) and (open, one open task), expect done, done, not done, not done.
Check: given an open milestone 5 of repo a/x with two closed tasks and an open task of repo a/y with milestone 5, expect it done.

**R18. A milestone is overdue when it is not done and its date is before today.**
Due today is not overdue; an undated milestone is never overdue.
Check: given dates yesterday, today and none on three open milestones with open tasks, expect `overdue`, `open`, `open`.

**R19. The timeline shows what is still to do and what was finished lately.**
Per lane: every milestone that is not done, and every done milestone finished within the last 30 days.
A milestone is finished on the day (board timezone) of its own `closed_at` when it is closed, otherwise of the latest `closed_at` among its tasks.
Those with a date go in `milestones`, ordered by date then number; those without go in `undated`, ordered by number.
A milestone's tasks are the tasks whose pair (`repo`, `milestone`) equals the milestone's (`repo`, `number`).
Check: given a milestone due 60 days ago and finished 10 days ago, one finished 45 days ago, an open undated one and an undated one finished yesterday, expect the first in `milestones`, the second absent, and the last two in `undated`.
Check: given an open undated milestone 5 of repo a/x whose only closed task, closed yesterday, has the same pair, and a closed task of repo a/y with milestone 5 closed 40 days ago, expect the finish day taken from the first task alone.

**R20. The timeline window is whole months around today.**
`start` is the first day of the month holding the earlier of (today minus 14 days) and the earliest date in any lane's `milestones`, but never earlier than the first day of the third month before today's month.
`end` is the last day of the month holding the later of (today plus 28 days) and the latest such date, but never later than the last day of the eleventh month after today's month.
A milestone dated before `start` is counted in its lane's `beforeWindow`, one after `end` in `beyondWindow`; neither is drawn.
Check: given today 2026-10-12 and open milestones on 2025-06-10, 2026-09-20 and 2028-01-15, expect start 2026-07-01, end 2027-09-30, `beforeWindow` 1 and `beyondWindow` 1; given only one on 2026-10-20, expect 2026-09-01 to 2026-11-30.

**R21. A project row sums up its milestones.**
`nextMilestone` is its earliest not-done milestone: dated ones first by date, then undated by number; `null` when there is none.
`overdueMilestones` is how many of its milestones are overdue.
A milestone's tasks are the tasks whose pair (`repo`, `milestone`) equals the milestone's (`repo`, `number`).
Check: given not-done milestones dated 2 days ago, in 3 days and in 9 days and one undated, expect the one 2 days ago as next and `overdueMilestones` 1; given only done milestones, expect `null` and 0.
Check: given two milestones with the number 5 in repos a/x and a/y, expect each row's `nextMilestone` and `overdueMilestones` to be computed from its own tasks only.

**R22. A task whose milestone belongs to another project is counted both ways and flagged.**
It counts in its own project's progress (R10) and in the milestone's progress (R15), and adds one to `milestone-crosses-project`.
On the `home` path a milestone shared by the tasks of two projects belongs to both and is not a crossing.
`milestone-crosses-project` is raised only on the title path.
Check: given a task that is an item of project a with a milestone titled for project b, expect it in a's total, in the milestone's total, and the warning at 1.
Check: given a home-repo milestone that holds tasks of projects a and b, expect it in both lanes and `milestone-crosses-project` absent.

### Focus

**R23. Focus is what settings say, and nothing else.**
`focus.projects` is exactly the shown projects whose key is in `focus`, in the order of R8; no data on GitHub adds or removes one.
Check: given settings with focus on two of four projects and five very different raw inputs (all tasks overdue, all closed, no issues at all, only ideas, `broken.json`), expect the same two focus projects every time.

**R24. An unknown focus key is ignored.**
It adds one to `focus-unknown`.
Check: given focus `["house", "nope"]`, expect one focus project and the warning at 1.

**R25. With no focus set, nothing is highlighted.**
`focus.projects` is empty and no project carries `focus: true`; What's next then treats every project alike (R30).
Check: given four projects with tasks and focus `[]`, expect four project rows, none with `focus: true`, and seats dealt across them in settings order.

**R26. An agent's focus proposal is shown, never applied.**
When `state.proposals.focus` is valid it is copied to `focus.proposal` with its `why` and with `stale` from R52; keys that are not shown projects are dropped, and a proposal left with nothing to add or remove is `null`.
Check: given a proposal to add `side` and `nope`, expect `focus.proposal.add` to be `["side"]` and `focus.projects` unchanged; given a proposal naming only `nope`, expect `null`.

### What's next

**R27. Candidates are the open tasks of shown projects.**
Ideas, check-ins, ignored issues and standalone tasks are never candidates.
An open task with at least one open blocker (`waitingOn` not empty) is never a candidate.
Check: given one open issue of each of those sorts and one open project task, expect only the project task in `next`.
Check: given an open project task with one open blocker, expect it absent from `next`.

**R28. Inside a project, tasks are ordered by urgency.**
First overdue tasks (R93), most overdue first, with `urgency` `overdue`; then tasks with a date today or later, soonest first, `dated`; then tasks with no date, `undated`; ties go to the lower issue number.
Check: given tasks dated 5 days ago, 2 days ago, in 3 days, and two with no date numbered 40 and 12, expect that order with 12 before 40.

**R29. Every focus project gets a seat before any gets a second.**
The list has `next.count` seats.
Seats are dealt in rounds over the focus projects in the order of R8: each round gives every focus project its next most urgent task, until the seats are full or the focus projects have no tasks left.
Check: given focus projects a (four tasks) and c (one task) and five seats, expect a1, c1, a2, a3, a4.

**R30. Other projects only fill leftover seats.**
Seats still free after R29 are dealt the same way over the projects that are not in focus.
Check: given focus project a with two tasks, non-focus b and d with three each, and five seats, expect a1, a2, b1, d1, b2.

**R31. A seat says why it is there.**
Each item carries its project, its milestone's short title when it has one, its date (R93) or `null`, `urgency`, and `overdueDays` (0 unless overdue).
Check: given a task dated 2 days ago, expect urgency `overdue` and overdueDays 2; given one with no date, expect `due: null` and overdueDays 0.

**R132. A work mode is a label the settings name, shown as a small coloured chip.**
A task's labels whose names (trimmed, compared case-insensitively) are in `modes` become chips after its title in What's next, in the order of `modes`.
The colour comes from `labelColors` (R76) and otherwise from the theme's `muted`; it is applied by class `mode-<n>` in the nonce style block (R77).
With no `modes`, there is no chip anywhere.
Check: given modes DO and THINK and a task labelled `think` with colour `#1d76db`, expect one chip `THINK` with that colour; given no modes, expect the page equal to the page without the label.

**R133. The board knows which tasks wait on another.**
The reader asks for blocked-by only for open cards whose `issue_dependencies_summary.blocked_by` is above 0, keeps the blockers that are open, and records each as `{ref, title, url}`.
A blocker in a repo the board does not read keeps its ref with `title: null`.
Check: given a card with summary 0, expect no blocked-by request; given one with 2 blockers of which one is closed, expect one entry.

**R134. A waiting task says what it waits on, on its project.**
A task with open blockers is out of What's next (R27), and its project row shows `waiting on: <blocker title or ref>` as a small grey word with the attribute `data-waiting`, at most three per row and then `+n`.
Check: given a blocked task, expect it absent from `next` and present on its project with the blocker's title.

### Ideas

**R32. The backlog is the open ideas, newest first.**
`ideas.count` is all of them; `items` holds the first 20 by creation time, newest first, ties by higher number; `shown` is the length of `items`.
When `settings.ideas` names a Project, the backlog is the open cards that are items of that Project.
Check: given 23 open ideas and 2 closed ones, expect count 23, shown 20, the newest first, and no closed idea.
Check: given `settings.ideas` naming a Project holding two open cards and one closed card, expect count 2 and no closed card.

**R33. An idea is never active.**
An idea counts in no progress, sits in no milestone total, takes no seat in What's next and is never standalone, even when it is an item of a project or has a milestone.
Check: given an idea that is an item of a shown project and sits in a milestone, expect its number under `ideas` and nowhere else in the board.

**R34. An agent's suggestion is shown beside its idea.**
A valid entry in `state.proposals.ideas` for an open idea becomes that idea's `suggestion`, with the project's and milestone's titles filled in where they are known and `stale` from R52.
`acceptable` is true only when the proposals file is not stale, `project` is a shown project, and `milestone` is `null` or one of that project's milestones that is not closed on GitHub; a suggestion naming a new project is never acceptable from the board.
Check: given fresh suggestions naming a shown project, an unknown project and a new project, expect acceptable true, false, false; given the first one in a 30-hour-old file, expect `stale` true and acceptable false.

**R35. A suggestion for something that is no longer an open idea is dropped.**
Check: given suggestions for an open idea, a closed idea, a task and a number that does not exist, expect one suggestion on the board and no trace of the other three numbers under `ideas`.

**R135. Ideas can live on their own Project.**
With `settings.ideas`, an idea is an open card that is an item of that Project, wherever the card lives, and the Ideas Project is never a shown project.
R33 holds for these ideas.
Without the setting, R2's label decides.
Check: given an Ideas Project holding a data-repo issue without the idea label, expect it under `ideas`; given the setting absent, expect the label to decide.

### Habits

**R36. Habits are the ones in settings, in that order.**
A habit may carry `score`; its days then also carry a score (R139).
Check: given two habits in settings with check-ins, and check-ins for a third habit, expect two habits in settings order, each with its own days.
Check: given a habit with `score` and a habit without, expect `score` in the first one's `recent` entries (R139) and in none of the second's.

**R37. A check-in belongs to the day in its title.**
The day is the `YYYY-MM-DD` after the last ` · ` of the title.
Check: given a check-in titled `Move · 2026-10-10`, expect it to count for 2026-10-10 or for no day at all, never for another day.

**R38. A day is done when one of its check-ins was closed on that same day.**
A check-in counts when it is closed and its `closed_at` falls on its own day in the board timezone; an open one, or one closed on another day, does not count; two for one day count once.
Check: given a check-in for 2026-10-10 closed at 21:59Z that day (`Europe/Brussels`), expect done; closed at 22:01Z (already the 11th there), expect not done; given one open and one valid closed check-in for the same day, expect done.

**R39. A habit's days run from its start to today.**
The start is `start` in settings, otherwise the day of its earliest check-in, otherwise today; earlier days have status `before` and count for nothing.
Check: given no `start` and a first check-in four days ago, expect the nine earliest entries of `recent` as `before` and a streak that starts four days ago.

**R40. Streaks, cheat tokens and resets.**
Walking the days from the start to yesterday: a done day adds one to `streak` and one to a run counter, and when the run counter reaches `tokenEvery` one token is earned and the counter returns to zero.
A day not done spends a token when one is held (status `token`: streak and counter stay as they are); with none held the day is `missed` and both streak and counter return to zero.
`toNextToken` is `tokenEvery` minus the counter.
Check: given 6 done, 1 not, 3 done, 1 not, expect statuses 6×done, token, 3×done, missed, and at the end streak 0, tokens 0; stopping one day earlier, expect streak 9, tokens 0, toNextToken 3.

**R41. Today is never missed while it lasts.**
Today done counts like any done day; today not done is `pending` and changes neither streak, counter nor tokens.
Check: given a 4-day streak and today not done, expect streak 4, `doneToday` false and status `pending`; with today done, streak 5 and `doneToday` true.

**R42. `best` is the longest streak ever reached.**
Check: given a streak of 8, a reset and a streak of 3, expect best 8.

**R43. Flames follow the tiers.**
`flamesLit` is the number of tiers at or below the streak; `toNextFlame` is the gap to the next tier, or `null` at the top.
Check: given streaks 0, 1, 6, 7 and 30 with the default tiers, expect 0, 1, 2, 3 and 5 lit, and toNextFlame 1, 2, 1, 7 and `null`.

**R44. `recent` is the last 14 days, oldest first, ending today.**
Check: given a habit started 5 days ago, expect 14 entries of which the first 8 are `before` and the last is today's.

**R45. A habit can join a project.**
A habit whose `project` is a shown project's key carries that project's key and colour and is listed in that project's `habits` with its streak; an unknown key adds one to `habit-project-unknown` and the habit stands alone.
The streak rules are the same either way.
Check: given one linked, one unlinked and one mislinked habit, expect `project` set, `null`, `null`, one entry in that project's `habits`, and the warning at 1.

**R46. Dates never depend on the machine's timezone.**
"Today" is the calendar date in the board timezone at `now`, and all day arithmetic runs on `YYYY-MM-DD` values.
Check: given `fixtures/raw/base.json` and one `now`, expect identical boards with the process timezone set to `Pacific/Kiritimati`, `America/Adak` and `UTC`; given `now` = 2026-10-12T22:30:00Z, expect today 2026-10-13 for `Europe/Brussels` and 2026-10-12 for `America/New_York`.

**R136. A scored habit reads its score from the Habits Project.**
A check-in of a habit with `score` that is an item of the Habits Project carries that item's `Score`, a number from `min` to `max`.
A `Score` that is not a number from `min` to `max` is ignored, and a score that is not a number adds one to `score-invalid`.
Check: given scores 7, 11 and `null`, expect 7, none with `score-invalid` at 1, and none.

**R137. A score makes the day done.**
A day of a scored habit is done by R38, that is by a closed check-in on that day.
Its score is the score of that check-in, or of the latest-updated one when there are two.
Check: given two closed check-ins for one day scored 6 and then 8 (the later updated), expect the day done with score 8.

**R138. A scored day is shaded by its score.**
In the 14-day strip, a done day of a scored habit carries a level as the class `day--s<level>`: scores 1 to 3 give level 1, 4 to 5 give 2, 6 to 7 give 3 and 8 to 10 give 4, and a higher level is darker.
The score shows on hover and on focus through a `title` and a visually hidden text, never through script.
Check: given scores 2, 5, 7 and 9, expect levels 1, 2, 3 and 4.

**R139. A scored habit's `recent` days carry their score.**
`recent[]` gains `score` (a number or `null`) for a scored habit only.
A tick habit's `recent` is unchanged.
Check: given one scored and one tick habit, expect `score` on every entry of the first one's `recent` and on none of the second's.

### Last 12 weeks and season

**R47. The 12-week map counts what was closed each day.**
It covers 12 whole weeks ending with the current one, each week starting on `weekStart`; a day's `count` is the issues of any kind (never pull requests) now closed whose `closed_at` falls on that day in the board timezone.
`level` is 0 for 0, 1 for 1, 2 for 2 to 3, 3 for 4 to 5, 4 for 6 or more.
It counts every card the board read: the data repo's issues and the cards of every home repo that are project items, each counted once by ref.
Check: given closes at 21:30Z and 22:30Z on 2026-10-12 with `Europe/Brussels` and `now` on 2026-10-14, expect one on the 12th and one on the 13th; given counts 0, 1, 3, 5, 6, expect levels 0, 1, 2, 3, 4; expect 12 weeks of 7 with `count` and `level` `null` on every day after the 14th.
Check: given the same close on cards `a/x#5` and `a/y#5` on one day, expect two on that day; given one card read twice, expect it counted once.

**R48. The season counts down and borrows its goals' progress.**
`daysLeft` is the days from today to `end`, never below 0; `phase` is `before`, `running` or `after`; a goal whose `project` is a shown project shows that project's `pct`; a goal with no project, or an unknown one (which adds one to `goal-project-unknown`), shows `pct: null`.
Check: given a season ending in 80 days with one linked, one unlinked and one mislinked goal, expect daysLeft 80, `running`, pcts 33, `null`, `null` and the warning at 1; given no season in settings, expect `season: null`.

### Panels that switch on

**R49. A panel exists only when its state file exists.**
With a state key `null` the panel is `null`, it has no entry in `meta.sources`, and the page has no section for it.
The calendar is the one panel with a second way in: the board's own reading of iCloud (R96) or of Google (R118), which fills the same state key.
Check: given all four state keys `null`, expect four `null` panels, one source (`github`), and no `data-section` of `brief`, `calendar`, `inbox` or `log` in the page; given all four present, expect four panels, five sources and those four sections.

**R50. A broken state file shows as broken, not as empty.**
A value that is `{ "error": "unreadable" }` or fails its shape gives a panel `{ "error": "unreadable" }` and a source in state `error`; the rest of the board is unaffected.
Check: given `brief` unreadable and `inbox` with a wrong shape, expect both panels in the error state and `projects` equal to the board built without them.

**R51. Panels are capped.**
Brief: at most 5 lines of at most 200 characters; calendar: at most 30 events and at most 10 all-day events, whose `kind` is `meeting`, `focus`, `personal` or `habit`, and any other `kind` reads as `meeting`; inbox: at most 30 threads, a thread with an unknown `bucket` is dropped; log: the first 10 entries of the file.
Longer text is cut and ends with an ellipsis.
Check: given 8 brief lines (one of 300 characters), 40 events, 50 threads and 25 log entries, expect 5, 30, 30 and 10, the long line cut to 200 characters, and the log's first entry unchanged; given 14 all-day events (one with a title of 300 characters), expect 10, that title cut to 200 characters; given none, expect no `allDay` key on the panel.

**R52. What is out of date says so.**
A brief whose `generated` is not today, a calendar whose `date` is not today or that carries `stale: true` (in a merged calendar, R110, the file's `date` and `stale` are read by R113 and R114 instead), and an inbox or proposals file whose `updated` is more than 24 hours before `now` are stale: the panel carries `stale: true` and its source is `stale`; a proposal and every suggestion from a stale proposals file carry `stale: true`.
Check: given yesterday's brief and calendar and 30-hour-old inbox and proposals files, expect `stale: true` on the three panels, on `focus.proposal` and on every suggestion; given a calendar dated today that carries `stale: true`, expect the panel stale and its source `stale`; given the same without it, expect neither.

**R53. Nothing in a state file becomes a link.**
A thread with `draft: true` shows a "Draft ready" badge, not a link; no URL found in any state file is rendered as an anchor.
Check: given state strings containing `https://evil.example/x`, expect every `href` in the page to be a GitHub address (R74), the board's own stylesheet or the font stylesheet (R84).

**R54. The board never writes a file to the data repo.**
Check: given a recording GitHub client and every action run once, expect no request that creates, changes or deletes repository contents.

**R117. A thread may say which mailbox it came to.**
A thread in `state/inbox.json` may carry an optional `account`, a short label for the mailbox, never an address.
The label is cleaned (control characters removed, whitespace collapsed, trimmed) and cut at 20 characters with no ellipsis; a label that is absent, is not text, is empty once cleaned or holds an `@` is treated as absent, and that thread is shown as it was before this rule.
A thread with a label carries `account` on the board, and the page writes it in the thread's foot, before the `why`, in an element with the attribute `data-account` whose text is the label alone.
The label is escaped like every other string (R73) and is never a link (R53).
An inbox in which no thread has a usable label gives the same board and the same page as before this rule, byte for byte.
Check: given threads whose `account` is `Work`, `"  Work\n  mail  "` (a real line break inside), 30 letters, `"><script>alert(1)</script>`, `""`, `7`, `me@example.test`, and one with none, expect on the board `Work`, `Work mail`, the first 20 letters and the payload cut to 20 characters, and no `account` key on the last four; expect on the page exactly one `data-account` element for each of the first four, inside that thread's foot and before its `why`, holding the label alone and escaped, with no `<script` beyond the board's own and no `@` that came from a label; given the same inbox with every label removed, expect the board and the page equal to those of the inbox built without the key, and no `data-account` in the page.

### The five actions

**R55. A write is accepted only as a same-site form post carrying a token for that exact form.**
Once the `Host` is allowed (R78) and the method is `POST` (R80), an action is refused with 403 and no call to GitHub unless: `Origin`, when sent, has the request's host; `Sec-Fetch-Site`, when sent, is `same-origin` or `none`; and the form carries a form token that this board signed for that action and target within the last 12 hours.
The target is `new` for logging an idea, `<habit id>:<date>:<on|off>` for a habit, and the issue number for sorting and closing.
Every form on the page has its own token; the signing key is derived from the GitHub token and is never sent anywhere, so a form token survives a restart.
A form token whose write succeeded is remembered while the board runs, and posting it again writes nothing and answers as a success; a token whose write failed can be posted again.
Two posts of the same form token that arrive while the first is still being handled are one write: the second waits for the first and gets the same answer.
The target is the short ref (see Words) for sorting and closing, and `<habit id>:<date>:score` for a score, the score itself being a field of that form (R140; amended at CP6 by the lead, so one form with a select can carry any score).
The signing key is `BOARD_FORM_KEY` when it is set (R130), otherwise it is derived from the default GitHub token as before.
Check: given a cross-site `Origin`, `Sec-Fetch-Site: cross-site`, a missing token, a token signed for another target and a token 13 hours old, expect five 403s and zero GitHub writes; given the same valid post twice, expect one write and two success answers; given the same valid post sent twice at the same moment, expect one write and two success answers; given a post that failed and is posted again, expect a second attempt; given a token issued before a restart, expect it accepted.
Check: given a close form for a card of a home repo, expect its target to be the card's full ref; given a score form, expect its target to be `<habit id>:<date>:score`; given `BOARD_FORM_KEY` set, expect a form token that differs from the one derived from the GitHub token.

**R56. Log an idea.**
The title is the input with control characters removed and runs of whitespace collapsed, trimmed, 1 to 200 characters; the issue is created with that title, no body, and the idea label.
An empty or over-long title is refused with a plain message and nothing is created.
When `settings.ideas` names a Project, logging an idea also adds the new issue to the Ideas Project as a second write.
The idea label is still written, which is harmless and keeps the setting reversible.
Check: given `"  Shelves\n for   the hall  "`, expect one create with title `Shelves for the hall` and labels `["idea"]`; given spaces only, and given 201 characters, expect no request.
Check: given `settings.ideas` set, expect one create with labels `["idea"]` and then one add-item to the Ideas Project.

**R57. Tick a habit.**
For today only: with no check-in for the habit today, one is created titled `<habit title> · <today>` with the habit's label and then closed; an open one is closed; one already closed today is left alone.
A habit with `score` is set through R140 instead, and its tick form is not shown.
Check: given no check-in, expect one create then one close; given an open one, one close; given one closed today, no request; given an unknown habit id or a date that is not today, a refusal and no request.
Check: given a habit with `score`, expect no tick form on the page and, in the same state, a score form (R140).

**R58. Untick a habit.**
For today only: every closed check-in of that habit for today is reopened.
A habit with `score` is set through R140 instead, and its untick form is not shown.
Check: given two closed check-ins for today, expect two reopen requests; given a check-in for yesterday only, expect none.
Check: given a habit with `score`, expect no untick form on the page.

**R59. Sort an idea by hand.**
Input: an idea number, a project key and an optional milestone number.
It is refused unless the issue is an open idea, the project is shown, and the milestone (when given) belongs to that project by R14 and is not closed on GitHub.
It then, in this order, adds the issue to the Project, sets the milestone, and removes the idea label while keeping every other label.
A step that is already true is skipped; when a step fails the earlier ones stay, the idea is still an idea, the answer names the step, and posting again finishes the job.
GitHub answers the add of an issue that is already an item of that Project with status 422 (observed), and its item list can run behind (R70), so an add answered 422 counts as done and the next steps follow; any other failed add stops the sort.
The board then holds that membership exactly as it holds one it has just written (R70), so the page shows the issue under the project while GitHub's item list still omits it.
With `settings.ideas`, the input is the idea's short ref, a project key and an optional goal; the steps are: add the issue to the target Project, set the milestone, then remove the item from the Ideas Project, which takes the place of removing the label.
The milestone must be one of the target project's goals (R14).
The order of the steps and "a step that is already true is skipped" are unchanged.
When the target project has a `home` and the idea lives in another repo, the idea first moves home: within one owner its issue is transferred into the home repo; across owners, where GitHub allows no transfer, a copy is created in the home repo (same title, a body naming the original, the original's labels without the idea label), the original gets a comment `Moved to <owner/repo#n>`, and after the other steps the original is closed as not planned.
A copy already named by such a comment on the original is not created again, so posting again after a failure finishes the job.
A goal of a project with a `home` is a milestone of its home repo that holds one of its cards, or one that holds no card yet when no other shown project has the same home; the later steps act on the moved issue or the copy.
Check: given a valid sort of an idea labelled `idea` and `home`, expect add-item, set-milestone, then labels set to `["home"]`; given a failure on set-milestone, expect no label change, then a second post that sends set-milestone and the labels; given an add answered 422, expect set-milestone and the labels to follow and a success; given an add answered 422 while GitHub's item list still lacks the issue, expect the issue under that project on the redirected load; given an add answered 500, and given one answered 403, expect a failure naming the step and no later request; given a milestone of another project, a closed idea, and a task, expect three refusals and no request.
Check: given `settings.ideas` set and a valid sort, expect add-item to the target Project, set-milestone, then removal from the Ideas Project, and no label change; given a milestone that is not one of the target project's goals, expect a refusal and no request.
Check: given a sort into a project whose home is under the idea's owner, expect a transfer into the home repo before the add; given one whose home is under another owner, expect a copy in the home repo, a `Moved to` comment on the original, the add, the milestone, the removal and the original closed as not planned; given the same sort posted again after a failure at the milestone, expect no second copy.

**R60. Accept a suggestion.**
Accepting runs R59 with the suggestion's project and milestone, read from the proposals file at the moment of the post, and only when the suggestion is acceptable (R34).
Check: given an acceptable suggestion, expect the same three requests as R59; given one that is stale, unknown or not acceptable, expect a refusal and no request.

**R61. Close a task.**
Input: the number of an open task (of a shown project, or standalone); it is closed with reason `completed`.
Anything else (an idea, a check-in, an ignored issue, a pull request, a closed or unknown number) is refused with no request.
The input is the short ref of an open task.
Check: given one post for each of those eight sorts, expect two close requests in total.
Check: given the short ref of an open task of a home repo, expect one close request to that repo; given a bare number for a task of the data repo, expect one close request to the data repo.

**R140. Set a score.**
`POST /actions/score` takes a habit id, today's date and a whole score from `min` to `max`.
With no check-in today, one is created (title and label as R57) and closed; an open one is closed.
Then the check-in is added to the Habits Project when it is not yet an item, and its `Score` is set.
Setting a score again on the same day only sets `Score`.
It is refused with status 400 and no request for an unknown habit, a habit without `score`, a date that is not today, or a score out of range.
Check: given the grid of no check-in, an open one and a closed one, each with a first and a second score on the same day, expect the writes each case needs and no others; given the four refusals, expect status 400 and no request.

**R62. Every action answers with a redirect or a plain message.**
Success answers `303` to `/`; a refusal or a GitHub failure answers with a small page that says in plain words what did not happen, with status 400 (bad input), 403 (R55, R63) or 502 (GitHub failed), and never with a stack trace.
There are five action paths, so there are five of these answers.
Check: given a forced GitHub 500 on each action, expect four 502 pages, none containing a line starting with `    at ` or the token.
Check: given a forced GitHub 500 on each of the five actions, expect five 502 pages, none containing a line starting with `    at ` or the token.

**R63. Read-only means no controls and no writes.**
With `BOARD_READ_ONLY=1`, `meta.readOnly` is true, the page renders no form, and every action path answers 403.
There are five action paths.
Check: given read-only, expect zero `<form` in the page and four 403s with no GitHub write.
Check: given read-only, expect zero `<form` in the page and five 403s with no GitHub write.

### Reading GitHub and refreshing

**R64. Every page load asks GitHub again, cheaply.**
Every address the board has read before is asked for with the stored `ETag` in `If-None-Match`; a `304` reuses the stored body.
Check: given a second load with unchanged data, expect every request whose address was read before to carry `If-None-Match`, and the board to be identical.

**R65. Once a day the board does a full read on its own.**
At `refresh.dailyAt` in the board timezone the server reads everything from scratch and saves it as the last good read; no outside scheduler is needed.
On a host that was asleep at that time, the first page load of the day does the full read instead.
Check: given a fake clock crossing 05:00 board time, expect exactly one full read; crossing it again the same day, none; given a first load on a later date than the last full read, expect a full read.

**R66. The last good read is saved, and it holds no secret.**
After every successful read the raw input, settings, theme and state are written to `last-good.json` in the data directory, readable by the owner only where the system supports that.
With the calendar read from iCloud (R96) the state holds today's event titles, so they are in that file too; no sign-in ever is (R102).
Check: given a first read into an empty folder with token `SENTINEL-TOKEN-123`, expect the file to exist and not to contain that string; given a later read, expect it replaced whole.

**R67. When GitHub does not answer, the board shows the last good read and says so.**
Any failed read (no network, a 5xx, a rate limit, a refused token) serves the last good read with `run.stale` set to the time of that read and the reason in plain words; the page shows them in a banner inside the header section (an element with `data-banner`), with status 200.
With no last good read the answer is a small plain page with status 503 and no board.
With more than one GitHub owner, a read that fails for one owner (any request that needs that owner's token) leaves that owner's projects out with `project-owner-unreadable` and a notice naming the owner.
The rest of the board is shown and the read counts as good.
A failure of the data repo still fails the whole read, and so does a failure on the data repo's owner, whose token is the default one: only an owner other than the data repo's is ever left out this way.
Check: given a forced 503 from GitHub after one good read, expect status 200, `meta.stale.since` equal to that read's time and one `data-banner`; given the same with an empty data directory, expect 503 and no `data-section`.
Check: given projects of owners a and b where every request for b answers 503, expect a board with a's projects, b's left out with `project-owner-unreadable` at 1, a notice naming b, and no stale banner; given the data repo answering 503 after one good read, expect the last good read as before.

**R68. Lists are followed page by page, only where GitHub says, and not forever.**
The next page is taken from the `Link` header's `rel="next"` and followed only when its origin is `https://api.github.com`; issues stop after 100 pages and each project's items after 20, setting `partial` and a `too-much-data` warning.
No request of the board's GitHub client leaves for any origin but `https://api.github.com`, whatever address it is handed, and it never lets a redirect be followed for it: a redirect of a read that stays on `https://api.github.com` is followed by the client itself, at most three in a row; a redirect to anywhere else, and any redirect of a write, is a failed request.
The items of the Habits Project are listed with `q=updated:>=<window start>`, where the window start is today minus 120 days in the board timezone, so they never reach the page cap.
Check: given a `Link` header pointing at `https://evil.example/`, expect no request to it; given an endless `next`, expect exactly 100 issue requests and the warning; given a read answered 302 with `Location: https://evil.example/x`, expect no request to that host and a failed read; given a read answered 301 to another `https://api.github.com` address, expect that address asked next and its answer returned; given four such redirects in a row, expect a failed read; given a write answered 307, expect a failed write and no second request; given an address on another host handed to the client, expect no request at all; expect every request to be sent with redirects switched off (`redirect: 'manual'`).
Check: given the Habits Project, expect its items request to carry `q=updated:>=` followed by the date 120 days before today.

**R69. Between full reads, only changes are fetched.**
A full read fetches issues with `state=all`; until the next full read, every load fetches issues with `since` set to five minutes before that full read began (so the address stays the same and R64 applies) and merges the result by issue number.
The merge is by card ref, not by number.
Check: given a full read then two loads, expect both loads to use the same `since`; given the second returning one changed issue, expect the merged list to keep its length with that issue updated.
Check: given a stored issue `a/x#5` and a changed issue `a/y#5`, expect the merged list to hold both.

**R70. After a write, the page shows the result.**
A successful action reads the changed data again before it answers.
GitHub's lists can run a few seconds behind a write (observed: from a moment up to about two minutes for a Project's items), so the board does not depend on them for its own writes: the issue GitHub returns from a write replaces the stored one with that number and is not undone by an older copy of it from a list, and for ten minutes after adding an issue to a Project the board counts it as an item of that Project even when the item list does not show it yet.
Check: given a tick followed by the redirected load, expect `doneToday` true; given a stored issue and a list that returns a copy with an earlier `updated_at`, expect the stored one kept; given a sort after which GitHub's item list still lacks the issue, expect the issue under that project on the redirected load; given the list still lacking it more than ten minutes later, expect it under that project no longer.

**R71. Simultaneous page loads share one read.**
Check: given ten loads started together, expect one set of GitHub requests.

**R116. Projects and home repos are read side by side, a few at a time.**
Inside one project the requests still follow each other (its fields, then its items, page by page as R68 says), but different projects of one owner's group are read at the same time, at most four projects at once.
In the same way the home repos of one group have their milestone lists (and, on a full read, their privacy) read at most four repos at once; one home's own requests still follow each other.
The result is the one a read of the projects and homes one after another gives: the same projects in the order of the settings, the same items in each, the same milestones and repos in the order of the group's homes, `partial` and `too-much-data` when any project's items or any home's milestones were cut (R68), and a failed request for any project or home failing that group as R67 and R6 say; once a request has failed no further project or home of that group is started.
No request is added or dropped by this: a read sends exactly the addresses a one-by-one read sends, each once.
Check: given 16 projects and a GitHub that answers every request after a short wait, expect at some moment more than one request for a project's fields or items in flight, and at no moment more than four; expect the set of addresses asked to equal that of the same read with a limit of one, and the board to be identical; given 3 projects, expect never more than three in flight; given ten home repos in one group, expect at some moment more than one milestone request in flight, never more than four, and the milestones in the order of the homes; given the settings listing the projects in an order other than GitHub's and the answers arriving in yet another order, expect the board's projects in the order of the settings; given one project's item list answered 503, expect the read to fail as in R67; given one project whose items never end, expect `partial` and the `too-much-data` warning as in R68.
**R116 (whole read).** The limit of four is shared by the whole read, not counted per group: the owner groups are read at the same time, and inside a group the homes do not wait for the Projects; at no moment are more than four project, home or owner requests in flight together.
Everything the read returns comes out exactly as a read of the groups one after another gives: projects in the order of the settings, milestones and repos in the order of each group's homes, notices and failed owners in group order, and the blocked-by questions of home cards asked after the groups are read, in group order, first card wins (R133).
A group that fails starts nothing further of its own and leaves only its projects out (R6); the data repo's group failing fails the read (R67), and no other group's result is used.
An owner's type (user or organisation) is asked on a full read and held for the life of the board otherwise.
Check: given three owner groups (the data owner with three Projects, an organisation with fourteen Projects and ten homes, a second organisation with one Project and one home) and a GitHub that answers every request after a short wait, expect at some moment requests of two different groups in flight together, at some moment a home milestone request of a group started before that group's last Project request has finished, never more than four project, home or owner requests in flight, and the board raw identical to the one a one-by-one read gives; given the second organisation's Project list answered 503, expect only its project left out with its notice and every other project read; given a non-full read after a full one, expect no `/users/<owner>` request.

**R72. Settings, theme and state are read from a private data repo, and a board that cannot be trusted is not shown.**
They are read from the repo's default branch through GitHub, unless `BOARD_CONFIG_DIR` is set.
A missing settings file, one that breaks a hard value, or a data repo that is public gives a small plain page that says which, with status 503 and no board; a missing theme file means the default theme.
A home repo that is public is treated like a public data repo: the plain page names that repo and no board is shown.
Repo privacy is read on every full read.
Check: given a 404 for `board.config.json`, expect that page pointing to setup; given a settings file with a `token` key, expect the page to name the key and not its value; given `repoPrivate: false`, expect the page to say the repo is public.
Check: given a home repo with `private: false`, expect the page to name that repo and say it is public, with status 503 and no board.

**R130. The form key is the board's own, or derived from the GitHub token as before.**
`BOARD_FORM_KEY` (32 or more characters, no whitespace) signs forms when it is set.
With no GitHub token it is required, and the board refuses to start without it, with one plain sentence.
With a GitHub token and no form key, the key is derived exactly as R55 says.
No board ever signs with a fixed or an empty key.
Check: given only a Notion token and no form key, expect a refusal; given a 31-character key, expect a refusal; given a GitHub token and no form key, expect a form token identical to today's for the same token.

**R131. One GitHub token per owner.**
`BOARD_GITHUB_TOKEN` serves the data repo's owner, and `BOARD_GITHUB_TOKEN_<n>` with `BOARD_GITHUB_OWNER_<n>` (n from 1 to 5) serves that owner.
A request for an owner with no token of its own uses the default token.
A `_<n>` token without its owner, or an owner without its token, is ignored with a warning at start.
Check: given tokens for owners a and b and settings listing projects of a, b and c, expect every request for a's and b's projects to carry their own token and c's to carry the default one.

**R141. Field ids are read on the full read.**
Between full reads, the board reads each Project's items with the field ids it already knows.
It reads the fields list again on the full read, and whenever an items read is refused or comes back without a field it asked for.
Check: given two loads, expect the fields address asked once.

### Reading Notion

**R143. A Notion board reads four data sources the settings name.**
`notion: { projects, tasks, goals, habitLog }` holds their ids, which are not secrets: Notion's own Projects and Tasks, a Goals table and a Habit log.
A setting that lacks one of the four, or names an id that is not a Notion id, refuses the read with one plain sentence that names the four.
Settings, theme and state come from `BOARD_CONFIG_DIR`, which is required on a Notion board.
Check: given no config dir, expect a refusal to start with one plain sentence.

**R144. A Notion task and goal are numbered by their `ID` property.**
The `unique_id` of the `ID` property gives `number`, and `ref` is `notion:<page id>`.
A row without an `ID` is skipped and adds one to `row-skipped`.
Check: given a task with `ID` 7 and a task with none, expect one card numbered 7 with ref `notion:<its page id>` and `row-skipped` at 1; given a goal with `ID` 3, expect a goal numbered 3.

**R145. Notion is read in changes and once a day in full.**
Between full reads, rows are queried with `last_edited_time` after the last read minus five minutes and merged by ref.
The daily full read (R65) also drops rows that disappeared.
Check: given a deleted row, expect it gone only after the next full read.

**R146. A Notion relation of more than 25 is read to its end.**
Relation values come back cut at 25; the reader pages the property item until done, at most 20 pages, then stops with `partial` and `too-much-data` (R68).
Check: given a relation of 60 values, expect all 60 read; given one that needs more than 20 pages, expect `partial` and `too-much-data`.

**R147. Notion's rate limit is waited out, not fought.**
A 429 is retried after its `Retry-After` (at most 10 seconds, at most three times); then the read fails as R67 says.
Requests go one at a time.
Check: given one 429 with `Retry-After` 2, expect one wait of 2 seconds and a good read; given four 429s in a row, expect three retries and a failed read; expect never more than one request in flight.

**R149. Both back-ends give the same board for the same world.**
One scenario (projects, cards, goals, a blocker, an idea, a scored check-in) built on both fakes gives the same board apart from URLs, the source tag and refs.
Check: given that scenario on both fakes, expect the two boards equal once URLs, the `GH`/`NT` tag and refs are removed.

**R151. On Notion an idea is a task tagged `Idea` with no Project.**
A task whose `Tags` hold `Idea` and whose `Project` is empty is an idea in the backlog and never a card; a task with a Project is a card whatever its tags.
Logging an idea creates one task with the `Idea` tag; filing it patches that same page once, setting its `Project` and `Goal` (or none) and removing `Idea` while keeping every other tag.
A retried filing patches the same page again and creates nothing.
Check: given an idea-tagged task with no Project and one with a Project, expect one idea and one card; given a filing of an idea tagged `Idea` and `DO`, expect one PATCH on that page leaving `DO` and no new page; given the same filing twice, expect no page created.

**R152. On Notion a card's modes are tags.**
A card's mode labels are the `Tags` it holds that the settings' `modes` name, in the order the settings give them, as a GitHub card's mode labels are; a tag that is not a mode is never a label, and a card with no mode tag has none.
A mode's colour is that `Tags` option's colour, through the setup palette.
Check: given a card tagged `THINK` and `DO` with modes `DO, THINK`, expect the labels `DO` then `THINK`; given a card tagged only `Urgent`, expect no label; given `DO` coloured green, expect its chip `#0e8a16`.

### Notion setup and copy

**R153. The copier reads GitHub and writes only to Notion.**
`scripts/copy-to-notion.mjs` has `plan`, `apply --confirm` and `verify`.
It sends GitHub nothing but reads, and it writes to Notion only the four tables the settings name.
It copies the listed projects, the open cards with their status, due date, mode, project, goal and open blockers, the goals they use, the open ideas, and every habit check-in of all time with its score; closed cards stay on GitHub.
It writes the Notion board's settings, theme and state beside each other, with each project keyed as before and owned by `notion`.
`apply` refuses a plan whose digest no longer matches what GitHub holds, and an unknown status name refuses the plan.
A record is saved after every write, and an apply run again or resumed after a crash never makes a second copy of a row.
`verify` reads both sides again, the Habit log with no date window, and passes only when every copied row matches.
Check: given the copy world, expect apply then verify to pass, a second apply to create nothing, a crash after three writes then a resume to leave no duplicate, a stale digest and an unknown status each refused, every GitHub request a read, and no token in any output line or record.

**R154. The setup script builds the Notion tables once.**
`scripts/notion-setup.mjs` creates a page called Howgozit with the four tables, their relations and their rollups, and prints the settings `notion` block.
A second run changes nothing and prints the same block; it touches nothing it did not create.
An internal connection, which cannot create a page at the top of a workspace, needs `--parent <page id>`, and the script says so in one plain sentence.
Check: given an empty fake workspace, expect the four tables and the block; given a second run, expect no write; given an internal token without `--parent`, expect that refusal.

**R155. On Notion the Projects rows are the project list.**
A Notion board whose settings have no `projects` list shows every Projects row whose Status is not in the Complete group, in `ID` order, each keyed `notion-<ID>` and owned by `notion`; the adapter hands the model that list as if the settings held it, so the model never knows where it came from (R150).
A settings `projects` list, when present, still decides which rows show and in what order.
`focus` and a habit's `project` may name a `notion-<ID>` key.
A row added in Notion shows on the next read with no settings edit; a row moved to Done drops off.
Check: given no `projects` list and three Projects rows, one Done, expect two projects keyed `notion-<ID>` in ID order; given a list naming one row, expect only that row; given a row added between two reads, expect it on the second; given `focus: ["notion-2"]`, expect that project in focus.

**R156. The setup script builds a starter board from a proposal.**
`scripts/notion-setup.mjs plan <proposal.json>` lists every table, row and file it would create and writes nothing; `apply <proposal.json>` creates the tables if they are missing (R154), then one Projects row per project, one Goals row per milestone with its Project, one Tasks row per task with its Project and Goal, and a complete starter `board.config.json` in `--config-dir`: the `notion` block, no `projects` list (R155), the habits, modes, focus by `notion-<ID>` key, name and timezone.
The proposal has the shape of `references/setup-proposal.md` without `owner` and `repo`.
A record is saved after every write, and a second apply, or one resumed after a crash, never makes a second row.
It ends by printing the environment lines to set, the form key made by a one-line command, never by the script.
Check: given an empty fake workspace and the example proposal, expect the rows, the settings file, and a board that renders every proposed project and task; given a second apply, expect no write; given a crash after three writes then a resume, expect no duplicate; given `plan`, expect no write.

### The Glitch feed

**R157. The feed keeps only a sender name and a subject.**
Per mailbox it reads Glitch's triage answer and keeps `display_name`, `subject`, `automated`, `disposition` and `date` of each item in `surface`.
`from`, `address`, `domain`, `snippet`, `subject_raw`, ids and attachments are never read past parsing, so there is no fallback to `from`.
Clean means control characters become spaces, whitespace is collapsed and the text is trimmed; anything that is not text becomes empty.
The address scrub removes every run of characters that are not space, bracket or quote and that contains `@`.
It then removes the empty pairs `<>`, `()`, `[]`, `""` and `''`, collapses spaces, and trims stray `<>"'` from both ends.
It also removes any `<scheme>://` or `www.` run up to the next whitespace, so nothing becomes a link.
These removals repeat until the text stops changing, so a removal can never join the pieces of a link or an address back together.
The sender text `from` is the scrubbed `display_name` cut to 200 characters, or `(unknown sender)` when that is empty.
The `subject` is the scrubbed subject cut to 200 characters, or `(no subject)` when that is empty.
Check: a hostile fixture with addresses in names and subjects, snippets and URLs; a name that is only an address gives `(unknown sender)` even when `from` holds a real name; a missing subject gives `(no subject)`; a 300-character name and subject are cut to 200; `<a@b.c>`, `("a@b.c")` and `www.x.y/z` leave nothing behind; sweep the written file and every printed line for `@`, `http` and the snippet sentinels.

**R158. The feed's buckets and order.**
An item with `automated: true` goes to `fyi`, any other to `reply`, and none to `decide`.
Only an answer whose `status` is `ok` contributes, and an item that is not an object is skipped.
The document is exactly `{"updated": <now as ISO 8601 with seconds and offset>, "counts": {"reply": n, "decide": 0, "fyi": n}, "threads": [{"bucket", "from", "subject", "why", "account"}, ...]}`, with the keys in that order.
The counts are over the kept threads.
It is written as JSON indented by 2 spaces plus a trailing newline, and a document of 256 KB or more is refused and not written.
The `why` is `No rule for this sender yet` when the disposition is missing or blank, `You marked this sender important` for `watch_important`, `You marked this as a live issue` for `live_issue`, and `You allow this sender` for `allow`.
Any other disposition gives `Rule: ` followed by the disposition with `_` turned into spaces, cleaned and scrubbed (R157), the whole text cut to 200 characters.
The date is ISO 8601, a date with no offset reads as UTC, and a missing or unparseable date sorts as 1970-01-01T00:00Z.
Threads are ordered newest first, ties keep read order (mailboxes in config order, items in answer order), and the first 30 are kept.
The `account` is `accountWord(label)` from R117, and when that gives null the `account` key is left out of that thread.
Check: a contract-drift test gives the same labels to the feed's cleaner and to `accountWord` and expects identical results; a label that gives null leaves out `account`; `automated: true` and `false` and a missing flag; an `ask` answer and a non-object item contribute nothing; each `why` case; ties across two mailboxes; offset, no-offset, missing and unparseable dates; 31 items keep 30; key order, 2-space indent and trailing newline; a document of 256 KB or more is refused.

**R159. A mailbox that is not healthy is skipped before any read.**
Health comes from two read-only calls: `integrations/connections.py doctor` for Google (the rows whose `surfaces` contain `gmail`) and `integrations/ms_connections.py doctor` for Microsoft.
A mailbox is healthy only when `health.status` is `connected`, and for Microsoft also signed in.
The member's config names mailboxes by Glitch label, and the feed passes the matching account `id` to `--account`, so a label shared by two providers never becomes ambiguous.
A triage answer is used only when its `status` is `ok`.
An answer of `ask` or `dormant`, a non-zero exit, empty or unparseable output, or an answer missing the expected keys skips that mailbox.
Each skipped mailbox is named with one plain reason: "needs you to sign in again in Glitch", "not connected in Glitch", "not a mailbox Glitch knows", "took too long" or "answer not understood".
Glitch's own reason text is never printed or written, because it can name labels or more.
The door's stdin is closed, and the feed opens no browser.
Check: a fake health answer with one unhealthy mailbox gives no triage call for it; each non-ok answer, exit, empty output and missing key gives its named reason; no printed or written line holds Glitch's reason text.

**R160. Time limits.**
`run` allows 60 seconds per door call and 300 seconds per run.
`check`, run attended in setup, allows 240 seconds per call, because Glitch's first triage of a mailbox does a one-time sent-mail backfill.
A call over its limit is killed with its whole process group and named "took too long".
No new call starts with under 3 seconds left.
Check: an injected clock; a call over its limit is killed and named; a call with under 3 seconds left is never started; `check` allows 240 seconds.

**R161. Where the file goes.**
With `BOARD_CONFIG_DIR` set, the feed writes `<dir>/state/inbox.json` and `<dir>/state/log.json` atomically and makes no network call.
When `BOARD_CONFIG_DIR` and `BOARD_REPO` are both set, the local folder wins and nothing goes to GitHub.
Otherwise it writes `state/inbox.json` to `BOARD_REPO` through the contents API with `BOARD_GITHUB_TOKEN`, as one commit, skipped when the bytes are equal.
The log is written only when the inbox file changed.
It then puts one counts-only entry at the front of `state/log.json`, keeping 30.
The entry is `{"t": "HH:MM" in the local time of the run, "agent": "Glitch", "what": "Updated inbox (<n> threads)"}` and never holds a name or subject.
Commit messages are the fixed text `Glitch feed: inbox` and `Glitch feed: log`, and never hold a subject, sender or label.
The token never appears in any printed line.
A 409 or 422 on a write is named ("the board's repo changed during the write; the next run catches up") and the log is not written.
If every mailbox failed, nothing is written.
Check: both targets against `fake-github` and a temp folder; both variables set gives zero GitHub calls; equal bytes give zero PUTs and no log entry; a changed inbox gives one inbox commit and one log commit with the fixed messages; the log entry has the exact keys and holds no sender or subject; a hostile subject and label appear in no commit message; the token appears in no printed line; a 409 and a 422 give the named line and no log write; total failure gives zero writes.

**R162. The scheduled job.**
`feed.mjs schedule apply` installs exactly one job named `howgozit-feed` for the current OS.
That is the Windows Task Scheduler task `\Howgozit\Feed`, the macOS LaunchAgent `ai.blastworks.howgozit.feed`, the Linux systemd user timer `howgozit-feed.timer`, or one crontab line tagged `# howgozit-feed` when no user service manager answers.
`morning` is 06:00 daily and `hourly` is every hour from 07:00 to 22:00, both in the machine's local time.
The job names `node` and `uv` by absolute paths resolved at `apply` time, because a scheduler's PATH is minimal, and never a `.cmd` shim on Windows.
Given `--fixtures <dir>`, `plan` and `apply` add `--fixtures <dir>` with the folder as an absolute path to the job's command, to prove the job on a machine without Glitch; without it the job's command is unchanged.
A second apply replaces only its own job, and `remove` leaves no trace.
Glitch's own `\Glitch\Watch`, `com.glitch.watch` and `glitch-watch` are never read, changed or removed.
`plan` prints what it would install and writes nothing.
Check: per OS with an injected runner and filesystem; the job text holds absolute `node` and `uv` paths; a Glitch watch job present in the fake is untouched; with a fixtures folder whose path holds a space, the job text holds `--fixtures` and that path correctly quoted for the OS, and without one no `--fixtures` appears anywhere.

**R163. The feed's own settings stay on the machine.**
`feed.config.json` sits in the board's config folder, or the folder given by `--config-dir`.
It holds `mailboxes` (1 to 10 Glitch labels), `frequency` (`morning` or `hourly`) and `glitch` (the absolute path to the Glitch folder).
A label holding `@`, `://` or a control character is refused.
It is never written to the data repo.
An invalid file stops the run with one plain sentence and writes nothing.
`feed.mjs run|check --fixtures <dir>` replaces every Glitch call with `<dir>/health.json` (the two doctors' answers) and `<dir>/triage-<label>.json`, to prove the scheduler on a machine without Glitch.
Beside it, `feed.env` may hold `BOARD_REPO`, `BOARD_GITHUB_TOKEN` and `BOARD_CONFIG_DIR` as `KEY=VALUE` lines, for the scheduled job, which starts with none of the board's environment; no other key is read, and a variable already in the environment wins over the file.
On macOS and Linux a `feed.env` that its group or others can read stops the run with one plain sentence, and the token is never printed.
Check: valid, missing and each invalid field (a label holding `@`, `://` or a control character included); with `--fixtures` no Glitch process is spawned and the answers come from the folder. With an empty environment and a `feed.env` the run reads its keys; the environment wins over the file; an unknown key (`PATH`, `NODE_OPTIONS`) is ignored and never reaches a spawned process; comments and blank lines are ignored; a `feed.env` readable by group or others stops the run with one sentence and writes nothing; the token appears in no printed line on any path.

**R164. A mailbox may have a colour.**
Board settings may carry `mailboxes: { "<label>": "<colour>" }`, the colour one of `green`, `amber`, `orange`, `charcoal`, `blue`, `purple`, `red` or `grey`.
The inbox tag for a thread whose `account` matches a key, after R117 cleaning, gets `data-colour="<colour>"`.
An unknown colour or label shows the plain tag.
Settings without `mailboxes` give the same board and page as before, byte for byte.
Each colour is legible on the card in light and dark, with contrast of at least 4.5:1 for the tag text.
The eight pairs are fixed and come from the theme module, and a page carries only the pairs its threads use, so no colour is written in the stylesheet (R83) and a board without colours is unchanged.
Check: R117's fixture plus colours; byte-equality without the block; the contrast of every colour in both themes.

### Output safety

**R73. Every string from outside is escaped.**
Anything that came from GitHub, the settings, the theme or a state file is HTML-escaped where it is written into the page.
Check: given `fixtures/raw/hostile.json`, `fixtures/settings/hostile.json` and `fixtures/state/hostile/`, which are valid in shape and hold `"><script>alert(1)</script>&'` in every free-text field (titles, names, labels, subjects, reasons, lines), expect a page with all sixteen sections, at least twenty escaped copies of the payload, and no `<script` other than the board's own script tag (R95).

**R74. The page links only to GitHub.**
An `href` is written only for a URL that starts with `https://github.com/`; anything else is shown as text.
The only other addresses a page may hold are its own stylesheet and script and the font stylesheet of R84.
Check: given `html_url` values of `javascript:alert(1)`, `http://github.com/x` and `https://github.com.evil.example/x` on three tasks in What's next, expect three seats and no `href` for any of them.

**R148. A Notion board links only to Notion and GitHub.**
R74 is extended: `https://www.notion.so/` is the one other allowed link start, and only on a Notion board.
Check: given a Notion board with a task url of `https://www.notion.so/x` and one of `https://www.notion.so.evil.example/x`, expect an `href` for the first only; given a GitHub board with the first url, expect no `href`.

**R75. The token appears nowhere.**
The token covers every GitHub token (`BOARD_GITHUB_TOKEN` and `BOARD_GITHUB_TOKEN_1` to `_5`), the Notion token (`BOARD_NOTION_TOKEN`) and `BOARD_FORM_KEY`.
It is in no page, no log line, no error message, no form token and no file the board writes.
The proxy secret of R107 is held to the same rule.
Check: given the sentinel token and every route, every action and every forced failure run once with output, logs, response headers and the data directory captured, expect the string in none of them.
Check: given a sentinel for each of the GitHub tokens, the Notion token and the form key, and every route, every action and every forced failure run once, expect none of the sentinels in any output, log, header, form token or file.

**R76. A colour is a hex colour or it is not used.**
Only `#RGB` and `#RRGGBB` are accepted, from settings and theme alike; anything else falls back to the default and adds one to `color-invalid`.
Check: given `red`, `#12345`, `url(x)` and `#abc;}body{display:none` as theme colours, expect four fallbacks and `color-invalid` at 4.
A GitHub label colour (six hex digits without `#`) is also a colour source: the board adds `#` and applies the same check.
Check: given label colours `1d76db` and `zzz` on two modes, expect `#1d76db` used and one fallback with `color-invalid` at 1.

**R77. Every answer carries locked-down headers, and the page carries no inline code.**
`Content-Security-Policy` is `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-<n>' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, without the two font hosts when fonts are `system`.
Also `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
The page has no `style=` attribute, no `on…=` attribute and no script written into it; values that differ per item (colours, widths, positions) go in one `<style>` block carrying the nonce.
Check: given the page, a static file, the health check and an error page, expect those headers on all four, and in the page zero matches for `style="` and ` on[a-z]+="` and exactly one `<script`, which has a `src` and no content.

**R78. The board answers only to its own name.**
A request whose `Host` is not in the allowed list gets status 421 and an empty body, whatever the path, except the health check.
Check: given `Host: evil.example` on `/`, on a static file and on an action, expect three 421s with empty bodies and no GitHub request.

**R79. The board holds no passwords and cannot be started open.**
It has no login page and reads no credentials from a request.
In `local` mode it binds to `127.0.0.1`; in `proxy` or `hosted` mode it refuses to start without `BOARD_IDENTITY_HEADER`, and a request without that header gets 401 and no board, except the health check.
Behind a proxy on a machine that other accounts or programs share, the lock of R107 should be set as well; the proxy guide says how.
Check: given `proxy` mode with no identity header configured, expect a refusal to start with one plain sentence; given it configured and a request without it, expect 401; given `local` mode, expect a loopback listening address; expect no route containing `login`.

**R80. There are nine routes and no others.**
`GET /`, `GET /static/board.css`, `GET /static/board.js`, `GET /healthz`, and `POST /actions/idea`, `/actions/habit`, `/actions/sort`, `/actions/close`, `/actions/score`.
A known path with another method answers 405; every other path answers 404; a static file is served from a fixed list, never from a path built out of the request.
Check: given `/static/../server.mjs`, `/static/%2e%2e/x` and `/admin`, expect three 404s with no file content; given `PUT /` and `GET /actions/idea`, expect two 405s.

**R81. The health check says nothing.**
`GET /healthz` answers status 200 and `ok`, with or without GitHub, whatever the `Host` and with or without the identity header.
Check: given GitHub down, a foreign `Host` and no identity header, expect 200 and a body of exactly `ok`.

**R107. A lock between the proxy and the board.**
With `BOARD_PROXY_SECRET` set, a request must carry the header `X-Board-Proxy-Secret` with exactly that value, or it gets 401 and no board, except the health check.
The check runs after the `Host` check of R78 and before the identity check of R79, and its 401 has the same status, headers and body as the 401 for a missing identity, so the answer does not say which lock refused.
The two values are compared in constant time, and a header sent more than once is a wrong value.
With the setting unset or empty the board behaves exactly as it does without this rule, in every mode.
A value that is set and is shorter than 32 characters, or holds any whitespace, makes the board refuse to start with one plain sentence that does not hold the value; a value made only of whitespace is refused, not read as unset.
The secret is held to R75: it appears nowhere.
Check: given the secret unset, expect every case below to answer as it does without this rule; given it set, on each of the eight routes of R80, with the header absent, wrong, wrong but of equal length, right but sent twice, and right, each with the identity header absent and present, expect 401 for every case but the right one on every route except `GET /healthz`, which answers 200 and `ok`; expect 421 for a foreign `Host` whatever the header; expect 401 for the right header with no identity and the route's own answer for the right header with an identity; expect the 401 for a wrong secret and the 401 for a missing identity to be equal in status, in headers apart from the date, and in body; given values of 31 characters, of 32 characters holding a space, of 32 characters ending in a newline and of spaces only, expect four refusals to start, none of them holding the value, and given a value of exactly 32 characters expect a start; given the first request after a fresh start with an empty data folder and no header, expect 401, the same as on a board that has already served a page; given the sentinel secret and every route, every action and every forced failure run once, expect the secret, raw, URL-encoded and base64-encoded, in no response body, no response header, no log line, no form token and no file in the data directory.

### Theme and layout

**R82. The look comes from one theme file.**
The theme is turned into CSS variables in the nonce `<style>` block; the stylesheet uses those variables for every colour, font and radius.
A missing key takes its default; a `radius` that is not a whole number from 0 to 40 takes the default.
Check: given a theme with accent `#123456` and radius `"9px;}"`, expect `--accent:#123456` and the default radius in the page.

**R83. No colour is written anywhere but the theme.**
Check: in `board/static/board.css` and every file under `board/render/`, expect no `#` followed by 3 to 8 hex digits, no `rgb(`, `rgba(`, `hsl(` or `hsla(`, and every stylesheet declaration of `color`, `background`, `background-color`, `border-color`, `fill`, `stroke` or `outline-color` to use `var(` or one of `none`, `transparent`, `currentColor`, `inherit`.

**R84. Fonts come from Google unless the theme says otherwise.**
With `fonts.source` `google` the page links one stylesheet at `https://fonts.googleapis.com/css2` for the three families, whose names may hold only letters, digits and spaces; with `system` the page makes no outside request at all and the families are the device's own.
Check: given `system`, expect no `https://` in the page other than GitHub links and no font host in the headers; given a family named `X&family=Evil`, expect the default family and `font-invalid` at 1.

**R85. A broken theme never takes the board down.**
A theme file that is not valid JSON gives the default theme and a `theme-unreadable` warning.
Check: given `{not json`, expect the default theme and the warning in `meta.warnings`.

**R86. One page, in one fixed order.**
Sections appear in this order:

1. `header`: date line, greeting with the name highlighted, one chip per source, and the stale banner when there is one;
2. `capture`: the "Log an idea" box (left out when read-only);
3. `brief` (when the panel is on) beside `season` (when settings have one);
4. `focus` (always; it says "No focus set" when empty) above `timeline` (left out when no lane has a milestone), full width;
5. `calendar` (when on), `inbox` (when on), `next` (always; it says so when empty);
6. `habits` (left out when settings have no habits);
7. `heatmap`, `projects` (always; it points to setup when empty), `log` (when on);
8. `ideas` (always), `standalone` (left out when the count is 0);
9. `footer`: warnings in plain words, the time of the data, a link to the data repo.

Every section's outer element carries `data-section` with its name above.
Check: given `fixtures/board/page.board.json`, expect those sixteen names in that order; given `fixtures/board/page-min.board.json` (no panels, no season, no habits, no milestones, nothing standalone), expect `header`, `capture`, `focus`, `next`, `heatmap`, `projects`, `ideas`, `footer` in order and no other.

The browser tab's title is the person's name from settings followed by ` · Howgozit`; with no name in settings it is `Howgozit` alone.
The name is escaped like every other string from outside (R73).
The product's name appears nowhere else on the page: not in the header, not in a card, not in the footer.
A notice page's tab title is that notice's own heading and nothing more.
Check: given the name `Sam`, expect exactly one `<title>` element and it reads `Sam · Howgozit`; given no name or an empty name, expect `<title>Howgozit</title>`; given a name holding `<`, `>`, `&` and a quote, expect it escaped inside the title; in each of those pages expect the word `Howgozit`, in any letter case, exactly once; given a notice with the heading `No settings file found`, expect `<title>No settings file found</title>` and the word `Howgozit` nowhere in it.

**R87. On a phone it is one column.**
At a width of 480 pixels or less every section takes the full width, in the order of R86, with habits two to a row and the "Log an idea" box staying at the bottom of the screen.
Check: expect one `@media (max-width: 480px)` block in the stylesheet that sets the page grid to one column and gives the capture section `position: sticky` and `bottom: 0`; looking at it at 390 pixels is a line of `references/release-checklist.md`.

**R88. Every card says where its data comes from.**
Each card carries a small source tag in an element with the attribute `data-src`: `GH`, `CAL`, `MAIL`, or the agent's name from settings.
On a Notion board the tag `GH` reads `NT`.
Check: given `agentName` `Robo`, expect `Robo` on the brief and log cards, `CAL` on the calendar, `MAIL` on the inbox, and `GH` on What's next, timeline, projects, habits, ideas, standalone and the 12-week map.
Check: given a Notion board, expect `NT` where `GH` stood and no `GH` anywhere.

**R89. A focus project is marked everywhere it appears.**
The mark is the attribute `data-focus="true"`; it is on the project's chip in the focus row, on its timeline lane and on its project row, and on nothing else.
Check: given two focus projects out of four, each with a milestone, expect exactly six `data-focus="true"` in the page.

**R90. A project has one colour.**
The same colour marks its timeline lane, its project row, its seats in What's next and its linked habits.
Each of those elements carries the class `pc-<key>`, and the nonce `<style>` block defines that class's colour once.
Check: given a project `house` with colour `#123456`, a milestone, a seat and a linked habit, expect `pc-house` on each of those four elements, one rule for `.pc-house` holding `#123456`, and no element of another project carrying `pc-house`.

**R91. The page works with no JavaScript.**
Every control is a plain HTML form that posts to one of the five action paths of R80.
Accepting a suggestion posts to `/actions/sort` with the idea's number and `accept=1`; the board takes the project and milestone from the suggestion, not from the form.
Check: expect every `<form` in the page to have `method="post"` and one of the five action paths, and at least one form for each of the four paths in `fixtures/board/page.board.json`.
Check: given a board with a scored habit, expect its form to post to `/actions/score` and every form on the page to post to one of the five paths.

### Soft values, dates, greeting and the script

**R92. A bad soft value falls back and is flagged.**
Each soft value of the settings shape that is missing takes its default silently; one that is present and bad takes its default and adds one to `setting-invalid` (a colour adds to `color-invalid` instead, R76).
Check: given `next.count` 0, `tokenEvery` 1, `flameTiers` `[3, 1]` and `weekStart` `friday`, expect the four defaults in force and `setting-invalid` at 4.

**R93. A task's date is its own, or else its milestone's.**
A task's date is the `due` of its item in its first project in the order of R8 that has one; with none, it is the date of its milestone (R16) when that milestone is not done; otherwise the task has no date.
A task is overdue when it is open and its date is before today; `overdueDays` is that gap in days.
Check: given a task with item `due` 2026-10-18 in a milestone dated 2026-10-20, expect 2026-10-18; given no item `due`, expect 2026-10-20; given no item `due` and a milestone closed on GitHub, expect no date; given a date of yesterday, expect overdue by 1.
On a board with home repos, "its milestone" means the goal found by (`repo`, `milestone`) of the task.
Check: given a home-repo task whose milestone number also exists in the data repo, expect the date of the home-repo milestone.

**R94. The greeting follows the clock on the wall.**
`greeting` is "Good morning" before 12:00, "Good afternoon" before 18:00 and "Good evening" after, in the board timezone; `weekNumber` is the ISO week of today.
Check: given `now` at 09:59Z, 10:00Z and 16:00Z with `Europe/Brussels` on 2026-10-12, expect morning, afternoon, evening, and week 42.

**R95. A small script makes actions feel instant, and nothing depends on it.**
`board/static/board.js` sends a form in the background, then gets the page once (R108) and swaps in the sections that changed, so the result shows without a full reload; when the post fails it shows the server's plain message beside the control.
It talks only to the board itself, holds no data and no logic of its own, and with it switched off every action still works by R91.
The swap also takes over the generated style rules of the fetched page (the one `<style>` block in its head), so a bar or a dot that moved is drawn at its new place.
When the page it fetches after a post is not an ordinary board page (an answer that is not OK, or a page with no section in it, as a login page or a notice has none), the script changes nothing on the page and reloads the window, so the person sees what the server sent.
Check: expect the file to copy the text of the fetched page's head `<style>` block into the page's own; expect the file to look at the fetched answer's `ok` and to count the fetched page's `[data-section]` elements before any swap, and to call `location.reload()` when either says it is not a board page; expect the file to contain no `eval`, no `innerHTML` assigned from anything but a fetched page of the same origin parsed with `DOMParser`, and no address other than relative paths; the feel itself (a tick showing without a reload, and still working with the script blocked) is a line of `references/release-checklist.md`.

**R108. One action, at most one read of the page.**
After an action is submitted from the page, the page shows the new state having caused at most one `GET` of `/`.
The server's answer to an action is the one R62 gives (a `303` to `/` on success, a plain message page on a refusal or failure) and carries no board page of its own.
The script (R95) makes no request for `/` except one, after a post that was answered with the `303`; after a post that was refused or failed it makes none, and shows the message of R95.
It follows no redirect of a post and then asks for `/` again: the redirect's own read and a separate fetch are not both made.
When that one read fails or is not an ordinary board page, R95's reload of the window may add one more `GET` of `/`, and only then.
Without the script, a plain form post is followed by the browser to `/` once, so the count is one.
Check: given a recording server and the script running on a page, submit a valid tick, expect one `POST` to `/actions/habit` answered `303` to `/`, exactly one `GET` of `/` after it, and the new state on the page; submit the same five more times in a row, expect five more posts and exactly five more reads, never two for one action; submit an action the server refuses (400) and one it fails (502), expect no `GET` of `/` after either and the message beside the control; given the one read answered with a login page, expect the window reloaded and at most one further `GET` of `/`; given the script switched off and a plain post of the same form, expect the `303` and exactly one `GET` of `/` once it is followed; expect the answers to the posts to be equal in status and `Location` with and without the script.

### The calendar from iCloud

These rules apply only when the settings file has a `calendar` block.
The board talks to iCloud's calendar service (CalDAV) itself; no agent and no published calendar link is involved.

**R96. The calendar comes straight from iCloud when the settings name calendars.**
With a usable `calendar` block in the settings (R104) the board reads today's events from iCloud itself and the calendar panel shows them; `state/calendar.json` is then ignored.
Without the block the board sends nothing to Apple, whatever its environment holds, and the panel follows the state file as before (R49).
With the block but no iCloud sign-in in the environment the panel is `{ "error": "unreadable", "from": "icloud" }` and the warning `calendar-no-login` is raised.
Event titles reach the page and the board's own last good read; they are never written to GitHub (R54).
All of this holds as written unless the block has `includeFile` on (R109 to R115).
Check: given a block naming `Home`, a sign-in and an iCloud holding one event today in `Home`, plus a `state/calendar.json` holding a different event, expect the page's calendar section to show the iCloud event and not the file's; given the same without the block, expect the file's event and zero requests to an Apple address; given the block and no sign-in, expect the broken panel, a `calendar` source in state `error` and `calendar-no-login` at 1.

**R97. Only the calendars named in the settings are read, and the settings give each its kind.**
A name in the settings matches an iCloud calendar when the two are equal after trimming and ignoring letter case; only matched calendars are asked for events; a collection that holds no events (a task list, an inbox) is never matched.
Every event carries the `kind` of its calendar's entry, `meeting` when the entry has none.
A name that matches nothing adds one to `calendar-not-found`; the others are still read.
Check: given iCloud calendars `Home`, `Work` and `Family` and settings naming ` home ` (kind `personal`) and `Work`, expect events from those two only, kinds `personal` and `meeting`, and no event request for `Family`; given a setting naming `Gym` as well, expect the same events and `calendar-not-found` at 1; given a setting naming `Reminders` (a task list on iCloud), expect `calendar-not-found` at 1.

**R98. The panel shows today's timed events, in the board timezone.**
The day runs from midnight to midnight in the board timezone.
An event's time is read as written: in UTC, in a named zone, or with no zone (then the board timezone); each is shown as `HH:MM` in the board timezone.
An event that crosses midnight shows the part inside today: it starts at `00:00` when it began earlier and ends at `24:00` when it runs on.
Events are in order of start, then end, then title.
A cancelled event is left out, and so is an invitation that the signed-in address declined. An all-day event is not among the timed events: it is listed apart, in `allDay`, in order of title (R105). A title is cleaned (escapes undone, control characters removed, whitespace collapsed), reads `(no title)` when empty, and is cut at 200 characters.
An event that names a zone the runtime does not know is read in the board timezone and adds one to `calendar-zone-unknown`; an event that cannot be read is left out and adds one to `calendar-event-skipped`.
Check: given `Europe/Brussels`, today 2026-10-12 and events from 08:30 to 08:45 UTC, from 14:00 to 15:00 in `America/New_York`, from 09:00 to 09:30 with no zone, from 23:00 yesterday to 01:00 today, from 23:30 today to 00:30 tomorrow, one cancelled, one declined by the signed-in address, one all-day and one on the 13th, expect exactly five events, `00:00` to `01:00`, `09:00` to `09:30`, `10:30` to `10:45`, `20:00` to `21:00` and `23:30` to `24:00`, in that order, and exactly one all-day entry; given a `TZID` of `Mars/Olympus`, expect the event at its written time and `calendar-zone-unknown` at 1; given an event with no start, expect it absent and `calendar-event-skipped` at 1.

**R99. A repeating event shows on the days it falls on, and never by guesswork.**
Daily, weekly, monthly and yearly repeats are worked out by the board, with their interval, weekdays (including "the second Tuesday" and "the last Friday"), days of the month, months, end date and number of times.
An occurrence that was removed is not shown; one that was moved shows at its new time and not at its old one; one that was cancelled is not shown.
A repeat the board cannot work out (by the hour, by position within a set, by week or day of the year, or a series changed "from this one on") shows nothing and adds one to `calendar-event-skipped`.
An event that also lists extra dates of its own (`RDATE`) shows on its rule's days only (or, with no rule, at its own start) and adds one to `calendar-event-skipped`, because the extra dates are not read.
A changed occurrence that carries no title of its own shows the title of its series.
Check: given today Monday 2026-10-12 and these events, each first held earlier at 09:00 in the board timezone: a daily one, a weekly one on Mondays and Wednesdays, a weekly one on Tuesdays, an every-second-week one whose week this is, the same one a week off, a monthly one on the 12th, a monthly one on the second Monday, a yearly one on 12 October, a daily one that ended on the 11th, a daily one limited to 3 times that began on the 1st, a daily one with today removed, a daily one whose today was moved to 16:00 and a daily one whose today was cancelled, expect an event at 09:00 for the first, second, fourth, sixth, seventh and eighth, one at 16:00 for the moved one, and nothing for the others; given a rule `FREQ=HOURLY`, and given `FREQ=DAILY;BYMONTHDAY=1`, expect no event and `calendar-event-skipped` at 1 each time; given a weekly Monday event whose occurrence of last week was moved to today 11:00, expect two events, at 09:00 and at 11:00.

**R100. Apple is asked at most once every five minutes and never holds the page up for long.**
An answer is reused for five minutes for the same day, timezone and named calendars, with no request at all; the list of calendars, once found, is kept and not asked for again while every named calendar is in it, and never more than once in one read.
One whole read gives up after eight seconds.
A read that is still under way is shared only by callers asking for the same day, timezone and named calendars; a caller asking for anything else gets a read of its own.
Check: given two reads started together for the same day, timezone and calendars, expect one set of requests and equal answers; given two started together for different named calendars, expect each to get the events of its own calendars; given two reads one minute apart, expect requests for the first only and equal answers; given a third read six minutes after the first, expect event requests again but no new search for the calendars; given a read after the date has changed, expect new requests; given an iCloud that never answers, expect the read to end within its time limit as a failure (R101).

**R101. When Apple does not answer, the board shows what it last read today and says so.**
After a failed read, events read earlier the same day for the same calendars are shown with `stale: true`, so the panel and its source say stale; with nothing kept for today the panel is `{ "error": "unreadable", "from": "icloud" }`.
Whenever iCloud is the source and the panel is the broken one, it carries `"from": "icloud"`, and the card reads "The calendar could not be read from iCloud. See the note at the foot of the page."; a calendar file that cannot be read keeps the sentence that names the file, and its panel stays `{ "error": "unreadable" }`.
The failure raises `calendar-login-refused` when Apple refused the sign-in and `calendar-unreachable` otherwise.
An answer the board cannot read is a failure, never an empty day.
After a failure Apple is left alone for one minute, then asked again.
Nothing else on the board changes: a calendar failure never makes the GitHub data stale and never replaces the board with a notice.
Check: given a good read, then a failing iCloud six minutes later, expect the same events with `stale: true`, the `calendar` source `stale` and `calendar-unreachable` at 1; given a first read that fails, expect the broken panel with `from` set to `icloud`, the card's iCloud sentence on the page and no mention of `state/calendar.json` in that card, and `projects` equal to the board built without a calendar; given no `calendar` block and an unreadable `state/calendar.json`, expect the panel `{ "error": "unreadable" }` and the sentence naming the file; given a refused sign-in, expect `calendar-login-refused` at 1; given an answer that is not what the board asked for, expect a failure and not an empty calendar; given a failure and a working iCloud thirty seconds later, expect the same failure answer and no request; given the same two minutes later, expect fresh events and no warning.

**R102. The iCloud sign-in lives in the environment and goes only to Apple.**
`BOARD_ICLOUD_USER` and `BOARD_ICLOUD_APP_PASSWORD` are set together or not at all; with only one the board refuses to start with one plain sentence.
The sign-in is sent only as a request header, only over `https`, and only to `icloud.com` or a host name ending in `.icloud.com`; an address anywhere else is never requested, whether Apple's own answer or a redirect points to it, and a redirect is never followed at all.
The sign-in appears in no page, log line, error message, form token or file the board writes, and the settings file cannot hold it (the hard rule on a key named `password`).
Check: given only one of the two variables, expect a refusal that names both and holds neither value; given an iCloud whose answer points the calendars to `https://evil.example/`, and one that redirects there, expect no request to that host and a failed read (R101); given a host `icloud.com.evil.example` and an `http:` address, expect neither requested; given sentinel values for both variables and every route, action and forced failure run once with output, logs, response headers and the data directory captured, expect neither sentinel in any of them, and the password in requests to Apple hosts only, inside `authorization`.

**R103. The board only reads the calendar.**
The only requests it sends to Apple are `PROPFIND` and `REPORT`; it never creates, changes or deletes an event or a calendar.
Check: given every read path run once (a first read, a reuse, a new search for the calendars, a failure), expect every recorded request to an Apple address to be a `PROPFIND` or a `REPORT`.

**R104. A bad calendar setting is dropped and flagged, never fatal.**
The `calendar` block is a soft value: a block that is not an object, has a `source` other than `icloud` or `google` or has no list of calendars is ignored as a whole; an entry without a usable name, with a name already listed, or beyond the twentieth (beyond the fifth for `google`, R118) is dropped; an unknown `kind` becomes `meeting`.
Each of those adds one to `setting-invalid`, and a block left with no calendar switches the connector off (R96).
Check: given `calendars` holding `{ "name": "Home", "kind": "personal" }`, `{ "name": "Work" }`, `{ "name": " " }`, `{ "name": "home" }` and `{ "name": "Gym", "kind": "sport" }`, expect `Home` as `personal`, `Work` and `Gym` as `meeting`, and `setting-invalid` at 3; given `source` `yahoo`, expect no connector and `setting-invalid` at 1; given the block absent, expect no connector and no warning; given 25 good entries, expect 20 kept and `setting-invalid` at 5.

### The calendar card

**R105. All-day events sit in one line above the hours.**
When the calendar panel has all-day events, the card shows one line above the day's hours: the words "All day" and the titles, separated by ` · `; the line is an element with the attribute `data-allday` inside the calendar section.
The count in the card's head stays the number of timed events.
Without all-day events there is no such line; with all-day events and no timed event the card still shows, with the line and the empty hours.
The titles are escaped like every other string (R73) and are never links (R53).
The agent's `state/calendar.json` may carry `allDay` too, and the card treats it the same way.
Check: given a calendar panel with all-day events `Day off` and `Trip to the coast` and two timed events, expect one `data-allday` element inside the calendar section holding `All day`, both titles and ` · `, and the head still saying 2 events; given no `allDay`, expect no `data-allday` in the page; given `allDay` and no timed event, expect the calendar section with the line; given an all-day title of `"><script>alert(1)</script>&'` and one of `https://evil.example/x`, expect no `<script` beyond the board's own and no `href` for either.

**R106. The now-line never crosses an event's words.**
The line that marks the present time passes behind the event boxes, whose ground is solid, so it shows between events and never over a title or a time; its dot at the hour column always shows.
Check: in `board/static/board.css`, expect the rule for the now-line to have a `z-index` lower than the rule for an event box, and the event box rule to set a `background` from a theme variable that is not `transparent`; looking at an event that began a few minutes ago, at desktop width and at 390 pixels, is a line of `references/release-checklist.md`.

### The calendar from iCloud and the agent's file together

**R109. A setting shows the agent's file beside iCloud, and left out it changes nothing.**
`calendar.includeFile` is `true` or `false` and is read as `false` when absent.
A value that is neither adds one to `setting-invalid` and reads as `false`.
With it `false` or absent, the board is exactly as R96 describes it: for the same inputs the board, the page, the requests to Apple and the warnings are equal, byte for byte, to those of a board whose settings lack the key.
No calendar panel then carries `merged`, `fileDate` or a `source`, and the page holds no `data-source` and no `data-filedate` element.
Check: given a fixture with a usable block, an iCloud holding one event and a `state/calendar.json` holding another, expect the board and page with `includeFile` absent, with `false`, and with `"yes"` to be equal, apart from `setting-invalid` at 1 for `"yes"`; expect the iCloud event only, none of the three keys and no `data-source` in all three pages; given the key `true` and a block that R104 drops as a whole, expect the file's panel as R96 gives it and no `merged`.

**R110. The two sources are shown together only when all three conditions hold.**
The panel is merged (it carries `"merged": true`) when `calendar.includeFile` is `true`, the block is usable with at least one calendar (R104), and `state.calendar` is not `null` (the file is present, whether it is healthy or not).
When any of the three is missing, nothing in R111 to R115 applies: with no usable block the panel follows the file alone (R49, R96); with the block and an absent file it follows iCloud alone (R96), a missing file raising no warning.
Check: given `includeFile` true with a usable block and a present file, expect `merged` true; given the same with `state.calendar` null, expect the panel to equal the one built with `includeFile` false and no `merged`; given `includeFile` true and a block whose only entry has no usable name (so R104 switches the connector off), expect the file's events only and no `merged`.

**R111. A merged panel is one list, in the order of R98.**
The merged timed events are the iCloud events (R98) and the file's `events` (R51 kinds and cuts) in one list, in order of start, then end, then title, compared exactly as R98 compares them; two events that are equal in all three are ordered the iCloud one first, and two such events of one source keep their order in that source.
The list is cut to its first 30, and the count in the card's head is the length of what is shown (R105).
The all-day entries are the iCloud ones and the file's `allDay` in one list, in order of title as in R98, a tie going to the iCloud one first and then to source order, cut to the first 10.
Check: given iCloud events at 09:00 to 10:00 `B` and 08:00 to 08:30 `Z`, and file events at 09:00 to 10:00 `A`, 09:00 to 10:00 `B` and 07:00 to 07:15 `Y`, expect the order `Y`, `Z`, `A`, `B` (iCloud), `B` (file); given 20 events from each source, expect 30 shown, and the head saying 30; given all-day titles `Trip` in both sources and `Day off` in the file, expect `Day off`, `Trip` (iCloud), `Trip` (file); given 8 all-day entries from each, expect 10.

**R112. Every event of a merged panel says where it came from.**
Each event and each all-day entry carries `source`, a word, and the page writes it after the title in an element with the attribute `data-source`, whose text is the word alone.
For an event the board read from iCloud the word is `iCloud`.
For an event from the file the word is the file's `source` label, cleaned as R98 cleans a title (escapes undone, control characters removed, whitespace collapsed, trimmed) and cut at 20 characters with no ellipsis; the word is `File` when the label is absent, is not text, or is empty once cleaned.
A label is one word for the whole file: no event carries a label of its own, and an `events[].source` in the file is ignored.
The word is escaped like every other string (R73) and is never a link (R53).
In the line of R105 each all-day title is followed by its word in a `data-source` element, in the same way, and the titles stay separated by ` · `.
Check: given an iCloud event and file events, the file with no `source`, with `"Work diary"`, with `"  Work\n   diary  "`, with 30 letters, with `"><script>alert(1)</script>&'`, with `""` and with `7`, expect the iCloud event's word `iCloud` each time, and the file events' words `File`, `Work diary`, `Work diary`, the first 20 letters, the payload cut to 20 characters and escaped (no `<script` beyond the board's own, no `href`), `File` and `File`; given an event in the file with its own `source` of `Elsewhere`, expect it ignored; given an all-day entry from each source, expect each title followed by its own `data-source` inside the one `data-allday` element.

**R113. Either source failing leaves the other shown, and raises its own warning.**
The file fails when `state.calendar` is `{ "error": "unreadable" }` or fails its shape (R50); a file that is present, in shape and holds no events and no all-day entries is not failing, it is an empty source, and it raises nothing.
A failing file adds one to the warning `calendar-file-unreadable`, whose text on the page is `The calendar file from the agent could not be read, so its events are not shown.`
iCloud fails as R101 says, and raises its own warnings as before (`calendar-no-login`, `calendar-login-refused`, `calendar-unreachable`).
When one source fails and the other does not, the panel is the other source's events (iCloud's kept events of R101 count as shown when there are any), with `stale: true`, and its `calendar` source in `meta.sources` is `stale`; the panel is not the broken one.
When both fail, the panel is the broken one of R101 with `"from": "icloud"`, its source is `error`, and both warnings are raised.
When neither fails, `stale` is false and the source is `ok`, an empty source included.
Check: given a good iCloud and an unreadable file, expect the iCloud events with their word, `stale` true, the source `stale`, `calendar-file-unreadable` at 1 and no other calendar warning; the same for a file of wrong shape; given a failing iCloud (no sign-in) and a good file, expect the file's events, `stale` true, the source `stale`, `calendar-no-login` at 1 and no `calendar-file-unreadable`; given an iCloud that failed after a good read earlier today, expect those events with `iCloud` and the file's, and `calendar-unreachable` at 1; given both failing, expect `{ "error": "unreadable", "from": "icloud" }`, the source `error` and both warnings at 1; given a good iCloud and a file holding `"events": []`, expect the iCloud events only, `stale` false, the source `ok` and no `calendar-file-unreadable`; given a file with `"stale": true`, expect it ignored.

**R114. A file from an earlier day says so.**
When the panel is merged and the file does not fail, and the file's `date` is before today (R46: a calendar date compared in the board timezone), the panel carries `"fileDate"` with that date as `YYYY-MM-DD` and `"fileSource"` with the file's source word, and the page shows, inside the calendar section, an element with the attribute `data-filedate` holding exactly `<word> events are from <date>.`, where `<word>` is the file's source word of R112 and `<date>` is that date; the file's events are still shown, and the panel is not stale for that reason.
A file dated today or later has no `fileDate` and no such element.
Check: given today 2026-10-12 and a file dated 2026-10-11 with no label, expect `fileDate` `2026-10-11`, one `data-filedate` element reading `File events are from 2026-10-11.`, the file's events shown, and `stale` false; the same with the label `Work diary`, expect `Work diary events are from 2026-10-11.`; given a file dated 2026-10-12, and one dated 2026-10-13, expect neither key and no element; given the board timezone at `now` 2026-10-12T22:30:00Z in `Europe/Brussels` (already the 13th) and a file dated 2026-10-12, expect the note.

**R115. The same event in both sources is shown twice.**
The board matches nothing between the two sources: an event that appears in both is listed once for each, each with its own word, in the order of R111, and counts twice in the head and in the cap of 30.
Check: given the same event (same title, start and end) in iCloud and in the file, expect two events in the panel, the words `iCloud` and `File`, and the head counting both.

### The calendar from Google

These rules apply only when the settings have a `calendar` block whose `source` is `google`.
The board fetches each listed calendar's "secret address in iCal format" itself: one private `https` address per calendar, set in the environment.
Google's own calendar service (CalDAV) is not used, and no sign-in of the person's is held.
Wherever R96 to R104 and R109 to R115 say iCloud, Apple or an Apple address, they speak of `source` `icloud` and hold for it alone, unless a rule below extends them.

**R118. The settings can name Google as the source the board reads, and then the panel is the one iCloud gives, with a few differences.**
`source` is `icloud` or `google`; a block has one `source`, so a board reads iCloud or Google and never both at once.
With `google` the entries of `calendars` give each calendar a `name`, a label of the person's choice that is matched to nothing in Google, and an optional `kind` as R97 and R104 give it; every event takes the `kind` of its calendar's entry.
At most 5 calendars are read: an entry beyond the fifth is dropped and adds one to `setting-invalid`, and so does an entry whose `name` holds the text `://`.
Everything R98, R99, R105 and R106 say about the panel holds unchanged for `google`: what an event is, its time as `HH:MM` in the board timezone, the cuts at midnight, the order, the title, repeating events, all-day events, the caps of R51 and the card.
Four things differ.
First, the board knows no address of the person's own, so an invitation the person declined is not left out and is shown like any other event.
Second, no name is matched to anything: R97 does not apply and `calendar-not-found` is never raised.
Third, the broken panel is `{ "error": "unreadable", "from": "google" }` and the card reads "The calendar could not be read from Google. See the note at the foot of the page."
Fourth, the sign-in, the time limits, the failure rules and the warnings are those of R119 to R126, not those of R100 to R103.
With a usable `google` block the file `state/calendar.json` is ignored, unless the block has `includeFile` on (R127); event titles reach the page and the board's own last good read and are never written to GitHub (R54).
Check: given a block with `source` `google` naming `Home` (kind `personal`) and `Work`, an address for each and a stand-in Google holding one event today in each, plus a `state/calendar.json` holding a different event, expect the calendar section to show both events with kinds `personal` and `meeting` and not the file's; given the stand-in holding for `Home` an event with a `PARTSTAT=DECLINED` attendee line for any address, expect it shown; given a repeating event, a cancelled event, an all-day event and an event crossing midnight, expect them read as R98, R99 and R105 read them (the check of each of those rules, run against this source); given a `google` block naming 7 calendars, expect 5 read and `setting-invalid` at 2; given an entry named `https://example.invalid/x`, expect it dropped, `setting-invalid` at 1 and no request for it; given a block with `source` `google` and every address missing, expect the panel `{ "error": "unreadable", "from": "google" }` on the page with the card's Google sentence; given `source` `icloud` and no iCloud sign-in, expect the iCloud sentence as before.

**R119. Each calendar's secret address lives in the environment, numbered by its place in the settings, and nowhere else.**
The n-th entry of `calendars` as written in the file, counting entries that are dropped, reads the variable `BOARD_GOOGLE_ICAL_<n>`, for n from 1 to 5.
A value is trimmed, and a value that is empty once trimmed is not set; no other variable of that family is read.
No variable is required: the board starts whatever these variables hold, and with `source` `google` a listed calendar with no value set is not requested, adds one to the warning `calendar-google-no-address` (R125) and leaves the others to be read.
The settings file never holds an address: a settings file in which any text, at any depth, contains `calendar.google.com/calendar/ical/` is invalid as a whole (R72), and the page says that the file holds a Google Calendar address and names the top-level key it was found under, and neither the address nor any part of it.
The address is also never in the data repo and never on GitHub: it reaches no request the board makes to GitHub.
Check: given `calendars` holding `Home`, a blank name and `Work`, and `BOARD_GOOGLE_ICAL_1`, `_2` and `_3` set to three different stand-in addresses, expect `Home` read from the first, `Work` read from the third and no request to the second, and `setting-invalid` at 1; given a value of `  ` for the first, expect `calendar-google-no-address` at 1 and the second calendar still read; given `BOARD_GOOGLE_ICAL_6` set, expect it never read; given only the variables set and none of the Google settings, expect the board to start; given a settings file holding the sentinel address in a `url` key of a calendar entry, in the `name`, and in an unrelated key such as `agentName`, expect each time a 503 page that names `calendar` (or `agentName`) and holds none of the sentinel's parts, and no request to Google; given every request the board makes to GitHub in all the checks of this section, expect none to hold a part of any address.

**R120. Only an address of Google's calendar feed is ever requested.**
An address is accepted only when, read as the URL standard reads it (dot segments resolved, host in lower case), all of these hold: the scheme is `https`; the host is exactly `calendar.google.com`; the port is absent or 443; there is no user name or password; there is no query and no fragment; the path begins `/calendar/ical/`, ends `.ics` and has at least one character between the two; and the whole address is no longer than 2000 characters.
The same test is applied before every request for this source, to the address from the environment and to every target of a redirect (R121).
An address that fails it is a bad setting: that calendar is not requested, it adds one to `calendar-google-address-refused` (R125), and the board starts and keeps running with the other calendars read.
Check: given `https://calendar.google.com/calendar/ical/home%40example.invalid/private-0123456789abcdef/basic.ics` and the same with the host written `CALENDAR.GOOGLE.COM` and with port `:443`, expect accepted; given the same with `http:`, with a host of `calendar.google.com.evil.example`, `www.google.com`, `evil.example` and `accounts.google.com`, with `user:pw@` before the host, with `:8443`, with `#top` at the end, with `?x=1` before `.ics`, with `/calendar/render` as the path, with the path ending `.ics.html`, with nothing between `/calendar/ical/` and `.ics`, with a path of `/calendar/ical/../render/x.ics`, and an address of 2001 characters, expect each refused, no request to any host, `calendar-google-address-refused` at 1 each time and the board started; given one refused address and one accepted address in two listed calendars, expect the accepted one read and the refused one named in the warning.

**R121. The board only reads, redirects are the board's own business, and nothing leaves for any other origin.**
The only request the board sends for this source is `GET`, with the headers `Accept: text/calendar` and `User-Agent: board`, and with no `Authorization`, no `Cookie` and no `Referer`; every request is sent with redirects switched off (`redirect: 'manual'`).
An answer that is a redirect (status 301, 302, 303, 307 or 308) is followed by the board itself, with another `GET`, only when its `Location` (resolved against the address just asked) passes the test of R120, and at most three times in a row.
A redirect whose target fails the test (a login page on `accounts.google.com`, any other host, `http:`) is a read that Google did not accept (`calendar-google-address-rejected`), and no request goes to that target.
A fourth redirect in a row, and a redirect with no usable `Location`, is a read that Google did not answer (`calendar-google-unreachable`).
No request for this source ever leaves for an origin other than `https://calendar.google.com`, whatever address is handed to the code.
Check: given a stand-in Google answering the address with 302 to `https://accounts.google.com/ServiceLogin`, expect no request to that host, the calendar not accepted and `calendar-google-address-rejected` at 1; given a 302 to `https://evil.example/x`, to `http://calendar.google.com/calendar/ical/x/basic.ics` and to `https://calendar.google.com/calendar/render`, expect no request to the target and the same warning each time; given a 301 to another address that passes R120, expect that address asked next and its answer used; given four such redirects in a row, expect a failed read and `calendar-google-unreachable` at 1; given a redirect with no `Location`, expect the same; given every read path run once, expect every recorded request to be a `GET` to `calendar.google.com` with `redirect: 'manual'` and none of the three forbidden headers.

**R122. A calendar's whole feed is read, but only today is kept, within stated limits.**
The feed is the whole calendar; the events kept are the ones that fall on today in the board timezone, read by the same reading of an iCalendar text and of repeating events as R98 and R99 give, with the day, timezone, cuts, order and warnings (`calendar-event-skipped`, `calendar-zone-unknown`) as there.
Only an answer of status 200 can be a calendar.
The answer is a calendar only when its text, after a leading byte-order mark and any whitespace, begins `BEGIN:VCALENDAR` (read without regard to letter case) and holds a line `END:VCALENDAR`; the `Content-Type` is not consulted either way.
An answer of status 200 that is not a calendar in this sense (an HTML page, for instance a login page), and an answer of any other 2xx status, is a read that is not a calendar (`calendar-google-not-a-calendar`); a calendar with no events is an empty day and not a failure.
The largest answer accepted for one calendar is 10,000,000 bytes, counted as they arrive and cut off as soon as they pass it, whatever `Content-Length` says; the largest number of events in one answer is 20,000, counting every `BEGIN:VEVENT` (a changed occurrence of a repeating event counts as one).
An answer over either limit is not read: that calendar is not shown, it adds one to `calendar-google-too-large`, and the other calendars are shown as they are read.
These limits are for this source alone; the limits of the iCloud source are unchanged.
Check: given a feed holding one event today and 2,000 other events on other days, 19,999 on other days and one today, and 20,001 events, expect the first two to show the one event and the third to give `calendar-google-too-large` at 1 and that calendar absent; given an answer of exactly 10,000,000 bytes that is a calendar with one event today, expect that event, and given one of 10,000,001 bytes, and one that streams without end with no `Content-Length`, expect `calendar-google-too-large` and the stream cancelled soon after 10,000,000 bytes; given an answer of status 200 with `Content-Type: text/calendar` and an HTML body, one with `Content-Type: text/html` and a calendar body, one that starts right but stops before `END:VCALENDAR`, and a `204` with no body, expect the first, third and fourth to give `calendar-google-not-a-calendar` at 1 and the second to be read; given a calendar with no `VEVENT`, expect an empty day, `stale` false and no warning; given two calendars where one is over the limit, expect the other's events shown, `stale: true` and `calendar-google-too-large` at 1.

**R123. Google is asked at most once every five minutes for all calendars together, and never holds the page up for long.**
The listed calendars are asked at the same time, not one after another.
An answer is reused for five minutes for the same day, timezone and calendars, with no request at all.
One calendar's request gives up after eight seconds and the whole read after twelve; a calendar that has not answered by then is a read that Google did not answer (`calendar-google-unreachable`), and the calendars that did answer are used.
A read still under way is shared only by callers asking for the same day, timezone and calendars.
After a read in which any calendar failed to read (`calendar-google-address-rejected`, `-unreachable` or `-not-a-calendar`), Google is left alone for one minute for all calendars: a caller in that minute gets the same answer with no request, and a later one makes a fresh read of all calendars.
A read whose only trouble is a missing address, a refused address or a calendar too large is reused for five minutes like a good one.
Check: given two reads started together for the same day, timezone and calendars, expect one request per calendar and equal answers; given two reads one minute apart, expect requests for the first only; given a third read six minutes after the first, expect new requests; given a read after the date has changed, expect new requests; given five calendars each answered after three seconds, expect the whole read to end in under six seconds; given one calendar that never answers, expect that calendar failed within eight seconds and the others shown, and given all five never answering, expect the read to end within twelve seconds; given a failure and a working Google thirty seconds later, expect the same answer and no request, and two minutes later expect fresh events and no warning; given a missing address and a good calendar read, then a second read two minutes later, expect no new request.

**R124. When a calendar cannot be read the board shows what it last read today and says so.**
Each listed calendar ends a read in one of these states: read, or not read for one of six reasons (R125).
The panel is made of the events of the calendars that were read and, for each calendar that failed to read (not accepted, no answer, not a calendar), the events last read from that calendar earlier the same day for the same timezone; a calendar with no address, a refused address or a calendar too large contributes nothing.
Whenever any listed calendar is not read, the panel carries `stale: true` and the `calendar` source in `meta.sources` is `stale`; when every listed calendar is read, `stale` is false and the source is `ok`, an empty day included.
When no listed calendar is read and nothing is kept for today, the panel is `{ "error": "unreadable", "from": "google" }` and the source is `error`.
A calendar failure never makes the GitHub data stale and never replaces the board with a notice; an answer the board cannot read is a failure and never an empty day.
Check: given two calendars read well, then six minutes later one of them answering 503, expect the events of both (the failed one's from the earlier read) with `stale: true`, the source `stale`, `calendar-google-unreachable` at 1 and `names` holding only the failed calendar; given a first read in which one calendar answers 404 and the other is read, expect the other's events, `stale: true` and `calendar-google-address-rejected` at 1; given a first read that fails for the only calendar, expect the broken panel with `from` `google`, the source `error`, the Google sentence of R118 on the page and `projects` equal to the board built without a calendar; given a first read in which every calendar has no address, expect the broken panel and `calendar-google-no-address` with all names; given the failure of a calendar read the day before, expect no events from it and the broken panel when it was the only one; given a failure within the minute, expect the same failure answer and no request.

**R125. Each reason has its own warning, and the page says it in plain words with the calendar's name and never its address.**
A warning for this source has its code, a `count` of the calendars it concerns and `names`, their settings names in the order of the settings; the page writes `<names>` as each name in straight double quotes, separated by `, `, each name escaped like every other string (R73).
The six, with the exact text of the page (the text is followed by nothing else):
1. `calendar-google-no-address`: "No secret address was set for these Google calendars, so they are not shown: <names>. Copy the address from Google Calendar and set it where the board starts."
2. `calendar-google-address-refused`: "The secret address set for these Google calendars is not one the board will use, so they are not shown: <names>. Copy the address from Google Calendar again."
3. `calendar-google-address-rejected`: raised for status 401, 403, 404 or 410, and for a redirect that fails the test (R121): "Google did not accept the secret address for these calendars, so they could not be read: <names>. The address may have been reset. Copy it from Google Calendar again."
4. `calendar-google-unreachable`: raised for no connection, a time limit (R123), status 429, 5xx or any status not named in this rule or in R122, and for too many redirects: "Google did not answer for these calendars, so they may be out of date: <names>."
5. `calendar-google-not-a-calendar`: raised for the answers of R122 that are not a calendar: "Google sent something that is not a calendar for these calendars, so they could not be read: <names>. Copy the secret address from Google Calendar again."
6. `calendar-google-too-large`: "These Google calendars are too large for the board to read, so they are not shown: <names>."
One calendar raises at most one of the six in one read; `calendar-event-skipped` and `calendar-zone-unknown` are raised as in R98 and R99, summed over the calendars; `calendar-no-login`, `calendar-login-refused` and `calendar-unreachable` are never raised for this source.
Check: given each of the six conditions on a calendar named `Home` and, in a second run, on `Home` and `Work` together, expect the code at count 1 and 2, `names` `["Home"]` and `["Home","Work"]`, and the page text above with `"Home"` and `"Home", "Work"`; given status 200 with a calendar for one calendar and each of 401, 403, 404, 410, 429, 500 and 503 for another, expect the third warning for the first four and the fourth for the rest; given a calendar named `"><script>alert(1)</script>&'`, expect the name escaped and no `<script` beyond the board's own; given five calendars in the conditions numbered 1, 3, 4, 5 and 6, and a second run with 2 in place of 1, expect five distinct warnings counting one each, with `names` each holding its own calendar, and the page showing none of the sentinel address's parts.

**R126. The secret address shows nowhere, and R75 and R66 hold for it.**
R75 holds for each calendar's address as it holds for the token: the whole address, and each part of its path (the segment after `/calendar/ical/` that names the calendar, which can be the person's own email address, and the segment that is the private token), appear in no page, no log line, no error message, no warning text, no form token, no file the board writes and no header of any response the board sends.
The address is sent only as the address of the request to `calendar.google.com` (R121), and in no other request: not to GitHub, not in a header, not in a redirect target of another origin.
A calendar is named only by its settings `name`, in every message, warning and log line.
The board is not started with the address on its command line, starts no process with it as an argument, and no script of the board takes it as an argument.
R66 holds as it does for iCloud: the last good read holds today's event titles and the settings names of the calendars, and never an address or a part of one.
Check: given sentinel addresses `https://calendar.google.com/calendar/ical/SENTINEL-CAL-ID/private-SENTINEL-TOKEN/basic.ics` for each of two calendars, and every route, every action and every forced failure of R121 to R125 run once with output, logs, response headers, the data directory (the whole of `last-good.json` included) and every request to GitHub captured, expect the address, `SENTINEL-CAL-ID` and `SENTINEL-TOKEN` in none of them; expect the sentinel in the requests to the stand-in Google, in the request line only; given the process arguments of the running board, expect none of the three.

**R127. With the agent's file, Google works as iCloud does.**
`calendar.includeFile` works with `source` `google` exactly as R109 to R115 say it works with `icloud`, with these changes of wording and no other.
Wherever those rules say "iCloud", read "Google".
The word of R112 for an event the board read itself is `Google`, for all the calendars together.
The failure of that source is the state of R124, as R113 reads the state of R101: a panel that is `{ "error": "unreadable", "from": "google" }` when it alone fails and nothing is kept, and kept events counting as shown.
Its warnings are the six of R125, in place of `calendar-no-login`, `calendar-login-refused` and `calendar-unreachable`.
Check: run the check of each of R109, R110, R111, R112, R113, R114 and R115 with `source` `google`, a stand-in Google in place of the invented iCloud and the word `Google` in place of `iCloud`, and expect the results that rule states; in particular given both sources failing, expect `{ "error": "unreadable", "from": "google" }`, the source `error`, `calendar-file-unreadable` at 1 and one of the six warnings of R125.

**R128. A board that does not use this source is unchanged, whatever its environment holds.**
With `source` `icloud` or with no `calendar` block, no request of any kind goes to `calendar.google.com` or to any address named by a `BOARD_GOOGLE_ICAL_<n>` variable, whatever those variables hold, valid or not.
For the same inputs the board, the page, the requests the board makes, the warnings and the files it writes are equal, byte for byte, to those of the same board started without any of those variables.
A settings file that does not use this source is read as it was before R118 to R127, except that the sentence of R119 about `calendar.google.com/calendar/ical/` applies to every settings file.
Check: given a fixture with `source` `icloud` and a working invented iCloud, and in a second run with no `calendar` block, each started three times with no `BOARD_GOOGLE_ICAL_<n>`, with all five set to valid stand-in addresses and with all five set to `not an address`, expect the board and page equal in the three runs, the requests recorded equal, zero requests to a Google address and a stand-in Google that records nothing; expect no `data-source` and no `names` anywhere.

## What setup must leave on GitHub

The rules above hold only when setup, or a user doing it by hand, leaves things in this shape.

**S1.** One private data repo holds every issue; setup refuses a public one.
**S2.** The repo has the idea label and one `habit:<id>` label per habit.
Add (CP7): when the proposal names `modes`, each mode is a label in the data repo and in every home repo, coloured by its place in `modes`; a label that exists is left as it is.
**S3.** Each project is one GitHub Project owned by the repo's owner, with a `Due` date field, listed in `board.config.json` with a key and its number; no project title contains ` · `.
Add (CP7): a project with a `home` (a private repository of the same owner, which setup never creates) has its Project linked to that repository. With `ideas`, an `Ideas` Project exists; with a habit that has `score`, a `Habits` Project exists with a number field `Score`. Neither is a listed project.
**S4.** Each milestone is titled `<Project title> · <Milestone>` and has a due date, written as noon UTC of that date.
Add (CP7): a milestone of a project with a `home` lives in the home repo and is titled with its own title alone.
**S5.** Every project task setup creates is an item of its Project and sits in its milestone, with its `Due` set when the proposal gives one; a standalone task is an item of no Project.
Add (CP7): a task of a project with a `home` is an issue of the home repo.
**S6.** `board.config.json` is committed at the repo root and validates against the settings shape; when one already exists, setup adds to it and removes nothing from it.
Add (CP7): the settings carry `home`, `modes`, `ideas`, `habitsProject` and `habits[].score` only when the proposal gives them, and a key already present is kept.
**S7.** Setup writes an undo record listing every label, Project, field, milestone, issue and file it created, and undo touches only what that record lists: Projects, milestones, labels and files are deleted, issues are closed as not planned.
Undo refuses to delete a Project or milestone that now holds issues the record does not list, unless told to with `--force`, and says what else would go.
A pull request, and an issue of another repo that happens to carry a listed number, are things the record does not list.
Undo also refuses, unless told to with `--force`: a settings file whose content changed since setup wrote it (it says the file was changed), and a Project or milestone holding more than undo can read in its page limit (it says it could not check everything).
An entry may name its own `repo` of the record's owner (a home repo); undo acts on it there with the same checks, and skips and names an entry whose `repo` belongs to another owner. A link of a Project the record does not list is undone by unlinking it.
Whatever the record says, undo deletes no file but `board.config.json`, and it changes nothing for a record whose `repo` is not written `owner/name` in letters, digits, dots, dashes and underscores.
Running undo again after it stopped partway finishes the job: what is already gone counts as removed, a Project deleted earlier included (GitHub answers that second delete with an error of type `NOT_FOUND`, observed 13 Oct 2026).
Undo asks for a listed milestone itself before it lists that milestone's issues, and lists nothing for one that is gone: GitHub answers the issue list of a milestone that no longer exists with status 422, not 404 (observed 13 Oct 2026, when the first fix of this rule passed every test and still failed on the real service).
While undo checks what a listed milestone or Project holds, only two answers mean "already gone": the milestone itself answering not found, and the first request for the Project's items answering not found.
Any other failed read of what they hold (the issue list of a milestone that was just found, a later page of a Project's items) stops undo before it changes anything, and the record stays where it is.
The settings file is checked again at the moment it is deleted: unless told to with `--force`, undo stops there when the content is no longer what setup wrote (it says the file was changed), and what it removed before that stays removed.
A listed settings file whose record entry holds no content id cannot be checked and is deleted without the check, as before; the deletion is a commit in the data repository, so the content stays in its history.
**S8.** Running setup twice with the same proposal creates nothing twice.
A proposal without `modes`, `ideas`, `home` or `score` makes the same requests and writes the same settings and undo record as before CP7.
**S9.** The token: on an organisation, a fine-grained token with repository permissions Issues (read and write) and Contents (read and write), and organisation permission Projects (read and write); on a personal account, a classic token with `repo` and `project`.
The running board only ever reads repository contents (R54); the write permission is for setup and undo.

Check for S1 to S8: `node scripts/rules.mjs S1 S2 S3 S4 S5 S6 S7 S8` runs setup and undo against a recording GitHub client and asserts each line above.

## What was seen against live iCloud, and what was not

R96 to R103 were written from the CalDAV and iCalendar standards and are tested against an invented iCloud.
In October 2026 `node scripts/calendar-check.mjs` and then the board itself were run against one real account: Apple accepted an app-specific password, the search for the calendars worked, the events request for one named calendar was answered, and the account's owner compared the card with that calendar and found its five events right, in title and time.
That is one account, one calendar and one day. Not seen: how Apple answers a wrong sign-in, an event in an unusual time zone, an all-day event from a real account, and the repeat forms that day did not happen to hold.

## What was seen against live Google, and what was not

R118 to R128 were written from the iCalendar standard, from Google's help page for the secret address and from a research note, and are tested against an invented Google.
No real Google account has been used.
Not seen: the shape of a real secret address, how long Google takes to show a change, how big a real calendar's whole feed is, what Google answers to a reset or wrong address (R125 treats 401, 403, 404 and 410 alike for that reason), whether a declined invitation is in the feed, and whether a work account offers the address at all.

## Proven against live GitHub

These facts came from GitHub's documentation or from reports when this contract was written.
`node scripts/probe.mjs` checks each one against a scratch repo and prints pass or fail; a failure changes the named rule before any code relies on it.
All eight were observed to hold in October 2026, on an organisation with a fine-grained token and on a personal account with a classic token.
What the run added is written into the rules it touches: the two-step read of a Project's items (the Raw shape), the lag of GitHub's lists behind a write (R70), and that a milestone's `due_on` written at noon UTC reads back at midnight UTC of the same date (R16 and S4 hold either way).

**V1.** A fine-grained token with the permissions of S9 can list an organisation's Projects, list a Project's items with their Status and `Due`, and add an issue to a Project (R4, R12, R59, R93).
**V2.** A classic token with `repo` and `project` can do the same on a personal account.
**V3.** A milestone created with `due_on` at noon UTC reads back with the same UTC calendar date (R16, S4).
**V4.** Creating a Project, adding a `Due` date field to it, setting an item's `Due`, and deleting the Project work with each token type; where one does not, setup asks the user to do that step by hand and says why (S3, S5, S7).
**V5.** The shape of a Project item as GitHub returns it, saved outside the public tree, so the reader is built against the real thing.
**V6.** A milestone whose date was picked in GitHub's own page reads back with that UTC calendar date (R16).
**V7.** With each token type: creating, closing and reopening an issue, setting labels and a milestone on it, and creating, updating and deleting a file in the repo (R56 to R61, S6, S7).
**V8.** GitHub accepts the API version header the reader sends, and answers with an `ETag` on the issues, milestones, Project items and contents addresses (R64).
