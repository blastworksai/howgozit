# Giving your board a look of its own: skins

This guide is for you if you want your board to look different from the neutral look it ships with.
You do not need to be a developer, but you do need to be able to write a little CSS, or to ask an agent to write it for you.
Everything here is about one private folder on the computer that runs the board.
Where a step depends on how you run the board, the guide says so.

## What a skin is and is not

A skin is one folder that holds one stylesheet, up to six fonts and up to twelve images.
The board wears it on top of its neutral look: your stylesheet loads after the board's own, and its rules apply on top of the neutral look.
The skin is yours.
It lives on the board's own computer, and the board only reads it.
It is never uploaded anywhere, and it is not part of your data repository.

A skin is not a theme.
The theme file (`theme.json` in your data repository) sets colours, fonts and the size of the corner cut, and works with no skin at all.
A skin goes further: it can restyle any part of the page, bring its own fonts and show images.

A skin is only a look.
It cannot add scripts, change the page's content or add pages.
"What a skin cannot do" below says exactly what.

## The folder

The folder has one shape.

```
my-skin/
  skin.css
  fonts/
    (up to 6 fonts)
  img/
    (up to 12 images)
```

Only `skin.css` is required.
`fonts/` and `img/` are optional.
These are the limits, and they are exact:

| Part | Allowed | Size limit of each file |
| --- | --- | --- |
| `skin.css` | exactly this name, one file | 256 KB |
| `fonts/` | up to 6 files, extension `.woff2` | 300 KB |
| `img/` | up to 12 files, extension `.png`, `.svg`, `.webp` or `.jpg` | 500 KB |

A kilobyte here is 1,024 bytes.
All the files together may be at most 3 MB (3,145,728 bytes).
The board counts `skin.css` first, then the fonts in order of name, then the images in order of name.
A file that would take the total over 3 MB is skipped.

When there are more files than the limit, the board takes them in order of name: the first six fonts and the first twelve images that meet every rule.
The board looks at no more than 64 entries in each of the three folders (the skin folder, `fonts/` and `img/`).
An empty `skin.css` is a valid skin.

Anything else in the skin folder is ignored without a warning, and so is any name that starts with a dot.
A `README.txt` or a folder of notes beside `skin.css` does no harm.
In `fonts/` and `img/` it is different: a file that cannot be used is skipped with a warning (see "When the skin is bad").

## File names

Every file in `fonts/` and `img/` needs a name that follows one pattern.
Use lower case letters, digits and hyphens only.
Start with a letter or a digit.
Use at most 40 characters before the dot, then one dot, then the extension the folder allows.

Good names:

- `panel-sans.woff2`
- `grid.png`
- `logo-2.svg`
- `paper-texture.webp`
- `photo.jpg`

Bad names, and why:

- `Panel-Sans.woff2`: a capital letter.
- `panel sans.woff2`: a space.
- `panel_sans.woff2`: an underscore.
- `-grid.png`: starts with a hyphen.
- `grid.v2.png`: two dots.
- `grid.PNG`: the extension must be lower case.
- `photo.jpeg`: the extension is `.jpg`, not `.jpeg`.
- `panel-sans.ttf`: only `.woff2` is allowed for fonts.
- `loop.gif`: `.gif` is not allowed.
- a name of 41 or more characters before the dot.

A file with a bad name is skipped, and the board tells you in its footer.

## A worked example

This example makes a light board with its own font, a faint grid behind the focus section, and a restyled section head.
It uses one font and one image.

The folder:

```
my-skin/
  skin.css
  fonts/
    panel-sans.woff2
  img/
    grid.png
```

You supply the two binary files yourself: a `.woff2` font you have the right to use, and a small `.png`.
The stylesheet is `skin.css`, written out in full:

```css
/* A font from the skin folder. The address is relative to skin.css. */
@font-face {
  font-family: "Panel Sans";
  src: url("fonts/panel-sans.woff2") format("woff2");
}

/* Colours and fonts. Every selector starts with html[data-skin]. */
html[data-skin] {
  --ground: #f2f2ee;
  --card: #ffffff;
  --border: #b9b9b2;
  --ink: #1d1d1f;
  --muted: #4f4f55;
  --faint: #5c5c62;
  --accent: #2a7f8c;
  --on-accent: #ffffff;
  --font-heading: "Panel Sans", system-ui, sans-serif;
  --font-body: "Panel Sans", system-ui, sans-serif;
}

/* An image, referenced the same way: relative to skin.css. */
html[data-skin] [data-section="focus"] .card-f {
  background-image: url("img/grid.png");
}

/* Restyle one part: the small capital heading of every card. */
html[data-skin] .cap {
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
```

