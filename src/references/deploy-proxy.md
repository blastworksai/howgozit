# Running the board behind your own login proxy

What was run and what was not: the image was built from `deploy/Dockerfile` and started once on Linux, with no network, a read-only file system, every capability dropped and a made-up identity header.
In that run it listened as a user without rights, its health check went green, it answered 401 without the identity header, 421 for another host name, and it refused to start without `BOARD_IDENTITY_HEADER`.
The compose file was written and read through, and was NOT started.
The Caddy example follows the shape of a Caddy and Authentik set-up that is known to work.
This guide has NOT been followed end to end behind a real login proxy.
Treat it as a careful starting point and check each step.

## The shape

The board has no login of its own.
It holds no passwords and shows no login page.
Outside `local` mode it will not start unless it is told which request header a login in front of it sets, and it answers 401 to any request without that header.

```
browser --> login proxy --------------> the board
            TLS, checks who you are,    internal network only,
            adds the identity header    no published port
```

The board does not check who the header names.
It checks only that the header is there.
So two things must be true, and everything below exists to make them true:

1. The proxy removes any copy of that header that the browser sent, then sets its own after a successful login.
2. Nothing can reach the board except through the proxy.

Who may sign in is decided in the login proxy, not in the board.
In Authentik, bind the application to a user or a group.
A provider that lets every account of the organisation in lets all of them see the board.

## Why each setting exists

| Setting | Why |
| --- | --- |
| `BOARD_MODE=proxy` | The board expects a login in front. It will not start without an identity header. The image sets it. |
| `BOARD_IDENTITY_HEADER` | The name of the header the proxy adds after a login. A request without it gets 401. Example: `X-Authentik-Username`. |
| `BOARD_ALLOWED_HOSTS` | The public name people type, for example `board.example.com`. A request with any other `Host` gets 421. Without it the board answers only to `localhost:<port>` and `127.0.0.1:<port>`, and your own name would be refused. |
| `BOARD_HOST=0.0.0.0` | Inside a container the board must listen on all addresses, or the proxy cannot reach it. The image sets it. This is safe only because the port is not published. When the proxy runs on the same machine and the board is not in a container, set `BOARD_HOST=127.0.0.1` instead, because outside `local` mode the board listens on every address by default. |
| `BOARD_GITHUB_TOKEN` | A GitHub token that can read the data repository and, for the board's four actions, write issues and Projects. With `BOARD_READ_ONLY=1` the board writes nothing. It is a secret. Keep it in a file outside the repository and outside the image. Never write it in the compose file. |
| `BOARD_REPO` | The data repository, written `owner/name`, for example `sam-life/life`. |
| `BOARD_ICLOUD_USER`, `BOARD_ICLOUD_APP_PASSWORD` | Optional, set together or not at all. They let the board read your iCloud calendar (see `references/calendar-icloud.md`). The password is a secret: keep both in the same file as the token, outside the repository, and never write them in the compose file. |
| `BOARD_GOOGLE_ICAL_1` to `BOARD_GOOGLE_ICAL_5` | Optional. The secret address of the Google calendar in that place of the settings (see `references/calendar-google.md`). Each is a secret: keep them in the same file as the token, outside the repository, and never write them in the compose file. |
| `BOARD_PROXY_SECRET` | Optional. A secret the proxy sends on every request as the header `X-Board-Proxy-Secret`. When it is set, the board answers 401 to any request without that exact value, on every route except `/healthz`. At least 32 characters, no whitespace, or the board will not start. It is a secret: keep it in a file outside the repository and never write it in the compose file. See "On a machine other people or programs share". |
| `BOARD_DATA_DIR=/data` | Where the board keeps its last good read. The image sets it, and the compose file mounts a named volume there. |

Inside the container leave the port at 8787, because the image's health check asks that port.

The board reads the token from its environment only.
That is why the compose file uses `env_file`, not a Docker secret file.

## Worked example: Authentik and Caddy

The login is Authentik.
The reverse proxy is Caddy, using its `forward_auth` directive.
Caddy asks Authentik's embedded outpost about every request, and the outpost answers with the user's name in `X-Authentik-Username`.
The board runs on an internal network with no published port (or on a loopback port if Caddy runs on the host).
In the settings the board needs: `BOARD_MODE=proxy`, `BOARD_ALLOWED_HOSTS=board.example.com` and `BOARD_IDENTITY_HEADER=X-Authentik-Username`.
This example assumes an Authentik server already runs and can be reached from Caddy.
Authentik is not in the compose file.

