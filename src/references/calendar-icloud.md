# Showing your iCloud calendar on the board

This guide and the feature it describes were written from the calendar standards and tested against a made-up iCloud.
Against a real iCloud account it has been run on one day, with one calendar: the check script signed in, listed the calendars and counted the day's events, and the card was compared with that calendar and found right.
That is a small sample; the last section says what has not been seen.
Where a step rests on what Apple does rather than on what the board does, the guide says so.

## What it does and what it does not

The board can read today's events from your own iCloud calendars, by itself.
No agent and no shared calendar link is needed.

- It shows today only, from midnight to midnight in the board's time zone.
- It shows timed events in the day's hours, and all-day events in one line above them.
- It reads only the calendars you name in your settings. Nothing shows until you name some.
- It only reads. The board never creates, changes or deletes anything in your calendar.
- Event titles go to the page and to the board's own saved copy of its last read, on the computer where the board runs.
- Event titles are never written to GitHub.
- Your Apple sign-in is never written to a page, a log or a file, and goes only to Apple.

## What you need

- An Apple Account with two-factor sign-in switched on.
- An app-specific password made for the board.
- Never use the password of the Apple Account itself.
- Apple's own help page "Sign in to apps with your Apple Account using app-specific passwords" describes how to make one and how to remove one.
- Follow that page, because Apple may change the steps.
- Give the password a name that tells you it is for the board, so you can find it later.

## The two values

The board takes your sign-in from two values in its environment.

| Name | What it holds |
| --- | --- |
| `BOARD_ICLOUD_USER` | The sign-in of your Apple Account, an email address. |
| `BOARD_ICLOUD_APP_PASSWORD` | The app-specific password you made for the board. |

Set both, or set neither.
If only one is set, the board refuses to start and says so in one sentence.
Without the `calendar` block in your settings, the board sends nothing to Apple, even when both values are set.
Never write either value into a file inside a repository, and never paste them into a chat.

Type them unseen in your own terminal (the PowerShell lines below also read them unseen), then start the board in the same terminal.
macOS or Linux:

```
read -s BOARD_ICLOUD_USER; export BOARD_ICLOUD_USER
read -s BOARD_ICLOUD_APP_PASSWORD; export BOARD_ICLOUD_APP_PASSWORD
```

Windows PowerShell:

```
$s = Read-Host "Apple Account sign-in" -AsSecureString
$env:BOARD_ICLOUD_USER = [System.Net.NetworkCredential]::new('', $s).Password
$s = Read-Host "App-specific password" -AsSecureString
$env:BOARD_ICLOUD_APP_PASSWORD = [System.Net.NetworkCredential]::new('', $s).Password
```

### Keeping them for next time

This works like the GitHub token in `references/deploy-local.md`, section "Keeping the token for next time".
The same warnings apply: type these only in your own terminal, and read that section first.
Only the service names differ.
These are from documentation, not run.

macOS Keychain:

```
security add-generic-password -a "$USER" -s board-icloud-user -w
security add-generic-password -a "$USER" -s board-icloud-app-password -w
security find-generic-password -a "$USER" -s board-icloud-user -w
security find-generic-password -a "$USER" -s board-icloud-app-password -w
```

Linux with `secret-tool`:

```
secret-tool store --label="Board iCloud user" service board-icloud-user
secret-tool store --label="Board iCloud app password" service board-icloud-app-password
secret-tool lookup service board-icloud-user
secret-tool lookup service board-icloud-app-password
```

Linux without it, two files only you can read, outside any repository:

```
mkdir -p ~/.config/board
read -s T; printf '%s' "$T" > ~/.config/board/icloud-user; unset T
read -s T; printf '%s' "$T" > ~/.config/board/icloud-app-password; unset T
chmod 600 ~/.config/board/icloud-user ~/.config/board/icloud-app-password
```

Windows keeps both in one file that works only for your user on this machine.
Type your Apple Account sign-in as the user name and the app-specific password as the password:

