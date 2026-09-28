// ESM like meetingJoinUrl.js: shared by the tray (main process) and the tray
// calendar popover (renderer).

// A meeting that started this recently still reads as "now" in the menu bar,
// so a late join shows the current meeting instead of the next one.
const LATE_JOIN_GRACE_MS = 10 * 60 * 1000;
const TITLE_MAX_CHARS = 24;

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function isWeekend(date) {
  const day = new Date(date).getDay();
  return day === 0 || day === 6;
}

/** A Google invite that still awaits a firm answer gets Accept/Maybe/Decline. */
export function needsRsvp(event) {
  return (
    event.provider === "google" &&
    (event.self_response_status === "needsAction" || event.self_response_status === "tentative")
  );
}

export function isVisibleEvent(event) {
  return !event.is_all_day && event.self_response_status !== "declined";
}

/** Menu-bar text for the next meeting of today, e.g. "Skie - Daily · 12m". */
export function formatTrayTitle(events, now = Date.now()) {
  const endOfToday = addDays(startOfDay(now), 1).getTime();
  const next = events.find((event) => {
    if (!isVisibleEvent(event)) return false;
    const start = Date.parse(event.start_time);
    return start >= now - LATE_JOIN_GRACE_MS && start < endOfToday;
  });
  if (!next) return "";

  const summary = (next.summary || "").trim();
  const name =
    summary.length > TITLE_MAX_CHARS ? `${summary.slice(0, TITLE_MAX_CHARS - 1)}…` : summary;
  const minutes = Math.ceil((Date.parse(next.start_time) - now) / 60000);
  const when =
    minutes <= 0
      ? "now"
      : minutes < 60
        ? `${minutes}m`
        : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return name ? `${name} · ${when}` : when;
}

/** Note title for a joined meeting, e.g. "Skie - Daily — 2026-09-28 14:00". */
export function meetingNoteTitle(event) {
  const summary = event.summary?.trim() || "New note";
  const start = new Date(event.start_time);
  if (Number.isNaN(start.getTime())) return summary;
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  return `${summary} — ${date} ${pad(start.getHours())}:${pad(start.getMinutes())}`;
}

/** Monday-first weeks covering `month`; weekends dropped when hidden. */
export function buildMonthGrid(month, hideWeekends) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = addDays(first, -((first.getDay() + 6) % 7));
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const weeks = [];
  for (let weekStart = gridStart; weekStart <= last; weekStart = addDays(weekStart, 7)) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    weeks.push(hideWeekends ? days.filter((day) => !isWeekend(day)) : days);
  }
  return weeks;
}

/** Visible events from `fromDay` onward, grouped by local day, in start order. */
export function groupEventsByDay(events, fromDay, hideWeekends) {
  const from = startOfDay(fromDay).getTime();
  const groups = new Map();
  for (const event of events) {
    if (!isVisibleEvent(event)) continue;
    const start = new Date(event.start_time);
    const day = startOfDay(start);
    if (day.getTime() < from || (hideWeekends && isWeekend(day))) continue;
    const key = day.toDateString();
    if (!groups.has(key)) groups.set(key, { key, date: day, events: [] });
    groups.get(key).events.push(event);
  }
  return [...groups.values()].sort((a, b) => a.date - b.date);
}

export const MAX_WORLD_CLOCKS = 4;
export const DEFAULT_WORLD_CLOCKS = [
  { label: "Lisbon", timeZone: "Europe/Lisbon" },
  { label: "São Paulo", timeZone: "America/Sao_Paulo" },
  { label: "Lima", timeZone: "America/Lima" },
  { label: "Charlotte", timeZone: "America/New_York" },
];

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "America/Sao_Paulo" → "Sao Paulo", used as the default clock label. */
export function cityFromTimeZone(timeZone) {
  return timeZone.split("/").pop().replace(/_/g, " ");
}

const ymd = (timeZone, now) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

/** 24-hour time in `timeZone` and how many days it is ahead of (or behind) `localTimeZone`. */
export function formatWorldClock(timeZone, now = Date.now(), localTimeZone = undefined) {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const dayOffset = Math.round(
    (Date.parse(ymd(timeZone, now)) - Date.parse(ymd(localTimeZone, now))) / 86400000
  );
  return { time, dayOffset };
}
