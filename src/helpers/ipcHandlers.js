const {
  ipcMain,
  app,
  shell,
  BrowserWindow,
  clipboard,
  systemPreferences,
  net,
} = require("electron");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { getModelType, isSherpaLocalProvider } = require("./parakeetModelInfo");
const { broadcastToWindows } = require("./windowBroadcast");
const { openExternalUrl } = require("./externalUrlOpener");
const { resolveFailedGpuBackends } = require("./whisper");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const { resolveSystemDefaultMicrophone } = require("./systemDefaultMicrophone");
const autoStart = require("./autoStart");
const { getRelaunchOptions, getRelaunchWaiter } = require("./autoStartPolicy");
const { i18nMain, changeLanguage } = require("./i18nMain");
const { getCortiToken } = require("./cortiAuth");
const LocalModelDownloadStatus = require("./localModelDownloadStatus");
const createMeetingTranscriptionLifecycle = require("./meetingTranscriptionLifecycle");
const liveSpeakerIdentifier = require("./liveSpeakerIdentifier");
const { supportsLiveSpeakerIdentification } = require("./liveSpeakerIdPolicy");
const MeetingEchoLeakDetector = require("./meetingEchoLeakDetector");
const createMeetingSystemAudioWatchdog = require("./meetingSystemAudioWatchdog");
const {
  partitionPendingMicFinals,
  isRiskyMicDuplicateProfile,
  isDuplicateMicSegment,
  selectRacingMicEntryIndices,
  partitionOverlappingPendingMicFinals,
} = require("./meetingMicHoldback");
const {
  computeChunkStats,
  resolveMicChunkAction,
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
} = require("./meetingMicGate");
const { deriveDetectorPreferences } = require("./meetingDetectionPreferencePolicy");
const { resolveDiarizationInput } = require("./meetingDiarizationInput");
const {
  transcriptsOverlap,
  transcriptsLooselyOverlap,
  buildMergedCandidates,
} = require("./transcriptText");
const {
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
  canAutoRelabelSpeaker,
  isSpeakerLocked,
} = require("./speakerAssignmentPolicy");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const { downsample24kTo16k, pcm16ToWav } = require("../utils/audioUtils");
const {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} = require("../constants/speakerDetection.json");
const {
  DEFAULT_WHISPER_VAD_CONFIG,
  sanitizeWhisperVadConfig,
  resolveContextSileroEnabled,
} = require("./whisperVadConfig");

const {
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
} = require("./meetingStreamingProviders");
const { fetchRealtimeTokenForProvider } = require("./realtimeTokenProviders");

