const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const tls = require("tls");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Extend Node's TLS trust with the OS store so ws and https.get see corporate
// CAs that Chromium already trusts.
try {
  const currentCAs = tls.getCACertificates();
  const systemCAs = tls.getCACertificates("system");
  if (systemCAs?.length) {
    tls.setDefaultCACertificates([...currentCAs, ...systemCAs]);
  }
} catch (err) {
  require("./src/helpers/debugLogger").warn("System CA merge failed; using existing CA list", {
    error: err?.message,
  });
}

const VALID_CHANNELS = new Set(["development", "staging", "production"]);

function isElectronBinaryExec() {
  return (process.execPath || "").toLowerCase().includes("/electron.app/contents/macos/electron");
}

function inferDefaultChannel() {
  if (process.env.NODE_ENV === "development" || process.defaultApp || isElectronBinaryExec()) {
    return "development";
  }
  return "production";
}

function resolveAppChannel() {
  const rawChannel = (process.env.OPENWHISPR_CHANNEL || process.env.VITE_OPENWHISPR_CHANNEL || "")
    .trim()
    .toLowerCase();

  if (VALID_CHANNELS.has(rawChannel)) {
    return rawChannel;
  }

  return inferDefaultChannel();
}

const APP_CHANNEL = resolveAppChannel();
process.env.OPENWHISPR_CHANNEL = APP_CHANNEL;

function configureChannelUserDataPath() {
  if (APP_CHANNEL === "production") {
    return;
  }

  const isolatedPath = path.join(app.getPath("appData"), `Switchboard-${APP_CHANNEL}`);
  app.setPath("userData", isolatedPath);
}

configureChannelUserDataPath();

