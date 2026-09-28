const path = require("path");
const { getLinuxSessionInfo } = require("./linuxSession");

const FOCUSLESS_OVERLAY_ROLES = new Set(["main", "notification"]);

function usesGnomeOverlayPolicy(linuxSession) {
  return (
    linuxSession.isWayland &&
    (linuxSession.isGnome || /ubuntu|unity/.test(linuxSession.desktopEnv || ""))
  );
}

function resolveOverlayWindowType({ role, platform, linuxSession }) {
  if (platform === "darwin") return "panel";
  if (platform !== "linux") return "normal";

  // Sway asks wlroots whether an unmanaged XWayland surface wants focus.
  // "toolbar" opts in; "notification" keeps the existing text field focused.
  if (linuxSession.isSway && linuxSession.xwaylandAvailable && FOCUSLESS_OVERLAY_ROLES.has(role)) {
    return "notification";
  }

  if (linuxSession.isKde || (role === "main" && usesGnomeOverlayPolicy(linuxSession))) {
    return "normal";
  }
  return "toolbar";
}

const linuxSession = getLinuxSessionInfo();
const OVERLAY_WINDOW_TYPES = {
  notification: resolveOverlayWindowType({
    role: "notification",
    platform: process.platform,
    linuxSession,
  }),
};

// The expanded flow deliberately uses a denser frame than the main control
// panel. Its typography, cards and spacing are sized for this 1000x740 canvas;
// clampedBounds still handles displays whose work area is smaller.
const ONBOARDING_WINDOW_SIZES = {
  COMPACT: { width: 480, height: 624 },
  EXPANDED: { width: 1000, height: 740 },
};

// Control panel window configuration
const CONTROL_PANEL_CONFIG = {
  width: 1200,
  height: 800,
  // macOS: fully transparent, so nothing paints into the compact onboarding
  // frame's rounded corners. Windows/Linux keep an opaque backing (the renderer
  // paints its own background on top) — see the transparent flag below.
  backgroundColor: process.platform === "darwin" ? "#00000000" : "#1c1c2e",
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    // sandbox: false is required because the preload script bridges IPC
    // between the renderer and main process.
    sandbox: false,
    // webSecurity: false disables same-origin policy. Required because in
    // production the renderer loads from a file:// origin but makes
    // cross-origin fetch calls to Better Auth, Gemini, OpenAI, and Groq APIs
    // directly from the browser. These would be blocked by CORS otherwise.
    webSecurity: false,
    spellcheck: false,
    backgroundThrottling: false,
  },
  title: "Control Panel",
  resizable: true,
  show: false,
  frame: false,
  ...(process.platform === "darwin" && {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
  }),
  // macOS only: transparent so a renderer that insets or rounds itself shows
  // the desktop rather than a square page backing bleeding out behind it. Safe
  // for the other control panel screens because each paints its own opaque
  // background (ControlPanel's root is `bg-background`); only the compact
  // onboarding steps clear body/#root — see index.css. Not on Windows/Linux:
  // transparency is creation-time-only and this window outlives onboarding, and
  // on Windows `transparent` forces thickFrame:false (no maximize/Aero-snap)
  // and renders black when compositing is off. The compact onboarding frame
  // falls back to square corners there by design.
  transparent: process.platform === "darwin",
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
  visibleOnAllWorkspaces: process.platform !== "win32",
  type: OVERLAY_WINDOW_TYPES.notification,
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

  // `level` only applies on macOS; Windows and Linux already use the strongest
  // level their window managers honor.
  static setupAlwaysOnTop(window, { level = "floating" } = {}) {
    if (process.platform === "darwin") {
      // macOS: Use panel level for proper floating behavior
      // This ensures the window stays on top across spaces and fullscreen apps
      window.setAlwaysOnTop(true, level, 1);
      // Re-applying the collection behavior when nothing drifted makes the
      // window server momentarily pull the window out of the active Space,
      // which blinks the entire visible window. Enforce calls land on hot
      // paths (assistant panel open/close, window show), so Spaces membership
      // is only touched when it was actually lost.
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
    } else if (process.platform === "win32") {
      window.setAlwaysOnTop(true, "pop-up-menu");
    } else if (usesGnomeOverlayPolicy(linuxSession)) {
      window.setAlwaysOnTop(true, "floating");
    } else {
      // KDE XWayland and other Linux — "screen-saver" is the strongest z-level
      window.setAlwaysOnTop(true, "screen-saver");
    }
  }
}

module.exports = {
  CONTROL_PANEL_CONFIG,
  ONBOARDING_WINDOW_SIZES,
  NOTIFICATION_WINDOW_CONFIG,
  WindowPositionUtil,
  resolveOverlayWindowType,
};
