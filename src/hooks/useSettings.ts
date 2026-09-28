import React, { createContext, useContext, useEffect, useRef } from "react";
import { useSettingsStore, initializeSettings } from "../stores/settingsStore";
import logger from "../utils/logger";
import type {
  ChineseScriptPreference,
  LocalTranscriptionProvider,
  InferenceMode,
  SelfHostedType,
} from "../types/electron";

export interface TranscriptionSettings {
  uiLanguage: string;
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cohereModel: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  /** When transcription language is Auto, force Chinese output script. See #975. */
  chineseScriptPreference: ChineseScriptPreference;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl?: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;
  assemblyAiStreaming: boolean;
}

export interface MeetingLayoutSettings {
  meetingHotkeyLayoutMode: "side-panel" | "full-width";
}

export interface OnboardingSettings {
  onboardingUseCases: string[];
  onboardingUseCaseNote: string;
  spokenLanguages: string[];
}

export interface MicrophoneSettings {
  microphoneSelectionMode: "system" | "built-in" | "specific";
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  selectedMicDeviceLabel: string;
}

export interface ApiKeySettings {
  openaiApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  xaiApiKey: string;
  mistralApiKey: string;
  cortiClientId: string;
  cortiClientSecret: string;
  cortiApiKey: string;
  tinfoilApiKey: string;
  deepgramApiKey: string;
  assemblyaiApiKey: string;
  customTranscriptionApiKey: string;
}