// Load userData .env (API keys, model selections, etc.) early, before any
// manager reads it.
require("dotenv").config({
  path: path.join(app.getPath("userData"), ".env"),
  override: false,
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

const isLiveWindow = (window) => window && !window.isDestroyed();

// Ensure macOS menus use the proper casing for the app name
if (app.getName() !== "Switchboard") {
  app.setName("Switchboard");
}

// Add global error handling for uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit the process for EPIPE errors as they're harmless
  if (error.code === "EPIPE") {
    return;
  }
  // For other errors, log and continue
  console.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Import helper module classes (but don't instantiate yet - wait for app.whenReady())
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const WhisperManager = require("./src/helpers/whisper");
const ParakeetManager = require("./src/helpers/parakeet");
const DiarizationManager = require("./src/helpers/diarization");
const TrayManager = require("./src/helpers/tray");
const MenuManager = require("./src/helpers/menuManager");
const dockManager = require("./src/helpers/dockManager");
const autoStart = require("./src/helpers/autoStart");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const GoogleCalendarManager = require("./src/helpers/googleCalendarManager");
const MicrosoftCalendarManager = require("./src/helpers/microsoftCalendarManager");
const AppleCalendarManager = require("./src/helpers/appleCalendarManager");
const CalendarReminderScheduler = require("./src/helpers/calendarReminderScheduler");
const MeetingProcessDetector = require("./src/helpers/meetingProcessDetector");
const AudioActivityDetector = require("./src/helpers/audioActivityDetector");
const {
  collectAudioCaptureHelperPids,
  createExcludedProcessIdProvider,
} = require("./src/helpers/electronProcessIds");
const AudioTapManager = require("./src/helpers/audioTapManager");
const MeetingAecManager = require("./src/helpers/meetingAecManager");
const MeetingDetectionEngine = require("./src/helpers/meetingDetectionEngine");
const { i18nMain } = require("./src/helpers/i18nMain");
const sidecarRegistry = require("./src/helpers/sidecarRegistry");
const { reapStaleSidecars } = require("./src/helpers/sidecarReaper");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let databaseManager = null;
let whisperManager = null;
let parakeetManager = null;
let diarizationManager = null;
let trayManager = null;
let googleCalendarManager = null;
let microsoftCalendarManager = null;
let appleCalendarManager = null;
let calendarReminderScheduler = null;
let meetingDetectionEngine = null;
let audioTapManager = null;
let meetingAecManager = null;

// Set up PATH for production builds to find system tools (whisper.cpp, ffmpeg)
function setupProductionPath() {
  if (process.env.NODE_ENV !== "development") {
    const commonPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];

    const currentPath = process.env.PATH || "";
    const pathsToAdd = commonPaths.filter((p) => !currentPath.includes(p));

    if (pathsToAdd.length > 0) {
      process.env.PATH = `${currentPath}:${pathsToAdd.join(":")}`;
    }
  }
}

// Reading the login item touches the OS, and failing to answer "did the session
// start us?" must not stop the app from starting at all. Falling back to false
// just shows the window, which is what every launch did before.
function wasLaunchedAtLoginHidden() {
  try {
    return autoStart.wasLaunchedAtLoginHidden();
  } catch (error) {
    if (debugLogger) debugLogger.warn("Failed to detect a login launch", { error: error?.message });
    return false;
  }
}

function initializeCoreManagers() {
  setupProductionPath();

  debugLogger = require("./src/helpers/debugLogger");
  debugLogger.ensureFileLogging();

  environmentManager = new EnvironmentManager();
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  databaseManager = new DatabaseManager();
  whisperManager = new WhisperManager();
  parakeetManager = new ParakeetManager();
  diarizationManager = new DiarizationManager();
  calendarReminderScheduler = new CalendarReminderScheduler(databaseManager);
  googleCalendarManager = new GoogleCalendarManager(
    databaseManager,
    windowManager,
    calendarReminderScheduler
  );
  microsoftCalendarManager = new MicrosoftCalendarManager(
    databaseManager,
    calendarReminderScheduler
  );
  appleCalendarManager = new AppleCalendarManager(databaseManager, calendarReminderScheduler);
  const meetingProcessDetector = new MeetingProcessDetector();
  meetingDetectionEngine = new MeetingDetectionEngine(
    calendarReminderScheduler,
    meetingProcessDetector,
    new AudioActivityDetector(
      // The capture-helper managers are created a few lines below; the provider
      // is only invoked on mic events, long after initialization completes.
      createExcludedProcessIdProvider(() => collectAudioCaptureHelperPids([audioTapManager])),
      () => meetingProcessDetector.getDetectedProcesses().length > 0
    ),
    windowManager,
    databaseManager
  );
  windowManager.meetingDetectionEngine = meetingDetectionEngine;
  calendarReminderScheduler.meetingDetectionEngine = meetingDetectionEngine;
  audioTapManager = new AudioTapManager();
  meetingAecManager = new MeetingAecManager();

  // IPC handlers must be registered before window content loads
  new IPCHandlers({
    environmentManager,
    databaseManager,
    whisperManager,
    parakeetManager,
    diarizationManager,
    windowManager,
    googleCalendarManager,
    microsoftCalendarManager,
    appleCalendarManager,
    meetingDetectionEngine,
    audioTapManager,
    meetingAecManager,
    getTrayManager: () => trayManager,
  });
}

function registerSidecars() {
  if (whisperManager) sidecarRegistry.register("whisper", () => whisperManager.stopServer());
  if (parakeetManager) sidecarRegistry.register("parakeet", () => parakeetManager.stopServer());
  if (diarizationManager) {
    sidecarRegistry.register("diarization", () => diarizationManager.shutdown());
  }
  const onnxWorkerClient = require("./src/helpers/onnxWorkerClient");
  sidecarRegistry.register("onnx", () => onnxWorkerClient.stop());
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers() {
  trayManager = new TrayManager();

  googleCalendarManager.start();
  microsoftCalendarManager.start();
  appleCalendarManager.start();
  meetingDetectionEngine.start();
}

// Main application startup
async function startApp() {
  // Await so a stale sidecar is confirmed dead before new ones can spawn and
  // contend for its port or storage lock.
  await reapStaleSidecars();

  // Phase 1: Core managers + IPC handlers before windows
  initializeCoreManagers();
  await environmentManager.init();
  registerSidecars();

  ipcMain.on("start-minimized-changed", (_event, enabled) => {
    if (debugLogger) debugLogger.info("Start minimized changed", { enabled });
    environmentManager.saveStartMinimized(enabled);
  });

  // The app menu (macOS) exists independently of any window.
  MenuManager.setupMainMenu(() => windowManager.openSettings());

  dockManager.init();

  // In development, wait for Vite dev server to be ready
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Create windows FIRST so the user sees UI as soon as possible.
  // A login launch goes to the tray whatever the preference says: the user asked
  // the OS to start us, not to put a window in front of them at every login.
  const launchedHidden = wasLaunchedAtLoginHidden();
  const startMinimized = environmentManager.getStartMinimized() || launchedHidden;
  if (debugLogger) debugLogger.info("Start minimized", { enabled: startMinimized, launchedHidden });
  await windowManager.createControlPanelWindow({ hidden: startMinimized });

  // Phase 2: Initialize remaining managers after windows are visible
  initializeDeferredManagers();

  app.on("browser-window-focus", () => {
    if (googleCalendarManager) googleCalendarManager.syncOnFocus();
    if (microsoftCalendarManager) microsoftCalendarManager.syncOnFocus();
    if (appleCalendarManager) appleCalendarManager.syncOnFocus();
  });

  const { powerMonitor } = require("electron");
  powerMonitor.on("resume", () => {
    if (calendarReminderScheduler) calendarReminderScheduler.onWakeFromSleep();
    if (googleCalendarManager) {
      googleCalendarManager.onWakeFromSleep();
    }
    if (microsoftCalendarManager) microsoftCalendarManager.onWakeFromSleep();
    if (appleCalendarManager) appleCalendarManager.onWakeFromSleep();
  });

  whisperManager.initializeAtStartup().catch((err) => {
    debugLogger.debug("Whisper startup init error (non-fatal)", { error: err.message });
  });
  parakeetManager.initializeAtStartup().catch((err) => {
    debugLogger.debug("Parakeet startup init error (non-fatal)", { error: err.message });
  });

  // Auto-download diarization models if binary is available
  if (
    diarizationManager.getBinaryPath() &&
    (!diarizationManager.isModelDownloaded() || !diarizationManager.isVadModelDownloaded())
  ) {
    diarizationManager.downloadModels().catch((err) => {
      debugLogger.debug("Diarization model auto-download error (non-fatal)", {
        error: err.message,
      });
    });
  }

  trayManager.setControlPanelWindow(windowManager.controlPanelWindow);
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() => windowManager.createControlPanelWindow());
  await trayManager.createTray();
  // Menu-bar calendar popover on left click
  new (require("./src/helpers/trayCalendar"))(trayManager, [
    googleCalendarManager,
    microsoftCalendarManager,
    appleCalendarManager,
  ]);
}

// App event handlers
if (gotSingleInstanceLock) {
  app.on("second-instance", async () => {
    await app.whenReady();
    if (!windowManager) {
      return;
    }

    if (isLiveWindow(windowManager.controlPanelWindow)) {
      if (windowManager.controlPanelWindow.isMinimized()) {
        windowManager.controlPanelWindow.restore();
      }
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
      dockManager.setControlPanelVisible(true);
      if (windowManager.controlPanelWindow.webContents.isCrashed()) {
        windowManager.loadControlPanel();
      }
    } else {
      windowManager.createControlPanelWindow();
    }
  });

  app.whenReady().then(() => {
    startApp().catch((error) => {
      console.error("Failed to start app:", error);
      dialog.showErrorBox(
        i18nMain.t("startup.error.title"),
        i18nMain.t("startup.error.message", { error: error.message })
      );
      app.exit(1);
    });
  });

  // Keep running in the menu bar when all windows are closed.
  app.on("window-all-closed", () => {});

  app.on("activate", () => {
    // On macOS, re-create the control panel when the dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      if (windowManager) {
        windowManager.createControlPanelWindow();
      }
    } else {
      // Show control panel when dock icon is clicked (most common user action)
      if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
        if (windowManager.controlPanelWindow.isMinimized()) {
          windowManager.controlPanelWindow.restore();
        }
        windowManager.controlPanelWindow.show();
        windowManager.controlPanelWindow.focus();
        dockManager.setControlPanelVisible(true);
      } else if (windowManager) {
        // If control panel doesn't exist, create it
        windowManager.createControlPanelWindow();
      }
    }
  });

  let isShuttingDown = false;
  app.on("before-quit", (event) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    event.preventDefault();
    performSyncTeardown();
    sidecarRegistry.shutdownAll().finally(() => app.exit(0));
  });
}

function performSyncTeardown() {
  if (meetingDetectionEngine) meetingDetectionEngine.stop();
  if (googleCalendarManager) googleCalendarManager.stop();
  if (microsoftCalendarManager) microsoftCalendarManager.stop();
  if (appleCalendarManager) appleCalendarManager.stop();
  if (calendarReminderScheduler) calendarReminderScheduler.stop();
  if (audioTapManager) audioTapManager.stop().catch(() => {});
  if (meetingAecManager) meetingAecManager.stop().catch(() => {});
}
