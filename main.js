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

const { app, desktopCapturer, BrowserWindow, dialog, ipcMain, net, session } = require("electron");
const path = require("path");
const http = require("http");
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
const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = {
  development: "openwhispr-dev",
  staging: "openwhispr-staging",
  production: "openwhispr",
};
const BASE_WINDOWS_APP_ID = "com.gizmolabs.openwhispr";
const DEFAULT_AUTH_BRIDGE_PORT = 5199;

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

  const isolatedPath = path.join(app.getPath("appData"), `OpenWhispr-${APP_CHANNEL}`);
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

function getOAuthProtocol() {
  const fromEnv = (process.env.VITE_OPENWHISPR_PROTOCOL || process.env.OPENWHISPR_PROTOCOL || "")
    .trim()
    .toLowerCase();

  if (/^[a-z][a-z0-9+.-]*$/.test(fromEnv)) {
    return fromEnv;
  }

  return (
    DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL[APP_CHANNEL] || DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL.production
  );
}

const OAUTH_PROTOCOL = getOAuthProtocol();

const { registerLinuxUrlSchemeHandler } = require("./src/helpers/linuxUrlSchemeHandler");

function shouldRegisterProtocolWithAppArg() {
  return Boolean(process.defaultApp) || isElectronBinaryExec();
}

