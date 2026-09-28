const { app, screen, BrowserWindow, dialog } = require("electron");
const debugLogger = require("./debugLogger");
// Aliased: this class has an openExternalUrl method wrapping the helper.
const { openExternalUrl: openUrlInExternalBrowser } = require("./externalUrlOpener");
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const { isAllowedAppNavigation, isExternalBrowserUrl } = require("./navigationGuard");
const { pathToFileURL } = require("url");
const dockManager = require("./dockManager");
const { i18nMain } = require("./i18nMain");
const { NotificationDismissTimer, getNotificationTimeoutMs } = require("./notificationTimer");
const {
  CONTROL_PANEL_CONFIG,
  NOTIFICATION_WINDOW_CONFIG,
  WindowPositionUtil,
} = require("./windowConfig");

class WindowManager {
  constructor() {
    this.controlPanelWindow = null;
    this._controlPanelVisibilityTimer = null;
    // Gates the meeting prompt and manual meeting starts until the control
    // panel renderer has mounted and reported ready.
    this._controlPanelReady = true;
    this.notificationWindow = null;
    this._notificationDismissTimer = new NotificationDismissTimer(() => {
      // Dismiss first: a prompt raised from the timeout handler must not be
      // closed by this dismissal. The engine is not told the card closed either —
      // handleNotificationTimeout below settles this expiry, and a close report
      // here would flush the queue into a card that handler is about to clear.
      this.dismissMeetingNotification({ notifyEngine: false });
      this.meetingDetectionEngine?.handleNotificationTimeout();
    });
    this.notificationPrefs = {
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      notifyCalendarReminders: true,
    };
    this.tray = null;
    this.dragManager = new DragManager();
    this.isQuitting = false;
    this.loadErrorShown = false;
    this._pendingMeetingNoteNavigation = null;
    this._pendingNoteNavigation = null;

    app.on("before-quit", () => {
      this.isQuitting = true;
    });
  }

  // Only the meeting prompt owns this: another overlay reporting its own hover
  // must not pause a countdown it cannot resume — it may be destroyed before
  // its pointer ever leaves.
  setNotificationInteractivity(sender, interactive) {
    const win = this.notificationWindow;
    if (!win || win.isDestroyed() || sender !== win.webContents) {
      return;
    }
    if (interactive) {
      win.setIgnoreMouseEvents(false);
      this._notificationDismissTimer.pause();
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
      this._notificationDismissTimer.resume();
    }
  }