Four things to see in it.

**Addresses are relative to the stylesheet.**
The board serves your stylesheet at `/skin/skin.css`, your fonts under `/skin/fonts/` and your images under `/skin/img/`.
So inside `skin.css` you write `url("fonts/panel-sans.woff2")` and `url("img/grid.png")`, with no leading slash and no folder name of your own.
Use the file names exactly as they are in the folder.

**Set theme variables on `html[data-skin]`, never on `:root`.**
The board writes its own values for the theme variables in a style block on `:root`.
That block comes after your stylesheet in the page.
So a skin that sets a variable on `:root` loses, every time, and the board keeps its own colour.
A skin that sets the variable on `html[data-skin]` wins, every time, because that selector is more specific than `:root`.
Ordinary rules on parts, such as `.cap` or `.card-f`, do not depend on this and apply either way.

**Every selector starts with `html[data-skin]`.**
Start the selector of every rule with it, the rules for single parts included, so that all your selectors look alike and none can lose.
Two kinds of rule are the exception.
`@font-face` has no selector.
`@media` holds ordinary rules, and the selectors inside it still start with `html[data-skin]`.

**Set `--on-accent` when you change `--accent`, `--ground` or `--ink`.**
`--on-accent` is the colour of text that sits on the accent.
The board works it out from the colours of the theme file, not from your skin.
If your skin changes the accent, the ground or the ink, and you do not set `--on-accent` yourself, the text on the accent may be unreadable.

**With no font file, leave the fonts out.**
Your skin does not have to bring a font.
If you have no font file, leave out the `fonts/` folder and write no `@font-face`, and the board keeps its own fonts.
To turn the example above into a skin with no font, make two deletions in `skin.css`: delete the whole `@font-face` block at the top, and delete the two lines that set `--font-heading` and `--font-body`.
Then leave `panel-sans.woff2` and the `fonts/` folder out of the skin folder.
The rest of the example works unchanged.

Restyling one part takes three steps: find the part in the reference at the end of this guide, write a rule that starts with `html[data-skin]` and names its class (or the section and the class), then restart the board.

A copy of the same idea ships with the board, as the tiny test skin in `fixtures/skin`.
It uses a neutral stand-in font, and it is there for the tests rather than as a look to copy.

## Try it without a board

You can see a skin without a GitHub account, a data repository or a running board.
The board comes with a script that draws sample pages from made-up data and puts your skin on them.
Run it from the folder that holds `board/server.mjs` (the `src` folder), and name your skin folder:

```
node scripts/render-fixture.mjs --skin $HOME/my-skin
```

On Windows PowerShell, name the folder the same way: `node scripts/render-fixture.mjs --skin C:\Users\YOU\my-skin`.

The script writes its pages into the `out/` folder, next to `board/`:

- `out/page.html`: the whole board.
- `out/page-min.html`: a board with almost no data.
- `out/page-stale.html`: a board that shows the "last good read" strip.
- `out/page-readonly.html`: a board with no controls.
- `out/page-notion.html`: the board as it looks on Notion, with the `NT` tag. It is written only with `--skin`.
- `out/notice.html`: the plain page for a refusal or a failure, with no skin.
- `out/notice-skin.html`: the same page with your skin on. It is written only with `--skin`.

It also copies your skin's files beside the pages, as `out/skin/skin.css`, `out/skin/fonts/<name>` and `out/skin/img/<name>`, and the board's own files into `out/static/`.
Without `--skin` it writes only the first four pages, `notice.html` and `out/static/`.
Each run rewrites the files, so run it again after every change to your skin.
Each run first removes the `out/skin/` of the run before, so a file missing from `out/skin/` really was refused this time.
A run without `--skin` also removes a leftover `out/skin/` and the two skinned pages, `page-notion.html` and `notice-skin.html`, so an unskinned run clears the skinned preview.

