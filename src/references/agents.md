# The optional agents

The board works with GitHub alone.
Five small agents can add to it.
Each one is optional and independent of the others.
Four of them each write one file into the `state/` folder of the person's data repo. The review agent opens one issue instead.
The board reads those files and shows a panel for each one that exists.

An "agent" here means any agent runner that has three things:
a schedule, access to the person's mail and calendar tools, and access to the repo on GitHub.
Nothing below names a particular product.
Setting up a runner is the person's choice; this file only says what each agent does and gives it a prompt.

Replace `{name}` in the prompts with the person's name (Sam in the examples).

## Rules for every agent

- Write one file, or open one issue. Nothing else.
- Keep text short. The board cuts long text and ends it with an ellipsis.
- Store titles and subjects. Never store email bodies, addresses, passwords, tokens or anything secret.
  The repo is the person's own and private, but files in it live for years.
- Never put a link in a state file. The board shows no link from these files.
- Write times in the person's own timezone, with the offset, like `2026-10-12T06:00:00+02:00`.
- After a run, add one entry to the front of `state/log.json` (see "The log" at the end).
- If a run fails, change nothing. An old file is better than a broken one.

## brief

**What it is for.** It gives the person a few plain lines about the day ahead.

**When it runs.** Each morning, after the calendar and inbox agents, if those are in use. For example 06:00.

**What it reads.** The board's data: open issues due today or overdue, milestones that fall due soon, habit streaks.
It also reads `state/calendar.json` and `state/inbox.json` when they exist.

**What it writes.** `state/brief.json`.
At most five lines, each at most 200 characters.
`src` is a short tag of where the line comes from, such as `CAL`, `MAIL` or `GH`.
The board turns `generated` into "stale" when it is not from today.

```json
{
  "generated": "2026-10-12T06:00:00+02:00",
  "lines": [
    { "src": "CAL", "text": "4 events today. The longest free block is 14:00 to 16:30; protect it." },
    { "src": "MAIL", "text": "2 threads need a reply, 1 needs a decision. 2 drafts are ready." },
    { "src": "GH", "text": "Move streak is at 9 days. Nothing overdue." }
  ]
}
```

**Prompt.**

```
You write the morning brief for {name}.
Read the open issues that are due today or overdue, the milestones due this week, and the habit streaks.
Read state/calendar.json and state/inbox.json if they exist.
Write at most five lines. Each line has a short tag (src) and a text of at most 20 words.
Suggested lines: CAL (how many events today, the longest free block, say to protect it),
MAIL (threads that need a reply or a decision, drafts ready),
GH (the most notable streak, anything overdue by project).
Be plain and specific. No encouragement, no advice about life.
Write the result as state/brief.json with the keys "generated" (now, with timezone offset) and "lines".
Do not copy email subjects, addresses or any secret into the brief.
Then add one entry to state/log.json.
```

**Limits.** Five lines, 200 characters each. It reads files, not mail. It changes nothing but its one file and the log.

## inbox

**What it is for.** It sorts new mail into three groups so the person sees at a glance what needs them.

**When it runs.** Every 30 minutes during the day, for example 06:00 to 22:00.

**What it reads.** New mail since the last run, through whatever mail tool the harness has.

**What it writes.** `state/inbox.json`.
Each thread has a bucket (`reply`, `decide` or `fyi`), the sender's name, the subject, and a one-line reason.
`draft: true` means a draft reply is waiting in the person's mail tool; the board shows a "Draft ready" badge, not a link.
The board shows at most 30 threads. A thread with any other bucket is dropped.
The file is stale after 24 hours.

```json
{
  "updated": "2026-10-12T07:45:00+02:00",
  "counts": { "reply": 1, "decide": 1, "fyi": 6 },
  "threads": [
    { "bucket": "reply", "from": "Accountant", "subject": "Q3 documents", "why": "Asked a direct question", "draft": true },
    { "bucket": "decide", "from": "Choir secretary", "subject": "Hall booking for April", "why": "Needs a yes or no by Friday" }
  ]
}
```

**Prompt.**

```
You sort the new email for {name}.
Put each email in exactly one bucket:
reply (someone asked {name} something), decide (it needs a yes or no), fyi (newsletters, receipts, notifications).
For each email store only: the sender's display name, the subject, the bucket, and a one-line reason.
RULE: store subjects and titles. Never store an email body, never an email address, never a password,
code, token or anything secret. If in doubt, leave it out.
For a reply, write a short draft in {name}'s voice and save it as a draft in the mail tool. Never send anything.
Count the threads per bucket and write state/inbox.json with "updated", "counts" and "threads".
Keep at most 30 threads, the most recent and the most urgent first.
Then add one entry to state/log.json.
```

