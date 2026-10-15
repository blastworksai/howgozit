# Release checklist

This file lists what no automated test can check.
Do it before every release, in order, on a clean copy of the folder.
Run every command from the folder that holds `board/server.mjs`.
Tick a box only after you have seen the result with your own eyes.
Fill in the table at the end.

## 1. The automated part, once

- [ ] Run `TZ=UTC node --test "test/*.test.mjs"`. See every test pass.
- [ ] Run `TZ=Pacific/Kiritimati node --test "test/*.test.mjs"`. See every test pass.
- [ ] Run `TZ=America/Adak node --test "test/*.test.mjs"`. See every test pass.
- [ ] Run `node scripts/rules.mjs 1-128 S1-S8`. See `ok`.
- [ ] Open `test/pending-rules.json`. See an empty list, `[]`.
- [ ] Run `node --check` on every `.mjs` file in `board/`, `scripts/`, `test/` and `fixtures/`. See no output and no error.

## 2. The page by eye

Run `node scripts/render-fixture.mjs`.
It writes sample pages into `out/`.
Open each file in a browser, once at desktop width and once at 390 pixels wide.

- [ ] Open `out/page.html`. See all sixteen sections, in the order of rule R86 in `references/contract.md`.
- [ ] Look at every section. See no text clipped and nothing overlapping.
- [ ] Look at the calendar. See a short event and an evening event, both readable and in the right place.
- [ ] Open `out/page-min.html`. See a page that still looks finished with almost no data.
- [ ] Open `out/page-stale.html`. See the stale banner at the top.
- [ ] Open `out/page-readonly.html`. See no controls: no buttons, no boxes to type in.
- [ ] Open `out/notice.html`. See one plain message you could act on.
- [ ] Narrow the window to 390 pixels. See one column and the "Log an idea" box fixed at the bottom of the screen.
- [ ] Scroll the phone width to the end. See that the bottom box never hides the last section.
- [ ] Look at the pages with the default fonts. See the fonts load and the text reads well.
- [ ] Run `node scripts/render-fixture.mjs --fonts system` and reopen `out/page.html`. See the same layout in system fonts, nothing shifted or cut.

## 3. The feel, in a real browser against a real board

Start the board against a real data repository, as in `references/deploy-local.md`.
Open it in a browser.

- [ ] Tick a task. See it change without the page reloading.
- [ ] Log an idea. See it appear without a reload and the box empty and ready for the next one.
- [ ] Sort an idea into a project. See it leave the inbox and appear where you sent it.
- [ ] Close a task. See it leave the list.
- [ ] Block the page's script in the browser. Repeat the four actions above. See each one reload the page and still work.
- [ ] Stop the board's access to GitHub, or use a token without write rights, and try an action. See the server's plain message beside the control, not a blank or a code.
- [ ] Open the network panel and reload. See requests only to the board itself.
- [ ] With the default fonts, check the panel again. See requests to the two font hosts and no others.
- [ ] Run `node scripts/calendar-check.mjs` against a real iCloud account. See it list the calendars and count today's events for the ones you name.
- [ ] Look at the calendar card with real events, including one repeating event and one event from another time zone. See each at the right time.

## 4. Setup, live, on a scratch private repo

Do this twice.
Once on an organisation with a fine-grained token.
Once on a personal account with a classic token.
Use a new private repository that you can delete afterwards.

- [ ] Run `node scripts/setup.mjs check --repo owner/name`. See that it passes and says what it found.
- [ ] Run `node scripts/setup.mjs plan proposal.json`. See the list of what it would do. See on GitHub that nothing was created.
- [ ] Run `node scripts/setup.mjs apply proposal.json`. See it finish without an error.
- [ ] Start the board. See every project with its tasks and zero warnings.
- [ ] Run `node scripts/setup.mjs apply proposal.json` again. See that it creates nothing.
- [ ] Run `node scripts/undo.mjs`. See on GitHub that exactly what was created is gone and nothing else.

Note: GitHub may take a couple of minutes to list new Project items.
Setup waits for it.
Do not call it a failure before it has waited.

## 5. The three ways to run it

Give each document to someone who did not write it.
They start from a clean folder and follow it word for word.

- [ ] Follow `references/deploy-local.md`. See the board running and the page open.
- [ ] Follow `references/deploy-proxy.md`. See the board running behind a login.
- [ ] At the end of `references/deploy-proxy.md`, do its six checks. See each one give the result the document says.
- [ ] Follow `references/deploy-tailscale.md`. See the board open on a second device that is signed in, and not from one that is not.
- [ ] Ask each person where they got stuck. Write it down and fix the document.

## 6. Other systems

- [ ] On macOS, run the suite from section 1 once. See every test pass.
- [ ] On Windows, run `npm test` once, without a time zone. See every test pass.
- [ ] On Windows PowerShell, run `$env:TZ = "Pacific/Kiritimati"; node --test "test/*.test.mjs"`. See every test pass.
- [ ] On each, type the start commands of `SKILL.md` exactly as written. See the board start.

## 7. Secrets and privacy

- [ ] Search the whole repository for the token you used. See no match.
- [ ] Run `git status`. See no `.board-data`, no `setup-undo*.json` and no `proposal*.json`.
- [ ] Open the data repository on GitHub. See that it is private.
- [ ] Click every link on the page. See that each one goes to GitHub.

## 8. Words

- [ ] Read `SKILL.md` aloud to someone who is not a developer. Mark every place they hesitate.
- [ ] Trigger each message the scripts print (a missing token, a wrong repo, a refused write). See a sentence they can act on.

## 9. Before publishing

- [ ] Check that `LICENSE` is present.
- [ ] Search the whole tree for any personal or company name. See none.
- [ ] Open `README.md`. See that it says which systems the board was verified on.

## Result

Copy one row per section, per run.
Write `pass`, or what failed.

| Date | Who | System | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |
