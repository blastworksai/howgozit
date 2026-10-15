# Running the board on your own computer

Run on Linux (bash, Node 22, a container with no network): start and stop, the page and `/healthz`, every setting in the table, the saved copy, the token file and the start script.
The unit file passed `systemd-analyze --user verify`. It was not started, and no real start at login was done.
Not run: anything against the real GitHub (the counts from `read-once`, a page with real data), `secret-tool`, zsh.
Every macOS and Windows step is written from documentation and was not run.

## What "local" means

The board runs on this computer and answers only to this computer (`127.0.0.1`).
It needs no login, and nobody else on the network can open it.
This is the default mode.

## Start and stop

It needs two values: `BOARD_GITHUB_TOKEN` (the GitHub token) and `BOARD_REPO` (your data repository, `owner/name`).
Open a terminal in the folder that holds `board/server.mjs`.
Never write the token into a file inside the repository, and never paste it into a chat.

macOS or Linux, in bash or zsh. Paste the token and press Enter; nothing is shown.
In plain `sh` the first line fails with `Illegal option -s`, so type `bash` first.

```
read -s BOARD_GITHUB_TOKEN; export BOARD_GITHUB_TOKEN
BOARD_REPO=sam-life/life node board/server.mjs
```

Windows PowerShell:

```
$s = Read-Host "Paste your token" -AsSecureString
$env:BOARD_GITHUB_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
$env:BOARD_REPO = "sam-life/life"
node board/server.mjs
```

Open `http://localhost:8787`.
Press Ctrl+C to stop.
Without a token the board prints `Set BOARD_GITHUB_TOKEN to a GitHub token that can read your data repository.` and stops.

## Every setting

| Name | What it does | Default | Local use |
| --- | --- | --- | --- |
| `BOARD_GITHUB_TOKEN` | The GitHub token. Never stored anywhere else. | none, required | needed |
| `BOARD_REPO` | The data repository, `owner/name`. | none, required | needed |
| `BOARD_MODE` | `local`, `proxy` or `hosted` (`hosted` acts as `proxy`). | `local` | never needed |
| `BOARD_HOST` | The address to listen on. | `127.0.0.1` in `local` | never needed |
| `BOARD_PORT` (or `PORT`) | The port. | `8787` | to change the port |
| `BOARD_ALLOWED_HOSTS` | `Host` values the board answers to. | `localhost:<port>,127.0.0.1:<port>` | never needed |
| `BOARD_IDENTITY_HEADER` | The header a login in front sets. | none; required outside `local` | never needed |
| `BOARD_DATA_DIR` | Folder for the last good read. | `.board-data`, in the project folder, next to the `board` folder | rarely |
| `BOARD_READ_ONLY` | `1` switches the four actions off. | off | optional |
| `BOARD_CONFIG_DIR` | Reads settings, theme and state from a local folder instead of the data repository (development and tests). | none | never needed |
| `BOARD_ICLOUD_USER` | Your Apple Account sign-in, to show your iCloud calendar. Set together with the next one, or not at all. | none | optional |
| `BOARD_ICLOUD_APP_PASSWORD` | An app-specific password made for the board, never the account's own password. | none | optional |
| `BOARD_GOOGLE_ICAL_1` to `BOARD_GOOGLE_ICAL_5` | The secret address of the Google calendar in the first to fifth place of the settings, to show a Google calendar instead of iCloud. Each is optional. | none | optional |

The two iCloud values are secrets like the token.
The Google addresses are secrets too: anyone who holds one can read that calendar.
The Google steps are in `references/calendar-google.md`.
How to make the password, name your calendars and keep the values for next time is in `references/calendar-icloud.md`.

## Where it keeps things

One folder: `.board-data`, in the project folder next to the `board` folder, or the folder named by `BOARD_DATA_DIR`.
It appears after the first successful read.
It holds the last good read (`last-good.json`), which contains no token.
Deleting it is safe; the next read fills it again.
Once a day, at `refresh.dailyAt` in your settings (`05:00` by default), the board reads everything from scratch.
If the computer was asleep, the first page load of the day does it.

## Keeping the token for next time

Type these in your own terminal, never in a chat or a repository file.

macOS Keychain (from documentation, not run):

