const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadTrayWithStubs(request, parent, isMain) {
  if (request === "electron") return { Tray: class {}, Menu: {}, nativeImage: {}, app: {} };
  if (request === "./debugLogger") return { info: () => undefined, debug: () => undefined };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const TrayManager = require("../../src/helpers/tray");
Module._load = originalLoad;

function createTrayManager(calls) {
  const trayManager = new TrayManager();
  trayManager.windowManager = {
    startManualMeeting: () => calls.push("meeting"),
  };
  return trayManager;
}

test("the tray menu leads with starting a meeting recording", () => {
  const calls = [];
  const [meeting, separator] = createTrayManager(calls).buildContextMenuTemplate();

  assert.deepEqual(
    [meeting.label, separator.type],
    ["app.commandMenu.startMeetingRecording", "separator"]
  );

  meeting.click();
  assert.deepEqual(calls, ["meeting"]);
});