Open `out/page.html` in a browser, as a file.
Look at it at desktop width, then make the window about 390 pixels wide and look at it again.
At 480 pixels or less the page turns into one column.
Then open the other pages the same way.

`--fonts system` or `--fonts google` can be added, to see the skin over either set of fonts.
With `google` the pages need a connection to Google's font service.

What this does not show:

- The data is made up, and the pages are plain files.
  The controls do nothing, because no board is running.
- The pages are opened from disk, so none of the board's content-policy headers apply.
  A skin that loads something from another site may look right here and be refused on a real board, so keep your skin to its own fonts and images.
- A skipped file shows no warning here.
  The script copies only the files the board would accept, so a file it skipped is simply missing from `out/skin/`.
  Compare `out/skin/fonts/` and `out/skin/img/` with your folder to find it.
- If the folder cannot be used as a skin at all, the script writes no pages and prints one sentence: `The skin folder could not be read, so no pages were written.`
- It does not test `BOARD_SKIN_DIR`, a restart or the folder's permissions.
  For those, switch the skin on, as the next section says.

## Switching it on

The board reads the skin from the folder named by one setting, `BOARD_SKIN_DIR`.
Unset, empty or only spaces means no skin, and the board is exactly as it is without this feature.
A relative path is read from the folder the board was started in; an absolute path is safer.

The board reads the folder once, when it starts.
If you add, change or remove a file afterwards, nothing changes until you start the board again.
Start it again after every change.

### On your own computer

Start the board as `references/deploy-local.md` does, with one more value.
macOS or Linux:

```
BOARD_SKIN_DIR=$HOME/my-skin BOARD_REPO=sam-life/life node board/server.mjs
```

Windows PowerShell:

```
$env:BOARD_SKIN_DIR = "C:\Users\YOU\my-skin"
$env:BOARD_REPO = "sam-life/life"
node board/server.mjs
```

The token must already be set in the same terminal, as in `references/deploy-local.md`.
Open `http://localhost:8787`.

To check that the board loaded the skin, run this in a second terminal (it works in `local` mode, where no login is asked for):

```
curl http://localhost:8787/skin/skin.css
```

You should see your stylesheet.
With no skin loaded the board answers 404 for this address.

### Under the hardened systemd unit

`deploy/board.service.example` hides your home folder, `/opt`, `/srv` and `/mnt` from the board.
A skin kept in any of those places cannot be read, so the board would show no skin.
Keep the skin under `/etc/board/skin` instead.
The board's account must be able to read it, and nothing may be able to change it except root.

1. Copy the folder and set owner and modes (run these as an administrator; `my-skin` is your folder):

   ```
   sudo mkdir -p /etc/board
   sudo cp -r my-skin /etc/board/skin
   sudo chown -R root:root /etc/board/skin
   sudo find /etc/board/skin -type d -exec chmod 755 {} +
   sudo find /etc/board/skin -type f -exec chmod 644 {} +
   ```

2. Check that the board's account can pass through `/etc/board` itself.
   Run `ls -ld /etc/board`.
   A mode of `drwxr-xr-x` or `drwx--x--x` is enough.
   The secret files inside, `board.env` and `proxy_secret.env`, keep their own mode 600 and stay unreadable to the account.
   If the folder is `drwx------`, the board cannot reach the skin: run `sudo chmod 711 /etc/board`.

3. In the unit, remove the `#` from the `BOARD_SKIN_DIR` line (the example has it, commented, next to the other `Environment=` lines).
   Do not change anything else in the unit.

4. Start the board again, and read the new unit first:

   ```
   sudo systemctl daemon-reload
   sudo systemctl restart board
   ```

A restart is needed after every later change to the skin, because the folder is read once at start.

### In the container

Mount the folder read-only and point the setting at the mount.
`deploy/compose.proxy.example.yml` has both lines, commented, under the `board` service:

```
    environment:
      BOARD_SKIN_DIR: /skin
    volumes:
      - /etc/board/skin:/skin:ro
```

