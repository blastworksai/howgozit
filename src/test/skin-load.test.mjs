// R165 to R169, the loader half: loadSkin(dir) reads a skin folder once, safely, into memory.
// API under test (board/skin.mjs): loadSkin(dir) is synchronous, never throws, never blocks and returns
//   { loaded, files: Map<urlPath, { type, body: Buffer, kind: 'css' | 'font' | 'img' }>, hasFonts,
//     warnings: [{ code: 'skin-file-skipped' | 'skin-unreadable', count }] }
// Every folder this file makes is created under os.tmpdir() with mkdtempSync and removed in after().
// "Growing while read" and "swapped after the check" cannot be made to happen from outside, so two kinds
// of proof stand in: a stand-in for fstatSync (the handle reports a size the bytes do not match), and
// source-text checks of the safe-reading structure R167 demands.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { loadSkin } from '../board/skin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const SKIN_SOURCE = path.join(SRC, 'board', 'skin.mjs');
const FIXTURE_SKIN = path.join(SRC, 'fixtures', 'skin');

const KB = 1024;
const CSS_CAP = 256 * KB; // 262,144
const FONT_CAP = 300 * KB; // 307,200
const IMG_CAP = 500 * KB; // 512,000
const TOTAL_CAP = 3 * 1024 * 1024; // 3,145,728

const GOOD_CSS = 'html[data-skin] { --accent: #336699; }\n';
const SENTINEL = 'SENTINEL-OUTSIDE-FILE-4f9c1e';
const TIMEOUT = { timeout: 15000 };

// ---------------------------------------------------------------- temp folders

const made = [];
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-'));
  made.push(root);
  return root;
}
after(() => {
  for (const root of made) {
    try {
      restorePerms(root);
    } catch {
      /* best effort */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function restorePerms(dir) {
  let entries;
  try {
    fs.chmodSync(dir, 0o755);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) restorePerms(full);
    else if (e.isFile()) {
      try {
        fs.chmodSync(full, 0o644);
      } catch {
        /* ignore */
      }
    }
  }
}

// A fixture: root/skin is the skin folder (with a good skin.css unless told otherwise); root/outside
// holds things links can point at. write('fonts/a.woff2', bytes) creates parents.
function fixture({ css = GOOD_CSS } = {}) {
  const root = mkRoot();
  const dir = path.join(root, 'skin');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  if (css !== null) fs.writeFileSync(path.join(dir, 'skin.css'), css);
  const f = {
    root,
    dir,
    outside,
    write(rel, content = 'x') {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return full;
    },
    mkdir(rel) {
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
    },
    link(rel, target, type) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.symlinkSync(target, full, type);
      return full;
    },
  };
  return f;
}

const bytesOf = (n, fill = 0x61) => Buffer.alloc(n, fill);

// ---------------------------------------------------------------- assertions

function skipped(r) {
  return r.warnings.filter((w) => w.code === 'skin-file-skipped').reduce((a, w) => a + w.count, 0);
}
function unreadable(r) {
  return r.warnings.filter((w) => w.code === 'skin-unreadable').reduce((a, w) => a + w.count, 0);
}
function names(r, folder) {
  return [...r.files.keys()].filter((k) => k.startsWith('/skin/' + folder + '/')).map((k) => k.slice(('/skin/' + folder + '/').length)).sort();
}
function assertShape(r) {
  assert.equal(typeof r.loaded, 'boolean');
  assert.ok(r.files instanceof Map);
  assert.equal(typeof r.hasFonts, 'boolean');
  assert.ok(Array.isArray(r.warnings));
  for (const w of r.warnings) {
    assert.ok(w.code === 'skin-file-skipped' || w.code === 'skin-unreadable', 'warning code ' + w.code);
    assert.ok(Number.isInteger(w.count) && w.count >= 1, 'warning count ' + w.count);
  }
  for (const [k, v] of r.files) {
    assert.ok(k.startsWith('/skin/'), k);
    assert.equal(typeof v.type, 'string');
    assert.ok(Buffer.isBuffer(v.body));
    assert.ok(['css', 'font', 'img'].includes(v.kind));
  }
}
function assertNoSkin(r, why) {
  assertShape(r);
  assert.equal(r.loaded, false, why);
  assert.equal(r.files.size, 0, why);
  assert.equal(r.hasFonts, false, why);
}
function assertUnusable(r, why) {
  assertNoSkin(r, why);
  assert.equal(unreadable(r), 1, why + ': skin-unreadable at 1');
}
function assertServed(r, key, type, body, kind) {
  const v = r.files.get(key);
  assert.ok(v, 'served: ' + key);
  assert.equal(v.type, type, key);
  assert.equal(v.kind, kind, key);
  assert.ok(Buffer.isBuffer(v.body));
  assert.ok(v.body.equals(Buffer.isBuffer(body) ? body : Buffer.from(body)), 'bytes of ' + key);
}
function assertNoSentinel(r) {
  for (const v of r.files.values()) assert.ok(!v.body.includes(SENTINEL), 'sentinel reached the map');
}
function timed(fn) {
  const t0 = Date.now();
  const r = fn();
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, 'the load took ' + ms + ' ms, expected under 1000');
  return r;
}

const mkfifoProbe = spawnSync('mkfifo', ['--help']);
const MKFIFO_SKIP = mkfifoProbe.error ? 'mkfifo is not available on this platform' : false;
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const ROOT_SKIP = IS_ROOT ? 'running as root: file permissions do not stop root from reading' : false;
const mkfifo = (p) => execFileSync('mkfifo', [p]);

// ================================================================ R165: no setting, no skin

test('R165 an unset folder (undefined, null, empty string) means no skin: nothing loaded, no warning', TIMEOUT, () => {
  for (const v of [undefined, null, '']) {
    const r = loadSkin(v);
    assertNoSkin(r, JSON.stringify(v));
    assert.deepEqual(r.warnings, []);
  }
  assert.deepEqual(loadSkin().warnings, []);
});

test('R165 loadSkin takes no setting from the environment: with BOARD_SKIN_DIR set, an unset argument is still no skin', TIMEOUT, () => {
  const f = fixture();
  const before = process.env.BOARD_SKIN_DIR;
  process.env.BOARD_SKIN_DIR = f.dir;
  try {
    const r = loadSkin(undefined);
    assertNoSkin(r, 'env');
    assert.deepEqual(r.warnings, []);
  } finally {
    if (before === undefined) delete process.env.BOARD_SKIN_DIR;
    else process.env.BOARD_SKIN_DIR = before;
  }
});

test('R165 a relative folder is read from the folder the process was started in', TIMEOUT, () => {
  const f = fixture();
  const cwd = process.cwd();
  try {
    process.chdir(f.root);
    const r = loadSkin('skin');
    assert.equal(r.loaded, true);
    assertServed(r, '/skin/skin.css', 'text/css; charset=utf-8', GOOD_CSS, 'css');
  } finally {
    process.chdir(cwd);
  }
});

test('R165 the folder is read once: files changed or removed after the load do not change the loaded map, a new load sees them', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/a.woff2', 'font-one');
  f.write('img/a.png', 'img-one');
  const r1 = loadSkin(f.dir);
  assert.equal(r1.loaded, true);
  fs.writeFileSync(path.join(f.dir, 'skin.css'), 'html[data-skin] { color: red; }');
  fs.rmSync(path.join(f.dir, 'fonts', 'a.woff2'));
  fs.writeFileSync(path.join(f.dir, 'img', 'b.png'), 'new-image');
  assertServed(r1, '/skin/skin.css', 'text/css; charset=utf-8', GOOD_CSS, 'css');
  assertServed(r1, '/skin/fonts/a.woff2', 'font/woff2', 'font-one', 'font');
  assert.equal(r1.files.has('/skin/img/b.png'), false);
  const r2 = loadSkin(f.dir);
  assertServed(r2, '/skin/skin.css', 'text/css; charset=utf-8', 'html[data-skin] { color: red; }', 'css');
  assert.equal(r2.files.has('/skin/fonts/a.woff2'), false);
  assert.equal(r2.files.has('/skin/img/b.png'), true);
});

test('R165 the returned buffers are copies: changing a returned buffer changes neither the file nor a later load', TIMEOUT, () => {
  const f = fixture();
  const r1 = loadSkin(f.dir);
  r1.files.get('/skin/skin.css').body.fill(0x7a);
  assert.equal(fs.readFileSync(path.join(f.dir, 'skin.css'), 'utf8'), GOOD_CSS);
  const r2 = loadSkin(f.dir);
  assertServed(r2, '/skin/skin.css', 'text/css; charset=utf-8', GOOD_CSS, 'css');
  assert.notEqual(r1.files, r2.files);
});