**Limits.** It never sends mail. It never stores a body or an address.
It changes only its one file and the log, plus drafts in the mail tool.
If the person wants a task from an email, they add it themselves.

## calendar

**What it is for.** It shows today's events on the board without the board touching the calendar.

**When it runs.** Early each morning, and again whenever the calendar changes if the harness can do that.

**What it reads.** Today's events, and tomorrow's if it wants to look ahead.

**What it writes.** `state/calendar.json`.
Each event has a title, a start and end as `HH:MM`, and a kind: `meeting`, `focus`, `habit` or `personal`.
Any other kind is shown as `meeting`. The board shows at most 30 events.
The panel is stale when `date` is not today.

```json
{
  "date": "2026-10-12",
  "events": [
    { "title": "Standup", "start": "08:30", "end": "08:45", "kind": "meeting" },
    { "title": "Focus: choir parts", "start": "14:00", "end": "16:30", "kind": "focus" },
    { "title": "Dentist", "start": "17:30", "end": "18:15", "kind": "personal" }
  ]
}
```

**Prompt.**

```
List today's events for {name}, in {name}'s timezone.
For each event write: the title, the start and end as HH:MM, and a kind: meeting, focus, habit or personal.
Titles only. Do not copy the description, the attendee list, the location, links or any notes.
Write state/calendar.json with "date" (today as YYYY-MM-DD) and "events", in time order. At most 30 events.
All-day events may go in a separate list "allDay", each as { "title": "…" }; the board shows them in one line above the hours. At most 10.
Do not move, create or delete any calendar event.
Then add one entry to state/log.json.
```

**Limits.** Titles only. It only reads the calendar.
If the person wants an agent that moves events, that is a different job and not part of the board.

**Or without an agent.** The board can also read iCloud calendars itself.
With a `calendar` block in the settings, this agent's file (`state/calendar.json`) is ignored, unless the block has `"includeFile": true`; then the board shows both together.
The file may carry an optional `"source"` label (up to 20 characters) that the board writes after each of its events when both are shown.
See `references/calendar-icloud.md`.

## review

**What it is for.** It looks back over the week and forward to the next one, once a week.

**When it runs.** Weekly, for example Sunday at 18:00.

**What it reads.** The week's closed and open issues, the habit check-ins, the milestones coming up.

**What it writes.** One new issue in the data repo, with the label `weekly-review`.
The board ignores issues with that label, so the review never shows up as a task or counts towards progress.
(The label is the default of `labels.ignore` in the settings. If the person changed that list, use the label on it.)
It also adds a line to `state/log.json`.

An example issue title is `Week 42 · review`.
An example body:

```
Closed this week
- House: Paint the hallway
- Choir: Learn the alto line

Carried over
- Japan trip: Compare flights

Habits
- Move: streak 9 days, 1 token used

Next week
1. Finish the hallway paint (#12, due Sunday)
2. Book the hall (#31)
3. Compare flights (#44)
```

**Prompt.**

```
Write the weekly review for {name} as one new GitHub issue in the data repo.
Give it the label weekly-review. Title: "Week <number> · review".
Look back: what was closed this week, by project; what carried over; streaks gained or lost; tokens used.
Look forward: three suggested priorities for next week, each naming an issue by number.
Keep it under 25 lines. Plain words, no pep talk.
Do not put anything private in it. Use issue titles, not details from mail or the calendar.
Open exactly one issue. Do not edit or close any other issue.
Then add one entry to state/log.json.
```

**Limits.** One issue per run. It does not change, close or label any other issue.

## triage

**What it is for.** It looks at the ideas waiting in the backlog and suggests where each one belongs.

**When it runs.** Daily, or twice a week. Often enough that the file stays under 24 hours old when the person looks at it.

**What it reads.** The open issues labelled as ideas, the projects with their milestones, the current focus, and optionally the other state files.

**What it writes.** `state/proposals.json`.
`ideas` holds one suggestion per idea: the idea's number, an existing project key, optionally a milestone number, and a short reason.
`focus` is optional. It says which projects to add to or remove from the focus, and why.
The board shows a suggestion beside its idea.
For a suggestion that names an existing project (and a milestone that is open, if given), the person can accept it with one button.
That moves the idea into the project and milestone.
Nothing changes until the person clicks.
A file older than 24 hours is marked out of date, and its suggestions cannot be accepted.

