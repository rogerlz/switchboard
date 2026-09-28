const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/hotkeys.ts");

test("empty input formats to an empty label", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("", "darwin"), "");
  assert.equal(formatHotkeyLabelForPlatform("  ", "darwin"), "");
});

test("the same stored accelerator renders per platform: Cmd on macOS, Ctrl on Windows", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("CommandOrControl+K", "darwin"), "Cmd+K");
  assert.equal(formatHotkeyLabelForPlatform("CommandOrControl+K", "win32"), "Ctrl+K");
});

test("Alt displays as Option on macOS and stays Alt on Windows", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("Alt+R", "darwin"), "Option+R");
  assert.equal(formatHotkeyLabelForPlatform("Alt+R", "win32"), "Alt+R");
});

test("Super/Meta display as Cmd on macOS, Win on Windows, Super on Linux", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("Super+K", "darwin"), "Cmd+K");
  assert.equal(formatHotkeyLabelForPlatform("Meta+K", "darwin"), "Cmd+K");
  assert.equal(formatHotkeyLabelForPlatform("Super+K", "win32"), "Win+K");
  assert.equal(formatHotkeyLabelForPlatform("Meta+K", "win32"), "Win+K");
  assert.equal(formatHotkeyLabelForPlatform("Super+K", "linux"), "Super+K");
  assert.equal(formatHotkeyLabelForPlatform("Meta+K", "linux"), "Super+K");
});

test("right-side single modifiers get spelled-out platform-aware labels", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("RightOption", "darwin"), "Right Option");
  assert.equal(formatHotkeyLabelForPlatform("RightOption", "win32"), "Right Alt");
  assert.equal(formatHotkeyLabelForPlatform("RightSuper", "win32"), "Right Win");
  assert.equal(formatHotkeyLabelForPlatform("RightCommand", "darwin"), "Right Cmd");
});

test("left-side modifiers are labelled by side too, so a rejection can name the key pressed", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("LeftOption", "darwin"), "Left Option");
  assert.equal(formatHotkeyLabelForPlatform("LeftOption", "win32"), "Left Alt");
  assert.equal(formatHotkeyLabelForPlatform("LeftControl", "darwin"), "Left Ctrl");
  assert.equal(formatHotkeyLabelForPlatform("LeftCommand", "darwin"), "Left Cmd");
  assert.equal(formatHotkeyLabelForPlatform("LeftShift", "linux"), "Left Shift");
});

test("bare modifier tokens format like they do inside a chord", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("Alt", "darwin"), "Option");
  assert.equal(formatHotkeyLabelForPlatform("Alt", "win32"), "Alt");
  assert.equal(formatHotkeyLabelForPlatform("Command", "darwin"), "Cmd");
  assert.equal(formatHotkeyLabelForPlatform("Super", "linux"), "Super");
});

test("single keys pass through unchanged", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("`", "darwin"), "`");
  assert.equal(formatHotkeyLabelForPlatform("F8", "win32"), "F8");
});