test('R165 the folder path appears in no warning', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/Bad Name.woff2');
  f.write('img/a.gif');
  const r = loadSkin(f.dir);
  assert.equal(skipped(r), 2);
  assert.ok(!JSON.stringify(r.warnings).includes(f.root));
  const missing = loadSkin(path.join(f.root, 'does-not-exist'));
  assert.ok(!JSON.stringify(missing.warnings).includes(f.root));
});

test('R165 loadSkin never throws on junk input: numbers, objects, arrays, booleans, symbols, odd and very long strings', TIMEOUT, () => {
  const junk = [42, 0, NaN, {}, { toString() { throw new Error('boom'); } }, [], ['a'], true, false, Symbol('s'), 10n, () => 1, 'x'.repeat(200000), 'a\0b', '\0', ' ', '   ', '..', '/', path.join(os.tmpdir(), 'skin-does-not-exist-' + 'z'.repeat(300))];
  for (const v of junk) {
    let r;
    assert.doesNotThrow(() => {
      r = timed(() => loadSkin(v));
    }, 'junk ' + String(typeof v));
    assertShape(r);
    assert.equal(r.loaded, false, 'junk is not a skin: ' + typeof v);
    assert.equal(r.files.size, 0);
  }
});

test('R165 loadSkin is synchronous: the result is a plain object, not a promise', TIMEOUT, () => {
  const r = loadSkin(undefined);
  assert.equal(typeof r.then, 'undefined');
  assert.ok(!(r instanceof Promise));
});

// ================================================================ the neutral test skin (R174's loader half)

test('R174 the neutral test skin loads with zero warnings, four files, and has fonts', TIMEOUT, () => {
  const r = loadSkin(FIXTURE_SKIN);
  assertShape(r);
  assert.equal(r.loaded, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.hasFonts, true);
  assert.deepEqual([...r.files.keys()].sort(), ['/skin/fonts/neutral.woff2', '/skin/img/neutral.png', '/skin/img/neutral.svg', '/skin/skin.css']);
  assertServed(r, '/skin/skin.css', 'text/css; charset=utf-8', fs.readFileSync(path.join(FIXTURE_SKIN, 'skin.css')), 'css');
  assertServed(r, '/skin/fonts/neutral.woff2', 'font/woff2', fs.readFileSync(path.join(FIXTURE_SKIN, 'fonts', 'neutral.woff2')), 'font');
  assertServed(r, '/skin/img/neutral.png', 'image/png', fs.readFileSync(path.join(FIXTURE_SKIN, 'img', 'neutral.png')), 'img');
  assertServed(r, '/skin/img/neutral.svg', 'image/svg+xml', fs.readFileSync(path.join(FIXTURE_SKIN, 'img', 'neutral.svg')), 'img');
});

// ================================================================ R166: the shape and the exact limits

test('R166 a good skin.css, two fonts and two images: all five served, right keys, types, kinds and bytes, no warning', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/one.woff2', 'wOF2-one');
  f.write('fonts/two.woff2', 'wOF2-two');
  f.write('img/a.png', 'png-bytes');
  f.write('img/b.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const r = loadSkin(f.dir);
  assertShape(r);
  assert.equal(r.loaded, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.hasFonts, true);
  assert.equal(r.files.size, 5);
  assertServed(r, '/skin/skin.css', 'text/css; charset=utf-8', GOOD_CSS, 'css');
  assertServed(r, '/skin/fonts/one.woff2', 'font/woff2', 'wOF2-one', 'font');
  assertServed(r, '/skin/fonts/two.woff2', 'font/woff2', 'wOF2-two', 'font');
  assertServed(r, '/skin/img/a.png', 'image/png', 'png-bytes', 'img');
  assertServed(r, '/skin/img/b.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'img');
});

test('R169 each image extension gets its content type: png, svg, webp, jpg; woff2 is font/woff2; skin.css is text/css; charset=utf-8', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/f.woff2', 'f');
  f.write('img/a.png', 'a');
  f.write('img/b.svg', 'b');
  f.write('img/c.webp', 'c');
  f.write('img/d.jpg', 'd');
  const r = loadSkin(f.dir);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.files.get('/skin/skin.css').type, 'text/css; charset=utf-8');
  assert.equal(r.files.get('/skin/fonts/f.woff2').type, 'font/woff2');
  assert.equal(r.files.get('/skin/img/a.png').type, 'image/png');
  assert.equal(r.files.get('/skin/img/b.svg').type, 'image/svg+xml');
  assert.equal(r.files.get('/skin/img/c.webp').type, 'image/webp');
  assert.equal(r.files.get('/skin/img/d.jpg').type, 'image/jpeg');
  for (const k of ['/skin/img/a.png', '/skin/img/b.svg', '/skin/img/c.webp', '/skin/img/d.jpg']) assert.equal(r.files.get(k).kind, 'img');
});

test('R169 each served body is exactly the bytes of the file, including bytes that are not text', TIMEOUT, () => {
  const f = fixture();
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  f.write('fonts/f.woff2', all);
  f.write('img/a.png', Buffer.concat([all, all]));
  const r = loadSkin(f.dir);
  assertServed(r, '/skin/fonts/f.woff2', 'font/woff2', all, 'font');
  assertServed(r, '/skin/img/a.png', 'image/png', Buffer.concat([all, all]), 'img');
});

test('R166 skin.css of exactly 262,144 bytes is served; 262,145 is no skin with skin-unreadable', TIMEOUT, () => {
  const exact = fixture({ css: bytesOf(CSS_CAP) });
  const r1 = loadSkin(exact.dir);
  assert.equal(r1.loaded, true);
  assert.equal(r1.files.get('/skin/skin.css').body.length, CSS_CAP);
  assert.deepEqual(r1.warnings, []);
  const over = fixture({ css: bytesOf(CSS_CAP + 1) });
  assertUnusable(loadSkin(over.dir), 'css one byte over');
});

test('R166 a font of exactly 307,200 bytes is served; 307,201 is skipped with one warning', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/exact.woff2', bytesOf(FONT_CAP));
  f.write('fonts/over.woff2', bytesOf(FONT_CAP + 1));
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.deepEqual(names(r, 'fonts'), ['exact.woff2']);
  assert.equal(r.files.get('/skin/fonts/exact.woff2').body.length, FONT_CAP);
  assert.equal(skipped(r), 1);
  assert.equal(r.hasFonts, true);
});

test('R166 an image of exactly 512,000 bytes is served; 512,001 is skipped with one warning', TIMEOUT, () => {
  const f = fixture();
  f.write('img/exact.png', bytesOf(IMG_CAP));
  f.write('img/over.png', bytesOf(IMG_CAP + 1));
  const r = loadSkin(f.dir);
  assert.deepEqual(names(r, 'img'), ['exact.png']);
  assert.equal(r.files.get('/skin/img/exact.png').body.length, IMG_CAP);
  assert.equal(skipped(r), 1);
});

test('R166 the cap holds for each image extension (.svg, .webp, .jpg), exactly at it and one over', TIMEOUT, () => {
  const f = fixture();
  for (const ext of ['svg', 'webp', 'jpg']) {
    f.write('img/at-' + ext + '.' + ext, bytesOf(IMG_CAP));
    f.write('img/over-' + ext + '.' + ext, bytesOf(IMG_CAP + 1));
  }
  const r = loadSkin(f.dir);
  assert.deepEqual(names(r, 'img'), ['at-jpg.jpg', 'at-svg.svg', 'at-webp.webp']);
  assert.equal(skipped(r), 3);
});

test('R166 seven fonts: the first six by name are served, the seventh is skipped, whatever order they were made in', TIMEOUT, () => {
  const f = fixture();
  // Ascending by UTF-16 code units of the whole name: "a-b.woff2" < "a.woff2" ('-' is 0x2d, '.' is 0x2e) < "a0" < "a1" < "b" < "c" < "z".
  for (const n of ['z', 'c', 'b', 'a1', 'a0', 'a', 'a-b']) f.write('fonts/' + n + '.woff2', n);
  const r = loadSkin(f.dir);
  assert.deepEqual(names(r, 'fonts'), ['a-b.woff2', 'a.woff2', 'a0.woff2', 'a1.woff2', 'b.woff2', 'c.woff2']);
  assert.equal(skipped(r), 1);
  assert.equal(r.loaded, true);
});

test('R166 thirteen images: twelve are served, the last by name is skipped', TIMEOUT, () => {
  const f = fixture();
  const all = Array.from({ length: 13 }, (_, i) => 'i' + String(i + 1).padStart(2, '0') + '.png');
  for (const n of [...all].reverse()) f.write('img/' + n, n);
  const r = loadSkin(f.dir);
  assert.deepEqual(names(r, 'img'), all.slice(0, 12));
  assert.equal(skipped(r), 1);
});

