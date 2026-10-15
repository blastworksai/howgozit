# Howgozit

Howgozit is a personal dashboard for your life.
It shows your projects, tasks, ideas and habits on one page, so you can see what to do next without keeping a separate system.
It is for people who are juggling a lot and have an AI agent tool at hand to do the setup for them.
You do not need to be a developer.
The name comes from flying: a howgozit chart is a running graph of how a flight is going against its plan.
In the rest of this file it is simply called the board.

## What you see on the page

- A greeting with the date, and a small chip for each source showing when it last updated.
- A box to log an idea. It becomes a GitHub issue.
- A morning brief, when an agent has written one.
- Focus: the projects you have chosen to concentrate on.
- A timeline of milestones for each project, with a mark for today.
- Today: your calendar events, when an agent supplies them or when the board reads your iCloud or Google calendars itself.
- Inbox: messages sorted into reply, decide and for your information, when an agent supplies them.
- What's next: the next tasks to do, with due dates and a tick box.
- Habits, each with a streak, cheat tokens and a button to mark today done.
- Last 12 weeks: a map of how many issues you closed each day.
- Projects, with progress and the next milestone.
- Ideas waiting to be sorted into a project.
- Standalone tasks that belong to no project.

The page works on a phone as well as a desktop screen.

## How it works

- On the GitHub road, GitHub holds everything: your projects, milestones, tasks, ideas and habit check-ins, all in one private repository.
- A small server, with no add-ons to install, reads that repository and draws the page.
- On the Notion road, four tables in your own Notion workspace hold the same things, and your settings stay in a folder on your computer.
- The server only reads. When you use the page it makes four small writes: log an idea, tick a habit, sort an idea and close a task.
- Optional agents can write extra files into the repository. They feed the brief, calendar, inbox and agent log panels.
- Without an agent, those panels do not appear. Everything else still works.

## What you need

- Node 22 or newer.
- Either a GitHub account and a GitHub token (first list below), or a Notion account and a Notion token (second list).

For GitHub:

- A GitHub account.
- A GitHub token.
  On an organisation, use a fine-grained token with Issues (read and write) and Contents (read and write) on the repository, plus Projects (read and write) on the organisation.
  On a personal account, use a classic token with `repo` and `project`.
  The running board reads, and writes only when you use one of the four actions: it creates, closes and relabels issues and adds an issue to a Project. That needs Issues and Projects write.
  Contents write is used only by setup and undo.
  With `BOARD_READ_ONLY=1` the board writes nothing.

For Notion:

- A Notion account, and a personal access token (or an internal connection's token) that can create pages and databases.
- No GitHub repository and no GitHub token. A Notion board ignores `BOARD_REPO` and the GitHub tokens.
- How to make the token, run setup and start the board is in `references/notion-setup.md`.

## Getting it

The easy way is to let an agent do it.
Tell your agent to read `SKILL.md` and follow it.
It interviews you, writes a proposal of projects and milestones, asks for your approval once, and then sets everything up, on GitHub or on Notion.

If you would rather do it by hand, fill in a proposal as described in `references/setup-proposal.md`, then run these three commands:

```
node scripts/setup.mjs check --repo owner/name
node scripts/setup.mjs plan <file>
node scripts/setup.mjs apply <file>
```

`check` looks at the repository, `plan` shows what would be created, and `apply` creates it.
Then start the board:

```
node board/server.mjs
```

On Notion, follow `references/notion-setup.md` instead.
In short: make a token, write the same kind of proposal (without `owner` and `repo`), then run these from this folder with `BOARD_NOTION_TOKEN` set:

```
node scripts/notion-setup.mjs plan <file>
node scripts/notion-setup.mjs apply <file>
```

`plan` shows what would be created and writes nothing.
`apply` creates the Notion tables and rows and a starter `board.config.json` (in `./config` unless you give `--config-dir`), then prints the environment lines to set.
Start the board with `BOARD_BACKEND=notion`, `BOARD_NOTION_TOKEN`, `BOARD_CONFIG_DIR` and `BOARD_FORM_KEY` set, and `node board/server.mjs`.

For GitHub, the board reads its settings from environment variables: `BOARD_GITHUB_TOKEN` (the token), `BOARD_REPO` (the data repository as `owner/name`), `BOARD_MODE`, and a few more listed in `references/contract.md`.

## Three ways to run it

- On your own computer (`BOARD_MODE=local`, the default). The board answers only on `127.0.0.1`, so only your own machine can reach it.
- Behind your own login proxy (`BOARD_MODE=proxy`). You must set `BOARD_IDENTITY_HEADER` to the header your proxy adds to every request it lets through.
- On a hosting platform (`BOARD_MODE=hosted`). It behaves the same as `proxy`, and has the same rule.

The board has no login of its own.
Outside `local` mode it refuses to start unless `BOARD_IDENTITY_HEADER` is set, and it answers 401 to any request without that header.
It also answers only to the host names you allow.
More in `references/deploy-local.md` (your own computer) and `references/deploy-proxy.md` (behind your own login proxy).
To open it from your own phone and laptop without putting it on the internet, see `references/deploy-tailscale.md`.
There is no step-by-step guide for a hosting platform.

## Privacy and safety

- The data repository is private. Setup refuses a public one.
- The token stays with the server. It appears in no page, log or file.
- The page links only to GitHub.
- By default the page loads its fonts from Google's font service, which tells Google the page was opened. To switch that off, set `fonts.source` to `system` in `theme.json`. The page then makes no outside request at all.
- There is no analytics and no tracking. Nothing else leaves your computer.
- The board never writes a file to your repository. Only setup, undo and your agents do.

## Undo

```
node scripts/undo.mjs
```

This removes what setup created and nothing else.
Issues are closed rather than deleted.

## Where to read more

- `SKILL.md`: the instructions an agent follows to set the board up.
- `references/contract.md`: every rule the board follows, each with the check that proves it.
- `references/agents.md`: how an agent feeds the brief, calendar, inbox and log panels.
- `references/calendar-icloud.md`: how to show today's events from your own iCloud calendars.
- `references/calendar-google.md`: how to show today's events from your own Google calendars.
- `references/github-notes.md`: notes on how the board uses GitHub.
- `references/notion-setup.md`: keeping your board in Notion instead of GitHub.

## Status

The Notion road was proven live on 15 Oct 2026: a real board was copied into a real Notion workspace, and a Notion board read it and ran the five actions (log an idea, file it, tick a habit, score, close a card).
The Notion setup script's `plan` and `apply` road was proven live on 15 Oct 2026 with a personal access token.
The test suite passes on Linux (Node 22), macOS (Node 26) and Windows (Node 26).
The board itself was started and used on Linux only; the local guide was followed there step by step in bash.
The macOS and Windows commands, the token stores and the start-at-login steps are written from documentation and were not run.
The Tailscale guide is written from Tailscale's documentation and was not followed on a real tailnet.
The container image in `deploy/` was built and started once on Linux; it has not been run behind a real login proxy.
The iCloud calendar was tested against a made-up iCloud and run against one real account on one day, where the card matched the real calendar; see `references/calendar-icloud.md` for what has not been seen.
The Google calendar has been run against a stand-in only and not yet against a real Google account; see `references/calendar-google.md`.

## Licence

MIT. See `LICENSE`.