```
New-Item -ItemType Directory -Force "$env:USERPROFILE\.board" | Out-Null
Get-Credential | Export-Clixml "$env:USERPROFILE\.board\icloud.xml"
(Import-Clixml "$env:USERPROFILE\.board\icloud.xml").UserName
(Import-Clixml "$env:USERPROFILE\.board\icloud.xml").GetNetworkCredential().Password
```

Then add the matching lines to the start script you already use, next to the token line.
For macOS, `export BOARD_ICLOUD_USER="$(security find-generic-password -a "$USER" -s board-icloud-user -w)"` and the same for the password with its own service name.
For Linux files, `export BOARD_ICLOUD_USER="$(cat ~/.config/board/icloud-user)"` and the same for the password file.
For Windows, set the two variables from the lines that read `icloud.xml` back.

## Finding the exact calendar names

The board matches calendars by name, so you need the names as iCloud has them.
In a terminal that has the two values set, in the folder that holds `board/server.mjs`, run:

```
node scripts/calendar-check.mjs
```

It needs no GitHub token.
It prints `Calendars found in iCloud:` and then the name of each calendar.
It never prints an event title, your sign-in or your password.

To see what the board would find today in the calendars you plan to use, name them:

```
node scripts/calendar-check.mjs --calendar "Home" --calendar "Work"
```

For each one it prints a line such as `Home: 2 timed, 1 all-day today`, or `Home: not found`.
It then prints any notes the page would show, in the page's own words.
You can add `--timezone <zone>`, for example `--timezone Europe/Brussels`. Without it, the script uses this computer's time zone.
If it cannot sign in or reach Apple, it prints one sentence about that and stops.

## The `calendar` block in `board.config.json`

Add this block to `board.config.json` in your data repository.
The block holds names only. It never holds a password.

```json
"calendar": {
  "source": "icloud",
  "calendars": [
    { "name": "Home", "kind": "personal" },
    { "name": "Work" }
  ]
}
```

- `source` must be `icloud` for this guide. One board reads iCloud or Google, not both; for Google see `references/calendar-google.md`.
- `calendars` lists the calendars to read, by `name`.
- A name matches a calendar when the two are the same after trimming spaces and ignoring capital letters. `home`, ` Home ` and `HOME` all match `Home`.
- You can name at most 20 calendars. Any beyond the twentieth are dropped.
- `kind` is optional. It is one of four: `meeting`, `focus`, `personal` or `habit`.
- A calendar with no `kind` counts as `meeting`. So does a `kind` that is none of the four.
- Every event takes the kind of its calendar.
- A name that is empty, or already listed, is dropped.
- A name that matches nothing in iCloud is skipped, and the page says so. The other calendars are still read.
- Task lists and reminder lists are not calendars. They are never matched.
- `includeFile` is optional, `true` or `false`, and `false` when left out. See "If you also run a calendar agent".
- A block that is broken as a whole is ignored, and the page notes a setting that could not be used.

## What is shown and what is left out

Shown:

- Timed events that fall today (at most thirty), as `HH:MM` in the board's time zone, whatever time zone Apple holds them in.
- An event that crosses midnight, as the part inside today. It starts at `00:00` if it began earlier and ends at `24:00` if it runs on.
- Events in order of start, then end, then title.
- A title with its formatting codes and odd characters cleaned, cut at 200 characters. An empty title reads `(no title)`.

Also shown: today's all-day events, as one line at the top of the card ("All day: …"), at most ten.

Left out:

- Cancelled events.
- Invitations that the signed-in address declined.
- A repeat the board cannot work out. See below.
- Any event the board cannot read at all. The page counts these in a note.

### Repeating events

The board works out daily, weekly, monthly and yearly repeats itself, including "every second week", "the second Tuesday" and "the last Friday", end dates and a set number of times.
A single occurrence that was removed or cancelled does not show.
An occurrence that was moved shows at its new time.
A repeat the board cannot work out shows nothing, and the page counts it as an event that could not be read.
These are repeats by the hour, by position within a set, by week of the year or day of the year, and series changed "from this one on".

