// Chromium picks the display backend before JS runs, so appendSwitch is too
// late — the flag has to come from a relaunch.
const { XWAYLAND_FLAG, shouldForceXWayland } = require("./src/helpers/xwayland");

if (shouldForceXWayland(process.argv)) {
  const { spawn } = require("child_process");
  spawn(process.execPath, [...process.argv.slice(1), XWAYLAND_FLAG], {
    stdio: "inherit",
    detached: true,
  }).unref();
  process.exit(0);
}

const { app, desktopCapturer, BrowserWindow, dialog, ipcMain, session } = require("electron");
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
const BASE_WINDOWS_APP_ID = "com.gizmolabs.openwhispr";

function isElectronBinaryExec() {
  const execPath = (process.execPath || "").toLowerCase();
  return (
    execPath.includes("/electron.app/contents/macos/electron") ||
    execPath.endsWith("/electron") ||
    execPath.endsWith("\\electron.exe")
  );
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

// Chromium's Windows-only occlusion tracker misclassifies the always-on-top
// transparent pill as occluded, throttling its renderer and jittering animations.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

// Fix transparent window flickering on Linux: --enable-transparent-visuals requires
// the compositor to set up an ARGB visual before any windows are created.
// --disable-gpu-compositing prevents GPU compositing conflicts with the compositor.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("gtk-version", "3");
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// Wayland: packaged builds use the wrapper script (scripts/afterPack.js) to
// force --ozone-platform=x11 before Electron starts. appendSwitch below is a
// best-effort fallback for unpackaged dev mode (may not take effect on E39+).
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
}

// Set desktop filename so Wayland compositors can match windows to the .desktop entry.
// This allows XDG portals (e.g. PipeWire) to persist permissions across sessions.
if (process.platform === "linux") {
  app.setDesktopName("open-whispr.desktop");
}

