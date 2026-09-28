// Launch at login via setLoginItemSettings, which routes through SMAppService on
// macOS 13+. openAsHidden is a no-op there, so wasOpenedAtLogin is what sends a
// login launch to the tray.

const { app } = require("electron");

// macOS 13+ can register an item and still leave it awaiting approval in
// System Settings. Unsurfaced, that just looks like a toggle that will not stick.
function getAutoStartState() {
  const settings = app.getLoginItemSettings();
  return {
    enabled: !!settings.openAtLogin,
    requiresApproval: settings.status === "requires-approval",
  };
}

function setAutoStartEnabled(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

function wasLaunchedAtLoginHidden() {
  return !!app.getLoginItemSettings().wasOpenedAtLogin;
}

module.exports = { getAutoStartState, setAutoStartEnabled, wasLaunchedAtLoginHidden };