function getDefaultHtmlHandler() {
  try {
    const { execFileSync } = require("child_process");
    return (
      execFileSync("xdg-mime", ["query", "default", "text/html"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function restoreHtmlHandlerIfChanged(original) {
  try {
    const { execFileSync } = require("child_process");
    const current = execFileSync("xdg-mime", ["query", "default", "text/html"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (current && current !== original) {
      execFileSync("xdg-mime", ["default", original, "text/html"], { timeout: 3000 });
    }
  } catch {
    // xdg-mime unavailable or failed
  }
}

// True source of truth for whether openwhispr:// resolves on Linux — the same
// MIME database xdg-open consults. Returns true for deb/rpm/flatpak/AUR installs
// (scheme registered via the packaged .desktop MimeType; registerLinuxUrlSchemeHandler
// first takes it back from an AppImage/tar.gz entry) and false for AppImage/tar.gz
// runs whose own registration failed, so we never enable a dead-end OAuth flow.
// Used to recover from setAsDefaultProtocolClient's KDE false negative.
function isOAuthSchemeRegistered() {
  if (process.platform !== "linux") return false;
  try {
    const { execFileSync } = require("child_process");
    const handler = execFileSync(
      "xdg-mime",
      ["query", "default", `x-scheme-handler/${OAUTH_PROTOCOL}`],
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    return handler.length > 0;
  } catch {
    return false;
  }
}

// In development, always include the app path argument so macOS/Windows/Linux
// can launch the project app instead of opening bare Electron.
function getProtocolAppArgs() {
  if (!shouldRegisterProtocolWithAppArg()) return [];
  return [process.argv[1] ? path.resolve(process.argv[1]) : path.resolve(".")];
}

// Register custom protocol for OAuth callbacks.
function registerOpenWhisprProtocol() {
  const protocol = OAUTH_PROTOCOL;
  const htmlHandler = process.platform === "linux" ? getDefaultHtmlHandler() : null;
  const appArgs = getProtocolAppArgs();

  let result;
  if (appArgs.length > 0) {
    result = app.setAsDefaultProtocolClient(protocol, process.execPath, appArgs);
  } else {
    result = app.setAsDefaultProtocolClient(protocol);
  }

  if (htmlHandler) {
    restoreHtmlHandlerIfChanged(htmlHandler);
  }

  return result;
}

// On Linux, setAsDefaultProtocolClient can only name open-whispr.desktop, which
// AppImage and tar.gz installs don't have, so those (and development) register
// their own handler entry first and skip it. Otherwise it runs as before, and
// since it returns a false negative on KDE/Wayland, fall back to probing the
// system MIME database for an actual handler. This keeps OAuth enabled where the
// callback can resolve and correctly gated where it can't.
const linuxSchemeHandler =
  process.platform === "linux"
    ? registerLinuxUrlSchemeHandler(OAUTH_PROTOCOL, getProtocolAppArgs())
    : null;
const protocolRegistered =
  linuxSchemeHandler?.registered || registerOpenWhisprProtocol() || isOAuthSchemeRegistered();
if (!protocolRegistered) {
  console.warn(`[Auth] Failed to register ${OAUTH_PROTOCOL}:// protocol handler`);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

const isLiveWindow = (window) => window && !window.isDestroyed();

// Ensure macOS menus use the proper casing for the app name
if (process.platform === "darwin" && app.getName() !== "OpenWhispr") {
  app.setName("OpenWhispr");
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
const ClipboardManager = require("./src/helpers/clipboard");
const WhisperManager = require("./src/helpers/whisper");
const ParakeetManager = require("./src/helpers/parakeet");
const DiarizationManager = require("./src/helpers/diarization");
const TrayManager = require("./src/helpers/tray");
const MenuManager = require("./src/helpers/menuManager");
const dockManager = require("./src/helpers/dockManager");
const autoStart = require("./src/helpers/autoStart");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const UpdateManager = require("./src/updater");
const DevServerManager = require("./src/helpers/devServerManager");
const TextEditMonitor = require("./src/helpers/textEditMonitor");
const SelectionManager = require("./src/helpers/selectionManager");
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
const { applyOpenWhisprOriginHeader } = require("./src/helpers/sessionHeaders");
const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");
const { ensureYdotool } = require("./src/helpers/ensureYdotool");
const sidecarRegistry = require("./src/helpers/sidecarRegistry");
const { reapStaleSidecars } = require("./src/helpers/sidecarReaper");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let databaseManager = null;
let clipboardManager = null;
let whisperManager = null;
let parakeetManager = null;
let diarizationManager = null;
let trayManager = null;
let updateManager = null;
let textEditMonitor = null;
let selectionManager = null;
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
let ipcHandlers = null;
let authBridgeServer = null;
let pendingNoteCloudId = null;
let pendingNoteRetryTimer = null;
let pendingNoteRetryCount = 0;
const WHISPER_WAKE_REWARM_DELAY_MS = 3000;
let wakeRewarmTimer = null;

function parseAuthBridgePort() {
  const raw = (process.env.OPENWHISPR_AUTH_BRIDGE_PORT || "").trim();
  if (!raw) return DEFAULT_AUTH_BRIDGE_PORT;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_AUTH_BRIDGE_PORT;
  }

  return parsed;
}

const AUTH_BRIDGE_HOST = "127.0.0.1";
const AUTH_BRIDGE_PORT = parseAuthBridgePort();
const AUTH_BRIDGE_PATH = "/oauth/callback";

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
  // Registration runs before app ready, when the logger cannot write its file yet.
  if (linuxSchemeHandler?.reason) {
    debugLogger.warn("Could not register the Linux URL scheme handler entry", {
      protocol: OAUTH_PROTOCOL,
      reason: linuxSchemeHandler.reason,
      protocolRegistered,
    });
  }

  environmentManager = new EnvironmentManager();
  const uiLanguage = environmentManager.getUiLanguage(app.getLocale());
  changeLanguage(uiLanguage);
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  databaseManager = new DatabaseManager();
  // Restore the last validated account scope before any window, IPC handler,
  // or meeting flow can read or create notes. Offline launches keep the
  // account's data visible; a stale or rotated credential fails the hash
  // check and restores nothing.
  const accountScopeBinding = require("./src/helpers/accountScopeBinding");
  const bootAccountId = accountScopeBinding.resolveBootAccountScope({
    token: require("./src/helpers/tokenStore").get(),
    binding: accountScopeBinding.read(),
  });
  if (bootAccountId) databaseManager.setActiveAccountId(bootAccountId);
  clipboardManager = new ClipboardManager();
  whisperManager = new WhisperManager();
  if (process.platform !== "darwin") {
    whisperCudaManager = new WhisperCudaManager();
    whisperVulkanManager = new WhisperVulkanManager();
    // Heal installs from before GPU packs got per-pack directories; must run
    // before startup pre-warm resolves any GPU binary path.
    const LlamaVulkanManager = require("./src/helpers/llamaVulkanManager");
    const llamaVulkanManager = new LlamaVulkanManager();
    const clearedPacks = migrateLegacyBinDir([
      whisperCudaManager,
      whisperVulkanManager,
      llamaVulkanManager,
    ]);
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
      { manager: llamaVulkanManager, enabledEnvVar: "LLAMA_VULKAN_ENABLED" },
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
  textEditMonitor = new TextEditMonitor();
  selectionManager = new SelectionManager({ clipboardManager, textEditMonitor });
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
  ipcHandlers = new IPCHandlers({
    environmentManager,
    databaseManager,
    clipboardManager,
    whisperManager,
    parakeetManager,
    diarizationManager,
    windowManager,
    updateManager,
    textEditMonitor,
    selectionManager,
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
    oauthProtocolRegistered: protocolRegistered,
    oauthProtocol: OAUTH_PROTOCOL,
  });
}

function registerSidecars() {
  if (whisperManager) sidecarRegistry.register("whisper", () => whisperManager.stopServer());
  if (parakeetManager) sidecarRegistry.register("parakeet", () => parakeetManager.stopServer());
  if (diarizationManager) {
    sidecarRegistry.register("diarization", () => diarizationManager.shutdown());
  }
  const modelManager = require("./src/helpers/modelManagerBridge").default;
  sidecarRegistry.register("llama", () => modelManager.stopServer());
  const onnxWorkerClient = require("./src/helpers/onnxWorkerClient");
  sidecarRegistry.register("onnx", () => onnxWorkerClient.stop());
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers() {
  ensureYdotool().catch((err) => {
    require("./src/helpers/debugLogger").warn(
      "ydotool setup error",
      { error: err?.message },
      "clipboard"
    );
  });
  if (process.platform !== "darwin") {
    clipboardManager.preWarmAccessibility();
  }
  trayManager = new TrayManager();

  googleCalendarManager.start();
  microsoftCalendarManager.start();
  appleCalendarManager.start();
  meetingDetectionEngine.start();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!url.startsWith(`${OAUTH_PROTOCOL}://`)) return;

  if (url.includes("upgrade-success")) {
    handleUpgradeDeepLink();
    return;
  }

  if (isNoteDeepLink(url)) {
    void handleNoteDeepLink(url);
    return;
  }

  if (isInvitationDeepLink(url)) {
    handleInvitationDeepLink(url);
    return;
  }

  void handleOAuthDeepLink(url);

  if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
    dockManager.setControlPanelVisible(true);
  }
});

function isInvitationDeepLink(url) {
  return url.slice(`${OAUTH_PROTOCOL}://`.length).startsWith("invitations/");
}

// Deep links can arrive before windowManager exists (cold start) or before the
// renderer has mounted its listener. The token is stashed here and the renderer
// pulls it via `get-pending-invitation-token` on mount; the push below is a
// best-effort fast path for an already-running app.
let pendingInvitationDeepLinkToken = null;

ipcMain.handle("get-pending-invitation-token", () => {
  const token = pendingInvitationDeepLinkToken;
  pendingInvitationDeepLinkToken = null;
  return token;
});

function isNoteDeepLink(url) {
  return url.slice(`${OAUTH_PROTOCOL}://`.length).startsWith("notes/");
}

function parseNoteCloudId(deepLinkUrl) {
  try {
    const match = deepLinkUrl.match(/notes\/([^/?#]+)/);
    const cloudId = match?.[1] ? decodeURIComponent(match[1]) : "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cloudId)
      ? cloudId
      : null;
  } catch {
    return null;
  }
}

function clearPendingNoteDeepLink() {
  clearTimeout(pendingNoteRetryTimer);
  pendingNoteRetryTimer = null;
  pendingNoteCloudId = null;
  pendingNoteRetryCount = 0;
}

async function flushPendingNoteDeepLink() {
  if (!pendingNoteCloudId || !windowManager || !databaseManager) return;

  try {
    // Surface the panel on the first attempt only; retries just poll the
    // database so they can't repeatedly steal focus.
    if (pendingNoteRetryCount === 0) {
      await windowManager.createControlPanelWindow();
    }

    const note = databaseManager.getNoteByCloudId(pendingNoteCloudId);
    if (!note) {
      // Cloud sync may still be hydrating during a cold launch. Retry briefly so
      // the handoff can resolve a note pulled after the protocol event arrived.
      pendingNoteRetryCount += 1;
      if (pendingNoteRetryCount <= 10) {
        clearTimeout(pendingNoteRetryTimer);
        pendingNoteRetryTimer = setTimeout(() => {
          void flushPendingNoteDeepLink();
        }, 1000);
      } else {
        console.warn("Note deep link could not resolve a local note", {
          cloudId: pendingNoteCloudId,
        });
        clearPendingNoteDeepLink();
      }
      return;
    }

    const payload = { noteId: note.id, folderId: note.folder_id ?? null };
    clearPendingNoteDeepLink();
    await windowManager.queueNoteNavigation(payload);
  } catch (error) {
    console.error("Note deep link failed:", error);
    clearPendingNoteDeepLink();
  }
}

async function handleNoteDeepLink(deepLinkUrl) {
  const cloudId = parseNoteCloudId(deepLinkUrl);
  if (!cloudId) {
    console.warn("Invalid note deep link");
    return;
  }

  clearPendingNoteDeepLink();
  pendingNoteCloudId = cloudId;
  await flushPendingNoteDeepLink();
}

function handleInvitationDeepLink(deepLinkUrl) {
  try {
    const match = deepLinkUrl.match(/invitations\/([^/?#]+)/);
    const token = match?.[1];
    if (!token) return;
    pendingInvitationDeepLinkToken = token;
    if (!windowManager) return;
    if (isLiveWindow(windowManager.controlPanelWindow)) {
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
      dockManager.setControlPanelVisible(true);
      // Best-effort fast path — the get-pending-invitation-token pull is the reliable path.
      windowManager.controlPanelWindow.webContents.send("workspace-invitation-token", token);
    } else {
      windowManager.createControlPanelWindow();
    }
  } catch (error) {
    console.error("Invitation deep link parse failed:", error);
  }
}

function resolveAuthUrl() {
  const fs = require("fs");
  const envPath = path.join(__dirname, "src", "dist", "runtime-env.json");
  let runtimeEnv = {};
  try {
    if (fs.existsSync(envPath)) runtimeEnv = JSON.parse(fs.readFileSync(envPath, "utf8"));
  } catch {}
  return (
    process.env.AUTH_URL || process.env.VITE_AUTH_URL || runtimeEnv.VITE_AUTH_URL || "" // fork: no default auth server
  );
}

function getOauthCookieName() {
  return process.env.NODE_ENV === "production"
    ? "__Secure-openwhispr.session_token"
    : "openwhispr.session_token";
}

// Older website builds send the signed cookie value as `?token=`; trade it
// for the raw session.token the bearer plugin expects.
async function exchangeSignedTokenForRawBearer(signedToken) {
  try {
    const res = await net.fetch(`${resolveAuthUrl()}/api/auth/get-session`, {
      headers: { Cookie: `${getOauthCookieName()}=${signedToken}` },
      signal: AbortSignal.timeout(5000),
      useSessionCookies: false,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.session?.token || null;
  } catch (err) {
    if (debugLogger) {
      debugLogger.warn("Signed-token bearer exchange failed (non-fatal)", {
        error: err?.message,
      });
    }
    return null;
  }
}

// One-time bridge for users upgrading from a build that injected the session
// cookie into Electron's jar: exchange the existing cookie for a raw bearer
// token, store it, and remove the cookie. Non-fatal — failures fall through
// to the normal sign-in flow.
async function migrateCookieToBearerToken() {
  const tokenStore = require("./src/helpers/tokenStore");
  if (tokenStore.get()) return;

  const cookieName = getOauthCookieName();
  const authUrl = resolveAuthUrl();
  if (!authUrl) return; // fork

  try {
    const cookies = await session.defaultSession.cookies.get({ url: authUrl, name: cookieName });
    if (!cookies.length) return;

    const rawToken = await exchangeSignedTokenForRawBearer(cookies[0].value);
    if (!rawToken) return;

    tokenStore.set(rawToken);
    await session.defaultSession.cookies.remove(authUrl, cookieName);
    if (debugLogger) debugLogger.debug("Migrated cookie to bearer token");
  } catch (err) {
    if (debugLogger) {
      debugLogger.warn("Cookie→bearer token migration failed (non-fatal)", {
        error: err?.message,
      });
    }
  }
}

// Persist the bearer token and reload the control panel so the renderer's
// authClient sends `Authorization: Bearer <token>` on its next request.
async function applySessionTokenAndRefresh(token) {
  if (!token) return;
  if (!isLiveWindow(windowManager?.controlPanelWindow)) return;

  const tokenStore = require("./src/helpers/tokenStore");
  tokenStore.set(token);

  const appUrl = DevServerManager.getAppUrl(true);
  if (appUrl) {
    windowManager.controlPanelWindow.loadURL(appUrl);
  } else {
    const fileInfo = DevServerManager.getAppFilePath(true);
    if (fileInfo) {
      windowManager.controlPanelWindow.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  if (debugLogger) {
    debugLogger.debug("Applied bearer token and reloaded control panel", {
      appChannel: APP_CHANNEL,
      oauthProtocol: OAUTH_PROTOCOL,
    });
  }
  windowManager.controlPanelWindow.show();
  windowManager.controlPanelWindow.focus();
  dockManager.setControlPanelVisible(true);
}

async function handleOAuthDeepLink(deepLinkUrl) {
  try {
    const parsed = new URL(deepLinkUrl);
    const bearerToken = parsed.searchParams.get("bearer_token");
    if (bearerToken) {
      void applySessionTokenAndRefresh(bearerToken);
      return;
    }
    const signedToken = parsed.searchParams.get("token");
    if (!signedToken) return;
    const rawToken = await exchangeSignedTokenForRawBearer(signedToken);
    if (rawToken) void applySessionTokenAndRefresh(rawToken);
  } catch (err) {
    if (debugLogger) debugLogger.error("Failed to handle OAuth deep link:", err);
  }
}

function handleUpgradeDeepLink() {
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    windowManager.controlPanelWindow.webContents.executeJavaScript(
      'window.dispatchEvent(new Event("upgrade-success"))'
    );
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
    dockManager.setControlPanelVisible(true);
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function writeCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function startAuthBridgeServer() {
  if (APP_CHANNEL !== "development" || authBridgeServer) {
    return;
  }

  authBridgeServer = http.createServer(async (req, res) => {
    writeCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${AUTH_BRIDGE_HOST}:${AUTH_BRIDGE_PORT}`);
    if (requestUrl.pathname !== AUTH_BRIDGE_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    let token = requestUrl.searchParams.get("bearer_token") || requestUrl.searchParams.get("token");
    if (!token && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        token = body?.bearer_token || body?.token || null;
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(error.message || "Invalid request");
        return;
      }
    }

    if (!token) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing token");
      return;
    }

    void applySessionTokenAndRefresh(token);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<html><body><h3>OpenWhispr sign-in complete.</h3><p>You can close this tab.</p></body></html>"
    );
  });

  authBridgeServer.on("error", (error) => {
    if (debugLogger) {
      debugLogger.error("OAuth auth bridge server failed:", error);
    }
  });

  authBridgeServer.listen(AUTH_BRIDGE_PORT, AUTH_BRIDGE_HOST, () => {
    if (debugLogger) {
      debugLogger.debug("OAuth auth bridge server started", {
        url: `http://${AUTH_BRIDGE_HOST}:${AUTH_BRIDGE_PORT}${AUTH_BRIDGE_PATH}`,
      });
    }
  });
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
  startAuthBridgeServer();

  await migrateCookieToBearerToken();

  applyOpenWhisprOriginHeader(session.defaultSession);

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

  // Windows/Linux cold start delivers protocol URLs via argv (macOS uses
  // open-url); without this scan a deep link that launches the app is lost.
  const initialProtocolUrl = process.argv.find((arg) => arg.startsWith(`${OAUTH_PROTOCOL}://`));
  if (initialProtocolUrl && isNoteDeepLink(initialProtocolUrl)) {
    await handleNoteDeepLink(initialProtocolUrl);
  } else {
    if (initialProtocolUrl && process.platform !== "darwin") {
      if (initialProtocolUrl.includes("upgrade-success")) {
        handleUpgradeDeepLink();
      } else if (isInvitationDeepLink(initialProtocolUrl)) {
        handleInvitationDeepLink(initialProtocolUrl);
      } else {
        void handleOAuthDeepLink(initialProtocolUrl);
      }
    }
    await flushPendingNoteDeepLink();
  }

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

  if (process.platform === "win32") {
    const nircmdStatus = clipboardManager.getNircmdStatus();
    debugLogger.debug("Windows paste tool status", nircmdStatus);
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
  app.on("second-instance", async (_event, commandLine) => {
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

    // Check for OAuth protocol URL in command line arguments (Windows/Linux)
    const url = commandLine.find((arg) => arg.startsWith(`${OAUTH_PROTOCOL}://`));
    if (url) {
      if (url.includes("upgrade-success")) {
        handleUpgradeDeepLink();
      } else if (isNoteDeepLink(url)) {
        await handleNoteDeepLink(url);
      } else if (isInvitationDeepLink(url)) {
        handleInvitationDeepLink(url);
      } else {
        void handleOAuthDeepLink(url);
      }
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
  clearPendingNoteDeepLink();
  if (authBridgeServer) {
    authBridgeServer.close();
    authBridgeServer = null;
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
  if (ipcHandlers) ipcHandlers._cleanupTextEditMonitor();
  if (textEditMonitor) textEditMonitor.stopMonitoring();
  if (updateManager) updateManager.cleanup();
}