test('R166 a file that does not meet the rules does not use up one of the six font places', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/A.woff2', 'bad name');
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) f.write('fonts/' + n + '.woff2', n);
  f.write('fonts/g.woff2', 'seventh good');
  const r = loadSkin(f.dir);
  assert.deepEqual(names(r, 'fonts'), ['a.woff2', 'b.woff2', 'c.woff2', 'd.woff2', 'e.woff2', 'f.woff2']);
  assert.equal(skipped(r), 2);
});

test('R166 bad names in fonts/ and img/ are all skipped, one warning each, and nothing is served from them', TIMEOUT, () => {
  const f = fixture();
  const badFonts = ['Font.woff2', 'a b.woff2', 'a..woff2', 'a.WOFF2', '-a.woff2', 'a.ttf', 'a'.repeat(41) + '.woff2'];
  for (const n of badFonts) f.write('fonts/' + n);
  f.write('img/a.gif');
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(skipped(r), 8);
  assert.deepEqual(names(r, 'fonts'), []);
  assert.deepEqual(names(r, 'img'), []);
  assert.equal(r.hasFonts, false);
});

test('R166 each bad-name kind on its own: upper case, space, two dots, leading hyphen, upper-case extension, unknown extension, 41 characters', TIMEOUT, () => {
  const cases = [
    ['fonts', 'Upper.woff2'],
    ['fonts', 'a b.woff2'],
    ['fonts', 'a..woff2'],
    ['fonts', 'a.b.woff2'],
    ['fonts', '-a.woff2'],
    ['fonts', 'a.WOFF2'],
    ['fonts', 'a.ttf'],
    ['fonts', 'noext'],
    ['fonts', 'a'.repeat(41) + '.woff2'],
    ['fonts', 'café.woff2'],
    ['fonts', 'a_b.woff2'],
    ['img', 'A.png'],
    ['img', 'a b.png'],
    ['img', 'a.PNG'],
    ['img', 'a.gif'],
    ['img', 'a.jpeg'],
    ['img', 'a.avif'],
    ['img', 'a'.repeat(41) + '.png'],
  ];
  for (const [folder, name] of cases) {
    const f = fixture();
    f.write(folder + '/' + name, 'data');
    const r = loadSkin(f.dir);
    assert.equal(r.loaded, true, name);
    assert.equal(skipped(r), 1, 'skipped: ' + JSON.stringify(name));
    assert.equal(r.files.size, 1, 'only skin.css: ' + JSON.stringify(name));
  }
});

test('R166 a name of exactly 40 characters before the dot is served', TIMEOUT, () => {
  const f = fixture();
  const name = 'a'.repeat(40);
  f.write('fonts/' + name + '.woff2', 'f');
  f.write('img/' + name + '.png', 'i');
  f.write('img/' + '0'.repeat(39) + '-.webp', 'w');
  const r = loadSkin(f.dir);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.files.has('/skin/fonts/' + name + '.woff2'));
  assert.ok(r.files.has('/skin/img/' + name + '.png'));
  assert.ok(r.files.has('/skin/img/' + '0'.repeat(39) + '-.webp'));
});

test('R166 a digit or a letter may start a name; hyphens and digits are allowed after it', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/0-9-a.woff2');
  f.write('img/9z-.png');
  const r = loadSkin(f.dir);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.files.size, 3);
});

test('R166 the wrong extension for the folder is skipped: an image in fonts/, a font in img/', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/a.png');
  f.write('img/a.woff2');
  const r = loadSkin(f.dir);
  assert.equal(skipped(r), 2);
  assert.equal(r.files.size, 1);
});

test('R166 an extension of the other case is not served: a.JPG, a.Svg', TIMEOUT, () => {
  const f = fixture();
  f.write('img/a.JPG');
  f.write('img/b.Svg');
  const r = loadSkin(f.dir);
  assert.equal(skipped(r), 2);
  assert.deepEqual(names(r, 'img'), []);
});

test('R166 files that together would pass 3,145,728 bytes: the file that crosses is skipped and every earlier file in order is served', TIMEOUT, () => {
  const f = fixture({ css: bytesOf(CSS_CAP) });
  for (let i = 1; i <= 6; i++) f.write('fonts/f' + i + '.woff2', bytesOf(FONT_CAP, 0x30 + i));
  // css 262,144 + fonts 1,843,200 = 2,105,344; two images of 512,000 reach 3,129,344; the third would reach 3,641,344.
  for (const n of ['a', 'b', 'c']) f.write('img/' + n + '.png', bytesOf(IMG_CAP, n.charCodeAt(0)));
  const total = CSS_CAP + 6 * FONT_CAP + 3 * IMG_CAP;
  assert.ok(total > TOTAL_CAP && CSS_CAP + 6 * FONT_CAP + 2 * IMG_CAP <= TOTAL_CAP);
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(names(r, 'fonts').length, 6);
  assert.deepEqual(names(r, 'img'), ['a.png', 'b.png']);
  assert.equal(skipped(r), 1);
  let sum = 0;
  for (const v of r.files.values()) sum += v.body.length;
  assert.ok(sum <= TOTAL_CAP, 'served total ' + sum);
});

test('R166 the total is counted css first, then fonts, then images: a font that crosses is skipped before any image is looked at', TIMEOUT, () => {
  // css 262,144 + 6 fonts 1,843,200 = 2,105,344. A seventh font does not exist (six at most), so the order is shown
  // with images alone: three images of 512,000 take 3,641,344 in all, the first two fit, the third is the crossing file.
  const f = fixture({ css: bytesOf(CSS_CAP) });
  for (let i = 1; i <= 6; i++) f.write('fonts/f' + i + '.woff2', bytesOf(FONT_CAP));
  f.write('img/z.png', bytesOf(IMG_CAP));
  f.write('img/y.png', bytesOf(IMG_CAP));
  f.write('img/x.png', bytesOf(IMG_CAP));
  const r = loadSkin(f.dir);
  assert.deepEqual(names(r, 'img'), ['x.png', 'y.png']);
  assert.equal(skipped(r), 1);
});

test('R166 a folder of 65 files in img/: only the first 64 listed are looked at, so 12 are served, 52 are skipped for count and one is added for the cut', TIMEOUT, () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) f.write('img/p' + String(i).padStart(2, '0') + '.png', String(i));
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(names(r, 'img').length, 12);
  assert.equal(skipped(r), 64 - 12 + 1);
});

test('R166 exactly 64 files in img/ add nothing for a cut: 12 served, 52 skipped', TIMEOUT, () => {
  const f = fixture();
  for (let i = 0; i < 64; i++) f.write('img/p' + String(i).padStart(2, '0') + '.png', String(i));
  const r = loadSkin(f.dir);
  assert.equal(names(r, 'img').length, 12);
  assert.equal(skipped(r), 52);
});

test('R166 a cut in fonts/ adds one for that folder: 65 files there, six served, 58 skipped and the cut', TIMEOUT, () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) f.write('fonts/p' + String(i).padStart(2, '0') + '.woff2', String(i));
  const r = loadSkin(f.dir);
  assert.equal(names(r, 'fonts').length, 6);
  assert.equal(skipped(r), 64 - 6 + 1);
});

test('R166 README.txt, .DS_Store and a folder docs/ in the skin folder are ignored with no warning', TIMEOUT, () => {
  const f = fixture();
  f.write('README.txt', 'notes');
  f.write('.DS_Store', 'junk');
  f.mkdir('docs');
  f.write('docs/a.png', 'not looked at');
  f.write('other.css', 'not looked at');
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual([...r.files.keys()], ['/skin/skin.css']);
});

test('R166 a name that starts with a dot in fonts/ or img/ is ignored with no warning', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/.DS_Store', 'junk');
  f.write('fonts/.hidden.woff2', 'junk');
  f.write('img/.DS_Store', 'junk');
  f.write('img/.a.png', 'junk');
  f.write('img/ok.png', 'ok');
  const r = loadSkin(f.dir);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(names(r, 'img'), ['ok.png']);
  assert.deepEqual(names(r, 'fonts'), []);
});

test('R166 fonts/ and img/ are optional: a skin of skin.css alone loads with no warning and no fonts', TIMEOUT, () => {
  const f = fixture();
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.hasFonts, false);
  assert.equal(r.files.size, 1);
});

test('R166 empty fonts/ and img/ folders add nothing', TIMEOUT, () => {
  const f = fixture();
  f.mkdir('fonts');
  f.mkdir('img');
  const r = loadSkin(f.dir);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.hasFonts, false);
});

