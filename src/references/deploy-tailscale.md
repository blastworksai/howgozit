# Reaching the board from your own devices with Tailscale Serve

What was run and what was not: this guide is written from Tailscale's documentation (read in October 2026) and from the board's own rules.
It was NOT followed on a real tailnet.
Check each step, and do the checks at the end before you trust it.

## What you get and what it costs

The board runs on your own computer.
You open it from your own phone and laptop, anywhere.
It is never on the public internet.

- Tailscale's pricing page lists a Personal plan at $0, "Free forever", with up to 6 users and unlimited user devices.
  That page does not mention Tailscale Serve by name, so check the plan page for Serve yourself.
- The computer must be on, and must be online, whenever you want the board.
- Every device needs the Tailscale app and your sign-in.

Tailscale also has a feature called Funnel.
It makes a service reachable from the whole public internet.
Do not use Funnel for the board.

## The shape

The board has no login of its own.
Outside `local` mode it will not start unless it is told which request header a login in front of it sets, and it answers 401 to any request without that header.
Here the login in front is Tailscale.

```
your phone --> Tailscale -----------> Tailscale Serve ----------> the board
               encrypted, knows       on your computer,           127.0.0.1:8787,
               who you are            adds the identity header,   this computer only
                                      removes any forged copy
```

The board does not check who the header names.
It checks only that the header is there.
So two things must be true:

1. Serve removes any copy of that header that the client sent, and sets its own.
2. Nothing outside this computer can reach the board's port except through Serve.

## Steps

1. Install Tailscale on the computer and on each device you want to use.
   Sign in to all of them with the same account.
2. In the Tailscale admin console, open the DNS page.
   Make sure MagicDNS is on.
   Tailscale's page says tailnets created on or after 20 October 2022 have it on by default.
3. On the same DNS page, turn on HTTPS under HTTPS Certificates.
   Tailscale's page warns that this publishes your machine names and your tailnet DNS name in a public certificate log.
   Pick a machine name you do not mind being public, and rename the computer before you turn this on.
   Tailscale's page says disabling HTTPS later does not revoke certificates already issued.
4. Find the computer's full name.
   In the admin console, open the Machines page and then the computer.
   The name looks like `sams-laptop.example-tailnet.ts.net`.
5. Start the board, as in `references/deploy-local.md` for the token and the repository, with these settings added.
   Open a terminal in the folder that holds `board/server.mjs`.

```
read -s BOARD_GITHUB_TOKEN; export BOARD_GITHUB_TOKEN
BOARD_REPO=sam-life/life \
BOARD_MODE=proxy \
BOARD_HOST=127.0.0.1 \
BOARD_IDENTITY_HEADER=tailscale-user-login \
BOARD_ALLOWED_HOSTS=sams-laptop.example-tailnet.ts.net \
node board/server.mjs
```

| Setting | Why |
| --- | --- |
| `BOARD_MODE=proxy` | A login sits in front. The board will not start without an identity header, and answers 401 to a request without it. |
| `BOARD_HOST=127.0.0.1` | Nothing outside this computer can reach the port except through Tailscale Serve. Outside `local` mode the default is every network card, which would let anyone on your network send the header themselves. |
| `BOARD_IDENTITY_HEADER=tailscale-user-login` | The header Serve adds. Tailscale's page names it `Tailscale-User-Login`. The board lowercases the name, so the case does not matter. |
| `BOARD_ALLOWED_HOSTS` | The name you type in the address bar. A request with any other `Host` gets 421. |
| `BOARD_GITHUB_TOKEN`, `BOARD_REPO` | The token and the data repository, as in `references/deploy-local.md`. |

The two optional iCloud calendar variables, `BOARD_ICLOUD_USER` and `BOARD_ICLOUD_APP_PASSWORD`, work the same way here as on your own computer; see `references/calendar-icloud.md`.
The optional Google calendar variables, `BOARD_GOOGLE_ICAL_1` to `BOARD_GOOGLE_ICAL_5`, work the same way; see `references/calendar-google.md`.

6. In a second terminal, put HTTPS on the tailnet name in front of the board:

