const path = require("path");
// Control panel window configuration
const CONTROL_PANEL_CONFIG = {
  width: 1200,
  height: 800,
  // Fully transparent; the renderer paints its own opaque background.
  backgroundColor: "#00000000",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    // sandbox: false is required because the preload script bridges IPC
    // between the renderer and main process.
    sandbox: false,
    // webSecurity: false disables same-origin policy: the renderer loads from
    // a file:// origin in production.
    webSecurity: false,
    spellcheck: false,
    backgroundThrottling: false,
  },
  title: "Control Panel",
  resizable: true,
  show: false,
  frame: false,
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 20, y: 20 },
  // Transparent so a renderer that insets or rounds itself shows the desktop
  // rather than a square page backing bleeding out behind it.
  transparent: true,
  minimizable: true,
  maximizable: true,
  closable: true,
  fullscreenable: true,
  skipTaskbar: false,
  alwaysOnTop: false,
  visibleOnAllWorkspaces: false,
  type: "normal",
};

const NOTIFICATION_WINDOW_CONFIG = {
  width: 392,
  height: 92,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  focusable: false,
  hasShadow: false,
  show: false,
  acceptFirstMouse: true,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  visibleOnAllWorkspaces: true,
  type: "panel",
};

class WindowPositionUtil {
  // Keeps a window's whole frame inside one display's work area. Displays of
  // different sizes leave dead space beside the smaller one, and a window parked
  // there is invisible even though the window server still reports it on screen.
  static clampToWorkArea(bounds, display) {
    const workArea = display.workArea || display.bounds;
    return {
      x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)),
      y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height)),
    };
  }

  static getNotificationPosition(display) {
    const { width, height } = NOTIFICATION_WINDOW_CONFIG;
    const MARGIN = 16;
    const workArea = display.workArea || display.bounds;
    // Clamp to the display, not to zero, or a monitor above the primary one
    // (negative origin) puts the prompt nowhere.
    const bounds = {
      x: workArea.x + workArea.width - width - MARGIN,
      y: workArea.y + MARGIN,
      width,
      height,
    };
    return { ...WindowPositionUtil.clampToWorkArea(bounds, display), width, height };
  }

  static setupAlwaysOnTop(window, { level = "floating" } = {}) {
    // Panel level for proper floating behavior across Spaces and fullscreen apps.
    window.setAlwaysOnTop(true, level, 1);
    // Re-applying the collection behavior when nothing drifted makes the
    // window server momentarily pull the window out of the active Space,
    // which blinks the entire visible window, so Spaces membership is only
    // touched when it was actually lost.
    if (!window.isVisibleOnAllWorkspaces()) {
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true, // Keep Dock/Command-Tab behaviour
      });
    }
    if (window.isFullScreenable()) {
      window.setFullScreenable(false);
    }
    if (window.isVisible()) {
      window.setAlwaysOnTop(true, level, 1);
    }
  }
}

module.exports = {
  CONTROL_PANEL_CONFIG,
  NOTIFICATION_WINDOW_CONFIG,
  WindowPositionUtil,
};