test('R166 hasFonts is true exactly when at least one font is served: false when the only font is skipped', TIMEOUT, () => {
  const bad = fixture();
  bad.write('fonts/big.woff2', bytesOf(FONT_CAP + 1));
  bad.write('fonts/Bad.woff2', 'x');
  const r1 = loadSkin(bad.dir);
  assert.equal(r1.hasFonts, false);
  assert.equal(skipped(r1), 2);
  const good = fixture();
  good.write('fonts/big.woff2', bytesOf(FONT_CAP + 1));
  good.write('fonts/ok.woff2', 'x');
  assert.equal(loadSkin(good.dir).hasFonts, true);
});

test('R166 images alone do not make hasFonts true', TIMEOUT, () => {
  const f = fixture();
  f.write('img/a.png');
  assert.equal(loadSkin(f.dir).hasFonts, false);
});

test('R166 zero-byte files are read like any other: a zero-byte skin.css is a valid skin, a zero-byte font and image are served', TIMEOUT, () => {
  const f = fixture({ css: '' });
  f.write('fonts/z.woff2', '');
  f.write('img/z.png', '');
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.deepEqual(r.warnings, []);
  assertServed(r, '/skin/skin.css', 'text/css; charset=utf-8', '', 'css');
  assertServed(r, '/skin/fonts/z.woff2', 'font/woff2', '', 'font');
  assertServed(r, '/skin/img/z.png', 'image/png', '', 'img');
  assert.equal(r.hasFonts, true);
});

test('R166 the order is deterministic: two loads of the same folder return the same keys in the same order', TIMEOUT, () => {
  const f = fixture();
  for (const n of ['m', 'c', 'x', 'a']) {
    f.write('fonts/' + n + '.woff2', n);
    f.write('img/' + n + '.png', n);
  }
  const k1 = [...loadSkin(f.dir).files.keys()];
  const k2 = [...loadSkin(f.dir).files.keys()];
  assert.deepEqual(k1, k2);
  assert.equal(k1[0], '/skin/skin.css');
});

test('R166 only the keys of served files exist: nothing for skipped or ignored entries', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/ok.woff2', 'f');
  f.write('fonts/Bad.woff2', 'f');
  f.write('img/ok.png', 'i');
  f.write('README.txt', 'r');
  const r = loadSkin(f.dir);
  assert.deepEqual([...r.files.keys()].sort(), ['/skin/fonts/ok.woff2', '/skin/img/ok.png', '/skin/skin.css']);
});

// ================================================================ R167: only regular files, never followed

test('R167 a symbolic link to a file holding a sentinel, a named pipe, a folder, a file of limit plus one byte and a good file: only the good one is served, four are skipped, the sentinel reaches nothing, and the load finishes within a second', { ...TIMEOUT, skip: MKFIFO_SKIP }, () => {
  const f = fixture();
  const target = path.join(f.outside, 'secret.png');
  fs.writeFileSync(target, SENTINEL);
  f.link('img/x.png', target);
  fs.mkdirSync(path.join(f.dir, 'img'), { recursive: true });
  mkfifo(path.join(f.dir, 'img', 'y.png'));
  f.mkdir('img/z.png');
  f.write('img/v.png', bytesOf(IMG_CAP + 1));
  f.write('img/w.png', 'good');
  const r = timed(() => loadSkin(f.dir));
  assert.equal(r.loaded, true);
  assert.deepEqual(names(r, 'img'), ['w.png']);
  assert.equal(skipped(r), 4);
  assertNoSentinel(r);
});

test('R167 a symbolic link to a good file in fonts/ or img/ is skipped, never followed', TIMEOUT, () => {
  const f = fixture();
  const font = path.join(f.outside, 'real.woff2');
  const img = path.join(f.outside, 'real.png');
  fs.writeFileSync(font, SENTINEL);
  fs.writeFileSync(img, SENTINEL);
  f.link('fonts/linked.woff2', font);
  f.link('img/linked.png', img);
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(skipped(r), 2);
  assert.equal(r.hasFonts, false);
  assert.deepEqual(names(r, 'fonts'), []);
  assert.deepEqual(names(r, 'img'), []);
  assertNoSentinel(r);
});

test('R167 a symbolic link whose target does not exist is skipped with one warning', TIMEOUT, () => {
  const f = fixture();
  f.link('img/dangling.png', path.join(f.outside, 'nothing-here'));
  f.link('fonts/dangling.woff2', path.join(f.outside, 'nothing-here'));
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(skipped(r), 2);
});

test('R167 a symbolic link to a folder where a file is expected is skipped', TIMEOUT, () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.outside, 'dir'));
  f.link('img/folderlink.png', path.join(f.outside, 'dir'), 'dir');
  const r = loadSkin(f.dir);
  assert.equal(skipped(r), 1);
  assert.equal(r.files.size, 1);
});

test('R167 fonts/ replaced by a symbolic link to a folder holding a good font: that font is not served, skin-file-skipped is 1, the skin still loads', TIMEOUT, () => {
  const f = fixture();
  const real = path.join(f.outside, 'realfonts');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'good.woff2'), SENTINEL);
  f.link('fonts', real, 'dir');
  f.write('img/a.png', 'img');
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(skipped(r), 1);
  assert.equal(unreadable(r), 0);
  assert.deepEqual(names(r, 'fonts'), []);
  assert.equal(r.hasFonts, false);
  assert.deepEqual(names(r, 'img'), ['a.png']);
  assertNoSentinel(r);
});

test('R167 img/ replaced by a symbolic link to a folder holding a good image: not served, skin-file-skipped is 1, the skin still loads', TIMEOUT, () => {
  const f = fixture();
  const real = path.join(f.outside, 'realimg');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'good.png'), SENTINEL);
  f.link('img', real, 'dir');
  f.write('fonts/a.woff2', 'font');
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(skipped(r), 1);
  assert.deepEqual(names(r, 'img'), []);
  assert.deepEqual(names(r, 'fonts'), ['a.woff2']);
  assertNoSentinel(r);
});

test('R167 skin.css as a symbolic link to a good file: no skin, skin-unreadable', TIMEOUT, () => {
  const f = fixture({ css: null });
  const real = path.join(f.outside, 'real.css');
  fs.writeFileSync(real, SENTINEL);
  f.link('skin.css', real);
  f.write('fonts/a.woff2', 'font');
  const r = loadSkin(f.dir);
  assertUnusable(r, 'skin.css link');
  assertNoSentinel(r);
});

test('R167 the skin folder itself as a symbolic link to a good folder: no skin, skin-unreadable', TIMEOUT, () => {
  const f = fixture();
  const linked = path.join(f.root, 'linked-skin');
  fs.symlinkSync(f.dir, linked, 'dir');
  assertUnusable(loadSkin(linked), 'skin folder link');
});

test('R167 a folder where a file is expected is skipped: a folder named like a font or an image', TIMEOUT, () => {
  const f = fixture();
  f.mkdir('fonts/dir.woff2');
  f.mkdir('img/dir.png');
  f.write('img/ok.png', 'ok');
  const r = loadSkin(f.dir);
  assert.equal(skipped(r), 2);
  assert.deepEqual(names(r, 'img'), ['ok.png']);
});

test('R167 skin.css as a folder: no skin, skin-unreadable', TIMEOUT, () => {
  const f = fixture({ css: null });
  f.mkdir('skin.css');
  assertUnusable(loadSkin(f.dir), 'skin.css folder');
});

test('R167 a named pipe in fonts/ and in img/ is skipped and never holds the start: back within a second', { ...TIMEOUT, skip: MKFIFO_SKIP }, () => {
  const f = fixture();
  f.mkdir('fonts');
  f.mkdir('img');
  mkfifo(path.join(f.dir, 'fonts', 'pipe.woff2'));
  mkfifo(path.join(f.dir, 'img', 'pipe.png'));
  f.write('img/ok.png', 'ok');
  const r = timed(() => loadSkin(f.dir));
  assert.equal(r.loaded, true);
  assert.equal(skipped(r), 2);
  assert.deepEqual(names(r, 'img'), ['ok.png']);
});

test('R167 skin.css as a named pipe: no skin, skin-unreadable, back within a second', { ...TIMEOUT, skip: MKFIFO_SKIP }, () => {
  const f = fixture({ css: null });
  mkfifo(path.join(f.dir, 'skin.css'));
  const r = timed(() => loadSkin(f.dir));
  assertUnusable(r, 'skin.css fifo');
});

test('R167 a named pipe with a writer already attached is still skipped and not read', { ...TIMEOUT, skip: MKFIFO_SKIP }, () => {
  const f = fixture();
  f.mkdir('img');
  const p = path.join(f.dir, 'img', 'pipe.png');
  mkfifo(p);
  // Keep a reader open on the pipe (non-blocking) so a writer could exist; the loader must still not read it.
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const r = timed(() => loadSkin(f.dir));
    assert.equal(skipped(r), 1);
    assert.deepEqual(names(r, 'img'), []);
  } finally {
    fs.closeSync(fd);
  }
});