```
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

   `--bg` keeps it running in the background.
   Tailscale's page says only `http://127.0.0.1` is supported as a target for a proxy.
7. See what is being served:

```
tailscale serve status
```

8. Stop it:

```
tailscale serve --https=443 http://127.0.0.1:8787 off
```

   Tailscale's page says to add `off` to the end of the command you used to turn it on, with the same flags.
   `tailscale serve reset` clears all Serve settings on this computer.

Then open `https://sams-laptop.example-tailnet.ts.net` on a device that is signed in.

## Who can get in

Anyone signed in to your tailnet can open the board.
The board only checks that Tailscale passed someone through, not who.

- Keep the tailnet to yourself, or
- if you share it, limit which devices and people can reach this computer with Tailscale's access rules.
  See Tailscale's documentation on access control (ACLs and grants).

Tailscale's Serve page says the identity headers are not filled in for traffic from tagged devices.
The board would then answer 401 to them.
It also says the headers are filled in for an outside person who accepts a share of your machine.
So sharing a machine with someone lets them in.

## What stays true on the computer itself

Other programs on the same computer can reach `127.0.0.1:8787` directly.
They get 421 unless they send the allowed host name, and 401 unless they also send the identity header.
A program that sends both can read the board.
That is the same trust as running the board locally.
Tailscale's page gives the same advice: have the program listen only on localhost, or anyone who reaches it directly can forge the headers.

## Checks before you trust it

Run these in order.
Stop at the first one that does not give the answer shown.

1. On a phone that is signed in to Tailscale, open `https://sams-laptop.example-tailnet.ts.net`.
   Expect the board, over HTTPS.
2. On a device that is not on your tailnet, with the Tailscale app off, open the same name.
   Expect that it does not resolve or does not connect.
   If the board opens, stop and run `tailscale serve status` to see what is shared.
3. On the computer, run `curl -i -H "Host: sams-laptop.example-tailnet.ts.net" http://127.0.0.1:8787/`.
   Expect `401`.
   Without the `Host` header the answer is `421`, because the board checks the host name first.
   Then run `curl http://127.0.0.1:8787/healthz`.
   Expect `ok`.
   The board answers `/healthz` before it checks the host name or the identity header, so this one needs neither.
4. From another device on your tailnet, send a forged header through Serve:

```
curl -i -H "Tailscale-User-Login: forged@example.org" https://sams-laptop.example-tailnet.ts.net/
```

   Tailscale's page says Serve removes these headers when it finds them on an incoming request.
   Expect the board, not an error.
   The board does not show the login, so also look at the identity the board saw: the plain way is to run the same `curl` against a throwaway server that prints request headers, instead of the board.
   Expect your own login there, not `forged@example.org`.
   If the forged value shows up, Serve is not replacing it.
   Stop, run `tailscale serve reset`, and do not use this set-up.
5. If the page answers 421, the host name in `BOARD_ALLOWED_HOSTS` does not match the `Host` the board received.
   Tailscale's pages do not say what `Host` Serve passes on.
   Read the exact name from the browser's address bar, set `BOARD_ALLOWED_HOSTS` to that, and restart the board.
   If you use a port other than 443, include it, for example `name.example-tailnet.ts.net:8443`.

## Starting at login, and turning it off

For the board, use the start scripts in `references/deploy-local.md`, with the settings from step 5 added.
Tailscale's page says a Serve started with `--bg` keeps running until you turn it off and resumes after a reboot or after `tailscale down` and `tailscale up`.
Without `--bg` you must start it again by hand.

To turn it all off:

1. Stop the board (Ctrl+C, or stop its start-up task).
2. Run `tailscale serve --https=443 http://127.0.0.1:8787 off`, or `tailscale serve reset`.
3. Check with `tailscale serve status` that nothing is listed.

## A hosting platform instead

A hosting platform with its own login in front works too.
Run the board with `BOARD_MODE=hosted` and set `BOARD_IDENTITY_HEADER` to that platform's identity header.
There is no step-by-step guide for one.
The same rule holds: the platform must limit who may sign in.
