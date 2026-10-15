// CalDAV request bodies, a small multistatus reader and the address rule for the iCloud connector.
// Pure: no clock, no file, no network, no environment. Nothing here throws on bad input.

export const ROOT = 'https://caldav.icloud.com/';

const DECL = '<?xml version="1.0" encoding="utf-8"?>\n';

export function principalBody() {
  return DECL + '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>';
}

export function homeBody() {
  return DECL + '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>';
}

export function calendarsBody() {
  return DECL + '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:displayname/><D:resourcetype/><C:supported-calendar-component-set/></D:prop></D:propfind>';
}

function basicUtc(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const d = new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  const year = d.getUTCFullYear();
  if (year < 0 || year > 9999) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function reportBody(range) {
  const r = range && typeof range === 'object' ? range : {};
  const start = basicUtc(r.start);
  const end = basicUtc(r.end);
  if (start === null || end === null) return null;
  return DECL + '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="' + start + '" end="' + end + '"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';
}

// ---------- multistatus reader ----------

const MAX_CHARS = 2000000;
const MAX_DEPTH = 100;
const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text) {
  let at = text.indexOf('&');
  if (at < 0) return text;
  let out = '';
  let from = 0;
  while (at >= 0) {
    out += text.slice(from, at);
    const semi = text.indexOf(';', at + 1);
    if (semi < 0) {
      // No ';' anywhere after this point: nothing further can be a reference.
      from = at;
      break;
    }
    if (semi - at > 12) {
      out += '&';
      from = at + 1;
    } else {
      const body = text.slice(at + 1, semi);
      if (Object.prototype.hasOwnProperty.call(NAMED, body)) {
        out += NAMED[body];
      } else if (/^#[0-9]{1,8}$/.test(body) || /^#[xX][0-9a-fA-F]{1,8}$/.test(body)) {
        const hex = body[1] === 'x' || body[1] === 'X';
        const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (cp >= 1 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) out += String.fromCodePoint(cp);
      } else {
        out += text.slice(at, semi + 1);
      }
      from = semi + 1;
    }
    at = text.indexOf('&', from);
  }
  return out + text.slice(from);
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127;
}
function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46;
}
function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}
function localOf(name) {
  const i = name.lastIndexOf(':');
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

// Linear scan into a tree of { name, attrs, children, text }. Returns the top-level elements, or null.
// Every step moves forward, and a step that cannot finish (no closing '>') ends the scan.
function parseTree(xml) {
  const top = { name: '', attrs: null, children: [], text: '' };
  const stack = [top];
  const n = xml.length;
  let pos = 0;
  while (pos < n) {
    const lt = xml.indexOf('<', pos);
    const cur = stack[stack.length - 1];
    if (lt < 0) {
      cur.text += decode(xml.slice(pos));
      break;
    }
    if (lt > pos) cur.text += decode(xml.slice(pos, lt));
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) break;
      pos = e + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) {
        cur.text += xml.slice(lt + 9);
        break;
      }
      cur.text += xml.slice(lt + 9, e);
      pos = e + 3;
    } else if (xml.charCodeAt(lt + 1) === 63) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) break;
      pos = e + 2;
    } else if (xml.charCodeAt(lt + 1) === 33) {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) break;
      pos = e + 1;
    } else if (xml.charCodeAt(lt + 1) === 47) {
      let p = lt + 2;
      const s = p;
      while (p < n && isNameChar(xml.charCodeAt(p))) p++;
      const name = localOf(xml.slice(s, p));
      const e = xml.indexOf('>', p);
      if (e < 0) break;
      pos = e + 1;
      if (p > s) {
        for (let i = stack.length - 1; i >= 1; i--) {
          if (stack[i].name === name) {
            stack.length = i;
            break;
          }
        }
      }
    } else {
      let p = lt + 1;
      const s = p;
      if (p >= n || !isNameStart(xml.charCodeAt(p))) {
        cur.text += '<';
        pos = lt + 1;
        continue;
      }
      while (p < n && isNameChar(xml.charCodeAt(p))) p++;
      const name = localOf(xml.slice(s, p));
      const attrs = Object.create(null);
      let selfClose = false;
      let closed = false;
      while (p < n) {
        const c = xml.charCodeAt(p);
        if (isSpace(c)) { p++; continue; }
        if (c === 62) { p++; closed = true; break; }
        if (c === 47) { selfClose = true; p++; continue; }
        if (isNameStart(c)) {
          const as = p;
          while (p < n && isNameChar(xml.charCodeAt(p))) p++;
          const an = localOf(xml.slice(as, p));
          while (p < n && isSpace(xml.charCodeAt(p))) p++;
          if (xml.charCodeAt(p) === 61) {
            p++;
            while (p < n && isSpace(xml.charCodeAt(p))) p++;
            const q = xml.charCodeAt(p);
            if (q === 34 || q === 39) {
              const qe = xml.indexOf(q === 34 ? '"' : "'", p + 1);
              if (qe < 0) { p = n; break; }
              if (!(an in attrs)) attrs[an] = decode(xml.slice(p + 1, qe));
              p = qe + 1;
            } else {
              const vs = p;
              while (p < n && !isSpace(xml.charCodeAt(p)) && xml.charCodeAt(p) !== 62 && xml.charCodeAt(p) !== 47) p++;
              if (!(an in attrs)) attrs[an] = decode(xml.slice(vs, p));
            }
          }
          selfClose = false;
          continue;
        }
        selfClose = false;
        p++;
      }
      if (!closed) break;
      pos = p;
      const node = { name, attrs, children: [], text: '' };
      cur.children.push(node);
      if (!selfClose) {
        if (stack.length > MAX_DEPTH) return null;
        stack.push(node);
      }
    }
  }
  return top.children;
}

