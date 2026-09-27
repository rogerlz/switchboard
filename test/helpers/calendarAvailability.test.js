const test = require("node:test");
const assert = require("node:assert/strict");

const { parseEventTime } = require("../../src/helpers/calendarAvailability.js");

test("date-only all-day rows use device-local midnight instead of UTC", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    assert.equal(parseEventTime("2026-08-25", true), Date.parse("2026-08-25T00:00:00-07:00"));
    assert.equal(parseEventTime("2026-02-30", true), null);
    assert.equal(parseEventTime("2026-08-25T10:00:00Z", false), Date.parse("2026-08-25T10:00:00Z"));
    assert.equal(parseEventTime(null, false), null);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