  async loadWindowContent(window, isControlPanel = false) {
    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel);
      await DevServerManager.waitForDevServer();
      await window.loadURL(appUrl);
    } else {
      const fileInfo = DevServerManager.getAppFilePath(isControlPanel);
      if (!fileInfo) {
        throw new Error("Failed to get app file path");
      }

      const fs = require("fs");
      if (!fs.existsSync(fileInfo.path)) {
        throw new Error(`HTML file not found: ${fileInfo.path}`);
      }

      await window.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  // The one entry for starting a meeting by hand (the tray).
  async startManualMeeting() {
    if (!this._controlPanelReady) return;
    try {
      await this.meetingDetectionEngine?.startManualMeeting();
    } catch (error) {
      debugLogger.error("Failed to start manual meeting", { error: error.message }, "meeting");
    }
  }

  // The control panel is transparent on macOS, where Electron ignores
  // `-webkit-app-region: drag` entirely — the renderer recreates its titlebar
  // drag through the shared DragManager instead (useControlPanelWindowDrag).
  // No pill bookkeeping: position ownership below is main-window-only.
  async startControlPanelDrag() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }
    return await this.dragManager.startWindowDrag(this.controlPanelWindow);
  }

  async stopControlPanelDrag() {
    return await this.dragManager.stopWindowDrag();
  }

  openExternalUrl(url, showError = true) {
    openUrlInExternalBrowser(url).catch((error) => {
      if (showError) {
        dialog.showErrorBox(
          i18nMain.t("dialog.openLink.title"),
          i18nMain.t("dialog.openLink.message", { url, error: error.message })
        );
      }
    });
  }

  // `hidden` creates the window without ever auto-showing it (start minimized,
  // login launch): meeting detection and prompts need a live renderer even
  // while the app sits in the tray.
  async createControlPanelWindow({ hidden = false } = {}) {
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      if (this.controlPanelWindow.isMinimized()) {
        this.controlPanelWindow.restore();
      }
      if (!this.controlPanelWindow.isVisible()) {
        this.controlPanelWindow.show();
      }
      this.controlPanelWindow.focus();
      dockManager.setControlPanelVisible(true);
      return;
    }

    this.controlPanelWindow = new BrowserWindow(CONTROL_PANEL_CONFIG);

    this.controlPanelWindow.webContents.on("will-navigate", (event, url) => {
      // getAppUrl() is null in packaged builds; exactly one of the two is set.
      const appUrl =
        DevServerManager.getAppUrl(true) ??
        pathToFileURL(DevServerManager.getAppFilePath(true).path).href;

      if (isAllowedAppNavigation(url, appUrl)) {
        return;
      }

      event.preventDefault();
      if (isExternalBrowserUrl(url)) {
        this.openExternalUrl(url);
      } else {
        debugLogger.debug("Blocked untrusted navigation", { url }, "window");
      }
    });

    this.controlPanelWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternalUrl(url);
      return { action: "deny" };
    });

    this.controlPanelWindow.webContents.on("did-create-window", (childWindow, details) => {
      childWindow.close();
      if (details.url && !details.url.startsWith("devtools://")) {
        this.openExternalUrl(details.url, false);
      }
    });

    // The renderer shows this window once it has mounted (control-panel-ready).
    // This timer is the backstop if it never gets that far — it loads but
    // throws or a lazy chunk fails — so it must outlive did-finish-load. Only a
    // real show cancels it.
    this._startHidden = hidden;
    if (!hidden) {
      this._controlPanelVisibilityTimer = setTimeout(() => {
        this._showControlPanel();
      }, 10000);
    }

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hideControlPanelToTray();
      }
    });

    this.controlPanelWindow.on("closed", () => {
      this._clearControlPanelVisibilityTimer();
      this.controlPanelWindow = null;
      this.setControlPanelReady(false);
      dockManager.setControlPanelVisible(false);
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      // Every fresh document starts unready. AppRouter releases the gate once
      // it has mounted, so a reload cannot surface meeting prompts before the
      // panel that handles them is ready.
      this.setControlPanelReady(false);
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (process.env.NODE_ENV !== "development") {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }
        // Show it regardless: a failed load can't reach the renderer path that
        // normally does, and a hidden window leaves the failure invisible.
        this._showControlPanel();
      }
    );

    this.controlPanelWindow.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "crashed" || details.reason === "killed" || details.reason === "oom") {
        debugLogger.error(
          "Control panel renderer process gone",
          { reason: details.reason, exitCode: details.exitCode },
          "window"
        );
        setTimeout(() => this.loadControlPanel(), 1000);
      }
    });

    this.controlPanelWindow.on("show", () => {
      if (this.controlPanelWindow.webContents.isCrashed()) {
        debugLogger.error("Control panel crashed, reloading on show", undefined, "window");
        this.loadControlPanel();
      }
    });

    await this.loadControlPanel();
  }

  async loadControlPanel() {
    await this.loadWindowContent(this.controlPanelWindow, true);
  }

  setControlPanelReady(ready) {
    const nextReady = ready === true;
    if (nextReady === this._controlPanelReady) return;
    this._controlPanelReady = nextReady;
    if (nextReady) this._showControlPanel();
    else this.dismissMeetingNotification({ flushQueued: false });
  }

  _clearControlPanelVisibilityTimer() {
    clearTimeout(this._controlPanelVisibilityTimer);
    this._controlPanelVisibilityTimer = null;
  }

  _showControlPanel() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    // Cancel the backstop either way: once the window has been shown on purpose,
    // a later timer firing could pull it back out of the tray.
    this._clearControlPanelVisibilityTimer();
    // A hidden start swallows the renderer's first ready show.
    if (this._startHidden) {
      this._startHidden = false;
      return;
    }
    if (win.isVisible()) return;
    win.show();
    win.focus();
    dockManager.setControlPanelVisible(true);
  }

  hideControlPanelToTray() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    // An explicit hide is authoritative: the visibility backstop exists to
    // rescue a window that never got shown, and letting it fire now would
    // pull the panel (and the Dock icon) back out of the tray.
    this._clearControlPanelVisibilityTimer();
    this.controlPanelWindow.hide();
    dockManager.setControlPanelVisible(false);
  }

  async showMeetingNotification(promptData, { autoDismiss = true } = {}) {
    if (!this._controlPanelReady) return false;
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      const previousWindow = this.notificationWindow;
      this.notificationWindow = null;
      this._pendingNotificationData = null;
      previousWindow.close();
    }
    this._notificationDismissTimer.cancel();
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }

    const display = screen.getPrimaryDisplay();
    const position = WindowPositionUtil.getNotificationPosition(display);

    const win = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      ...position,
    });
    this.notificationWindow = win;

    // "closed" fires asynchronously, so a replaced prompt's window emits it
    // after the replacement already took over the reference and the countdown.
    win.on("closed", () => {
      if (this.notificationWindow !== win) return;
      const closedDetectionId = this._pendingNotificationData?.detectionId ?? null;
      this.notificationWindow = null;
      this._pendingNotificationData = null;
      this._notificationDismissTimer.cancel();
      if (this._notificationReadyFallback) {
        clearTimeout(this._notificationReadyFallback);
        this._notificationReadyFallback = null;
      }
      if (closedDetectionId) {
        this.meetingDetectionEngine?.handleDetectionNotificationClosed?.(closedDetectionId);
      }
    });

    win.setContentProtection(true);

    win.setIgnoreMouseEvents(true, { forward: true });

    // Notifications must clear every other window.
    WindowPositionUtil.setupAlwaysOnTop(win, { level: "screen-saver" });

    this._pendingNotificationData = promptData;

    // Everything past the load addresses `win` directly: a replacement taking
    // over mid-load must not have this prompt's data, countdown or force-show
    // applied to its window.
    try {
      if (process.env.NODE_ENV === "development") {
        await DevServerManager.waitForDevServer();
        if (this.notificationWindow !== win) return false;
        await win.loadURL(`${DevServerManager.DEV_SERVER_URL}?meeting-notification=true`);
      } else {
        const fileInfo = DevServerManager.getAppFilePath(false);
        await win.loadFile(fileInfo.path, {
          query: { ...fileInfo.query, "meeting-notification": "true" },
        });
      }
    } catch (error) {
      // A load aborted by our own replacement or dismissal is not a failure —
      // but the caller must still learn the notification never appeared.
      if (this.notificationWindow !== win) return false;
      this.dismissMeetingNotification();
      throw error;
    }
    if (this.notificationWindow !== win) return false;
    if (!this._controlPanelReady) {
      this.dismissMeetingNotification();
      return false;
    }

    const readyFallback = setTimeout(() => {
      if (this._notificationReadyFallback !== readyFallback) return;
      this._notificationReadyFallback = null;
      if (!this._controlPanelReady || this.notificationWindow !== win || win.isDestroyed()) return;
      debugLogger.warn("Notification renderer did not signal ready, force-showing", {}, "meeting");
      win.webContents.send("meeting-notification-data", promptData);
      win.showInactive();
    }, 3000);
    this._notificationReadyFallback = readyFallback;

    if (autoDismiss) {
      this._notificationDismissTimer.start(getNotificationTimeoutMs(promptData.source));
    }
    return true;
  }

  // Only the window that loaded the prompt may reveal it: a stale window's late
  // "ready" must not clear the fallback that would force-show its replacement.
  showNotificationWindow(ownerWebContents) {
    if (!this._controlPanelReady) {
      this.dismissMeetingNotification();
      return;
    }
    const win = this.notificationWindow;
    if (!win || win.isDestroyed() || (ownerWebContents && win.webContents !== ownerWebContents)) {
      return;
    }

    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    win.showInactive();
  }

  dismissMeetingNotification({ notifyEngine = true, flushQueued = true } = {}) {
    const notification = this._pendingNotificationData;
    this._pendingNotificationData = null;
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    this._notificationDismissTimer.cancel();
    const win = this.notificationWindow;
    this.notificationWindow = null;
    if (win && !win.isDestroyed()) win.close();
    if (notifyEngine && notification?.detectionId) {
      this.meetingDetectionEngine?.handleDetectionNotificationClosed?.(notification.detectionId, {
        flushQueued,
      });
    }
  }

  sendToControlPanel(channel, data) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => {
        if (!win.isDestroyed()) win.webContents.send(channel, data);
      });
    } else {
      win.webContents.send(channel, data);
    }
  }

  async queueMeetingNoteNavigation(payload) {
    this._pendingMeetingNoteNavigation = payload;
    await this.createControlPanelWindow();
    this.sendToControlPanel("meeting-note-navigation-pending");
  }

  consumePendingMeetingNoteNavigation() {
    const payload = this._pendingMeetingNoteNavigation;
    this._pendingMeetingNoteNavigation = null;
    return payload;
  }

  async queueNoteNavigation(payload) {
    this._pendingNoteNavigation = payload;
    await this.createControlPanelWindow();
    this.sendToControlPanel("note-navigation-pending");
  }

  consumePendingNoteNavigation() {
    const payload = this._pendingNoteNavigation;
    this._pendingNoteNavigation = null;
    return payload;
  }

  snapControlPanelToMeetingMode() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    this._preMeetingBounds = win.getBounds();
    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const width = Math.round(workArea.width / 3);
    win.setBounds({
      x: workArea.x + workArea.width - width,
      y: workArea.y,
      width,
      height: workArea.height,
    });
    win.focus();
  }

  restoreControlPanelFromMeetingMode() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    if (this._preMeetingBounds) {
      win.setBounds(this._preMeetingBounds);
      this._preMeetingBounds = null;
    } else {
      const { width, height } = CONTROL_PANEL_CONFIG;
      win.setSize(width, height);
      win.center();
    }
  }

  async openSettings() {
    await this.createControlPanelWindow();
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      this.controlPanelWindow.webContents.send("show-settings");
    }
  }

  showLoadFailureDialog(windowName, errorCode, errorDescription, validatedURL) {
    if (this.loadErrorShown) {
      return;
    }
    this.loadErrorShown = true;
    const detailLines = [
      i18nMain.t("dialog.loadFailure.detail.window", { windowName }),
      i18nMain.t("dialog.loadFailure.detail.error", { errorCode, errorDescription }),
      validatedURL ? i18nMain.t("dialog.loadFailure.detail.url", { url: validatedURL }) : null,
      i18nMain.t("dialog.loadFailure.detail.hint"),
    ].filter(Boolean);
    dialog.showMessageBox({
      type: "error",
      title: i18nMain.t("dialog.loadFailure.title"),
      message: i18nMain.t("dialog.loadFailure.message"),
      detail: detailLines.join("\n"),
    });
  }
}

module.exports = WindowManager;
