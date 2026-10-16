---
name: howgozit
description: Use this when a person wants one page that shows all their projects, tasks, ideas and habits, kept on their own private GitHub or in their own Notion workspace. You interview them, propose the setup, get one approval, create everything on GitHub and start the board.
---

# Howgozit

## What this is

Howgozit is one web page that shows a person's whole life in one place.
Below it is called the board.
It shows what to focus on, what to do next, deadlines, progress per project, habits with streaks, and a list of ideas.
Everything lives as cards on GitHub, in one private repository that belongs to the person.
A small server (Node 22, no other software to install) reads that repository and draws the page.
You do the whole setup after a short interview and one approval.

## What you need

- Node 22 or newer. Check with `node --version`. If it is older or missing, tell the person to install Node 22 from nodejs.org, then carry on.
- A GitHub account, and one private repository for the data. Setup does not create the repository. If the person has none, walk them through making an empty private one on GitHub (the "New repository" page, a name such as `life`, "Private" ticked) before step 3.
- A GitHub token. It is the key that lets setup and the board use the repository.

Which token depends on where the board lives:

- An organisation (a free one is enough): a fine-grained token. It can be limited to the one repository. This is the safer choice, and the one to recommend.
- A personal account: a classic token. It is broader: it can reach all of the person's repositories. It is the only kind GitHub allows for personal Projects.

The exact permissions to tick are in `references/contract.md` (rule S9).
Pitfalls and how to create each token are in `references/github-notes.md`. Read it before you walk the person through making a token.

All commands below are run from this skill's folder.

## Ground rules

- Use plain words. The person is not a developer. A GitHub issue is "a card on GitHub"; say that once and then say "card".
- Never ask the person to paste a token into the chat. Never print it, never write it in a file inside the repository.
- The token goes into an environment variable called `BOARD_GITHUB_TOKEN`. Tell the person to type this in their own terminal:

  macOS or Linux (the token is typed unseen):

  ```
  read -s BOARD_GITHUB_TOKEN; export BOARD_GITHUB_TOKEN
  ```

  Windows (PowerShell):

  ```
  $s = Read-Host "Paste your token" -AsSecureString
  $env:BOARD_GITHUB_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
  ```

- The variable only exists in the terminal where it was set. If your commands run in a different terminal, hand the person each command to run in theirs, and ask them to tell you what it printed.
- Ask permission once for each step that leaves this machine. Then either run it, or give the person the one-line command to run themselves. Never ask twice for the same step.
- Create nothing on GitHub until the person has given the one approval in step 3.
- The repository must be private. Setup refuses a public one. Do not try to get round that.
- Never store email bodies, passwords or anything secret in the repository. Titles and subjects only.
- Do not use the words "token", "API", "JSON", "milestone" or "environment variable" without one short explanation the first time.

## Step 1: The interview

Ask one question at a time. Wait for the answer. Keep the person's own words for titles.
Do not offer a list of options when an open question works. Do not ask what you can work out.
When you already have an answer, from Glitch or from earlier in the conversation, do not ask the question. Say what you have and ask only for a yes.
You are running inside Glitch when the folder this conversation started in, or a folder above it, holds `glitch-mem/Memory/USER.md`. That folder is the Glitch folder; the two Glitch steps below run there, not in this skill's folder.

1. "What are you working on, or want to work on? Say it however it comes. Big things, small things, half ideas."
2. Read their list back, grouped. Keep anything that sounds like a daily habit aside for question 4, and say so. "Which of these belong together? A group is a project. Anything that stands alone stays on its own." Accept their grouping. Do not invent projects.
   If you are running inside Glitch, the person's Glitch workspaces are projects they already have. List them with `uv run --directory <Glitch folder>/.claude/scripts python workspaces.py list`, and take only the entries whose `status` is `active`, by their `slug`. Every other status is not a project of its own: a task inside another workspace, a copy, or a folder Glitch could not read. Offer them once, by name: "You already have these projects in Glitch: <names>. Shall I add them all as projects here too?" Add the ones they keep. A project added this way needs no stages or tasks; in question 3, ask only about the ones the person wants to fill in now.