The image runs the board as a user with no rights.
Make the folder and the files readable by everyone (modes 755 and 644, as in the systemd steps), or the board will find no skin.
Apply the change with `docker compose -f compose.proxy.example.yml up -d board`.
After you change a file in the folder, run `docker compose -f compose.proxy.example.yml restart board`.

## When the skin is bad

A bad skin never stops the board from starting.
The board skips what it cannot use and tells you in plain words in the footer of the page.
There are two warnings.

**`1 skin file could not be used and was skipped.`**
With more than one it reads `<n> skin files could not be used and were skipped.`, where `<n>` is the number.
This means the skin loaded, and `<n>` files in it did not.
The usual causes:

- a file name that breaks the rules (see "File names");
- the wrong extension for the folder, such as a `.ttf` in `fonts/`;
- a file over its size limit, or one that would take the total over 3 MB;
- a seventh font or a thirteenth image;
- a symbolic link, a folder or any other thing that is not an ordinary file, in `fonts/` or `img/`;
- a `fonts/` or `img/` that is itself a link or is not a folder;
- more than 64 entries in one of the three folders: the rest are not read, and the cut counts as one skipped file.

To fix it, correct the file or remove it from the folder, then start the board again.
The footer does not name the files.
Check each file in `fonts/` and `img/` against the limits table and the name rules.

**`The skin folder could not be read, so the board is shown without a skin.`**
This means no skin was loaded at all, and the board looks as it does with no skin.
The causes:

- the folder does not exist, or the path in `BOARD_SKIN_DIR` is wrong;
- the folder is a link and not a real folder;
- the board's account cannot list it;
- there is no `skin.css`, or `skin.css` is a link, a folder, unreadable or over 256 KB.
- on Linux, in a container, `/proc` is not mounted for the board, so the board cannot reach the folder's contents through the folder it holds open, and it refuses to reach them any other way.

To fix it, correct the path or the file, then start the board again.
On a hardened unit or in a container, also check that the board's account can read the folder (see the two sections above).
The footer never shows the folder's path.

## Safety, in plain words

- The board reads only ordinary files.
  It does not follow links: a link in the skin folder is skipped, and what it points at is never read or served.
- It reads each file once, at start, and keeps it in memory.
- Nothing outside the skin folder is ever served.
- One limit on the two statements above, which depends on the system.
  On Linux the board always holds each skin folder open and reaches its files through it, and it never reads a skin file any other way there.
  So swapping a folder for a link while the board starts changes nothing.
  If the board cannot do this on Linux, it never falls back to a weaker way of reading, and what happens depends on what it cannot reach.
  If it cannot hold the skin folder itself open, or reach `skin.css`, the board starts without a skin, and the footer says the skin folder could not be read.
  This is what happens when `/proc` is not available, as in a minimal container.
  The board can still open the skin folder, but without `/proc` it cannot reach the folder's contents through it, and on Linux it refuses to reach them any other way.
  If it cannot hold `fonts/` or `img/` open, for example because the board's account may not read it, the skin still loads without the files of that one folder, and the footer says one skin file could not be used and was skipped.
  A single file that cannot be reached is skipped in the same way.
  On every other system, such as Windows and macOS, the board checks the folder again after it opens each file.
  That stops ordinary mistakes and links that sit still, but it narrows the window for a swap and does not close it, and it is untested there.
  So on those systems a program that can write into your skin folder, and swaps a folder at exactly the right moment while the board starts, could get one file from outside the folder served.
  The practical answer is the same everywhere: keep the skin folder writable only by you, and readable by the board's account, as the modes in "Switching it on" give.
- The board serves skin files only from the list it made at start: `/skin/skin.css`, and one address for each font and image it loaded.
  Any other address under `/skin/` answers 404.
- Skin files sit behind the same checks as the board itself: the host check, your proxy's lock if you set one, and the sign-in header.
  Someone who cannot open the board cannot fetch a skin file either.
- A vector image (`.svg`) is served with a policy of its own.
  Its own inline styling works, and nothing else does.
  No script in it runs, it cannot load anything from outside, and it cannot send a form anywhere.
  When someone opens the file directly in the browser, it is also sandboxed.
  Used as an image, as a skin uses it, none of this limits it, because an image runs nothing anyway.
- The folder's path appears in no page, header or warning.

## Fonts