// Meeting capture runs at 24 kHz (see meetingRecordingStore AudioContext); cloud
// streaming providers must be told the true PCM rate or they misread the audio.
const MEETING_STREAM_SAMPLE_RATE = 24000;
const MEETING_RECONNECT_BUFFER_MAX_BYTES = MEETING_STREAM_SAMPLE_RATE * 2 * 30;
// The realtime clients default to a 0.6 server-VAD threshold, raised in #630 to
// keep mic ambient noise from opening turns. The system loopback channel's noise
// floor is digital silence, so it keeps the original, more sensitive threshold —
// at 0.6 quiet remote speech may never trip the VAD and the whole channel
// transcribes to nothing.
const MEETING_SYSTEM_VAD_THRESHOLD = 0.3;

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.whisperManager = managers.whisperManager;
    this.parakeetManager = managers.parakeetManager;
    this.diarizationManager = managers.diarizationManager;
    this.windowManager = managers.windowManager;
    this.updateManager = managers.updateManager;
    this.getTrayManager = managers.getTrayManager;
    this.whisperCudaManager = managers.whisperCudaManager;
    this.whisperVulkanManager = managers.whisperVulkanManager;
    this.googleCalendarManager = managers.googleCalendarManager;
    this.microsoftCalendarManager = managers.microsoftCalendarManager;
    this.appleCalendarManager = managers.appleCalendarManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.audioTapManager = managers.audioTapManager;
    this.linuxPortalAudioManager = managers.linuxPortalAudioManager;
    this.windowsLoopbackAudioManager = managers.windowsLoopbackAudioManager;
    this.meetingAecManager = managers.meetingAecManager;
    this.sessionId = crypto.randomUUID();
    this._meetingMicStreaming = null;
    this._meetingSystemStreaming = null;
    this.localModelDownloadStatus = new LocalModelDownloadStatus();
    this._noteFilesEnabled = false;
    this._granolaImportPending = null;
    this.speakerDiarizationEnabled = true;
    // Default for the saved process-detection toggle. The engine keeps both detectors
    // off until the renderer syncs (see meetingDetectionPreferencePolicy.js).
    this.meetingProcessDetection = true;
    this.activeMeetingSpeakerConfig = null;
    this.whisperVadSettings = {
      dictationSileroEnabled: false,
      noteRecordingSileroEnabled: true,
      meetingSileroEnabled: true,
      ...DEFAULT_WHISPER_VAD_CONFIG,
    };
    liveSpeakerIdentifier.setDiarizationManager(this.diarizationManager);
    this._logDetectedGpus();
    // Warm the OS default mic answer before the first hotkey press (~2s on Windows).
    resolveSystemDefaultMicrophone();
    this.setupHandlers();
    if (this.whisperManager?.serverManager) {
      // Remember the failed backend so it isn't re-attempted (and its model
      // reload re-paid) on every launch; cleared by retry, re-download, delete.
      this.whisperManager.serverManager.on("cuda-fallback", () => {
        this._recordWhisperGpuFailure("cuda");
        broadcastToWindows("cuda-fallback-notification", {});
      });
      this.whisperManager.serverManager.on("gpu-fallback", () => {
        this._recordWhisperGpuFailure("vulkan");
        broadcastToWindows("gpu-fallback-notification", {});
      });
      // Persist the discrete-GPU pin so later launches spawn pinned directly
      // instead of paying a second Vulkan cold start. See #1606.
      this.whisperManager.serverManager.on("vulkan-device-pinned", ({ index }) => {
        this._syncStartupEnv({ WHISPER_VULKAN_DEVICE: String(index) });
      });
      this.whisperManager.serverManager.on("vulkan-device-pin-cleared", () => {
        this._syncStartupEnv({}, ["WHISPER_VULKAN_DEVICE"]);
      });
    }
  }

  _getWhisperVadSettings() {
    const current = this.whisperVadSettings || {};
    return {
      dictationSileroEnabled: current.dictationSileroEnabled === true,
      noteRecordingSileroEnabled: current.noteRecordingSileroEnabled !== false,
      meetingSileroEnabled: current.meetingSileroEnabled !== false,
      ...sanitizeWhisperVadConfig(current),
    };
  }

  _updateNativeModelDownloadStatus(modelType, modelId, progressData) {
    if (progressData.type === "complete") {
      return this.localModelDownloadStatus.finish(modelType, modelId);
    }

    if (progressData.type === "installing") {
      return this.localModelDownloadStatus.update(modelType, modelId, {
        phase: "installing",
        progress: progressData.percentage || 100,
      });
    }

    return this.localModelDownloadStatus.update(modelType, modelId, {
      phase: "downloading",
      progress: progressData.percentage || 0,
      downloadedBytes: progressData.downloaded_bytes || 0,
      totalBytes: progressData.total_bytes || 0,
    });
  }

  _setWhisperVadSettings(update = {}) {
    const ALLOWED_KEYS = new Set([
      "dictationSileroEnabled",
      "noteRecordingSileroEnabled",
      "meetingSileroEnabled",
      ...Object.keys(require("../constants/whisperVad.json").DEFAULTS),
    ]);
    const filtered = {};
    for (const [k, v] of Object.entries(update)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = v;
    }
    this.whisperVadSettings = { ...this._getWhisperVadSettings(), ...filtered };
    return this._getWhisperVadSettings();
  }

  _resolveWhisperVadOptions(context) {
    const settings = this._getWhisperVadSettings();
    const {
      dictationSileroEnabled,
      noteRecordingSileroEnabled,
      meetingSileroEnabled,
      ...vadConfig
    } = settings;
    return {
      vadEnabled: resolveContextSileroEnabled(settings, context),
      vadConfig,
    };
  }

  _mirrorDeleteFolderIfUnshared(folderName) {
    if (!this._noteFilesEnabled) return;
    // Folder names are only unique per space — a live same-named folder in
    // another space shares the mirror directory, so leave it on disk.
    const stillLive = this.databaseManager.db
      .prepare("SELECT 1 FROM folders WHERE name = ? AND deleted_at IS NULL")
      .get(folderName);
    if (stillLive) return;
    const markdownMirror = require("./markdownMirror");
    markdownMirror.deleteFolder(folderName);
  }

  _asyncMirrorWrite(note) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug(
        "Mirror write skipped: note files disabled",
        { noteId: note.id },
        "note-files"
      );
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      const folderName = this._getFolderName(note.folder_id);
      markdownMirror.writeNote(note, folderName);
      if (note.transcript) {
        markdownMirror.writeTranscript(note, folderName, this._buildSpeakerMappings(note.id));
      }
    });
  }

  _asyncMirrorDelete(noteId) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug("Mirror delete skipped: note files disabled", { noteId }, "note-files");
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      markdownMirror.deleteNote(noteId);
    });
  }

  _buildFolderMap() {
    const folders = this.databaseManager.getFolders();
    const map = {};
    for (const f of folders) {
      map[f.id] = f.name;
    }
    return map;
  }

  _buildSpeakerMappings(noteId) {
    const arr = this.databaseManager.getSpeakerMappings(noteId);
    const map = {};
    for (const m of arr) {
      map[m.speaker_id] = m.display_name;
    }
    return map;
  }

  _parseNonSelfParticipants(participantsJson) {
    if (!participantsJson) return [];
    let participants;
    try {
      participants = JSON.parse(participantsJson);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(participants) || participants.length === 0) return [];
    const googleEmails = new Set(
      this.databaseManager.getGoogleAccounts().map((a) => a.email.toLowerCase())
    );
    return participants.filter(
      (p) => p && p.self !== true && !googleEmails.has((p.email || "").toLowerCase())
    );
  }

  _getNoteNonSelfParticipants(noteId) {
    if (!noteId) return [];
    try {
      const note = this.databaseManager.getNote(noteId);
      return this._parseNonSelfParticipants(note?.participants);
    } catch (_) {
      return [];
    }
  }

  _resolveOneOnOneOtherParticipant(participantsJson) {
    const others = this._parseNonSelfParticipants(participantsJson);
    if (others.length !== 1) return null;
    const displayName = others[0].displayName || others[0].email;
    if (!displayName) return null;
    const email = (others[0].email || "").toLowerCase().trim() || null;
    return { displayName, email };
  }

  _noteExpectedSpeakerCountOrNull(note) {
    const stored = normalizeStoredSpeakerCount(note?.expected_speaker_count);
    if (stored != null) {
      return stored;
    }
    const others = this._parseNonSelfParticipants(note?.participants).length;
    if (others > 0) {
      return Math.min(others + 1, MAX_SPEAKER_COUNT);
    }
    return null;
  }

  _resolveNoteExpectedSpeakerCount(note) {
    return this._noteExpectedSpeakerCountOrNull(note) ?? DEFAULT_EXPECTED_SPEAKER_COUNT;
  }

  _resolveInitialMeetingSpeakerConfig(noteId) {
    let note = null;
    if (noteId != null) {
      try {
        note = this.databaseManager.getNote(noteId);
      } catch (_) {
        note = null;
      }
    }
    const enabled =
      (note?.diarization_enabled == null
        ? this.speakerDiarizationEnabled
        : note.diarization_enabled !== 0) !== false;
    return { enabled, expectedCount: this._resolveNoteExpectedSpeakerCount(note) };
  }

  // Participants added mid-meeting must raise the speaker cap that was derived
  // from the note at recording start. A count the user set via the stepper
  // (explicit) is never overridden.
  //
  // Raise-only: lowering the cap below the clusters already discovered would make
  // _assignOrForceCluster fold every later voice onto an existing speaker — the
  // exact identity collapse this refresh exists to prevent. A roster that shrinks
  // (or empties) mid-meeting therefore leaves the cap where it is.
  _refreshMeetingSpeakerConfigFromNote(noteId, note) {
    const config = this.activeMeetingSpeakerConfig;
    if (!config || config.explicit) return;
    if (noteId == null || this._activeMeetingNoteId !== noteId) return;

    const expectedCount = this._noteExpectedSpeakerCountOrNull(note);
    if (expectedCount == null || expectedCount <= config.expectedCount) return;

    this.activeMeetingSpeakerConfig = { ...config, expectedCount };
    liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
    broadcastToWindows("meeting-session-speaker-config-updated", {
      enabled: config.enabled,
      expectedCount,
    });
    debugLogger.info(
      "Meeting speaker config refreshed from participants",
      { noteId, expectedCount },
      "speaker"
    );
  }

  _rebuildMirror(basePath) {
    const markdownMirror = require("./markdownMirror");
    if (basePath) markdownMirror.init(basePath);
    const notes = this.databaseManager.getNotes(null, 99999);
    const speakerMappingsMap = {};
    for (const note of notes) {
      if (note.transcript) {
        speakerMappingsMap[note.id] = this._buildSpeakerMappings(note.id);
      }
    }
    markdownMirror.rebuildAll(notes, this._buildFolderMap(), speakerMappingsMap);
  }

  _getFolderName(folderId) {
    if (!folderId) return "Personal";
    const folder = this.databaseManager.db
      .prepare("SELECT name FROM folders WHERE id = ?")
      .get(folderId);
    return folder?.name || "Personal";
  }

  async _logDetectedGpus() {
    const { listNvidiaGpus } = require("../utils/gpuDetection");
    const gpus = await listNvidiaGpus();
    if (gpus.length > 0) {
      debugLogger.info(
        "NVIDIA GPUs detected",
        {
          count: gpus.length,
          devices: gpus.map((g) => `[${g.index}] ${g.name} (${g.vramMb}MB) ${g.uuid}`),
        },
        "gpu"
      );
    } else {
      debugLogger.debug("No NVIDIA GPUs detected", {}, "gpu");
    }
  }

  _whisperGpuFailedBackends() {
    return resolveFailedGpuBackends(process.env.WHISPER_GPU_FAILED);
  }

  _recordWhisperGpuFailure(backend) {
    const failed = this._whisperGpuFailedBackends();
    if (!failed.includes(backend)) failed.push(backend);
    this._syncStartupEnv({ WHISPER_GPU_FAILED: failed.join(",") });
  }

  _clearWhisperGpuFailure(backend) {
    const failed = this._whisperGpuFailedBackends().filter((b) => b !== backend);
    if (failed.length > 0) {
      this._syncStartupEnv({ WHISPER_GPU_FAILED: failed.join(",") });
    } else {
      this._syncStartupEnv({}, ["WHISPER_GPU_FAILED"]);
    }
  }

  // Captured before a handler stops the server to touch pack files (stopServer
  // clears currentServerModel); tells _applyWhisperGpuPreference what to reload.
  _whisperReloadModel() {
    return this.whisperManager.serverManager.isRemote
      ? null
      : this.whisperManager.currentServerModel;
  }

  // Apply a GPU pack change to the loaded server without blocking the caller's
  // IPC reply (a Vulkan cold start can take minutes); the renderer follows
  // progress by polling whisper-server-status. Returns whether a reload was
  // kicked off so the UI shows "activating" only when one is coming.
  _applyWhisperGpuPreference(modelName) {
    this.whisperManager.restartServerWithGpuPreference(modelName).catch((err) => {
      debugLogger.error("whisper-server GPU preference restart failed", { error: err.message });
    });
    return !!modelName;
  }

  _syncStartupEnv(setVars, clearVars = []) {
    let changed = false;
    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }
    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }
    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      // A swallowed .env write failure here left GPU enablement flags silently
      // out of sync with the packs on disk (#1340) — log which keys were lost.
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
        debugLogger.error("Failed to persist startup env vars to .env", {
          set: Object.keys(setVars),
          clearRequested: clearVars,
          error: err.message,
        });
      });
    }
  }

  // Mints a Corti access token from stored BYOK credentials. Shared by the
  // dictation streaming handlers and the meeting realtime-token resolver.
  async _mintStoredCortiToken(options = {}) {
    const clientId = this.environmentManager.getCortiClientId();
    const clientSecret = this.environmentManager.getCortiClientSecret();
    if (!clientId || !clientSecret) {
      const err = new Error("No Corti credentials configured. Add them in Settings.");
      err.code = "NO_API";
      throw err;
    }
    const environment = options.environment || "us";
    const tenant = (options.tenant || "").trim() || "base";
    const token = await getCortiToken({ environment, tenant, clientId, clientSecret });
    return { token, environment, tenant };
  }

  setupHandlers() {
    ipcMain.handle("onboarding-set-window-mode", (_event, mode) =>
      this.windowManager.setOnboardingWindowMode(mode)
    );

    ipcMain.handle("onboarding-set-active", (_event, active) => {
      if (typeof active !== "boolean") return false;
      return this.windowManager.setOnboardingActive(active);
    });

    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    ipcMain.handle("snap-to-meeting-mode", () => {
      this.windowManager.snapControlPanelToMeetingMode();
    });

    ipcMain.handle("restore-from-meeting-mode", () => {
      this.windowManager.restoreControlPanelFromMeetingMode();
      this.meetingDetectionEngine?.setMeetingModeActive(false);
    });

    ipcMain.handle("set-notification-interactivity", (event, interactive) => {
      this.windowManager.setNotificationInteractivity(event.sender, Boolean(interactive));
      return { success: true };
    });

    for (const k of BYOK_API_KEYS) {
      ipcMain.handle(`get-${k.base}-key`, () => this.environmentManager[k.get]());
      ipcMain.handle(`save-${k.base}-key`, (event, key) => this.environmentManager[k.save](key));
    }

    ipcMain.handle(
      "db-save-note",
      async (event, title, content, noteType, sourceFile, audioDuration, folderId, spaceId) => {
        const result = this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId,
          spaceId
        );
        if (result?.success && result?.note) {
          setImmediate(() => broadcastToWindows("note-added", result.note));
          this._asyncMirrorWrite(result.note);
        }
        return result;
      }
    );

    ipcMain.handle("db-get-note", async (event, id) => {
      return this.databaseManager.getNote(id);
    });

    ipcMain.handle("db-get-notes", async (event, noteType, limit, folderId, spaceId) => {
      return this.databaseManager.getNotes(noteType, limit, folderId, spaceId);
    });

    ipcMain.handle("db-get-space-notes", async (event, spaceId, limit) => {
      return this.databaseManager.getNotesForSpace(spaceId, limit);
    });

    ipcMain.handle("db-update-note", async (event, id, updates) => {
      const result = this.databaseManager.updateNote(id, updates);
      if (result?.success && result?.note) {
        setImmediate(() => broadcastToWindows("note-updated", result.note));
        this._asyncMirrorWrite(result.note);
        if (updates.participants) {
          this._tryAutoLabelOneOnOne(id);
          this._refreshMeetingSpeakerConfigFromNote(id, result.note);
        }
      }
      return result;
    });

    ipcMain.handle("db-delete-note", async (event, id) => {
      return this.deleteNoteInternal(id);
    });

    ipcMain.handle("db-search-notes", async (event, query, limit, spaceId, folderId) => {
      return this.databaseManager.searchNotes(query, limit, spaceId, folderId);
    });

    ipcMain.handle("db-get-folders", async (event, spaceId) => {
      return this.databaseManager.getFolders(spaceId);
    });

    ipcMain.handle("db-create-folder", async (event, name, spaceId) => {
      const result = this.databaseManager.createFolder(name, spaceId);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          broadcastToWindows("folder-created", result.folder);
          if (this._noteFilesEnabled) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.ensureFolder(result.folder.name);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-folder", async (event, id) => {
      const folderName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.deleteFolder(id);
      if (result?.success) {
        // Other accounts' notes were released to the space root; their mirror
        // files leave with the folder directory, so rewrite the live ones.
        for (const note of result.relocatedNotes ?? []) {
          if (!note.deleted_at) this._asyncMirrorWrite(note);
        }
        setImmediate(() => {
          broadcastToWindows("folder-deleted", { id });
          if (folderName) this._mirrorDeleteFolderIfUnshared(folderName);
        });
      }
      return result;
    });

    ipcMain.handle("db-rename-folder", async (event, id, name) => {
      const oldName = this._noteFilesEnabled ? this._getFolderName(id) : null;
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          broadcastToWindows("folder-renamed", result.folder);
          if (this._noteFilesEnabled && oldName) {
            const markdownMirror = require("./markdownMirror");
            markdownMirror.renameFolder(oldName, name);
          }
        });
      }
      return result;
    });

    ipcMain.handle("db-get-folder-note-counts", async () => {
      return this.databaseManager.getFolderNoteCounts();
    });

    ipcMain.handle("db-get-spaces", async () => {
      return this.databaseManager.getSpaces();
    });

    ipcMain.handle("export-note", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const { dialog } = require("electron");
        const fs = require("fs");
        const exportFormat =
          format === "txt"
            ? { name: "Text", extension: "txt" }
            : { name: "Markdown", extension: "md" };
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${exportFormat.extension}`,
          filters: [{ name: exportFormat.name, extensions: [exportFormat.extension] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        let exportContent;
        if (format === "txt") {
          exportContent = (note.content || "")
            .replace(/#{1,6}\s+/g, "")
            .replace(/[*_~`]+/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
            .replace(/^>\s+/gm, "")
            .trim();
        } else {
          exportContent = note.enhanced_content || note.content;
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting note", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-transcript", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const segments = JSON.parse(note.transcript || "[]");
        if (!segments.length) return { success: false, error: "No transcript available" };

        const speakerMappings = this._buildSpeakerMappings(noteId);

        const { dialog } = require("electron");
        const fs = require("fs");
        const exportFormats = {
          txt: { name: "Text", extension: "txt" },
          srt: { name: "SubRip Subtitles", extension: "srt" },
          json: { name: "JSON", extension: "json" },
          md: { name: "Markdown", extension: "md" },
        };
        const exportFormat = exportFormats[format] || exportFormats.txt;
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${exportFormat.extension}`,
          filters: [{ name: exportFormat.name, extensions: [exportFormat.extension] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        const transcriptFormatter = require("./transcriptFormatter");
        let exportContent;
        if (format === "txt") {
          exportContent = transcriptFormatter.formatTxt(note, segments, speakerMappings);
        } else if (format === "srt") {
          exportContent = transcriptFormatter.formatSrt(segments, speakerMappings, note);
        } else if (format === "md") {
          exportContent = transcriptFormatter.formatMd(note, segments, speakerMappings);
        } else {
          exportContent = transcriptFormatter.formatJson(note, segments, speakerMappings);
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting transcript", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("read-clipboard", () => clipboard.readText());

    ipcMain.handle("write-clipboard", (_event, text) => {
      clipboard.writeText(text);
      return { success: true };
    });

    ipcMain.handle("check-whisper-installation", async (event) => {
      return this.whisperManager.checkWhisperInstallation();
    });

    ipcMain.handle("get-audio-diagnostics", async () => {
      return this.whisperManager.getDiagnostics();
    });

    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      const hadActiveDownload = this.localModelDownloadStatus.has("whisper", modelName);
      this.localModelDownloadStatus.start("whisper", modelName);
      try {
        const result = await this.whisperManager.downloadWhisperModel(modelName, (progressData) => {
          const status = this._updateNativeModelDownloadStatus("whisper", modelName, progressData);
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            ...progressData,
            sequence: status?.sequence,
          });
        });
        const status = this.localModelDownloadStatus.has("whisper", modelName)
          ? this.localModelDownloadStatus.finish("whisper", modelName)
          : null;
        if (status) {
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            type: "complete",
            model: modelName,
            percentage: 100,
            sequence: status.sequence,
          });
        }
        return result;
      } catch (error) {
        const status = hadActiveDownload
          ? null
          : this.localModelDownloadStatus.finish("whisper", modelName);
        if (!hadActiveDownload && error.code !== "DOWNLOAD_IN_PROGRESS") {
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
            sequence: status?.sequence,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-model-status", async (event, modelName) => {
      return this.whisperManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-whisper-models", async (event) => {
      return this.whisperManager.listWhisperModels();
    });

    ipcMain.handle("delete-whisper-model", async (event, modelName) => {
      return this.whisperManager.deleteWhisperModel(modelName);
    });

    ipcMain.handle("delete-all-whisper-models", async () => {
      return this.whisperManager.deleteAllWhisperModels();
    });

    ipcMain.handle("cancel-whisper-download", async (event) => {
      return this.whisperManager.cancelDownload();
    });

    ipcMain.handle("whisper-server-start", async (event, modelName) => {
      return this.whisperManager.startServer(
        modelName,
        this.whisperManager.resolveGpuStartOptions()
      );
    });

    ipcMain.handle("whisper-server-stop", async () => {
      return this.whisperManager.stopServer();
    });

    ipcMain.handle("whisper-server-status", async () => {
      return this.whisperManager.getServerStatus();
    });

    ipcMain.handle("detect-gpu", async () => {
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      return detectNvidiaGpu();
    });

    ipcMain.handle("list-gpus", async () => {
      const { listNvidiaGpus } = require("../utils/gpuDetection");
      return listNvidiaGpus();
    });

    ipcMain.handle("set-gpu-device-index", async (_event, purpose, uuid) => {
      if (purpose !== "transcription") {
        return { success: false };
      }
      // Empty string clears the pinned GPU; otherwise require an nvidia-smi UUID. See #531.
      if (typeof uuid !== "string" || (uuid !== "" && !uuid.startsWith("GPU-"))) {
        return { success: false };
      }
      const key = "TRANSCRIPTION_GPU_UUID";
      const oldUuid = process.env[key] || "";
      process.env[key] = uuid;
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
        debugLogger.error("Failed to persist GPU UUID", { error: err.message }, "gpu");
      });

      if (oldUuid !== uuid) {
        try {
          if (this.whisperManager?.serverManager?.process) {
            debugLogger.info(
              "Restarting whisper-server for GPU change",
              { from: oldUuid, to: uuid },
              "gpu"
            );
            await this.whisperManager.restartServerWithGpuPreference();
          }
        } catch (err) {
          debugLogger.error(
            "Failed to restart server after GPU change",
            { error: err.message, purpose },
            "gpu"
          );
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-gpu-device-index", async (_event, purpose) => {
      if (purpose !== "transcription") {
        return "";
      }
      return process.env.TRANSCRIPTION_GPU_UUID || "";
    });

    ipcMain.handle("get-cuda-whisper-status", async () => {
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      const gpuInfo = await detectNvidiaGpu();
      if (!this.whisperCudaManager) {
        return { downloaded: false, downloading: false, path: null, gpuInfo };
      }
      return {
        downloaded: this.whisperCudaManager.isDownloaded(),
        downloading: this.whisperCudaManager.isDownloading(),
        path: this.whisperCudaManager.getCudaBinaryPath(),
        gpuInfo,
        gpuFailed: this._whisperGpuFailedBackends().includes("cuda"),
      };
    });

    ipcMain.handle("download-cuda-whisper-binary", async (event) => {
      if (!this.whisperCudaManager) {
        return { success: false, error: "CUDA not supported on this platform" };
      }
      try {
        const reloadModel = this._whisperReloadModel();
        // Stop the server first: swapping in a pack a running binary is loaded
        // from EBUSYs on Windows (same rule as the Vulkan handler below)
        await this.whisperManager.stopServer().catch(() => {});
        await this.whisperCudaManager.download((downloaded, total) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("cuda-download-progress", {
              downloadedBytes: downloaded,
              totalBytes: total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        });
        this._syncStartupEnv({ WHISPER_CUDA_ENABLED: "true" });
        this._clearWhisperGpuFailure("cuda");
        return { success: true, willRestart: this._applyWhisperGpuPreference(reloadModel) };
      } catch (error) {
        debugLogger.error("CUDA binary download failed", {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-cuda-whisper-download", async () => {
      if (!this.whisperCudaManager) return { success: false };
      return this.whisperCudaManager.cancelDownload();
    });

    ipcMain.handle("delete-cuda-whisper-binary", async () => {
      if (!this.whisperCudaManager) return { success: false };
      const reloadModel = this._whisperReloadModel();
      // Stop the server first so the running binary can be deleted on Windows
      await this.whisperManager.stopServer().catch(() => {});
      const result = await this.whisperCudaManager.delete();
      if (result.success) {
        this._syncStartupEnv({}, ["WHISPER_CUDA_ENABLED"]);
        this._clearWhisperGpuFailure("cuda");
        this._applyWhisperGpuPreference(reloadModel);
      }
      return result;
    });

    ipcMain.handle("get-vulkan-whisper-status", async () => {
      const { detectVulkanGpu } = require("../utils/vulkanDetection");
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      const [vulkan, gpuInfo] = await Promise.all([detectVulkanGpu(), detectNvidiaGpu()]);
      return {
        downloaded: this.whisperVulkanManager?.isDownloaded() ?? false,
        downloading: this.whisperVulkanManager?.isDownloading() ?? false,
        vulkan,
        hasNvidiaGpu: gpuInfo.hasNvidiaGpu,
        gpuFailed: this._whisperGpuFailedBackends().includes("vulkan"),
      };
    });

    ipcMain.handle("download-vulkan-whisper-binary", async (event) => {
      if (!this.whisperVulkanManager) {
        return { success: false, error: "Vulkan not supported on this platform" };
      }
      try {
        const reloadModel = this._whisperReloadModel();
        // Stop the server first: overwriting a running binary EBUSYs on Windows
        await this.whisperManager.stopServer().catch(() => {});
        await this.whisperVulkanManager.download((downloaded, total) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("vulkan-whisper-download-progress", {
              downloadedBytes: downloaded,
              totalBytes: total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        });
        this._syncStartupEnv({ WHISPER_VULKAN_ENABLED: "true" });
        this._clearWhisperGpuFailure("vulkan");
        return { success: true, willRestart: this._applyWhisperGpuPreference(reloadModel) };
      } catch (error) {
        debugLogger.error("Vulkan whisper binary download failed", {
          error: error.message,
          stack: error.stack,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-vulkan-whisper-download", async () => {
      if (!this.whisperVulkanManager) return { success: false };
      return { success: this.whisperVulkanManager.cancelDownload() };
    });

    ipcMain.handle("delete-vulkan-whisper-binary", async () => {
      if (!this.whisperVulkanManager) return { success: false };
      const reloadModel = this._whisperReloadModel();
      // Stop the server first so the running binary can be deleted on Windows
      await this.whisperManager.stopServer().catch(() => {});
      const { deletedCount } = await this.whisperVulkanManager.delete();
      this._syncStartupEnv({}, ["WHISPER_VULKAN_ENABLED", "WHISPER_VULKAN_DEVICE"]);
      this._clearWhisperGpuFailure("vulkan");
      this._applyWhisperGpuPreference(reloadModel);
      return { success: true, deletedCount };
    });

    // One-time "GPU pack needs re-downloading" notice recorded by the
    // legacy-layout migration before any window existed. See #1606.
    ipcMain.handle("get-gpu-pack-migration-notice", () => {
      return require("./gpuPackMigrationNotice").read();
    });

    ipcMain.handle("dismiss-gpu-pack-migration-notice", () => {
      require("./gpuPackMigrationNotice").clear();
      return { success: true };
    });

    // Clears the remembered GPU failure and reloads the server with the GPU
    // backend re-enabled (Retry on the "GPU could not be activated" state)
    ipcMain.handle("whisper-gpu-retry", async () => {
      this._syncStartupEnv({}, ["WHISPER_GPU_FAILED"]);
      return {
        success: true,
        willRestart: this._applyWhisperGpuPreference(this._whisperReloadModel()),
      };
    });

    ipcMain.handle("check-ffmpeg-availability", async (event) => {
      return this.whisperManager.checkFFmpegAvailability();
    });

    ipcMain.handle("check-parakeet-installation", async () => {
      return this.parakeetManager.checkInstallation();
    });

    ipcMain.handle("download-parakeet-model", async (event, modelName) => {
      const hadActiveDownload = this.localModelDownloadStatus.has("parakeet", modelName);
      this.localModelDownloadStatus.start("parakeet", modelName);
      try {
        const result = await this.parakeetManager.downloadParakeetModel(
          modelName,
          (progressData) => {
            const status = this._updateNativeModelDownloadStatus(
              "parakeet",
              modelName,
              progressData
            );
            this.windowManager.sendToControlPanel("parakeet-download-progress", {
              ...progressData,
              sequence: status?.sequence,
            });
          }
        );
        const status = this.localModelDownloadStatus.has("parakeet", modelName)
          ? this.localModelDownloadStatus.finish("parakeet", modelName)
          : null;
        if (status) {
          this.windowManager.sendToControlPanel("parakeet-download-progress", {
            type: "complete",
            model: modelName,
            percentage: 100,
            sequence: status.sequence,
          });
        }
        return result;
      } catch (error) {
        const status = hadActiveDownload
          ? null
          : this.localModelDownloadStatus.finish("parakeet", modelName);
        if (!hadActiveDownload && error.code !== "DOWNLOAD_IN_PROGRESS") {
          this.windowManager.sendToControlPanel("parakeet-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
            sequence: status?.sequence,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-parakeet-model-status", async (_event, modelName) => {
      return this.parakeetManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-parakeet-models", async () => {
      return this.parakeetManager.listParakeetModels();
    });

    ipcMain.handle("delete-parakeet-model", async (_event, modelName) => {
      return this.parakeetManager.deleteParakeetModel(modelName);
    });

    ipcMain.handle("delete-all-parakeet-models", async () => {
      return this.parakeetManager.deleteAllParakeetModels();
    });

    ipcMain.handle("cancel-parakeet-download", async () => {
      return this.parakeetManager.cancelDownload();
    });

    ipcMain.handle("get-parakeet-diagnostics", async () => {
      return this.parakeetManager.getDiagnostics();
    });

    ipcMain.handle("parakeet-server-start", async (event, modelName) => {
      const result = await this.parakeetManager.startServer(modelName);
      // Persisting a provider that failed to start would wedge every launch
      // into a failing pre-warm.
      if (result.success) {
        process.env.LOCAL_TRANSCRIPTION_PROVIDER =
          getModelType(modelName) === "cohere-transcribe" ? "cohere" : "nvidia";
        process.env.PARAKEET_MODEL = modelName;
        await this.environmentManager.saveAllKeysToEnvFile();
      }
      return result;
    });

    ipcMain.handle("parakeet-server-stop", async () => {
      const result = await this.parakeetManager.stopServer();
      delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
      delete process.env.PARAKEET_MODEL;
      await this.environmentManager.saveAllKeysToEnvFile();
      return result;
    });

    ipcMain.handle("parakeet-server-status", async () => {
      return this.parakeetManager.getServerStatus();
    });

    // Diarization model management
    ipcMain.handle("download-diarization-models", async (event) => {
      try {
        const result = await this.diarizationManager.downloadModels((progressData) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("diarization-download-progress", progressData);
          }
        });
        return result;
      } catch (error) {
        if (!event.sender.isDestroyed()) {
          event.sender.send("diarization-download-progress", {
            type: "error",
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("get-diarization-model-status", async () => {
      return {
        available: this.diarizationManager?.isAvailable() ?? false,
        modelsDownloaded:
          (this.diarizationManager?.isModelDownloaded() ?? false) &&
          (this.diarizationManager?.isVadModelDownloaded() ?? false),
      };
    });

    ipcMain.handle("delete-diarization-models", async () => {
      try {
        await this.diarizationManager.deleteModels();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to delete diarization models", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-diarization-download", async () => {
      return this.diarizationManager.cancelDownload();
    });

    // Under `npm run dev` the Vite server dies with Electron, so a relaunched dev
    // instance would have no renderer: just quit there.
    ipcMain.handle("relaunch-app", async () => {
      if (process.env.NODE_ENV === "development") return app.quit();
      // Once Squirrel.Mac holds a downloaded update it installs it on this quit regardless
      // of any flag, so the updater owns that restart instead of racing app.relaunch().
      if (this.updateManager.hasStagedUpdate()) {
        const { success } = await this.updateManager
          .installUpdate()
          .catch(() => ({ success: false }));
        if (success) return;
      }
      this.updateManager.deferInstallOnQuit();
      const { launcherPath, args } = getRelaunchOptions({
        argv: process.argv,
        appImagePath: process.env.APPIMAGE,
      });
      if (launcherPath) {
        const waiter = getRelaunchWaiter({ launcherPath, args, pid: process.pid });
        require("child_process")
          .spawn(waiter.file, waiter.args, {
            detached: true,
            stdio: "ignore",
            cwd: path.dirname(launcherPath), // never inside the directory being removed
          })
          .unref();
      } else {
        app.relaunch({ args });
      }
      app.quit();
    });

    ipcMain.handle("cleanup-app", async (event) => {
      const fs = require("fs");
      const os = require("os");
      const errors = [];

      // Stop services before deleting files they hold open
      try {
        await this.parakeetManager?.stopServer();
      } catch (e) {
        errors.push(`Parakeet stop: ${e.message}`);
      }
      try {
        this.whisperManager?.stopServer();
      } catch (e) {
        errors.push(`Whisper stop: ${e.message}`);
      }
      try {
        this.googleCalendarManager?.stop();
      } catch (e) {
        errors.push(`GCal stop: ${e.message}`);
      }
      try {
        this.microsoftCalendarManager?.stop();
      } catch (e) {
        errors.push(`MCal stop: ${e.message}`);
      }
      try {
        this.appleCalendarManager?.stop();
      } catch (e) {
        errors.push(`ACal stop: ${e.message}`);
      }
      try {
        await this.diarizationManager?.shutdown();
      } catch (e) {
        errors.push(`Diarization stop: ${e.message}`);
      }
      try {
        const onnxWorkerClient = require("./onnxWorkerClient");
        await onnxWorkerClient.stop();
      } catch (e) {
        errors.push(`Embedding worker stop: ${e.message}`);
      }

      // Revoke Google OAuth tokens before DB is closed
      try {
        await this.googleCalendarManager?.revokeAllTokens();
      } catch (e) {
        errors.push(`GCal revoke: ${e.message}`);
      }

      // Close DB connection before deleting the file
      try {
        this.databaseManager?.db?.close();
      } catch (e) {
        errors.push(`DB close: ${e.message}`);
      }

      // Delete downloaded models
      try {
        const { getModelsDirForService } = require("./modelDirUtils");
        const whisperDir = getModelsDirForService("whisper");
        if (fs.existsSync(whisperDir)) fs.rmSync(whisperDir, { recursive: true, force: true });
      } catch (e) {
        errors.push(`Whisper models: ${e.message}`);
      }
      try {
        await this.parakeetManager?.deleteAllParakeetModels();
      } catch (e) {
        errors.push(`Parakeet models: ${e.message}`);
      }
      try {
        await this.diarizationManager?.deleteModels();
      } catch (e) {
        errors.push(`Diarization models: ${e.message}`);
      }

      // Caches older builds wrote under the shared cache root.
      const homeCacheRoot = path.join(os.homedir(), ".cache", "openwhispr");
      for (const cacheName of ["embedding-models", "qdrant-data", "qdrant-data-dev", "yt-dlp"]) {
        try {
          fs.rmSync(path.join(homeCacheRoot, cacheName), { recursive: true, force: true });
        } catch (e) {
          errors.push(`${cacheName} cache: ${e.message}`);
        }
      }

      // Delete database file + WAL/SHM
      try {
        const dbPath = path.join(
          app.getPath("userData"),
          process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
        );
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
        if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
      } catch (e) {
        errors.push(`DB file: ${e.message}`);
      }

      // Delete device-wide settings and encrypted credentials.
      try {
        await this.environmentManager?.clearAllPersistedData();
      } catch (e) {
        errors.push(`Environment settings: ${e.message}`);
      }
      try {
        for (const fileName of ["globe-preference-state.json", ".system-audio-permission"]) {
          fs.rmSync(path.join(app.getPath("userData"), fileName), { force: true });
        }
      } catch (e) {
        errors.push(`Device setting files: ${e.message}`);
      }
      try {
        fs.rmSync(path.join(app.getPath("userData"), "bin"), { recursive: true, force: true });
      } catch (e) {
        errors.push(`bin runtime: ${e.message}`);
      }
      try {
        autoStart.setAutoStartEnabled(false);
      } catch (e) {
        errors.push(`Launch at login: ${e.message}`);
      }

      // Clear browser-held state, including cookies, IndexedDB, Cache Storage
      // and localStorage persisted by any app window.
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData();
          await win.webContents.session.clearCache();
        }
      } catch (e) {
        errors.push(`Browser data: ${e.message}`);
      }

      // Clear localStorage
      try {
        await event.sender.executeJavaScript("localStorage.clear()");
      } catch (e) {
        errors.push(`localStorage: ${e.message}`);
      }

      if (errors.length > 0) {
        debugLogger.warn("Cleanup completed with errors", { errors }, "cleanup");
      }

      return { success: errors.length === 0, message: "Cleanup completed", errors };
    });

    ipcMain.handle("start-control-panel-drag", async () => {
      return await this.windowManager.startControlPanelDrag();
    });

    ipcMain.handle("stop-control-panel-drag", async () => {
      return await this.windowManager.stopControlPanelDrag();
    });

    ipcMain.handle("open-external", async (event, url) => {
      try {
        const { protocol } = new URL(url);
        if (!["http:", "https:", "mailto:"].includes(protocol)) {
          return { success: false, error: `Blocked URL scheme: ${protocol}` };
        }
        await openExternalUrl(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        return autoStart.getAutoStartState();
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return { enabled: false, requiresApproval: false };
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        autoStart.setAutoStartEnabled(enabled);
        debugLogger.debug("Auto-start setting updated", { enabled });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("model-get-active-downloads", async () => {
      return this.localModelDownloadStatus.getActiveDownloads();
    });

    ipcMain.handle("get-corti-client-id", async () => {
      return this.environmentManager.getCortiClientId();
    });

    ipcMain.handle("save-corti-client-id", async (event, key) => {
      return this.environmentManager.saveCortiClientId(key);
    });

    ipcMain.handle("get-corti-client-secret", async () => {
      return this.environmentManager.getCortiClientSecret();
    });

    ipcMain.handle("save-corti-client-secret", async (event, key) => {
      return this.environmentManager.saveCortiClientSecret(key);
    });

    ipcMain.handle("get-custom-transcription-key", async () => {
      return this.environmentManager.getCustomTranscriptionKey();
    });

    ipcMain.handle("save-custom-transcription-key", async (event, key) => {
      return this.environmentManager.saveCustomTranscriptionKey(key);
    });

    ipcMain.handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    ipcMain.handle("save-ui-language", async (event, language) => {
      return this.environmentManager.saveUiLanguage(language);
    });

    ipcMain.handle("set-ui-language", async (event, language) => {
      const result = this.environmentManager.saveUiLanguage(language);
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    ipcMain.handle("sync-startup-preferences", async (event, prefs) => {
      const setVars = {};
      const clearVars = [];

      if (prefs.useLocalWhisper && prefs.model) {
        // Local mode with model selected - set provider and model for pre-warming
        setVars.LOCAL_TRANSCRIPTION_PROVIDER = prefs.localTranscriptionProvider;
        if (prefs.language) setVars.DICTATION_LANGUAGE = prefs.language;
        if (isSherpaLocalProvider(prefs.localTranscriptionProvider)) {
          setVars.PARAKEET_MODEL = prefs.model;
          clearVars.push("LOCAL_WHISPER_MODEL");
          this.whisperManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop whisper-server on provider switch", {
              error: err.message,
            });
          });
        } else {
          setVars.LOCAL_WHISPER_MODEL = prefs.model;
          clearVars.push("PARAKEET_MODEL");
          this.parakeetManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop parakeet-server on provider switch", {
              error: err.message,
            });
          });
        }
      } else if (prefs.useLocalWhisper) {
        // Local mode enabled but no model selected - clear pre-warming vars
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
      } else {
        // Cloud mode - stop local servers to free RAM
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
        this.whisperManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop whisper-server on cloud switch", {
            error: err.message,
          });
        });
        this.parakeetManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop parakeet-server on cloud switch", {
            error: err.message,
          });
        });
      }

      this._syncStartupEnv(setVars, clearVars);
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        systemAudio:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        screenRecording:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
        loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
        loginItems: "ms-settings:startupapps",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          systemAudio: i18nMain.t("systemSettings.systemAudio"),
          screenRecording: i18nMain.t("systemSettings.screenRecording"),
          loginItems: i18nMain.t("systemSettings.loginItems"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("get-system-default-microphone", (_event, options = {}) =>
      resolveSystemDefaultMicrophone({ refresh: options?.refresh === true })
    );
    ipcMain.handle("open-system-audio-settings", () => openSystemSettings("systemAudio"));
    ipcMain.handle("open-login-items-settings", () => openSystemSettings("loginItems"));

    ipcMain.handle("open-calendar-privacy-settings", () => openSystemSettings("calendars"));

    ipcMain.handle("request-microphone-access", async () => {
      if (process.platform !== "darwin") {
        return { granted: true, status: "granted" };
      }
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    });

    ipcMain.handle("check-microphone-access", () => {
      if (process.platform !== "darwin") {
        return { granted: true, status: "granted" };
      }
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return { granted: status === "granted", status };
    });

    const buildSystemAudioAccess = (partial = {}) => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      supportsPersistentGrant: false,
      supportsPersistentPortalGrant: false,
      supportsNativeCapture: false,
      supportsOnboardingGrant: false,
      requiresRuntimeSharePrompt: false,
      strategy: "unsupported",
      restoreTokenAvailable: false,
      portalVersion: null,
      ...partial,
    });

    const getLinuxSystemAudioAccess = async () => {
      const capability = await this.linuxPortalAudioManager?.getCapability().catch((error) => ({
        available: false,
        supportsPersistentGrant: false,
        supportsPersistentPortalGrant: false,
        supportsSystemAudio: false,
        supportsNativeCapture: false,
        portalVersion: null,
        error: error.message,
      }));
      const available = !!capability?.available;
      const supportsSystemAudio = !!capability?.supportsSystemAudio;
      const supportsNativeCapture = !!capability?.supportsNativeCapture;
      const granted = available && supportsSystemAudio && supportsNativeCapture;
      const helperError =
        typeof capability?.error === "string" &&
        !capability.error.includes("helper binary not found")
          ? capability.error
          : undefined;

      return buildSystemAudioAccess({
        granted,
        status: granted ? "granted" : "unknown",
        mode: granted ? "loopback" : "unsupported",
        supportsNativeCapture,
        strategy: granted ? "pipewire-loopback" : "unsupported",
        portalVersion: capability?.portalVersion ?? null,
        error: helperError,
      });
    };

    // System audio is always capturable on Windows: via the native WASAPI
    // process-loopback helper when available (hears every output device),
    // otherwise via Chromium's default-device loopback in the renderer.
    const getWindowsSystemAudioAccess = async ({ refreshCapability = false } = {}) => {
      const capability = await this.windowsLoopbackAudioManager
        ?.getCapability({ force: refreshCapability })
        .catch(() => ({
          available: false,
        }));
      const helperAvailable = !!capability?.available;

      return buildSystemAudioAccess({
        granted: true,
        status: "granted",
        mode: "loopback",
        supportsNativeCapture: helperAvailable,
        strategy: helperAvailable ? "wasapi-loopback" : "loopback",
      });
    };

    const getSystemAudioAccess = async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      const result = this.audioTapManager.checkAccess();
      return buildSystemAudioAccess({
        granted: result.granted,
        status: result.status,
        mode: "native",
        strategy: "native",
      });
    };

    ipcMain.handle("check-system-audio-access", () => getSystemAudioAccess());

    ipcMain.handle("request-system-audio-access", async () => {
      if (process.platform === "win32") {
        return getWindowsSystemAudioAccess();
      }

      if (process.platform === "linux") {
        return getLinuxSystemAudioAccess();
      }

      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      try {
        const result = await this.audioTapManager.requestAccess();
        if (result.granted) {
          return buildSystemAudioAccess({
            granted: true,
            status: "granted",
            mode: "native",
            strategy: "native",
          });
        }
      } catch {
        // Falls through to opening System Settings
      }

      await openSystemSettings("systemAudio");
      const status = this.audioTapManager.getPermissionStatus();
      return buildSystemAudioAccess({
        granted: false,
        status,
        mode: "native",
        strategy: "native",
      });
    });

    // Honors system proxy via Electron's net stack.
    const proxyFetch = (url, init = {}) => net.fetch(url, { ...init, useSessionCookies: false });
    const toFailure = (error) => ({
      success: false,
      error: error?.message || String(error),
      ...(error?.code ? { code: error.code } : {}),
    });

    let meetingTranscriptionStartInProgress = false;
    let meetingTranscriptionPrepareInProgress = false;
    let meetingTranscriptionPreparePromise = null;

    const DUPLICATE_TRANSCRIPT_WINDOW_MS = 6000;
    const DUPLICATE_TRANSCRIPT_MERGE_LIMIT = 3;
    const STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS = 3000;
    const LOCAL_MEETING_CHUNK_INTERVAL_MS = 5000;
    // Must outlast one local transcription cycle so a straddling remote
    // utterance's next-cycle system transcript can confirm buffered echo.
    const LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS = LOCAL_MEETING_CHUNK_INTERVAL_MS + 1000;
    const RACING_MIC_RETRACT_WINDOW_MS = 4000;

    const buildNearbyTranscriptCandidates = (
      targetSource,
      timestamp,
      { extraSegment = null } = {}
    ) => {
      const relevant = meetingDiarizationSegments.filter(
        (candidate) =>
          candidate.source === targetSource && candidate.timestamp != null && candidate.text
      );

      return buildMergedCandidates({
        segments: relevant,
        timestamp,
        windowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        mergeLimit: DUPLICATE_TRANSCRIPT_MERGE_LIMIT,
        extraSegment,
      });
    };

    const hasNearbyTranscriptMatch = (targetSource, text, timestamp, options = {}) => {
      if (!text) return false;

      const matcher = options.relaxed ? transcriptsLooselyOverlap : transcriptsOverlap;
      const candidates = buildNearbyTranscriptCandidates(targetSource, timestamp, options);
      for (const candidateText of candidates) {
        if (matcher(text, candidateText)) {
          return true;
        }
      }

      return false;
    };

    const shouldSkipDuplicateMicSegment = (text, timestamp, suppression = null) =>
      isDuplicateMicSegment({ text, timestamp, suppression, hasNearbyTranscriptMatch });

    const isWithinMeetingStartupWarmup = () =>
      meetingStartedAt != null && Date.now() - meetingStartedAt < MEETING_STARTUP_WARMUP_MS;

    const hasRiskyMicDuplicateProfile = (suppression = null) =>
      isRiskyMicDuplicateProfile({
        suppression,
        inStartupWarmup: isWithinMeetingStartupWarmup(),
      });

    const removeRacingMicEntriesFor = (systemText, systemTimestamp) => {
      const indices = selectRacingMicEntryIndices({
        segments: meetingDiarizationSegments,
        systemText,
        systemTimestamp,
        hasNearbyTranscriptMatch,
        duplicateWindowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        retractWindowMs: RACING_MIC_RETRACT_WINDOW_MS,
      });
      const removed = [];
      // Indices are descending, so splicing in order never shifts a later index.
      for (const index of indices) {
        removed.push(meetingDiarizationSegments[index]);
        meetingDiarizationSegments.splice(index, 1);
      }
      return removed;
    };

    const appendMeetingLocalTranscript = (text) => {
      if (!text) return;
      meetingLocalTranscript += `${meetingLocalTranscript ? " " : ""}${text}`;
    };

    // Held-back mic segments are appended at release time, so insertion order
    // is not spoken order.
    const buildOrderedTranscriptText = (segments) =>
      segments
        .slice()
        .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
        .map((segment) => segment.text)
        .join(" ")
        .trim();

    const storeMeetingDiarizationSegment = (text, source, timestamp, micSuppression = null) => {
      meetingDiarizationSegments.push({
        text,
        source,
        timestamp,
        committedAt: Date.now(),
        suppressionReason: source === "mic" ? micSuppression?.reason || null : null,
        hasBleedEvidence: source === "mic" ? !!micSuppression?.hasBleedEvidence : false,
        likelyRenderBleed: source === "mic" ? !!micSuppression?.likelyRenderBleed : false,
      });
    };

    const sendMeetingFinalSegment = ({
      text,
      source,
      timestamp,
      micSuppression = null,
      send = null,
      includeInLocalTranscript = false,
    }) => {
      if (includeInLocalTranscript) {
        appendMeetingLocalTranscript(text);
      }

      storeMeetingDiarizationSegment(text, source, timestamp, micSuppression);

      if (send) {
        send("meeting-transcription-segment", {
          text,
          source,
          type: "final",
          timestamp,
        });
      }
    };

    function flushPendingMicFinals(force = false) {
      if (meetingPendingMicFinals.length === 0) {
        if (meetingPendingMicFinalTimer) {
          clearTimeout(meetingPendingMicFinalTimer);
          meetingPendingMicFinalTimer = null;
        }
        return;
      }

      const { deferred, duplicates, releases } = partitionPendingMicFinals({
        pending: meetingPendingMicFinals,
        now: Date.now(),
        force,
        isDuplicate: (entry) =>
          shouldSkipDuplicateMicSegment(entry.text, entry.timestamp, entry.micSuppression),
      });

      meetingPendingMicFinals = deferred;
      schedulePendingMicFinalFlush();

      for (const pending of duplicates) {
        debugLogger.debug(
          "Dropping buffered mic segment after system context confirmed duplicate",
          {
            text: pending.text.slice(0, 80),
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          }
        );
      }

      for (const pending of releases) {
        debugLogger.debug(
          pending.micSuppression?.hasBleedEvidence
            ? "Releasing bleed-flagged mic segment after holdback (no transcript match)"
            : "Releasing buffered mic segment after duplicate holdback",
          {
            text: pending.text.slice(0, 80),
            holdbackMs: pending.holdbackMs,
            reason: pending.micSuppression?.reason,
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          }
        );
        pending.emit();
      }
    }

    const schedulePendingMicFinalFlush = () => {
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }

      if (meetingPendingMicFinals.length === 0) {
        return;
      }

      const nextDelay = Math.max(0, meetingPendingMicFinals[0].releaseAt - Date.now());
      meetingPendingMicFinalTimer = setTimeout(() => {
        meetingPendingMicFinalTimer = null;
        flushPendingMicFinals();
      }, nextDelay);
    };

    const resetPendingMicFinals = () => {
      meetingPendingMicFinals = [];
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }
    };

    const removePendingMicFinalsFor = (systemText, systemTimestamp) => {
      const { kept, removed } = partitionOverlappingPendingMicFinals({
        pending: meetingPendingMicFinals,
        systemText,
        systemTimestamp,
        hasNearbyTranscriptMatch,
      });
      meetingPendingMicFinals = kept;
      schedulePendingMicFinalFlush();
      return removed;
    };

    const queuePendingMicFinal = ({ text, timestamp, micSuppression, holdbackMs, emit }) => {
      meetingPendingMicFinals.push({
        text,
        timestamp,
        micSuppression,
        holdbackMs,
        releaseAt: Date.now() + holdbackMs,
        emit,
      });
      meetingPendingMicFinals.sort((left, right) => left.releaseAt - right.releaseAt);
      schedulePendingMicFinalFlush();
    };

    const captureMeetingDiarizationState = async () => {
      const systemPcmPath = meetingDiarizationPath;
      const systemStartedAt = meetingDiarizationStartedAt;
      const micPcmPath = meetingMicDiarizationPath;
      const micStartedAt = meetingMicDiarizationStartedAt;
      const systemAudioHeard = meetingSystemAudioHeard;
      const diarizationSegments = meetingDiarizationSegments;
      if (meetingDiarizationStream) {
        await new Promise((resolve) => meetingDiarizationStream.end(resolve));
        meetingDiarizationStream = null;
      }
      if (meetingMicDiarizationStream) {
        await new Promise((resolve) => meetingMicDiarizationStream.end(resolve));
        meetingMicDiarizationStream = null;
      }
      meetingDiarizationPath = null;
      meetingDiarizationStartedAt = null;
      meetingMicDiarizationPath = null;
      meetingMicDiarizationStartedAt = null;
      meetingSystemAudioHeard = false;
      meetingSystemAudioDegraded = false;
      meetingDiarizationSegments = [];
      const { pcmPath, startedAt, diarizedSource, cleanupPcmPaths } = resolveDiarizationInput({
        systemPcmPath,
        micPcmPath,
        systemAudioHeard,
        systemStartedAt,
        micStartedAt,
      });
      for (const stalePath of cleanupPcmPaths) {
        fs.unlink(stalePath, () => {});
      }
      return {
        diarizationPcmPath: pcmPath,
        diarizationSegments,
        diarizationStartedAt: startedAt,
        diarizedSource,
      };
    };

    const attachMeetingStreamingHandlers = (streaming, win, source) => {
      const send = (channel, data) => {
        if (!win || win.isDestroyed()) {
          debugLogger.error("Meeting segment send failed: window unavailable", {
            channel,
            source,
            winExists: !!win,
          });
          return;
        }
        win.webContents.send(channel, data);
      };

      streaming.onPartialTranscript = (text) => {
        if (source === "mic" && meetingEchoLeakDetector.isMicProbablyRenderBleed()) {
          send("meeting-transcription-segment", { text: "", source, type: "partial" });
          return;
        }

        send("meeting-transcription-segment", { text, source, type: "partial" });
      };
      streaming.onFinalTranscript = (text, timestamp) => {
        const segments = streaming.completedSegments;
        const latestSegment = segments.length > 0 ? segments[segments.length - 1] : text;
        let micSuppression = null;
        if (source === "mic") {
          micSuppression = shouldSuppressMicTranscriptSegment(timestamp, Date.now());
          if (micSuppression.suppress) {
            debugLogger.debug("Suppressing contaminated mic segment", {
              reason: micSuppression.reason,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
              text: latestSegment.slice(0, 80),
            });
            send("meeting-transcription-segment", { text: "", source, type: "partial" });
            return;
          }

          if (shouldSkipDuplicateMicSegment(latestSegment, timestamp, micSuppression)) {
            debugLogger.debug("Skipping duplicate mic segment that matches recent system audio", {
              text: latestSegment.slice(0, 80),
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            send("meeting-transcription-segment", { text: "", source, type: "partial" });
            return;
          }
        }

        if (source === "system") {
          const pending = removePendingMicFinalsFor(latestSegment, timestamp);
          if (pending.length > 0) {
            debugLogger.debug("Dropping buffered mic segments after system transcript arrived", {
              count: pending.length,
              text: latestSegment.slice(0, 80),
            });
          }

          const retracted = removeRacingMicEntriesFor(latestSegment, timestamp);
          for (const stale of retracted) {
            send("meeting-transcription-segment", {
              text: stale.text,
              source: "mic",
              type: "retract",
              timestamp: stale.timestamp,
            });
          }
        }

        debugLogger.debug("Meeting segment sending to renderer", {
          source,
          text: latestSegment.slice(0, 80),
          segmentCount: segments.length,
          micCorrelation: micSuppression?.averageCorrelation?.toFixed(3),
          micSuppressionReason: micSuppression?.reason,
          micHasBleedEvidence: micSuppression?.hasBleedEvidence,
          micLikelyRenderBleed: micSuppression?.likelyRenderBleed,
          systemSpeaking: micSuppression?.systemSpeaking,
        });
        if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
          debugLogger.debug("Buffering risky mic segment before renderer commit", {
            text: latestSegment.slice(0, 80),
            holdbackMs: STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS,
            reason: micSuppression?.reason,
            hasBleedEvidence: micSuppression?.hasBleedEvidence,
          });
          send("meeting-transcription-segment", { text: "", source, type: "partial" });
          queuePendingMicFinal({
            text: latestSegment,
            timestamp,
            micSuppression,
            holdbackMs: STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS,
            emit: () =>
              sendMeetingFinalSegment({
                text: latestSegment,
                source,
                timestamp,
                micSuppression,
                send,
              }),
          });
          return;
        }

        sendMeetingFinalSegment({
          text: latestSegment,
          source,
          timestamp,
          micSuppression,
          send,
        });
      };
      streaming.onError = (error) => {
        send("meeting-transcription-error", error.message);
      };
      const recoverConnection = async (error, restoreOldOnFailure) => {
        let recovered = false;
        try {
          recovered = await reconnectMeetingStreams({ restoreOldOnFailure });
        } catch (reconnectError) {
          debugLogger.error("Meeting stream recovery failed unexpectedly", {
            error: reconnectError.message,
          });
        }
        if (!recovered && !meetingFatalErrorSent) {
          meetingFatalErrorSent = true;
          send(
            "meeting-transcription-fatal-error",
            error?.message || "Meeting transcription connection could not be restored."
          );
        }
      };
      streaming.onConnectionLost = (error) => {
        void recoverConnection(error, false);
      };
      streaming.onSessionExpired = ({ proactive = false } = {}) => {
        void recoverConnection(
          new Error("Meeting transcription session could not be renewed."),
          proactive
        );
      };
    };

    const resetMeetingReconnectAudio = () => {
      meetingReconnectAudioBuffers = { mic: [], system: [] };
      meetingReconnectAudioBytes = { mic: 0, system: 0 };
      meetingReconnectReplaySources = new Set();
    };

    const sendMeetingStreamingAudio = (streaming, buffer, capturedAt = null) => {
      const firstSampleAt = streaming.audioBytesSent === 0 ? capturedAt : null;
      const sent = streaming.sendAudio(buffer);
      if (
        sent &&
        streaming.isConnected &&
        firstSampleAt !== null &&
        streaming.sessionStartedAt != null
      ) {
        // Deepgram/Corti time segments from the first PCM sample, which can
        // precede a replacement socket's creation when replaying recovery audio.
        streaming.sessionStartedAt = firstSampleAt;
      }
      return sent;
    };

    const queueMeetingReconnectAudio = (source, buffer, capturedAt = null) => {
      if (!meetingReconnectReplaySources.has(source)) return;
      const copy = Buffer.from(buffer);
      const queue = meetingReconnectAudioBuffers[source];
      queue.push({ buffer: copy, capturedAt });
      meetingReconnectAudioBytes[source] += copy.length;
      while (
        meetingReconnectAudioBytes[source] > MEETING_RECONNECT_BUFFER_MAX_BYTES &&
        queue.length > 1
      ) {
        meetingReconnectAudioBytes[source] -= queue.shift().buffer.length;
      }
    };

    const replayMeetingReconnectAudio = (source, streaming) => {
      if (!meetingReconnectReplaySources.has(source)) return true;
      const queue = meetingReconnectAudioBuffers[source];
      const replayed = queue.every(({ buffer, capturedAt }) =>
        sendMeetingStreamingAudio(streaming, buffer, capturedAt)
      );
      debugLogger.info("Replayed meeting audio after reconnect", {
        source,
        chunks: queue.length,
        bytes: meetingReconnectAudioBytes[source],
      });
      return replayed;
    };

    // Labels the socket for field logs and, for system, swaps in the more
    // sensitive threshold (see MEETING_SYSTEM_VAD_THRESHOLD).
    const withMeetingSourceConnectOpts = (connectOpts, source) => ({
      ...connectOpts,
      streamLabel: source,
      ...(source === "system" ? { vadThreshold: MEETING_SYSTEM_VAD_THRESHOLD } : {}),
    });

    const reconnectMeetingStreams = ({ restoreOldOnFailure = false } = {}) => {
      if (meetingReconnectPromise) return meetingReconnectPromise;

      const pending = (async () => {
        if (meetingLocalMode) return false;

        const options = meetingConnectionOptions;
        const win = meetingConnectionWin;
        if (!options || !win || win.isDestroyed()) {
          debugLogger.error("Cannot reconnect meeting streams: missing connection context");
          return false;
        }

        if (meetingReconnectCount >= MAX_MEETING_RECONNECTS) {
          debugLogger.error("Meeting reconnect limit reached", { count: meetingReconnectCount });
          return false;
        }

        meetingReconnectCount++;

        const oldMic = this._meetingMicStreaming;
        const oldSystem = this._meetingSystemStreaming;
        meetingReconnectReplaySources = new Set([
          ...(!oldMic?.isConnected ? ["mic"] : []),
          ...(oldSystem && !oldSystem.isConnected ? ["system"] : []),
        ]);
        let newMic = null;
        let newSystem = null;

        try {
          const StreamingClass = getMeetingStreamingClient(options.provider);
          newMic = new StreamingClass();
          attachMeetingStreamingHandlers(newMic, win, "mic");
          if (oldSystem) {
            newSystem = new StreamingClass();
            attachMeetingStreamingHandlers(newSystem, win, "system");
          }

          debugLogger.info("Reconnecting meeting streams", {
            attempt: meetingReconnectCount,
            maxAttempts: MAX_MEETING_RECONNECTS,
          });

          const tokenEvent = { sender: win.webContents };
          const connectOpts = {
            model: options.model,
            language: options.language,
            mode: options.mode,
            preconfigured: options.mode !== "byok",
            environment: options.environment,
            tenant: options.tenant,
            keyterms: options.keyterms,
            sampleRate: MEETING_STREAM_SAMPLE_RATE,
          };

          let pairs;
          if (newSystem) {
            const secrets = await fetchRealtimeToken(tokenEvent, options, { streams: 2 });
            pairs = [
              { streaming: newMic, secret: secrets[0], source: "mic" },
              { streaming: newSystem, secret: secrets[1], source: "system" },
            ];
          } else {
            pairs = [
              {
                streaming: newMic,
                secret: await fetchRealtimeToken(tokenEvent, options),
                source: "mic",
              },
            ];
          }

          await Promise.all(
            pairs.map(({ streaming, secret, source }) =>
              streaming.connect({
                apiKey: secret,
                token: secret,
                ...withMeetingSourceConnectOpts(connectOpts, source),
              })
            )
          );

          if (pairs.some(({ streaming }) => !streaming.isConnected)) {
            throw new Error("Meeting transcription connection closed during reconnect.");
          }

          if (meetingConnectionOptions !== options) {
            for (const { streaming } of pairs) streaming.disconnect().catch(() => {});
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            resetMeetingReconnectAudio();
            return true;
          }

          const replayedMic = replayMeetingReconnectAudio("mic", newMic);
          const replayedSystem = !newSystem || replayMeetingReconnectAudio("system", newSystem);
          if (!replayedMic || !replayedSystem) {
            throw new Error("Meeting audio could not be restored after reconnect.");
          }
          this._meetingMicStreaming = newMic;
          this._meetingSystemStreaming = newSystem;
          resetMeetingReconnectAudio();
          oldMic?.disconnect().catch(() => {});
          oldSystem?.disconnect().catch(() => {});
          meetingConnectionKey = getMeetingConnectionKey(options);

          debugLogger.info("Meeting streams reconnected", { attempt: meetingReconnectCount });
          meetingReconnectCount = 0;
          return true;
        } catch (error) {
          debugLogger.error("Meeting stream reconnect failed", {
            error: error.message,
            attempt: meetingReconnectCount,
          });
          newMic?.disconnect().catch(() => {});
          newSystem?.disconnect().catch(() => {});
          if (meetingConnectionOptions !== options) {
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            resetMeetingReconnectAudio();
            return true;
          }

          const canRestoreOld =
            restoreOldOnFailure && !!oldMic?.isConnected && (!oldSystem || oldSystem.isConnected);
          if (canRestoreOld) {
            this._meetingMicStreaming = oldMic;
            this._meetingSystemStreaming = oldSystem;
          } else {
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            this._meetingMicStreaming = null;
            this._meetingSystemStreaming = null;
            meetingConnectionKey = null;
          }
          resetMeetingReconnectAudio();
          if (!win.isDestroyed()) {
            win.webContents.send("meeting-transcription-error", error.message);
          }
          return canRestoreOld;
        }
      })();

      meetingReconnectPromise = pending;
      return pending.finally(() => {
        if (meetingReconnectPromise === pending) meetingReconnectPromise = null;
      });
    };

    const fetchRealtimeToken = async (event, options, { streams } = {}) => {
      return fetchRealtimeTokenForProvider(
        options.provider,
        {
          environmentManager: this.environmentManager,
          proxyFetch,
          mintCortiToken: (tokenOptions) => this._mintStoredCortiToken(tokenOptions),
        },
        options,
        { streams }
      );
    };

    const getMeetingSystemAudioCapabilityMode = () => {
      if (this.audioTapManager?.isSupported()) return "native";
      if (process.platform === "win32") return "loopback";
      if (process.platform === "linux") return "loopback";
      return "unsupported";
    };

    const getMeetingSystemAudioMode = () => getMeetingSystemAudioCapabilityMode();

    const getMeetingSystemAudioPlan = async ({ refreshWindowsCapability = false } = {}) => {
      const mode = getMeetingSystemAudioMode();
      if (mode === "unsupported") {
        return { mode, strategy: "unsupported" };
      }

      if (mode === "native") {
        return { mode, strategy: "native" };
      }

      if (process.platform === "linux") {
        const linuxAccess = await getLinuxSystemAudioAccess();
        return {
          mode: linuxAccess.mode,
          strategy: linuxAccess.strategy || "unsupported",
        };
      }

      if (process.platform === "win32") {
        const windowsAccess = await getWindowsSystemAudioAccess({
          refreshCapability: refreshWindowsCapability,
        });
        return { mode: windowsAccess.mode, strategy: windowsAccess.strategy };
      }

      // Unreachable today (loopback implies win32 or linux, both handled
      // above), but callers destructure the result, so never return undefined.
      return { mode, strategy: "unsupported" };
    };

    const hasNativeMeetingSystemAudio = () => getMeetingSystemAudioMode() === "native";

    const isMeetingStreamingConnected = (systemAudioMode = getMeetingSystemAudioCapabilityMode()) =>
      !!this._meetingMicStreaming?.isConnected &&
      (systemAudioMode === "unsupported" || !!this._meetingSystemStreaming?.isConnected);

    const connectRealtimeStreaming = async (event, options) => {
      const connectionKey = getMeetingConnectionKey(options);
      const StreamingClass = getMeetingStreamingClient(options.provider);
      if (this._meetingMicStreaming?.isConnected) {
        await this._meetingMicStreaming.disconnect();
      }
      if (this._meetingSystemStreaming?.isConnected) {
        await this._meetingSystemStreaming.disconnect();
      }
      this._meetingMicStreaming = null;
      this._meetingSystemStreaming = null;
      const win = BrowserWindow.fromWebContents(event.sender);

      const connectOpts = {
        model: options.model,
        language: options.language,
        mode: options.mode,
        preconfigured: options.mode !== "byok",
        environment: options.environment,
        tenant: options.tenant,
        keyterms: options.keyterms,
        sampleRate: MEETING_STREAM_SAMPLE_RATE,
      };
      const { mode: systemAudioMode } = await getMeetingSystemAudioPlan();
      let pairs;
      if (systemAudioMode !== "unsupported") {
        const secrets = await fetchRealtimeToken(event, options, { streams: 2 });
        pairs = [
          { ref: "_meetingMicStreaming", secret: secrets[0], source: "mic" },
          { ref: "_meetingSystemStreaming", secret: secrets[1], source: "system" },
        ];
      } else {
        pairs = [
          {
            ref: "_meetingMicStreaming",
            secret: await fetchRealtimeToken(event, options),
            source: "mic",
          },
        ];
      }

      for (const { ref, source } of pairs) {
        this[ref] = new StreamingClass();
        attachMeetingStreamingHandlers(this[ref], win, source);
      }

      try {
        await Promise.all(
          pairs.map(({ ref, secret, source }) =>
            this[ref].connect({
              apiKey: secret,
              token: secret,
              ...withMeetingSourceConnectOpts(connectOpts, source),
            })
          )
        );
        if (pairs.some(({ ref }) => !this[ref]?.isConnected)) {
          throw new Error("Meeting transcription connection closed during startup.");
        }
        meetingConnectionKey = connectionKey;
      } catch (error) {
        await Promise.all(
          pairs.map(({ ref }) => this[ref]?.disconnect().catch(() => ({ text: "" })))
        );
        this._meetingMicStreaming = null;
        this._meetingSystemStreaming = null;
        meetingConnectionKey = null;
        throw error;
      }

      return win;
    };

    const MEETING_MIC_REFERENCE_ALIGNMENT_MS = 320;
    const MEETING_STARTUP_WARMUP_MS = 1500;
    const MEETING_MIC_BLEED_LOOKBACK_MS = 500;
    const MEETING_MIC_STATS_LOG_LIMIT = 200;
    const MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS = 45000;
    const MEETING_SYSTEM_AUDIO_TICK_MS = 2000;
    let meetingMicStatsLogCount = 0;
    let meetingSystemAudioSilenceTimer = null;
    let meetingSystemAudioTicker = null;
    let meetingSystemAudioWatchdogWin = null;

    const meetingSystemAudioWatchdog = createMeetingSystemAudioWatchdog({
      onResumed: () => {
        const win = meetingSystemAudioWatchdogWin;
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-resumed");
        }
      },
      onInterrupted: (payload) => {
        // debugLogger.error flattens its arguments into one string, dropping
        // both the meta and the scope, so the give-up event would vanish from a
        // log filtered on "meeting", the one filter used to triage this bug.
        if (payload.recovering) {
          debugLogger.warn("Meeting system audio interrupted, restarting", payload, "meeting");
        } else {
          debugLogger.warn("Meeting system audio capture gave up", payload, "meeting");
        }
        const win = meetingSystemAudioWatchdogWin;
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-interrupted", payload);
        }
      },
    });
    let meetingStartedAt = null;
    let meetingSendCounts = { mic: 0, system: 0 };
    const meetingEchoLeakDetector = new MeetingEchoLeakDetector();
    let meetingReconnectPromise = null;
    let meetingFatalErrorSent = false;
    let meetingReconnectCount = 0;
    const MAX_MEETING_RECONNECTS = 5;
    let meetingConnectionOptions = null;
    let meetingConnectionWin = null;
    let meetingConnectionKey = null;
    let meetingReconnectAudioBuffers = { mic: [], system: [] };
    let meetingReconnectAudioBytes = { mic: 0, system: 0 };
    let meetingReconnectReplaySources = new Set();

    const fs = require("fs");
    let meetingDiarizationStream = null;
    let meetingDiarizationPath = null;
    let meetingDiarizationStartedAt = null;
    // Parallel raw mic capture so an in-person session (no audible system
    // audio) can be diarized; dropped as soon as the session proves to be a call.
    let meetingMicDiarizationStream = null;
    let meetingMicDiarizationPath = null;
    let meetingMicDiarizationStartedAt = null;
    let meetingSystemAudioHeard = false;
    let meetingSystemAudioDegraded = false;
    let meetingDiarizationSegments = [];
    let meetingLiveSpeakerActive = false;
    let meetingLiveSpeakerState = null;
    let meetingLiveSpeakerStartedAt = null;
    let meetingReclusterTimer = null;

    let meetingLocalMode = false;
    let meetingLocalBuffers = { mic: [], system: [] };
    let meetingLocalTimer = null;
    let meetingLocalWin = null;
    let meetingLocalTranscript = "";
    let meetingLocalProvider = null;
    let meetingLocalModel = null;
    let meetingLocalLanguage = null;
    let meetingLocalTranscribing = false;
    let meetingPendingMicChunks = [];
    let meetingPendingMicFinals = [];
    let meetingPendingMicFinalTimer = null;
    let meetingAecEnabled = false;
    let meetingOneOnOneAttendee = null;
    let meetingOneOnOneProfileBound = false;
    let meetingNoteId = null;

    const getLiveSpeakerProfiles = () => {
      const attendees = this._getNoteNonSelfParticipants(meetingNoteId);
      const attendeeEmails = new Set();
      for (const p of attendees) {
        const email = (p.email || "").toLowerCase().trim();
        if (email) attendeeEmails.add(email);
      }
      if (attendeeEmails.size === 0) return [];
      return this.databaseManager
        .getSpeakerProfiles(true)
        .filter((p) => p.email && attendeeEmails.has(p.email.toLowerCase()));
    };
    const shouldSuppressMicTranscriptSegment = (startedAt, endedAt = Date.now()) =>
      meetingEchoLeakDetector.shouldSuppressMicSegment(startedAt, endedAt);

    const resolveOneOnOneAttendeeForNote = (noteId) => {
      if (!noteId) return null;
      try {
        const note = this.databaseManager.getNote(noteId);
        return this._resolveOneOnOneOtherParticipant(note?.participants);
      } catch (_) {
        return null;
      }
    };

    const resolveDiarizationEnabled = () =>
      (this.activeMeetingSpeakerConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    const resolveSessionMaxSpeakers = () => {
      const count = this.activeMeetingSpeakerConfig?.expectedCount;
      const total = count ? Math.min(count, MAX_SPEAKER_COUNT) : DEFAULT_EXPECTED_SPEAKER_COUNT;
      return Math.max(1, total - 1);
    };

    const bindOneOnOneAttendeeToSpeaker = (speakerId) => {
      if (!meetingOneOnOneAttendee || meetingOneOnOneProfileBound || !speakerId) return;
      if (!resolveDiarizationEnabled()) return;
      const embedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
      if (!embedding) return;
      try {
        const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        const profile = this.databaseManager.upsertSpeakerProfile(
          meetingOneOnOneAttendee.displayName,
          meetingOneOnOneAttendee.email,
          buffer
        );
        liveSpeakerIdentifier.mapSpeaker(
          speakerId,
          profile.id,
          meetingOneOnOneAttendee.displayName,
          null
        );
        meetingOneOnOneProfileBound = true;
      } catch (error) {
        debugLogger.warn(
          "1-on-1 attendee profile binding failed",
          { error: error.message },
          "speaker"
        );
      }
    };

    const dispatchMeetingAudioBuffer = (buffer, source, synthetic = false, capturedAt = null) => {
      if (meetingLocalMode) {
        // Local STT timestamps each batch with wall time, not a sample cursor.
        // Large synthetic gaps would dilute speech and inflate the next batch.
        if (synthetic) return;
        meetingLocalBuffers[source].push(buffer);
        return;
      }

      const streaming = source === "mic" ? this._meetingMicStreaming : this._meetingSystemStreaming;
      if (!streaming) {
        if (meetingSendCounts[source] === 0) {
          debugLogger.error("Meeting audio send: no streaming instance", { source });
        }
        return;
      }

      let outbound = buffer;
      if (source === "mic" && buffer.length >= 2) {
        const { rms, peak, sampleCount } = computeChunkStats(buffer);
        // Evaluated eagerly (as before) because the stats log reports it.
        const systemSpeaking = meetingEchoLeakDetector.isSystemSpeaking(
          Date.now() - MEETING_MIC_BLEED_LOOKBACK_MS
        );
        const verdict = resolveMicChunkAction({
          mode: "streaming",
          source,
          rms,
          peak,
          sampleCount,
          isSystemSpeaking: () => systemSpeaking,
        });
        if (verdict.action === "zero") {
          outbound = Buffer.alloc(buffer.length);
        }
        if (
          meetingMicStatsLogCount < MEETING_MIC_STATS_LOG_LIMIT &&
          (systemSpeaking || rms > 0.02)
        ) {
          meetingMicStatsLogCount += 1;
          debugLogger.debug("Meeting mic audio stats", {
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
            systemSpeaking,
            zeroed: outbound !== buffer,
          });
        }
      } else if (source === "system" && buffer.length >= 2 && !synthetic) {
        // System chunks stream verbatim (no gate), so a periodic level readout
        // is the only way field logs can tell real audio from capture silence.
        const chunkCount = meetingSendCounts.system + 1;
        if (chunkCount === 1 || chunkCount % 200 === 0) {
          const { rms, peak } = computeChunkStats(buffer);
          debugLogger.debug("Meeting system audio stats", {
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
            chunkCount,
          });
        }
      }

      queueMeetingReconnectAudio(source, outbound, capturedAt);
      const sent = sendMeetingStreamingAudio(streaming, outbound, capturedAt);
      if (synthetic) return;
      meetingSendCounts[source]++;
      if (meetingSendCounts[source] <= 5 || meetingSendCounts[source] % 100 === 0) {
        debugLogger.debug("Meeting audio send", {
          source,
          bytes: buffer.length,
          sent,
          wsReady: streaming.ws?.readyState,
          totalSent: streaming.audioBytesSent,
          count: meetingSendCounts[source],
        });
      }
    };

    const stopMeetingAec = async () => {
      meetingAecEnabled = false;
      if (this.meetingAecManager) {
        await this.meetingAecManager.stop().catch(() => {});
      }
    };

    const startMeetingAec = async (systemAudioMode) => {
      meetingAecEnabled = false;
      if (systemAudioMode === "unsupported" || !this.meetingAecManager?.isAvailable()) {
        return false;
      }

      const started = await this.meetingAecManager
        .start({
          onMicChunk: (chunk) => {
            dispatchMeetingAudioBuffer(chunk, "mic");
          },
          onError: (error) => {
            debugLogger.warn("Meeting AEC helper disabled", { error: error.message }, "meeting");
            meetingAecEnabled = false;
            void this.meetingAecManager.stop().catch(() => {});
          },
          onWarning: (warning) => {
            debugLogger.debug("Meeting AEC helper warning", warning, "meeting");
          },
        })
        .catch((error) => {
          debugLogger.warn("Meeting AEC helper start failed", { error: error.message }, "meeting");
          return false;
        });

      meetingAecEnabled = !!started;
      if (meetingAecEnabled) {
        debugLogger.info("Meeting AEC helper started", { systemAudioMode }, "meeting");
      }
      return meetingAecEnabled;
    };

    const flushPendingMeetingMicChunks = (force = false) => {
      if (!meetingPendingMicChunks.length) {
        return;
      }

      const now = Date.now();
      while (meetingPendingMicChunks.length > 0) {
        const next = meetingPendingMicChunks[0];
        if (!force && now - next.queuedAt < MEETING_MIC_REFERENCE_ALIGNMENT_MS) {
          break;
        }

        meetingPendingMicChunks.shift();
        const analysis = meetingEchoLeakDetector.analyzeMicChunk(next.buffer);
        if (next.analysisOnly) {
          continue;
        }
        if (analysis?.shouldMute && !meetingAecEnabled) {
          if (!meetingLocalMode) {
            dispatchMeetingAudioBuffer(Buffer.alloc(next.buffer.length), "mic");
          }
          continue;
        }

        dispatchMeetingAudioBuffer(next.buffer, "mic");
      }
    };

    const processMeetingMicWithAec = (buffer) => {
      if (!meetingAecEnabled) {
        return false;
      }

      const sent = this.meetingAecManager?.processMicBuffer(buffer);
      if (sent) {
        meetingPendingMicChunks.push({
          buffer,
          queuedAt: Date.now(),
          analysisOnly: true,
        });
        flushPendingMeetingMicChunks();
        return true;
      }

      meetingAecEnabled = false;
      return false;
    };

    const stopLiveSpeakerIdentification = async () => {
      if (!meetingLiveSpeakerActive) {
        return null;
      }

      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }

      meetingLiveSpeakerActive = false;
      meetingLiveSpeakerState = await liveSpeakerIdentifier.stop();
      return meetingLiveSpeakerState;
    };

    const startLiveSpeakerIdentification = async (win, systemAudioMode) => {
      await stopLiveSpeakerIdentification();

      if (
        !supportsLiveSpeakerIdentification(systemAudioMode) ||
        !liveSpeakerIdentifier.isAvailable()
      ) {
        return false;
      }

      const diarizationEnabled = resolveDiarizationEnabled();
      if (!diarizationEnabled) {
        return false;
      }

      meetingLiveSpeakerState = null;
      // Anchored on the first system chunk instead, in sendMeetingAudio.
      meetingLiveSpeakerStartedAt = null;
      const started = await liveSpeakerIdentifier
        .start(
          (identification) => {
            if (!win || win.isDestroyed() || meetingLiveSpeakerStartedAt == null) {
              return;
            }

            bindOneOnOneAttendeeToSpeaker(identification.speakerId);

            const displayName = meetingOneOnOneAttendee
              ? meetingOneOnOneAttendee.displayName
              : identification.displayName;

            const startTime = Math.max(
              meetingLiveSpeakerStartedAt,
              meetingLiveSpeakerStartedAt + identification.startTime * 1000
            );
            const endTime = Math.max(
              startTime,
              meetingLiveSpeakerStartedAt + identification.endTime * 1000
            );
            const enrichedIdentification = {
              ...identification,
              displayName,
              startTime,
              endTime,
            };

            win.webContents.send("meeting-speaker-identified", enrichedIdentification);

            for (const seg of meetingDiarizationSegments) {
              if (
                seg.source === "system" &&
                seg.timestamp != null &&
                seg.timestamp >= startTime &&
                seg.timestamp <= endTime &&
                (!seg.speaker || seg.speakerIsPlaceholder)
              ) {
                applyConfirmedSpeaker(seg, {
                  speaker: identification.speakerId,
                  speakerName: displayName || seg.speakerName,
                  speakerIsPlaceholder: false,
                });
              }
            }
          },
          {
            getSpeakerProfiles: getLiveSpeakerProfiles,
            maxSpeakers: resolveSessionMaxSpeakers(),
            enabled: true,
          }
        )
        .catch((error) => {
          // isAvailable() only stats the model file, so a corrupt model or an
          // onnxruntime binding that won't load still throws here. Speaker labels
          // are an enhancement — never let them take the recording down with them.
          debugLogger.warn(
            "Live speaker identification start failed",
            { error: error.message },
            "speaker"
          );
          return false;
        });

      if (started) {
        meetingLiveSpeakerActive = true;
        meetingReclusterTimer = setInterval(async () => {
          if (!meetingLiveSpeakerActive || !win || win.isDestroyed()) return;

          const merges = await liveSpeakerIdentifier.recluster();
          if (!merges.length) return;

          for (const { keep, remove, displayName } of merges) {
            for (const seg of meetingDiarizationSegments) {
              if (seg.speaker === remove) {
                seg.speaker = keep;
                if (displayName) seg.speakerName = displayName;
              }
            }
          }

          win.webContents.send("meeting-speakers-merged", merges);
        }, 30_000);
      } else {
        meetingLiveSpeakerStartedAt = null;
      }

      return started;
    };

    const transcribeLocalMeetingChunk = async (source) => {
      const chunks = meetingLocalBuffers[source];
      if (!chunks.length) return;

      const pcm24k = Buffer.concat(chunks);
      meetingLocalBuffers[source] = [];

      const pcm16k = downsample24kTo16k(pcm24k);

      const { rms, peak, sampleCount } = computeChunkStats(pcm16k);
      const verdict = resolveMicChunkAction({
        mode: "local",
        source,
        rms,
        peak,
        sampleCount,
        isSystemSpeaking: () =>
          meetingEchoLeakDetector.isSystemSpeaking(Date.now() - LOCAL_MEETING_CHUNK_INTERVAL_MS),
      });
      if (verdict.action === "skip") {
        debugLogger.debug(
          verdict.reason === "silence"
            ? "Skipping silent meeting chunk"
            : "Skipping system-dominant mic chunk",
          {
            source,
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
          }
        );
        return;
      }

      const wav = pcm16ToWav(pcm16k);

      try {
        let result;
        if (isSherpaLocalProvider(meetingLocalProvider)) {
          result = await this.parakeetManager.transcribeLocalParakeet(wav, {
            model: meetingLocalModel,
            language: meetingLocalLanguage,
          });
        } else {
          const vadOptions = this._resolveWhisperVadOptions("meeting");
          result = await this.whisperManager.transcribeLocalWhisper(wav, {
            model: meetingLocalModel,
            language: meetingLocalLanguage,
            // Keep whisper.cpp's default decoder thresholds on this continuous
            // load: the raised #1458 values multiply temperature-fallback
            // re-decodes, and meeting chunks already have RMS-gate, VAD, and
            // holdback/dedup hallucination protection.
            skipDecoderThresholds: true,
            ...vadOptions,
          });
        }

        if (result?.success && result.text?.trim()) {
          const text = result.text.trim();
          const segTimestamp = Date.now();
          let micSuppression = null;
          if (source === "mic") {
            const chunkDurationMs = (pcm24k.length / 2 / 24000) * 1000;
            micSuppression = shouldSuppressMicTranscriptSegment(
              segTimestamp - chunkDurationMs,
              segTimestamp
            );
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
              suppress: micSuppression.suppress,
              reason: micSuppression.reason,
              hasBleedEvidence: micSuppression.hasBleedEvidence,
              likelyRenderBleed: micSuppression.likelyRenderBleed,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            if (micSuppression.suppress) {
              debugLogger.debug("Suppressing contaminated local mic segment", {
                reason: micSuppression.reason,
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
                text: text.slice(0, 80),
              });
              return;
            }

            if (shouldSkipDuplicateMicSegment(text, segTimestamp, micSuppression)) {
              debugLogger.debug("Skipping duplicate local mic segment that matches system audio", {
                text: text.slice(0, 80),
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
              });
              return;
            }
          } else {
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
            });
          }

          if (source === "system") {
            const pending = removePendingMicFinalsFor(text, segTimestamp);
            if (pending.length > 0) {
              debugLogger.debug(
                "Dropping buffered local mic segments after system transcript arrived",
                {
                  count: pending.length,
                  text: text.slice(0, 80),
                }
              );
            }

            const retracted = removeRacingMicEntriesFor(text, segTimestamp);
            for (const stale of retracted) {
              if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
                meetingLocalWin.webContents.send("meeting-transcription-segment", {
                  text: stale.text,
                  source: "mic",
                  type: "retract",
                  timestamp: stale.timestamp,
                });
              }
            }
          }

          const sendLocalSegment = (channel, payload) => {
            if (channel !== "meeting-transcription-segment") {
              return;
            }

            if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
              meetingLocalWin.webContents.send(channel, payload);
            }
          };

          if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
            debugLogger.debug("Buffering risky local mic segment before renderer commit", {
              text: text.slice(0, 80),
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              reason: micSuppression?.reason,
              hasBleedEvidence: micSuppression?.hasBleedEvidence,
            });
            queuePendingMicFinal({
              text,
              timestamp: segTimestamp,
              micSuppression,
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              emit: () =>
                sendMeetingFinalSegment({
                  text,
                  source,
                  timestamp: segTimestamp,
                  micSuppression,
                  send: sendLocalSegment,
                  includeInLocalTranscript: true,
                }),
            });
            return;
          }

          sendMeetingFinalSegment({
            text,
            source,
            timestamp: segTimestamp,
            micSuppression,
            send: sendLocalSegment,
            includeInLocalTranscript: true,
          });
        }
      } catch (error) {
        debugLogger.error("Local meeting transcription chunk failed", {
          source,
          error: error.message,
        });
        if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
          meetingLocalWin.webContents.send("meeting-transcription-error", error.message);
        }
      }
    };

    const transcribeAllLocalBuffers = async () => {
      if (meetingLocalTranscribing) return;
      meetingLocalTranscribing = true;
      try {
        await transcribeLocalMeetingChunk("system");
        await transcribeLocalMeetingChunk("mic");
      } finally {
        meetingLocalTranscribing = false;
      }
    };

    const dropMeetingMicDiarizationCapture = () => {
      if (meetingMicDiarizationStream) {
        meetingMicDiarizationStream.end();
        meetingMicDiarizationStream = null;
      }
      if (meetingMicDiarizationPath) {
        fs.unlink(meetingMicDiarizationPath, () => {});
        meetingMicDiarizationPath = null;
      }
      meetingMicDiarizationStartedAt = null;
    };

    const resetMeetingLocalState = () => {
      if (meetingLocalTimer) {
        clearInterval(meetingLocalTimer);
        meetingLocalTimer = null;
      }
      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }
      void stopLiveSpeakerIdentification();
      meetingLiveSpeakerState = null;
      meetingLiveSpeakerStartedAt = null;
      meetingOneOnOneAttendee = null;
      meetingOneOnOneProfileBound = false;
      meetingNoteId = null;
      this._activeMeetingNoteId = null;
      meetingLocalMode = false;
      meetingLocalBuffers = { mic: [], system: [] };
      if (meetingDiarizationStream) {
        meetingDiarizationStream.end();
        meetingDiarizationStream = null;
      }
      if (meetingDiarizationPath) {
        fs.unlink(meetingDiarizationPath, () => {});
        meetingDiarizationPath = null;
      }
      meetingDiarizationStartedAt = null;
      dropMeetingMicDiarizationCapture();
      meetingSystemAudioHeard = false;
      meetingSystemAudioDegraded = false;
      meetingDiarizationSegments = [];
      meetingLocalWin = null;
      meetingLocalTranscript = "";
      meetingLocalProvider = null;
      meetingLocalModel = null;
      meetingLocalLanguage = null;
      meetingLocalTranscribing = false;
      meetingPendingMicChunks = [];
      resetPendingMicFinals();
      meetingAecEnabled = false;
      meetingStartedAt = null;
      meetingEchoLeakDetector.reset();
    };

    const resetMeetingStreamingState = () => {
      this._meetingMicStreaming = null;
      this._meetingSystemStreaming = null;
      meetingSendCounts = { mic: 0, system: 0 };
      meetingLiveSpeakerStartedAt = null;
      meetingPendingMicChunks = [];
      resetPendingMicFinals();
      meetingAecEnabled = false;
      meetingEchoLeakDetector.reset();
      meetingReconnectPromise = null;
      meetingFatalErrorSent = false;
      meetingReconnectCount = 0;
      meetingConnectionOptions = null;
      meetingConnectionWin = null;
      meetingConnectionKey = null;
      resetMeetingReconnectAudio();
    };

    const disconnectMeetingStreaming = async ({ flushPending = false } = {}) => {
      const results = await Promise.all([
        this._meetingMicStreaming
          ? this._meetingMicStreaming.disconnect().catch(() => ({ text: "" }))
          : Promise.resolve({ text: "" }),
        this._meetingSystemStreaming
          ? this._meetingSystemStreaming.disconnect().catch(() => ({ text: "" }))
          : Promise.resolve({ text: "" }),
      ]);

      if (flushPending) {
        flushPendingMicFinals(true);
      }

      resetMeetingStreamingState();
      return results;
    };

    const clearMeetingSystemAudioSilenceTimer = () => {
      if (meetingSystemAudioSilenceTimer) {
        clearTimeout(meetingSystemAudioSilenceTimer);
        meetingSystemAudioSilenceTimer = null;
      }
    };

    // One-shot: system capture is active but nothing audible has arrived by the
    // deadline, so tell the meeting window the remote side may be missing from
    // the transcript. Audio arriving before the deadline cancels it outright;
    // the toast itself is time-boxed by the renderer, not by later audio.
    const armMeetingSystemAudioSilenceTimer = (win, systemAudioStrategy) => {
      clearMeetingSystemAudioSilenceTimer();
      meetingSystemAudioSilenceTimer = setTimeout(() => {
        meetingSystemAudioSilenceTimer = null;
        if (meetingSystemAudioHeard) return;
        debugLogger.debug(
          "Meeting system audio still silent past warning window",
          { systemAudioStrategy, timeoutMs: MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS },
          "meeting"
        );
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-silent", { systemAudioStrategy });
        }
      }, MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS);
    };

    const clearMeetingSystemAudioTicker = () => {
      if (meetingSystemAudioTicker) {
        clearInterval(meetingSystemAudioTicker);
        meetingSystemAudioTicker = null;
      }
    };

    const stopMeetingSystemAudioWatchdog = () => {
      clearMeetingSystemAudioTicker();
      // Detaches the capture too, which strands any restart still in flight.
      meetingSystemAudioWatchdog.stop();
      meetingSystemAudioWatchdogWin = null;
    };

    // Rolling counterpart to the one-shot warning above, which only covers a
    // session that never produced audio and stops watching once any arrives.
    const startMeetingSystemAudioWatchdog = (win, systemAudioStrategy) => {
      // Deliberately not stopMeetingSystemAudioWatchdog(): capture is already
      // running and attached by this point, and detaching it here would leave a
      // watchdog that reports stalls it cannot recover from.
      clearMeetingSystemAudioTicker();
      meetingSystemAudioWatchdogWin = win;
      meetingSystemAudioWatchdog.start({
        systemAudioStrategy,
        // Only the macOS tap delivers a chunk every period regardless of what
        // is playing; a gap from the loopback helpers proves nothing.
        watchesDelivery: systemAudioStrategy === "native",
      });
      meetingSystemAudioTicker = setInterval(
        () => meetingSystemAudioWatchdog.tick(),
        MEETING_SYSTEM_AUDIO_TICK_MS
      );
    };

    const rollbackMeetingTranscriptionStart = async () => {
      clearMeetingSystemAudioSilenceTimer();
      stopMeetingSystemAudioWatchdog();
      if (this.audioTapManager) {
        await this.audioTapManager.stop().catch(() => {});
      }
      if (this.linuxPortalAudioManager) {
        await this.linuxPortalAudioManager.stop().catch(() => {});
      }
      if (this.windowsLoopbackAudioManager) {
        await this.windowsLoopbackAudioManager.stop().catch(() => {});
      }
      await stopMeetingAec();
      await stopLiveSpeakerIdentification().catch(() => {});
      resetMeetingLocalState();
      await disconnectMeetingStreaming().catch(() => {});
      this.activeMeetingSpeakerConfig = null;
    };

    // Pre-warm: fetch tokens + connect WebSockets before user hits record
    ipcMain.handle("meeting-transcription-prepare", async (event, options = {}) => {
      if (meetingTranscriptionPrepareInProgress || meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription prepare already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }

      if (options.provider === "local") {
        return { success: true };
      }

      const { mode: systemAudioMode } = await getMeetingSystemAudioPlan();
      const requestedConnectionKey = getMeetingConnectionKey(options);

      if (
        isMeetingStreamingConnected(systemAudioMode) &&
        meetingConnectionKey === requestedConnectionKey
      ) {
        debugLogger.debug("Meeting transcription already prepared (warm connections)");
        return { success: true, alreadyPrepared: true };
      }

      meetingTranscriptionPrepareInProgress = true;
      meetingTranscriptionPreparePromise = (async () => {
        let timeoutHandle;
        try {
          await Promise.race([
            connectRealtimeStreaming(event, options),
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error("Prepare timed out")), 15000);
            }),
          ]);
          debugLogger.debug("Meeting transcription prepared (meeting streams warm)");
          return { success: true };
        } catch (error) {
          debugLogger.error("Meeting transcription prepare error", { error: error.message });
          return toFailure(error);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          meetingTranscriptionPrepareInProgress = false;
          meetingTranscriptionPreparePromise = null;
        }
      })();

      return meetingTranscriptionPreparePromise;
    });

    ipcMain.handle("meeting-transcription-cancel", async () => {
      if (isMeetingStreamingConnected() || meetingLocalTimer) {
        return { success: false, reason: "recording-active" };
      }
      meetingTranscriptionPrepareInProgress = false;
      meetingTranscriptionStartInProgress = false;
      meetingTranscriptionPreparePromise = null;
      return { success: true };
    });

    const startMeetingTranscription = async (event, options = {}) => {
      // Wait for any in-flight prepare to finish before starting
      if (meetingTranscriptionPreparePromise) {
        debugLogger.debug("Meeting transcription start: waiting for in-flight prepare");
        await meetingTranscriptionPreparePromise;
      }

      if (meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription start already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }

      if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }

      meetingTranscriptionStartInProgress = true;
      // The lifecycle wrapper is the only caller and always injects the same
      // sessionId it registered; re-deriving one here would silently break
      // scoped stop/auto-end matching.
      const recordingSessionId = options.sessionId;
      meetingStartedAt = Date.now();
      meetingConnectionOptions = options;
      meetingConnectionWin = BrowserWindow.fromWebContents(event.sender);
      meetingReconnectCount = 0;
      meetingFatalErrorSent = false;
      this.meetingDetectionEngine?.endRecordingSession();
      this.meetingDetectionEngine?.setUserRecording(true);

      const completeStart = async (result) => {
        await this.meetingDetectionEngine?.beginRecordingSession({
          sessionId: recordingSessionId,
          autoEndEligible: options.autoEndEligible === true,
          ownerWebContents: event.sender,
          noteId: options.noteId ?? null,
          // Renderer loopback may still fail after main chooses its strategy.
          // Auto-end stays fail-safe until the renderer confirms a real source.
          systemAudioAvailable: false,
        });
        // Arms on any active system-audio strategy — capture follows platform
        // capability, not call detection — so the warning copy also covers
        // in-person recordings where a silent system tap is expected.
        if (result.systemAudioStrategy && result.systemAudioStrategy !== "unsupported") {
          armMeetingSystemAudioSilenceTimer(meetingConnectionWin, result.systemAudioStrategy);
          startMeetingSystemAudioWatchdog(meetingConnectionWin, result.systemAudioStrategy);
        }
        return { ...result, sessionId: recordingSessionId };
      };

      try {
        const systemAudioPlan = await getMeetingSystemAudioPlan({ refreshWindowsCapability: true });
        let { mode: systemAudioMode, strategy: systemAudioStrategy } = systemAudioPlan;
        const requestedConnectionKey = getMeetingConnectionKey(options);
        meetingEchoLeakDetector.reset();
        meetingOneOnOneAttendee = resolveOneOnOneAttendeeForNote(options.noteId);
        meetingOneOnOneProfileBound = false;
        meetingNoteId = options.noteId ?? null;
        this._activeMeetingNoteId = meetingNoteId;

        // Seed the speaker cap from the note/calendar participants up front so live
        // identification isn't stuck at the default if the renderer never pushes a config.
        if (!this.activeMeetingSpeakerConfig) {
          this.activeMeetingSpeakerConfig = this._resolveInitialMeetingSpeakerConfig(meetingNoteId);
        }

        if (systemAudioMode === "unsupported" && this._meetingSystemStreaming?.isConnected) {
          await this._meetingSystemStreaming.disconnect().catch(() => ({ text: "" }));
          this._meetingSystemStreaming = null;
        }

        // If already prepared (warm connections from prepare), just re-attach handlers
        if (
          !meetingLocalMode &&
          isMeetingStreamingConnected(systemAudioMode) &&
          meetingConnectionKey === requestedConnectionKey
        ) {
          debugLogger.debug("Meeting transcription start: reusing warm connections");
          const win = BrowserWindow.fromWebContents(event.sender);
          attachMeetingStreamingHandlers(this._meetingMicStreaming, win, "mic");
          if (systemAudioMode !== "unsupported") {
            attachMeetingStreamingHandlers(this._meetingSystemStreaming, win, "system");
          }
          await startMeetingAec(systemAudioMode);
          await startLiveSpeakerIdentification(win, systemAudioMode);
          ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "during warm-start reuse"
          ));
          return await completeStart({
            success: true,
            systemAudioMode,
            systemAudioStrategy,
            oneOnOneAttendee: meetingOneOnOneAttendee,
          });
        }

        if (options.provider === "local") {
          meetingLocalMode = true;
          meetingLocalProvider = options.localProvider || "whisper";
          meetingLocalModel = options.localModel || null;
          meetingLocalLanguage = options.language || null;
          meetingLocalWin = BrowserWindow.fromWebContents(event.sender);
          meetingLocalBuffers = { mic: [], system: [] };
          meetingLocalTranscript = "";

          await startLiveSpeakerIdentification(meetingLocalWin, systemAudioMode);
          await startMeetingAec(systemAudioMode);

          meetingLocalTimer = setInterval(() => {
            transcribeAllLocalBuffers();
          }, LOCAL_MEETING_CHUNK_INTERVAL_MS);

          ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "in local meeting mode"
          ));

          debugLogger.debug("Meeting transcription started in local mode", {
            provider: meetingLocalProvider,
            systemAudioMode,
            systemAudioStrategy,
          });

          return await completeStart({
            success: true,
            systemAudioMode,
            systemAudioStrategy,
            oneOnOneAttendee: meetingOneOnOneAttendee,
          });
        }

        await connectRealtimeStreaming(event, options);
        const realtimeWin = BrowserWindow.fromWebContents(event.sender);
        await startLiveSpeakerIdentification(realtimeWin, systemAudioMode);
        await startMeetingAec(systemAudioMode);
        ({ systemAudioMode, systemAudioStrategy } = await startMeetingSystemAudio(
          event,
          systemAudioMode,
          systemAudioStrategy,
          "in realtime mode"
        ));
        return await completeStart({
          success: true,
          systemAudioMode,
          systemAudioStrategy,
          oneOnOneAttendee: meetingOneOnOneAttendee,
        });
      } catch (error) {
        await rollbackMeetingTranscriptionStart();
        this.meetingDetectionEngine?.endRecordingSession(recordingSessionId);
        this.meetingDetectionEngine?.setUserRecording(false);
        debugLogger.error("Meeting transcription start error", { error: error.message });
        return toFailure(error);
      } finally {
        meetingTranscriptionStartInProgress = false;
      }
    };

    const sendMeetingAudio = (audioBuffer, source, synthetic = false, capturedAt = null) => {
      const outboundBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      // Auto-end judges "is anyone audible" from the raw chunk of either
      // channel, before AEC/holdback/muting can swallow it.
      if (!synthetic) {
        this.meetingDetectionEngine?.recordMeetingAudioChunk(source, outboundBuffer);
      }

      if (source === "system") {
        const receivedAt = Date.now();
        // Recovery silence repairs sample clocks, but is not current capture
        // evidence or an AEC reference for the mic arriving now.
        if (!synthetic) {
          meetingEchoLeakDetector.recordSystemChunk(outboundBuffer, receivedAt);
          if (meetingAecEnabled && !this.meetingAecManager?.processSystemBuffer(outboundBuffer)) {
            meetingAecEnabled = false;
          }
          flushPendingMeetingMicChunks();
        }

        if (meetingLiveSpeakerActive) {
          // identification.startTime counts samples from the first chunk the
          // identifier sees, so the wall-clock anchor has to be the arrival of
          // that chunk. Stamping it when identification starts is only correct
          // when capture is already running (the macOS tap); the Windows
          // loopback helper can take seconds to hand over its first buffer, and
          // a stale anchor shifts every label earlier by that gap.
          meetingLiveSpeakerStartedAt ??= receivedAt;
          void liveSpeakerIdentifier.feedAudio(outboundBuffer);
        }

        if (!meetingDiarizationStream) {
          const os = require("os");
          meetingDiarizationPath = path.join(os.tmpdir(), `ow-diarize-raw-${Date.now()}.pcm`);
          meetingDiarizationStream = fs.createWriteStream(meetingDiarizationPath);
          meetingDiarizationStartedAt = receivedAt;
        }
        meetingDiarizationStream.write(outboundBuffer);

        if (!synthetic) {
          // Every real chunk feeds the watchdog, including actual silence.
          const { rms, peak } = computeChunkStats(outboundBuffer);
          const audible = rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK;
          meetingSystemAudioWatchdog.recordChunk(audible);
          if (audible && !meetingSystemAudioHeard) {
            // A call is audibly underway, so stop paying the mic capture's disk cost.
            meetingSystemAudioHeard = true;
            dropMeetingMicDiarizationCapture();
          }
        }

        dispatchMeetingAudioBuffer(outboundBuffer, "system", synthetic, capturedAt);
        return;
      }

      if (source === "mic") {
        // Until the session proves to be a call (audible system audio), keep a
        // raw mic capture so an in-person recording can be diarized. Written
        // pre-AEC/pre-gate so the timeline stays continuous, like the system
        // capture above.
        if (!meetingSystemAudioHeard) {
          if (!meetingMicDiarizationStream) {
            const receivedAt = Date.now();
            meetingMicDiarizationPath = path.join(
              os.tmpdir(),
              `ow-diarize-raw-mic-${receivedAt}.pcm`
            );
            meetingMicDiarizationStream = fs.createWriteStream(meetingMicDiarizationPath);
            meetingMicDiarizationStartedAt = receivedAt;
          }
          meetingMicDiarizationStream.write(outboundBuffer);
        }

        if (processMeetingMicWithAec(outboundBuffer)) {
          return;
        }

        if (!hasNativeMeetingSystemAudio()) {
          const analysis = meetingEchoLeakDetector.analyzeMicChunk(outboundBuffer);
          if (analysis?.shouldMute && !meetingAecEnabled) {
            if (!meetingLocalMode) {
              dispatchMeetingAudioBuffer(Buffer.alloc(outboundBuffer.length), "mic");
            }
            return;
          }

          dispatchMeetingAudioBuffer(outboundBuffer, "mic");
          return;
        }

        meetingPendingMicChunks.push({
          buffer: outboundBuffer,
          queuedAt: Date.now(),
        });
        flushPendingMeetingMicChunks();
        return;
      }
    };

    // The Windows helper reports capture_silent when its own stream is silent
    // while a render endpoint is playing: activation succeeded but no audio
    // will ever arrive, so hand the live session to Chromium's renderer
    // loopback. The silence watchdog stays armed in case that fails too.
    const degradeMeetingSystemAudioToLoopback = async (event) => {
      if (meetingSystemAudioDegraded || meetingSystemAudioHeard) return;
      meetingSystemAudioDegraded = true;
      debugLogger.warn(
        "Windows system audio helper captured only silence, switching to renderer loopback",
        {},
        "meeting"
      );
      await this.windowsLoopbackAudioManager?.stop().catch(() => {});
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-system-audio-degraded");
      }
    };

    const startManagedMeetingSystemAudio = (event, manager, warningLabel, onWarningCode) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const timeline =
        manager === this.audioTapManager ? require("./meetingAudioTimeline")() : null;
      let captureStarted = false;
      const startCapture = () => {
        if (captureStarted) timeline?.markRestart();
        captureStarted = true;
        return manager.start({
          onChunk: (chunk) => {
            if (timeline) {
              timeline.write(chunk, (buffer, synthetic, capturedAt) =>
                sendMeetingAudio(buffer, "system", synthetic, capturedAt)
              );
            } else {
              sendMeetingAudio(chunk, "system");
            }
          },
          onError: (error) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send("meeting-transcription-error", error.message);
            }
          },
          onWarning: (warning) => {
            debugLogger.warn(
              warningLabel,
              { code: warning.code, message: warning.message },
              "meeting"
            );
            onWarningCode?.(warning.code);
          },
        });
      };

      // Keep the native sample timeline through recovery, including the stall
      // before detection and the helper restart. New sessions get a new timeline.
      meetingSystemAudioWatchdog.attachCapture({
        stop: () => manager.stop(),
        start: startCapture,
      });

      return startCapture();
    };

    const fallBackToMicOnly = async (context) => {
      if (this._meetingSystemStreaming?.isConnected) {
        await this._meetingSystemStreaming.disconnect().catch((disconnectError) => {
          debugLogger.debug(
            `System streaming disconnect during ${context} fallback failed`,
            { error: disconnectError.message },
            "meeting"
          );
        });
      }
      this._meetingSystemStreaming = null;
      // No system capture left to recover, so drop the restart hook with it.
      stopMeetingSystemAudioWatchdog();
      await stopLiveSpeakerIdentification().catch(() => {});
    };

    const startMeetingSystemAudio = async (
      event,
      systemAudioMode,
      systemAudioStrategy,
      context
    ) => {
      if (systemAudioMode === "native") {
        try {
          await startManagedMeetingSystemAudio(
            event,
            this.audioTapManager,
            "macOS system audio tap warning",
            (code) => {
              // The tap is pinned to the devices it saw at creation, so a route
              // change can strand it. Restart before the stall window elapses.
              if (code === "device_invalidated") {
                meetingSystemAudioWatchdog.reportDeviceInvalidated();
              }
            }
          );
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Native system audio tap failed ${context}, falling back to mic-only`,
            { error: error.message },
            "meeting"
          );
          await fallBackToMicOnly("native");
          return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
        }
      }

      if (systemAudioStrategy === "wasapi-loopback") {
        try {
          await startManagedMeetingSystemAudio(
            event,
            this.windowsLoopbackAudioManager,
            "Windows system audio warning",
            (code) => {
              if (code === "capture_silent") {
                void degradeMeetingSystemAudioToLoopback(event);
              }
            }
          );
          return { systemAudioMode, systemAudioStrategy };
        } catch (error) {
          debugLogger.warn(
            `Windows system audio helper failed ${context}, falling back to renderer loopback`,
            { error: error.message },
            "meeting"
          );
          // The renderer captures via Chromium's display-media loopback when
          // it sees the downgraded strategy in the start result.
          return { systemAudioMode, systemAudioStrategy: "loopback" };
        }
      }

      if (systemAudioStrategy !== "pipewire-loopback") {
        return { systemAudioMode, systemAudioStrategy };
      }

      try {
        await startManagedMeetingSystemAudio(
          event,
          this.linuxPortalAudioManager,
          "Linux PipeWire system audio warning"
        );
        return { systemAudioMode, systemAudioStrategy };
      } catch (error) {
        debugLogger.warn(
          `Linux PipeWire helper failed ${context}, falling back to mic-only`,
          { error: error.message },
          "meeting"
        );
        await fallBackToMicOnly("PipeWire");
        return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
      }
    };

    ipcMain.on("meeting-transcription-send", (_event, audioBuffer, source) => {
      sendMeetingAudio(audioBuffer, source);
    });

    const stopMeetingTranscription = async (expectedSessionId) => {
      // Only a *different* live session blocks teardown — it owns the shared
      // capture now. With no engine session (e.g. after quit-path engine stop)
      // the streams below must still be torn down.
      if (this.meetingDetectionEngine?.endRecordingSession(expectedSessionId) === false) {
        return { success: false, reason: "stale-session" };
      }
      this.meetingDetectionEngine?.setUserRecording(false);
      clearMeetingSystemAudioSilenceTimer();
      stopMeetingSystemAudioWatchdog();
      try {
        if (this.audioTapManager) {
          await this.audioTapManager.stop();
        }
        if (this.linuxPortalAudioManager) {
          await this.linuxPortalAudioManager.stop().catch(() => {});
        }
        if (this.windowsLoopbackAudioManager) {
          await this.windowsLoopbackAudioManager.stop().catch(() => {});
        }

        flushPendingMeetingMicChunks(true);
        await stopMeetingAec();

        const liveSpeakerState = await stopLiveSpeakerIdentification().catch(() => null);

        const diarizationSessionId = `diar-${Date.now()}`;
        const diarizationWin = meetingLocalWin || this.windowManager.controlPanelWindow;

        if (meetingLocalMode) {
          if (meetingLocalTimer) {
            clearInterval(meetingLocalTimer);
            meetingLocalTimer = null;
          }
          try {
            await transcribeAllLocalBuffers();
          } catch (err) {
            debugLogger.error("Local meeting final transcription failed", { error: err.message });
          }
          flushPendingMicFinals(true);
          const { diarizationPcmPath, diarizationSegments, diarizationStartedAt, diarizedSource } =
            await captureMeetingDiarizationState();
          const transcript =
            buildOrderedTranscriptText(diarizationSegments) || meetingLocalTranscript;
          const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
          const noteIdSnapshot = meetingNoteId;
          this.activeMeetingSpeakerConfig = null;
          resetMeetingLocalState();

          // Fire-and-forget background diarization (or notify skip)
          this._startOrSkipDiarization(
            diarizationSessionId,
            diarizationPcmPath,
            diarizationStartedAt,
            diarizationSegments,
            diarizationWin,
            liveSpeakerState,
            sessionSpeakerConfigSnapshot,
            noteIdSnapshot,
            diarizedSource
          );

          return { success: true, transcript, diarizationSessionId };
        }

        const results = await disconnectMeetingStreaming({ flushPending: true });
        const { diarizationPcmPath, diarizationSegments, diarizationStartedAt, diarizedSource } =
          await captureMeetingDiarizationState();
        const transcript =
          buildOrderedTranscriptText(diarizationSegments) ||
          [results[0]?.text, results[1]?.text].filter(Boolean).join(" ");

        const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
        const noteIdSnapshot = meetingNoteId;
        this.activeMeetingSpeakerConfig = null;

        // Fire-and-forget background diarization (or notify skip)
        this._startOrSkipDiarization(
          diarizationSessionId,
          diarizationPcmPath,
          diarizationStartedAt,
          diarizationSegments,
          diarizationWin,
          liveSpeakerState,
          sessionSpeakerConfigSnapshot,
          noteIdSnapshot,
          diarizedSource
        );

        return { success: true, transcript, diarizationSessionId };
      } catch (error) {
        debugLogger.error("Meeting transcription stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    };

    const meetingTranscriptionLifecycle = createMeetingTranscriptionLifecycle({
      start: ({ sessionId, ownerWebContents, options }) =>
        startMeetingTranscription({ sender: ownerWebContents }, { ...options, sessionId }),
      stop: (sessionId) => stopMeetingTranscription(sessionId),
      onError: (error, sessionId) => {
        debugLogger.error(
          "Meeting transcription owner-loss teardown failed",
          { error: error?.message, sessionId },
          "meeting"
        );
      },
    });

    ipcMain.handle("meeting-transcription-start", (event, options = {}) => {
      const sessionId =
        typeof options.sessionId === "string" && options.sessionId.length > 0
          ? options.sessionId
          : crypto.randomUUID();
      return meetingTranscriptionLifecycle.startSession({
        sessionId,
        ownerWebContents: event.sender,
        options,
      });
    });

    ipcMain.handle("meeting-transcription-stop", (_event, expectedSessionId) =>
      meetingTranscriptionLifecycle.stopSession(expectedSessionId)
    );

    ipcMain.handle(
      "meeting-transcription-set-system-audio-available",
      async (event, sessionId, available) => {
        const updated = await this.meetingDetectionEngine?.setRecordingSystemAudioAvailable(
          sessionId,
          available === true,
          event.sender
        );
        return updated === true ? { success: true } : { success: false, reason: "stale-session" };
      }
    );

    ipcMain.handle("get-model-cache-root", () => {
      const { getCacheRoot } = require("./modelDirUtils");
      return getCacheRoot();
    });

    ipcMain.handle("open-whisper-models-folder", async () => {
      try {
        const { getCacheRoot } = require("./modelDirUtils");
        const cacheRoot = getCacheRoot();
        await fs.promises.mkdir(cacheRoot, { recursive: true });
        const errMsg = await shell.openPath(cacheRoot);
        if (errMsg) return { success: false, error: errMsg };
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open model cache folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        const path = require("path");
        const fs = require("fs");
        const envPath = path.join(app.getPath("userData"), ".env");

        // Read current .env content
        let envContent = "";
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, "utf8");
        }

        // Parse lines
        const lines = envContent.split("\n");
        const logLevelIndex = lines.findIndex((line) =>
          line.trim().startsWith("OPENWHISPR_LOG_LEVEL=")
        );

        if (enabled) {
          // Set to debug
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=debug";
          } else {
            // Add new line
            if (lines.length > 0 && lines[lines.length - 1] !== "") {
              lines.push("");
            }
            lines.push("# Debug logging setting");
            lines.push("OPENWHISPR_LOG_LEVEL=debug");
          }
        } else {
          // Remove or set to info
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=info";
          }
        }

        // Write back
        fs.writeFileSync(envPath, lines.join("\n"), "utf8");

        // Update environment variable
        process.env.OPENWHISPR_LOG_LEVEL = enabled ? "debug" : "info";

        // Refresh logger state
        debugLogger.refreshLogLevel();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        await shell.openPath(logsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("check-for-updates", async () => {
      return { updateAvailable: false, message: "Updates disabled in this fork" }; // fork
    });

    ipcMain.handle("download-update", async () => {
      return this.updateManager.downloadUpdate();
    });

    ipcMain.handle("install-update", async () => {
      return this.updateManager.installUpdate();
    });

    ipcMain.handle("get-app-version", async () => {
      return this.updateManager.getAppVersion();
    });

    ipcMain.handle("get-update-status", async () => {
      return this.updateManager.getUpdateStatus();
    });

    ipcMain.handle("get-update-info", async () => {
      return this.updateManager.getUpdateInfo();
    });

    ipcMain.handle("set-auto-updates-enabled", async (_event, enabled) => {
      this.updateManager.setAutoUpdatesEnabled(enabled === true);
      return { success: true };
    });

    // Google Calendar
    ipcMain.handle("gcal-start-oauth", async () => {
      try {
        return await this.googleCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Google Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-disconnect", async (_event, email) => {
      try {
        this.googleCalendarManager.disconnect(email);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Google Calendar disconnect failed",
          { error: error.message },
          "calendar"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-get-connection-status", async () => {
      try {
        return this.googleCalendarManager.getConnectionStatus();
      } catch (error) {
        return { connected: false, email: null };
      }
    });

    ipcMain.handle("gcal-get-calendars", async () => {
      try {
        return { success: true, calendars: this.googleCalendarManager.getCalendars() };
      } catch (error) {
        return { success: false, calendars: [] };
      }
    });

    ipcMain.handle("gcal-set-calendar-selection", async (_event, calendarId, isSelected) => {
      try {
        await this.googleCalendarManager.setCalendarSelection(calendarId, isSelected);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-set-primary-only", async (_event, value) => {
      try {
        await this.googleCalendarManager.setPrimaryOnly(value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-sync-events", async () => {
      try {
        await this.googleCalendarManager.syncEvents();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-get-upcoming-events", async (_event, windowMinutes) => {
      try {
        return {
          success: true,
          events: await this.googleCalendarManager.getUpcomingEvents(windowMinutes),
        };
      } catch (error) {
        return { success: false, events: [] };
      }
    });

    ipcMain.handle("gcal-get-event", async (_event, eventId) => {
      try {
        const event = this.databaseManager.getCalendarEventById(eventId);
        return { success: true, event };
      } catch (error) {
        return { success: false, event: null };
      }
    });

    // Microsoft Calendar
    ipcMain.handle("mcal-start-oauth", async () => {
      try {
        return await this.microsoftCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Microsoft Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("mcal-disconnect", async (_event, email) => {
      try {
        this.microsoftCalendarManager.disconnect(email);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Microsoft Calendar disconnect failed",
          { error: error.message },
          "calendar"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("mcal-get-connection-status", async () => {
      try {
        return this.microsoftCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Microsoft Calendar connection status failed",
          { error: error.message },
          "calendar"
        );
        return { connected: false, accounts: [] };
      }
    });

    ipcMain.handle("mcal-set-primary-only", async (_event, value) => {
      try {
        await this.microsoftCalendarManager.setPrimaryOnly(value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Apple Calendar (macOS EventKit)
    ipcMain.handle("acal-connect", async () => {
      try {
        return await this.appleCalendarManager.connect();
      } catch (error) {
        debugLogger.error("Apple Calendar connect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-disconnect", async () => {
      try {
        return this.appleCalendarManager.disconnect();
      } catch (error) {
        debugLogger.error("Apple Calendar disconnect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-get-connection-status", async () => {
      try {
        return this.appleCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Apple Calendar connection status failed",
          { error: error.message },
          "acal"
        );
        return { connected: false, sourceNames: [] };
      }
    });

    ipcMain.handle("search-contacts", async (_event, query) => {
      try {
        const contacts = this.databaseManager.searchContacts(query);
        return { success: true, contacts };
      } catch (error) {
        return { success: false, contacts: [] };
      }
    });

    ipcMain.handle("upsert-contact", async (_event, contact) => {
      try {
        this.databaseManager.upsertContacts([contact]);
        return { success: true };
      } catch (error) {
        return { success: false };
      }
    });

    ipcMain.handle("get-md5-hash", (_event, text) => {
      return crypto.createHash("md5").update(text.toLowerCase().trim()).digest("hex");
    });

    const NOTIFICATION_PREF_KEYS = new Set([
      "notificationsEnabled",
      "notifyMeetingDetection",
      "notifyCalendarReminders",
    ]);

    ipcMain.handle("sync-notification-preferences", async (_event, prefs) => {
      try {
        if (!prefs || typeof prefs !== "object") {
          return { success: false, error: "Invalid preferences" };
        }
        for (const [key, value] of Object.entries(prefs)) {
          if (NOTIFICATION_PREF_KEYS.has(key)) {
            this.windowManager.notificationPrefs[key] = !!value;
          }
        }
        if (typeof prefs.meetingProcessDetection === "boolean") {
          this.meetingProcessDetection = prefs.meetingProcessDetection;
        }
        const { notificationsEnabled, notifyMeetingDetection } =
          this.windowManager.notificationPrefs;
        this.meetingDetectionEngine?.setPreferences(
          deriveDetectorPreferences({
            notificationsEnabled,
            notifyMeetingDetection,
            meetingProcessDetection: this.meetingProcessDetection,
          })
        );
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-speaker-diarization-enabled", async (_event, payload) => {
      try {
        this.speakerDiarizationEnabled = payload?.enabled !== false;
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("whisper-vad-get-config", async () => {
      try {
        return { success: true, config: this._getWhisperVadSettings() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("whisper-vad-set-config", async (_event, payload) => {
      try {
        const config = this._setWhisperVadSettings(payload || {});
        return { success: true, config };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-session-speaker-config", async (_event, payload) => {
      try {
        const enabled = payload?.enabled !== false;
        const expectedCount = Math.max(
          1,
          Math.min(
            MAX_SPEAKER_COUNT,
            Number(payload?.expectedCount) || DEFAULT_EXPECTED_SPEAKER_COUNT
          )
        );
        // Only a stepper-set count is explicit; the diarization toggle reuses this
        // channel and must not freeze the count against roster-driven refreshes.
        this.activeMeetingSpeakerConfig = {
          enabled,
          expectedCount,
          explicit: payload?.countIsExplicit === true,
        };
        liveSpeakerIdentifier.setEnabled(enabled);
        // Live identification only labels other speakers (the mic track is "you"),
        // so cap at expectedCount - 1 to match resolveSessionMaxSpeakers().
        liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-notification-respond", async (_event, detectionId, action) => {
      try {
        await this.meetingDetectionEngine.handleNotificationResponse(detectionId, action);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("join-calendar-meeting", async (_event, eventId) => {
      try {
        await this.meetingDetectionEngine.joinCalendarMeeting(eventId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("start-manual-meeting", () => this.windowManager.startManualMeeting());

    ipcMain.handle("get-meeting-notification-data", async () => {
      return this.windowManager?._pendingNotificationData ?? null;
    });

    ipcMain.handle("get-pending-meeting-note-navigation", async () => {
      return this.windowManager?.consumePendingMeetingNoteNavigation() ?? null;
    });

    ipcMain.handle("get-pending-note-navigation", async () => {
      return this.windowManager?.consumePendingNoteNavigation() ?? null;
    });

    ipcMain.handle("meeting-notification-ready", async (event) => {
      this.windowManager?.showNotificationWindow(event.sender);
    });

    // Note files (markdown mirror) handlers
    ipcMain.handle("note-files-set-enabled", async (_event, enabled, customPath, options) => {
      try {
        this._noteFilesEnabled = !!enabled;
        if (!enabled) return { success: true };
        const basePath = customPath || path.join(app.getPath("userData"), "notes");
        if (options?.skipRebuild) {
          require("./markdownMirror").init(basePath);
        } else {
          this._rebuildMirror(basePath);
        }
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to set note-files enabled",
          { error: error.message },
          "note-files"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-set-path", async (_event, newPath) => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror(newPath);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to set note-files path", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-rebuild", async () => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to rebuild note files", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-get-default-path", async () => {
      return path.join(app.getPath("userData"), "notes");
    });

    ipcMain.handle("show-note-file", async (_event, noteId) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const filePath = markdownMirror.getNotePath(noteId);
        if (!filePath) return { success: false };
        shell.showItemInFolder(filePath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show note file",
          { noteId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("show-folder-in-explorer", async (_event, folderName) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const dirPath = markdownMirror.getFolderPath(folderName);
        if (!dirPath) return { success: false };
        await shell.openPath(dirPath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show folder",
          { folderName, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("note-files-pick-folder", async () => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        return { canceled: false, path: result.filePaths[0] };
      } catch (error) {
        debugLogger.error("Failed to pick folder", { error: error.message }, "note-files");
        return { canceled: true };
      }
    });

    ipcMain.handle("granola-import-pick-and-preview", async (event) => {
      try {
        const { dialog } = require("electron");
        // Parent the dialog so it opens as a sheet on the settings window —
        // a parentless panel can land invisible on another display/Space.
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        // Granola chunks large exports into numbered files (…-000.csv, -001, …),
        // so let the user grab the whole set in one pick.
        const dialogOptions = {
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "CSV", extensions: ["csv"] }],
        };
        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        const filePaths = [...result.filePaths].sort();
        const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
        const { createGranolaNoteKeyAllocator, parseGranolaCsv } =
          await import("./granolaImport.js");
        const allocateNoteKey = createGranolaNoteKeyAllocator();
        const notes = [];
        const seenIds = new Set();
        let rowIssueCount = 0;
        for (const filePath of filePaths) {
          if (fs.statSync(filePath).size > MAX_IMPORT_BYTES) {
            return { canceled: false, success: false, error: "FILE_TOO_LARGE" };
          }
          const parsed = parseGranolaCsv(fs.readFileSync(filePath, "utf8"), {
            allocateNoteKey,
          });
          if (!parsed.ok) {
            return { canceled: false, success: false, error: parsed.error.code };
          }
          // File-level warnings (e.g. ignored columns) are expected on every
          // real export; only row-scoped problems belong in the issue count.
          rowIssueCount += parsed.warnings.filter((warning) => warning.row != null).length;
          for (const note of parsed.notes) {
            if (!seenIds.has(note.clientNoteId)) {
              seenIds.add(note.clientNoteId);
              notes.push(note);
            }
          }
        }
        const existing = new Set(
          this.databaseManager.getExistingClientNoteIds(notes.map((n) => n.clientNoteId))
        );
        const freshNotes = notes.filter((n) => !existing.has(n.clientNoteId));
        // The run handler only ever imports what this preview parsed — the
        // renderer never sends a file path across the bridge.
        this._granolaImportPending = { notes };
        return {
          canceled: false,
          success: true,
          fileName: filePaths.map((p) => path.basename(p)).join(", "),
          total: notes.length,
          newCount: freshNotes.length,
          duplicateCount: notes.length - freshNotes.length,
          sampleTitles: freshNotes.slice(0, 5).map((n) => n.title),
          rowIssueCount,
        };
      } catch (error) {
        debugLogger.error(
          "Granola import preview failed",
          { error: error.message },
          "granola-import"
        );
        return { canceled: false, success: false, error: "READ_FAILED" };
      }
    });

    ipcMain.handle("granola-import-run", async () => {
      const pending = this._granolaImportPending;
      this._granolaImportPending = null;
      if (!pending) return { success: false, error: "NO_PENDING_IMPORT" };
      try {
        const result = this.databaseManager.importNotes(pending.notes);
        if (result.imported > 0) {
          // One-shot side effects: a single index wake-up (the SQLite triggers
          // already journaled every imported note) and a single mirror rebuild —
          // never per-note work (sync storm / O(notes × files) mirror scans).
          setImmediate(() => {
            try {
              if (this._noteFilesEnabled) this._rebuildMirror();
            } catch (sideEffectError) {
              debugLogger.error(
                "Granola import side effects failed",
                { error: sideEffectError.message },
                "granola-import"
              );
            }
          });
        }
        return {
          success: true,
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors,
        };
      } catch (error) {
        debugLogger.error("Granola import failed", { error: error.message }, "granola-import");
        return { success: false, error: "IMPORT_FAILED" };
      }
    });

    ipcMain.handle("get-speaker-mappings", async (_event, noteId) => {
      return this.databaseManager.getSpeakerMappings(noteId);
    });

    ipcMain.handle(
      "set-speaker-mapping",
      async (_event, noteId, speakerId, displayName, email, profileId) => {
        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        const noteSpeakerEmbedding = embeddings.find((e) => e.speaker_id === speakerId);
        const liveSpeakerEmbedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
        const speakerEmbeddingBuffer =
          noteSpeakerEmbedding?.embedding ||
          (liveSpeakerEmbedding ? Buffer.from(liveSpeakerEmbedding.buffer) : null);

        let resolvedProfileId = profileId ?? null;
        if (speakerEmbeddingBuffer) {
          const profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email || null,
            speakerEmbeddingBuffer,
            resolvedProfileId
          );
          resolvedProfileId = profile.id;
          this._retroactiveMapping(profile);
        }

        this.databaseManager.setSpeakerMapping(noteId, speakerId, resolvedProfileId, displayName);
        liveSpeakerIdentifier.mapSpeaker(speakerId, resolvedProfileId, displayName, noteId);
        return { success: true, profileId: resolvedProfileId };
      }
    );

    ipcMain.handle("remove-speaker-mapping", async (_event, noteId, speakerId) => {
      this.databaseManager.removeSpeakerMapping(noteId, speakerId);
      return { success: true };
    });

    ipcMain.handle("get-speaker-profiles", async () => {
      return this.databaseManager.getSpeakerProfiles();
    });

    ipcMain.handle("attach-speaker-email", async (_event, profileId, email) => {
      try {
        const profile = this.databaseManager.attachEmailToProfile(profileId, email);
        this._retroactiveMapping(profile);
        return {
          success: true,
          profile: {
            id: profile.id,
            display_name: profile.display_name,
            email: profile.email,
            sample_count: profile.sample_count,
          },
        };
      } catch (error) {
        debugLogger.error(
          "Failed to attach email to speaker profile",
          { error: error.message },
          "speaker"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("save-note-speaker-embeddings", async (_event, noteId, embeddingsObj) => {
      const buffers = {};
      for (const [speakerId, arr] of Object.entries(embeddingsObj)) {
        buffers[speakerId] = Buffer.from(new Float32Array(arr).buffer);
      }
      this.databaseManager.saveNoteSpeakerEmbeddings(noteId, buffers);
      this._tryAutoLabelOneOnOne(noteId);
      return { success: true };
    });
  }

  _retroactiveMapping(profile) {
    setImmediate(async () => {
      try {
        const speakerEmbeddings = require("./speakerEmbeddings");
        const noteIds = this.databaseManager.getNotesWithUnmappedSpeakers();

        const profileEmb = new Float32Array(
          profile.embedding.buffer,
          profile.embedding.byteOffset,
          profile.embedding.byteLength / 4
        );

        for (const noteId of noteIds) {
          const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
          const existing = this.databaseManager.getSpeakerMappings(noteId);
          const mappedSpeakers = new Set(existing.map((m) => m.speaker_id));
          for (const emb of embeddings) {
            if (mappedSpeakers.has(emb.speaker_id)) continue;

            const speakerEmb = new Float32Array(
              emb.embedding.buffer,
              emb.embedding.byteOffset,
              emb.embedding.byteLength / 4
            );
            const similarity = speakerEmbeddings.cosineSimilarity(profileEmb, speakerEmb);

            if (similarity > 0.6) {
              this.databaseManager.setSpeakerMapping(
                noteId,
                emb.speaker_id,
                profile.id,
                profile.display_name
              );

              const note = this.databaseManager.getNote(noteId);
              if (note?.transcript) {
                try {
                  const segments = JSON.parse(note.transcript);
                  let changed = false;
                  for (const seg of segments) {
                    if (seg.speaker === emb.speaker_id && !seg.speakerName) {
                      if (canAutoRelabelSpeaker(seg)) {
                        applyConfirmedSpeaker(seg, {
                          speakerName: profile.display_name,
                          speakerIsPlaceholder: false,
                        });
                      } else {
                        seg.speakerName = profile.display_name;
                        seg.speakerIsPlaceholder = false;
                      }
                      changed = true;
                    }
                  }
                  if (changed) {
                    this.databaseManager.updateNote(noteId, {
                      transcript: JSON.stringify(segments),
                    });
                  }
                } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        debugLogger.warn("Retroactive speaker mapping failed", { error: err.message });
      }
    });
  }

  _tryAutoLabelOneOnOne(noteId) {
    setImmediate(async () => {
      try {
        const note = this.databaseManager.getNote(noteId);
        const other = this._resolveOneOnOneOtherParticipant(note?.participants);
        if (!other) return;
        const { displayName, email } = other;

        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        if (!embeddings.length) return;

        const existingMappings = this.databaseManager.getSpeakerMappings(noteId);
        const mappedSpeakers = new Set(existingMappings.map((m) => m.speaker_id));

        const transcript = note.transcript ? JSON.parse(note.transcript) : [];
        const systemSpeakers = new Set(
          transcript.filter((s) => s.source !== "mic" && s.speaker).map((s) => s.speaker)
        );

        const unmapped = embeddings.filter(
          (e) => !mappedSpeakers.has(e.speaker_id) && systemSpeakers.has(e.speaker_id)
        );
        if (!unmapped.length) return;

        let profile = null;
        for (const emb of unmapped) {
          profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email,
            emb.embedding,
            profile?.id ?? null
          );
          this.databaseManager.setSpeakerMapping(noteId, emb.speaker_id, profile.id, displayName);
          liveSpeakerIdentifier.mapSpeaker(emb.speaker_id, profile.id, displayName, noteId);
        }

        const unmappedSystemSpeakers = new Set(unmapped.map((e) => e.speaker_id));
        let changed = false;
        for (const seg of transcript) {
          if (!unmappedSystemSpeakers.has(seg.speaker)) continue;
          if (seg.speakerName && !seg.speakerIsPlaceholder) continue;
          if (canAutoRelabelSpeaker(seg)) {
            applyConfirmedSpeaker(seg, { speakerName: displayName, speakerIsPlaceholder: false });
          } else {
            seg.speakerName = displayName;
            seg.speakerIsPlaceholder = false;
          }
          changed = true;
        }

        if (changed) {
          this.databaseManager.updateNote(noteId, { transcript: JSON.stringify(transcript) });
          const updated = this.databaseManager.getNote(noteId);
          if (updated) broadcastToWindows("note-updated", updated);
        }

        if (profile) this._retroactiveMapping(profile);

        debugLogger.info(
          "Auto-labeled 1-on-1 meeting speakers",
          { noteId, displayName, speakerCount: unmapped.length },
          "speaker"
        );
      } catch (err) {
        debugLogger.warn("Auto-label 1-on-1 failed", { noteId, error: err.message }, "speaker");
      }
    });
  }

  _applySpeakerName(segments, speakerId, displayName) {
    if (!displayName) {
      return;
    }

    for (const segment of segments) {
      if (segment.speaker !== speakerId) {
        continue;
      }

      applyConfirmedSpeaker(segment, {
        speakerName: displayName,
        speakerIsPlaceholder: false,
        suggestedName: undefined,
        suggestedProfileId: undefined,
      });
    }
  }

  _reconcileLiveSpeakerState(liveSpeakerState, speakerEmbeddingsMap, enrichedSegments) {
    if (!liveSpeakerState || !speakerEmbeddingsMap) {
      return new Set();
    }

    const speakerEmbeddings = require("./speakerEmbeddings");
    const reconciledSpeakers = new Set();
    const usedLiveSpeakers = new Set();
    const noteMappings = new Map();

    const liveEntries = Object.entries(liveSpeakerState)
      .map(([speakerId, data]) => ({
        speakerId,
        displayName: data?.displayName || null,
        profileId: data?.profileId ?? null,
        noteId: data?.noteId ?? null,
        embedding: Array.isArray(data?.embedding) ? new Float32Array(data.embedding) : null,
      }))
      .filter((entry) => entry.embedding);

    const getMappingsForNote = (noteId) => {
      if (!noteMappings.has(noteId)) {
        noteMappings.set(noteId, this.databaseManager.getSpeakerMappings(noteId));
      }
      return noteMappings.get(noteId);
    };

    for (const [mappedId, embeddingArray] of Object.entries(speakerEmbeddingsMap)) {
      let bestEntry = null;
      let bestSimilarity = 0;

      for (const entry of liveEntries) {
        if (usedLiveSpeakers.has(entry.speakerId)) {
          continue;
        }

        const similarity = speakerEmbeddings.cosineSimilarity(
          new Float32Array(embeddingArray),
          entry.embedding
        );
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestEntry = entry;
        }
      }

      if (!bestEntry || bestSimilarity <= 0.6) {
        continue;
      }

      usedLiveSpeakers.add(bestEntry.speakerId);
      reconciledSpeakers.add(mappedId);

      let displayName = bestEntry.displayName;
      let profileId = bestEntry.profileId;

      if (bestEntry.noteId) {
        const liveMapping = getMappingsForNote(bestEntry.noteId).find(
          (mapping) => mapping.speaker_id === bestEntry.speakerId
        );
        if (liveMapping) {
          displayName = liveMapping.display_name || displayName;
          profileId = liveMapping.profile_id ?? profileId;
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
          // Live and offline ids share one namespace now, so they often match —
          // removing the "old" row would delete the mapping just written.
          if (bestEntry.speakerId !== mappedId) {
            this.databaseManager.removeSpeakerMapping(bestEntry.noteId, bestEntry.speakerId);
          }
        } else if (displayName) {
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
        }
      }

      this._applySpeakerName(enrichedSegments, mappedId, displayName);
    }

    return reconciledSpeakers;
  }

  _resolveSpeakerExpectation({ sessionConfig, noteId, observedSpeakerIds, diarizedSource }) {
    // Only a count the user set explicitly outranks the note: participants added
    // mid-meeting postdate the config snapshot taken at recording start.
    let expectedTotal = sessionConfig?.explicit ? sessionConfig.expectedCount : null;

    if (!expectedTotal && noteId != null) {
      try {
        expectedTotal = this._noteExpectedSpeakerCountOrNull(this.databaseManager.getNote(noteId));
      } catch (_) {
        expectedTotal = null;
      }
    }

    // Diarizing the mic track (in-person session) means the user is one of the
    // diarized voices, so the expected total applies without the -1 the
    // system-audio branches use.
    const micMode = diarizedSource === "mic";

    if (expectedTotal) {
      const total = Math.min(expectedTotal, MAX_SPEAKER_COUNT);
      const numSpeakers = micMode ? total : Math.max(1, total - 1);
      return { numSpeakers, cap: numSpeakers };
    }

    if (observedSpeakerIds.size >= 2) {
      const numSpeakers = Math.min(observedSpeakerIds.size, MAX_SPEAKER_COUNT);
      return { numSpeakers, cap: numSpeakers };
    }

    if (micMode) {
      return { numSpeakers: -1, cap: DEFAULT_EXPECTED_SPEAKER_COUNT };
    }

    // Only system audio reaches the diarizer (the mic track is "you"), so the cap
    // counts other speakers — same total - 1 basis as the branches above.
    return { numSpeakers: -1, cap: Math.max(1, DEFAULT_EXPECTED_SPEAKER_COUNT - 1) };
  }

  _startOrSkipDiarization(
    sessionId,
    rawPcmPath,
    audioStartedAt,
    transcriptSegments,
    win,
    liveSpeakerState = null,
    sessionConfig = null,
    noteId = null,
    diarizedSource = "system"
  ) {
    const send = (payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-diarization-complete", { sessionId, noteId, ...payload });
      }
    };

    const diarizationEnabled = (sessionConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    if (!diarizationEnabled || !this.diarizationManager?.isAvailable() || !rawPcmPath) {
      send({
        segments: transcriptSegments.map((segment, index) => ({
          ...segment,
          id: segment.id || `segment-${index}`,
        })),
      });
      return;
    }

    const fs = require("fs");

    (async () => {
      let tmpWav = null;
      try {
        tmpWav = await this.diarizationManager.convertRawPcmToWav(rawPcmPath, 24000);
        const observedSpeakerIds = new Set(
          transcriptSegments
            .filter((segment) => segment.source === "system" && segment.speaker)
            .map((segment) => segment.speaker)
        );
        for (const speakerId of Object.keys(liveSpeakerState || {})) {
          observedSpeakerIds.add(speakerId);
        }

        if (observedSpeakerIds.size > 10) {
          debugLogger.warn("Excessive speaker count from live identification", {
            observedSpeakers: observedSpeakerIds.size,
          });
        }

        const { numSpeakers, cap } = this._resolveSpeakerExpectation({
          sessionConfig,
          noteId,
          observedSpeakerIds,
          diarizedSource,
        });
        let diarizationSegments = await this.diarizationManager.diarize(
          tmpWav,
          numSpeakers > 0 ? { numSpeakers } : {}
        );
        if (cap != null) {
          diarizationSegments = this.diarizationManager.capSpeakerClusters(
            diarizationSegments,
            cap
          );
        }

        const startMs =
          (Number.isFinite(audioStartedAt) && audioStartedAt) ||
          transcriptSegments.find((segment) => segment.source === diarizedSource)?.timestamp ||
          transcriptSegments[0]?.timestamp ||
          0;
        const isEpochMs = startMs > 1e9;
        const normalized = transcriptSegments.map((seg) => ({
          ...seg,
          timestamp:
            seg.timestamp != null
              ? isEpochMs
                ? (seg.timestamp - startMs) / 1000
                : seg.timestamp
              : undefined,
        }));

        const enrichedSegments = this.diarizationManager.mergeWithTranscript(
          normalized,
          diarizationSegments,
          { diarizedSource }
        );

        const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
        const speakerRenumber = new Map();
        let sIdx = 0;
        for (const sp of speakerSet) {
          speakerRenumber.set(sp, `speaker_${sIdx}`);
          sIdx++;
        }

        // Mirrors the mic-mode single-cluster softening in mergeWithTranscript:
        // every segment stays "you", so persisting an embedding keyed to a
        // cluster id that owns no segments would leave the note inconsistent.
        const micSingleClusterSoftened = diarizedSource === "mic" && speakerSet.size === 1;

        let speakerEmbeddingsMap = null;
        const speakerEmb = require("./speakerEmbeddings");
        try {
          if (!micSingleClusterSoftened && speakerEmb.isAvailable() && tmpWav) {
            const speakerIds = [...new Set(diarizationSegments.map((s) => s.speaker))];
            speakerEmbeddingsMap = {};

            for (const spk of speakerIds) {
              const segs = diarizationSegments.filter((s) => s.speaker === spk);
              const sorted = segs.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3);
              const embeddings = [];
              for (const seg of sorted) {
                if (seg.end - seg.start < 1.5) continue;
                const emb = await speakerEmb.extractEmbedding(tmpWav, seg.start, seg.end);
                if (emb) embeddings.push(emb);
              }
              if (embeddings.length > 0) {
                const centroid = speakerEmb.computeCentroid(embeddings);
                const mappedId = speakerRenumber.get(spk) || spk;
                speakerEmbeddingsMap[mappedId] = Array.from(centroid);
              }
            }
          }
        } catch (err) {
          debugLogger.debug("Speaker embedding extraction skipped", { error: err.message });
        }

        const reconciledSpeakers = this._reconcileLiveSpeakerState(
          liveSpeakerState,
          speakerEmbeddingsMap,
          enrichedSegments
        );

        if (speakerEmbeddingsMap) {
          try {
            const profiles = this.databaseManager.getSpeakerProfiles(true);

            if (profiles.length > 0) {
              for (const [mappedId, embArr] of Object.entries(speakerEmbeddingsMap)) {
                const alreadyMapped = enrichedSegments.some(
                  (segment) => segment.speaker === mappedId && segment.speakerName
                );
                if (reconciledSpeakers.has(mappedId) || alreadyMapped) {
                  continue;
                }

                const emb = new Float32Array(embArr);
                let bestProfile = null;
                let bestSim = 0;

                for (const profile of profiles) {
                  const profileEmb = new Float32Array(
                    profile.embedding.buffer,
                    profile.embedding.byteOffset,
                    profile.embedding.byteLength / 4
                  );
                  const sim = speakerEmb.cosineSimilarity(emb, profileEmb);
                  if (sim > bestSim) {
                    bestSim = sim;
                    bestProfile = profile;
                  }
                }

                if (bestProfile && bestSim > 0.6) {
                  for (const seg of enrichedSegments) {
                    if (seg.speaker === mappedId) {
                      applyConfirmedSpeaker(seg, {
                        speakerName: bestProfile.display_name,
                        speakerIsPlaceholder: false,
                        suggestedName: undefined,
                        suggestedProfileId: undefined,
                      });
                    }
                  }
                } else if (bestProfile && bestSim > 0.5) {
                  for (const seg of enrichedSegments) {
                    if (seg.speaker === mappedId) {
                      if (isSpeakerLocked(seg)) {
                        continue;
                      }
                      applySuggestedSpeaker(seg, {
                        suggestedName: bestProfile.display_name,
                        suggestedProfileId: bestProfile.id,
                      });
                    }
                  }
                }
              }
            }
          } catch (err) {
            debugLogger.debug("Auto speaker recognition skipped", { error: err.message });
          }
        }

        send({ segments: enrichedSegments, speakerEmbeddings: speakerEmbeddingsMap });
      } catch (err) {
        debugLogger.warn("Background diarization failed", { error: err.message });
        send({ segments: [] });
      } finally {
        try {
          fs.unlinkSync(rawPcmPath);
        } catch (_) {}
        if (tmpWav) {
          try {
            fs.unlinkSync(tmpWav);
          } catch (_) {}
        }
      }
    })();
  }

  deleteNoteInternal(id) {
    const result = this.databaseManager.deleteNote(id);
    if (result?.success) {
      setImmediate(() => broadcastToWindows("note-deleted", { id }));
      this._asyncMirrorDelete(id);
    }
    return result;
  }
}

module.exports = IPCHandlers;