## How often it asks Apple, and when Apple does not answer

- The board asks Apple at most once every five minutes. In between it reuses the last answer.
- One whole read gives up after eight seconds, so a slow Apple never holds the page up for long.
- After a failed read, the board leaves Apple alone for one minute and then tries again.
- A failure of the calendar never makes the rest of the board stale, and never replaces the board with an error page.

When Apple does not answer, you see one of two things:

- If the board read your calendar earlier the same day, it shows those events marked out of date.
- If it has nothing kept for today, the calendar card is still shown, with the sentence "The calendar could not be read from iCloud. See the note at the foot of the page."
  The note at the foot of the page says why.

The page may also show these notes at the foot, in exactly these words.
Where a note counts something, it says `1 calendar` for one and `<n> calendars` for more.

1. "The settings name iCloud calendars, but this board was started without an iCloud sign-in, so the calendar is not shown."
   Set both `BOARD_ICLOUD_USER` and `BOARD_ICLOUD_APP_PASSWORD` where the board starts, then restart it.
2. "iCloud did not accept the sign-in, so the calendar could not be read. The app-specific password may have been removed."
   Check the Apple Account sign-in. If the password was removed, or mistyped, make a new app-specific password and set the two values again.
3. "iCloud did not answer, so the calendar may be out of date."
   Usually nothing. The board tries again within minutes. If it stays for long, check your internet connection and Apple's own system status page.
4. "1 calendar named in the settings was not found in iCloud." (more than one: "<n> calendars named in the settings were not found in iCloud.")
   Run `node scripts/calendar-check.mjs` and correct the spelling of the name in `board.config.json`.
5. "1 calendar event could not be read and is not shown." (more than one: "<n> calendar events could not be read and are not shown.")
   Usually a repeat the board cannot work out, or an event with no start. Nothing to fix on the board. Open the event in your calendar if it matters.
6. "1 calendar event names a time zone this board does not know, so its time may be off." (more than one: "<n> calendar events name a time zone this board does not know, so their times may be off.")
   The event is shown at the time written, read in the board's time zone. Check its time in your calendar.
7. "The calendar file from the agent could not be read, so its events are not shown." Only with `includeFile` on.
   Check that `state/calendar.json` is valid JSON of the shape in `references/agents.md`.

## Removing it

1. Delete the `calendar` block from `board.config.json`. The board then sends nothing to Apple. The card follows `state/calendar.json` again, if an agent writes one.
2. Unset `BOARD_ICLOUD_USER` and `BOARD_ICLOUD_APP_PASSWORD`, and delete any stored copy (a Keychain entry, a `secret-tool` entry, a file, or `icloud.xml`) and the lines in your start script.
3. Remove the app-specific password at Apple, following Apple's help page named above.
4. The board's saved copy of its last read may still hold today's event titles. Deleting the `.board-data` folder is safe, and the next read fills it again.

## If you also run a calendar agent

With the `calendar` block present, the board reads iCloud and `state/calendar.json` is not used, unless you add `"includeFile": true` to the block.
With it, the card shows both sets of events together in time order, each followed by a word saying where it came from: `iCloud`, or the file's own `source` label (up to 20 characters), or `File` when the file has none.
An event in both is shown twice.
If one source cannot be read, the other is still shown and the foot of the page says which one failed.
A file from an earlier day is still shown, with a line saying the date of its events.
Without `includeFile`, your calendar agent can stay, but its file does nothing until you remove the block.
Without the block, the agent's file drives the card as before.
The agent is described in `references/agents.md`.

## What has not been proven

The calendar standards and a made-up iCloud were the main material.
Seen against one real account, on one day, with one calendar: the sign-in, the search for the calendars, and that day's events shown on the card with the right titles and times.
Not yet seen: how Apple answers a wrong sign-in, an all-day event from a real account, an event in an unusual time zone, and kinds of repeating events that day did not hold.
If you try it, please run `node scripts/calendar-check.mjs` first.