A skin may bring its own fonts as `.woff2` files and name them in `@font-face`, as in the example.
The board serves them itself and needs no theme setting for them.
A skin does not have to bring a font.
With no font file, leave out `fonts/` and any `@font-face`, and the board keeps its own fonts: the device's own by default, or Google's when the theme says `google`.

To make the board load no font from anywhere else, set the theme's `fonts.source` to `system`.
That is the default, and with it the board makes no outside request at all.
If your theme says `google`, the board also loads the three families from Google's font service, and your skin's fonts still work beside them.
For a board that must make no outside request, keep `fonts.source` at `system`.

## Caching

The skin's fonts and images may stay in the browser for up to an hour.
After you change a font or an image, a browser that has already fetched it may show the old file for up to an hour.
The skin stylesheet is never kept: the browser asks for it again on every page load.
So a changed stylesheet shows at once after the board restarts, and a changed font or image may take up to an hour.

If you want a changed font or image to show at once, save it under a new name and change the name in `skin.css`.

## What a skin cannot do

- It cannot run a script.
  The board's pages allow scripts only from the board itself, and a skin can offer none: only a stylesheet, fonts and images are served.
- It cannot change the page's markup or its words.
  A skin only styles what is there.
- It cannot add a page or an address.
  The board has its own fixed addresses, and a skin adds only its own files.
- It cannot load anything from another site.
  Stylesheets, fonts and scripts may come from the board only.
  Images may come from the board or be written in the stylesheet as `data:` addresses.
  Fonts must be files in `fonts/`.
- It cannot be read from outside the board's own machine except through the board, behind its sign-in.

## What a skin can rely on

These names are the stable surface of the page.
Every rebuild of the board's markup keeps them, so a skin that uses only these keeps working.
Names that are not in this list, such as a class inside a part not listed, may change.

### Sections

Every section's outer element carries `data-section` with its name, in this order on the page: `header`, `capture`, `brief`, `season`, `focus`, `timeline`, `calendar`, `inbox`, `next`, `habits`, `heatmap`, `projects`, `log`, `ideas`, `standalone`, `footer`.
Not every section is always on the page.
For example, `[data-section="focus"]` always exists, and `[data-section="calendar"]` only when the calendar is on.

The twelve sections `brief`, `season`, `focus`, `timeline`, `calendar`, `inbox`, `next`, `heatmap`, `projects`, `log`, `ideas` and `standalone` are frames: the outer element has the class `card` and holds one `div` with the class `card-f`.
`header`, `capture`, `habits` and `footer` are not frames.

### Data hooks

| Hook | What it marks |
| --- | --- |
| `data-src` | The small source tag on a card: `GH`, `NT` on a Notion board, `CAL`, `MAIL` or the agent's name. |
| `data-focus` | `true` on a focus project's chip, its timeline lane and its project row. |
| `data-stale` | `true` on a card whose data is an older saved copy. |
| `data-banner` | The strip in the header that says the board shows the last good read. |
| `data-message` | The small message that appears beside a control when an action fails. |
| `data-waiting` | A "waiting on" word on a project row, for a task that has open blockers. |
| `data-done` | `true` or `false` on a habit day. |
| `data-allday` | The line of all-day events above the calendar's hours. |
| `data-account` | The mailbox label on an inbox thread. |
| `data-colour` | The colour name of a mailbox, on its inbox tag. |
| `data-source` | The source word after a calendar event's title. |
| `data-filedate` | The line that says a calendar file's events are from an earlier date. |

### Theme variables

Your skin may read these and set them (starting the rule with `html[data-skin]`).

| Variable | What it is |
| --- | --- |
| `--ground` | The page's background. |
| `--dot` | A faint line colour, used on empty heat-map cells. |
| `--card` | The face of a part. |
| `--border` | Rules and seams. |
| `--ink` | The main text colour. |
| `--muted` | Labels and secondary text. |
| `--faint` | Placeholders and small print. |
| `--agent-bg` | The background of the agent frames, the brief and the log. |
| `--agent-ink` | The text colour on the agent frames. |
| `--accent` | The "live or current" colour, used as a fill, a rail or a small pad, never as text. |
| `--hot` | The warning colour. |
| `--hot-ink` | The error colour. |
| `--ok` | The "fine" colour. |
| `--on-accent` | The text colour on the accent. Set it yourself if your skin changes `--accent`, `--ground` or `--ink`. |
| `--radius` | The size of the corner cut. 0 gives square corners. |
| `--font-heading` | The font of headings and big numbers. |
| `--font-body` | The font of body text. |
| `--font-mono` | The font of small labels, times and counts. |