3. For each project, one at a time: "What is the next stage of this? Give me one or two." Each stage becomes a milestone. Then: "What are the first few things to do for it?" Aim for three to five tasks. Ask for a date only where the person already has one. Never push for dates.
4. "Which habits do you want to keep? Pick a few, small ones, things you can do every day. Or say 'not right now' if you don't want to track habits yet." Two to five is right. A habit may belong to a project if the person says so. "Not right now" means no habits; carry on without asking again.
5. "Which of these projects matter most right now?" More than one is fine. These become the focus. A person with no answer gets no focus yet.
6. "What is your first name, and what timezone are you in?" Convert a city or country to a name like `Europe/Brussels` yourself. Confirm it in plain words.
   If you are running inside Glitch, it already knows both: read the `Name` and `Timezone` lines under "Basic Info" in `glitch-mem/Memory/USER.md` in the Glitch folder. A line still holding a `<...>` placeholder is not filled in. When both are filled in, confirm them instead of asking: "I have you as <name>, on <timezone> time. Is that right?" Ask only for what is missing or wrong.
7. Where it lives. First the difference, in two sentences:
   "If you mostly work on coding projects, I would recommend GitHub, because the board then sits right beside your code. If your projects are not about code, you may find Notion more intuitive."
   Then the places:
   "On GitHub, the board can live in a free GitHub organisation, which lets me give it a key limited to this one repository, or in your personal account, which works but needs a broader key that can reach all your repositories. On Notion, it lives in your own Notion workspace, in four tables the setup makes for you. That needs a Notion workspace you own and a Notion token, and no GitHub at all."
   Recommend by their projects: GitHub when they are mostly code, Notion when they are not. On GitHub, recommend the organisation.
   Ask: GitHub organisation, GitHub personal account, or Notion.
   One board lives in one place. If the projects are mixed, the person still picks one place; never set up both.
   If they choose GitHub, ask what the account or organisation is called.
   If they choose Notion, do not ask for an account name. Follow "The Notion road" below instead of Steps 2 and 3, and ask no more GitHub questions.

If the person only gives you one project, or only habits, carry on. A small board is a good start.

## Step 2: The proposal

Write the proposal to a file called `proposal.json` in this folder.
The shape and every rule it must satisfy are in `references/setup-proposal.md`. Follow it exactly.
An example for orientation: owner `sam-life`, repo `life`, name `Sam`, one project `House` with a stage `Hallway` and two tasks, one standalone task, one habit `Move`, focus on `house`.

Then show it to the person, in plain words. Never show the file or the JSON. Use this order:

- Where it will live: the repository, and whether it is an organisation or a personal account.
- Each project, with its stages and dates, and the tasks under each stage.
- The tasks that stand alone.
- The habits.
- What is in focus.
- What will be created on GitHub, in one sentence: "a card for every task, a GitHub Project for each of your projects, a few labels, and a small settings file".

End with: "What would you change?"

Steer until it is right. Change the file after each correction, and read back only what changed.
When they say it is fine, ask for the one approval, and say what it covers:
"If you say yes, I will create all of this on your GitHub, in one go. Nothing is created before that. I will also save a note of everything I made, so it can all be taken away again. Shall I go ahead?"

A question like "looks good" is not a yes. Ask once more, plainly, if you are unsure.

## Step 3: Doing it

Before each command, say in a sentence what it will do. If your harness asks for permission, that is the one ask for that step.

1. Check the token and the repository.

   ```
   node scripts/setup.mjs check --repo sam-life/life
   ```

   Use the real owner and repository name. Each line printed is a check; read the failures to the person in plain words (see "When something goes wrong").

2. Show what would be created. This changes nothing.

   ```
   node scripts/setup.mjs plan proposal.json
   ```

   Summarise the list for the person: how many projects, stages, cards and labels, and anything that already exists. If this is not what they approved, go back to step 2.

3. Do it. Only after the approval.

   ```
   node scripts/setup.mjs apply proposal.json
   ```

   It prints a count at the end. It also writes `setup-undo.json` in this folder. Tell the person to keep that file.
   Before it ends it waits until GitHub lists everything it added. That can take a couple of minutes. Tell the person this is normal, and do not stop it.
   Running it again with the same proposal creates nothing twice, so it is safe to retry after a failure.

4. If it prints steps to do by hand, give them to the person one at a time, in their words, with the page address if one is given. Wait until the person says each is done. Then run `apply` again to finish. A common one is GitHub refusing to add a date field; the fix is to add it in GitHub's own page for that project.

5. Start the board.

   ```
   BOARD_REPO=sam-life/life node board/server.mjs
   ```

   On Windows PowerShell set the repository first with `$env:BOARD_REPO = "sam-life/life"` and then run `node board/server.mjs`.
   `BOARD_GITHUB_TOKEN` must already be set in the same terminal. The board starts in `local` mode, so only this computer can open it.
   Give the person the address: `http://localhost:8787`. Ask them to open it.
   To check from here that the board can read the repository, open a terminal where `BOARD_GITHUB_TOKEN` is set and run `BOARD_REPO=sam-life/life node scripts/read-once.mjs`. On Windows PowerShell set `$env:BOARD_REPO` first. It prints counts only.