test('R167 the skin folder, fonts/ and img/ as plain files (not folders) are not read: skin-unreadable for the first, one skipped for each of the others', TIMEOUT, () => {
  const a = fixture();
  const fileAsDir = path.join(a.root, 'iam-a-file');
  fs.writeFileSync(fileAsDir, 'x');
  assertUnusable(loadSkin(fileAsDir), 'skin folder is a file');
  const b = fixture();
  b.write('fonts', 'i am a file, not a folder');
  const rb = loadSkin(b.dir);
  assert.equal(rb.loaded, true);
  assert.equal(skipped(rb), 1);
  const c = fixture();
  c.write('img', 'i am a file, not a folder');
  const rc = loadSkin(c.dir);
  assert.equal(rc.loaded, true);
  assert.equal(skipped(rc), 1);
});

test('R167 a missing fonts/ or img/ adds nothing; a missing skin folder is no skin with skin-unreadable', TIMEOUT, () => {
  const f = fixture();
  const ok = loadSkin(f.dir);
  assert.deepEqual(ok.warnings, []);
  assertUnusable(loadSkin(path.join(f.root, 'missing')), 'missing folder');
});

test('R167 a file of the limit plus one byte is skipped, never read through: skin.css, a font and an image each', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/big.woff2', bytesOf(FONT_CAP + 1, 0x42));
  f.write('img/big.png', bytesOf(IMG_CAP + 1, 0x42));
  const r = loadSkin(f.dir);
  assert.equal(skipped(r), 2);
  for (const v of r.files.values()) assert.ok(!v.body.includes(0x42));
});

test('R167 a file whose permissions make it unreadable (a font and an image) is skipped with one warning each', { ...TIMEOUT, skip: ROOT_SKIP }, () => {
  const f = fixture();
  const a = f.write('fonts/locked.woff2', 'secret');
  const b = f.write('img/locked.png', 'secret');
  f.write('img/ok.png', 'ok');
  fs.chmodSync(a, 0o000);
  fs.chmodSync(b, 0o000);
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(skipped(r), 2);
  assert.deepEqual(names(r, 'img'), ['ok.png']);
  assert.equal(r.hasFonts, false);
});

test('R168 an unreadable skin.css means no skin with skin-unreadable', { ...TIMEOUT, skip: ROOT_SKIP }, () => {
  const f = fixture();
  fs.chmodSync(path.join(f.dir, 'skin.css'), 0o000);
  assertUnusable(loadSkin(f.dir), 'unreadable skin.css');
});

test('R167 a fonts/ or img/ that cannot be listed is not read and adds one to skin-file-skipped', { ...TIMEOUT, skip: ROOT_SKIP }, () => {
  const f = fixture();
  f.write('fonts/a.woff2', 'f');
  f.write('img/a.png', 'i');
  fs.chmodSync(path.join(f.dir, 'fonts'), 0o000);
  const r = loadSkin(f.dir);
  assert.equal(r.loaded, true);
  assert.equal(skipped(r), 1);
  assert.equal(r.hasFonts, false);
  assert.deepEqual(names(r, 'img'), ['a.png']);
});

test('R168 a skin folder that cannot be listed is no skin with skin-unreadable', { ...TIMEOUT, skip: ROOT_SKIP }, () => {
  const f = fixture();
  fs.chmodSync(f.dir, 0o000);
  assertUnusable(loadSkin(f.dir), 'unlistable skin folder');
});

test('R167 a thrown error while reading one file skips that file only: the stand-in fails the open of one font, the rest load', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/a.woff2', 'a');
  f.write('fonts/b.woff2', 'b');
  const realOpen = fs.openSync;
  fs.openSync = function patched(p, ...rest) {
    if (String(p).endsWith('a.woff2')) throw Object.assign(new Error('stand-in: open refused'), { code: 'EACCES' });
    return realOpen.call(this, p, ...rest);
  };
  syncBuiltinESMExports();
  let r;
  try {
    r = loadSkin(f.dir);
  } finally {
    fs.openSync = realOpen;
    syncBuiltinESMExports();
  }
  assert.equal(r.loaded, true);
  assert.deepEqual(names(r, 'fonts'), ['b.woff2']);
  assert.equal(skipped(r), 1);
});

// The stand-in for fstatSync: the handle reports a size the bytes do not match.
// This is the "growing while read" and "swapped after it was listed" case seen from the handle: the number of bytes
// read differs from the handle's size, or more than the limit can be read.
function withFstatSize(sizeFor, fn) {
  const realFstat = fs.fstatSync;
  fs.fstatSync = function patched(fd, opts) {
    const st = realFstat.call(this, fd, opts);
    const want = sizeFor({ isFile: () => st.isFile(), size: Number(st.size) });
    if (want === undefined) return st;
    const size = typeof st.size === 'bigint' ? BigInt(want) : want;
    return Object.create(st, { size: { value: size } });
  };
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs.fstatSync = realFstat;
    syncBuiltinESMExports();
  }
}

test('R167 a file whose handle reports a size within the limit but whose bytes run past the limit (limit plus one) is skipped and the load does not hang', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/grow.woff2', bytesOf(FONT_CAP + 1));
  f.write('img/grow.png', bytesOf(IMG_CAP + 1));
  f.write('img/ok.png', 'ok');
  const r = withFstatSize((st) => (st.isFile() && st.size === FONT_CAP + 1 ? FONT_CAP : st.isFile() && st.size === IMG_CAP + 1 ? IMG_CAP : undefined), () => timed(() => loadSkin(f.dir)));
  assert.equal(r.loaded, true);
  assert.deepEqual(names(r, 'fonts'), []);
  assert.deepEqual(names(r, 'img'), ['ok.png']);
  assert.equal(skipped(r), 2);
});

test('R167 a file whose bytes read are fewer than the handle size is skipped (a file swapped after it was listed)', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/short.woff2', bytesOf(100));
  f.write('img/short.png', bytesOf(100));
  f.write('img/ok.png', bytesOf(7));
  const r = withFstatSize((st) => (st.isFile() && st.size === 100 ? 200 : undefined), () => timed(() => loadSkin(f.dir)));
  assert.deepEqual(names(r, 'fonts'), []);
  assert.deepEqual(names(r, 'img'), ['ok.png']);
  assert.equal(skipped(r), 2);
});

test('R167 a file whose bytes read are more than the handle size is skipped (a file that grew while it was read)', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/long.woff2', bytesOf(100));
  f.write('img/ok.png', bytesOf(7));
  const r = withFstatSize((st) => (st.isFile() && st.size === 100 ? 50 : undefined), () => timed(() => loadSkin(f.dir)));
  assert.deepEqual(names(r, 'fonts'), []);
  assert.deepEqual(names(r, 'img'), ['ok.png']);
  assert.equal(skipped(r), 1);
});

test('R167 the stand-ins above change nothing for an honest file: with no patch the same files are served', TIMEOUT, () => {
  const f = fixture();
  f.write('fonts/short.woff2', bytesOf(100));
  f.write('img/short.png', bytesOf(100));
  const r = withFstatSize(() => undefined, () => loadSkin(f.dir));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.files.size, 3);
});

// ================================================================ R167: the safe-reading structure, read as source text

const source = () => fs.readFileSync(SKIN_SOURCE, 'utf8');
// Comments are dropped so a sentence about readFileSync does not count as a call.
const code = () =>
  source()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