Four kinds of per-item class carry a value you can read:

- `pc-<key>` sets `--pc`, the colour of one project.
- `mode-<n>` sets `--mc`, the colour of one work mode.
- `x-<n>` sets `--x`, a position.
- `w-<n>` sets `--w`, a width.

### The parts in the page

This is the real markup of four parts, copied from a page the board drew, so that you can predict the nesting and know what to aim at.
Line breaks and indents are added here, and nothing else.

A key is a `button` with the class `b`, and an inner `span` with the class `b-f` that is its face.
The face holds the label and two small marks, `b-n` and `b-z`:

```html
<button type="submit" class="b pri">
  <span class="b-f">
    <span class="b-n"></span>
    <span class="b-z" aria-hidden="true"></span>
    Log idea
  </span>
</button>
```

A tag is one `span`, and its source name is in `data-src`:

```html
<span class="tag src" data-src="GH">GH</span>
```

A framed section is a `section` with the class `card` and the section's name in `data-section`.
It holds one `div` with the class `card-f`, and that holds the head and the body.
This is "What's next", with the rows of its list cut down to one row (the dots stand for the other four rows and for the controls of the row):

```html
<section class="card" data-section="next">
  <div class="card-f">
    <div class="card__head">
      <h2 class="card__title cap">What's next</h2>
      <span class="card__meta">
        <span class="tag src" data-src="GH">GH</span>
        <span class="card__note lab">5 seats</span>
      </span>
    </div>
    <ul class="ls ls--flow seats">
      <li class="ls-r seat pc-house">...</li>
      ...
    </ul>
  </div>
</section>
```

A list row is an `li` with the classes `ls-r` and `seat`, and the project's `pc-<key>` class.
This is one whole row of the same list:

```html
<li class="ls-r seat pc-house">
  <div class="seat__body">
    <a class="seat__title" href="https://github.com/sam-life/life/issues/12">Paint the hallway</a>
    <span class="seat__meta lab">
      <span>House</span>
      <span>Hallway</span>
      <span class="seat__due seat__due--overdue">overdue 3 days</span>
    </span>
  </div>
  <div class="seat__close">
    <form method="post" action="/actions/close">
      <input type="hidden" name="token" value="fixture">
      <input type="hidden" name="number" value="12">
      <button type="submit" class="ck">
        <span class="box" aria-hidden="true"><svg viewBox="0 0 30 30"><polyline points="8,15 13,20 22,10"/></svg></span>
        <span class="sr-only">Close</span>
      </button>
    </form>
  </div>
</li>
```

A rule such as `html[data-skin] .b-f` styles the face of every key, and `html[data-skin] [data-section="next"] .seat__title` styles only the titles in "What's next".
The cut corners are drawn on the frames and faces, so aim a background at the inner part (`card-f`, `b-f`) rather than at the outer one.

### Part classes

These are the parts, with one line on each.

**Page and frames**

| Class | What it is |
| --- | --- |
| `page` | The page's wrapper. |
| `row`, `row-brief`, `row-focus`, `row-trio`, `row-low`, `row-ideas` | The rows that lay the sections out. |
| `card` | A section frame. |
| `card-f` | The face inside a frame, where its content sits. |
| `card--agent` | A frame written by an agent: the brief and the log. |
| `card--wide` | A frame that takes the full width. |
| `card__head`, `card__title`, `card__meta`, `card__note`, `card__label` | The parts of a frame's head. |
| `section-head` | A heading inside a section. |
| `header`, `header__main`, `header__date`, `header__title` | The page header, its date line and its greeting. |
| `hl` | The highlight on the name in the greeting. |
| `sources` | The row of source chips in the header. |
| `capture` | The "Log an idea" box. |
| `footer`, `footer__time`, `warnings` | The footer, the time of the data and the list of warnings. |
| `notice` | The page for a refusal or a failure. |
| `sr-only` | Text that only a screen reader reads. |

