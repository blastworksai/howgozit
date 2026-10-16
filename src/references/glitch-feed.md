# The Glitch mail feed

A small job of Howgozit's own reads your mail through Glitch and fills the board's inbox panel.
It is only for members who run Glitch. It is mail only; the calendar through Glitch comes later.
Setup offers it once. Saying "feed my inbox" brings the same walk back.

## What lands on the board

For each thread: the sender's name, the subject, a group (`reply` or `fyi`), a short reason, and the label of the mailbox it came from, with the colour you picked for that mailbox.
The reason is one of a few fixed lines, such as "You marked this sender important".
Everything is cut to 200 characters. The board shows at most 30 threads, newest first.
Mail Glitch marks as automated goes to FYI. All other mail goes to reply. Nothing goes to decide.

## What never lands

- No email address, not even one inside a sender name or a subject. Those parts are removed.
- No body, no snippet, no attachment.
- No link. A web address in a name or subject is removed.
- No message from Glitch about your accounts. Only fixed plain lines are printed or written.

## Where the file goes

The job writes `state/inbox.json`, and one short line in `state/log.json` ("Updated inbox (n threads)", never a name or subject).

- A GitHub board: into your data repository, as one commit with the fixed message `Glitch feed: inbox`. This needs `BOARD_REPO` and `BOARD_GITHUB_TOKEN`, the same two values the board uses.
- A board started with `BOARD_CONFIG_DIR` (every Notion board): into `<config folder>/state/`. No network call is made. If both are set, the folder wins.

Your feed settings (`feed.config.json`: mailboxes, how often, the Glitch folder) stay on this computer. They are never put in the data repository.

### The file `feed.env`

A scheduled job does not inherit your terminal's settings, so the feed reads its target from a file named `feed.env`, beside `feed.config.json`.
Each line is `KEY=VALUE`. Only three keys are read: `BOARD_REPO`, `BOARD_GITHUB_TOKEN` and `BOARD_CONFIG_DIR`. Anything else is ignored.
A GitHub board needs `BOARD_REPO` and `BOARD_GITHUB_TOKEN`; a board started with `BOARD_CONFIG_DIR` needs only that line.
If the same key is set in the process environment, the process environment wins.
You type the token into this file yourself, in your own editor or terminal. Never paste it into a chat.
On macOS and Linux the file must be readable by you alone (`chmod 600 feed.env`), or the run stops.
On Windows the file sits in your own config folder under your user profile.

## The people-records side effect

Each run uses Glitch's inbox rules (`triage`). That is the same step Glitch takes in a session.
So Glitch may log contact with people it knows and may suggest new people from that mail.
Suggestions wait in your queue; nothing is created without your yes.
The first read of a mailbox also does a one-time look back over a year of sent mail, so it can take a few minutes.

## When a mailbox is skipped

Before it reads anything, the feed asks Glitch whether each mailbox is healthy. An unhealthy one is skipped, never read, and named with one plain reason:

1. "needs you to sign in again in Glitch": sign in to that account in Glitch, then run again.
2. "not connected in Glitch".
3. "not a mailbox Glitch knows": the label in `feed.config.json` matches no Glitch account.
4. "took too long".
5. "answer not understood".

The feed never opens a browser. If every mailbox is skipped, nothing is written.

## Time limits

60 seconds for each mailbox and 300 seconds for a whole run. `check`, run by hand in setup, allows 240 seconds for each mailbox, for the first-read look back. A call over its limit is stopped and named "took too long".

## How to see the last run

- `node <skill folder>/scripts/feed.mjs check --config-dir <config folder>` reads the mailboxes now and prints the headline and any skipped mailbox. It writes nothing.
- `node <skill folder>/scripts/feed.mjs schedule status --config-dir <config folder>` says whether the job is installed.
- The board's log panel shows the line "Glitch: Updated inbox (n threads)" with the time of each run that changed the inbox.

## How to stop it

`node <skill folder>/scripts/feed.mjs schedule remove --config-dir <config folder>` removes the job and leaves nothing behind. Glitch's own jobs are never touched.
To drop the colours too, delete the `mailboxes` block from `board.config.json`.

## The job itself

One job, named `howgozit-feed`: a Task Scheduler task `\Howgozit\Feed` on Windows, a LaunchAgent `ai.blastworks.howgozit.feed` on macOS, a systemd user timer `howgozit-feed.timer` on Linux (a crontab line tagged `# howgozit-feed` where no user service manager answers).
Each morning means 06:00. Every hour means 07:00 to 22:00. Both are your computer's own time.
On Linux the job stops when you log out unless you run `loginctl enable-linger <you>` once with sudo. `schedule plan` prints that line; run it yourself.
On a Notion board the job must run on the computer that runs the board.

## What has been run on a real machine

So far only tests with stand-ins: no real Glitch, no real mailbox, no real scheduler.
Linux, macOS and Windows real-machine runs have not been done yet.