test('R167 source: files are opened without following links (O_NOFOLLOW where the platform has it) and without waiting (O_NONBLOCK)', () => {
  const s = code();
  assert.match(s, /O_NOFOLLOW/);
  assert.match(s, /O_NONBLOCK/);
  assert.match(s, /openSync\s*\(/);
});

test('R167 source: where there is no no-follow flag, device and inode are compared before and after the open', () => {
  const s = code();
  assert.match(s, /\bino\b/);
  assert.match(s, /\bdev\b/);
});

test('R167 source: the open handle is checked with fstat (a regular file within its limit), not decided from the path', () => {
  const s = code();
  assert.match(s, /fstatSync\s*\(/);
  assert.match(s, /isFile\s*\(\s*\)/);
  const open = s.search(/openSync\s*\(/);
  const fstat = s.search(/fstatSync\s*\(/);
  const read = s.search(/readSync\s*\(/);
  assert.ok(open >= 0 && fstat >= 0 && read >= 0, 'openSync, fstatSync and readSync all present');
  assert.ok(open < fstat, 'the open comes before the fstat');
  assert.ok(fstat < read, 'the fstat comes before the first read');
});

test('R167 source: at most the limit plus one byte is read from the handle, and the bytes read are compared with the handle size', () => {
  const s = code();
  assert.match(s, /readSync\s*\(/);
  assert.match(s, /\+\s*1\b/);
  assert.match(s, /\.size\b/);
  assert.match(s, /(!==|!=)/);
});

test('R167 source: no whole-file read of a path (readFileSync, readFile, createReadStream) is used on a skin file', () => {
  const s = code();
  assert.doesNotMatch(s, /readFileSync\s*\(/);
  assert.doesNotMatch(s, /\breadFile\s*\(/);
  assert.doesNotMatch(s, /createReadStream\s*\(/);
  assert.doesNotMatch(s, /promises/);
});

test('R167 source: the handle is closed again after reading (closeSync present)', () => {
  assert.match(code(), /closeSync\s*\(/);
});

test('R167 source: the three folders are checked as real folders with lstat (a link to a folder is not one)', () => {
  assert.match(code(), /lstatSync\s*\(/);
});

test('R165 source: the module is synchronous and reads the folder only inside loadSkin (no watcher, no timer)', () => {
  const s = code();
  assert.match(s, /export\s+function\s+loadSkin\s*\(/);
  assert.doesNotMatch(s, /\bwatch(File)?\s*\(/);
  assert.doesNotMatch(s, /setInterval\s*\(/);
  assert.doesNotMatch(s, /setTimeout\s*\(/);
  assert.doesNotMatch(s, /export\s+(async|default\s+async)/);
});

// ================================================================ R167: a folder swapped for a link after it was checked

import { spawn } from 'node:child_process';

const SWAP_SENTINEL = 'SENTINEL-SWAPPED-IN-OUTSIDE-9d27b3';

let SYMLINK_SKIP = false;
{
  const probe = mkRoot();
  try {
    fs.symlinkSync(probe, path.join(probe, 'l'), 'dir');
  } catch (e) {
    SYMLINK_SKIP = 'symbolic links are not available here: ' + (e && e.code);
  }
}

function noSwapBytes(r) {
  for (const [k, v] of r.files) assert.ok(!v.body.includes(SWAP_SENTINEL), 'outside bytes reached ' + k);
}

// Wraps fs.openSync. At the first open whose base name is in `watch` (a path under the folder or a
// /proc/self/fd/... path both end in the base name), runs swap() once, before the real open goes on.
function withSwapAtFirstOpen(watch, swap, fn) {
  const realOpen = fs.openSync;
  const state = { swapped: false, opens: [], witness: null };
  let busy = false;
  fs.openSync = function patched(p, ...rest) {
    if (!busy) {
      state.opens.push(String(p));
      if (!state.swapped && watch.includes(path.basename(String(p)))) {
        busy = true;
        try {
          state.witness = swap();
          state.swapped = true;
        } finally {
          busy = false;
        }
      }
    }
    return realOpen.call(this, p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return { r: timed(() => fn()), state };
  } finally {
    fs.openSync = realOpen;
    syncBuiltinESMExports();
  }
}

// Replace folder `rel` of the skin by a link to an outside folder holding the sentinel; the witness is what a
// reader that re-resolves the path would now read.
function swapFolderForLink(f, rel, outsideName, witnessFile) {
  return () => {
    fs.renameSync(path.join(f.dir, rel), path.join(f.dir, rel + '-away'));
    fs.symlinkSync(path.join(f.outside, outsideName), path.join(f.dir, rel), 'dir');
    return fs.readFileSync(path.join(f.dir, rel, witnessFile), 'utf8');
  };
}

for (const [folder, ext, type] of [['img', 'png', 'image/png'], ['fonts', 'woff2', 'font/woff2']]) {
  test('R167 a ' + folder + '/ swapped for a link to an outside folder at the first open of a file in it: the outside bytes reach no answer', { ...TIMEOUT, skip: SYMLINK_SKIP }, () => {
    const f = fixture();
    const genuine = 'GENUINE-' + folder;
    f.write(folder + '/same.' + ext, genuine);
    fs.mkdirSync(path.join(f.outside, 'out-' + folder));
    fs.writeFileSync(path.join(f.outside, 'out-' + folder, 'same.' + ext), SWAP_SENTINEL);
    fs.writeFileSync(path.join(f.outside, 'out-' + folder, 'private.' + ext), SWAP_SENTINEL);
    const { r, state } = withSwapAtFirstOpen(['same.' + ext], swapFolderForLink(f, folder, 'out-' + folder, 'private.' + ext), () => loadSkin(f.dir));
    // The witness: the swap really happened, and a reader that opens the path again WOULD have read the sentinel.
    assert.equal(state.swapped, true, 'the stand-in never saw a child open; opens seen: ' + JSON.stringify(state.opens.map((p) => path.basename(p))));
    assert.equal(state.witness, SWAP_SENTINEL);
    assert.ok(fs.lstatSync(path.join(f.dir, folder)).isSymbolicLink());
    assertShape(r);
    noSwapBytes(r);
    // The contract allows the genuine file (read through the folder that was checked) or a skip, never anything else.
    const key = '/skin/' + folder + '/same.' + ext;
    if (r.files.has(key)) assertServed(r, key, type, genuine, folder === 'img' ? 'img' : 'font');
    else assert.ok(skipped(r) >= 1, 'a file that is not served is counted as skipped');
    assert.equal(r.files.has('/skin/' + folder + '/private.' + ext), false);
  });
}

test('R167 the skin folder swapped for a link to an outside folder at the first open of skin.css: the outside stylesheet never reaches the map', { ...TIMEOUT, skip: SYMLINK_SKIP }, () => {
  const f = fixture();
  const out = path.join(f.outside, 'out-skin');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'skin.css'), SWAP_SENTINEL);
  fs.writeFileSync(path.join(out, 'private.css'), SWAP_SENTINEL);
  const swap = () => {
    fs.renameSync(f.dir, f.dir + '-away');
    fs.symlinkSync(out, f.dir, 'dir');
    return fs.readFileSync(path.join(f.dir, 'private.css'), 'utf8');
  };
  const { r, state } = withSwapAtFirstOpen(['skin.css'], swap, () => loadSkin(f.dir));
  assert.equal(state.swapped, true, 'the stand-in never saw the open of skin.css');
  assert.equal(state.witness, SWAP_SENTINEL);
  assertShape(r);
  noSwapBytes(r);
  if (r.loaded) assertServed(r, '/skin/skin.css', 'text/css; charset=utf-8', GOOD_CSS, 'css');
  else assertUnusable(r, 'swapped skin folder');
});

test('R167 the swap stand-in is not vacuous: a reader that re-resolves the path after the check does read the outside bytes', { ...TIMEOUT, skip: SYMLINK_SKIP }, () => {
  const f = fixture();
  f.write('img/same.png', 'GENUINE');
  fs.mkdirSync(path.join(f.outside, 'out-img'));
  fs.writeFileSync(path.join(f.outside, 'out-img', 'same.png'), SWAP_SENTINEL);
  // A tiny re-resolving reader: list and lstat the folder, then open the child by its path.
  const naive = () => {
    const dirPath = path.join(f.dir, 'img');
    if (!fs.lstatSync(dirPath).isDirectory()) return null;
    const names = fs.readdirSync(dirPath);
    const fd = fs.openSync(path.join(dirPath, names[0]), fs.constants.O_RDONLY);
    try {
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  };
  const { r: got, state } = withSwapAtFirstOpen(['same.png'], swapFolderForLink(f, 'img', 'out-img', 'same.png'), naive);
  assert.equal(state.swapped, true);
  assert.equal(got, SWAP_SENTINEL, 'the swap is real: the path now leads outside');
});

// The reader of the old tree (before folders were held open) is the proof the swap test bites.
// It is checked in a one-off run, not here: a copy of that file does not live in the repository.

// Runs a real race: a child process flips `target` (a folder of the skin) between a real folder and a link to
// `outside`, and `load` is called in a loop for about one second. The child reports "flipping" only after its first 20
// flips, and the timed loop starts only then, so a slow start under load cannot make the test fail; a child that never
// gets going within 5 s makes the test skip (an environment that cannot run the helper is not a product defect).
// The flip count is the difference of the child's counter over the loop. The child is always killed and waited for.
async function flipRace(t, target, outside, counter, load) {
  const script = `
    const fs = require('node:fs');
    const [target, outside, counter] = process.argv.slice(1);
    const away = target + '-away';
    let n = 0, said = false;
    for (;;) {
      try { fs.renameSync(target, away); fs.symlinkSync(outside, target, 'dir'); n++; fs.unlinkSync(target); fs.renameSync(away, target); } catch {}
      if (n % 10 === 0 && n > 0) { try { fs.writeFileSync(counter + '.tmp', String(n)); fs.renameSync(counter + '.tmp', counter); } catch {} }
      if (!said && n >= 20) { said = true; process.stdout.write('flipping\\n'); }
    }`;
  let child;
  try {
    child = spawn(process.execPath, ['-e', script, target, outside, counter], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip('a child process cannot be started here');
    return null;
  }
  const readCount = () => {
    try {
      return Number(fs.readFileSync(counter, 'utf8')) || 0;
    } catch {
      return 0;
    }
  };
  try {
    const started = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      child.once('error', () => { clearTimeout(timer); resolve(false); });
      child.stdout.once('data', () => { clearTimeout(timer); resolve(true); });
    });
    if (!started) {
      t.skip('the flipping helper did not start flipping within 5 seconds (environment too loaded)');
      return null;
    }
    const before = readCount();
    let loops = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
      load();
      loops++;
    }
    const ms = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 30)); // let the child's last counter write land
    return { loops, ms, flips: readCount() - before };
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve)));
  }
}

test('R167 a real race: a second process flips img/ between a real folder and a link to an outside folder while loadSkin runs in a loop, and the outside bytes never appear', { timeout: 15000, skip: SYMLINK_SKIP }, async (t) => {
  const f = fixture();
  f.write('img/a.png', 'GENUINE-A');
  f.write('img/b.png', 'GENUINE-B');
  fs.mkdirSync(path.join(f.outside, 'out-img'));
  for (const n of ['a.png', 'b.png', 'c.png']) fs.writeFileSync(path.join(f.outside, 'out-img', n), SWAP_SENTINEL);
  const res = await flipRace(t, path.join(f.dir, 'img'), path.join(f.outside, 'out-img'), path.join(f.root, 'flips'), () => {
    const r = loadSkin(f.dir);
    noSwapBytes(r);
  });
  if (!res) return;
  assert.ok(res.loops > 5, 'loaded ' + res.loops + ' times');
  assert.ok(res.flips >= 10, 'the flipping process really flipped during the loop (' + res.flips + ' flips)');
});

// ---------------------------------------------------------------- source properties of the held-folder reader

test('R167 source: each of the three folders is opened once with the directory and no-follow flags', () => {
  const s = code();
  assert.match(s, /O_DIRECTORY/);
  assert.match(s, /O_NOFOLLOW/);
  // The flags for a folder are combined with the read-only flag in one open.
  assert.match(s, /O_DIRECTORY[\s\S]{0,200}O_NOFOLLOW|O_NOFOLLOW[\s\S]{0,200}O_DIRECTORY/);
});

test('R167 source: on Linux a child is opened through the held folder handle (/proc/self/fd/<n>/<name>), not through the folder path', () => {
  const s = code();
  assert.match(s, /\/proc\/self\/fd/);
  assert.match(s, /process\.platform|linux/);
});

test('R167 source: the held folder handles are closed again', () => {
  const s = code();
  assert.match(s, /closeSync\s*\(/);
  assert.ok((s.match(/closeSync\s*\(/g) || []).length >= 2, 'one close for the file handle and one for the folder handle');
});

test('R167 source: no child is opened by a path built from the folder path alone (no openSync(path.join(...)))', () => {
  const s = code();
  assert.doesNotMatch(s, /openSync\s*\(\s*path\.join\s*\(/);
  assert.doesNotMatch(s, /openSync\s*\(\s*`\$\{/);
});

// ================================================================ R167: a failed folder open or identity check is a rejection, never a weaker route

const HANDLE_SKIP = process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')
  ? 'the folder-handle route does not exist here (no /proc/self/fd), so the rejection rule for it cannot be shown'
  : false;

// Wraps fs.openSync and fs.fstatSync for one call of loadSkin. failOpen(p, flags, n) may return an error code to
// throw for that open (n counts the opens of the same path so far); skewIno(p) marks the handles of folder opens
// whose inode is reported one higher. Every path opened is recorded.
function withFolderStandIns({ failOpen = () => null, skewFor = () => false }, fn) {
  const realOpen = fs.openSync;
  const realFstat = fs.fstatSync;
  const opened = [];
  const seen = new Map();
  const skewed = new Set();
  let marked = 0;
  fs.openSync = function patched(p, flags, ...rest) {
    const key = String(p);
    opened.push(key);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const code = failOpen(key, flags, n);
    if (code) throw Object.assign(new Error('stand-in: ' + code), { code });
    const fd = realOpen.call(this, p, flags, ...rest);
    if (skewFor(key, flags, n)) { skewed.add(fd); marked++; }
    return fd;
  };
  fs.fstatSync = function patched(fd, opts) {
    const st = realFstat.call(this, fd, opts);
    if (!skewed.has(fd)) return st;
    skewed.delete(fd); // one report only: the descriptor number is reused after the handle is closed
    const ino = typeof st.ino === 'bigint' ? st.ino + 1n : st.ino + 1;
    return Object.create(st, { ino: { value: ino } });
  };
  syncBuiltinESMExports();
  try {
    return { r: timed(() => fn()), opened, skewedCount: marked };
  } finally {
    fs.openSync = realOpen;
    fs.fstatSync = realFstat;
    syncBuiltinESMExports();
  }
}

// A plain-path open of anything under the folder: <dir>/<something>, reached without /proc/self/fd/.
const plainChildOpens = (opened, dir) => opened.filter((p) => p.startsWith(dir + path.sep) && !p.startsWith('/proc/self/fd/'));
const baseNames = (opened) => opened.map((p) => path.basename(p));

function richFixture() {
  const f = fixture();
  f.write('fonts/child.woff2', 'FONT-BYTES');
  f.write('img/child.png', 'IMG-BYTES');
  return f;
}

for (const code of ['ELOOP', 'ENOTDIR']) {
  test('R167 a failed open (' + code + ') of the skin folder itself is a rejection: no skin, skin-unreadable at 1, and no child is opened by a plain path', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
    const f = richFixture();
    const { r, opened } = withFolderStandIns({ failOpen: (p, flags, n) => (p === f.dir && n === 1 ? code : null) }, () => loadSkin(f.dir));
    assert.ok(opened.includes(f.dir), 'the stand-in saw the open of the skin folder; opens: ' + JSON.stringify(opened.map((p) => path.basename(p))));
    assertUnusable(r, 'skin folder open refused');
    assert.deepEqual(plainChildOpens(opened, f.dir), [], 'a child was opened by a plain path');
    assert.ok(!baseNames(opened).includes('skin.css'), 'skin.css was opened at all');
  });
}

for (const folder of ['img', 'fonts']) {
  for (const code of ['ELOOP', 'ENOTDIR']) {
    test('R167 a failed open (' + code + ') of ' + folder + '/ is a rejection: that folder is skipped with one count, the rest is served, and none of its children is opened', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
      const f = richFixture();
      const other = folder === 'img' ? 'fonts' : 'img';
      const { r, opened } = withFolderStandIns({ failOpen: (p, flags, n) => (path.basename(p) === folder && p !== f.dir && n === 1 ? code : null) }, () => loadSkin(f.dir));
      assert.ok(opened.some((p) => path.basename(p) === folder), 'the stand-in saw the open of ' + folder + '/');
      assert.equal(r.loaded, true);
      assert.equal(skipped(r), 1);
      assert.equal(unreadable(r), 0);
      assert.deepEqual(names(r, folder), []);
      assert.equal(names(r, other).length, 1, 'the other folder is still served');
      assert.ok(r.files.has('/skin/skin.css'));
      assert.deepEqual(plainChildOpens(opened, f.dir), [], 'a child was opened by a plain path');
      assert.ok(!baseNames(opened).includes('child.' + (folder === 'img' ? 'png' : 'woff2')), 'a child of the refused folder was opened');
    });
  }
}

test('R167 a skin folder whose handle reports a different inode than lstat showed is rejected: no skin, skin-unreadable at 1, no child opened by a plain path', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
  const f = richFixture();
  const { r, opened, skewedCount } = withFolderStandIns({ skewFor: (p, flags, n) => p === f.dir && n === 1 }, () => loadSkin(f.dir));
  assert.equal(skewedCount, 1, 'the stand-in marked the skin folder handle');
  assertUnusable(r, 'identity mismatch on the skin folder');
  assert.deepEqual(plainChildOpens(opened, f.dir), [], 'a child was opened by a plain path');
  assert.ok(!baseNames(opened).includes('skin.css'));
});

test('R167 an img/ or fonts/ handle that reports a different inode than lstat showed is rejected: that folder skipped with one count, no plain-path child open', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
  for (const folder of ['img', 'fonts']) {
    const f = richFixture();
    const { r, opened, skewedCount } = withFolderStandIns({ skewFor: (p, flags, n) => path.basename(p) === folder && p !== f.dir && n === 1 }, () => loadSkin(f.dir));
    assert.equal(skewedCount, 1, folder + ' handle marked');
    assert.equal(r.loaded, true);
    assert.equal(skipped(r), 1, folder);
    assert.deepEqual(names(r, folder), [], folder);
    assert.deepEqual(plainChildOpens(opened, f.dir), []);
  }
});

test('R167 the stand-ins above change nothing when they refuse nothing: the same fixture loads whole with no plain-path child open', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
  const f = richFixture();
  const { r, opened } = withFolderStandIns({}, () => loadSkin(f.dir));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.files.size, 3);
  assert.deepEqual(plainChildOpens(opened, f.dir), []);
});

test('R167 a real race on the skin folder itself: a second process flips it between a real folder and a link to an outside folder holding skin.css and img/private.png, and the outside bytes never appear', { timeout: 15000, skip: SYMLINK_SKIP }, async (t) => {
  const f = fixture();
  f.write('img/a.png', 'GENUINE-A');
  const out = path.join(f.outside, 'out-skin');
  fs.mkdirSync(path.join(out, 'img'), { recursive: true });
  fs.writeFileSync(path.join(out, 'skin.css'), SWAP_SENTINEL);
  fs.writeFileSync(path.join(out, 'img', 'private.png'), SWAP_SENTINEL);
  fs.writeFileSync(path.join(out, 'img', 'a.png'), SWAP_SENTINEL);
  const res = await flipRace(t, f.dir, out, path.join(f.root, 'flips'), () => {
    const r = loadSkin(f.dir);
    assertShape(r);
    noSwapBytes(r);
  });
  if (!res) return;
  assert.ok(res.loops > 5, 'loaded ' + res.loops + ' times');
  assert.ok(res.flips >= 10, 'the flipping process really flipped during the loop (' + res.flips + ' flips)');
});

// ================================================================ R167: on Linux the folder-handle route is the only route, chosen by the platform

const PROC = '/proc/self/fd/';
const isProc = (p) => p.startsWith(PROC);

for (const code of ['EMFILE', 'EACCES']) {
  test('R167 with every open under /proc/self/fd/ failing (' + code + ') the skin is refused: no skin, skin-unreadable at 1, no child opened by a plain path', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
    const f = richFixture();
    const { r, opened } = withFolderStandIns({ failOpen: (p) => (isProc(p) ? code : null) }, () => loadSkin(f.dir));
    assertUnusable(r, 'handle route unusable (' + code + ')');
    assert.deepEqual(plainChildOpens(opened, f.dir), [], 'a child was opened by a plain path: the weak route was taken');
  });

  test('R167 the same refusal holds when every plain-path open under the skin folder also throws (' + code + ' on /proc/self/fd/): the weak route does not exist on Linux', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
    const f = richFixture();
    const { r, opened } = withFolderStandIns({
      failOpen: (p) => (isProc(p) ? code : p.startsWith(f.dir + path.sep) ? 'EIO' : null),
    }, () => loadSkin(f.dir));
    assertUnusable(r, 'both routes failing');
    assert.deepEqual(plainChildOpens(opened, f.dir).length > 0 ? ['the reader tried a plain-path child open'] : [], []);
  });
}

test('R167 with every plain-path open under the skin folder throwing, the fixture still loads whole through the folder handles: the handle route never needs a plain child path', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
  const f = richFixture();
  const { r, opened } = withFolderStandIns({ failOpen: (p) => (p.startsWith(f.dir + path.sep) ? 'EIO' : null) }, () => loadSkin(f.dir));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.files.size, 3);
  assert.deepEqual(plainChildOpens(opened, f.dir), []);
});

test('R167 an open of / failing (EACCES) changes nothing: the fixture loads whole with no warnings, the reader needs no open of /, and no child is opened by a plain path', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
  const f = richFixture();
  const { r, opened } = withFolderStandIns({ failOpen: (p) => (p === '/' ? 'EACCES' : null) }, () => loadSkin(f.dir));
  assert.equal(r.loaded, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.files.size, 3);
  assert.deepEqual(plainChildOpens(opened, f.dir), [], 'a child was opened by a plain path: the weak route was taken');
});

test('R167 only the FIRST open under /proc/self/fd/ failing (EMFILE) is a refusal of what that open was for, never a fall back to plain paths', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
  const f = richFixture();
  let seen = 0;
  const { r, opened } = withFolderStandIns({ failOpen: (p) => (isProc(p) && ++seen === 1 ? 'EMFILE' : null) }, () => loadSkin(f.dir));
  assert.ok(seen >= 1, 'the reader opened something under /proc/self/fd/');
  assert.deepEqual(plainChildOpens(opened, f.dir), [], 'a child was opened by a plain path: the weak route was taken');
  if (r.loaded) {
    assert.ok(skipped(r) >= 1, 'a loaded skin must show the refused file or folder as skipped');
    assert.ok(r.files.size < 3, 'something was refused');
  } else {
    assertUnusable(r, 'first handle open refused');
  }
});

test('R167 with every /proc/self/fd/ open failing (EMFILE) and the folder opens passing, no file or folder is ever read by a path resolved from the top', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
  const f = richFixture();
  const { opened } = withFolderStandIns({ failOpen: (p) => (isProc(p) ? 'EMFILE' : null) }, () => loadSkin(f.dir));
  for (const p of opened) {
    assert.ok(p === f.dir || isProc(p) || !p.startsWith(f.dir), 'opened by a plain path: ' + path.basename(p));
  }
});

// ---- both branches exist, and which one each platform takes (a child process overrides process.platform before the import)

function runReaderAs(platform) {
  const script = `
    import fs from 'node:fs';
    const [dir, url, platform] = process.argv.slice(1);
    if (platform) Object.defineProperty(process, 'platform', { value: platform });
    const opened = [];
    const real = fs.openSync;
    fs.openSync = function (p, ...rest) { opened.push(String(p)); return real.call(this, p, ...rest); };
    const { loadSkin } = await import(url);
    const r = loadSkin(dir);
    console.log(JSON.stringify({ platform: process.platform, loaded: r.loaded, warnings: r.warnings, keys: [...r.files.keys()].sort(), hasFonts: r.hasFonts,
      procOpens: opened.filter((p) => p.startsWith('/proc/self/fd/')).length,
      plainChildOpens: opened.filter((p) => p.startsWith(dir + '/')).map((p) => p.slice(dir.length + 1)) }));
  `;
  const args = ['--input-type=module', '-e', script, FIXTURE_SKIN, new URL('../board/skin.mjs', import.meta.url).href];
  if (platform) args.push(platform);
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
  assert.equal(res.status, 0, 'the child failed: ' + (res.stderr || res.error));
  return JSON.parse(res.stdout.trim().split('\n').pop());
}
const FIXTURE_KEYS = ['/skin/fonts/neutral.woff2', '/skin/img/neutral.png', '/skin/img/neutral.svg', '/skin/skin.css'];

test('R167 with process.platform set to darwin before the module is imported, the fixture skin loads through plain paths with no warnings', { ...TIMEOUT, skip: process.platform === 'win32' ? 'the child process check is written for POSIX paths' : false }, () => {
  const o = runReaderAs('darwin');
  assert.equal(o.platform, 'darwin', 'the platform override took effect');
  assert.equal(o.loaded, true);
  assert.deepEqual(o.warnings, []);
  assert.deepEqual(o.keys, FIXTURE_KEYS);
  assert.equal(o.procOpens, 0, 'the darwin branch must not use /proc/self/fd');
  assert.ok(o.plainChildOpens.includes('skin.css'), 'the darwin branch opens children by plain paths: ' + JSON.stringify(o.plainChildOpens));
});

test('R167 on Linux (no override) the same fixture loads through /proc/self/fd/ and no child is opened by a plain path', { ...TIMEOUT, skip: HANDLE_SKIP }, () => {
  const o = runReaderAs(null);
  assert.equal(o.platform, 'linux');
  assert.equal(o.loaded, true);
  assert.deepEqual(o.warnings, []);
  assert.deepEqual(o.keys, FIXTURE_KEYS);
  assert.ok(o.procOpens > 0, 'the Linux branch opens through /proc/self/fd/');
  assert.deepEqual(o.plainChildOpens, []);
});

// ---- source properties

test('R167 source: the route is chosen by a platform constant computed without I/O, and /proc/self/fd appears', () => {
  const s = code();
  assert.match(s, /^(export\s+)?(const|let)\s+\w+\s*=[^;\n]*process\.platform/m, 'a top-level constant built from process.platform');
  assert.match(s, /\/proc\/self\/fd/);
});

test('R167 source: the reader never opens / (no probe of the root)', () => {
  const s = code();
  assert.doesNotMatch(s, /openSync\s*\(\s*['"`]\/['"`]/);
  assert.doesNotMatch(s, /opendirSync\s*\(\s*['"`]\/['"`]/);
});
