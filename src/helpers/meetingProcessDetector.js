const EventEmitter = require("events");
const debugLogger = require("./debugLogger");
const processListCache = require("./processListCache");

const BUNDLE_ID_MAP = {
  "us.zoom.xos": "zoom",
  "com.microsoft.teams": "teams",
  "com.microsoft.teams2": "teams",
  "com.cisco.webexmeetingsapp": "webex",
  "com.apple.FaceTime": "facetime",
};

const BUNDLE_APP_NAMES = {
  zoom: "Zoom",
  teams: "Microsoft Teams",
  webex: "Webex",
  facetime: "FaceTime",
};

class MeetingProcessDetector extends EventEmitter {
  constructor() {
    super();
    this.detectedProcesses = new Map();
    this.dismissedProcesses = new Set();
    this._subscriptionIds = [];
    this._running = false;
    this._startGeneration = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const generation = ++this._startGeneration;

    const { systemPreferences } = require("electron");

    const launchId = systemPreferences.subscribeWorkspaceNotification(
      "NSWorkspaceDidLaunchApplicationNotification",
      (_event, userInfo) => {
        const bundleId = userInfo?.NSApplicationBundleIdentifier;
        const processKey = bundleId ? BUNDLE_ID_MAP[bundleId] : null;
        if (processKey) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.debug("Workspace app launched", { bundleId, processKey }, "meeting");
          this._updateDetection(processKey, appName, true);
        }
      }
    );

    const terminateId = systemPreferences.subscribeWorkspaceNotification(
      "NSWorkspaceDidTerminateApplicationNotification",
      (_event, userInfo) => {
        const bundleId = userInfo?.NSApplicationBundleIdentifier;
        const processKey = bundleId ? BUNDLE_ID_MAP[bundleId] : null;
        if (processKey) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.debug("Workspace app terminated", { bundleId, processKey }, "meeting");
          this._updateDetection(processKey, appName, false);
        }
      }
    );

    this._subscriptionIds.push(launchId, terminateId);

    debugLogger.info(
      "Process detector started",
      {
        mode: "NSWorkspace",
        bundleIds: Object.keys(BUNDLE_ID_MAP),
      },
      "meeting"
    );

    this._initialScan(generation);
  }

  // True once stop() or a newer start() has superseded the run that owns `generation`.
  _isStale(generation) {
    return !this._running || generation !== this._startGeneration;
  }

  async _initialScan(generation) {
    try {
      const processList = await processListCache.getProcessList();
      if (this._isStale(generation)) return;
      const darwinProcessNames = [
        { match: "zoom.us", processKey: "zoom" },
        { match: "microsoft teams", processKey: "teams" },
        { match: "webex", processKey: "webex" },
        { match: "facetime", processKey: "facetime" },
      ];
      for (const { match, processKey } of darwinProcessNames) {
        if (processList.some((p) => p.includes(match))) {
          const appName = BUNDLE_APP_NAMES[processKey] || processKey;
          debugLogger.info("Initial scan: already running", { processKey, appName }, "meeting");
          this._updateDetection(processKey, appName, true);
        }
      }
    } catch (err) {
      debugLogger.warn("Initial scan failed", { error: err.message }, "meeting");
    }
  }

  stop() {
    if (!this._running) return;
    this._running = false;

    if (this._subscriptionIds.length > 0) {
      try {
        const { systemPreferences } = require("electron");
        for (const id of this._subscriptionIds) {
          systemPreferences.unsubscribeWorkspaceNotification(id);
        }
      } catch {
        // electron may not be available during cleanup
      }
      this._subscriptionIds = [];
    }

    this.detectedProcesses.clear();
    this.dismissedProcesses.clear();
    debugLogger.info("Stopped meeting process detector", {}, "meeting");
  }

  dismiss(processKey) {
    this.dismissedProcesses.add(processKey);
    debugLogger.info("Process detection dismissed", { processKey }, "meeting");
  }

  getDetectedProcesses() {
    return Array.from(this.detectedProcesses.entries()).map(([processKey, { detectedAt }]) => ({
      processKey,
      appName: this._getAppName(processKey),
      detectedAt,
    }));
  }

  _getAppName(processKey) {
    return BUNDLE_APP_NAMES[processKey] || processKey;
  }

  _updateDetection(processKey, appName, isRunning) {
    if (isRunning) {
      if (!this.detectedProcesses.has(processKey) && !this.dismissedProcesses.has(processKey)) {
        const detectedAt = Date.now();
        this.detectedProcesses.set(processKey, { detectedAt });
        debugLogger.info("Meeting process detected", { processKey, appName }, "meeting");
        this.emit("meeting-process-detected", { processKey, appName, detectedAt });
      }
    } else if (this.detectedProcesses.has(processKey)) {
      this.detectedProcesses.delete(processKey);
      this.dismissedProcesses.delete(processKey);
      debugLogger.info("Meeting process ended", { processKey, appName }, "meeting");
      this.emit("meeting-process-ended", { processKey, appName });
    }
  }
}

module.exports = MeetingProcessDetector;