**Small parts**

| Class | What it is |
| --- | --- |
| `lab` | A small label. |
| `cap` | A small capital heading. |
| `tag`, `tag--line`, `tag--acc` | A small tag. |
| `bdg`, `bdg--stale` | A small badge. |
| `pad`, `ok`, `warn`, `err`, `info`, `off` | A small status square, in the colour of its state. |
| `rail` | A thin coloured edge. |
| `fix`, `fix--tl`, `fix--tr`, `fix--bl`, `fix--br` | A small mark in one corner of an empty-state block. |
| `ch` | A part with a cut corner. |
| `swatch` | A small square of a project's colour. |
| `chip`, `chip__label`, `chip__name`, `chip__state` | A chip: a source in the header, or a focus project. |
| `bar`, `bar--thin` | A progress bar. |
| `bn`, `bn--m`, `bn--s` | A big number. |
| `meta` | A line of small facts. |
| `emp`, `emp--block` | An empty state. |
| `al`, `al-t` | An alert strip and its text. |
| `banner`, `banner__title` | The strip that says the board shows the last good read. |

**Controls**

| Class | What it is |
| --- | --- |
| `b`, `b-f`, `b-n`, `b-z` | A key (a button) and its face, label and size. |
| `sm`, `pri` | A small key and a main key. |
| `sel`, `sel--s` | A drop-down list. |
| `box`, `ck` | A tick box and its hit area. |
| `ac`, `ac-i`, `ac-m`, `ac-p` | A fold-out: the whole, its opening line, the mark on it and its panel. |
| `fx`, `floor` | The text field of the "Log an idea" box, and the line that grows under it when you type. |
| `score-form` | The form for scoring a habit. |
| `sort`, `sort__form` | The fold-out that sorts an idea into a project, and its form. |
| `sg` | The strip that holds the inbox counts. |
| `ls`, `ls--flow`, `ls-r` | A list, a list that flows, and one row of a list. |
| `gh` | The head line of a group of rows. |

**Brief, focus and season**

| Class | What it is |
| --- | --- |
| `brief__lines`, `brief__line`, `brief__tag`, `brief__text` | The brief's lines, each with its tag and text. |
| `season__big`, `season__days`, `season__label` | The season's big number, its days and its label. |
| `goals`, `goal`, `goal__row`, `goal__title`, `goal__pct` | The season's goals. |
| `focus__chips`, `focus__proposal`, `focus__why` | The focus chips, a proposal for focus and its reason. |

**Timeline**

| Class | What it is |
| --- | --- |
| `tl-wrap` | The timeline's wrapper. |
| `tl-row`, `tl-name`, `tl-plot`, `tl-track` | One project's row, its name, its plot and its track. |
| `tl-lane`, `tl-lane--other` | A project's lane. |
| `tl-dot`, `tl-dot--open`, `tl-dot--overdue`, `tl-dot--done`, `tl-dot__label` | A milestone dot, its states and its label. |
| `tl-today`, `tl-today__label` | The mark for today, and its label. |
| `tl-axis`, `tl-sub`, `tl-note`, `tl-undated`, `tl-legend` | The axis, its sub-line, a note, the undated list and the legend. |

**Calendar**

| Class | What it is |
| --- | --- |
| `cal-day` | The day's hours and its events. |
| `cal-hours`, `cal-body` | The column of hours and the area for the events. |
| `cal-event__title`, `cal-event__time` | An event's title and its time. |
| `cal-event`, `cal-event--meeting`, `cal-event--focus`, `cal-event--personal`, `cal-event--habit`, `cal-event--short` | One calendar event, and its kind. |
| `cal-now` | The mark for the time now. |
| `cal-allday`, `cal-allday-label` | The line of all-day events and its label. |
| `cal-source`, `cal-filedate` | The source word and the file-date line. |

**Inbox**

| Class | What it is |
| --- | --- |
| `counts`, `count`, `count__n`, `count--reply` | The counts at the top of the inbox. |
| `inbox__group`, `group-title` | A group of threads (reply, decide, for your information) and its title. |
| `thread`, `thread__from`, `thread__subject`, `thread__foot`, `thread__account`, `thread__why` | A thread and its parts. |