6. What they should see: a page headed with their name, the projects in focus first, a "What's next" list of up to five tasks, a timeline of the stages with dates, progress per project, their habits with a streak count of zero, an ideas list, and a list of tasks that stand alone.
   Show them the four things they can do on the page: write down an idea, tick a habit, sort an idea into a project, close a task.
   Tell them that ticking a habit today counts for today only, and that a missed day uses up a saved day if they have one.
   Panels for a morning brief, calendar, inbox and an activity log appear only when an agent writes for them. Without one, they stay hidden. That is correct.
   The calendar panel has a second way in: the board can read the person's iCloud calendars itself (see "Agents (optional)" below).

The board stops when the terminal closes. To start it again later, run the same start command.
Keeping the token for next time and starting the board at login are in `references/deploy-local.md`.

## The Notion road

Use this instead of Steps 2 and 3 when the person chose Notion. Steps 1 and 4 stay the same, and the ground rules hold, with `BOARD_NOTION_TOKEN` in place of `BOARD_GITHUB_TOKEN`.
Notion needs no repository. It makes a page called Howgozit with four tables in the person's workspace.
The person needs a Notion workspace of their own, one they are the owner of. Say so plainly before the token. If they only belong to someone else's workspace, such as their employer's, have them make a personal one first (free in Notion); they become its owner.

1. The token. Walk the person through making a Notion personal access token by reading `references/notion-setup.md`, section "1. Make a token", including where to find it in Notion. Do not ask them to read it to you.
   Never ask them to paste the token into the chat. Tell them to type it in their own terminal:

   macOS or Linux (the token is typed unseen):

   ```
   read -s BOARD_NOTION_TOKEN; export BOARD_NOTION_TOKEN
   ```

   Windows (PowerShell):

   ```
   $s = Read-Host "Paste your token" -AsSecureString
   $env:BOARD_NOTION_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
   ```

   If the person cannot make a personal access token, offer the backup: an internal connection, with a page shared with it and its id given as `--parent`; `references/notion-setup.md` explains. Say: "This is a backup road; your agent might need to tinker a little."
2. The proposal. Write `proposal.json` in this folder from the same interview answers, in the shape of `references/setup-proposal.md` but with no `owner` and no `repo`. `name` and `timezone` are required.
   If the person has habits, ask once: "Would you like to score any of these from 1 to 10 instead of ticking it, like mood or energy?" Put `"score": { "min": 1, "max": 10 }` on each habit they name. Leave it off the others.
   Show it in plain words, as in Step 2, but end "what will be created" with: "a page called Howgozit in your Notion, four tables in it, a row for every project, stage and task, and a small settings file on this computer".
3. Look first. This sends nothing to Notion and writes nothing.

   ```
   node scripts/notion-setup.mjs plan proposal.json
   ```

   Read the list back in plain words: how many projects, stages and tasks, what is new, and where the settings file would go. Then ask for ONE yes, saying what it covers.
   A "looks good" is not a yes. Create nothing in Notion before it.
4. Do it, after the yes.

   ```
   node scripts/notion-setup.mjs apply proposal.json
   ```

   The settings file is written to `./config/board.config.json` in this folder. Add `--config-dir <folder>` to put it elsewhere.
   An internal connection adds `--parent <page id>`.
   Running it again with the same proposal creates nothing twice, so a stopped run is safe to repeat.
   If the person later asks you to remove it all, `references/notion-setup.md`, section "Removing it".
5. It ends by printing the lines to set. Give them to the person, one at a time, to run in their own terminal:
   - `BOARD_BACKEND=notion`
   - `BOARD_NOTION_TOKEN` (already set in step 1)
   - `BOARD_CONFIG_DIR` set to the folder the settings file is in.
   - `BOARD_FORM_KEY`, a key that signs the page's forms. Have them run `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"` and set the result without pasting it into the chat.
6. Start the board in the same terminal with `node board/server.mjs`. It listens on `http://localhost:8787` unless `BOARD_PORT` is set.
7. Check it. `http://localhost:8787/healthz` should answer `ok`. Then ask them to open `http://localhost:8787`: they should see a page headed with their name, every project of the proposal, the tasks under "What's next", their habits and their ideas box, as in Step 3, item 6.
   A project they add later in Notion shows with no settings edit. If the page is empty, see "What you should see" in `references/notion-setup.md`.

