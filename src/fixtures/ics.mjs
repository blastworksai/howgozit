// Test material: writes iCalendar text for the calendar tests. It writes text and works nothing out.
// Every value is written as the caller gave it; no time is converted and no rule is read.

let counter = 0;

// One VEVENT block, lines joined with CRLF, not folded (vcalendar folds).
export function vevent({
  uid, summary, start, end, tzid, allDay, duration, rrule, exdate, rdate, recurrenceId, status, extra,
} = {}) {
  counter += 1;
  const id = uid === undefined ? `fixture-${counter}@example.com` : uid;
  // The parameter text placed before the colon on the time lines.
  const param = allDay ? ';VALUE=DATE' : tzid ? `;TZID=${tzid}` : '';
  const lines = ['BEGIN:VEVENT', `UID:${id}`, 'DTSTAMP:20261001T000000Z'];
  if (summary !== undefined) lines.push(`SUMMARY:${summary}`);
  if (start !== undefined) lines.push(`DTSTART${param}:${start}`);
  if (end !== undefined) lines.push(`DTEND${param}:${end}`);
  if (duration !== undefined) lines.push(`DURATION:${duration}`);
  if (rrule !== undefined) lines.push(`RRULE:${rrule}`);
  if (exdate !== undefined) {
    for (const value of Array.isArray(exdate) ? exdate : [exdate]) lines.push(`EXDATE${param}:${value}`);
  }
  if (rdate !== undefined) lines.push(`RDATE:${rdate}`);
  if (recurrenceId !== undefined) lines.push(`RECURRENCE-ID${param}:${recurrenceId}`);
  if (status !== undefined) lines.push(`STATUS:${status}`);
  if (Array.isArray(extra)) lines.push(...extra);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

// Fold one line at 75 characters: each continuation starts with one space.
function fold(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join('\r\n');
}

// One calendar object around the given events (each a vevent() text), CRLF line ends, long lines folded.
export function vcalendar(...events) {
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Fixture//EN', 'CALSCALE:GREGORIAN'];
  for (const event of events) body.push(...String(event).split('\r\n'));
  body.push('END:VCALENDAR');
  return `${body.map(fold).join('\r\n')}\r\n`;
}

// Run directly, it prints one sample calendar.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(vcalendar(
    vevent({ uid: 'sample-1', summary: 'Standup', start: '20261012T083000Z', end: '20261012T084500Z' }),
    vevent({
      uid: 'sample-2', summary: 'Weekly review with a very long title that has to be folded onto a second line',
      start: '20260928T090000', end: '20260928T100000', tzid: 'Europe/Brussels',
      rrule: 'FREQ=WEEKLY;BYDAY=MO', exdate: ['20261005T090000', '20261012T090000'],
      extra: ['ATTENDEE;PARTSTAT=DECLINED:mailto:sam@example.com', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'END:VALARM'],
    }),
    vevent({ uid: 'sample-3', summary: 'Holiday', start: '20261012', end: '20261013', allDay: true }),
  ));
}
