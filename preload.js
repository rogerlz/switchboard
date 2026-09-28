const { contextBridge, ipcRenderer } = require("electron");

// BYOK API-key bridges, built once instead of hand-listed per key. Sandboxed
// preloads can't require local modules, so the {base, get, save} tuples are
// inlined here; keep them in sync with the BYOK_API_KEYS manifest in
// src/config/secretKeys.js (the main process derives its plumbing from that).
const BYOK_KEY_BRIDGES = [
  { base: "openai", get: "getOpenAIKey", save: "saveOpenAIKey" },
  { base: "tinfoil", get: "getTinfoilKey", save: "saveTinfoilKey" },
  { base: "deepgram", get: "getDeepgramKey", save: "saveDeepgramKey" },
  { base: "assemblyai", get: "getAssemblyAIKey", save: "saveAssemblyAIKey" },
];
const secretKeyApi = {};
for (const k of BYOK_KEY_BRIDGES) {
  secretKeyApi[k.get] = () => ipcRenderer.invoke(`get-${k.base}-key`);
  secretKeyApi[k.save] = (key) => ipcRenderer.invoke(`save-${k.base}-key`, key);
}

/**
 * Helper to register an IPC listener and return a cleanup function.
 * Ensures renderer code can easily remove listeners to avoid leaks.
 */