Adding a project later on Notion: the person adds a row to the Projects table in Notion and it shows on the next read, with no settings edit.

## Step 4: After

### Other ways to run it

Offer these. Do not set them up unasked.

- Behind the person's own login. If they already run a server with a login in front of it (a reverse proxy that checks who you are), the board runs there. Set `BOARD_MODE` to `proxy`, `BOARD_IDENTITY_HEADER` to the header name their login adds to every request it lets through, `BOARD_ALLOWED_HOSTS` to the public address of the board, and `BOARD_GITHUB_TOKEN` and `BOARD_REPO` as before. The board has no login of its own and will refuse to start without the header. Details in `references/deploy-proxy.md`.
- From the person's own phone and laptop, through Tailscale. The board stays on their computer; Tailscale Serve lets their own signed-in devices reach it from anywhere, and it is never on the public internet. The computer must stay on, and each device needs the Tailscale app. Steps in `references/deploy-tailscale.md`.
- On a hosting platform with its own login in front. It works the same way as the proxy: `BOARD_MODE` set to `hosted`, the platform's own header in `BOARD_IDENTITY_HEADER`, `BOARD_ALLOWED_HOSTS` for the address it gives, the platform's secret store for `BOARD_GITHUB_TOKEN`, and `BOARD_PORT` or `PORT` if the platform sets one. There is no step-by-step guide for one. The platform must limit who may sign in, because the board only checks that the login let someone through.

The last two need an account the person already has or is willing to make. A platform with no login of its own is not safe for this board. Say so.
Setting `BOARD_READ_ONLY` to `1` switches the four actions off, if the person wants a page that only shows.

### Agents (optional)

Five optional agents can write a morning brief, sort the inbox, read the calendar, run a weekly review and suggest where ideas belong. They need an agent that can run on a schedule with access to mail and calendar.
Describe this in one sentence. Ask whether they want to hear more. If yes, follow `references/agents.md`. If no, drop it.
Never switch one on unasked. Never store email bodies, only subjects and titles.

#### The Glitch mail feed (only when you are running inside Glitch)

A member running inside Glitch (detection in Step 1) has a second, simpler road for the inbox panel: a small job of Howgozit's own that reads their mail through Glitch's inbox rules. It is not one of the five agents. Details: `references/glitch-feed.md`.

Offer it once, during setup, in these words or close: "Glitch can put your mail on the board: who wrote and the subject, never the text. Want that?" Never switch it on unasked. If they say "feed my inbox" later, start the same walk here.

On a no, drop it. On a yes, one question at a time:

1. List their Glitch mail accounts with two commands, run in the Glitch folder. Keep Google rows whose `surfaces` include `gmail`. Keep Microsoft rows only when `enabled` is true.
   `uv run --directory <Glitch folder>/.claude/scripts python integrations/connections.py doctor`
   `uv run --directory <Glitch folder>/.claude/scripts python integrations/ms_connections.py doctor`
   Show the labels only. Never show or write an address (`login`).
2. "Which of these should go on the board?" One to ten. Use the labels exactly as Glitch shows them.
3. For each one: "Which colour for <label>?" From green, amber, orange, charcoal, blue, purple, red, grey.
4. "Each morning, or every hour during the day?" Each morning (06:00) is the default; every hour means 07:00 to 22:00, your computer's time.
5. Write two files in the board's config folder. That is the folder the settings file `board.config.json` sits in: `./config/` in this skill's folder, or the `--config-dir` folder if setup used one. Say which path you used.
   `feed.config.json` holds `mailboxes` (the chosen labels), `frequency` (`morning` or `hourly`) and `glitch` (the absolute path of the Glitch folder). It stays on this computer and is never put in the GitHub data repository.
   `board.config.json` gets a `mailboxes` block of label to colour, for example `"mailboxes": {"personal": "green"}`. Add it to the file setup already wrote and change nothing else in it. The colours show once the board is restarted.
   Also write `feed.env` in the same folder with the board's target, one `KEY=VALUE` per line: `BOARD_REPO=<owner/name>` for a GitHub board, or `BOARD_CONFIG_DIR=<config folder>` for a Notion board. The scheduled job reads only this file, not the terminal. For a GitHub board the member types the line `BOARD_GITHUB_TOKEN=...` into the file themselves, in their own editor or terminal; never ask for the token in the chat. On macOS and Linux have them run `chmod 600 <config folder>/feed.env`, or the run stops. On Windows, say the file sits in their own config folder under their user profile.
