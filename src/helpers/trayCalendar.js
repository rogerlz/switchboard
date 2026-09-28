const { BrowserWindow, ipcMain, nativeTheme, screen } = require("electron");
const path = require("path");
const debugLogger = require("./debugLogger");
const DevServerManager = require("./devServerManager");
const { addDays, formatTrayTitle, startOfDay } = require("./trayCalendarModel");

const WIDTH = 360;
const HEIGHT = 600;
const PROVIDERS = ["google", "microsoft", "apple"];
// The popover needs yesterday (shown on click) and as far ahead as sync keeps.
const PAST_DAYS = 1;
const FUTURE_DAYS = 60;
const TITLE_REFRESH_MS = 60 * 1000;
// Clicking the tray icon while the popover is open blurs (hides) it first; a
// click this soon after must not reopen it.
const REOPEN_GUARD_MS = 300;

// Menu-bar calendar popover (fork addition): next meeting as the tray title,
// left click opens a month grid + per-day meeting list with Join.
class TrayCalendar {
  constructor(trayManager, calendarManagers = []) {
    this.trayManager = trayManager;
    this.calendarManagers = calendarManagers.filter(Boolean);
    this.win = null;
    this.hiddenAt = 0;

    ipcMain.handle("tray-calendar-get-events", () => this.getEvents());
    ipcMain.handle("tray-calendar-refresh", () => this.refresh());
    ipcMain.handle("tray-calendar-open-app", () => {
      this.win?.hide();
      return this.trayManager.showControlPanelFromTray();
    });

    const tray = trayManager.tray;
    if (tray) {
      trayManager.calendar = this;
      tray.setContextMenu(null);
      tray.on("click", () => void this.toggle());
      tray.on("right-click", () => tray.popUpContextMenu(trayManager.contextMenu));
    }

    this.refreshTitle();
    setInterval(() => this.refreshTitle(), TITLE_REFRESH_MS).unref?.();
  }

  get databaseManager() {
    return this.trayManager.windowManager?.meetingDetectionEngine?.databaseManager ?? null;
  }

  getEvents() {
    const db = this.databaseManager;
    if (!db) return [];
    const today = startOfDay(new Date());
    try {
      return db.getCalendarEventsInRange(
        addDays(today, -PAST_DAYS).toISOString(),
        addDays(today, FUTURE_DAYS).toISOString(),
        PROVIDERS
      );
    } catch (error) {
      debugLogger.error("Tray calendar events failed", { error: error.message }, "tray");
      return [];
    }
  }

  // Pulls fresh events from every connected calendar; each sync broadcasts its
  // own "events synced" signal, which the popover already listens to.
  async refresh() {
    await Promise.allSettled(
      this.calendarManagers.map((manager) =>
        manager.isConnected?.() === false ? null : manager.refresh()
      )
    );
    this.refreshTitle();
    return this.getEvents();
  }

  refreshTitle() {
    const tray = this.trayManager.tray;
    if (!tray || process.platform !== "darwin") return;
    tray.setTitle(formatTrayTitle(this.getEvents()));
  }

  async toggle() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.hide();
      return;
    }
    if (Date.now() - this.hiddenAt < REOPEN_GUARD_MS) return;

    if (!this.win || this.win.isDestroyed()) {
      this.win = this.createWindow();
      await this.load(this.win);
    }
    this.position();
    this.win.show();
    this.win.focus();
  }

  createWindow() {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff",
      webPreferences: {
        preload: path.join(__dirname, "..", "..", "preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on("blur", () => {
      if (win.isDestroyed() || !win.isVisible()) return;
      this.hiddenAt = Date.now();
      win.hide();
    });
    return win;
  }

  async load(win) {
    try {
      if (process.env.NODE_ENV === "development") {
        await DevServerManager.waitForDevServer();
        await win.loadURL(`${DevServerManager.DEV_SERVER_URL}?tray-calendar=true`);
      } else {
        const fileInfo = DevServerManager.getAppFilePath(false);
        await win.loadFile(fileInfo.path, {
          query: { ...fileInfo.query, "tray-calendar": "true" },
        });
      }
    } catch (error) {
      debugLogger.error("Tray calendar failed to load", { error: error.message }, "tray");
    }
  }

  // Centered under the icon, flipped above it when the tray sits at the
  // bottom (Windows taskbar), clamped to the display's work area.
  position() {
    const tray = this.trayManager.tray;
    if (!tray || !this.win) return;
    const icon = tray.getBounds();
    const { workArea } = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y });
    const x = Math.round(
      Math.min(
        Math.max(icon.x + icon.width / 2 - WIDTH / 2, workArea.x),
        workArea.x + workArea.width - WIDTH
      )
    );
    const below = icon.y < workArea.y + workArea.height / 2;
    const y = below ? Math.max(icon.y + icon.height, workArea.y) + 4 : icon.y - HEIGHT - 4;
    this.win.setPosition(x, Math.round(y), false);
  }
}

module.exports = TrayCalendar;
