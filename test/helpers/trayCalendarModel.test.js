const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/trayCalendarModel.js");

const at = (h, m = 0, dayOffset = 0) => new Date(2026, 8, 28 + dayOffset, h, m).toISOString();
const event = (summary, start, extra = {}) => ({
  summary,
  start_time: start,
  end_time: start,
  is_all_day: 0,
  self_response_status: "accepted",
  ...extra,
});

test("tray title shows the next meeting of today with a countdown", async () => {
  const { formatTrayTitle } = await load();
  const now = new Date(2026, 8, 28, 13, 48).getTime();
  const events = [event("Standup", at(9)), event("Skie - Daily", at(14))];
  assert.equal(formatTrayTitle(events, now), "Skie - Daily · 12m");
});

test("tray title keeps a just-started meeting, skips declined and tomorrow", async () => {
  const { formatTrayTitle } = await load();
  const now = new Date(2026, 8, 28, 14, 5).getTime();
  assert.equal(formatTrayTitle([event("Daily", at(14))], now), "Daily · now");
  assert.equal(
    formatTrayTitle([event("Nope", at(15), { self_response_status: "declined" })], now),
    ""
  );
  assert.equal(formatTrayTitle([event("Tomorrow", at(9, 0, 1))], now), "");
});

test("tray title truncates long names and formats hours", async () => {
  const { formatTrayTitle } = await load();
  const now = new Date(2026, 8, 28, 8, 0).getTime();
  const title = formatTrayTitle([event("Patching RCA and change management", at(10, 30))], now);
  assert.equal(title, "Patching RCA and change… · 2h 30m");
});

test("month grid starts on Monday and drops weekends when hidden", async () => {
  const { buildMonthGrid } = await load();
  const weeks = buildMonthGrid(new Date(2026, 8, 1), false);
  assert.equal(weeks[0][0].getDate(), 31); // Mon 31 Aug
  assert.ok(weeks.every((week) => week.length === 7));
  const weekdays = buildMonthGrid(new Date(2026, 8, 1), true);
  assert.ok(weekdays.every((week) => week.every((d) => d.getDay() !== 0 && d.getDay() !== 6)));
});

test("groups skip earlier days, weekends, all-day and declined events", async () => {
  const { groupEventsByDay } = await load();
  const events = [
    event("Yesterday", at(10, 0, -1)),
    event("Today", at(14)),
    event("All day", at(0), { is_all_day: 1 }),
    event("Declined", at(15), { self_response_status: "declined" }),
    event("Saturday", at(10, 0, 5)),
    event("Tuesday", at(14, 0, 1)),
  ];
  const groups = groupEventsByDay(events, new Date(2026, 8, 28), true);
  assert.deepEqual(
    groups.map((g) => g.events.map((e) => e.summary)),
    [["Today"], ["Tuesday"]]
  );
  const withYesterday = groupEventsByDay(events, new Date(2026, 8, 27), false);
  assert.equal(withYesterday.length, 4);
});

test("meeting note title carries the local date and start time", async () => {
  const { meetingNoteTitle } = await load();
  assert.equal(meetingNoteTitle(event("Skie - Daily", at(14))), "Skie - Daily — 2026-09-28 14:00");
  assert.equal(meetingNoteTitle(event(null, "bad")), "New note");
});

test("only pending Google invites ask for an RSVP", async () => {
  const { needsRsvp } = await load();
  const google = (status) => ({ provider: "google", self_response_status: status });
  assert.equal(needsRsvp(google("needsAction")), true);
  assert.equal(needsRsvp(google("tentative")), true);
  assert.equal(needsRsvp(google("accepted")), false);
  assert.equal(needsRsvp({ provider: "apple", self_response_status: "needsAction" }), false);
});

test("world clocks show 24-hour local time and a day offset", async () => {
  const { formatWorldClock } = await load();
  const now = Date.UTC(2026, 8, 28, 23, 30); // 00:30 in Lisbon (WEST, UTC+1)
  assert.deepEqual(formatWorldClock("America/Sao_Paulo", now, "Europe/Lisbon"), {
    time: "20:30",
    dayOffset: -1,
  });
  assert.deepEqual(formatWorldClock("Europe/Lisbon", now, "Europe/Lisbon"), {
    time: "00:30",
    dayOffset: 0,
  });
  assert.deepEqual(formatWorldClock("Asia/Tokyo", now, "America/New_York"), {
    time: "08:30",
    dayOffset: 1,
  });
});

test("time zone helpers validate zones and derive city labels", async () => {
  const { isValidTimeZone, cityFromTimeZone } = await load();
  assert.equal(isValidTimeZone("America/Lima"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(cityFromTimeZone("America/Sao_Paulo"), "Sao Paulo");
});
