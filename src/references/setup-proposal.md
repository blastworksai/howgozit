# The setup proposal

The proposal is a single JSON file.
The agent writes it after the interview.
It is the one thing the person approves before anything is created on GitHub.
Read it back to the person in plain words, and change it until they say yes.

## Shape

Required: `owner` and `repo`.
`name` and `timezone` are required for a first setup, and optional when the repo already holds a settings file.
Optional: `projects`, `standalone`, `habits`, `focus`.
No other top-level key is allowed.

- `projects[]`: `key`, `title`, and optionally `milestones[]` (`title`, optional `due`) and `tasks[]` (`title`, optional `due`, optional `milestone`).
- `standalone[]`: tasks that belong to no project, each with a `title`.
- `habits[]`: `id`, `title`, and optionally `project`.
- `focus[]`: project keys.

## Example

```json
{
  "owner": "sam-life",
  "repo": "life",
  "name": "Sam",
  "timezone": "Europe/Brussels",
  "projects": [
    {
      "key": "house",
      "title": "House",
      "milestones": [
        { "title": "Hallway", "due": "2026-11-20" },
        { "title": "Garden shed", "due": "2027-03-31" }
      ],
      "tasks": [
        { "title": "Paint the hallway", "milestone": "Hallway", "due": "2026-11-10" },
        { "title": "Pick a colour" },
        { "title": "Order shed panels", "milestone": "Garden shed" }
      ]
    },
    {
      "key": "choir",
      "title": "Choir",
      "milestones": [{ "title": "Spring concert", "due": "2027-04-18" }],
      "tasks": [
        { "title": "Learn the alto line", "milestone": "Spring concert" },
        { "title": "Book the hall", "milestone": "Spring concert", "due": "2027-01-15" }
      ]
    },
    {
      "key": "japan",
      "title": "Japan trip",
      "milestones": [{ "title": "Bookings", "due": "2027-02-28" }],
      "tasks": [
        { "title": "Compare flights", "milestone": "Bookings" },
        { "title": "Check passport dates" }
      ]
    }
  ],
  "standalone": [{ "title": "Renew passport" }, { "title": "Call the dentist" }],
  "habits": [
    { "id": "move", "title": "Move" },
    { "id": "sing", "title": "Sing for ten minutes", "project": "choir" }
  ],
  "focus": ["house", "choir"]
}
```

## Rules for a valid proposal

- A project `key` uses lower-case letters, digits and dashes.
- A title must not contain the separator ` · ` (a space, a middle dot, a space).
- Keys are unique. Titles are unique. A date is `YYYY-MM-DD` and a real day.
- A task's `milestone` is the short title of a milestone in the same project.
- A habit's `project` is a project key from this proposal or from the existing settings.
- The repo must be private. Setup refuses a public one.

When a rule is broken, the check names the place, for example `projects[1].title: …`.
Fix that place and run the check again.

## What the commands do with it

All commands are run with `node scripts/setup.mjs`, and the token comes from `BOARD_GITHUB_TOKEN`.

- `check --repo owner/name` tests the token, that the repo can be read and is private, and that the owner's Projects can be listed.
- `plan <proposal.json>` validates the file, then walks the whole setup without writing anything. It lists each label, Project, milestone, issue and file it would create, and each one that is already there.
- `apply <proposal.json>` does the same walk for real. It creates labels, Projects (with a `Due` field), milestones, issues, and the settings file `board.config.json`. Each task is added to its Project, with its `Due` set when the proposal has one.
- Things are matched by name. Running `apply` twice with the same file creates nothing twice.
- An existing settings file is added to, never rewritten. Nothing in it is removed or changed.
- Every object `apply` creates is written to `setup-undo.json` as it goes, so a run that stops halfway can still be undone with `node scripts/undo.mjs`.
- If GitHub refuses to create a Project or its field, that project is skipped and the run ends with a plain sentence saying what to do by hand in GitHub, then to run `apply` again.

## On Notion

A Notion board uses the same proposal with `owner` and `repo` left out; the check refuses them.
`name` and `timezone` are required.
A habit may also carry `score: { "min": 1, "max": 10 }` (whole numbers, 1 <= min < max <= 10), as on GitHub; it gives the habit that score and makes setup add the scored-habits setting.
The commands are `node scripts/notion-setup.mjs plan <proposal.json>` and `apply <proposal.json>`; see `references/notion-setup.md`.