```json
{
  "updated": "2026-10-12T06:00:00+02:00",
  "focus": { "add": ["choir"], "remove": [], "why": "Two milestones fall due this week" },
  "ideas": [
    { "number": 41, "project": "house", "milestone": 5, "newProject": null, "why": "Same room as the hallway work" },
    { "number": 47, "project": "japan", "milestone": null, "newProject": null, "why": "About booking a hotel" }
  ]
}
```

**An idea that fits no project.** The agent suggests a new project by name.
It sets `project` to `null`, `milestone` to `null` and `newProject` to the name.

```json
{
  "updated": "2026-10-12T06:00:00+02:00",
  "ideas": [
    { "number": 52, "project": null, "milestone": null, "newProject": "Vegetable garden", "why": "Three ideas about beds and seeds fit no project" }
  ]
}
```

The board shows this suggestion but cannot accept it.
Creating a project is not something the board does.
Only after the person says yes, in the chat with the agent, does the agent act:

1. It writes a small proposal file holding just that project (the shape is in `references/setup-proposal.md`).
   It leaves out the other projects, and names the owner and repo of the data repo.
2. It shows the file to the person in plain words.
3. It runs `node scripts/setup.mjs apply <file>`.
   Setup adds the project to the existing settings and removes nothing.
4. It then moves the idea into the new project, or writes a fresh suggestion for it on the next run.

```json
{
  "owner": "sam-life",
  "repo": "life",
  "projects": [
    {
      "key": "garden",
      "title": "Vegetable garden",
      "milestones": [{ "title": "First planting", "due": "2027-04-30" }],
      "tasks": [{ "title": "Plan the beds", "milestone": "First planting" }]
    }
  ]
}
```

**Prompt.**

```
You suggest where each waiting idea belongs for {name}. You only suggest; you never move anything yourself.
Read the open ideas, the projects with their open milestones, and the current focus.
For each idea, pick the best existing project (by its key) and, if one clearly fits, an open milestone (by its number).
Give a short reason, one sentence. If you are not sure, leave the idea out.
If an idea fits no project, set "project" and "milestone" to null and "newProject" to a short name.
Optionally write a focus proposal: projects to add to or remove from the focus, with a short reason.
Suggest a change only when the dates or the work clearly call for it.
Write state/proposals.json with "updated", and optionally "focus" and "ideas".
Use only project keys and milestone numbers that exist. Do not invent either.
Never create a project on your own. Only after {name} says yes to a named new project:
write a small proposal file holding just that project, show it, and run
node scripts/setup.mjs apply <file>.
Then add one entry to state/log.json.
```

**Limits.** It suggests; the person decides.
It never sorts an idea, changes the focus, or creates a project without a yes.
The board never infers the focus, so a focus proposal is only ever text until the person changes the settings.

## The log

Every agent adds one entry to `state/log.json` when it has run.
The file is a list, newest first.
The board shows the first 10 entries in the "Agent did" card.
Keep the list short: drop the entries after the first 30.

```json
[
  { "t": "07:45", "agent": "inbox-agent", "what": "Sorted 8 threads, saved 1 draft" },
  { "t": "06:00", "agent": "brief-agent", "what": "Wrote this morning's brief" }
]
```

`t` is the time of the run as `HH:MM`, `agent` is the agent's name and `what` is one short line.
Read the file, put the new entry first, write it back.

## How the agents write

Each agent saves its file as one commit to the data repo, through the harness's GitHub access.
The commit holds that one file and nothing else.
On a board started with `BOARD_CONFIG_DIR` (every Notion board) the state files live in `<config dir>/state/` instead, and the Glitch feed (R161) may write them too.
The board writes no file to the data repo. It only reads the files there.
The one file it writes is a local cache of its last good read, in its own data folder on the computer it runs on.

## When an agent stops

Nothing breaks.
The board shows the panel marked out of date when its file is old:
a brief not from today, a calendar not for today (when shown beside iCloud's events, it says the date of its events instead), an inbox or proposals file more than 24 hours old.
A suggestion in an out-of-date proposals file cannot be accepted.
A file that is not valid shows the panel as unreadable, and the rest of the board is unaffected.
If a file is removed, its panel goes away.

## All five are optional

The board needs none of them.
Run one, some or all.
Each reads the repo and its own tools, and writes its own file.
The brief gets better when the calendar and inbox agents run, but it works without them.
