# Keeping your board in Notion

This guide and the feature it describes were written from Notion's developer documentation.
Where a step rests on what Notion does rather than on what the board does, the guide says so.

Follow it top to bottom.
You make a token, run the setup script to build your tables and a starter board, then start the board.

You need a Notion workspace of your own, one you are the owner of.
If you only belong to someone else's workspace, such as your employer's, make a personal one first; it is free, and you are its owner.

## What you get

A Notion page called Howgozit, holding four tables.
Notion calls a table a "data source".

- **Projects**: the things you are working on.
- **Tasks**: what you do. Each one can belong to a project and a goal.
- **Goals**: a stage of a project, such as "Hallway". A goal belongs to its project through its `Project` relation.
- **Habit log**: one row per habit per day.

How the board reads them:

- An idea is a task tagged `Idea` that has no project.
- Sorting an idea into a project sets its `Project` and removes the `Idea` tag, on the same page. No second page is made.
- A card's mode (`DO`, `THINK`, `REVIEW`, `LAUNCH`) is one of the task's `Tags`.
- A task that waits for another uses `Blocked by`. The other task shows it under `Blocking`.

What the board does with them:

- It reads your tables and shows the same page as it does from GitHub.
- The four things you can do on the page still work: write down an idea, tick a habit, sort an idea into a project, close a task. Each one changes a row in your Notion tables.
- The board never deletes a row.
- Your settings stay in a folder on the computer where the board runs, not in Notion.
- Your token goes only to Notion. It is never written to a page, a log or a file the board makes.
- A board reads GitHub or Notion, not both at once.

## Notion's terms

