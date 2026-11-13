// The part strings the section modules share (PART-MAP C3, C4, C5, C6).
// Pure strings and string builders: no imports, no clock, no files. top, mid and low import from here;
// page.mjs is NOT imported (it imports the section modules).

// C4: the stale badge.
export const STALE_BADGE = '<span class="bdg bdg--stale"><span class="pad warn"></span>Out of date</span>';

// C5: the four fixings and the empty state. `text` is the caller's already-escaped sentence.
export const FIX = '<span class="fix fix--tl"></span><span class="fix fix--tr"></span>'
  + '<span class="fix fix--bl"></span><span class="fix fix--br"></span>';
export const emp = (text, extraClass = '') => `<p class="${extraClass ? `emp ${extraClass}` : 'emp'}">${FIX}${text}</p>`;

// C6: the alert strip for a panel that could not be read. `sentence` is already-escaped text.
export const panelError = (sentence) =>
  `<div class="al ch in panel-error" data-k="err"><span class="pad err"></span><div class="al-t"><span>${sentence}</span></div></div>`;

// C3: the section frame, one card-f face inside. `classes` starts with `card`; `attrs` is a leading-space attribute string.
export const frame = (classes, name, attrs, inner) =>
  `<section class="${classes}" data-section="${name}"${attrs}><div class="card-f">${inner}</div></section>`;
