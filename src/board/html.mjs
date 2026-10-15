// Two small helpers for writing the page safely. Pure: no clock, no file, no network, no environment.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// HTML-escapes & < > " '. null and undefined give ''; anything else is stringified first.
export function esc(s) {
  if (s === null || s === undefined) return '';
  let text;
  try {
    text = String(s);
  } catch {
    return '';
  }
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const PREFIX = 'https://github.com/';
// A control character, a space, a quote, < or >: none may appear anywhere in a link.
const UNSAFE = /[\u0000- \u007f-\u009f"'<>`\\]/;

const NOTION_PREFIX = 'https://www.notion.so/';

// The url itself when it is a Notion address (R148), otherwise null.
export function notionHref(url) {
  if (typeof url !== 'string') return null;
  if (!url.startsWith(NOTION_PREFIX)) return null;
  if (UNSAFE.test(url)) return null;
  return url;
}

// The url itself when it is a GitHub address, otherwise null.
export function githubHref(url) {
  if (typeof url !== 'string') return null;
  if (!url.startsWith(PREFIX)) return null;
  if (UNSAFE.test(url)) return null;
  return url;
}