export interface PrivacySettings {
  cloudBackupEnabled: boolean;
  insightsSyncEnabled: boolean;
  telemetryEnabled: boolean;
  dataRetentionEnabled: boolean;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

function useSettingsInternal() {
  const store = useSettingsStore();

  // One-time initialization: sync API keys, dictation key, activation mode,
  // UI language, and dictionary from the main process / SQLite.
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    initializeSettings().catch((err) => {
      logger.warn(
        "Failed to initialize settings store",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, []);

  // Sync startup pre-warming preferences to main process
  const {
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    cohereModel,
    preferredLanguage,
  } = store;
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    const model =
      localTranscriptionProvider === "nvidia"
        ? parakeetModel
        : localTranscriptionProvider === "cohere"
          ? cohereModel
          : whisperModel;
    window.electronAPI
      .syncStartupPreferences({
        useLocalWhisper,
        localTranscriptionProvider,
        model: model || undefined,
        language: preferredLanguage || undefined,
      })
      .catch((err) =>
        logger.warn(
          "Failed to sync startup preferences",
          { error: (err as Error).message },
          "settings"
        )
      );
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    cohereModel,
    preferredLanguage,
  ]);

  return {
    useLocalWhisper: store.useLocalWhisper,
    whisperModel: store.whisperModel,
    uiLanguage: store.uiLanguage,
    localTranscriptionProvider: store.localTranscriptionProvider,
    parakeetModel: store.parakeetModel,
    cohereModel: store.cohereModel,
    allowOpenAIFallback: store.allowOpenAIFallback,
    allowLocalFallback: store.allowLocalFallback,
    fallbackWhisperModel: store.fallbackWhisperModel,
    preferredLanguage: store.preferredLanguage,
    chineseScriptPreference: store.chineseScriptPreference,
    cloudTranscriptionProvider: store.cloudTranscriptionProvider,
    cloudTranscriptionModel: store.cloudTranscriptionModel,
    cloudTranscriptionBaseUrl: store.cloudTranscriptionBaseUrl,
    cloudTranscriptionMode: store.cloudTranscriptionMode,
    transcriptionMode: store.transcriptionMode,
    remoteTranscriptionType: store.remoteTranscriptionType,
    remoteTranscriptionUrl: store.remoteTranscriptionUrl,
    remoteTranscriptionModel: store.remoteTranscriptionModel,
    assemblyAiStreaming: store.assemblyAiStreaming,
    setAssemblyAiStreaming: store.setAssemblyAiStreaming,
    openaiApiKey: store.openaiApiKey,
    geminiApiKey: store.geminiApiKey,
    groqApiKey: store.groqApiKey,
    xaiApiKey: store.xaiApiKey,
    mistralApiKey: store.mistralApiKey,
    tinfoilApiKey: store.tinfoilApiKey,
    deepgramApiKey: store.deepgramApiKey,
    assemblyaiApiKey: store.assemblyaiApiKey,
    meetingHotkeyLayoutMode: store.meetingHotkeyLayoutMode,
    setMeetingHotkeyLayoutMode: store.setMeetingHotkeyLayoutMode,
    theme: store.theme,
    setUseLocalWhisper: store.setUseLocalWhisper,
    setWhisperModel: store.setWhisperModel,
    setUiLanguage: store.setUiLanguage,
    setLocalTranscriptionProvider: store.setLocalTranscriptionProvider,
    setParakeetModel: store.setParakeetModel,
    setCohereModel: store.setCohereModel,
    setAllowOpenAIFallback: store.setAllowOpenAIFallback,
    setAllowLocalFallback: store.setAllowLocalFallback,
    setFallbackWhisperModel: store.setFallbackWhisperModel,
    setPreferredLanguage: store.setPreferredLanguage,
    setChineseScriptPreference: store.setChineseScriptPreference,
    setCloudTranscriptionProvider: store.setCloudTranscriptionProvider,
    setCloudTranscriptionModel: store.setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl: store.setCloudTranscriptionBaseUrl,
    setCloudTranscriptionMode: store.setCloudTranscriptionMode,
    setTranscriptionMode: store.setTranscriptionMode,
    setRemoteTranscriptionType: store.setRemoteTranscriptionType,
    setRemoteTranscriptionUrl: store.setRemoteTranscriptionUrl,
    setRemoteTranscriptionModel: store.setRemoteTranscriptionModel,
    setOpenaiApiKey: store.setOpenaiApiKey,
    setGeminiApiKey: store.setGeminiApiKey,
    setGroqApiKey: store.setGroqApiKey,
    setMistralApiKey: store.setMistralApiKey,
    customTranscriptionApiKey: store.customTranscriptionApiKey,
    setCustomTranscriptionApiKey: store.setCustomTranscriptionApiKey,
    onboardingUseCases: store.onboardingUseCases,
    setOnboardingUseCases: store.setOnboardingUseCases,
    onboardingUseCaseNote: store.onboardingUseCaseNote,
    setOnboardingUseCaseNote: store.setOnboardingUseCaseNote,
    spokenLanguages: store.spokenLanguages,
    setSpokenLanguages: store.setSpokenLanguages,
    setTheme: store.setTheme,
    notificationsEnabled: store.notificationsEnabled,
    setNotificationsEnabled: store.setNotificationsEnabled,
    notifyMeetingDetection: store.notifyMeetingDetection,
    setNotifyMeetingDetection: store.setNotifyMeetingDetection,
    notifyCalendarReminders: store.notifyCalendarReminders,
    setNotifyCalendarReminders: store.setNotifyCalendarReminders,
    autoUpdatesEnabled: store.autoUpdatesEnabled,
    setAutoUpdatesEnabled: store.setAutoUpdatesEnabled,
    startMinimized: store.startMinimized,
    setStartMinimized: store.setStartMinimized,
    microphoneSelectionMode: store.microphoneSelectionMode,
    preferBuiltInMic: store.preferBuiltInMic,
    selectedMicDeviceId: store.selectedMicDeviceId,
    selectedMicDeviceLabel: store.selectedMicDeviceLabel,
    setMicrophoneSelectionMode: store.setMicrophoneSelectionMode,
    setPreferBuiltInMic: store.setPreferBuiltInMic,
    setSelectedMicDevice: store.setSelectedMicDevice,
    noteFilesEnabled: store.noteFilesEnabled,
    setNoteFilesEnabled: store.setNoteFilesEnabled,
    noteFilesPath: store.noteFilesPath,
    setNoteFilesPath: store.setNoteFilesPath,
    dictationSileroEnabled: store.dictationSileroEnabled,
    setDictationSileroEnabled: store.setDictationSileroEnabled,
    noteRecordingSileroEnabled: store.noteRecordingSileroEnabled,
    setNoteRecordingSileroEnabled: store.setNoteRecordingSileroEnabled,
    meetingSileroEnabled: store.meetingSileroEnabled,
    setMeetingSileroEnabled: store.setMeetingSileroEnabled,
    whisperVadThreshold: store.whisperVadThreshold,
    setWhisperVadThreshold: store.setWhisperVadThreshold,
    whisperVadMinSpeechDurationMs: store.whisperVadMinSpeechDurationMs,
    setWhisperVadMinSpeechDurationMs: store.setWhisperVadMinSpeechDurationMs,
    whisperVadMinSilenceDurationMs: store.whisperVadMinSilenceDurationMs,
    setWhisperVadMinSilenceDurationMs: store.setWhisperVadMinSilenceDurationMs,
    whisperVadMaxSpeechDurationS: store.whisperVadMaxSpeechDurationS,
    setWhisperVadMaxSpeechDurationS: store.setWhisperVadMaxSpeechDurationS,
    whisperVadSpeechPadMs: store.whisperVadSpeechPadMs,
    setWhisperVadSpeechPadMs: store.setWhisperVadSpeechPadMs,
    whisperVadSamplesOverlap: store.whisperVadSamplesOverlap,
    setWhisperVadSamplesOverlap: store.setWhisperVadSamplesOverlap,
    cloudBackupEnabled: store.cloudBackupEnabled,
    setCloudBackupEnabled: store.setCloudBackupEnabled,
    insightsSyncEnabled: store.insightsSyncEnabled,
    setInsightsSyncEnabled: store.setInsightsSyncEnabled,
    telemetryEnabled: store.telemetryEnabled,
    setTelemetryEnabled: store.setTelemetryEnabled,
    dataRetentionEnabled: store.dataRetentionEnabled,
    setDataRetentionEnabled: store.setDataRetentionEnabled,
    updateTranscriptionSettings: store.updateTranscriptionSettings,
    updateApiKeys: store.updateApiKeys,
  };
}

export type SettingsValue = ReturnType<typeof useSettingsInternal>;

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const value = useSettingsInternal();
  return React.createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
