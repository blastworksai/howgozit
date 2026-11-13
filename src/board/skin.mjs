// Skin loader (R165 to R169). Reads one private folder ONCE into memory and returns the fixed list the server serves.
// INVARIANT: on Linux no child is ever opened through a path resolved from the top; a Linux system without a usable /proc
// gets no skin (a Linux container without /proc mounted cannot use skins at all: accepted, it fails closed).
// The folder's content is not trusted: a link is never followed, a pipe never waited on, a file never read without
// bound, and no path is built from anything but the folder plus a listed name that already passed the name pattern.
// Never throws, never blocks, never puts the folder's path into a warning.
import fs from 'node:fs';
import path from 'node:path';

const KB = 1024;
const MAX_CSS = 256 * KB;
const MAX_TOTAL = 3 * 1024 * KB;
const MAX_ENTRIES = 64;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}\.[a-z0-9]+$/;

const PARTS = {
  fonts: { max: 300 * KB, count: 6, kind: 'font', types: { woff2: 'font/woff2' } },
  img: { max: 500 * KB, count: 12, kind: 'img', types: { png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp', jpg: 'image/jpeg' } },
};

// Windows has no O_NOFOLLOW: there the open falls back to a device-and-inode comparison (R167).
// That fallback is UNVERIFIED on Windows; it is written from the contract and never run there.
const HAS_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number';
// O_NONBLOCK keeps the open of a named pipe from waiting for a writer, so a pipe cannot hold the start.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
// A folder is opened as a folder, never through a link (O_NOFOLLOW) and never as anything else (O_DIRECTORY).
const DIR_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0);

// THE ROUTE IS CHOSEN HERE, BY A FACT THAT CANNOT FAIL AT RUN TIME: the platform and two constants, computed at load with
// no I/O. On Linux the handle route is mandatory: nothing is probed, and anything in it that does not work (no handle for
// the folder, no usable /proc, EMFILE, EACCES, any exception) is a refusal by the rules of R167/R168, never a path read.
// The path route below is code reached only when this is false.
const HANDLE_ROUTE = process.platform === 'linux' && typeof fs.constants.O_DIRECTORY === 'number' && HAS_NOFOLLOW;

const lstatBig = (p) => fs.lstatSync(p, { bigint: true });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Opens a folder as a folder handle and requires it to be the very folder that lstat just showed (a swap between the two
// is refused). Returns the handle or null. Used by the handle route only.
function openFolderHandle(target, lst) {
  let fd = null;
  try {
    fd = fs.openSync(target, DIR_FLAGS);
    const st = fs.fstatSync(fd, { bigint: true });
    if (st.isDirectory() && sameFile(st, lst)) return fd;
  } catch { /* refused: not a folder, or a link, or no descriptor to spare */ }
  if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
  return null;
}

// True when the open handle's own /proc entry can be opened as a folder. Handle route only.
function procEntryOpens(base) {
  let h = null;
  try {
    h = fs.openSync(base, DIR_FLAGS & ~fs.constants.O_NOFOLLOW); // the entry is itself a link to the folder
    return fs.fstatSync(h).isDirectory();
  } catch {
    return false;
  } finally {
    if (h !== null) { try { fs.closeSync(h); } catch { /* nothing to do */ } }
  }
}

// HANDLE ROUTE, one child. `file` is always `/proc/self/fd/<folder handle>/<name>`: the name is looked up in the folder
// that was checked and is held open, whatever the folder's own name becomes later (DIRECTORY SWAP: O_NOFOLLOW protects
// only the LAST part of a path, so re-opening `<skin>/img/x.png` by path would follow a swapped parent link).
// Every decision comes from the open child handle, never from anything looked at before the open.
function readHandleChild(file, limit, budget) {
  let fd = null;
  try {
    fd = fs.openSync(file, OPEN_FLAGS); // a link is refused (ELOOP) and a pipe opens without waiting
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null; // pipe, device, folder: not a regular file
    return readOpen(fd, st, limit, budget);
  } catch {
    return null; // an error on one file skips that file only
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
  }
}

// PATH ROUTE, one child (only where HANDLE_ROUTE is false). Same reading, plus the guard of makePathGuard.
function readPathChild(file, limit, budget, guard) {
  let fd = null;
  try {
    let before = null;
    if (!HAS_NOFOLLOW) {
      before = lstatBig(file);
      if (!before.isFile()) return null;
    }
    fd = fs.openSync(file, OPEN_FLAGS);
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    if (before && !sameFile(before, st)) return null; // swapped during the open
    if (!guard(st, file)) return null;
    return readOpen(fd, st, limit, budget);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to do */ } }
  }
}

