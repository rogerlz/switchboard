// ESM like meetingJoinUrl.js: this module is shared with the renderer, where
// Vite only handles ESM source files; main-process CJS callers load it via
// Node's require(esm) with module-syntax detection.

// Widest buffer the calendar sync windows keep covered past their edges.
export const MAX_BUFFER_MINUTES = 120;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function hasValidDateParts(year, month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function parseLocalDateOnly(value) {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!hasValidDateParts(year, month, day)) return null;

  const date = new Date(year, month - 1, day);
  if (year >= 0 && year < 100) date.setFullYear(year);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

// Date-only all-day rows resolve to device-local midnight instead of UTC.
export function parseEventTime(value, isAllDay) {
  if (typeof value !== "string") return null;
  if (isAllDay && DATE_ONLY_PATTERN.test(value)) return parseLocalDateOnly(value);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