6. Run `node <skill folder>/scripts/feed.mjs check --config-dir <config folder>`. Say first that the very first read of a mailbox can take a few minutes, once, because Glitch looks back over a year of sent mail. Show the headline and any line about a mailbox that was skipped. Nothing is written by `check`.
7. Run `feed.mjs schedule plan` with the same flag and show what it would install. Ask for ONE yes to install it. Then `feed.mjs schedule apply`.
   On Linux, show the member the linger line the command prints and let them run it themselves; it needs sudo.
   On a Notion board, say the job must run on the same computer that runs the board.
8. Say plainly: each run uses Glitch's inbox rules, so Glitch may suggest new people from that mail, as it does in a session. They can stop it any time with `feed.mjs schedule remove`.

Only mail goes through this road. The calendar through Glitch comes later.

### The iCloud calendar (optional)

The board can read today's events from the person's own iCloud calendars, only the calendars they name. It needs no agent.
You may offer it. Never set it up unasked.
Never ask the person to paste a password or an app-specific password into the chat. They type it in their own terminal.
Follow `references/calendar-icloud.md`. It has been run against one real iCloud account on one day; say that it is new when you offer it.
The board can also read Google Calendars from their secret addresses, instead of iCloud, by following `references/calendar-google.md`.
That has been run against a stand-in only and not yet against a real Google account; say so when you offer it.
Never ask the person for the secret address in the chat; they set it in their own terminal, in the board's environment.

### Adding a project later

When the person says they have a new project, do the same steps in short.

1. Ask the same questions about that project only: its stages, a few first tasks, whether it joins the focus.
2. Write a small proposal for it, with the same `owner` and `repo` and only that project in it, to a new file such as `proposal-new.json`.
3. Show it in plain words and ask for the yes.
4. Run `plan`, then `apply`, with that file.

This adds the new project. It does not change or remove anything that is already there.

### Undo

If the person wants it all gone:

```
node scripts/undo.mjs
```

It lists everything it will remove, and waits for the word `undo` to be typed. Add `--yes` to skip the question.
It removes only what `setup-undo.json` lists: the labels, projects, stages, the settings file. It closes the cards it made, as "not planned"; GitHub does not allow deleting a card, so closed cards stay in the repository's history.
It does not remove the repository, the token, anything the person added later, or anything the record does not list.
If a project or stage now holds cards the person added, it stops and removes nothing at all, and says what else would go. Only if the person insists, run it with `--force`, and say what went.

### Fonts

The default look loads its fonts from Google on every page view. A person who does not want that switches it off in `theme.json` at the root of their repository:

```json
{ "fonts": { "source": "system" } }
```

The page then uses the fonts already on the person's device. The whole file is optional. Colours and other choices are listed in `references/contract.md` under "Theme".

## When something goes wrong

Say what happened in one plain sentence, say what you will do, then do it.

- The command says `BOARD_GITHUB_TOKEN` is not set. The variable is missing in the terminal that ran the command. Tell the person to set it again (see the ground rules) and run the command from the same terminal.
- GitHub did not accept the token, or a refusal mentions permission. The token is wrong, has expired, or is missing a permission. Send the person to `references/github-notes.md` to make a new one. Do not ask them to read it to you.
- Setup says the repository is not private. Stop. Tell them the board only works on a private repository, and ask them to make it private in the repository's settings on GitHub. Then run `check` again.
- GitHub could not find the repository. The name is mistyped, or the token cannot see that repository. Check the owner and name with the person. For a fine-grained token, the repository must be ticked when the token was made.
- GitHub refused to create a project or a date field. It happens on some accounts. Give the person the by-hand step the command printed, and run `apply` again afterwards. Nothing is lost.
- Right after setup, tasks show under "Standalone" instead of under their project. GitHub has not caught up yet. Nothing is wrong. They move to their project within a few minutes; ask the person to refresh.
- A run stopped half way. Run the same `apply` again. It skips what exists. If the person wants to start over, use undo, then apply again.
- The board will not start and prints a sentence about the identity header. It was started in `proxy` or `hosted` mode without `BOARD_IDENTITY_HEADER`. For a person on their own computer, unset `BOARD_MODE` so it runs in `local` mode.
- The page opens but shows nothing, or an old version. The board reads GitHub on every page load and keeps the last good read if GitHub is down. Ask them to refresh. If it is still empty, in a terminal where `BOARD_GITHUB_TOKEN` is set, run `BOARD_REPO=sam-life/life node scripts/read-once.mjs` (on Windows PowerShell set `$env:BOARD_REPO` first) and read the counts to them.
- Port already in use. Set `BOARD_PORT` to another number, such as `8788`, and give them the new address.