// The bounded read from an open regular file (both routes). Returns a copy of the bytes or null.
function readOpen(fd, st, limit, budget) {
  if (st.size > BigInt(limit) || st.size > BigInt(budget)) return null;
  // Read at most limit + 1 bytes: a file that grows past its cap is seen as over, never read without bound.
  const buf = Buffer.allocUnsafe(limit + 1);
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, null);
    if (n === 0) break;
    got += n;
  }
  if (got > limit || BigInt(got) !== st.size) return null; // grew, shrank or was swapped while read
  if (got > budget) return null;
  return Buffer.from(buf.subarray(0, got)); // own copy, so nothing is re-read later
}

// The first 64 entries the system lists (R166). Reads entry by entry so a huge folder is never listed whole.
// Returns { names, cut } or null when the folder cannot be listed.
function listFolder(base) {
  let dh = null;
  try {
    dh = fs.opendirSync(base);
    const names = [];
    let cut = false;
    for (;;) {
      const ent = dh.readSync();
      if (ent === null) break;
      if (names.length >= MAX_ENTRIES) { cut = true; break; }
      names.push(ent.name);
    }
    return { names, cut };
  } catch {
    return null;
  } finally {
    if (dh) { try { dh.closeSync(); } catch { /* nothing to do */ } }
  }
}

// A real folder (a link to one is not one, R167). 'absent' is told apart from 'bad' because only 'bad' is counted.
function folderState(dir) {
  try {
    const st = lstatBig(dir);
    return st.isDirectory() ? { state: 'ok', st } : { state: 'bad' };
  } catch (e) {
    return { state: e && e.code === 'ENOENT' ? 'absent' : 'bad' };
  }
}

function none(unreadable) {
  return { loaded: false, files: new Map(), hasFonts: false, warnings: unreadable ? [{ code: 'skin-unreadable', count: 1 }] : [] };
}

// What both routes share and neither can change: which listed names are candidates, their order, the counts, the limits.
// `readChild(name, limit, budget)` is the route's own reader. Returns the number of skipped files.
function collect(name, part, listed, readChild, budget, out) {
  let skipped = listed.cut ? 1 : 0;
  const candidates = [];
  for (const entry of listed.names) {
    if (entry.startsWith('.')) continue; // dot names are ignored without a warning
    const ext = entry.slice(entry.lastIndexOf('.') + 1);
    if (!NAME_RE.test(entry) || !Object.hasOwn(part.types, ext)) { skipped += 1; continue; }
    candidates.push(entry);
  }
  candidates.sort(); // default order is by UTF-16 code unit, as R166 says

  let served = 0;
  for (const entry of candidates) {
    if (served >= part.count) { skipped += 1; continue; } // a seventh font or a thirteenth image
    const body = readChild(entry, part.max, budget.left);
    if (!body) { skipped += 1; continue; }
    budget.left -= body.length;
    const ext = entry.slice(entry.lastIndexOf('.') + 1);
    out.set(`/skin/${name}/${entry}`, { type: part.types[ext], body, kind: part.kind });
    served += 1;
  }
  return skipped;
}

function finish(files, skipped) {
  const hasFonts = [...files.values()].some((f) => f.kind === 'font');
  return { loaded: true, files, hasFonts, warnings: skipped > 0 ? [{ code: 'skin-file-skipped', count: skipped }] : [] };
}

function addCss(files, budget, css) {
  budget.left -= css.length;
  files.set('/skin/skin.css', { type: 'text/css; charset=utf-8', body: css, kind: 'css' });
}

// ===================================================== HANDLE ROUTE (Linux)
// The skin folder is opened once as a folder and held open; `fonts/` and `img/` are opened through its handle and held
// open while their files are read; every child is reached as `/proc/self/fd/<handle>/<name>`. The first handle taken is
// the skin folder's own. Every handle is closed on every path.
function loadPartByHandle(topBase, name, part, budget, out) {
  const target = path.join(topBase, name);
  const g = folderState(target);
  if (g.state === 'absent') return 0;
  if (g.state === 'bad') return 1;
  const fd = openFolderHandle(target, g.st);
  if (fd === null) return 1; // not openable as the real folder lstat showed: skipped and counted, never read by path
  try {
    const base = `/proc/self/fd/${fd}`;
    const listed = listFolder(base);
    if (!listed) return 1;
    return collect(name, part, listed, (entry, limit, left) => readHandleChild(path.join(base, entry), limit, left), budget, out);
  } finally {
    try { fs.closeSync(fd); } catch { /* nothing to do */ }
  }
}