**What's next**

| Class | What it is |
| --- | --- |
| `seats`, `seat` | The list of next tasks, and one task. |
| `seat__body`, `seat__line`, `seat__title`, `seat__meta`, `seat__due`, `seat__due--overdue`, `seat__close` | The parts of one task. |
| `mode-chip` | The chip that shows a task's work mode. |

**Habits**

| Class | What it is |
| --- | --- |
| `habit-section` | The wrapper of the habit tiles. |
| `habit-grid`, `habit` | The grid of tiles, and one tile. |
| `habit__top`, `habit__name`, `habit__mid`, `habit__streak`, `habit__n`, `habit__unit`, `habit__foot` | The parts of one tile. |
| `flames`, `flame`, `flame--lit` | A habit's row of five flames, which shows its streak, and one flame, lit or not. |
| `days`, `day` | The row of days of a habit, and one day. |
| `day--done`, `day--missed`, `day--pending`, `day--before`, `day--token`, `day--s1` to `day--s4` | The state of a day: done, missed, not yet, before the habit began, a saved day used, or a score band from 1 to 4. |

**Heat map, projects, log, ideas and standalone**

| Class | What it is |
| --- | --- |
| `heat`, `heat__week`, `heat__cell`, `heat__legend` | The heat map, a week of it, a cell and the legend. |
| `heat__cell--l0` to `heat__cell--l4`, `heat__cell--none` | The levels of a cell. |
| `projects`, `project`, `project__head`, `project__title`, `project__count`, `project__stats`, `project__habits` | The project list, one row and its parts. |
| `stat--hot` | A figure that needs attention. |
| `log`, `log__item`, `log__t`, `log__body`, `log__agent` | The agent log and its items. |
| `ideas`, `idea`, `idea__top`, `idea__title`, `idea__date`, `idea__actions` | The ideas list and one idea. |
| `suggestion`, `suggestion__text`, `suggestion__why` | An agent's suggestion for an idea. |
| `standalone`, `solo`, `solo__top`, `solo__title`, `solo__close` | The standalone tasks and one of them. |

## Troubleshooting

**The board looks the same as before.**
You have not started the board again since the change; start it again.
Or `BOARD_SKIN_DIR` is not set in the terminal or the unit that starts the board.
Check by viewing the page's source: with a skin loaded it has `<link rel="stylesheet" href="/skin/skin.css">` and `<html lang="en" data-skin>`.
Without a skin, neither is there.

**The footer says the skin folder could not be read.**
See "When the skin is bad".
On a hardened unit, the usual cause is a folder under your home, `/opt`, `/srv` or `/mnt`: move it to `/etc/board/skin`.
On Linux in a container, it can also mean that `/proc` is not mounted for the board.

**The footer says some skin files could not be used.**
Check every file in `fonts/` and `img/` against the limits table and the name rules.

**My colours or fonts do nothing.**
You probably set the variable on `:root`, which the board's own block overrides every time.
Set it on `html[data-skin]` instead.
For a rule on a part, check that its selector starts with `html[data-skin]` and that the class is spelled as in the reference.

**The text on the accent is hard to read.**
Set `--on-accent` in your skin.

**My font does not show.**
Check that the file is a `.woff2`, that its name follows the rules, that the footer does not say it was skipped, and that the `url()` in `@font-face` is relative to `skin.css`, with no leading slash.
Then check that a rule uses the family name you gave in `@font-face`.

**My image does not show.**
Check the extension (`.png`, `.svg`, `.webp` or `.jpg`), the name and the size, and that the `url()` is relative to `skin.css`.
An image from another site is refused by design.

**I changed a font or an image and the old one shows.**
The browser keeps skin fonts and images for up to an hour.
Save the file under a new name and change the name in `skin.css`.

**`/skin/skin.css` answers 404.**
No skin was loaded.
Look for the footer warning, and check the setting.

**`/skin/skin.css` answers 401 or 421.**
The board is behind a login proxy.
Open the address in a browser through the proxy, signed in, with the name you set in `BOARD_ALLOWED_HOSTS`.

**I want the board to make no outside request.**
Set the theme's `fonts.source` to `system`, and use only fonts and images from your skin folder.
