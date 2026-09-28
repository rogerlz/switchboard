const { contextBridge, ipcRenderer } = require("electron");

// BYOK API-key bridges, built once instead of hand-listed per key. Sandboxed
// preloads can't require local modules, so the {base, get, save} tuples are
// inlined here; keep them in sync with the BYOK_API_KEYS manifest in
// src/config/secretKeys.js (the main process derives its plumbing from that).
const BYOK_KEY_BRIDGES = [
  { base: "openai", get: "getOpenAIKey", save: "saveOpenAIKey" },
  { base: "gemini", get: "getGeminiKey", save: "saveGeminiKey" },
  { base: "groq", get: "getGroqKey", save: "saveGroqKey" },
  { base: "xai", get: "getXaiKey", save: "saveXaiKey" },
  { base: "mistral", get: "getMistralKey", save: "saveMistralKey" },
  { base: "tinfoil", get: "getTinfoilKey", save: "saveTinfoilKey" },
  { base: "corti", get: "getCortiKey", save: "saveCortiKey" },
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
  setOnboardingWindowMode: (mode) => ipcRenderer.invoke("onboarding-set-window-mode", mode),
  setOnboardingActive: (active) => ipcRenderer.invoke("onboarding-set-active", active),

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
  updateNoteCloudId: (id, cloudId) => ipcRenderer.invoke("db-update-note-cloud-id", id, cloudId),
  updateNoteShareState: (id, state) => ipcRenderer.invoke("db-update-note-share-state", id, state),

  // Folder functions
  getFolders: (spaceId) => ipcRenderer.invoke("db-get-folders", spaceId),
  createFolder: (name, spaceId) => ipcRenderer.invoke("db-create-folder", name, spaceId),
  deleteFolder: (id) => ipcRenderer.invoke("db-delete-folder", id),
  renameFolder: (id, name) => ipcRenderer.invoke("db-rename-folder", id, name),
  moveFolderToSpace: (id, spaceId) => ipcRenderer.invoke("db-move-folder-to-space", id, spaceId),
  getFolderNoteCounts: () => ipcRenderer.invoke("db-get-folder-note-counts"),

  // Space functions
  getSpaces: () => ipcRenderer.invoke("db-get-spaces"),
  setActiveAccountScope: (accountId, expectedAuthGeneration) =>
    ipcRenderer.invoke("set-active-account-scope", accountId, expectedAuthGeneration),
  getActiveAccountScope: () => ipcRenderer.invoke("get-active-account-scope"),
  onActiveAccountScopeChanged: registerListener(
    "active-account-scope-changed",
    (callback) => (_event, scope) => callback(scope)
  ),
  deleteAccountData: (accountId, expectedAuthGeneration) =>
    ipcRenderer.invoke("delete-account-data", accountId, expectedAuthGeneration),
  updateSpace: (id, updates) => ipcRenderer.invoke("db-update-space", id, updates),
  purgeSpace: (id, options) => ipcRenderer.invoke("db-purge-space", id, options),
  upsertSpaceFromCloud: (space) => ipcRenderer.invoke("db-upsert-space-from-cloud", space),
  setSpaceSyncStatus: (id, status) => ipcRenderer.invoke("db-set-space-sync-status", id, status),
  onSpacePurged: (callback) => {
    const listener = (_event, payload) => callback?.(payload);
    ipcRenderer.on("space-purged", listener);
    return () => ipcRenderer.removeListener("space-purged", listener);
  },
  onSpaceSynced: (callback) => {
    const listener = (_event, space) => callback?.(space);
    ipcRenderer.on("space-synced", listener);
    return () => ipcRenderer.removeListener("space-synced", listener);
  },

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
  onNoteSynced: (callback) => {
    const listener = (_event, note) => callback?.(note);
    ipcRenderer.on("note-synced", listener);
    return () => ipcRenderer.removeListener("note-synced", listener);
  },
  onFolderSynced: (callback) => {
    const listener = (_event, folder) => callback?.(folder);
    ipcRenderer.on("folder-synced", listener);
    return () => ipcRenderer.removeListener("folder-synced", listener);
  },
  onFolderDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("folder-deleted", listener);
    return () => ipcRenderer.removeListener("folder-deleted", listener);
  },
  emitSyncEvent: (name, payload) => ipcRenderer.invoke("broadcast-sync-event", name, payload),
  onSyncEvent: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("sync-event", listener);
    return () => ipcRenderer.removeListener("sync-event", listener);
  },

  // BYOK API keys (get/save for every provider in the secretKeys manifest)
  ...secretKeyApi,

  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),

  // Local Whisper functions (whisper.cpp)
  checkWhisperInstallation: () => ipcRenderer.invoke("check-whisper-installation"),
  downloadWhisperModel: (modelName) => ipcRenderer.invoke("download-whisper-model", modelName),
  onWhisperDownloadProgress: registerListener("whisper-download-progress"),
  checkModelStatus: (modelName) => ipcRenderer.invoke("check-model-status", modelName),
  listWhisperModels: () => ipcRenderer.invoke("list-whisper-models"),
  deleteWhisperModel: (modelName) => ipcRenderer.invoke("delete-whisper-model", modelName),
  deleteAllWhisperModels: () => ipcRenderer.invoke("delete-all-whisper-models"),
  cancelWhisperDownload: () => ipcRenderer.invoke("cancel-whisper-download"),
  checkFFmpegAvailability: () => ipcRenderer.invoke("check-ffmpeg-availability"),
  getAudioDiagnostics: () => ipcRenderer.invoke("get-audio-diagnostics"),

  // Whisper server functions (faster repeated transcriptions)
  whisperServerStart: (modelName) => ipcRenderer.invoke("whisper-server-start", modelName),
  whisperServerStop: () => ipcRenderer.invoke("whisper-server-stop"),
  whisperServerStatus: () => ipcRenderer.invoke("whisper-server-status"),
  whisperGpuRetry: () => ipcRenderer.invoke("whisper-gpu-retry"),

  // CUDA GPU acceleration
  listGpus: () => ipcRenderer.invoke("list-gpus"),
  setGpuDeviceIndex: (purpose, uuid) => ipcRenderer.invoke("set-gpu-device-index", purpose, uuid),
  getGpuDeviceIndex: (purpose) => ipcRenderer.invoke("get-gpu-device-index", purpose),
  detectGpu: () => ipcRenderer.invoke("detect-gpu"),
  getCudaWhisperStatus: () => ipcRenderer.invoke("get-cuda-whisper-status"),
  downloadCudaWhisperBinary: () => ipcRenderer.invoke("download-cuda-whisper-binary"),
  cancelCudaWhisperDownload: () => ipcRenderer.invoke("cancel-cuda-whisper-download"),
  deleteCudaWhisperBinary: () => ipcRenderer.invoke("delete-cuda-whisper-binary"),
  onCudaDownloadProgress: registerListener(
    "cuda-download-progress",
    (callback) => (_event, data) => callback(data)
  ),
  onCudaFallbackNotification: registerListener(
    "cuda-fallback-notification",
    (callback) => () => callback()
  ),

  // Vulkan GPU acceleration (whisper on AMD/Intel GPUs)
  getVulkanWhisperStatus: () => ipcRenderer.invoke("get-vulkan-whisper-status"),
  downloadVulkanWhisperBinary: () => ipcRenderer.invoke("download-vulkan-whisper-binary"),
  cancelVulkanWhisperDownload: () => ipcRenderer.invoke("cancel-vulkan-whisper-download"),
  deleteVulkanWhisperBinary: () => ipcRenderer.invoke("delete-vulkan-whisper-binary"),
  onVulkanWhisperDownloadProgress: registerListener(
    "vulkan-whisper-download-progress",
    (callback) => (_event, data) => callback(data)
  ),
  onGpuFallbackNotification: registerListener(
    "gpu-fallback-notification",
    (callback) => () => callback()
  ),

  // One-time "GPU pack needs re-downloading" notice from the legacy-layout migration
  getGpuPackMigrationNotice: () => ipcRenderer.invoke("get-gpu-pack-migration-notice"),
  dismissGpuPackMigrationNotice: () => ipcRenderer.invoke("dismiss-gpu-pack-migration-notice"),

  // Local Parakeet (NVIDIA) functions
  checkParakeetInstallation: () => ipcRenderer.invoke("check-parakeet-installation"),
  downloadParakeetModel: (modelName) => ipcRenderer.invoke("download-parakeet-model", modelName),
  onParakeetDownloadProgress: registerListener("parakeet-download-progress"),
  checkParakeetModelStatus: (modelName) =>
    ipcRenderer.invoke("check-parakeet-model-status", modelName),
  listParakeetModels: () => ipcRenderer.invoke("list-parakeet-models"),
  deleteParakeetModel: (modelName) => ipcRenderer.invoke("delete-parakeet-model", modelName),
  deleteAllParakeetModels: () => ipcRenderer.invoke("delete-all-parakeet-models"),
  cancelParakeetDownload: () => ipcRenderer.invoke("cancel-parakeet-download"),
  getParakeetDiagnostics: () => ipcRenderer.invoke("get-parakeet-diagnostics"),

  // Parakeet server functions (faster repeated transcriptions)
  parakeetServerStart: (modelName) => ipcRenderer.invoke("parakeet-server-start", modelName),
  parakeetServerStop: () => ipcRenderer.invoke("parakeet-server-stop"),
  parakeetServerStatus: () => ipcRenderer.invoke("parakeet-server-status"),

  // Diarization (speaker identification) functions
  downloadDiarizationModels: () => ipcRenderer.invoke("download-diarization-models"),
  getDiarizationModelStatus: () => ipcRenderer.invoke("get-diarization-model-status"),
  deleteDiarizationModels: () => ipcRenderer.invoke("delete-diarization-models"),
  cancelDiarizationDownload: () => ipcRenderer.invoke("cancel-diarization-download"),
  onDiarizationDownloadProgress: registerListener(
    "diarization-download-progress",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingDiarizationComplete: registerListener(
    "meeting-diarization-complete",
    (callback) => (_event, data) => callback(data)
  ),

  // Speaker name mapping
  getSpeakerMappings: (noteId) => ipcRenderer.invoke("get-speaker-mappings", noteId),
  setSpeakerMapping: (noteId, speakerId, displayName, email, profileId) =>
    ipcRenderer.invoke("set-speaker-mapping", noteId, speakerId, displayName, email, profileId),
  removeSpeakerMapping: (noteId, speakerId) =>
    ipcRenderer.invoke("remove-speaker-mapping", noteId, speakerId),
  getSpeakerProfiles: () => ipcRenderer.invoke("get-speaker-profiles"),
  attachSpeakerEmail: (profileId, email) =>
    ipcRenderer.invoke("attach-speaker-email", profileId, email),
  saveNoteSpeakerEmbeddings: (noteId, embeddings) =>
    ipcRenderer.invoke("save-note-speaker-embeddings", noteId, embeddings),

  // Window control functions
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  snapToMeetingMode: () => ipcRenderer.invoke("snap-to-meeting-mode"),
  restoreFromMeetingMode: () => ipcRenderer.invoke("restore-from-meeting-mode"),
  getPlatform: () => process.platform,

  // Cleanup function
  cleanupApp: () => ipcRenderer.invoke("cleanup-app"),
  relaunchApp: () => ipcRenderer.invoke("relaunch-app"),
  startControlPanelDrag: () => ipcRenderer.invoke("start-control-panel-drag"),
  stopControlPanelDrag: () => ipcRenderer.invoke("stop-control-panel-drag"),
  setNotificationInteractivity: (interactive) =>
    ipcRenderer.invoke("set-notification-interactivity", interactive),

  // Update functions
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getPostMigrationState: () => ipcRenderer.invoke("get-post-migration-state"),
  getOAuthProtocolRegistered: () => ipcRenderer.invoke("get-oauth-protocol-registered"),
  getOAuthProtocol: () => ipcRenderer.invoke("get-oauth-protocol"),
  markBundleMigrated: () => ipcRenderer.invoke("mark-bundle-migrated"),
  markBundleMigrationDismissed: () => ipcRenderer.invoke("mark-bundle-migration-dismissed"),
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status"),
  getUpdateInfo: () => ipcRenderer.invoke("get-update-info"),
  setAutoUpdatesEnabled: (enabled) => ipcRenderer.invoke("set-auto-updates-enabled", enabled),

  // Update event listeners
  onUpdateAvailable: registerListener("update-available"),
  onUpdateNotAvailable: registerListener("update-not-available"),
  onUpdateDownloaded: registerListener("update-downloaded"),
  onUpdateDownloadProgress: registerListener("update-download-progress"),
  onUpdateError: registerListener("update-error"),

  // External link opener
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Local transcription model download status (whisper, parakeet)
  modelGetActiveDownloads: () => ipcRenderer.invoke("model-get-active-downloads"),

  getUiLanguage: () => ipcRenderer.invoke("get-ui-language"),
  saveUiLanguage: (language) => ipcRenderer.invoke("save-ui-language", language),
  setUiLanguage: (language) => ipcRenderer.invoke("set-ui-language", language),

  // Corti API
  getCortiClientId: () => ipcRenderer.invoke("get-corti-client-id"),
  saveCortiClientId: (key) => ipcRenderer.invoke("save-corti-client-id", key),
  getCortiClientSecret: () => ipcRenderer.invoke("get-corti-client-secret"),
  saveCortiClientSecret: (key) => ipcRenderer.invoke("save-corti-client-secret", key),

  // Custom endpoint API keys
  getCustomTranscriptionKey: () => ipcRenderer.invoke("get-custom-transcription-key"),
  saveCustomTranscriptionKey: (key) => ipcRenderer.invoke("save-custom-transcription-key", key),

  saveAllKeysToEnv: () => ipcRenderer.invoke("save-all-keys-to-env"),
  syncStartupPreferences: (prefs) => ipcRenderer.invoke("sync-startup-preferences", prefs),

  getManagedEnterpriseConfig: (accountId, workspaceId, expectedAuthGeneration, forceRefresh) =>
    ipcRenderer.invoke(
      "get-managed-enterprise-config",
      accountId,
      workspaceId,
      expectedAuthGeneration,
      forceRefresh
    ),
  onManagedEnterpriseConfigChanged: registerListener(
    "managed-enterprise-config-changed",
    (callback) => (_event, snapshot) => callback(snapshot)
  ),
  clearManagedEnterpriseIdentity: () => ipcRenderer.invoke("clear-managed-enterprise-identity"),

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
  authClearSession: () => ipcRenderer.invoke("auth-clear-session"),
  authGetToken: () => ipcRenderer.invoke("auth-get-token"),
  authGetTokenState: () => ipcRenderer.invoke("auth-get-token-state"),
  authSetToken: (token, expectedGeneration) =>
    ipcRenderer.invoke("auth-set-token", token, expectedGeneration),
  onAuthTokenStateChanged: registerListener(
    "auth-token-state-changed",
    (callback) => (_event, state) => callback(state)
  ),

  // OpenWhispr Cloud API
  cloudHealthCheck: () => ipcRenderer.invoke("cloud-health-check"),
  cloudUsage: () => ipcRenderer.invoke("cloud-usage"),
  cloudCheckout: (opts) => ipcRenderer.invoke("cloud-checkout", opts),
  cloudBillingPortal: () => ipcRenderer.invoke("cloud-billing-portal"),
  cloudSwitchPlan: (opts) => ipcRenderer.invoke("cloud-switch-plan", opts),
  cloudPreviewSwitch: (opts) => ipcRenderer.invoke("cloud-preview-switch", opts),
  cloudApiRequest: (opts) => ipcRenderer.invoke("cloud-api-request", opts),
  getSttConfig: () => ipcRenderer.invoke("get-stt-config"),
  getWorkspacePolicy: (accountId, expectedAuthGeneration) =>
    ipcRenderer.invoke("get-workspace-policy", accountId, expectedAuthGeneration),
  onWorkspacePolicyChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("workspace-policy-changed", listener);
    return () => ipcRenderer.removeListener("workspace-policy-changed", listener);
  },
  getNoteRecordingConfig: () => ipcRenderer.invoke("get-note-recording-config"),

  // Referral stats
  getReferralStats: () => ipcRenderer.invoke("get-referral-stats"),
  sendReferralInvite: (email) => ipcRenderer.invoke("send-referral-invite", email),
  getReferralInvites: () => ipcRenderer.invoke("get-referral-invites"),

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
  onMeetingSystemAudioDegraded: registerListener(
    "meeting-system-audio-degraded",
    (callback) => () => callback()
  ),
  onMeetingSystemAudioInterrupted: registerListener(
    "meeting-system-audio-interrupted",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioResumed: registerListener(
    "meeting-system-audio-resumed",
    (callback) => () => callback()
  ),

  // Workspace invitation deep link
  onWorkspaceInvitationToken: registerListener(
    "workspace-invitation-token",
    (callback) => (_event, token) => callback(token)
  ),
  getPendingInvitationToken: () => ipcRenderer.invoke("get-pending-invitation-token"),

  // Settings shortcut (Cmd+, / Ctrl+,)
  onShowSettings: registerListener("show-settings", (callback) => () => callback()),

  // Start minimized
  notifyStartMinimizedChanged: (enabled) => ipcRenderer.send("start-minimized-changed", enabled),

  // Auto-start management
  getAutoStartEnabled: () => ipcRenderer.invoke("get-auto-start-enabled"),
  setAutoStartEnabled: (enabled) => ipcRenderer.invoke("set-auto-start-enabled", enabled),

  // Sync operations
  getPendingNotes: (spaceKind) => ipcRenderer.invoke("db-get-pending-notes", spaceKind),
  getPendingNoteDeletes: () => ipcRenderer.invoke("db-get-pending-note-deletes"),
  getNoteByClientId: (clientNoteId) => ipcRenderer.invoke("db-get-note-by-client-id", clientNoteId),
  upsertNoteFromCloud: (cloudNote, localFolderId, localSpaceId) =>
    ipcRenderer.invoke("db-upsert-note-from-cloud", cloudNote, localFolderId, localSpaceId),
  acknowledgeNoteCreate: (id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, settleIfUnchanged) =>
    ipcRenderer.invoke(
      "db-acknowledge-note-create",
      id,
      snapshot,
      cloudId,
      cloudUpdatedAt,
      ownerUserId,
      settleIfUnchanged
    ),
  markNoteSyncedIfUnchanged: (id, snapshot, expectedCloudId, cloudUpdatedAt, ownerUserId) =>
    ipcRenderer.invoke(
      "db-mark-note-synced-if-unchanged",
      id,
      snapshot,
      expectedCloudId,
      cloudUpdatedAt,
      ownerUserId
    ),
  setNoteCloudBase: (id, cloudUpdatedAt) =>
    ipcRenderer.invoke("db-set-note-cloud-base", id, cloudUpdatedAt),
  setNoteOwnerFromCloud: (id, ownerUserId) =>
    ipcRenderer.invoke("db-set-note-owner-from-cloud", id, ownerUserId),
  countTeamNotesMissingOwner: () => ipcRenderer.invoke("db-count-team-notes-missing-owner"),
  markNoteSyncError: (id) => ipcRenderer.invoke("db-mark-note-sync-error", id),
  restoreNoteAfterDeniedDelete: (id) =>
    ipcRenderer.invoke("db-restore-note-after-denied-delete", id),
  hardDeleteNote: (id) => ipcRenderer.invoke("db-hard-delete-note", id),

  getPendingFolders: (spaceKind) => ipcRenderer.invoke("db-get-pending-folders", spaceKind),
  getFolderByClientId: (clientFolderId) =>
    ipcRenderer.invoke("db-get-folder-by-client-id", clientFolderId),
  upsertFolderFromCloud: (cloudFolder, localSpaceId) =>
    ipcRenderer.invoke("db-upsert-folder-from-cloud", cloudFolder, localSpaceId),
  acknowledgeFolderCreate: (
    id,
    snapshot,
    expectedCloudId,
    responseClientFolderId,
    cloudId,
    cloudUpdatedAt
  ) =>
    ipcRenderer.invoke(
      "db-acknowledge-folder-create",
      id,
      snapshot,
      expectedCloudId,
      responseClientFolderId,
      cloudId,
      cloudUpdatedAt
    ),
  markFolderSyncedIfUnchanged: (id, snapshot, expectedCloudId) =>
    ipcRenderer.invoke("db-mark-folder-synced-if-unchanged", id, snapshot, expectedCloudId),
  getFolderIdMap: () => ipcRenderer.invoke("db-get-folder-id-map"),
  getPendingFolderDeletes: () => ipcRenderer.invoke("db-get-pending-folder-deletes"),
  restoreFolderAfterDeniedDelete: (id) =>
    ipcRenderer.invoke("db-restore-folder-after-denied-delete", id),
  hardDeleteFolder: (id) => ipcRenderer.invoke("db-hard-delete-folder", id),
  relocateRevokedFolder: (id, privateSpaceId, preserveFolder) =>
    ipcRenderer.invoke("db-relocate-revoked-folder", id, privateSpaceId, preserveFolder),

  // Google Calendar
  gcalStartOAuth: () => ipcRenderer.invoke("gcal-start-oauth"),
  gcalDisconnect: (email) => ipcRenderer.invoke("gcal-disconnect", email),
  gcalGetConnectionStatus: () => ipcRenderer.invoke("gcal-get-connection-status"),
  gcalGetCalendars: () => ipcRenderer.invoke("gcal-get-calendars"),
  gcalSetCalendarSelection: (calendarId, isSelected) =>
    ipcRenderer.invoke("gcal-set-calendar-selection", calendarId, isSelected),
  gcalSetPrimaryOnly: (value) => ipcRenderer.invoke("gcal-set-primary-only", value),
  gcalSyncEvents: () => ipcRenderer.invoke("gcal-sync-events"),
  gcalGetUpcomingEvents: (windowMinutes) =>
    ipcRenderer.invoke("gcal-get-upcoming-events", windowMinutes),
  gcalGetEvent: (eventId) => ipcRenderer.invoke("gcal-get-event", eventId),
  trayCalendarGetEvents: () => ipcRenderer.invoke("tray-calendar-get-events"),

  // Microsoft Calendar
  mcalStartOAuth: () => ipcRenderer.invoke("mcal-start-oauth"),
  mcalDisconnect: (email) => ipcRenderer.invoke("mcal-disconnect", email),
  mcalGetConnectionStatus: () => ipcRenderer.invoke("mcal-get-connection-status"),
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
  getWhisperVadConfig: () => ipcRenderer.invoke("whisper-vad-get-config"),
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
  startManualMeeting: () => ipcRenderer.invoke("start-manual-meeting"),
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