function loadViaHandles(root) {
  let top = null;
  try {
    const g = folderState(root);
    if (g.state !== 'ok') return none(true);
    top = openFolderHandle(root, g.st);
    if (top === null) return none(true);
    const base = `/proc/self/fd/${top}`;
    // Is the handle's /proc entry usable? Asked once, by opening it. This never SELECTS a route (there is only one on
    // Linux): a failure is a refusal, so no child is even tried.
    if (!procEntryOpens(base)) return none(true);
    const listed = listFolder(base); // fails when /proc is not usable: then there is no skin
    if (!listed) return none(true);

    const budget = { left: MAX_TOTAL };
    const files = new Map();
    // skin.css is required and is counted first. It is only found if it is among the first 64 entries.
    if (!listed.names.includes('skin.css')) return none(true);
    const css = readHandleChild(path.join(base, 'skin.css'), MAX_CSS, budget.left);
    if (!css) return none(true);
    addCss(files, budget, css);

    let skipped = listed.cut ? 1 : 0;
    // Fonts before images, so the 3 MB total is counted in the order R166 gives.
    if (listed.names.includes('fonts')) skipped += loadPartByHandle(base, 'fonts', PARTS.fonts, budget, files);
    if (listed.names.includes('img')) skipped += loadPartByHandle(base, 'img', PARTS.img, budget, files);
    return finish(files, skipped);
  } catch {
    return none(true);
  } finally {
    if (top !== null) { try { fs.closeSync(top); } catch { /* nothing to do */ } }
  }
}

// ===================================================== PATH ROUTE (not Linux: macOS, Windows)
// Reached ONLY when HANDLE_ROUTE is false. A child can only be opened by its path again, so the parent-link swap cannot
// be closed here. This narrows the window and does NOT close it, and it is UNTESTED on those platforms. After the child
// is open: the folder's path must still lstat to the same device and inode and not be a link, the child must be on the
// folder's device, and the child's real path must lie inside the real skin folder taken at the start; otherwise the
// file is skipped.
// RESIDUAL RACE, accepted and disclosed: swapping a folder for an outside folder on the SAME device for the instant of a
// child open, and restoring it before the guard runs, passes every one of these checks while the descriptor that was
// opened outside survives and is read. Nobody should believe this route is closed.
// Root-aware containment: the child is inside when the relative path from the folder to it is non-empty, does not climb
// out (`..` as a whole first part) and is not absolute (another drive). No string-prefix arithmetic, so a skin at `/` or
// `D:\` works.
function isInside(rootReal, childReal, pathMod = path) {
  const rel = pathMod.relative(rootReal, childReal);
  if (rel === '' || pathMod.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + pathMod.sep);
}

function makePathGuard(folder, rootReal) {
  return (st, file) => {
    try {
      const now = lstatBig(folder.path);
      if (!now.isDirectory() || !sameFile(now, folder.st)) return false;
      if (st.dev !== folder.st.dev) return false;
      return isInside(rootReal, fs.realpathSync(file));
    } catch {
      return false;
    }
  };
}

// List a folder by path and check it is still the same real folder afterwards.
function listByPath(folder) {
  const listed = listFolder(folder.path);
  if (!listed) return null;
  const after = folderState(folder.path);
  if (after.state !== 'ok' || !sameFile(folder.st, after.st)) return null;
  return listed;
}

function loadPartByPath(rootPath, name, part, budget, out, rootReal) {
  const plain = path.join(rootPath, name);
  const g = folderState(plain);
  if (g.state === 'absent') return 0;
  if (g.state === 'bad') return 1;
  const folder = { path: plain, st: g.st };
  const guard = makePathGuard(folder, rootReal);
  const listed = listByPath(folder);
  if (!listed) return 1;
  return collect(name, part, listed, (entry, limit, left) => readPathChild(path.join(plain, entry), limit, left, guard), budget, out);
}

function loadViaPaths(root) {
  try {
    const g = folderState(root);
    if (g.state !== 'ok') return none(true);
    let rootReal;
    try { rootReal = fs.realpathSync(root); } catch { return none(true); }
    const top = { path: root, st: g.st };
    const guard = makePathGuard(top, rootReal);
    const listed = listByPath(top);
    if (!listed) return none(true);

    const budget = { left: MAX_TOTAL };
    const files = new Map();
    if (!listed.names.includes('skin.css')) return none(true);
    const css = readPathChild(path.join(root, 'skin.css'), MAX_CSS, budget.left, guard);
    if (!css) return none(true);
    addCss(files, budget, css);

    let skipped = listed.cut ? 1 : 0;
    if (listed.names.includes('fonts')) skipped += loadPartByPath(root, 'fonts', PARTS.fonts, budget, files, rootReal);
    if (listed.names.includes('img')) skipped += loadPartByPath(root, 'img', PARTS.img, budget, files, rootReal);
    return finish(files, skipped);
  } catch {
    return none(true);
  }
}

export function loadSkin(dir) {
  try {
    if (typeof dir !== 'string' || dir.trim() === '') return none(false);
    const root = dir.trim();
    return HANDLE_ROUTE ? loadViaHandles(root) : loadViaPaths(root);
  } catch {
    return none(true);
  }
}