Steps:

1. In Authentik, create a Proxy provider in forward-auth mode (single application) for `https://board.example.com`, an application that uses it, and attach it to an outpost.
   The embedded outpost is enough.
   Bind the application to the user or group that may see the board.
2. Put the token in a file outside the repository, for example `/etc/board/board.env`, with one line: `BOARD_GITHUB_TOKEN=` followed by the token.
   Set the mode to 600.
3. Edit `deploy/compose.proxy.example.yml` and `deploy/Caddyfile.example` in place, in the `deploy/` folder (a copy made elsewhere breaks `context: ..` and the Caddyfile mount).
   Change the host name, the repo, and the address of the Authentik server (the placeholder `authentik-server:9000` appears in the Caddyfile).
   If Authentik lives on another Docker network, attach the `caddy` service to that network too.
4. Decide where TLS ends, and keep one of the two site blocks in the Caddyfile.
   If Caddy holds the certificate itself, use `board.example.com { … }`.
   If TLS ends in front of Caddy, use `board.example.com:80 { … }` and keep `header_up X-Forwarded-Proto https`, so the outpost builds its redirects with `https`.
5. Build and start from the `deploy/` folder: `docker compose -f compose.proxy.example.yml up -d --build`.
   The build context is the `src` folder, one level up.

The lines that matter in the Caddyfile:

- `route { … }` wraps the outpost path and the auth check.
  Inside a `route`, Caddy keeps the written order, so the outpost's own paths (`/outpost.goauthentik.io/*`) are handled before the auth check.
  Without it, the login redirect can loop.
- `reverse_proxy /outpost.goauthentik.io/* …` sends the outpost's own paths to Authentik without a login check.
- `forward_auth … { uri /outpost.goauthentik.io/auth/caddy }` asks the outpost about every other request.
- `copy_headers X-Authentik-Username …` copies those headers from Authentik's answer onto the request sent to the board.
  The capitalisation of the names matters.
- `trusted_proxies private_ranges` lets Caddy accept forwarded headers from private addresses.

The board lowercases `BOARD_IDENTITY_HEADER`, so `X-Authentik-Username` and `x-authentik-username` are the same to it.

Whether the proxy removes a copy of the header that the browser sent is something you find out with the checklist below.
The board cannot tell a forged header from a real one.

The board's service has no `ports:` section.
Only Caddy is published to the outside.

The compose file also hardens the container:

- `init: true` puts a small init process in front of the board, so it stops at once on `docker compose stop` instead of waiting out the ten-second timeout.
- `read_only: true` makes the container's file system read-only, so the board can write only to `/data` and the `tmpfs`.
- `tmpfs: /tmp` gives it a small scratch folder in memory that is gone when it stops.
- `cap_drop: ALL` removes every Linux capability the board does not need.
- `security_opt: no-new-privileges:true` stops any process in the container from gaining more rights.
- `restart: unless-stopped` starts the board again after a crash or a reboot, until you stop it yourself.

The image has a `.dockerignore` file, so the build context leaves out files that do not belong in the image.
Keep it in place when you build.

## On a machine other people or programs share

The board trusts the identity header, and a header is only text.
On a machine where other accounts or programs run, any of them can open a connection to the board's port on the loopback address and send the identity header itself.
Your login proxy never sees that request, so the login does not protect it.

The lock is `BOARD_PROXY_SECRET`.
Set it on the board, and make the proxy add the same value as the header `X-Board-Proxy-Secret` on every request it forwards.
Without the right value the board answers 401, the same answer as for a missing identity, so the reply does not say which lock refused.
Only `GET /healthz` is let through without it.
In the Caddyfile example, switch on the `header_up X-Board-Proxy-Secret {env.BOARD_PROXY_SECRET}` line.

Make a value with `openssl rand -hex 32`.
That gives 64 characters, which is above the 32 the board asks for.
Keep it in one file, outside the repository, readable only by root, for example `/etc/board/proxy_secret.env`, with one line: `BOARD_PROXY_SECRET=` followed by the value.
Let both the proxy and the board read that one file, with `EnvironmentFile=` for each service or `env_file:` in compose.
Then the two sides cannot drift apart, and changing the value is one edit and two restarts.

The lock does not replace the other rules.
The proxy still strips and sets the identity header, and the board's port should still answer on the loopback address only.

## Without a container: a unit beside the proxy

