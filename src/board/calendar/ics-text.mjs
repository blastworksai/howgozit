// Reads the text of one iCalendar object (pure): events as property lists, and clean titles.
// One linear pass; no pattern here can backtrack without bound; nothing throws.

const MAX_CHARS = 2000000;
const MAX_EVENTS = 2000;

function unfold(text) {
  const raw = text.split('\n');
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    const c = line.charCodeAt(0);
    if ((c === 32 || c === 9) && lines.length > 0) {
      lines[lines.length - 1].push(line.slice(1));
    } else {
      lines.push([line]);
    }
  }
  return lines.map((parts) => (parts.length === 1 ? parts[0] : parts.join('')));
}

// Returns { name, params, value } or null when the line has no usable ':'.
function parseLine(line) {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ':' && line[i] !== ';') i++;
  if (i >= n) return null;
  const name = line.slice(0, i).trim().toUpperCase();
  if (name === '') return null;
  const params = {};
  while (i < n && line[i] === ';') {
    i++;
    const start = i;
    let inQuote = false;
    let eq = -1;
    while (i < n) {
      const ch = line[i];
      if (ch === '"') inQuote = !inQuote;
      else if (!inQuote && (ch === ';' || ch === ':')) break;
      else if (!inQuote && ch === '=' && eq < 0) eq = i;
      i++;
    }
    if (eq > start) {
      const pname = line.slice(start, eq).trim().toUpperCase();
      if (pname !== "") Object.defineProperty(params, pname, { value: line.slice(eq + 1, i).split(String.fromCharCode(34)).join(""), enumerable: true, writable: true, configurable: true });
    }
  }
  if (i >= n || line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

export function readEvents(text, { maxChars = MAX_CHARS, maxEvents = MAX_EVENTS } = {}) {
  try {
    if (typeof text !== 'string' || text.length > maxChars) return null;
    const lines = unfold(text);
    const events = [];
    let current = null;
    let skip = 0;
    let started = 0;
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      if (line === '') continue;
      const p = parseLine(line);
      if (p === null) continue;
      if (p.name === 'BEGIN') {
        const what = p.value.trim().toUpperCase();
        if (skip > 0 || current !== null) {
          skip++;
        } else if (what === 'VEVENT') {
          started++;
          if (started > maxEvents) return null;
          current = Object.create(null);
        } else if (what !== 'VCALENDAR') {
          skip = 1;
        }
        continue;
      }
      if (p.name === 'END') {
        if (skip > 0) skip--;
        else if (current !== null && p.value.trim().toUpperCase() === 'VEVENT') {
          events.push(current);
          current = null;
        }
        continue;
      }
      if (current !== null && skip === 0) {
        const entry = { params: p.params, value: p.value };
        if (current[p.name]) current[p.name].push(entry);
        else current[p.name] = [entry];
      }
    }
    return events;
  } catch {
    return null;
  }
}

export function cleanTitle(value) {
  try {
    if (typeof value !== 'string') return '(no title)';
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === '\\' && i + 1 < value.length) {
        const nx = value[i + 1];
        if (nx === 'n' || nx === 'N') { out += ' '; i++; continue; }
        if (nx === ',' || nx === ';' || nx === '\\') { out += nx; i++; continue; }
      }
      out += ch;
    }
    out = out.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
    if (out === '') return '(no title)';
    const chars = Array.from(out);
    if (chars.length > 200) return chars.slice(0, 199).join('') + '…';
    return out;
  } catch {
    return '(no title)';
  }
}
