const { app, screen, BrowserWindow, dialog, ipcMain } = require("electron");
const debugLogger = require("./debugLogger");
const { createLinuxWindowInputRegion } = require("./linuxWindowInputRegion");
// Aliased: this class has an openExternalUrl method wrapping the helper.
const { openExternalUrl: openUrlInExternalBrowser } = require("./externalUrlOpener");
const HotkeyManager = require("./hotkeyManager");
const { isGlobeLikeHotkey } = HotkeyManager;
const DragManager = require("./dragManager");
const MainWindowPlacementCoordinator = require("./mainWindowPlacementCoordinator");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const { isAllowedAppNavigation, isExternalBrowserUrl } = require("./navigationGuard");
const { pathToFileURL } = require("url");
const dockManager = require("./dockManager");
const { i18nMain } = require("./i18nMain");
const { NotificationDismissTimer, getNotificationTimeoutMs } = require("./notificationTimer");
const {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
} = require("./dictationLifecycle");
const { DEV_SERVER_PORT } = DevServerManager;
const DRAG_MOVE_TOLERANCE_PX = 2;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  ONBOARDING_WINDOW_SIZES,
  NOTIFICATION_WINDOW_CONFIG,
  fitAssistantContentWindowToWorkArea,
  fitAssistantWindowToWorkArea,
  fitDictationErrorContentWindowToWorkArea,
  fitDictationErrorWindowToWorkArea,
  resolveHorizontalWindowDirection,
  WINDOW_SIZES,
  WindowPositionUtil,
} = require("./windowConfig");
const { centeredBounds, clampedBounds } = require("./onboardingWindowBounds");
const { ONBOARDING_DEMO_KINDS, isOnboardingInputAllowed } = require("./onboardingInputPolicy");
const { createHotkeyRepeatGate } = require("./hotkeyRepeatGate");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this._resizeMaskTokenCounter = 0;
    this._controlPanelVisibilityTimer = null;
    this._onboardingRestoreBounds = null;
    this._onboardingWindowMode = null;
    this._onboardingWindowState = null;
    // Fail closed until AppRouter has resolved persisted onboarding state and
    // committed the normal app. This covers the startup gap before React mounts.
    this._onboardingActive = true;
    this._onboardingDemoKind = null;
    // Set by IPCHandlers so its demo session dies with the demo kind on every
    // teardown path (id-matched end, onboarding exit, control panel closed).
    this.onOnboardingDemoTeardown = null;
    // Set by main.js so the tray's listen item rebuilds with dictation state.
    this.onDictationStateChanged = null;
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
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this._mainWindowPlacementCoordinator = new MainWindowPlacementCoordinator();
    this.isQuitting = false;
    this.loadErrorShown = false;
    this.macCompoundPushState = null;
    this.winPushState = null;
    this._cachedActivationMode = "tap";
    this._floatingIconAutoHide = false;
    this._panelStartPosition = "bottom-right";
    this._activeHorizontalDirection = null;
    this._isDictatingToggle = false;
    this._dictationLifecycleState = DICTATION_LIFECYCLE.IDLE;
    this._pendingMeetingNoteNavigation = null;
    this._pendingNoteNavigation = null;

    app.on("before-quit", () => {
      this.isQuitting = true;
      this.hotkeyManager.unregisterAll();
    });
  }

  async createMainWindow() {
    const cursorPos = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPos);
    const position = WindowPositionUtil.getMainWindowPosition(
      display,
      null,
      this._panelStartPosition
    );

    this.mainWindow = new BrowserWindow({
      ...MAIN_WINDOW_CONFIG,
      ...position,
    });

    this.setMainWindowInteractivity(false);
    this.registerMainWindowEvents();

    // Register load event handlers BEFORE loading to catch all events
    this.mainWindow.webContents.on(
      "did-fail-load",
      async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (
          process.env.NODE_ENV === "development" &&
          validatedURL &&
          validatedURL.includes(`localhost:${DEV_SERVER_PORT}`)
        ) {
          setTimeout(async () => {
            const isReady = await DevServerManager.waitForDevServer();
            if (isReady) {
              this.mainWindow.reload();
            }
          }, 2000);
        } else {
          this.showLoadFailureDialog("Dictation panel", errorCode, errorDescription, validatedURL);
        }
      }
    );

    this.mainWindow.webContents.on("did-finish-load", () => {
      // A reload has not resolved its route yet. AppRouter releases this gate
      // after it renders the normal app; fresh onboarding keeps it active.
      this.setOnboardingActive(true);
      this.endOnboardingDemo();
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
      this.enforceMainWindowOnTop();
      this._notifyMainWindowHorizontalDirection();
    });

    await this.loadMainWindow();
    await this.initializeHotkey();
    this.dragManager.setTargetWindow(this.mainWindow);
    MenuManager.setupMainMenu(() => this.openSettings());
  }


  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (process.platform === "win32") {
      // Windows click-through forwarding is unreliable for this floating panel.
      this.mainWindow.setIgnoreMouseEvents(false);
      return;
    }

    if (process.platform === "linux") {
      // Native capture is the fallback when the input-region helper is unavailable.
      this.mainWindow.setIgnoreMouseEvents(!shouldCapture);
    } else if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  async setMainWindowInputRegion(region) {
    const win = this.mainWindow;
    if (process.platform !== "linux" || !win || win.isDestroyed()) return false;
    if (this._linuxWindowInputRegion?.window !== win) {
      this._linuxWindowInputRegion?.stop();
      this._linuxWindowInputRegion = { window: win, ...createLinuxWindowInputRegion(win) };
    }
    try {
      await this._linuxWindowInputRegion.set(region);
      return !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    } catch (error) {
      // The writer rejects after its process closes, so an old shape cannot
      // overwrite this fallback and leave native hover unreachable.
      if (!win.isDestroyed()) win.setIgnoreMouseEvents(false);
      throw error;
    }
  }

  // Only the meeting prompt owns this: another overlay reporting its own hover
  // must not pause a countdown it cannot resume — it may be destroyed before
  // its pointer ever leaves.
  setNotificationInteractivity(sender, interactive) {
    const win = this.notificationWindow;
    if (!win || win.isDestroyed() || sender !== win.webContents) {
      return;
    }
    // Linux ignores the `forward` option, so a card returned to click-through
    // there never sees another mouseenter and Start/Dismiss stay unreachable
    // for the rest of its life (#1456). It is only click-through on macOS to
    // begin with, so on Linux leave the hit-testing alone and move the
    // countdown alone.
    const togglesClickThrough = process.platform !== "linux";
    if (interactive) {
      if (togglesClickThrough) win.setIgnoreMouseEvents(false);
      this._notificationDismissTimer.pause();
    } else {
      if (togglesClickThrough) win.setIgnoreMouseEvents(true, { forward: true });
      this._notificationDismissTimer.resume();
    }
  }

  resizeMainWindow(sizeKey) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }
    return this._enqueueMainWindowMutation(() => this._performMainWindowResize(sizeKey));
  }

  resizeAssistantWindowToContent(surfaceHeight) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    return this._enqueueMainWindowMutation(() =>
      this._performMainWindowResize("ASSISTANT_CONTENT", { surfaceHeight })
    );
  }

  resizeDictationErrorWindowToContent(surfaceHeight) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }


    return this._enqueueMainWindowMutation(() =>
      this._performMainWindowResize("DICTATION_ERROR_CONTENT", { surfaceHeight })
    );
  }

  // Deliberate moves are not anchored resizes: the renderer must drop any live
  // resize mask rather than hold a translation against invalidated bounds.
  _clearRendererResizeMask() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("main-window-will-resize", { anchor: "none" });
  }

  async _prepareRendererForMainWindowResize(bounds, anchor) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    // The renderer must install screen-space anchor compensation before
    // setBounds reaches the OS compositor. Without this handshake, Windows
    // and macOS can paint the new viewport size one frame before the
    // corresponding window position, which visibly kicks the pill or panel.
    // A fixed sleep loses that race whenever the renderer is mid-task (an
    // entrance commit, mic warm-up), so wait for its explicit ack; the
    // timeout only covers an unresponsive or torn-down renderer.
    const token = ++this._resizeMaskTokenCounter;
    const ackPromise = new Promise((resolve) => {
      const listener = (_event, ackToken) => {
        if (ackToken !== token) return;
        ipcMain.removeListener("main-window-resize-mask-ready", listener);
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        ipcMain.removeListener("main-window-resize-mask-ready", listener);
        resolve();
      }, 60);
      ipcMain.on("main-window-resize-mask-ready", listener);
    });
    this.mainWindow.webContents.send("main-window-will-resize", { bounds, anchor, token });
    await ackPromise;
  }

  _enqueueMainWindowMutation(run) {
    // Renderer voice requests are latest-wins, while errors and other overlays
    // and active-display placement can also mutate the native bounds. Serialize
    // once more at the native boundary so setBounds calls cannot interleave.
    this._mainWindowResizeQueue = (this._mainWindowResizeQueue || Promise.resolve()).then(run, run);
    return this._mainWindowResizeQueue;
  }

  // The pill is bottom-anchored, so the display that owns its bottom-center
  // point is the one that must keep it through resizes and repositions.
  _getMainWindowDisplayFor(bounds) {
    return screen.getDisplayNearestPoint({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
    });
  }

  _resolveMainWindowSize(sizeKey, workArea, request) {
    switch (sizeKey) {
      case "ASSISTANT":
        return fitAssistantWindowToWorkArea(WINDOW_SIZES.ASSISTANT, workArea);
      case "DICTATION_ERROR":
      case "DICTATION_ERROR_WITH_TRANSCRIPT":
        return fitDictationErrorWindowToWorkArea(WINDOW_SIZES[sizeKey], workArea);
      case "ASSISTANT_CONTENT":
        return fitAssistantContentWindowToWorkArea(request?.surfaceHeight, workArea);
      case "DICTATION_ERROR_CONTENT":
        return fitDictationErrorContentWindowToWorkArea(request?.surfaceHeight, workArea);
      default:
        return WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    }
  }

  async _performMainWindowResize(sizeKey, request) {
    // The queue can drain after the window is gone (quit, recreate); the
    // caller's guard ran before enqueueing.
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, error: "Main window not available" };
    }
    // Bounds, display and the work-area fit are all sampled inside the queue:
    // a queued cross-display move would otherwise leave a fit computed at
    // enqueue time describing the display the window is about to leave.
    const currentBounds = this.mainWindow.getBounds();
    const display = this._getMainWindowDisplayFor(currentBounds);
    const newSize = this._resolveMainWindowSize(
      sizeKey,
      display.workArea || display.bounds,
      request
    );

    // A window moved since the last resize (dragged) means the captured BASE
    // bounds no longer describe where the user wants the pill — drop them.
    // Tolerate a couple of pixels: fractional DPI scaling can round setBounds
    // values, and treating that as a drag would defeat the restore forever.
    const MOVE_TOLERANCE_PX = 2;
    if (
      this._lastResizeBounds &&
      (Math.abs(currentBounds.x - this._lastResizeBounds.x) > MOVE_TOLERANCE_PX ||
        Math.abs(currentBounds.y - this._lastResizeBounds.y) > MOVE_TOLERANCE_PX)
    ) {
      this._baseBoundsBeforeResize = null;
      this._activeHorizontalDirection = null;
    }

    // Returning to BASE restores the exact pre-grow bounds. Anchoring the
    // shrink on the grown bounds instead would re-anchor on whatever the
    // work-area clamp did on the way up, walking the pill away from where the
    // user put it a little more on every grow/shrink cycle.
    if (sizeKey === "BASE" && this._baseBoundsBeforeResize) {
      // The work area can shrink while the window is grown (dock/taskbar
      // reappearing, resolution change) — clamp the restore so the pill
      // cannot come back off-screen.
      const restored = {
        ...this._baseBoundsBeforeResize,
        ...WindowPositionUtil.clampToWorkArea(this._baseBoundsBeforeResize, display),
      };
      const restoreAnchor =
        this._panelStartPosition === "center"
          ? "center"
          : `bottom-${this._activeHorizontalDirection || this.getMainWindowHorizontalDirection()}`;
      this._baseBoundsBeforeResize = null;
      if (
        restored.x === currentBounds.x &&
        restored.y === currentBounds.y &&
        restored.width === currentBounds.width &&
        restored.height === currentBounds.height
      ) {
        // Nothing moved (BASE and the grown size share bounds) — skip the mask
        // handshake and setBounds so the restore cannot perturb the renderer.
        this._lastResizeBounds = restored;
        this._activeHorizontalDirection = null;
        this._notifyMainWindowHorizontalDirection();
        return { success: true, bounds: restored, changed: false };
      }
      await this._prepareRendererForMainWindowResize(restored, restoreAnchor);
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        return { success: false, message: "Window not available" };
      }
      this._lastResizeBounds = restored;
      this.mainWindow.setBounds(restored);
      this._activeHorizontalDirection = null;
      this._notifyMainWindowHorizontalDirection();
      return { success: true, bounds: restored, changed: true };
    }

    if (
      sizeKey !== "BASE" &&
      !this._baseBoundsBeforeResize &&
      currentBounds.width === WINDOW_SIZES.BASE.width &&
      currentBounds.height === WINDOW_SIZES.BASE.height
    ) {
      this._baseBoundsBeforeResize = { ...currentBounds };
      this._activeHorizontalDirection = resolveHorizontalWindowDirection(
        currentBounds,
        display,
        this._panelStartPosition
      );
    }

    if (sizeKey !== "BASE" && !this._activeHorizontalDirection) {
      this._activeHorizontalDirection = resolveHorizontalWindowDirection(
        currentBounds,
        display,
        this._panelStartPosition
      );
    }
    const position =
      this._panelStartPosition === "center"
        ? "center"
        : `bottom-${this._activeHorizontalDirection || this.getMainWindowHorizontalDirection()}`;

    let newX, newY;

    if (position === "bottom-left") {
      // Anchor bottom-left corner: keep x, expand rightward and upward
      newX = currentBounds.x;
      newY = currentBounds.y + currentBounds.height - newSize.height;
    } else if (position === "center") {
      // Anchor bottom-center: expand symmetrically and upward
      const centerX = currentBounds.x + currentBounds.width / 2;
      newX = centerX - newSize.width / 2;
      newY = currentBounds.y + currentBounds.height - newSize.height;
    } else {
      // bottom-right (default): anchor bottom-right corner, expand leftward and upward
      const bottomRightX = currentBounds.x + currentBounds.width;
      newX = bottomRightX - newSize.width;
      newY = currentBounds.y + currentBounds.height - newSize.height;
    }

    const clamped = WindowPositionUtil.clampToWorkArea({ x: newX, y: newY, ...newSize }, display);
    const newBounds = { ...clamped, ...newSize };

    // Opening a voice mode and the size-priority effect can request the same
    // footprint in adjacent ticks. Avoid asking the OS compositor to rebuild
    // an unchanged transparent window surface.
    if (
      currentBounds.x === newBounds.x &&
      currentBounds.y === newBounds.y &&
      currentBounds.width === newBounds.width &&
      currentBounds.height === newBounds.height
    ) {
      this._lastResizeBounds = { ...currentBounds };
      if (sizeKey === "BASE") {
        this._activeHorizontalDirection = null;
        this._notifyMainWindowHorizontalDirection();
      }
      return { success: true, bounds: currentBounds, changed: false };
    }

    await this._prepareRendererForMainWindowResize(newBounds, position);
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }
    this.mainWindow.setBounds(newBounds);
    this._lastResizeBounds = newBounds;
    if (sizeKey === "BASE") {
      this._activeHorizontalDirection = null;
      this._notifyMainWindowHorizontalDirection();
    }

    return { success: true, bounds: newBounds, changed: true };
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

  async loadMainWindow() {
    await this.loadWindowContent(this.mainWindow, false);
  }

  createHotkeyCallback() {
    const isPress = createHotkeyRepeatGate();

    // globalShortcut registrations pass the hotkey that fired; native shortcuts
    // use down/up phases and resolve their primary hotkey from the active slot.
    return async (triggeredHotkey, phase) => {
      if (this.hotkeyManager.isInListeningMode()) {
        return;
      }
      if (this.isDictationProcessing()) {
        return;
      }

      const activationMode = this.getActivationMode();
      const currentHotkey = triggeredHotkey || this.hotkeyManager.getCurrentHotkey?.();

      if (process.platform === "linux" && activationMode === "push") {
        if (phase === "down") {
          this.startWindowsPushToTalk(currentHotkey);
        } else if (phase === "up") {
          this.handleWindowsPushKeyUp(currentHotkey);
        }
        return;
      }
      if (phase === "up") return;

      if (
        process.platform === "darwin" &&
        activationMode === "push" &&
        currentHotkey &&
        !isGlobeLikeHotkey(currentHotkey) &&
        currentHotkey.includes("+")
      ) {
        this.startMacCompoundPushToTalk(currentHotkey);
        return;
      }

      // Push mode: defer to native listener (globalShortcut can't detect key-up)
      if (
        (process.platform === "win32" || process.platform === "linux") &&
        activationMode === "push"
      ) {
        return;
      }

      if (!isPress()) return;
      this.sendToggleDictation();
    };
  }

  startMacCompoundPushToTalk(hotkey) {
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (this.macCompoundPushState?.active || this.isDictationProcessing()) {
      return;
    }

    const requiredModifiers = this.getMacRequiredModifiers(hotkey);
    if (requiredModifiers.size === 0) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const MAX_PUSH_DURATION_MS = 300000; // 5 minutes max recording
    const downTime = Date.now();

    const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
    this.showDictationPanel({ reposition: true, targetPidPromise });
    this.sendPrepareDictation();

    const safetyTimeoutId = setTimeout(() => {
      if (this.macCompoundPushState?.active) {
        debugLogger.warn("Compound PTT safety timeout", undefined, "ptt");
        this.forceStopMacCompoundPush("timeout");
      }
    }, MAX_PUSH_DURATION_MS);

    this.macCompoundPushState = {
      active: true,
      downTime,
      isRecording: false,
      requiredModifiers,
      safetyTimeoutId,
    };

    setTimeout(() => {
      if (!this.macCompoundPushState || this.macCompoundPushState.downTime !== downTime) {
        return;
      }

      if (!this.macCompoundPushState.isRecording) {
        this.macCompoundPushState.isRecording = true;
        this.sendStartDictation();
      }
    }, MIN_HOLD_DURATION_MS);
  }

  handleMacPushModifierUp(modifier) {
    if (!this.macCompoundPushState?.active) {
      return;
    }

    if (!this.macCompoundPushState.requiredModifiers.has(modifier)) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    this.macCompoundPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.sendCancelDictationPreparation();
      this.hideDictationPanel();
    }
  }

  // A push that ends without a physical release leaves the trigger keys down, so
  // an injected paste shortcut lands in a modifier state the target app cannot
  // interpret and the transcript is lost. Tell the renderer to hold the text
  // back instead of pasting it.
  _notifyPushForceStopped(reason) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("dictation-force-stopped", { reason });
    }
  }

  forceStopMacCompoundPush(reason = "manual") {
    if (!this.macCompoundPushState) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    this.macCompoundPushState = null;

    this._notifyPushForceStopped(reason);

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.sendCancelDictationPreparation();
      this.hideDictationPanel();
    }
  }

  getMacRequiredModifiers(hotkey) {
    const required = new Set();
    const parts = hotkey.split("+").map((part) => part.trim());

    for (const part of parts) {
      switch (part) {
        case "Command":
        case "Cmd":
        case "RightCommand":
        case "RightCmd":
        case "CommandOrControl":
        case "Super":
        case "Meta":
          required.add("command");
          break;
        case "Control":
        case "Ctrl":
        case "RightControl":
        case "RightCtrl":
          required.add("control");
          break;
        case "Alt":
        case "Option":
        case "RightAlt":
        case "RightOption":
          required.add("option");
          break;
        case "Shift":
        case "RightShift":
          required.add("shift");
          break;
        case "Fn":
          required.add("fn");
          break;
        default:
          break;
      }
    }

    return required;
  }

  startWindowsPushToTalk(key) {
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (this.winPushState?.active || this.isDictationProcessing()) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const MAX_PUSH_DURATION_MS = 300000;
    const downTime = Date.now();

    this.showDictationPanel({ reposition: true });
    this.sendPrepareDictation();

    const safetyTimeoutId = setTimeout(() => {
      if (!this.winPushState || this.winPushState.downTime !== downTime) return;
      debugLogger.warn("Native PTT safety timeout", undefined, "ptt");
      this.handleWindowsPushKeyUp(undefined, { reason: "timeout" });
    }, MAX_PUSH_DURATION_MS);

    this.winPushState = {
      active: true,
      key,
      downTime,
      isRecording: false,
      safetyTimeoutId,
    };

    setTimeout(() => {
      if (!this.winPushState || this.winPushState.downTime !== downTime) {
        return;
      }

      if (!this.winPushState.isRecording) {
        this.winPushState.isRecording = true;
        this.sendStartDictation();
      }
    }, MIN_HOLD_DURATION_MS);
  }

  // With several dictation hotkeys bound, only the key that started the push may
  // stop it; called without a key to force-stop. "release" is the user letting
  // go; every other reason ends a push whose trigger keys are still physically
  // down, which the renderer must know before it pastes.
  handleWindowsPushKeyUp(key, { reason = "release" } = {}) {
    if (!this.winPushState?.active) {
      return;
    }
    if (key && this.winPushState.key && key !== this.winPushState.key) {
      return;
    }

    if (this.winPushState.safetyTimeoutId) {
      clearTimeout(this.winPushState.safetyTimeoutId);
    }

    const wasRecording = this.winPushState.isRecording;
    this.winPushState = null;

    if (reason !== "release") this._notifyPushForceStopped(reason);

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.sendCancelDictationPreparation();
      this.hideDictationPanel();
    }
  }

  resetWindowsPushState() {
    if (!this.winPushState?.active) {
      return;
    }

    this.handleWindowsPushKeyUp(undefined, { reason: "reset" });
  }

  _isOnboardingInputAllowed(inputKind) {
    return isOnboardingInputAllowed(this._onboardingActive, this._onboardingDemoKind, inputKind);
  }

  // "meeting" is never a demo kind, so this is simply "not during onboarding".
  isMeetingInputAllowed() {
    return this._isOnboardingInputAllowed("meeting");
  }

  // The one entry for starting a meeting by hand: the meeting hotkey, the pill's
  // command menu, and the tray. Fails closed during onboarding and while a
  // hotkey is being captured, like every hotkey slot.
  async startManualMeeting() {
    if (this.hotkeyManager.isInListeningMode() || !this.isMeetingInputAllowed()) return;
    try {
      await this.meetingDetectionEngine?.startManualMeeting();
    } catch (error) {
      debugLogger.error("Failed to start manual meeting", { error: error.message }, "meeting");
    }
  }


  _sendDictationToggle(channel, inputKind) {
    if (!this._isOnboardingInputAllowed(inputKind)) return;
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
      debugLogger.debug("Ignoring dictation toggle while transcription is processing", {
        channel,
      });
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const isStarting = !this._isDictatingToggle;
      // Capture the paste target and any selection on every toggle press,
      // before the overlay steals focus — the paste can't refocus the target
      // otherwise (#668). The renderer owns the real recording state and may
      // decline a toggle (mic error, silence gate, Esc cancel), so gating this
      // on _isDictatingToggle desyncs and leaves a stale target from a
      // previous app. Press-time capture matches the dictation hotkey call
      // sites in main.js; a stop-press capture resolves the same frontmost
      // app, since NSWorkspace ignores the overlay panel.
      const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
      void this.selectionManager?.captureTarget?.();
      if (!isStarting) {
        this._mainWindowPlacementCoordinator.cancelPending();
      }
      this.showDictationPanel({
        reposition: isStarting,
        targetPidPromise,
      });
      // About-to-start guess: open the mic one IPC message ahead of the toggle.
      // A wrong guess (renderer declines) is bounded by the prepared capture's
      // max-age expiry, and the renderer dedups its own prepare call. Pass the
      // toggle's own kind so the onboarding gate judges the pre-warm like it.
      if (isStarting) {
        this.sendPrepareDictation({ inputKind });
      }
      this.mainWindow.webContents.send(channel);
    }
  }

  setDictationLifecycleState(state) {
    const nextState = normalizeDictationLifecycle(state);
    if (nextState === this._dictationLifecycleState) return;

    this._dictationLifecycleState = nextState;
    this._isDictatingToggle = isDictationRecording(nextState);
    this.meetingDetectionEngine?.setUserRecording(this._isDictatingToggle);
    this.onDictationStateChanged?.();
  }

  // The tray's listen item is a toggle over this state, like the pill's.
  isDictating() {
    return this._isDictatingToggle;
  }


  isDictationProcessing() {
    return shouldIgnoreDictationHotkey(this._dictationLifecycleState);
  }

  sendToggleDictation() {
    this._sendDictationToggle("toggle-dictation", "dictation");
  }

  sendToggleTranslation() {
    this._sendDictationToggle("toggle-translation", "translation");
  }


  sendStartDictation() {
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
      void this.selectionManager?.captureTarget?.();
      this.showDictationPanel({ reposition: true, targetPidPromise });
      this.mainWindow.webContents.send("start-dictation");
    }
  }

  sendStopDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
    }
  }

  sendPrepareDictation({ inputKind = "dictation" } = {}) {
    if (!this._isOnboardingInputAllowed(inputKind)) return;
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("prepare-dictation", { inputKind });
    }
  }

  sendCancelDictationPreparation() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("cancel-dictation-preparation");
    }
  }

  sendCancelDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("cancel-dictation-preparation");
      this.mainWindow.webContents.send("cancel-hotkey-pressed");
    }
  }

  // Unlike sendCancelDictation (a silent input reset: preparation and
  // recording only), this also cancels a transcript still processing. The
  // companion pill's cancel control lives in another window, but only the
  // main window's renderer owns the recording state, so it decides what
  // "cancel" means at arrival time.
  sendCancelActiveDictation() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("cancel-dictation");
    }
  }

  getActivationMode() {
    return this._cachedActivationMode;
  }

  async setActivationModeCache(mode) {
    const nextMode = mode === "push" ? "push" : "tap";
    const success = await this.hotkeyManager.setActivationMode(nextMode);
    if (!success) return false;
    this._cachedActivationMode = nextMode;
    return true;
  }

  /**
   * Sync the native low-level key listeners (Windows/Linux) so every hotkey slot
   * that needs one is watched. Call after any change to a slot hotkey or the
   * activation mode. No-op during hotkey capture (listeners are stopped then).
   */
  reconcileNativeKeyListeners() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.hotkeyManager.isInListeningMode()) return;
    const activationMode = this.getActivationMode();
    const nativeListenerKeys = this.hotkeyManager.getNativeListenerKeys(activationMode);
    // Native desktop shortcuts replace the low-level listener in tap mode. In
    // push mode, keep the dictation listener as a release-event fallback; the
    // push state machine makes duplicate backend and low-level phases harmless.
    const keys = this.hotkeyManager.isUsingNativeShortcut()
      ? activationMode === "push"
        ? nativeListenerKeys.filter((key) => this.hotkeyManager.slotHasHotkey("dictation", key))
        : []
      : nativeListenerKeys;
    if (process.platform === "win32" && this.windowsKeyManager) {
      this.windowsKeyManager.setKeys(keys);
    } else if (process.platform === "linux" && this.linuxKeyManager) {
      this.linuxKeyManager.setKeys(keys);
    }
  }

  setFloatingIconAutoHide(enabled) {
    this._floatingIconAutoHide = Boolean(enabled);
  }

  getMainWindowHorizontalDirection() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return this._panelStartPosition === "bottom-left" ? "left" : "right";
    }
    const bounds = this.mainWindow.getBounds();
    const display = this._getMainWindowDisplayFor(bounds);
    return resolveHorizontalWindowDirection(bounds, display, this._panelStartPosition);
  }

  _notifyMainWindowHorizontalDirection() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(
      "main-window-horizontal-direction-changed",
      this.getMainWindowHorizontalDirection()
    );
  }

  setPanelStartPosition(position) {
    this._panelStartPosition = position || "bottom-right";
    this._mainWindowPlacementCoordinator.resetManualPosition();
    this._activeHorizontalDirection = null;
    // Reposition the window immediately
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const currentBounds = this.mainWindow.getBounds();
      const display = this._getMainWindowDisplayFor(currentBounds);
      const newPos = WindowPositionUtil.getMainWindowPosition(
        display,
        { width: currentBounds.width, height: currentBounds.height },
        this._panelStartPosition
      );
      this._clearRendererResizeMask();
      this.mainWindow.setBounds(newPos);
      this._notifyMainWindowHorizontalDirection();
    }
  }

  setHotkeyListeningMode(enabled) {
    this.hotkeyManager.setListeningMode(enabled);
  }

  async initializeHotkey() {
    await this.hotkeyManager.initializeHotkey(this.mainWindow, this.createHotkeyCallback());
  }

  async updateHotkey(hotkey) {
    return await this.hotkeyManager.updateHotkey(hotkey, this.createHotkeyCallback());
  }

  isUsingGnomeHotkeys() {
    return this.hotkeyManager.isUsingGnome();
  }

  isUsingHyprlandHotkeys() {
    return this.hotkeyManager.isUsingHyprland();
  }

  getHyprlandConfigStatus() {
    return this.hotkeyManager.getHyprlandConfigStatus();
  }

  isUsingKDEHotkeys() {
    return this.hotkeyManager.isUsingKDE();
  }

  isUsingNativeShortcutHotkeys() {
    return this.hotkeyManager.isUsingNativeShortcut();
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

  async startWindowDrag() {
    // A lookup started by a prior hotkey must never land while the user is
    // taking ownership of the panel position.
    this._mainWindowPlacementCoordinator.cancelPending();
    this._dragStartBounds =
      this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.getBounds() : null;
    return await this.dragManager.startWindowDrag();
  }

  async stopWindowDrag() {
    const result = await this.dragManager.stopWindowDrag();
    if (result.success && this.mainWindow && !this.mainWindow.isDestroyed()) {
      const draggedBounds = this.mainWindow.getBounds();
      const start = this._dragStartBounds;
      // Every pill click goes through start/stopWindowDrag; only an actual
      // move hands position ownership to the user.
      const moved =
        !start ||
        Math.abs(draggedBounds.x - start.x) > DRAG_MOVE_TOLERANCE_PX ||
        Math.abs(draggedBounds.y - start.y) > DRAG_MOVE_TOLERANCE_PX;
      if (moved) {
        this._mainWindowPlacementCoordinator.markManuallyPositioned();
        this._baseBoundsBeforeResize = null;
        this._lastResizeBounds = { ...draggedBounds };
      }
    }
    this._dragStartBounds = null;
    this._activeHorizontalDirection = null;
    this._notifyMainWindowHorizontalDirection();
    return result;
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

  async createControlPanelWindow() {
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
    this._onboardingRestoreBounds = null;
    this._onboardingWindowMode = null;
    this._onboardingWindowState = null;

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

    // Nothing else shows this window: ready-to-show deliberately doesn't, so the
    // renderer can pick the onboarding size first and avoid a visible
    // expanded → compact flash on fresh installs. That makes this the only
    // backstop if the renderer never gets that far — it loads but throws, a lazy
    // chunk fails, or auth/policy resolution never settles — so it must outlive
    // did-finish-load. Only a real show cancels it.
    this._controlPanelVisibilityTimer = setTimeout(() => {
      this._showControlPanel();
    }, 10000);

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hideControlPanelToTray();
      }
    });

    this.controlPanelWindow.on("closed", () => {
      this._clearControlPanelVisibilityTimer();
      this.endOnboardingDemo();
      this.controlPanelWindow = null;
      this._onboardingActive = true;
      this._hideNormalAppSurfaces();
      this._onboardingRestoreBounds = null;
      this._onboardingWindowMode = null;
      this._onboardingWindowState = null;
      dockManager.setControlPanelVisible(false);
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      // Every fresh document starts unresolved. AppRouter releases the gate
      // only after it commits the normal app, so OAuth/onboarding reloads cannot
      // expose the dictation pill, hotkeys, or popup surfaces in between.
      this.setOnboardingActive(true);
      this.endOnboardingDemo();
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
        // The renderer owned any running demo; without this, its stale session
        // keeps swallowing dictations after the reload.
        this.endOnboardingDemo();
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


  async showTranscriptionPreview(text) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-text", text);
    // Partials arrive several times a second; re-showing a visible window
    // restacks it (and re-fires "show") on every chunk (#1262).
    if (!this.mainWindow.isVisible()) {
      this.mainWindow.showInactive();
      this.enforceMainWindowOnTop();
    }
  }

  appendTranscriptionPreview(text) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-append", text);
  }

  holdTranscriptionPreview(options = {}) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const payload = {
      showCleanup: !!options.showCleanup,
    };
    this.mainWindow.webContents.send("preview-hold", payload);
  }

  completeTranscriptionPreview(text) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const payload = { text };
    this.mainWindow.webContents.send("preview-result", payload);
    this.enforceMainWindowOnTop();
  }


  hideTranscriptionPreview() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-hide");
  }

  // The display the user is working on is the one showing the app being dictated
  // into, which on a multi-monitor desk is often not the one the mouse rests on.
  // Falls back to the cursor when the target has no readable window (non-macOS,
  // no target captured yet, or an app with no ordinary window).
  async _resolveActiveDisplay(targetPidPromise) {
    let pid = this.textEditMonitor?.lastTargetPid;
    if (targetPidPromise) {
      try {
        pid = await targetPidPromise;
      } catch {
        pid = null;
      }
    }
    const bounds = pid ? await this.textEditMonitor.getTargetWindowBounds(pid) : null;
    return bounds
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  _repositionToActiveDisplay(targetPidPromise) {
    return this._mainWindowPlacementCoordinator.request(
      () => this._resolveActiveDisplay(targetPidPromise),
      (activeDisplay, isCurrent) =>
        this._enqueueMainWindowMutation(() =>
          this._performActiveDisplayReposition(activeDisplay, isCurrent)
        )
    );
  }

  _performActiveDisplayReposition(activeDisplay, isCurrent) {
    if (
      !isCurrent() ||
      this.dragManager.isDragActive() ||
      !this.mainWindow ||
      this.mainWindow.isDestroyed()
    ) {
      return { applied: false, reason: "superseded" };
    }

    const currentBounds = this.mainWindow.getBounds();
    const currentDisplay = this._getMainWindowDisplayFor(currentBounds);

    if (currentDisplay.id === activeDisplay.id) {
      // Nearest-display math can't tell "on this display" from "just past its
      // edge", so a rearranged monitor or a drag that ended over another
      // display can leave the panel stranded in dead space, looking like the
      // overlay vanished. Pull it back before showing it.
      const clamped = WindowPositionUtil.clampToWorkArea(currentBounds, currentDisplay);
      if (clamped.x !== currentBounds.x || clamped.y !== currentBounds.y) {
        const clampedBounds = { ...currentBounds, ...clamped };
        this._clearRendererResizeMask();
        this.mainWindow.setBounds(clampedBounds);
        this._lastResizeBounds = { ...clampedBounds };
        this._baseBoundsBeforeResize = null;
        return { applied: true, bounds: clampedBounds };
      }
      return { applied: false, reason: "same-display" };
    }

    const newPos = WindowPositionUtil.getMainWindowPosition(
      activeDisplay,
      { width: currentBounds.width, height: currentBounds.height },
      this._panelStartPosition
    );
    debugLogger.debug(
      "[WindowManager] Moving dictation panel to the active display",
      { from: currentBounds, to: newPos, displayId: activeDisplay.id },
      "window"
    );
    this._clearRendererResizeMask();
    this.mainWindow.setBounds(newPos);
    // This is an intentional native move, not a drag. Keep resize restoration
    // from treating the old display's bounds as the user's desired base state.
    this._lastResizeBounds = { ...newPos };
    this._baseBoundsBeforeResize = null;
    this._activeHorizontalDirection = null;
    this._notifyMainWindowHorizontalDirection();
    return { applied: true, bounds: newPos };
  }

  showDictationPanel(options = {}) {
    if (this._onboardingActive) return;
    const { focus = false, reposition = false, targetPidPromise } = options;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (reposition) {
      void this._repositionToActiveDisplay(targetPidPromise);
    }
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    if (!this.mainWindow.isVisible()) {
      if (typeof this.mainWindow.showInactive === "function") {
        this.mainWindow.showInactive();
      } else {
        this.mainWindow.show();
      }
    }
    if (focus) {
      this.mainWindow.focus();
    }
  }

  setOnboardingActive(active) {
    const nextActive = active === true;
    if (nextActive === this._onboardingActive) {
      if (nextActive) this._hideNormalAppSurfaces();
      return true;
    }

    if (nextActive) {
      this._onboardingActive = true;
      this.sendCancelDictation();
      this._hideNormalAppSurfaces();
      return true;
    }

    this.endOnboardingDemo();
    this.sendCancelDictation();
    this.hideDictationPanel();
    this._onboardingActive = false;
    if (!this._floatingIconAutoHide) this.showDictationPanel();
    return true;
  }

  _hideNormalAppSurfaces() {
    this.hideDictationPanel();
    this.hideTranscriptionPreview();
    this.dismissMeetingNotification({ flushQueued: false });
  }

  beginOnboardingDemo(kind) {
    if (!ONBOARDING_DEMO_KINDS.has(kind)) return false;
    this._onboardingActive = true;
    this._onboardingDemoKind = kind;
    // A prior recording must not leak into a new correlated demo session.
    this.sendCancelDictation();
    this.hideDictationPanel();
    return true;
  }

  isOnboardingDemoActive() {
    return this._onboardingDemoKind !== null;
  }

  stopOnboardingDemoRecording() {
    if (!this._onboardingDemoKind) return false;
    this.sendStopDictation();
    this.hideDictationPanel();
    return true;
  }

  endOnboardingDemo() {
    // Before the early return on purpose: IPCHandlers' demo session must die
    // on every teardown path even if the demo kind is already gone — a stale
    // session broadcasts every later dictation on onboarding-demo-event.
    this.onOnboardingDemoTeardown?.();
    if (!this._onboardingDemoKind) return false;
    // Leaving/retrying is cancellation, not a transcription request. The
    // overlay owns AudioManager, so route cleanup must be delivered there.
    this.sendCancelDictation();
    this.hideDictationPanel();
    this._onboardingDemoKind = null;
    return true;
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
    if (win.isVisible()) return;
    win.show();
    win.focus();
    dockManager.setControlPanelVisible(true);
  }

  // Compact onboarding starts at smaller bounds, but both modes expose the
  // complete window-control contract so a frameless window never traps the
  // user in setup.
  _applyOnboardingWindowChrome(win, mode) {
    const expanded = mode === "expanded";
    win.setResizable(true);
    win.setMinimizable(true);
    win.setMaximizable(true);
    win.setClosable(true);
    win.setFullScreenable(false);
    // Floor at the mode's canonical size so no step renders below the bounds
    // it was designed for — clamped to the work area, or a 1366x768-class
    // display could never fit (and setContentBounds would fight the minimum).
    const floor = expanded ? ONBOARDING_WINDOW_SIZES.EXPANDED : ONBOARDING_WINDOW_SIZES.COMPACT;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    win.setMinimumSize(
      Math.min(floor.width, workArea.width),
      Math.min(floor.height, workArea.height)
    );
    if (process.platform === "darwin" && typeof win.setWindowButtonVisibility === "function") {
      win.setWindowButtonVisibility(true);
    }
  }

  setOnboardingWindowMode(mode) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return false;
    if (!new Set(["compact", "expanded", "restore"]).has(mode)) return false;
    if (mode !== "restore" && (win.isFullScreen() || win.isMaximized())) {
      // Entering onboarding from a maximized/fullscreen control panel must not
      // refuse: each mode is applied at its canonical centered bounds, which
      // only take effect from a normal window state. Both modes stay
      // maximizable, so the user can simply maximize again afterwards.
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    }

    const current = win.getContentBounds();
    const { workArea } = screen.getDisplayMatching(win.getBounds());

    if (mode === "restore") {
      // A maximized/fullscreen window the user made keeps its bounds, but the
      // chrome state below must still be restored and the tracking cleared —
      // refusing outright left setFullScreenable(false) and onboarding's
      // minimum-size floor on the control panel for the rest of its life.
      if (!win.isFullScreen() && !win.isMaximized() && this._onboardingRestoreBounds) {
        win.setContentBounds(clampedBounds(this._onboardingRestoreBounds, workArea), true);
      }
      const state = this._onboardingWindowState;
      if (state) {
        win.setResizable(state.resizable);
        win.setMinimizable(state.minimizable);
        win.setMaximizable(state.maximizable);
        win.setClosable(state.closable);
        win.setFullScreenable(state.fullscreenable);
        if (state.minimumSize) win.setMinimumSize(...state.minimumSize);
      }
      if (process.platform === "darwin" && typeof win.setWindowButtonVisibility === "function") {
        win.setWindowButtonVisibility(true);
      }
      this._onboardingRestoreBounds = null;
      this._onboardingWindowMode = null;
      this._onboardingWindowState = null;
      this._showControlPanel();
      return true;
    }

    if (!this._onboardingRestoreBounds) {
      this._onboardingRestoreBounds = current;
      this._onboardingWindowState = {
        resizable: win.isResizable(),
        minimizable: win.isMinimizable(),
        maximizable: win.isMaximizable(),
        closable: win.isClosable(),
        fullscreenable: win.isFullScreenable(),
        minimumSize: win.getMinimumSize(),
      };
    }

    this._applyOnboardingWindowChrome(win, mode);

    if (this._onboardingWindowMode === mode) {
      this._showControlPanel();
      return true;
    }

    const target =
      mode === "compact" ? ONBOARDING_WINDOW_SIZES.COMPACT : ONBOARDING_WINDOW_SIZES.EXPANDED;
    const next = centeredBounds(current, target, workArea);
    if (
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      this._onboardingWindowMode = mode;
      this._showControlPanel();
      return true;
    }

    win.setContentBounds(next, true);
    this._onboardingWindowMode = mode;
    this._showControlPanel();
    return true;
  }

  hideControlPanelToTray() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    // An explicit hide is authoritative: the visibility backstop exists to
    // rescue a window that never got shown, and letting it fire now would
    // pull the panel (and the Dock icon) back out of the tray.
    this._clearControlPanelVisibilityTimer();
    // A demo left running when the panel hides would keep swallowing normal
    // dictations (paste suppressed, transcripts rerouted to the demo session).
    this.endOnboardingDemo();
    this.controlPanelWindow.hide();
    dockManager.setControlPanelVisible(false);
  }

  hideDictationPanel() {
    this._mainWindowPlacementCoordinator.cancelPending();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.hide();
  }


  isDictationPanelVisible() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    if (this.mainWindow.isMinimized && this.mainWindow.isMinimized()) {
      return false;
    }

    return this.mainWindow.isVisible();
  }

  registerMainWindowEvents() {
    if (!this.mainWindow) {
      return;
    }

    if (process.platform === "linux") {
      const win = this.mainWindow;
      // backgroundThrottling:false keeps document.visibilityState visible even
      // after hide(). Native visibility owns the Linux input-region updates.
      for (const event of ["show", "hide", "minimize", "restore"]) {
        win.on(event, () => {
          win.webContents.send(
            "main-window-visibility-changed",
            win.isVisible() && !win.isMinimized()
          );
        });
      }
    }

    // Safety timeout: force show the window if ready-to-show doesn't fire within 10 seconds
    const showTimeout = setTimeout(() => {
      if (
        this.mainWindow &&
        !this.mainWindow.isDestroyed() &&
        !this.mainWindow.isVisible() &&
        !this._floatingIconAutoHide
      ) {
        this.showDictationPanel();
      }
    }, 10000);

    this.mainWindow.once("ready-to-show", () => {
      clearTimeout(showTimeout);
      this.enforceMainWindowOnTop();
      if (!this.mainWindow.isVisible() && !this._floatingIconAutoHide) {
        this.showDictationPanel();
      }
    });

    this.mainWindow.on("show", () => {
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("focus", () => {
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("closed", () => {
      this.dragManager.cleanup();
      this.mainWindow = null;
    });
  }

  enforceMainWindowOnTop() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.mainWindow);
    }
  }

  async showMeetingNotification(promptData, { autoDismiss = true } = {}) {
    if (this._onboardingActive) return false;
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

    if (process.platform === "darwin") {
      win.setIgnoreMouseEvents(true, { forward: true });
    }

    // Notifications must clear every other window, including our own floating
    // dictation panel.
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
    if (this._onboardingActive) {
      this.dismissMeetingNotification();
      return false;
    }

    const readyFallback = setTimeout(() => {
      if (this._notificationReadyFallback !== readyFallback) return;
      this._notificationReadyFallback = null;
      if (this._onboardingActive || this.notificationWindow !== win || win.isDestroyed()) return;
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
    if (this._onboardingActive) {
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

  refreshLocalizedUi() {
    MenuManager.setupMainMenu(() => this.openSettings());

    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
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