```
security add-generic-password -a "$USER" -s board-github-token -w
security find-generic-password -a "$USER" -s board-github-token -w
```

Linux (`secret-tool` was not run; it was not installed on the test machine). With `secret-tool`, where your system has it:

```
secret-tool store --label="Board GitHub token" service board-github-token
secret-tool lookup service board-github-token
```

Otherwise, a file only you can read, outside any repository (run in bash or zsh; plain `sh` leaves an empty file).
The `umask 077` makes the folder and the file private from the moment they are written.
It sits inside parentheses so it does not change your terminal.
Paste the token and press Enter; nothing is shown.
This was run in bash.

```
( umask 077; mkdir -p ~/.config/board; read -s T; printf '%s' "$T" > ~/.config/board/token )
chmod 600 ~/.config/board/token
```

Windows (from documentation, not run). The file works only for your user on this machine:

```
New-Item -ItemType Directory -Force "$env:USERPROFILE\.board" | Out-Null
Get-Credential -UserName board | Export-Clixml "$env:USERPROFILE\.board\token.xml"
(Import-Clixml "$env:USERPROFILE\.board\token.xml").GetNetworkCredential().Password
```

Type the token as the password. The last line reads it back.

## Starting at login

Each system runs a small start script that fetches the token and runs the board.
The token is never written into the plist, the unit or the task.
Replace `/path/to/board-folder` and `/full/path/to/node` with your own.

macOS (from documentation, not run). `~/bin/start-board.sh`, then `chmod +x`:

```
#!/bin/sh
export BOARD_GITHUB_TOKEN="$(security find-generic-password -a "$USER" -s board-github-token -w)"
export BOARD_REPO=sam-life/life
cd /path/to/board-folder || exit 1
exec /full/path/to/node board/server.mjs
```

`~/Library/LaunchAgents/board.local.plist`, then `launchctl load` on it:

```
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>board.local</string>
  <key>ProgramArguments</key><array><string>/Users/YOU/bin/start-board.sh</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
```

Linux. The script was run and brought the board up with the token read from the file.
The unit passed `systemd-analyze --user verify`; it was not started.
Run `mkdir -p ~/bin ~/.config/systemd/user`.
Save the same script as `~/bin/start-board.sh`, with `export BOARD_GITHUB_TOKEN="$(cat ~/.config/board/token)"` as the token line.
Run `chmod +x ~/bin/start-board.sh`; without it systemd refuses the unit with `Permission denied`.
A keyring may still be locked at login, so the file is the safer choice here.
`~/.config/systemd/user/board.service`, then `systemctl --user enable --now board.service`:

```
[Service]
ExecStart=%h/bin/start-board.sh
Restart=on-failure

[Install]
WantedBy=default.target
```

Windows (from documentation, not run). `%USERPROFILE%\.board\start-board.ps1`:

```
$env:BOARD_GITHUB_TOKEN = (Import-Clixml "$env:USERPROFILE\.board\token.xml").GetNetworkCredential().Password
$env:BOARD_REPO = "sam-life/life"
Set-Location "C:\path\to\board-folder"
& "C:\full\path\to\node.exe" board/server.mjs
```

In Task Scheduler, create a task for your own user with the trigger "At log on" and this action:

```
powershell.exe -NoProfile -WindowStyle Hidden -File "C:\Users\YOU\.board\start-board.ps1"
```

## Checking it

`http://localhost:8787/healthz` answers `ok`, with or without GitHub.
In a terminal that has the token and repository set, `node scripts/read-once.mjs` reads the data repository once and prints counts.
Run it from the project folder.
When GitHub does not answer it prints one line and ends with exit code 1.
The line starts `stale:` when there is a saved copy, and `No saved data yet:` when there is none.
When GitHub does not answer, the page still opens, with a banner: "Showing the last good read", the reason, and the time of that read.
With no good read yet, the board shows a small plain page instead.

## Port and read-only

In the terminal where the token is already set:

```
BOARD_PORT=8788 BOARD_REPO=sam-life/life node board/server.mjs
```

On Windows set `$env:BOARD_PORT = "8788"` first, then open the new address.
Set `BOARD_READ_ONLY=1` to switch off the four actions the page can do, so it only shows.
