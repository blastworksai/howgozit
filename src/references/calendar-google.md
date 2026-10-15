# Showing your Google calendar on the board

This guide and the feature it describes were written from the calendar standards and from Google's help pages.
They have been tested against a stand-in server only.
They have not yet been run against a real Google account.
Where a step rests on what Google does rather than on what the board does, the guide says so.

## What it does and what it does not

The board can read today's events from your own Google calendars, by itself.
No agent is needed.
For each calendar it uses the "secret address in iCal format" that Google Calendar gives you.

- It shows today only, from midnight to midnight in the board's time zone.
- It shows timed events in the day's hours, and all-day events in one line above them.
- It reads only the calendars you list in your settings. Nothing shows until you list some.
- It only reads. The board never creates, changes or deletes anything in your calendar.
- Event titles go to the page and to the board's own saved copy of its last read, on the computer where the board runs.
- Event titles are never written to GitHub.
- A secret address is never written to a page, a log or a file, and goes only to Google.
- The board reads either iCloud or Google, not both at once. Both at once is not there yet.
- An invitation you declined is still shown, because the board does not know which address is yours.

## The secret address is a secret

Anyone who holds the secret address of a calendar can read every detail of that calendar, with no sign-in.
That means titles, times, places, descriptions and, probably, the guests.
The address only reads. It cannot change your calendar and it does not open your mail or your other calendars.
Treat it like a password: never paste it into a chat, never write it into a file inside a repository.
If it leaks, reset it (see "Resetting an address").

## Finding the address

Do this on a computer, in Google Calendar in a browser.
These are the steps as Google describes them.
The words on Google's screens may differ from these, and Google may change them.

1. Open Google Calendar and click the gear at the top right, then Settings.
2. In the left panel, under "Settings for my calendars", click the name of the calendar.
3. Open "Integrate calendar".
4. Find "Secret address in iCal format" and copy the long address.
5. Do the same for each calendar you want, one address each. The board reads at most five.

If you use a Google Account from work or school, your administrator may have turned the address off.
Google says to ask your administrator when you cannot find it.
Then this road is closed for that calendar.
It is not known whether the phone apps can show the address; the steps above are written for a computer.

An address looks like this invented one:

```
https://calendar.google.com/calendar/ical/example%40example.invalid/private-0123456789abcdef/basic.ics
```

The board accepts only an address that starts `https://calendar.google.com/calendar/ical/` and ends `.ics`.
Anything else is refused and the page says so.

## Resetting an address

On the same "Integrate calendar" page there is a button to reset the secret address.
Resetting makes the old address stop working and gives you a new one.
Do this if the address was seen by someone it should not have been, or if you are not sure.
After a reset, copy the new address and set it again where the board starts (see below).

## The values

The board takes each address from its own value in its environment.
The first calendar in your settings uses `BOARD_GOOGLE_ICAL_1`, the second `BOARD_GOOGLE_ICAL_2`, and so on up to `BOARD_GOOGLE_ICAL_5`.
The number is the place of the calendar in the list in your settings, counting every entry you wrote, even one the board drops.

| Name | What it holds |
| --- | --- |
| `BOARD_GOOGLE_ICAL_1` | The secret address of the first calendar listed in your settings. |
| `BOARD_GOOGLE_ICAL_2` | The same for the second, and so on up to the fifth. |

Set only as many as you list.
Without the `calendar` block in your settings, or with `source` set to `icloud`, the board sends nothing to Google, even when these values are set.
Never write a value into a file inside a repository, and never paste it into a chat.

Type them unseen in your own terminal (the PowerShell lines below also read them unseen), then start the board in the same terminal.
The address is not shown on the screen while you paste it.
macOS or Linux:

```
read -s BOARD_GOOGLE_ICAL_1; export BOARD_GOOGLE_ICAL_1
read -s BOARD_GOOGLE_ICAL_2; export BOARD_GOOGLE_ICAL_2
```

Windows PowerShell:

```
$s = Read-Host "Secret address, first calendar" -AsSecureString
$env:BOARD_GOOGLE_ICAL_1 = [System.Net.NetworkCredential]::new('', $s).Password
$s = Read-Host "Secret address, second calendar" -AsSecureString
$env:BOARD_GOOGLE_ICAL_2 = [System.Net.NetworkCredential]::new('', $s).Password
```

Do not put an address in a command line, because other programs on the computer can list command lines.

### Keeping them for next time

This works like the GitHub token in `references/deploy-local.md`, section "Keeping the token for next time".
The same warnings apply: type these only in your own terminal, and read that section first.
Only the service names differ.
These are from documentation, not run.
The lines below are for the first calendar; repeat them for the others with `-2`, `-3` and so on.

macOS Keychain:

```
security add-generic-password -a "$USER" -s board-google-ical-1 -w
security find-generic-password -a "$USER" -s board-google-ical-1 -w
```

Linux with `secret-tool`:

```
secret-tool store --label="Board Google address 1" service board-google-ical-1
secret-tool lookup service board-google-ical-1
```

Linux without it, a file only you can read, outside any repository:

```
mkdir -p ~/.config/board
read -s T; printf '%s' "$T" > ~/.config/board/google-ical-1; unset T
chmod 600 ~/.config/board/google-ical-1
```

Windows keeps it in a file that works only for your user on this machine.
Type any name as the user name and the secret address as the password:

```
New-Item -ItemType Directory -Force "$env:USERPROFILE\.board" | Out-Null
Get-Credential | Export-Clixml "$env:USERPROFILE\.board\google-ical-1.xml"
(Import-Clixml "$env:USERPROFILE\.board\google-ical-1.xml").GetNetworkCredential().Password
```

Then add the matching line to the start script you already use, next to the token line.
For macOS, `export BOARD_GOOGLE_ICAL_1="$(security find-generic-password -a "$USER" -s board-google-ical-1 -w)"`.
For Linux files, `export BOARD_GOOGLE_ICAL_1="$(cat ~/.config/board/google-ical-1)"`.
For Windows, set the variable from the line that reads `google-ical-1.xml` back.

### Behind a login proxy, in a container, or on a tailnet

The values work the same way as on your own computer.
In a container, put them in the same file as the GitHub token, outside the repository, and never write them in the compose file.
See `references/deploy-proxy.md` and `references/deploy-tailscale.md` for where that file is.
After you change a value, restart the board.

## The `calendar` block in `board.config.json`

Add this block to `board.config.json` in your data repository.
The block holds names only. It never holds an address.

```json
"calendar": {
  "source": "google",
  "calendars": [
    { "name": "Home", "kind": "personal" },
    { "name": "Work" }
  ]
}
```

- `source` must be `google`. One board reads iCloud or Google, not both.
- `calendars` lists the calendars to read, by `name`.
- The `name` is only a label that you choose. It is not looked up in Google. The page uses it to tell you which calendar has a problem.
- The first entry reads `BOARD_GOOGLE_ICAL_1`, the second `BOARD_GOOGLE_ICAL_2`, and so on.
- You can list at most five calendars. Any beyond the fifth are dropped.
- Do not use an address, or any text with `://`, as a name. Such a name is dropped.
- If any text in the file contains a Google Calendar secret address, the board will not show at all and its page says the file holds one. Remove it, and reset the address, because it was written where it should not be.
- `kind` is optional. It is one of four: `meeting`, `focus`, `personal` or `habit`.
- A calendar with no `kind` counts as `meeting`. So does a `kind` that is none of the four.
- Every event takes the kind of its calendar.
- A name that is empty, or already listed, is dropped.
- `includeFile` is optional, `true` or `false`, and `false` when left out. See "If you also run a calendar agent".
- A block that is broken as a whole is ignored, and the page notes a setting that could not be used.

## What is shown and what is left out