const registerListener = (channel, handlerFactory) => {
  return (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener =
      typeof handlerFactory === "function"
        ? handlerFactory(callback)
        : (event, ...args) => callback(event, ...args);

    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
};

contextBridge.exposeInMainWorld("electronAPI", {
  controlPanelReady: () => ipcRenderer.invoke("control-panel-ready"),

  // Note functions
  saveNote: (title, content, noteType, sourceFile, audioDuration, folderId, spaceId) =>
    ipcRenderer.invoke(
      "db-save-note",
      title,
      content,
      noteType,
      sourceFile,
      audioDuration,
      folderId,
      spaceId
    ),
  getNote: (id) => ipcRenderer.invoke("db-get-note", id),
  getNotes: (noteType, limit, folderId, spaceId) =>
    ipcRenderer.invoke("db-get-notes", noteType, limit, folderId, spaceId),
  getSpaceNotes: (spaceId, limit) => ipcRenderer.invoke("db-get-space-notes", spaceId, limit),
  updateNote: (id, updates) => ipcRenderer.invoke("db-update-note", id, updates),
  deleteNote: (id) => ipcRenderer.invoke("db-delete-note", id),
  exportNote: (noteId, format) => ipcRenderer.invoke("export-note", noteId, format),
  exportTranscript: (noteId, format) => ipcRenderer.invoke("export-transcript", noteId, format),
  searchNotes: (query, limit, spaceId, folderId) =>
    ipcRenderer.invoke("db-search-notes", query, limit, spaceId, folderId),

  // Folder functions
  getFolders: (spaceId) => ipcRenderer.invoke("db-get-folders", spaceId),
  createFolder: (name, spaceId) => ipcRenderer.invoke("db-create-folder", name, spaceId),
  deleteFolder: (id) => ipcRenderer.invoke("db-delete-folder", id),
  renameFolder: (id, name) => ipcRenderer.invoke("db-rename-folder", id, name),
  getFolderNoteCounts: () => ipcRenderer.invoke("db-get-folder-note-counts"),

  // Space functions
  getSpaces: () => ipcRenderer.invoke("db-get-spaces"),

  // Note files (markdown mirror) functions
  noteFilesSetEnabled: (enabled, customPath, options) =>
    ipcRenderer.invoke("note-files-set-enabled", enabled, customPath, options),
  noteFilesSetPath: (path) => ipcRenderer.invoke("note-files-set-path", path),
  noteFilesRebuild: () => ipcRenderer.invoke("note-files-rebuild"),
  noteFilesGetDefaultPath: () => ipcRenderer.invoke("note-files-get-default-path"),
  noteFilesPickFolder: () => ipcRenderer.invoke("note-files-pick-folder"),
  granolaImportPickAndPreview: () => ipcRenderer.invoke("granola-import-pick-and-preview"),
  granolaImportRun: () => ipcRenderer.invoke("granola-import-run"),
  showNoteFile: (noteId) => ipcRenderer.invoke("show-note-file", noteId),
  showFolderInExplorer: (folderName) => ipcRenderer.invoke("show-folder-in-explorer", folderName),

  onNoteAdded: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-added", listener);
    return () => ipcRenderer.removeListener("note-added", listener);
  },
  onNoteUpdated: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-updated", listener);
    return () => ipcRenderer.removeListener("note-updated", listener);
  },
  onNoteDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("note-deleted", listener);
    return () => ipcRenderer.removeListener("note-deleted", listener);
  },
  onFolderDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("folder-deleted", listener);
    return () => ipcRenderer.removeListener("folder-deleted", listener);
  },
  // BYOK API keys (get/save for every provider in the secretKeys manifest)
  ...secretKeyApi,

  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),

  downloadWhisperModel: (modelName) => ipcRenderer.invoke("download-whisper-model", modelName),
  onWhisperDownloadProgress: registerListener("whisper-download-progress"),
  listWhisperModels: () => ipcRenderer.invoke("list-whisper-models"),
  deleteWhisperModel: (modelName) => ipcRenderer.invoke("delete-whisper-model", modelName),
  deleteAllWhisperModels: () => ipcRenderer.invoke("delete-all-whisper-models"),
  cancelWhisperDownload: () => ipcRenderer.invoke("cancel-whisper-download"),

  // Local Parakeet (NVIDIA) functions
  checkParakeetInstallation: () => ipcRenderer.invoke("check-parakeet-installation"),
  downloadParakeetModel: (modelName) => ipcRenderer.invoke("download-parakeet-model", modelName),
  onParakeetDownloadProgress: registerListener("parakeet-download-progress"),
  listParakeetModels: () => ipcRenderer.invoke("list-parakeet-models"),
  deleteParakeetModel: (modelName) => ipcRenderer.invoke("delete-parakeet-model", modelName),
  deleteAllParakeetModels: () => ipcRenderer.invoke("delete-all-parakeet-models"),
  cancelParakeetDownload: () => ipcRenderer.invoke("cancel-parakeet-download"),

  onMeetingDiarizationComplete: registerListener(
    "meeting-diarization-complete",
    (callback) => (_event, data) => callback(data)
  ),

  // Speaker name mapping
  getSpeakerMappings: (noteId) => ipcRenderer.invoke("get-speaker-mappings", noteId),
  setSpeakerMapping: (noteId, speakerId, displayName, email, profileId) =>
    ipcRenderer.invoke("set-speaker-mapping", noteId, speakerId, displayName, email, profileId),
  getSpeakerProfiles: () => ipcRenderer.invoke("get-speaker-profiles"),
  attachSpeakerEmail: (profileId, email) =>
    ipcRenderer.invoke("attach-speaker-email", profileId, email),
  saveNoteSpeakerEmbeddings: (noteId, embeddings) =>
    ipcRenderer.invoke("save-note-speaker-embeddings", noteId, embeddings),

  snapToMeetingMode: () => ipcRenderer.invoke("snap-to-meeting-mode"),
  restoreFromMeetingMode: () => ipcRenderer.invoke("restore-from-meeting-mode"),

  // Cleanup function
  cleanupApp: () => ipcRenderer.invoke("cleanup-app"),
  relaunchApp: () => ipcRenderer.invoke("relaunch-app"),
  startControlPanelDrag: () => ipcRenderer.invoke("start-control-panel-drag"),
  stopControlPanelDrag: () => ipcRenderer.invoke("stop-control-panel-drag"),
  setNotificationInteractivity: (interactive) =>
    ipcRenderer.invoke("set-notification-interactivity", interactive),

  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  // External link opener
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Local transcription model download status (whisper, parakeet)
  modelGetActiveDownloads: () => ipcRenderer.invoke("model-get-active-downloads"),

  // Corti API
  getCortiClientId: () => ipcRenderer.invoke("get-corti-client-id"),
  saveCortiClientId: (key) => ipcRenderer.invoke("save-corti-client-id", key),
  getCortiClientSecret: () => ipcRenderer.invoke("get-corti-client-secret"),
  saveCortiClientSecret: (key) => ipcRenderer.invoke("save-corti-client-secret", key),

  saveAllKeysToEnv: () => ipcRenderer.invoke("save-all-keys-to-env"),

  getLogLevel: () => ipcRenderer.invoke("get-log-level"),
  log: (entry) => ipcRenderer.invoke("app-log", entry),

  // Debug logging management
  getDebugState: () => ipcRenderer.invoke("get-debug-state"),
  setDebugLogging: (enabled) => ipcRenderer.invoke("set-debug-logging", enabled),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),

  // System settings helpers for microphone/audio permissions
  requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
  checkMicrophoneAccess: () => ipcRenderer.invoke("check-microphone-access"),
  getSystemDefaultMicrophone: (options) =>
    ipcRenderer.invoke("get-system-default-microphone", options),
  checkSystemAudioAccess: () => ipcRenderer.invoke("check-system-audio-access"),
  requestSystemAudioAccess: () => ipcRenderer.invoke("request-system-audio-access"),
  openMicrophoneSettings: () => ipcRenderer.invoke("open-microphone-settings"),
  openSoundInputSettings: () => ipcRenderer.invoke("open-sound-input-settings"),
  openSystemAudioSettings: () => ipcRenderer.invoke("open-system-audio-settings"),
  openLoginItemsSettings: () => ipcRenderer.invoke("open-login-items-settings"),
  getModelCacheRoot: () => ipcRenderer.invoke("get-model-cache-root"),
  openWhisperModelsFolder: () => ipcRenderer.invoke("open-whisper-models-folder"),
  // Meeting transcription (streaming, dual-channel)
  meetingTranscriptionPrepare: (options) =>
    ipcRenderer.invoke("meeting-transcription-prepare", options),
  meetingTranscriptionStart: (options) =>
    ipcRenderer.invoke("meeting-transcription-start", options),
  meetingTranscriptionSend: (buffer, source) =>
    ipcRenderer.send("meeting-transcription-send", buffer, source),
  meetingTranscriptionSetSystemAudioAvailable: (sessionId, available) =>
    ipcRenderer.invoke("meeting-transcription-set-system-audio-available", sessionId, available),
  meetingTranscriptionStop: (expectedSessionId) =>
    ipcRenderer.invoke("meeting-transcription-stop", expectedSessionId),
  meetingTranscriptionCancel: () => ipcRenderer.invoke("meeting-transcription-cancel"),
  onMeetingTranscriptionSegment: registerListener(
    "meeting-transcription-segment",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakerIdentified: registerListener(
    "meeting-speaker-identified",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakersMerged: registerListener(
    "meeting-speakers-merged",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSessionSpeakerConfigUpdated: registerListener(
    "meeting-session-speaker-config-updated",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionError: registerListener(
    "meeting-transcription-error",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionFatalError: registerListener(
    "meeting-transcription-fatal-error",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioSilent: registerListener(
    "meeting-system-audio-silent",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioInterrupted: registerListener(
    "meeting-system-audio-interrupted",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioResumed: registerListener(
    "meeting-system-audio-resumed",
    (callback) => () => callback()
  ),

  // Settings shortcut (Cmd+, / Ctrl+,)
  onShowSettings: registerListener("show-settings", (callback) => () => callback()),

  // Start minimized
  notifyStartMinimizedChanged: (enabled) => ipcRenderer.send("start-minimized-changed", enabled),

  // Auto-start management
  getAutoStartEnabled: () => ipcRenderer.invoke("get-auto-start-enabled"),
  setAutoStartEnabled: (enabled) => ipcRenderer.invoke("set-auto-start-enabled", enabled),

  // Google Calendar
  gcalStartOAuth: () => ipcRenderer.invoke("gcal-start-oauth"),
  gcalDisconnect: (email) => ipcRenderer.invoke("gcal-disconnect", email),
  gcalSetPrimaryOnly: (value) => ipcRenderer.invoke("gcal-set-primary-only", value),
  gcalGetUpcomingEvents: (windowMinutes) =>
    ipcRenderer.invoke("gcal-get-upcoming-events", windowMinutes),
  gcalGetEvent: (eventId) => ipcRenderer.invoke("gcal-get-event", eventId),
  gcalRespondToEvent: (eventId, response) =>
    ipcRenderer.invoke("gcal-respond-to-event", eventId, response),
  trayCalendarGetEvents: () => ipcRenderer.invoke("tray-calendar-get-events"),

  // Microsoft Calendar
  mcalStartOAuth: () => ipcRenderer.invoke("mcal-start-oauth"),
  mcalDisconnect: (email) => ipcRenderer.invoke("mcal-disconnect", email),
  mcalSetPrimaryOnly: (value) => ipcRenderer.invoke("mcal-set-primary-only", value),

  // Apple Calendar (macOS EventKit)
  acalConnect: () => ipcRenderer.invoke("acal-connect"),
  acalDisconnect: () => ipcRenderer.invoke("acal-disconnect"),
  acalGetConnectionStatus: () => ipcRenderer.invoke("acal-get-connection-status"),
  openCalendarPrivacySettings: () => ipcRenderer.invoke("open-calendar-privacy-settings"),

  // Contacts
  searchContacts: (query) => ipcRenderer.invoke("search-contacts", query),
  upsertContact: (contact) => ipcRenderer.invoke("upsert-contact", contact),
  getMD5Hash: (text) => ipcRenderer.invoke("get-md5-hash", text),

  // Google Calendar event listeners
  onGcalConnectionChanged: registerListener(
    "gcal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onGcalEventsSynced: registerListener(
    "gcal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Microsoft Calendar event listeners
  onMcalConnectionChanged: registerListener(
    "mcal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onMcalEventsSynced: registerListener(
    "mcal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Apple Calendar event listeners
  onAcalConnectionChanged: registerListener(
    "acal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onAcalEventsSynced: registerListener(
    "acal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Meeting detection
  syncNotificationPreferences: (prefs) =>
    ipcRenderer.invoke("sync-notification-preferences", prefs),
  setSpeakerDiarizationEnabled: (enabled) =>
    ipcRenderer.invoke("meeting-set-speaker-diarization-enabled", { enabled }),
  setMeetingSessionSpeakerConfig: (config) =>
    ipcRenderer.invoke("meeting-set-session-speaker-config", config),
  setWhisperVadConfig: (config) => ipcRenderer.invoke("whisper-vad-set-config", config),
  onMeetingNotificationData: registerListener(
    "meeting-notification-data",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingAutoEndRequested: registerListener(
    "meeting-auto-end-requested",
    (callback) => (_event, data) => callback(data)
  ),
  getMeetingNotificationData: () => ipcRenderer.invoke("get-meeting-notification-data"),
  meetingNotificationReady: () => ipcRenderer.invoke("meeting-notification-ready"),
  meetingNotificationRespond: (detectionId, action) =>
    ipcRenderer.invoke("meeting-notification-respond", detectionId, action),
  joinCalendarMeeting: (eventId) => ipcRenderer.invoke("join-calendar-meeting", eventId),
  getPendingMeetingNoteNavigation: () => ipcRenderer.invoke("get-pending-meeting-note-navigation"),
  onMeetingNoteNavigationPending: registerListener(
    "meeting-note-navigation-pending",
    (callback) => () => callback()
  ),
  getPendingNoteNavigation: () => ipcRenderer.invoke("get-pending-note-navigation"),
  onNoteNavigationPending: registerListener(
    "note-navigation-pending",
    (callback) => () => callback()
  ),
});
