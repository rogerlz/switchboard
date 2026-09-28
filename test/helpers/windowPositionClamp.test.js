const test = require("node:test");
const assert = require("node:assert/strict");

const { WindowPositionUtil } = require("../../src/helpers/windowConfig");

// A 1512px laptop screen with a wider monitor mounted above it: x beyond 1512
// is dead space at the laptop's y range, even though the desktop spans further.
const LAPTOP = { workArea: { x: 0, y: 0, width: 1512, height: 949 } };

test("pulls a window parked beyond a display edge back into its work area", () => {
  const stranded = { x: 1472, y: 33, width: 96, height: 96 };
  assert.deepEqual(WindowPositionUtil.clampToWorkArea(stranded, LAPTOP), { x: 1416, y: 33 });
});

test("leaves a window already inside the work area untouched", () => {
  const inside = { x: 1412, y: 849, width: 96, height: 96 };
  assert.deepEqual(WindowPositionUtil.clampToWorkArea(inside, LAPTOP), { x: 1412, y: 849 });
});

// A monitor mounted above (or left of) the primary display has a negative origin
// in Electron's coordinate space. Flooring a computed position at zero lands the
// window on a row that display doesn't cover — beside the primary screen, where
// nothing is drawn and the overlay looks like it vanished.
const MONITOR_ABOVE = { workArea: { x: -451, y: -1440, width: 2560, height: 1440 } };

test("the meeting prompt also lands on a monitor above the primary display", () => {
  const { x, y, width, height } = WindowPositionUtil.getNotificationPosition(MONITOR_ABOVE);
  const { workArea } = MONITOR_ABOVE;

  assert.ok(y < 0, "the prompt must not be floored onto the primary display's rows");
  assert.ok(x >= workArea.x && x + width <= workArea.x + workArea.width);
  assert.ok(y >= workArea.y && y + height <= workArea.y + workArea.height);
});

test("clamps against negative-origin displays and falls back to bounds", () => {
  const external = { bounds: { x: -451, y: -1440, width: 2560, height: 1440 } };
  assert.deepEqual(
    WindowPositionUtil.clampToWorkArea({ x: -900, y: -2000, width: 400, height: 500 }, external),
    { x: -451, y: -1440 }
  );
});