The card works as it does for iCloud, and `references/calendar-icloud.md` describes it: the timed events, the all-day line, the order, the cleaned titles, and the repeating events the board works out itself.
Two things differ.
The board does not know which address is yours, so it cannot leave out an invitation you declined; it shows it.
The board reads the whole calendar from Google and keeps only today, so a very large calendar can be too large (see "Limits").

## How often it asks Google, and when Google does not answer

- The board asks Google at most once every five minutes, for all your calendars together. In between it reuses the last answer.
- It asks for all calendars at the same time. One calendar gives up after eight seconds, and the whole read after twelve.
- After a failed read, the board leaves Google alone for one minute and then tries again.
- A failure of the calendar never makes the rest of the board stale, and never replaces the board with an error page.

When a calendar cannot be read, you see one of two things:

- If the board read that calendar earlier the same day, it shows those events marked out of date.
- If it has nothing kept for today, the calendar card is still shown, with the sentence "The calendar could not be read from Google. See the note at the foot of the page." when no calendar could be read at all.

## Limits

- At most five calendars.
- At most 10,000,000 bytes from Google for one calendar.
- At most 20,000 events in one calendar's feed.
- A calendar over either limit is not shown, and the others still are.
- At most thirty timed events and ten all-day events are shown, as for iCloud.

## The notes at the foot of the page

The page may show these notes, in exactly these words.
Each lists the names of the calendars it concerns, in double quotes.

1. "No secret address was set for these Google calendars, so they are not shown: <names>. Copy the address from Google Calendar and set it where the board starts."
   Set `BOARD_GOOGLE_ICAL_<n>` for each name, where n is its place in your settings, then restart the board.
2. "The secret address set for these Google calendars is not one the board will use, so they are not shown: <names>. Copy the address from Google Calendar again."
   The value is not an address of the shape above. Copy it again and set it again, with nothing before or after it.
3. "Google did not accept the secret address for these calendars, so they could not be read: <names>. The address may have been reset. Copy it from Google Calendar again."
   Copy the address from Google Calendar again, set it, and restart the board.
4. "Google did not answer for these calendars, so they may be out of date: <names>."
   Usually nothing. The board tries again within minutes. If it stays for long, check your internet connection.
5. "Google sent something that is not a calendar for these calendars, so they could not be read: <names>. Copy the secret address from Google Calendar again."
   The address may be wrong or reset, or the calendar may not be shared in this way. Copy it again.
6. "These Google calendars are too large for the board to read, so they are not shown: <names>."
   The calendar holds more than the limits above. Use a smaller calendar for what you want on the board.

The page may also show, as for iCloud, a note that events could not be read or that a time zone is not known; `references/calendar-icloud.md` words them.
With `includeFile` on, it may show "The calendar file from the agent could not be read, so its events are not shown."

## Removing it

1. Delete the `calendar` block from `board.config.json`. The board then sends nothing to Google. The card follows `state/calendar.json` again, if an agent writes one.
2. Unset `BOARD_GOOGLE_ICAL_1` and the others, and delete any stored copy (a Keychain entry, a `secret-tool` entry, a file, or an `.xml` file) and the lines in your start script.
3. Reset the secret address in Google Calendar, so that any copy that is left stops working.
4. The board's saved copy of its last read may still hold today's event titles. Deleting the `.board-data` folder is safe, and the next read fills it again.

## If you also run a calendar agent

With the `calendar` block present, the board reads Google and `state/calendar.json` is not used, unless you add `"includeFile": true` to the block.
With it, the card shows both sets of events together in time order, each followed by a word saying where it came from: `Google`, or the file's own `source` label (up to 20 characters), or `File` when the file has none.
Everything else works as `references/calendar-icloud.md` describes for iCloud.
The agent is described in `references/agents.md`.

## What has not been proven

The calendar standards, Google's help pages and a stand-in Google server were the material.
Nothing has been run against a real Google account.
Not yet seen: the real shape of the address, how soon Google shows a change, how large a real calendar's feed is, what Google answers after a reset, whether a declined invitation is in the feed, and whether a work account offers the address at all.
If you try it, please say what you saw.