If the board runs straight on the machine next to the proxy, `deploy/board.service.example` is a systemd unit that locks it down.
It runs the board as its own account, with `BOARD_HOST=127.0.0.1`, a private state folder, no capabilities and no way to reach most of the file system.
Edit the host name, the account, the paths and the identity header name to match your set-up before you install it.
Put the unit in `/etc/systemd/system/`, run `systemctl daemon-reload`, then `systemctl enable --now board`.
Make the proxy read `proxy_secret.env` too, for example with a drop-in for the proxy's own service that adds the same `EnvironmentFile=`, so Caddy can fill `{env.BOARD_PROXY_SECRET}`.

## The same pattern for another proxy

This works for oauth2-proxy, Authelia, a cloud provider's identity-aware proxy, or any proxy with forward-auth or a built-in login.

- Pick one header the proxy sets after login, such as `X-Forwarded-User`, `Remote-User` or the name your provider documents.
  Put that name in `BOARD_IDENTITY_HEADER`.
  The board lowercases it, so the case does not matter.
- Strip and set.
  Configure the proxy to delete that header from the browser's request, then set it from the login result.
  If your proxy can only add a header and not strip one, put a rule in front of it that deletes the header.
- No published port.
  Put the board on an internal network that only the proxy shares.
  If the board's port can be reached from any other machine, anyone can send the header themselves and walk past your login.
- Health check on `/healthz`.
  It answers `ok` with no header and for any `Host`, so a proxy, an orchestrator or the image's own `HEALTHCHECK` can use it without a login.
- Set `BOARD_ALLOWED_HOSTS` to exactly the name people type, with the port if it is not 443.
- Terminate TLS at the proxy.
  The board speaks plain HTTP.

## Check before you trust it

Run these in order.
Stop at the first one that does not give the answer shown.

1. From outside, with no login, open `https://board.example.com/`.
   Expect the login page, not the board.
2. From another machine, run `curl -m 5 http://<docker-host>:8787/`.
   Expect a failure to connect.
   If you get any answer, a port is published. Remove it.
3. Send a forged header in a request that has no valid login, for example `curl -i -H "X-Authentik-Username: sam" https://board.example.com/`.
   Expect the login page or a redirect to it, not the board.
   Then, with a valid session cookie, send the same forged header with another name.
   The board never shows the identity header, and it logs only the method, the path and the status.
   So put a throwaway service that prints its request headers behind the same proxy rule, in place of the board, and send the same request to it.
   It must show your real login name, not the forged one.
   If the forged value gets through, the proxy is not stripping the header. Stop, and do not use it until it does.
4. Without logging in, `curl https://board.example.com/healthz` is not available to you, because the proxy asks for a login first.
   From the `deploy/` folder, on the Docker host, run `docker compose -f compose.proxy.example.yml exec board node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)"`.
   Expect `ok`.
5. Log in and load the page.
   Expect the board.
6. Send a wrong `Host`, from the `deploy/` folder: `docker compose -f compose.proxy.example.yml exec board node -e "fetch('http://127.0.0.1:8787/',{headers:{host:'evil.example','x-authentik-username':'a'}}).then(r=>console.log(r.status))"`.
   Expect `421`.
   (Node's `fetch` may refuse to set `Host`. If it does, use any HTTP client that allows it.)
7. On a shared machine with `BOARD_PROXY_SECRET` set, send a request straight to the board's port with a forged identity header and no secret, for example `curl -i -H "X-Forwarded-User: sam" http://127.0.0.1:8787/`.
   Expect 401.
8. From another machine, connect to the board's port, for example `curl -m 5 http://<host>:8787/`.
   Expect a failure to connect, because the board answers on the loopback address only.
   On the machine itself, `ss -ltn` should show the port on `127.0.0.1` and not on `0.0.0.0`.

## Updating

1. Pull the new code.
2. From the `deploy/` folder: `docker compose -f compose.proxy.example.yml up -d --build`.
   This rebuilds the image and restarts the board.
3. Run the checklist again if you changed the proxy.

The data folder is the named volume `board-data`, mounted at `/data`.
It holds the last good read, which is your GitHub data and, with the iCloud calendar on, today's event titles.
It holds no token and no sign-in.
It is safe to delete.
The board reads it again on the next start.
The data repository on GitHub is the real copy.

## Pointing a name at the proxy

Create a DNS record for `board.example.com` that points at the machine running the proxy.
Use the same name in three places: the DNS record, the proxy's site block, and `BOARD_ALLOWED_HOSTS`.
If they differ, you get a 404 from the proxy or a 421 from the board.
