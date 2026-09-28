const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/hotkeys.ts");

test("accelerators format as macOS labels", async () => {
  const { formatHotkeyLabel } = await load();

  assert.equal(formatHotkeyLabel(""), "");
  assert.equal(formatHotkeyLabel("  "), "");
  assert.equal(formatHotkeyLabel(null), "");
  assert.equal(formatHotkeyLabel("CommandOrControl+Shift+K"), "Cmd+Shift+K");
  assert.equal(formatHotkeyLabel("Alt+R"), "Option+R");
  assert.equal(formatHotkeyLabel("F8"), "F8");
});