Using Notion's API with your token means you accept [Notion's Developer Terms](https://notion.notion.site/Developer-Terms-ba4131408d0844e08330da2cbb225c20) (last updated 2 April 2026 when this guide was written), together with Notion's Content & Use Policy and Brand Guidelines.
Read them yourself; this is a summary of what touches the board, not legal advice.

- Howgozit is an independent project. It is not made, endorsed, certified or supported by Notion, and Notion offers no support for it.
- Your token is yours alone. The terms forbid a tool from asking for your token, and the board never does: you type it on your own computer, and it goes only to Notion. Never give it to anyone, us included.
- Your data stays with you. The board reads your tables from your own computer and keeps a copy of its last read there (the `.board-data` folder, see "Removing it"). Nothing reaches Blastworks.ai or anyone else.
- The board keeps to Notion's rate limits: it waits when Notion asks it to and reads only what changed between full reads.
- Notion may change or stop its API at any time. If it does, the Notion side of the board may stop working until the board is updated.

## 1. Make a token

The setup script needs a Notion token that can create pages and databases.
The board then needs one that can read, update and insert content.
One token can do both.
Choose one of two kinds.

A personal access token (recommended):

- Notion's documentation recommends it for personal or developer-owned workflows.
- It acts as you, with your page permissions, so there is no sharing step.
- It can create the Howgozit page at the top of your workspace.
- It belongs to one workspace.
- It expires after the time you choose, up to one year. An expired token is refused; make a new one in Notion's settings and set it again where the board starts.
- Who may make one depends on your Notion plan. On the Free plan only workspace owners can.
- Where to find it, as Notion's documentation describes it (October 2026; Notion may rename or move these, and its own pages word the first step two ways):
  1. In Notion on a computer, open **Settings** and turn on **Developer Mode** (also called "Enable developer features", under **Developer**). Notion says this is not available on mobile.
  2. Open **Personal access tokens** from the developer section in your sidebar.
  3. Select **New token**.
  If you cannot find it, Notion's documentation links the token page directly: `https://www.notion.so/developers/tokens`.
- Notion's "New personal access token" dialog (seen 15 Oct 2026) asks for a name, an expiry (one year at most) and its capabilities. Name it `howgozit`. Tick **Notion API** (read, write and search content, comments and users). Leave **Workers** unticked; the board does not use it. Creating the token accepts Notion's Developer Terms.
- Select **Create token**, then copy the token. Step 2 shows where it goes.

The backup: an internal connection, if you cannot make a personal access token.
This road works differently from the first, and your agent might need to tinker a little.

- You make it in Notion's developer portal (`https://app.notion.com/developers/connections`), under Internal connections. Its token is on the Configuration tab.
- Notion's documentation is not consistent on whether only a workspace owner may make one. If you cannot, use a personal access token or ask your workspace owner.
- Give it the read, update and insert content capabilities.
- It sees nothing until you share pages with it, and it cannot create a page at the top of a workspace.
- So first make an empty page in Notion and share it with the connection: the page's `•••` menu, then Connections. Copy that page's id, and give it to the script as `--parent` (step 2).
- The Howgozit page and its tables are then made inside your shared page, and the connection can see them.

Whichever you choose, treat the token like a password.
Never paste it into a chat and never write it into a file inside a repository.

## 2. Run the script first

The script is `scripts/notion-setup.mjs`, and you run it from the `src` folder.
It has two roads:

- **A new board (recommended): `plan` then `apply` a proposal.** It builds the page and the four tables, fills in your projects, goals and tasks, and writes a complete starter `board.config.json`. Steps 2a and 2b.
- **Tables only: the bare run.** It builds the page and the four tables and prints the `notion` block, and you write the settings yourself (step 3). Step 2c.

Keep the token out of your shell history.
Put it in a file only you can read, outside any repository, as one line:

```
BOARD_NOTION_TOKEN=paste-your-token-here
```

For example, make the file with these lines in bash or zsh (paste the token and press Enter; nothing is shown):

```
( umask 077; mkdir -p ~/.config/board; printf 'BOARD_NOTION_TOKEN=' > ~/.config/board/notion.env; read -s T; printf '%s\n' "$T" >> ~/.config/board/notion.env )
chmod 600 ~/.config/board/notion.env
```

### 2a. Write a proposal

The proposal is a JSON file with the shape of `references/setup-proposal.md`, without `owner` and `repo` (the script refuses them).
`name` and `timezone` are required.
`projects`, `standalone`, `habits`, `focus` and `modes` are optional.
A habit takes an optional `"score": { "min": 1, "max": 10 }`, as on GitHub, if you want a 1 to 10 score on it.
A smallest example, saved as `proposal.json`:

```json
{
  "name": "Sam",
  "timezone": "Europe/Brussels",
  "projects": [
    {
      "key": "house",
      "title": "House",
      "milestones": [{ "title": "Hallway", "due": "2026-11-20" }],
      "tasks": [{ "title": "Paint the hallway", "milestone": "Hallway" }]
    }
  ],
  "standalone": [{ "title": "Renew passport" }],
  "habits": [{ "id": "move", "title": "Move" }, { "id": "mood", "title": "Mood", "score": { "min": 1, "max": 10 } }],
  "focus": ["house"]
}
```

### 2b. Plan, then apply

`plan` lists every table, row and file `apply` would create.
It writes nothing, sends nothing to Notion and needs no token:

```
node scripts/notion-setup.mjs plan proposal.json
```

Read the list.
Each line says `new` or `already there`, and the last says how many steps would write.
Then apply it:

```
node --env-file=$HOME/.config/board/notion.env scripts/notion-setup.mjs apply proposal.json
```

`apply` creates the page and four tables if they are missing, then one Projects row per project, one Goals row per stage and one Tasks row per task, then a complete starter `board.config.json`.
The settings file goes to `./config` (relative to where you run the command) unless you give `--config-dir <dir>`.
Add `--parent <page id>` for an internal connection, `--state <file>` to move the state file, and `--json` for JSON output.
It saves a record after every write (`.howgozit-notion-rows.json`, beside the state file), so running the same command again, or after a stop, never makes a second row.
It ends by printing the environment lines to set, as in step 4: `BOARD_BACKEND=notion`, `BOARD_NOTION_TOKEN`, `BOARD_CONFIG_DIR` and the form key command.
Go to step 4; steps 2c and 3 are for the tables-only road.

### 2c. Tables only

The bare run builds the page and the four tables, with their relations and rollups, and prints the settings `notion` block.
Run it with Node's `--env-file`.
The token is read from the file and never appears on the command line:

```
node --env-file=$HOME/.config/board/notion.env scripts/notion-setup.mjs --habits mood,walk
```

Use your own habit ids in place of these two.
They are the `id` of each entry in `habits` in your settings, and they become the options of the Habit log's `Habit` property.
If you already have a settings file, give it instead: `--settings /path/to/board.config.json` reads the habit ids from it.
Give `--habits` or `--settings`, not both.

If you use an internal connection, add `--parent <page id>`:

```
node --env-file=$HOME/.config/board/notion.env scripts/notion-setup.mjs --parent <page id> --habits mood,walk
```

What it prints on a first run:

```
Created the Howgozit page and its four tables.
"notion": {
  "projects": "<data source id>",
  "goals": "<data source id>",
  "tasks": "<data source id>",
  "habitLog": "<data source id>"
}
```

Keep that block for step 3.
Add `--json` to get the same facts as JSON.

Running it again:

- A second run changes nothing. It reads back what the first run made and prints the same block.
- It records what it made in a state file called `.howgozit-notion.json` in the folder where you run it. `--state <file>` puts that file somewhere else.
- A run that stopped half way carries on from the state file when you run the same command again.
- It never changes anything it did not create. It finds the page by its title, Howgozit, under the parent (or at the top of the workspace). If a page called Howgozit is already there and does not hold exactly the four tables, it refuses and changes nothing.
- On a second run it prints `The Howgozit page and its four tables are already there; nothing was changed.`

To look before it writes, add `--dry-run`.
It prints `Dry run: nothing was written. It would:` and the list of steps still to do, and writes nothing, not even the state file.

Words you may meet:

- `Set BOARD_NOTION_TOKEN to a Notion token that can create pages and databases.` The token is not set where the script runs.
- `An internal connection cannot create a page at the top of a workspace: share a page with the connection in Notion and run this again with --parent <page id>.` Use `--parent`.
- `Notion would not create the page under that parent; share the page with the connection and check the id given to --parent.` The page is not shared with the connection, or the id is wrong.

## 3. The settings

Skip this step if you used `apply` in step 2b; it wrote a starter `board.config.json` for you.
Otherwise:

Keep `board.config.json` in a folder on the computer where the board runs.
Add the block the script printed:

```json
"notion": {
  "projects": "0123456789abcdef0123456789abcdef",
  "goals": "2123456789abcdef0123456789abcdef",
  "tasks": "1123456789abcdef0123456789abcdef",
  "habitLog": "4123456789abcdef0123456789abcdef"
}
```

The ids above are invented.
Use the ones the script printed.

- All four ids are needed. If one is missing or is not a data source id, the board says: `The settings need a notion block with the four data source ids (projects, tasks, goals, habitLog); see notion-setup.md.`
- The block holds ids only, never a token.

The rest of the settings:

- **Projects.** With no `projects` list in your settings, every Projects row whose status is not Done shows, keyed `notion-<ID>` in `ID` order.
A project you add in Notion appears with no settings edit.
To restrict or order them, give a `projects` list of entries like `{ "key": "house", "owner": "notion", "number": 3 }`.
The number is the project's `ID` in the Projects table, which you see in Notion once you have added the project.
Give it no `home`.
A project title must not contain ` · ` (a space, a middle dot, a space).
- **Ideas.** Add `"ideas": { "owner": "notion", "number": 998 }`. It tells the board that ideas are the tagged tasks with no project. The number is a marker, not a row; 998 sits outside the range of your project numbers.
- **Scored habits.** Add `"habitsProject": { "owner": "notion", "number": 999 }`. It means "scored habits read their `Score` from the Habit log". The number is a marker too; 999 does not need to match any row. Pick a number no row in Projects has, or the setting is ignored and the board warns about it.
- **Modes.** Keep `modes` as you have it, for example `DO`, `THINK`, `REVIEW`, `LAUNCH`. A task shows a mode when its `Tags` hold a tag with that name. A tag that is not a mode is never shown as one. The script makes those four tags and `Idea`; the colour of each tag is the colour of the mode on the page.
- **Habits.** Keep `habits` as you have it. The ids must match the options of the Habit log's `Habit` property. When you tick a habit for a day that has no row, the board creates one, and Notion adds a new option name when the token may write to the table.
- `focus`, `timezone`, `name`, `labels`, `season` and `calendar` stay as they are.

## 4. The environment

The board reads these values from the terminal where it starts.
The values below are placeholders.

| Name | What it holds |
| --- | --- |
| `BOARD_BACKEND` | `notion` |
| `BOARD_NOTION_TOKEN` | your Notion token |
| `BOARD_CONFIG_DIR` | the folder that holds `board.config.json` |
| `BOARD_FORM_KEY` | a key that signs the page's forms: at least 32 characters, no spaces |

Make the form key with this one line, and set the result without pasting it into a chat:

```
node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
```

With Notion you set no `BOARD_REPO` and no GitHub token.
If you do set them, they are ignored.
Without `BOARD_NOTION_TOKEN` or `BOARD_CONFIG_DIR` the board refuses to start and says which one is missing.
A `BOARD_FORM_KEY` shorter than 32 characters, or one with spaces, is refused too.

A shorter way on macOS or Linux: the token is already in `~/.config/board/notion.env` from step 2.
Add the form key to the same file, generated without showing it:

```
printf 'BOARD_FORM_KEY=%s\n' "$(node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))")" >> ~/.config/board/notion.env
```

Then start the board with Node's `--env-file`:

```
BOARD_BACKEND=notion BOARD_CONFIG_DIR=/path/to/config node --env-file=$HOME/.config/board/notion.env board/server.mjs
```

Or, the other way (and the Windows road), type the secret ones unseen in your own terminal, then start the board in the same terminal.
macOS or Linux:

```
export BOARD_BACKEND=notion
export BOARD_CONFIG_DIR=/path/to/your/settings/folder
read -s BOARD_NOTION_TOKEN; export BOARD_NOTION_TOKEN
read -s BOARD_FORM_KEY; export BOARD_FORM_KEY
node board/server.mjs
```

Windows PowerShell:

```
$env:BOARD_BACKEND = "notion"
$env:BOARD_CONFIG_DIR = "C:/path/to/your/settings/folder"
$s = Read-Host "Notion token" -AsSecureString
$env:BOARD_NOTION_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
$s = Read-Host "Form key (32 or more characters)" -AsSecureString
$env:BOARD_FORM_KEY = [System.Net.NetworkCredential]::new('', $s).Password
node board/server.mjs
```

Run `node board/server.mjs` from the `src` folder.
Do not put a token or key in a command line, because other programs on the computer can list command lines.
To keep them for next time, use the same ways as the GitHub token in `references/deploy-local.md`, section "Keeping the token for next time".
Only the names differ.
The other deployment values (mode, host, port, a login proxy) work as in `references/contract.md`, section "Deployment values".

## What you should see

With the board started, in another terminal:

```
curl http://localhost:8787/healthz
```

It answers `ok` (HTTP 200). The default port is 8787; `BOARD_PORT` changes it.
Then open `http://localhost:8787`.
You should see a page headed with your name, the projects of your proposal (those in `focus` first), a "What's next" list, your habits with a streak of zero, and an ideas box.
A project you add in Notion shows on the next read when your settings have no `projects` list.
If the board will not start, it prints one sentence naming the missing value (`BOARD_NOTION_TOKEN`, `BOARD_CONFIG_DIR` or `BOARD_FORM_KEY`).
If the page is empty, check that `BOARD_CONFIG_DIR` is the folder that holds `board.config.json`, and that the token can see the Howgozit page.

## 5. Building the tables by hand

Prefer to make the tables yourself?
Do this instead of step 2, then write the settings of step 3 yourself.
Make a page called Howgozit, and inside it four full-page or inline databases, titled exactly Projects, Goals, Tasks and Habit log.
Property names are case-sensitive; spell them as shown.
The title property of each table is named as in the first row of its table.
Make Projects first, then Goals, then Tasks, because a relation needs the table it points to.

Projects:

| Property | Type |
| --- | --- |
| `Project name` | Title |
| `ID` | Unique ID |
| `Status` | Status |
| `Priority` | Select |
| `Dates` | Date |
| `Owner` | Person |
| `Tasks` | Relation to Tasks (two-way, with Tasks' `Project`) |
| `Goals` | Relation to Goals (two-way, with Goals' `Project`) |
| `Completion` | Rollup |

Goals:

| Property | Type |
| --- | --- |
| `Goal name` | Title |
| `ID` | Unique ID |
| `Due` | Date |
| `Done` | Checkbox |
| `Project` | Relation to Projects (two-way, with Projects' `Goals`) |
| `Tasks` | Relation to Tasks (two-way, with Tasks' `Goal`) |
| `Completion` | Rollup |

Tasks:

| Property | Type |
| --- | --- |
| `Task name` | Title |
| `ID` | Unique ID |
| `Status` | Status |
| `Due` | Date |
| `Priority` | Select |
| `Tags` | Multi-select |
| `Assignee` | Person |
| `Project` | Relation to Projects (two-way, with Projects' `Tasks`) |
| `Goal` | Relation to Goals (two-way, with Goals' `Tasks`) |
| `Blocked by` | Relation to Tasks (two-way; the other side is named `Blocking`) |
| `Blocking` | Relation to Tasks (the other side of `Blocked by`) |

Habit log (one row per habit per day):

| Property | Type |
| --- | --- |
| `Name` | Title |
| `ID` | Unique ID |
| `Habit` | Select, with one option for each habit id in your settings |
| `Date` | Date |
| `Done` | Checkbox |
| `Score` | Number |

Notes on the properties:

- `Tags` holds the options `DO`, `THINK`, `REVIEW`, `LAUNCH` and `Idea`. Their colours are the colours of the modes on the board.
- `Status` keeps Notion's three groups (To-do, In progress, Complete). A task counts as done when its status is in the Complete group. A board that closes a task needs at least one option in that group; Notion's default `Done` is one.
- `Completion` is a rollup of the related tasks' `Status`, shown as a percentage by group. The board does not read it.
- `Score` is only needed for habits you score. Without it the habits still tick.
- Whether a relation is one-way or two-way does not matter to the board [to be confirmed against a real workspace], but the script builds them two-way.
- Each table numbers its own rows, so a task, a goal and a check-in may share a number.

Then find each table's data source id and write the `notion` block of step 3 yourself.
Where Notion shows it on screen is not covered by the documentation this guide was written from [to be confirmed against a real workspace].
Notion's documentation says the id is what the API calls the data source, and that a database can hold more than one data source, each with its own id.
If a table has only one data source, that is the one.
If you use an internal connection, share the Howgozit page with it; sharing a parent page also shares the pages inside it.

## How the board reads Notion

- The first read, and one a day after that, reads every row of the four tables.
- Between those, it asks only for rows edited since its last read.
- A single read stops at 10,000 rows per table, as Notion's own limit does. A board that large is shown as incomplete, with a note.
- If Notion does not answer, the board keeps showing its last good read and marks it out of date.
- If Notion limits the requests, the board waits as long as Notion asks, up to ten seconds, and then tries again a few times.

## Limits you should know about

- A goal related to two Projects shows under the first one only.
- A done task's day on the 12-week map is the day of its last edit, because Notion does not record when a task was closed. Editing a done task later moves its day.
- A done task tagged `Idea` with no project is shown neither as an idea nor as a card.
- A row you delete in Notion leaves the board at its next daily full read, not at once.
- A Notion page published to the web cannot be seen through the API, so the board cannot tell that one exists. This is a known gap, not something the board has checked.
- A card's address on the page is built from its Notion page id. It opens the page in Notion when you are signed in.
- Notion limits how fast any tool may ask. Notion's documentation gives 180 requests a minute per token on most plans, and more on Business and Enterprise.

## What has not been proven

Notion's documentation and a stand-in Notion server were the material for the setup script.
Not yet seen: where Notion shows a table's data source id, the exact shape of a relation with more than 25 rows, how soon a changed row shows in a read, and how a personal access token's edits are labelled in Notion.
If you try it, please say what you saw.

## Removing it

1. Delete the `notion` block from `board.config.json`, and the `ideas` and `habitsProject` lines if you added them.
2. Unset `BOARD_BACKEND`, `BOARD_NOTION_TOKEN` and `BOARD_FORM_KEY`, and delete any stored copy (the env file of step 2 too) and the lines in your start script.
3. Revoke the token in Notion: delete the personal access token, or remove the connection from the pages you shared.
4. Delete the `.howgozit-notion.json` state file and the `.howgozit-notion-rows.json` record (and the `config` folder `apply` made, if you no longer want it), and the Howgozit page in Notion if you no longer want the tables.
5. The board's saved copy of its last read may still hold your titles. Deleting the `.board-data` folder is safe, and the next read fills it again.