// Group all windows under single taskbar entry on Windows
if (process.platform === "win32") {
  const windowsAppId =
    APP_CHANNEL === "production" ? BASE_WINDOWS_APP_ID : `${BASE_WINDOWS_APP_ID}.${APP_CHANNEL}`;
  app.setAppUserModelId(windowsAppId);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

const isLiveWindow = (window) => window && !window.isDestroyed();

// Ensure macOS menus use the proper casing for the app name
if (process.platform === "darwin" && app.getName() !== "Switchboard") {
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
const UpdateManager = require("./src/updater");
const WhisperCudaManager = require("./src/helpers/whisperCudaManager");
const WhisperVulkanManager = require("./src/helpers/whisperVulkanManager");
const { migrateLegacyBinDir, detectOrphanedGpuPacks } = require("./src/helpers/gpuBinaryManager");
const { resetWhisperGpuFailureOnUpgrade } = require("./src/helpers/whisperGpuUpgradeReset");
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
const LinuxPortalAudioManager = require("./src/helpers/linuxPortalAudioManager");
const WindowsLoopbackAudioManager = require("./src/helpers/windowsLoopbackAudioManager");
const MeetingAecManager = require("./src/helpers/meetingAecManager");
const MeetingDetectionEngine = require("./src/helpers/meetingDetectionEngine");
const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");
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
let updateManager = null;
let whisperCudaManager = null;
let whisperVulkanManager = null;
let googleCalendarManager = null;
let microsoftCalendarManager = null;
let appleCalendarManager = null;
let calendarReminderScheduler = null;
let meetingDetectionEngine = null;
let audioTapManager = null;
let linuxPortalAudioManager = null;
let windowsLoopbackAudioManager = null;
let meetingAecManager = null;
const WHISPER_WAKE_REWARM_DELAY_MS = 3000;
let wakeRewarmTimer = null;

// Set up PATH for production builds to find system tools (whisper.cpp, ffmpeg)
function setupProductionPath() {
  if (process.platform === "darwin" && process.env.NODE_ENV !== "development") {
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

// Phase 1: Initialize managers + IPC handlers before window content loads
// Best-effort cleanup of the orphaned portal restore-token file older builds wrote. See PR #904.
const LINUX_RESTORE_TOKEN_FILENAME = ".linux-system-audio-restore-token.json";

function cleanupOrphanedLinuxRestoreToken() {
  if (process.platform !== "linux") return;
  try {
    const fs = require("fs");
    fs.unlinkSync(path.join(app.getPath("userData"), LINUX_RESTORE_TOKEN_FILENAME));
  } catch {}
}

function syncAutoStartEntry() {
  try {
    if (autoStart.syncAutoStartEntry()) {
      debugLogger.info("Re-pointed the launch-at-login entry at the current executable");
    }
  } catch (error) {
    debugLogger.warn("Failed to sync the launch-at-login entry", { error: error?.message });
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
  const uiLanguage = environmentManager.getUiLanguage(app.getLocale());
  changeLanguage(uiLanguage);
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  databaseManager = new DatabaseManager();
  whisperManager = new WhisperManager();
  if (process.platform !== "darwin") {
    whisperCudaManager = new WhisperCudaManager();
    whisperVulkanManager = new WhisperVulkanManager();
    // Heal installs from before GPU packs got per-pack directories; must run
    // before startup pre-warm resolves any GPU binary path.
    const clearedPacks = migrateLegacyBinDir([whisperCudaManager, whisperVulkanManager]);
    if (clearedPacks.length > 0) {
      // No window exists yet — persist the notice; a control panel window
      // shows it as a toast and clears it. See #1606.
      require("./src/helpers/gpuPackMigrationNotice").record(clearedPacks);
    }
    // The 1.8.3 migration deleted lib-carrying packs without recording that
    // notice, leaving those users on a silent CPU fallback: an enabled flag
    // with no pack on disk only happens via such data loss. recordOnce gates
    // each pack to one notice so a dismissed toast doesn't return every launch.
    const orphanedPacks = detectOrphanedGpuPacks([
      { manager: whisperCudaManager, enabledEnvVar: "WHISPER_CUDA_ENABLED" },
      { manager: whisperVulkanManager, enabledEnvVar: "WHISPER_VULKAN_ENABLED" },
    ]);
    if (orphanedPacks.length > 0) {
      require("./src/helpers/gpuPackMigrationNotice").recordOnce(orphanedPacks);
    }
    // Lets every server start resolve its GPU backend from installed packs
    whisperManager.setGpuBinaryManagers({ cuda: whisperCudaManager, vulkan: whisperVulkanManager });
  }
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
      createExcludedProcessIdProvider(() =>
        collectAudioCaptureHelperPids([
          audioTapManager,
          linuxPortalAudioManager,
          windowsLoopbackAudioManager,
        ])
      ),
      () => meetingProcessDetector.getDetectedProcesses().length > 0
    ),
    windowManager,
    databaseManager
  );
  windowManager.meetingDetectionEngine = meetingDetectionEngine;
  calendarReminderScheduler.meetingDetectionEngine = meetingDetectionEngine;
  updateManager = new UpdateManager();
  updateManager.setWindowManager(windowManager);
  audioTapManager = new AudioTapManager();
  linuxPortalAudioManager = new LinuxPortalAudioManager();
  windowsLoopbackAudioManager = new WindowsLoopbackAudioManager();
  // Warm the capability cache off the hot path so the first meeting start
  // doesn't pay the probe spawn. No-ops on non-Windows.
  windowsLoopbackAudioManager.getCapability().catch(() => {});
  cleanupOrphanedLinuxRestoreToken();
  syncAutoStartEntry();
  meetingAecManager = new MeetingAecManager();

  // IPC handlers must be registered before window content loads
  new IPCHandlers({
    environmentManager,
    databaseManager,
    whisperManager,
    parakeetManager,
    diarizationManager,
    windowManager,
    updateManager,
    whisperCudaManager,
    whisperVulkanManager,
    googleCalendarManager,
    microsoftCalendarManager,
    appleCalendarManager,
    meetingDetectionEngine,
    audioTapManager,
    linuxPortalAudioManager,
    windowsLoopbackAudioManager,
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
  // After any upgrade the GPU gets one fresh attempt: clear the remembered
  // failure before the whisper pre-warm below resolves its GPU backend.
  resetWhisperGpuFailureOnUpgrade(environmentManager);
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
    // Sleep evicts the local GPU model from VRAM; reload it once the driver settles. See #766.
    if (wakeRewarmTimer) clearTimeout(wakeRewarmTimer);
    wakeRewarmTimer = setTimeout(() => {
      wakeRewarmTimer = null;
      whisperManager?.onWakeFromSleep().catch((err) => {
        debugLogger.debug("whisper wake re-warm error (non-fatal)", { error: err.message });
      });
    }, WHISPER_WAKE_REWARM_DELAY_MS);
  });

  // Non-blocking server pre-warming; GPU backend resolved by the manager
  const whisperSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    whisperModel: process.env.LOCAL_WHISPER_MODEL,
  };
  whisperManager.initializeAtStartup(whisperSettings).catch((err) => {
    debugLogger.debug("Whisper startup init error (non-fatal)", { error: err.message });
  });

  const parakeetSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    parakeetModel: process.env.PARAKEET_MODEL,
    language: process.env.DICTATION_LANGUAGE,
  };
  parakeetManager.initializeAtStartup(parakeetSettings).catch((err) => {
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
  // fork: menu-bar calendar popover on left click (macOS)
  if (process.platform === "darwin") new (require("./src/helpers/trayCalendar"))(trayManager);

  // fork: no update checks; upstream releases would replace this build
  // updateManager.checkForUpdatesOnStartup();
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

  app
    .whenReady()
    .then(() => {
      // On Linux, --enable-transparent-visuals requires a short delay before creating
      // windows to allow the compositor to set up the ARGB visual correctly.
      // Without this delay, transparent windows flicker on both X11 and Wayland.
      const delay = process.platform === "linux" ? 300 : 0;
      return new Promise((resolve) => setTimeout(resolve, delay));
    })
    .then(() => {
      if (process.platform === "win32") {
        session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
          // Only the loopback audio track is used; the video source is
          // discarded by the renderer, so skip thumbnail generation.
          desktopCapturer
            .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
            .then((sources) => {
              if (sources.length > 0) {
                callback({ video: sources[0], audio: "loopback" });
              } else {
                callback(null);
              }
            })
            .catch((error) => {
              console.error("Display media request failed:", error);
              callback(null);
            });
        });
      }

      startApp().catch((error) => {
        console.error("Failed to start app:", error);
        dialog.showErrorBox(
          i18nMain.t("startup.error.title"),
          i18nMain.t("startup.error.message", { error: error.message })
        );
        app.exit(1);
      });
    });

  app.on("window-all-closed", () => {
    // Don't quit on macOS when all windows are closed
    // The app should stay in the dock/menu bar
    if (process.platform !== "darwin") {
      app.quit();
    }
    // On macOS, keep the app running even without windows
  });

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
    if (updateManager && updateManager.isQuittingForUpdate) {
      // Quit must proceed for the installer to run, so no preventDefault;
      // sidecar shutdown is best-effort (the reaper cleans up orphans on relaunch).
      performSyncTeardown();
      sidecarRegistry.shutdownAll().catch(() => {});
      return;
    }
    event.preventDefault();
    performSyncTeardown();
    sidecarRegistry.shutdownAll().finally(() => app.exit(0));
  });
}

function performSyncTeardown() {
  if (wakeRewarmTimer) {
    clearTimeout(wakeRewarmTimer);
    wakeRewarmTimer = null;
  }
  if (meetingDetectionEngine) meetingDetectionEngine.stop();
  if (googleCalendarManager) googleCalendarManager.stop();
  if (microsoftCalendarManager) microsoftCalendarManager.stop();
  if (appleCalendarManager) appleCalendarManager.stop();
  if (calendarReminderScheduler) calendarReminderScheduler.stop();
  if (audioTapManager) audioTapManager.stop().catch(() => {});
  if (linuxPortalAudioManager) linuxPortalAudioManager.stop().catch(() => {});
  if (windowsLoopbackAudioManager) windowsLoopbackAudioManager.stop().catch(() => {});
  if (meetingAecManager) meetingAecManager.stop().catch(() => {});
  if (updateManager) updateManager.cleanup();
}