function kids(node, name) {
  return node.children.filter((c) => c.name === name);
}
function firstKid(node, name) {
  for (const c of node.children) if (c.name === name) return c;
  return null;
}
function hrefOf(node) {
  const h = firstKid(node, 'href');
  return h ? h.text.trim() : null;
}

export function parseMultistatus(xml) {
  try {
    if (typeof xml !== 'string' || xml.length > MAX_CHARS) return null;
    const roots = parseTree(xml);
    if (!roots || roots.length === 0 || roots[0].name !== 'multistatus') return null;
    const out = [];
    for (const resp of kids(roots[0], 'response')) {
      const props = {
        displayName: null,
        isCalendar: false,
        components: null,
        principal: null,
        home: null,
        calendarData: null,
      };
      for (const ps of kids(resp, 'propstat')) {
        const st = firstKid(ps, 'status');
        if (!st || !st.text.includes(' 200 ')) continue;
        for (const prop of kids(ps, 'prop')) {
          for (const p of prop.children) {
            if (p.name === 'displayname') props.displayName = p.text;
            else if (p.name === 'resourcetype') { if (firstKid(p, 'calendar')) props.isCalendar = true; }
            else if (p.name === 'supported-calendar-component-set') {
              const names = [];
              for (const c of kids(p, 'comp')) if (typeof c.attrs.name === 'string') names.push(c.attrs.name);
              props.components = names;
            } else if (p.name === 'current-user-principal') props.principal = hrefOf(p);
            else if (p.name === 'calendar-home-set') props.home = hrefOf(p);
            else if (p.name === 'calendar-data') props.calendarData = p.text;
          }
        }
      }
      out.push({ href: hrefOf(resp), props });
    }
    return out;
  } catch {
    return null;
  }
}

// ---------- addresses ----------

export function allowedUrl(url) {
  try {
    if (typeof url !== 'string') return false;
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username !== '' || u.password !== '') return false;
    if (u.port !== '' && u.port !== '443') return false;
    const h = u.hostname.toLowerCase();
    return h === 'icloud.com' || h.endsWith('.icloud.com');
  } catch {
    return false;
  }
}

export function resolveHref(base, href) {
  try {
    if (typeof base !== 'string' || typeof href !== 'string') return null;
    const u = new URL(href, base).href;
    return allowedUrl(u) ? u : null;
  } catch {
    return null;
  }
}
