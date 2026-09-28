const { Tray, Menu, nativeImage, app, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const dockManager = require("./dockManager");
const { i18nMain } = require("./i18nMain");

// macOS saves the menu-bar position under this GUID, so changing it resets every
// user's placement. Electron lowercases the GUID before handing it to macOS, so
// it stays lowercase here or the position key below matches no item.
const MACOS_TRAY_GUID = "eb809902-04b5-5b08-b12a-f81d6f27e185";
const MACOS_TRAY_POSITION_KEY = `NSStatusItem Preferred Position ${MACOS_TRAY_GUID}`;

class TrayManager {
  constructor() {
    this.tray = null;
    this.controlPanelWindow = null;
    this.windowManager = null;
    this.attachedControlPanels = new WeakSet();
  }

  setControlPanelWindow(controlPanelWindow) {
    this.controlPanelWindow = controlPanelWindow;

    if (this.controlPanelWindow) {
      this.attachControlPanelListeners(this.controlPanelWindow);
    }

    this.updateTrayMenu?.();
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  setCreateControlPanelCallback(callback) {
    this.createControlPanelCallback = callback;
  }

  attachControlPanelListeners(window) {
    if (!window || this.attachedControlPanels.has(window)) {
      return;
    }

    this.attachedControlPanels.add(window);

    window.on("show", () => {
      this.updateTrayMenu?.();
    });

    window.on("hide", () => {
      this.updateTrayMenu?.();
    });

    window.on("minimize", () => {
      this.updateTrayMenu?.();
    });

    window.on("restore", () => {
      this.updateTrayMenu?.();
    });

    window.on("destroyed", () => {
      this.controlPanelWindow = null;
      this.updateTrayMenu?.();
    });
  }

  syncControlPanelWindow() {
    if (this.windowManager) {
      this.controlPanelWindow = this.windowManager.controlPanelWindow || this.controlPanelWindow;
    }
    this.attachControlPanelListeners(this.controlPanelWindow);
    return this.controlPanelWindow;
  }

  isControlPanelVisible() {
    const win = this.syncControlPanelWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  }

  async toggleControlPanelFromTray() {
    if (this.isControlPanelVisible()) {
      this.windowManager?.hideControlPanelToTray();
      return;
    }

    await this.showControlPanelFromTray();
  }

  async showControlPanelFromTray() {
    try {
      this.syncControlPanelWindow();

      if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
        if (this.controlPanelWindow.isMinimized()) {
          this.controlPanelWindow.restore();
        }
        if (!this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
        }
        this.controlPanelWindow.focus();
        dockManager.setControlPanelVisible(true);
        if (this.controlPanelWindow.webContents.isCrashed()) {
          this.controlPanelWindow.webContents.reload();
        }
        return;
      }

      if (this.createControlPanelCallback) {
        await this.createControlPanelCallback();
        this.syncControlPanelWindow();

        if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
          this.controlPanelWindow.show();
          this.controlPanelWindow.focus();
          dockManager.setControlPanelVisible(true);
        }
        return;
      }

      debugLogger.error("No control panel callback available", undefined, "tray");
    } catch (error) {
      debugLogger.error("Failed to open control panel", { error: error?.message }, "tray");
    }
  }

  async createTray() {
    try {
      const trayIcon = await this.loadTrayIcon();
      if (!trayIcon || trayIcon.isEmpty()) {
        debugLogger.error("Failed to load tray icon", undefined, "tray");
        return;
      }

      // The position key is an undocumented AppKit default, so placement is best
      // effort. Position 0 starts the icon as far right as macOS allows, beside
      // the system icons. A registered default only fills in for a missing value,
      // so once the user drags the icon, their saved position wins.
      systemPreferences.registerDefaults({ [MACOS_TRAY_POSITION_KEY]: 0 });
      this.tray = new Tray(trayIcon, MACOS_TRAY_GUID);
      this.tray.setIgnoreDoubleClickEvents(true);

      this.updateTrayMenu();
      this.setupTrayEventHandlers();
    } catch (error) {
      debugLogger.error("Error creating tray icon", { error: error.message }, "tray");
    }
  }

  async loadTrayIcon() {
    const fileName = "iconTemplate@3x.png";
    const candidatePaths =
      process.env.NODE_ENV === "development"
        ? [path.join(__dirname, "..", "assets", fileName)]
        : [
            path.join(process.resourcesPath, "src", "assets", fileName),
            path.join(process.resourcesPath, "assets", fileName),
            path.join(process.resourcesPath, "app.asar.unpacked", "src", "assets", fileName),
            path.join(__dirname, "..", "..", "src", "assets", fileName),
            path.join(app.getAppPath(), "src", "assets", fileName),
          ];

    for (const testPath of candidatePaths) {
      try {
        if (fs.existsSync(testPath)) {
          const icon = nativeImage.createFromPath(testPath);
          if (icon && !icon.isEmpty()) {
            icon.setTemplateImage(true);
            debugLogger.debug("Using tray icon", { path: testPath }, "tray");
            return icon;
          }
        }
      } catch (error) {
        debugLogger.error(
          "Error checking tray icon path",
          { path: testPath, error: error.message },
          "tray"
        );
      }
    }

    debugLogger.error("Could not find tray icon in any expected location", undefined, "tray");
    return this.createFallbackIcon();
  }

  createFallbackIcon() {
    // A minimal 16x16 black square PNG
    const pngData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x91, 0x68, 0x36, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x28, 0x53, 0x63, 0x08,
      0x05, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const fallbackIcon = nativeImage.createFromBuffer(pngData);
    debugLogger.info("Created minimal fallback tray icon", undefined, "tray");
    return fallbackIcon;
  }

  buildContextMenuTemplate() {
    return [
      {
        // Starts in the main process: the recording it opens is policy-gated
        // where it actually begins, in the control panel.
        label: i18nMain.t("app.commandMenu.startMeetingRecording"),
        click: () => this.windowManager?.startManualMeeting(),
      },
      { type: "separator" },
      {
        label: this.isControlPanelVisible()
          ? i18nMain.t("tray.hideControlPanel")
          : i18nMain.t("tray.openControlPanel"),
        click: () => {
          void this.toggleControlPanelFromTray();
        },
      },
      { type: "separator" },
      {
        label: i18nMain.t("tray.quit"),
        click: () => {
          debugLogger.info("Quitting app via tray menu", undefined, "tray");
          app.quit();
        },
      },
    ];
  }

  updateTrayMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate(this.buildContextMenuTemplate());
    this.tray.setToolTip(i18nMain.t("tray.tooltip"));
    this.contextMenu = contextMenu; // fork: TrayCalendar shows it on right click
    if (!this.calendar) this.tray.setContextMenu(contextMenu);
  }

  setupTrayEventHandlers() {
    if (!this.tray) {
      return;
    }

    this.tray.on("destroyed", () => {
      debugLogger.debug("Tray icon destroyed", undefined, "tray");
      this.tray = null;
    });
  }
}

module.exports = TrayManager;
