# Keeping your board in Notion

This guide and the feature it describes were written from Notion's developer documentation.
They have been tested against a stand-in Notion server only.
They have not yet been run against a real Notion workspace.
Where a step rests on what Notion does rather than on what the board does, the guide says so.

## What it does and what it does not

With Notion, your projects, tasks, goals, ideas and habit check-ins live in five tables in your own Notion workspace.
The board reads them and shows the same page as it does from GitHub.
The four things you can do on the page still work: write down an idea, tick a habit, sort an idea into a project, close a task.
Each one changes a row in your Notion tables.

- The board never deletes a row. Sorting an idea ticks its `Filed` box instead.
- Your settings stay in a folder on the computer where the board runs, not in Notion.
- Your token goes only to Notion. It is never written to a page, a log or a file.
- A board reads GitHub or Notion, not both at once.

## Notion's terms

Using Notion's API with your token means you accept [Notion's Developer Terms](https://notion.notion.site/Developer-Terms-ba4131408d0844e08330da2cbb225c20) (last updated 2 April 2026 when this guide was written), together with Notion's Content & Use Policy and Brand Guidelines.
Read them yourself; this is a summary of what touches the board, not legal advice.

- Howgozit is an independent project. It is not made, endorsed, certified or supported by Notion, and Notion offers no support for it.
- Your token is yours alone. The terms forbid a tool from asking for your token, and the board never does: you type it on your own computer, and it goes only to Notion. Never give it to anyone, us included.
- Your data stays with you. The board reads your tables from your own computer and keeps a copy of its last read there (the `.board-data` folder, see "Removing it"). Nothing reaches Blastworks.ai or anyone else.
- The board keeps to Notion's rate limits: it waits when Notion asks it to and reads only what changed between full reads.
- Notion may change or stop its API at any time. If it does, the Notion side of the board may stop working until the board is updated.

## The five tables

Notion calls a table a "data source".
Create five, in any pages you like, with exactly these property names and types.
The names are case-sensitive; spell them as shown.
The title property of each table (every table has one) may be called what you like, but this guide calls it `Name`.

Projects:

| Property | Type |
| --- | --- |
| `Name` | Title |
| `ID` | Unique ID |

Cards (your tasks):

| Property | Type |
| --- | --- |
| `Name` | Title |
| `ID` | Unique ID |
| `Status` | Status |
| `Project` | Relation to Projects |
| `Goal` | Relation to Goals |
| `Blocked by` | Relation to Cards |
| `Mode` | Select |
| `Due` | Date |

Goals (a stage of a project, such as "Hallway"):

| Property | Type |
| --- | --- |
| `Name` | Title |
| `ID` | Unique ID |
| `Project` | Relation to Projects |
| `Due` | Date |
| `Done` | Checkbox |

Ideas:

| Property | Type |
| --- | --- |
| `Name` | Title |
| `ID` | Unique ID |
| `Filed` | Checkbox |

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

- `Status` keeps Notion's three groups (To-do, In progress, Complete). A card counts as done when its status is in the Complete group. A board that closes a card needs at least one option in that group; Notion's default `Done` is one.
- `Mode` is a label such as `DO`. Its option colour becomes the label's colour on the board.
- `Score` is only needed for habits you score. Without it the habits still tick.
- A relation needs the table it points to to exist first. Notion's documentation says the related table must also be shared with your token (see below).
- Whether a relation is one-way or two-way does not matter to the board [to be confirmed against a real workspace].

## The token

The board needs a Notion token that can read, update and insert content.
Choose one of two.

A personal access token (recommended for a tool of your own):

- Notion's documentation recommends it for personal or developer-owned workflows.
- It acts as you, with your page permissions, so there is no sharing step.
- It belongs to one workspace.
- It expires after the time you choose, up to one year. An expired token is refused; make a new one in Notion's settings and set it again where the board starts.
- Who may make one depends on your Notion plan. On the Free plan only workspace owners can.
- Give it the read, update and insert content capabilities.

An internal connection:

- You make it in Notion's developer portal (`https://app.notion.com/developers/connections`), under Internal connections. Its token is on the Configuration tab.
- Notion's documentation is not consistent on whether only a workspace owner may make one. If you cannot, use a personal access token or ask your workspace owner.
- Give it the read, update and insert content capabilities.
- It sees nothing until you share pages with it. Share each of the five tables with it, either from the portal's Content access tab or in Notion with the page's `•••` menu, then Connections. Sharing a parent page also shares the pages inside it.

Whichever you choose, treat the token like a password.
Never paste it into a chat and never write it into a file inside a repository.

## Finding the five ids

The board needs the id of each table (the data source id), a 32-character code that may be written with dashes.
Where Notion shows it on screen is not covered by the documentation this guide was written from [to be confirmed against a real workspace].
Notion's documentation does say that the id is what the API calls the data source, and that a database can hold more than one data source, each with its own id.
If a table has only one data source, that is the one.

## The `notion` block in `board.config.json`

Keep `board.config.json` in a folder on the computer where the board runs.
Add this block, with your own ids in place of these invented ones:

```json
"notion": {
  "projects": "0123456789abcdef0123456789abcdef",
  "cards": "1123456789abcdef0123456789abcdef",
  "goals": "2123456789abcdef0123456789abcdef",
  "ideas": "3123456789abcdef0123456789abcdef",
  "habitLog": "4123456789abcdef0123456789abcdef"
}
```

- All five ids are needed. If one is missing or is not a data source id, the board says so and shows nothing.
- The block holds ids only, never a token.

Projects in your settings are listed by number, as on GitHub.
On Notion the number is the project's `ID` in the Projects table.
A project with `ID` 3 is `{ "key": "house", "number": 3 }`.
Only projects listed in your settings are shown.

For habits that carry a score, add this to your settings:

```json
"habitsProject": { "owner": "notion", "number": 999 }
```

It is a switch.
It means "scored habits read their `Score` from the Habit log".
The number can be any whole number above zero; use 999.
It does not need to match any row in Notion.
Pick a number no row in Projects has, or the setting is ignored and the board warns about it.

The `Habit` select options must match the habit ids in your settings.
When you tick a habit for a day that has no row, the board creates one; Notion's documentation says a new select name is added as an option when the token may write to the table.

## The environment

The board reads these values from the terminal where it starts.
The values below are placeholders.

| Name | What it holds |
| --- | --- |
| `BOARD_BACKEND` | `notion` |
| `BOARD_NOTION_TOKEN` | your Notion token |
| `BOARD_CONFIG_DIR` | the folder that holds `board.config.json` |
| `BOARD_FORM_KEY` | a key that signs the page's forms: at least 32 characters, no spaces |

With Notion you set no `BOARD_REPO` and no GitHub token.
If you do set them, they are ignored.
Without `BOARD_NOTION_TOKEN` or `BOARD_CONFIG_DIR` the board refuses to start and says which one is missing.

Type the secret ones unseen in your own terminal, then start the board in the same terminal.
macOS or Linux:

```
export BOARD_BACKEND=notion
export BOARD_CONFIG_DIR=/path/to/your/settings/folder
read -s BOARD_NOTION_TOKEN; export BOARD_NOTION_TOKEN
read -s BOARD_FORM_KEY; export BOARD_FORM_KEY
```

Windows PowerShell:

```
$env:BOARD_BACKEND = "notion"
$env:BOARD_CONFIG_DIR = "C:/path/to/your/settings/folder"
$s = Read-Host "Notion token" -AsSecureString
$env:BOARD_NOTION_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
$s = Read-Host "Form key (32 or more characters)" -AsSecureString
$env:BOARD_FORM_KEY = [System.Net.NetworkCredential]::new('', $s).Password
```

Do not put a token or key in a command line, because other programs on the computer can list command lines.
To keep them for next time, use the same ways as the GitHub token in `references/deploy-local.md`, section "Keeping the token for next time".
Only the names differ.
The other deployment values (mode, host, port, a login proxy) work as in `references/contract.md`, section "Deployment values".

## How the board reads Notion

- The first read, and one a day after that, reads every row of the five tables.
- Between those, it asks only for rows edited since its last read.
- A single read stops at 10,000 rows per table, as Notion's own limit does. A board that large is shown as incomplete, with a note.
- If Notion does not answer, the board keeps showing its last good read and marks it out of date.
- If Notion limits the requests, the board waits as long as Notion asks, up to ten seconds, and then tries again a few times.

## Limits you should know about

- A Project title must not contain ` · ` (a space, a middle dot, a space). The board joins a goal's title to its project's title with that mark, and a title that holds it splits in the wrong place.
- A goal related to two Projects shows under the first one only.
- A done card's day on the 12-week map is the day of its last edit, because Notion does not record when a card was closed. Editing a done card later moves its day.
- A row you delete in Notion leaves the board at its next daily full read, not at once.
- A Notion page published to the web cannot be seen through the API, so the board cannot tell that one exists. This is a known gap, not something the board has checked.
- A card's address on the page is built from its Notion page id. It opens the page in Notion when you are signed in.
- Notion limits how fast any tool may ask. Notion's documentation gives 180 requests a minute per token on most plans, and more on Business and Enterprise.

## What has not been proven

Notion's documentation and a stand-in Notion server were the material.
Nothing has been run against a real Notion workspace.
Not yet seen: where Notion shows a table's data source id, the exact shape of a relation with more than 25 rows, how soon a changed row shows in a read, how a personal access token's edits are labelled in Notion, and whether the default names Notion gives a status and a dependency match the ones above.
If you try it, please say what you saw.

## Removing it

1. Delete the `notion` block from `board.config.json`, and the `habitsProject` line if you added it.
2. Unset `BOARD_BACKEND`, `BOARD_NOTION_TOKEN` and `BOARD_FORM_KEY`, and delete any stored copy and the lines in your start script.
3. Revoke the token in Notion: delete the personal access token, or remove the connection from the pages you shared.
4. The board's saved copy of its last read may still hold your titles. Deleting the `.board-data` folder is safe, and the next read fills it again.
