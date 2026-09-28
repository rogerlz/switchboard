import { create } from "zustand";
import { API_ENDPOINTS } from "../config/constants";
import i18n, { normalizeUiLanguage } from "../i18n";
import logger from "../utils/logger";
import whisperVadConstants from "../constants/whisperVad.json";
import type {
  ChineseScriptPreference,
  LocalTranscriptionProvider,
  InferenceMode,
  SelfHostedType,
} from "../types/electron";
import type { CalendarAccount } from "../types/calendar";
import { normalizeChineseScriptPreference } from "../utils/chineseScript";
import modelRegistryData from "../models/modelRegistryData.json";
import { MEETING_STREAMING_PROVIDER_IDS } from "../helpers/meetingTranscriptionRouting";
import {
  getTranscriptionSelection,
  resolveEffectivePolicySelection,
  type PolicyDecisionSnapshot,
  type TranscriptionPolicyContext,
} from "./policyRules";
import { usePolicyStore } from "./policyStore";
import type {
  TranscriptionSettings,
  MeetingLayoutSettings,
  OnboardingSettings,
  MicrophoneSettings,
  ApiKeySettings,
  PrivacySettings,
  ThemeSettings,
} from "../hooks/useSettings";
import type { EnterpriseSetupMode } from "../types/enterpriseIdentity";

// Requires localStorage as well as window: the module-scope migrations below
// dereference the bare localStorage global, and test harnesses import this
// store with partial window stubs that don't define it.
const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

const DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER = "openai";

export const TRANSCRIPTION_POLICY_PROVIDER_IDS = [
  ...modelRegistryData.transcriptionProviders.map((provider) => provider.id),
  "custom",
] as const;

// Managed transcription is Azure-only in this phase.
export const TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS = ["azure"] as const;

const TRANSCRIPTION_POLICY_CATALOG = {
  modes: ["openwhispr", "providers", "local", "self-hosted", "enterprise"] as const,
  byokProviders: TRANSCRIPTION_POLICY_PROVIDER_IDS,
  enterpriseProviders: TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
};

const MEETING_TRANSCRIPTION_POLICY_CATALOG = {
  // Self-hosted realtime is not implemented for Note Recording.
  modes: ["openwhispr", "providers", "local"] as const,
  byokProviders: modelRegistryData.transcriptionProviders
    .filter(
      (provider) =>
        MEETING_STREAMING_PROVIDER_IDS.includes(provider.id) &&
        provider.models.some((model) => model.streaming)
    )
    .map((provider) => provider.id),
};

function transcriptionProviderModels(
  providerId: string,
  context: TranscriptionPolicyContext
): Array<{ id: string; streaming?: boolean }> {
  const models =
    modelRegistryData.transcriptionProviders.find((provider) => provider.id === providerId)
      ?.models ?? [];
  return context === "meeting" ? models.filter((model) => model.streaming) : models;
}

function defaultTranscriptionModel(
  providerId: string,
  context: TranscriptionPolicyContext
): string {
  return transcriptionProviderModels(providerId, context)[0]?.id ?? "whisper-1";
}

function transcriptionModelBelongsToProvider(
  providerId: string,
  modelId: string,
  context: TranscriptionPolicyContext
): boolean {
  if (providerId === "custom") return Boolean(modelId);
  return transcriptionProviderModels(providerId, context).some((model) => model.id === modelId);
}

function canonicalTranscriptionBaseUrl(providerId: string): string | null {
  return (
    modelRegistryData.transcriptionProviders.find((provider) => provider.id === providerId)
      ?.baseUrl ?? null
  );
}

function readString(key: string, fallback: string): string {
  if (!isBrowser) return fallback;
  return localStorage.getItem(key) ?? fallback;
}

// Literal rather than an import from ModelRegistry: ModelRegistry imports this
// store, so importing back would create a require cycle.
const DEFAULT_COHERE_MODEL = "cohere-transcribe-03-2026";

function readLocalProvider(key: string): LocalTranscriptionProvider {
  const stored = readString(key, "whisper");
  return stored === "nvidia" || stored === "cohere" ? stored : "whisper";
}

// Meeting/upload keys defaulted to "whisper" even when never stored, so a
// fresh Parakeet/Cohere install resolved uploads against Whisper `base`.
function readScopedLocalProvider(scopeKey: string): LocalTranscriptionProvider {
  if (isBrowser && localStorage.getItem(scopeKey) === null) {
    return readLocalProvider("localTranscriptionProvider");
  }
  return readLocalProvider(scopeKey);
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  if (fallback === true) return stored !== "false";
  return stored === "true";
}

function readStringArray(key: string, fallback: string[]): string[] {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

type MicrophoneSelectionMode = "system" | "built-in" | "specific";

function migrateMicrophoneSelectionMode() {
  if (!isBrowser) return;
  const current = localStorage.getItem("microphoneSelectionMode");
  if (current === "system" || current === "built-in" || current === "specific") return;

  const selectedDeviceId = localStorage.getItem("selectedMicDeviceId") || "";
  const legacyBuiltIn = localStorage.getItem("preferBuiltInMic");
  const mode: MicrophoneSelectionMode =
    legacyBuiltIn === "true"
      ? "built-in"
      : selectedDeviceId && selectedDeviceId !== "default"
        ? "specific"
        : "system";
  localStorage.setItem("microphoneSelectionMode", mode);
}

migrateMicrophoneSelectionMode();

// Automatic updates default on for new installs only. An install that already
// finished onboarding keeps the manual download-and-install flow until the
// user opts in.
function initializeAutoUpdatesDefault() {
  if (!isBrowser || localStorage.getItem("autoUpdatesEnabled") !== null) return;
  const isExistingInstall = localStorage.getItem("onboardingCompleted") === "true";
  localStorage.setItem("autoUpdatesEnabled", String(!isExistingInstall));
}

initializeAutoUpdatesDefault();

const BOOLEAN_SETTINGS = new Set([
  "useLocalWhisper",
  "meetingUseLocalWhisper",
  "allowOpenAIFallback",
  "allowLocalFallback",
  "assemblyAiStreaming",
  "preferBuiltInMic",
  "cloudBackupEnabled",
  "insightsSyncEnabled",
  "telemetryEnabled",
  "startMinimized",
  "meetingProcessDetection",
  "speakerDiarizationEnabled",
  "dictationSileroEnabled",
  "noteRecordingSileroEnabled",
  "meetingSileroEnabled",
  "isSignedIn",
  "dataRetentionEnabled",
  "noteFilesEnabled",
  "notificationsEnabled",
  "notifyMeetingDetection",
  "notifyCalendarReminders",
  "autoUpdatesEnabled",
  "gcalPrimaryOnly",
  "mcalPrimaryOnly",
  "appleCalendarConnected",
]);

const ARRAY_SETTINGS = new Set([
  "gcalAccounts",
  "mcalAccounts",
  "onboardingUseCases",
  "spokenLanguages",
]);

const NUMERIC_SETTINGS = new Set([
  "whisperVadThreshold",
  "whisperVadMinSpeechDurationMs",
  "whisperVadMinSilenceDurationMs",
  "whisperVadMaxSpeechDurationS",
  "whisperVadSpeechPadMs",
  "whisperVadSamplesOverlap",
]);

const WHISPER_VAD_DEFAULTS = whisperVadConstants.DEFAULTS;
const WHISPER_VAD_LIMITS = whisperVadConstants.LIMITS;

type WhisperVadKey = keyof typeof WHISPER_VAD_DEFAULTS;

const clampVadValue = (key: WhisperVadKey, raw: unknown): number => {
  const fallback = WHISPER_VAD_DEFAULTS[key];
  const n = raw === null || raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = WHISPER_VAD_LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
};

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };

function migratePreferredLanguage() {
  if (!isBrowser) return;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

migratePreferredLanguage();

// Map the underlying transcription fields to the InferenceMode the Settings
// tabs select on. Single source of truth shared by the provider-settings
// migration and the onboarding "use this provider everywhere" action.
function deriveTranscriptionMode(
  useLocalWhisper: boolean,
  cloudTranscriptionMode: string | null,
  cloudTranscriptionProvider: string | null
): InferenceMode {
  if (useLocalWhisper) return "local";
  if (cloudTranscriptionMode === "byok") {
    return cloudTranscriptionProvider === "custom" ? "self-hosted" : "providers";
  }
  return "local"; // fork: no OpenWhispr cloud
}

function migrateProviderSettings() {
  if (!isBrowser) return;
  if (localStorage.getItem("_providerSettingsMigrated") === "1") return;

  const cloudMode = localStorage.getItem("cloudTranscriptionMode");
  const useLocal = localStorage.getItem("useLocalWhisper") === "true";
  const provider = localStorage.getItem("cloudTranscriptionProvider");

  const transcriptionMode = deriveTranscriptionMode(useLocal, cloudMode, provider);
  localStorage.setItem("transcriptionMode", transcriptionMode);

  if (provider === "custom" && cloudMode === "byok") {
    localStorage.setItem("remoteTranscriptionType", "openai-compatible");
    const legacyBaseUrl = localStorage.getItem("cloudTranscriptionBaseUrl");
    const existingRemoteUrl = localStorage.getItem("remoteTranscriptionUrl");
    if (!existingRemoteUrl && legacyBaseUrl && legacyBaseUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE) {
      localStorage.setItem("remoteTranscriptionUrl", legacyBaseUrl);
    }
  }

  localStorage.setItem("_providerSettingsMigrated", "1");
}

migrateProviderSettings();

// One-time migration for legacy `meetingFollows{Transcription,Reasoning}` flags.
// When the flag was true (the default), meeting/note recordings inherited the
// main dictation/intelligence settings. We've removed the toggle; copy the
// effective values into the dedicated meeting fields so post-migration reads
// (which always go through meeting fields) preserve every existing user's
// behavior. After migration the flag stays at "false" as a marker so this
// never runs again. Safe to delete after a few releases.
const MEETING_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["useLocalWhisper", "meetingUseLocalWhisper"],
  ["whisperModel", "meetingWhisperModel"],
  ["localTranscriptionProvider", "meetingLocalTranscriptionProvider"],
  ["parakeetModel", "meetingParakeetModel"],
  ["cohereModel", "meetingCohereModel"],
  ["cloudTranscriptionProvider", "meetingCloudTranscriptionProvider"],
  ["cloudTranscriptionModel", "meetingCloudTranscriptionModel"],
  ["cloudTranscriptionBaseUrl", "meetingCloudTranscriptionBaseUrl"],
  ["cloudTranscriptionMode", "meetingCloudTranscriptionMode"],
  ["transcriptionMode", "meetingTranscriptionMode"],
  ["remoteTranscriptionType", "meetingRemoteTranscriptionType"],
  ["remoteTranscriptionUrl", "meetingRemoteTranscriptionUrl"],
];
function migrateMeetingFollowFlags() {
  if (!isBrowser) return;
  for (const [flag, pairs] of [
    ["meetingFollowsTranscription", MEETING_TRANSCRIPTION_PAIRS],
  ] as const) {
    if (localStorage.getItem(flag) === "false") continue;
    for (const [src, dst] of pairs) {
      const v = localStorage.getItem(src);
      if (v !== null) localStorage.setItem(dst, v);
    }
    localStorage.setItem(flag, "false");
  }
}

// Runs after migrateProviderSettings() so the mode keys it derives and persists
// (`transcriptionMode`, the `remote*` keys) exist to be copied.
// Before 1.10.0 it ran first, skipped those pairs, and latched — see
// healSkippedMeetingFollowModes() for the profiles that already did.
migrateMeetingFollowFlags();

// Dictation renders `transcriptionMode` in its picker but routes on
// `useLocalWhisper` and `cloudTranscriptionMode` (the `isOpenWhisprCloud` test),
// so routing can disagree with what the user sees (#2086).
//
// Note Recording is excluded: resolveMeetingTranscriptionOptions branches on
// `meetingTranscriptionMode`, the key MeetingSettings renders, so it cannot
// disagree, and no router reads `meetingUseLocalWhisper`.
//
// Never complete either rule symmetrically — it would start uploading audio from
// profiles that exist: the mode-less Settings toggle wrote the local flag alone
// until 6fb0c906, and ProviderSetupStep writes `cloudTranscriptionMode` before the
// commit that derives the mode.
const TRANSCRIPTION_ROUTING_KEYS: ReadonlyArray<{
  mode: keyof SettingsState;
  useLocal: keyof SettingsState;
  cloudMode: keyof SettingsState;
}> = [
  { mode: "transcriptionMode", useLocal: "useLocalWhisper", cloudMode: "cloudTranscriptionMode" },
];

function reconcileTranscriptionRouting(): void {
  if (!isBrowser) return;
  const repaired: string[] = [];
  for (const keys of TRANSCRIPTION_ROUTING_KEYS) {
    const mode = localStorage.getItem(keys.mode);
    if (mode === "local" && localStorage.getItem(keys.useLocal) !== "true") {
      localStorage.setItem(keys.useLocal, "true");
      repaired.push(keys.useLocal);
    }
    // Stored value, not the upload resolver's inherited one: these modes are only
    // derivable when the scope's own cloud key is set, so unset is not a desync.
    if (
      (mode === "providers" || mode === "self-hosted") &&
      localStorage.getItem(keys.cloudMode) === "openwhispr"
    ) {
      localStorage.setItem(keys.cloudMode, "byok");
      repaired.push(keys.cloudMode);
    }
  }
  if (repaired.length === 0) return;

  logger.info(
    "Repaired transcription routing that disagreed with the selected mode",
    { keys: repaired },
    "settings"
  );
}

reconcileTranscriptionRouting();

// Builds before 1.10.0 ran migrateMeetingFollowFlags() before
// migrateProviderSettings() had created `transcriptionMode`, so a profile
// upgrading straight from ≤1.6.7 copied every Note Recording key except the
// mode and then latched the follow flag. `meetingTranscriptionMode` has no
// fallback: selectResolvedMeetingTranscription passes it straight through, so
// it is reconstructed from the snapshot the copy did write — with the same
// function migrateProviderSettings() uses, not from today's dictation keys,
// which the user may have changed since. Idempotent — writing a mode retires
// its own guard — and it never touches `meetingUseLocalWhisper`, which no
// router reads but which rule two below depends on.
function healSkippedMeetingFollowModes(): Record<string, InferenceMode> {
  if (!isBrowser) return {};
  const healed: Record<string, InferenceMode> = {};

  const meetingUseLocal = localStorage.getItem("meetingUseLocalWhisper");
  const meetingCloudMode = localStorage.getItem("meetingCloudTranscriptionMode");
  if (
    localStorage.getItem("meetingTranscriptionMode") === null &&
    (meetingUseLocal !== null || meetingCloudMode !== null)
  ) {
    const mode = deriveTranscriptionMode(
      meetingUseLocal === "true",
      meetingCloudMode,
      localStorage.getItem("meetingCloudTranscriptionProvider")
    );
    localStorage.setItem("meetingTranscriptionMode", mode);
    healed.meetingTranscriptionMode = mode;
  }

  // v1.6.8–v1.6.9's since-removed mode-less toggle wrote `useLocalWhisper` alone,
  // so a deliberate Local choice could sit under a stale cloud mode; v1.6.10's
  // wholesale copy carried both into Note Recording, where the mode is what
  // routes. The UI writes the flag as `mode === "local"`, so this pair can only
  // be that copy. Follow the flag — local-ward only.
  const meetingMode = localStorage.getItem("meetingTranscriptionMode");
  if (meetingUseLocal === "true" && meetingMode !== null && meetingMode !== "local") {
    localStorage.setItem("meetingTranscriptionMode", "local");
    healed.meetingTranscriptionMode = "local";
  }

  return healed;
}

const healedMeetingFollowModes = healSkippedMeetingFollowModes();
if (Object.keys(healedMeetingFollowModes).length > 0) {
  logger.info(
    "Re-derived Note Recording modes the follow-flag migration had skipped",
    healedMeetingFollowModes,
    "settings"
  );
}

export interface SettingsState
  extends
    TranscriptionSettings,
    MeetingLayoutSettings,
    OnboardingSettings,
    MicrophoneSettings,
    ApiKeySettings,
    PrivacySettings,
    ThemeSettings {
  isSignedIn: boolean;
  startMinimized: boolean;
  gcalAccounts: CalendarAccount[];
  gcalConnected: boolean;
  gcalEmail: string;
  mcalAccounts: CalendarAccount[];
  mcalConnected: boolean;
  notificationsEnabled: boolean;
  notifyMeetingDetection: boolean;
  notifyCalendarReminders: boolean;
  autoUpdatesEnabled: boolean;
  gcalPrimaryOnly: boolean;
  mcalPrimaryOnly: boolean;
  appleCalendarConnected: boolean;
  meetingProcessDetection: boolean;
  speakerDiarizationEnabled: boolean;
  dictationSileroEnabled: boolean;
  noteRecordingSileroEnabled: boolean;
  meetingSileroEnabled: boolean;
  whisperVadThreshold: number;
  whisperVadMinSpeechDurationMs: number;
  whisperVadMinSilenceDurationMs: number;
  whisperVadMaxSpeechDurationS: number;
  whisperVadSpeechPadMs: number;
  whisperVadSamplesOverlap: number;
  noteFilesEnabled: boolean;
  noteFilesPath: string;

  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;

  meetingTranscriptionMode: InferenceMode;
  meetingUseLocalWhisper: boolean;
  meetingWhisperModel: string;
  meetingLocalTranscriptionProvider: LocalTranscriptionProvider;
  meetingParakeetModel: string;
  meetingCohereModel: string;
  meetingCloudTranscriptionProvider: string;
  meetingCloudTranscriptionModel: string;
  meetingCloudTranscriptionBaseUrl: string;
  meetingCloudTranscriptionMode: string;
  meetingRemoteTranscriptionType: SelfHostedType;
  meetingRemoteTranscriptionUrl: string;

  /** Last model used per scope+provider (`"<context>:<providerId>"`), so switching providers restores it. */
  transcriptionModelByProvider: Record<string, string>;

  setTranscriptionMode: (mode: InferenceMode) => void;
  setRemoteTranscriptionType: (type: SelfHostedType) => void;
  setRemoteTranscriptionUrl: (url: string) => void;
  setRemoteTranscriptionModel: (model: string) => void;

  setMeetingTranscriptionMode: (mode: InferenceMode) => void;
  setMeetingUseLocalWhisper: (value: boolean) => void;
  setMeetingWhisperModel: (value: string) => void;
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setMeetingParakeetModel: (value: string) => void;
  setMeetingCohereModel: (value: string) => void;
  setMeetingCloudTranscriptionProvider: (value: string) => void;
  setMeetingCloudTranscriptionModel: (value: string) => void;
  setMeetingCloudTranscriptionBaseUrl: (value: string) => void;
  setMeetingCloudTranscriptionMode: (value: string) => void;
  setMeetingRemoteTranscriptionType: (type: SelfHostedType) => void;
  setMeetingRemoteTranscriptionUrl: (url: string) => void;

  setUseLocalWhisper: (value: boolean) => void;
  setWhisperModel: (value: string) => void;
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setParakeetModel: (value: string) => void;
  setCohereModel: (value: string) => void;
  setAllowOpenAIFallback: (value: boolean) => void;
  setAllowLocalFallback: (value: boolean) => void;
  setFallbackWhisperModel: (value: string) => void;
  setPreferredLanguage: (value: string) => void;
  setChineseScriptPreference: (value: ChineseScriptPreference) => void;
  setCloudTranscriptionProvider: (value: string) => void;
  setCloudTranscriptionModel: (value: string) => void;
  setCloudTranscriptionBaseUrl: (value: string) => void;
  setCloudTranscriptionMode: (value: string) => void;
  switchCloudTranscriptionProvider: (
    context: TranscriptionPolicyContext,
    providerId: string
  ) => void;
  setAssemblyAiStreaming: (value: boolean) => void;
  setUiLanguage: (language: string) => void;

  setOpenaiApiKey: (key: string) => void;
  setGeminiApiKey: (key: string) => void;
  setGroqApiKey: (key: string) => void;
  setXaiApiKey: (key: string) => void;
  setMistralApiKey: (key: string) => void;
  setCortiClientId: (key: string) => void;
  setCortiClientSecret: (key: string) => void;
  setCortiApiKey: (key: string) => void;
  setTinfoilApiKey: (key: string) => void;
  setDeepgramApiKey: (key: string) => void;
  setAssemblyaiApiKey: (key: string) => void;
  setCustomTranscriptionApiKey: (key: string) => void;

  // Corti (BYOK)
  cortiEnvironment: string;
  cortiTenant: string;
  setCortiEnvironment: (value: string) => void;
  setCortiTenant: (value: string) => void;

  // Enterprise managed transcription
  enterpriseTranscriptionSetupMode: EnterpriseSetupMode;
  setEnterpriseTranscriptionSetupMode: (value: EnterpriseSetupMode) => void;

  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => void;
  setOnboardingUseCases: (useCases: string[]) => void;
  setOnboardingUseCaseNote: (note: string) => void;
  setSpokenLanguages: (languages: string[]) => void;

  setPreferBuiltInMic: (value: boolean) => void;
  setMicrophoneSelectionMode: (mode: MicrophoneSelectionMode) => void;
  setSelectedMicDevice: (deviceId: string, label: string) => void;

  setTheme: (value: "light" | "dark" | "auto") => void;
  setCloudBackupEnabled: (value: boolean) => void;
  setInsightsSyncEnabled: (value: boolean) => void;
  setTelemetryEnabled: (value: boolean) => void;
  setDataRetentionEnabled: (value: boolean) => void;
  setStartMinimized: (enabled: boolean) => void;
  setGcalAccounts: (accounts: CalendarAccount[]) => void;
  setMcalAccounts: (accounts: CalendarAccount[]) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setNotifyMeetingDetection: (value: boolean) => void;
  setNotifyCalendarReminders: (value: boolean) => void;
  setAutoUpdatesEnabled: (enabled: boolean) => void;
  setGcalPrimaryOnly: (value: boolean) => void;
  setMcalPrimaryOnly: (value: boolean) => void;
  setAppleCalendarConnected: (value: boolean) => void;
  setMeetingProcessDetection: (value: boolean) => void;
  setSpeakerDiarizationEnabled: (value: boolean) => void;
  setDictationSileroEnabled: (value: boolean) => void;
  setNoteRecordingSileroEnabled: (value: boolean) => void;
  setMeetingSileroEnabled: (value: boolean) => void;
  setWhisperVadThreshold: (value: number) => void;
  setWhisperVadMinSpeechDurationMs: (value: number) => void;
  setWhisperVadMinSilenceDurationMs: (value: number) => void;
  setWhisperVadMaxSpeechDurationS: (value: number) => void;
  setWhisperVadSpeechPadMs: (value: number) => void;
  setWhisperVadSamplesOverlap: (value: number) => void;
  setNoteFilesEnabled: (value: boolean) => void;
  setNoteFilesPath: (value: string) => void;
  setIsSignedIn: (value: boolean) => void;

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => void;
  setCloudTranscriptionForAllScopes: (settings: Partial<TranscriptionSettings>) => void;
  updateApiKeys: (keys: Partial<ApiKeySettings>) => void;
}

function createStringSetter(key: string) {
  return (value: string) => {
    if (isBrowser) localStorage.setItem(key, value);
    useSettingsStore.setState({ [key]: value });
  };
}

function persistTranscriptionModelMemory(memory: Record<string, string>) {
  if (isBrowser) localStorage.setItem("transcriptionModelByProvider", JSON.stringify(memory));
  useSettingsStore.setState({ transcriptionModelByProvider: memory });
}

function readModelMemory(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readString(key, "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** Writes a string setting whose key is computed rather than known up front. */
export function setStringSetting(key: keyof SettingsState, value: string): void {
  createStringSetter(key)(value);
}

function createBooleanSetter(key: string) {
  return (value: boolean) => {
    if (isBrowser) localStorage.setItem(key, String(value));
    useSettingsStore.setState({ [key]: value });
  };
}

let envPersistTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedPersistToEnv() {
  if (!isBrowser) return;
  if (envPersistTimer) clearTimeout(envPersistTimer);
  envPersistTimer = setTimeout(() => {
    window.electronAPI?.saveAllKeysToEnv?.().catch((err) => {
      logger.warn(
        "Failed to persist API keys to .env",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, 1000);
}

const SECRET_IPC_SAVERS = {
  openai: "saveOpenAIKey",
  gemini: "saveGeminiKey",
  groq: "saveGroqKey",
  xai: "saveXaiKey",
  mistral: "saveMistralKey",
  cortiClientId: "saveCortiClientId",
  cortiClientSecret: "saveCortiClientSecret",
  cortiApiKey: "saveCortiKey",
  tinfoil: "saveTinfoilKey",
  deepgram: "saveDeepgramKey",
  assemblyai: "saveAssemblyAIKey",
  customTranscription: "saveCustomTranscriptionKey",
} as const;

type SecretProvider = keyof typeof SECRET_IPC_SAVERS;

const secretSaveTimers: Partial<Record<SecretProvider, ReturnType<typeof setTimeout>>> = {};
function debouncedSaveSecret(provider: SecretProvider, key: string) {
  if (!isBrowser) return;
  const timer = secretSaveTimers[provider];
  if (timer) clearTimeout(timer);
  secretSaveTimers[provider] = setTimeout(() => {
    const api = window.electronAPI;
    const save = api?.[SECRET_IPC_SAVERS[provider]] as
      ((k: string) => Promise<unknown>) | undefined;
    save?.(key)?.catch((err) => {
      logger.warn(
        "Failed to persist secret",
        { provider, error: (err as Error).message },
        "settings"
      );
    });
  }, 250);
}

const STALE_SECRET_LOCALSTORAGE_KEYS = [
  "openaiApiKey",
  "anthropicApiKey",
  "geminiApiKey",
  "groqApiKey",
  "xaiApiKey",
  "mistralApiKey",
  "openrouterApiKey",
  "cortiClientId",
  "cortiClientSecret",
  "cortiApiKey",
  "tinfoilApiKey",
  "deepgramApiKey",
  "assemblyaiApiKey",
  "customTranscriptionApiKey",
  "customReasoningApiKey",
  "cleanupCustomApiKey",
  "noteFormattingCustomApiKey",
  "translationCustomApiKey",
  "dictationAgentCustomApiKey",
  "dictationAgentVisionCustomApiKey",
  "chatAgentCustomApiKey",
  "bedrockAccessKeyId",
  "bedrockSecretAccessKey",
  "bedrockSessionToken",
  "azureApiKey",
  "vertexApiKey",
] as const;

function invalidateApiKeyCaches() {
  if (isBrowser) window.dispatchEvent(new Event("api-key-changed"));
  debouncedPersistToEnv();
}

// Uniform BYOK key setter: persist to the secure store (debounced).
function createSecretSetter(storeKey: string, saver: SecretProvider) {
  return (key: string) => {
    useSettingsStore.setState({ [storeKey]: key });
    debouncedSaveSecret(saver, key);
    invalidateApiKeyCaches();
  };
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  uiLanguage: normalizeUiLanguage(
    isBrowser ? localStorage.getItem("uiLanguage") || i18n.language : null
  ),
  useLocalWhisper: readBoolean("useLocalWhisper", false),
  whisperModel: readString("whisperModel", "base"),
  localTranscriptionProvider: readLocalProvider("localTranscriptionProvider"),
  parakeetModel: readString("parakeetModel", ""),
  cohereModel: readString("cohereModel", DEFAULT_COHERE_MODEL),
  allowOpenAIFallback: readBoolean("allowOpenAIFallback", false),
  allowLocalFallback: readBoolean("allowLocalFallback", false),
  fallbackWhisperModel: readString("fallbackWhisperModel", "base"),
  preferredLanguage: readString("preferredLanguage", "auto"),
  chineseScriptPreference: normalizeChineseScriptPreference(
    readString("chineseScriptPreference", "as-transcribed")
  ),
  cloudTranscriptionProvider: readString(
    "cloudTranscriptionProvider",
    DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER
  ),
  cloudTranscriptionModel: readString("cloudTranscriptionModel", "gpt-4o-mini-transcribe"),
  cloudTranscriptionBaseUrl: readString(
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE
  ),
  transcriptionModelByProvider: readModelMemory("transcriptionModelByProvider"),
  // Secrets aren't hydrated yet at construction; the BYOK default is set
  // post-hydration in initializeSettings.
  cloudTranscriptionMode: readString("cloudTranscriptionMode", "local"),
  cortiEnvironment: readString("cortiEnvironment", "us"),
  cortiTenant: readString("cortiTenant", "base"),
  assemblyAiStreaming: readBoolean("assemblyAiStreaming", true),

  // Secrets hydrate from main process in initializeSettings, never from localStorage.
  openaiApiKey: "",
  geminiApiKey: "",
  groqApiKey: "",
  xaiApiKey: "",
  mistralApiKey: "",
  cortiClientId: "",
  cortiClientSecret: "",
  cortiApiKey: "",
  tinfoilApiKey: "",
  deepgramApiKey: "",
  assemblyaiApiKey: "",
  customTranscriptionApiKey: "",

  // Enterprise managed transcription
  enterpriseTranscriptionSetupMode: (() => {
    const v = readString("enterpriseTranscriptionSetupMode", "auto");
    if (v === "auto" || v === "managed" || v === "manual") return v;
    return "auto" as EnterpriseSetupMode;
  })(),
  onboardingUseCases: readStringArray("onboardingUseCases", []),
  onboardingUseCaseNote: readString("onboardingUseCaseNote", ""),
  spokenLanguages: readStringArray("spokenLanguages", []),
  meetingHotkeyLayoutMode: (readString("meetingHotkeyLayoutMode", "full-width") === "side-panel"
    ? "side-panel"
    : "full-width") as "side-panel" | "full-width",

  microphoneSelectionMode: (() => {
    const mode = readString("microphoneSelectionMode", "system");
    return (
      mode === "built-in" || mode === "specific" ? mode : "system"
    ) as MicrophoneSelectionMode;
  })(),
  preferBuiltInMic: readBoolean("preferBuiltInMic", false),
  selectedMicDeviceId: readString("selectedMicDeviceId", ""),
  selectedMicDeviceLabel: readString("selectedMicDeviceLabel", ""),

  theme: (() => {
    const v = readString("theme", "auto");
    if (v === "light" || v === "dark" || v === "auto") return v;
    return "auto" as const;
  })(),
  cloudBackupEnabled: readBoolean("cloudBackupEnabled", false),
  insightsSyncEnabled: readBoolean("insightsSyncEnabled", false),
  telemetryEnabled: readBoolean("telemetryEnabled", false),
  dataRetentionEnabled: readBoolean("dataRetentionEnabled", true),
  startMinimized: readBoolean("startMinimized", false),
  notificationsEnabled: readBoolean("notificationsEnabled", true),
  notifyMeetingDetection: readBoolean("notifyMeetingDetection", true),
  notifyCalendarReminders: readBoolean("notifyCalendarReminders", true),
  autoUpdatesEnabled: readBoolean("autoUpdatesEnabled", true),
  ...(() => {
    let accounts: CalendarAccount[] = [];
    try {
      const parsed = JSON.parse(readString("gcalAccounts", "[]"));
      if (Array.isArray(parsed)) accounts = parsed;
    } catch {
      /* use empty default */
    }
    return {
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    };
  })(),
  ...(() => {
    let accounts: CalendarAccount[] = [];
    try {
      const parsed = JSON.parse(readString("mcalAccounts", "[]"));
      if (Array.isArray(parsed)) accounts = parsed;
    } catch {
      /* use empty default */
    }
    return {
      mcalAccounts: accounts,
      mcalConnected: accounts.length > 0,
    };
  })(),
  gcalPrimaryOnly: readBoolean("gcalPrimaryOnly", true),
  mcalPrimaryOnly: readBoolean("mcalPrimaryOnly", true),
  appleCalendarConnected: readBoolean("appleCalendarConnected", false),
  meetingProcessDetection: readBoolean("meetingProcessDetection", true),
  speakerDiarizationEnabled: readBoolean("speakerDiarizationEnabled", true),
  // Off by default: VAD on pause-heavy dictations can strip the speech and make
  // Whisper hallucinate the dictionary prompt as the transcript (#1454).
  dictationSileroEnabled: readBoolean("dictationSileroEnabled", false),
  noteRecordingSileroEnabled: readBoolean("noteRecordingSileroEnabled", true),
  meetingSileroEnabled: readBoolean("meetingSileroEnabled", true),
  whisperVadThreshold: clampVadValue("threshold", readString("whisperVadThreshold", "0.5")),
  whisperVadMinSpeechDurationMs: clampVadValue(
    "minSpeechDurationMs",
    readString("whisperVadMinSpeechDurationMs", "250")
  ),
  whisperVadMinSilenceDurationMs: clampVadValue(
    "minSilenceDurationMs",
    readString("whisperVadMinSilenceDurationMs", "200")
  ),
  whisperVadMaxSpeechDurationS: clampVadValue(
    "maxSpeechDurationS",
    readString("whisperVadMaxSpeechDurationS", "30")
  ),
  whisperVadSpeechPadMs: clampVadValue("speechPadMs", readString("whisperVadSpeechPadMs", "100")),
  whisperVadSamplesOverlap: clampVadValue(
    "samplesOverlap",
    readString("whisperVadSamplesOverlap", "0.5")
  ),
  noteFilesEnabled: readBoolean("noteFilesEnabled", false),
  noteFilesPath: readString("noteFilesPath", ""),
  isSignedIn: readBoolean("isSignedIn", false),

  transcriptionMode: (() => {
    const v = readString("transcriptionMode", "local");
    if (v === "providers" || v === "local" || v === "self-hosted") return v;
    return "local" as InferenceMode;
  })(),
  remoteTranscriptionType: (() => {
    const v = readString("remoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  remoteTranscriptionUrl: readString("remoteTranscriptionUrl", ""),
  remoteTranscriptionModel: readString("remoteTranscriptionModel", ""),
  meetingTranscriptionMode: (() => {
    const v = readString("meetingTranscriptionMode", "local");
    if (v === "providers" || v === "local" || v === "self-hosted") return v;
    return "local" as InferenceMode;
  })(),
  meetingUseLocalWhisper: readBoolean("meetingUseLocalWhisper", false),
  meetingWhisperModel: readString("meetingWhisperModel", ""),
  meetingLocalTranscriptionProvider: readScopedLocalProvider("meetingLocalTranscriptionProvider"),
  meetingParakeetModel: readString("meetingParakeetModel", ""),
  meetingCohereModel: readString("meetingCohereModel", ""),
  meetingCloudTranscriptionProvider: readString("meetingCloudTranscriptionProvider", ""),
  meetingCloudTranscriptionModel: readString("meetingCloudTranscriptionModel", ""),
  meetingCloudTranscriptionBaseUrl: readString("meetingCloudTranscriptionBaseUrl", ""),
  meetingCloudTranscriptionMode: readString("meetingCloudTranscriptionMode", ""),
  meetingRemoteTranscriptionType: (() => {
    const v = readString("meetingRemoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  meetingRemoteTranscriptionUrl: readString("meetingRemoteTranscriptionUrl", ""),

  setTranscriptionMode: createStringSetter("transcriptionMode") as (mode: InferenceMode) => void,
  setRemoteTranscriptionType: createStringSetter("remoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setRemoteTranscriptionUrl: createStringSetter("remoteTranscriptionUrl"),
  setRemoteTranscriptionModel: createStringSetter("remoteTranscriptionModel"),

  setMeetingTranscriptionMode: createStringSetter("meetingTranscriptionMode") as (
    mode: InferenceMode
  ) => void,
  setMeetingUseLocalWhisper: createBooleanSetter("meetingUseLocalWhisper"),
  setMeetingWhisperModel: createStringSetter("meetingWhisperModel"),
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("meetingLocalTranscriptionProvider", value);
    useSettingsStore.setState({ meetingLocalTranscriptionProvider: value });
  },
  setMeetingParakeetModel: createStringSetter("meetingParakeetModel"),
  setMeetingCohereModel: createStringSetter("meetingCohereModel"),
  setMeetingCloudTranscriptionProvider: createStringSetter("meetingCloudTranscriptionProvider"),
  setMeetingCloudTranscriptionModel: createStringSetter("meetingCloudTranscriptionModel"),
  setMeetingCloudTranscriptionBaseUrl: createStringSetter("meetingCloudTranscriptionBaseUrl"),
  setMeetingCloudTranscriptionMode: createStringSetter("meetingCloudTranscriptionMode"),
  setMeetingRemoteTranscriptionType: createStringSetter("meetingRemoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setMeetingRemoteTranscriptionUrl: createStringSetter("meetingRemoteTranscriptionUrl"),

  setUseLocalWhisper: createBooleanSetter("useLocalWhisper"),
  setWhisperModel: createStringSetter("whisperModel"),
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("localTranscriptionProvider", value);
    set({ localTranscriptionProvider: value });
  },
  setParakeetModel: createStringSetter("parakeetModel"),
  setCohereModel: createStringSetter("cohereModel"),
  setAllowOpenAIFallback: createBooleanSetter("allowOpenAIFallback"),
  setAllowLocalFallback: createBooleanSetter("allowLocalFallback"),
  setFallbackWhisperModel: createStringSetter("fallbackWhisperModel"),
  setPreferredLanguage: createStringSetter("preferredLanguage"),
  setChineseScriptPreference: (value: ChineseScriptPreference) =>
    createStringSetter("chineseScriptPreference")(normalizeChineseScriptPreference(value)),
  setCloudTranscriptionProvider: createStringSetter("cloudTranscriptionProvider"),
  setCloudTranscriptionModel: createStringSetter("cloudTranscriptionModel"),
  setCloudTranscriptionBaseUrl: createStringSetter("cloudTranscriptionBaseUrl"),

  // Every provider shares one model slot per scope, so a plain provider write
  // destroys the outgoing provider's model (the "Parasail" wipe). This setter
  // remembers the outgoing model and restores the incoming provider's last one.
  switchCloudTranscriptionProvider: (context, providerId) => {
    const s = useSettingsStore.getState();
    const keys = TRANSCRIPTION_CONTEXT_KEYS.find((entry) => entry.context === context);
    if (!keys) return;
    // Meeting/upload raw keys default to "" (inherit from dictation), so work
    // against resolved values. Restoring writes a concrete model — the scope
    // stops inheriting the dictation model from that point on.
    const outgoingProvider = (s[keys.provider] as string) || s.cloudTranscriptionProvider;
    if (outgoingProvider === providerId) {
      setStringSetting(keys.provider, providerId);
      return;
    }
    const outgoingModel = (s[keys.model] as string) || s.cloudTranscriptionModel;
    const memory = { ...s.transcriptionModelByProvider };
    if (outgoingProvider && outgoingModel) {
      memory[`${context}:${outgoingProvider}`] = outgoingModel;
      persistTranscriptionModelMemory(memory);
    }
    const remembered = memory[`${context}:${providerId}`];
    setStringSetting(keys.provider, providerId);
    setStringSetting(
      keys.model,
      remembered && transcriptionModelBelongsToProvider(providerId, remembered, context)
        ? remembered
        : defaultTranscriptionModel(providerId, context)
    );
  },

  setCloudTranscriptionMode: createStringSetter("cloudTranscriptionMode"),
  setAssemblyAiStreaming: createBooleanSetter("assemblyAiStreaming"),

  setUiLanguage: (language: string) => {
    const normalized = normalizeUiLanguage(language);
    if (isBrowser) localStorage.setItem("uiLanguage", normalized);
    set({ uiLanguage: normalized });
    void i18n.changeLanguage(normalized);
    if (isBrowser && window.electronAPI?.setUiLanguage) {
      window.electronAPI.setUiLanguage(normalized).catch((err) => {
        logger.warn(
          "Failed to sync UI language to main process",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  },

  setOpenaiApiKey: createSecretSetter("openaiApiKey", "openai"),
  setGeminiApiKey: createSecretSetter("geminiApiKey", "gemini"),
  setGroqApiKey: createSecretSetter("groqApiKey", "groq"),
  setXaiApiKey: createSecretSetter("xaiApiKey", "xai"),
  setMistralApiKey: createSecretSetter("mistralApiKey", "mistral"),
  setCortiClientId: createSecretSetter("cortiClientId", "cortiClientId"),
  setCortiClientSecret: createSecretSetter("cortiClientSecret", "cortiClientSecret"),
  setCortiApiKey: createSecretSetter("cortiApiKey", "cortiApiKey"),
  setCortiEnvironment: createStringSetter("cortiEnvironment"),
  setCortiTenant: createStringSetter("cortiTenant"),
  setTinfoilApiKey: createSecretSetter("tinfoilApiKey", "tinfoil"),
  setDeepgramApiKey: createSecretSetter("deepgramApiKey", "deepgram"),
  setAssemblyaiApiKey: createSecretSetter("assemblyaiApiKey", "assemblyai"),
  setCustomTranscriptionApiKey: createSecretSetter(
    "customTranscriptionApiKey",
    "customTranscription"
  ),

  setEnterpriseTranscriptionSetupMode: createStringSetter("enterpriseTranscriptionSetupMode") as (
    value: EnterpriseSetupMode
  ) => void,
  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => {
    if (isBrowser) localStorage.setItem("meetingHotkeyLayoutMode", mode);
    set({ meetingHotkeyLayoutMode: mode });
  },

  setOnboardingUseCases: (useCases: string[]) => {
    if (isBrowser) localStorage.setItem("onboardingUseCases", JSON.stringify(useCases));
    set({ onboardingUseCases: useCases });
  },

  setOnboardingUseCaseNote: createStringSetter("onboardingUseCaseNote"),

  setSpokenLanguages: (languages: string[]) => {
    if (isBrowser) localStorage.setItem("spokenLanguages", JSON.stringify(languages));
    set({ spokenLanguages: languages });
  },

  setPreferBuiltInMic: (value: boolean) => {
    const mode: MicrophoneSelectionMode = value ? "built-in" : "system";
    if (isBrowser) {
      localStorage.setItem("preferBuiltInMic", String(value));
      localStorage.setItem("microphoneSelectionMode", mode);
    }
    set({ preferBuiltInMic: value, microphoneSelectionMode: mode });
  },
  setMicrophoneSelectionMode: (mode: MicrophoneSelectionMode) => {
    const normalized: MicrophoneSelectionMode =
      mode === "built-in" || mode === "specific" ? mode : "system";
    const preferBuiltInMic = normalized === "built-in";
    if (isBrowser) {
      localStorage.setItem("microphoneSelectionMode", normalized);
      localStorage.setItem("preferBuiltInMic", String(preferBuiltInMic));
    }
    set({ microphoneSelectionMode: normalized, preferBuiltInMic });
  },
  setSelectedMicDevice: (deviceId: string, label: string) => {
    if (isBrowser) {
      localStorage.setItem("selectedMicDeviceLabel", label);
      localStorage.setItem("selectedMicDeviceId", deviceId);
    }
    set({ selectedMicDeviceId: deviceId, selectedMicDeviceLabel: label });
  },

  setTheme: (value: "light" | "dark" | "auto") => {
    if (isBrowser) localStorage.setItem("theme", value);
    set({ theme: value });
  },

  setCloudBackupEnabled: createBooleanSetter("cloudBackupEnabled"),
  setInsightsSyncEnabled: createBooleanSetter("insightsSyncEnabled"),
  setTelemetryEnabled: createBooleanSetter("telemetryEnabled"),
  setDataRetentionEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dataRetentionEnabled", String(value));
    set({ dataRetentionEnabled: value });
    logger.info(
      value
        ? "Data retention enabled — transcriptions and audio will be saved"
        : "Data retention disabled — transcriptions and audio will not be saved",
      {},
      "settings"
    );
  },

  setStartMinimized: (enabled: boolean) => {
    if (get().startMinimized === enabled) return;
    if (isBrowser) localStorage.setItem("startMinimized", String(enabled));
    set({ startMinimized: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyStartMinimizedChanged?.(enabled);
    }
  },

  setGcalAccounts: (accounts: CalendarAccount[]) => {
    if (isBrowser) localStorage.setItem("gcalAccounts", JSON.stringify(accounts));
    useSettingsStore.setState({
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    });
  },
  setMcalAccounts: (accounts: CalendarAccount[]) => {
    if (isBrowser) localStorage.setItem("mcalAccounts", JSON.stringify(accounts));
    useSettingsStore.setState({
      mcalAccounts: accounts,
      mcalConnected: accounts.length > 0,
    });
  },
  setNotificationsEnabled: createBooleanSetter("notificationsEnabled"),
  setNotifyMeetingDetection: createBooleanSetter("notifyMeetingDetection"),
  setNotifyCalendarReminders: createBooleanSetter("notifyCalendarReminders"),
  setAutoUpdatesEnabled: (enabled: boolean) => {
    if (isBrowser) localStorage.setItem("autoUpdatesEnabled", String(enabled));
    set({ autoUpdatesEnabled: enabled });
    if (isBrowser) window.electronAPI?.setAutoUpdatesEnabled?.(enabled);
  },
  setGcalPrimaryOnly: (value: boolean) => {
    if (isBrowser) localStorage.setItem("gcalPrimaryOnly", String(value));
    useSettingsStore.setState({ gcalPrimaryOnly: value });
    if (isBrowser) window.electronAPI?.gcalSetPrimaryOnly?.(value);
  },
  setMcalPrimaryOnly: (value: boolean) => {
    if (isBrowser) localStorage.setItem("mcalPrimaryOnly", String(value));
    useSettingsStore.setState({ mcalPrimaryOnly: value });
    if (isBrowser) window.electronAPI?.mcalSetPrimaryOnly?.(value);
  },
  setAppleCalendarConnected: createBooleanSetter("appleCalendarConnected"),
  setMeetingProcessDetection: createBooleanSetter("meetingProcessDetection"),
  setSpeakerDiarizationEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("speakerDiarizationEnabled", String(value));
    useSettingsStore.setState({ speakerDiarizationEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeakerDiarizationEnabled?.(value);
    }
  },
  setDictationSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dictationSileroEnabled", String(value));
    useSettingsStore.setState({ dictationSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ dictationSileroEnabled: value });
    }
  },
  setNoteRecordingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("noteRecordingSileroEnabled", String(value));
    useSettingsStore.setState({ noteRecordingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ noteRecordingSileroEnabled: value });
    }
  },
  setMeetingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("meetingSileroEnabled", String(value));
    useSettingsStore.setState({ meetingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ meetingSileroEnabled: value });
    }
  },
  setWhisperVadThreshold: (value: number) => {
    const next = clampVadValue("threshold", value);
    if (isBrowser) localStorage.setItem("whisperVadThreshold", String(next));
    useSettingsStore.setState({ whisperVadThreshold: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ threshold: next });
    }
  },
  setWhisperVadMinSpeechDurationMs: (value: number) => {
    const next = clampVadValue("minSpeechDurationMs", value);
    if (isBrowser) localStorage.setItem("whisperVadMinSpeechDurationMs", String(next));
    useSettingsStore.setState({ whisperVadMinSpeechDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ minSpeechDurationMs: next });
    }
  },
  setWhisperVadMinSilenceDurationMs: (value: number) => {
    const next = clampVadValue("minSilenceDurationMs", value);
    if (isBrowser) localStorage.setItem("whisperVadMinSilenceDurationMs", String(next));
    useSettingsStore.setState({ whisperVadMinSilenceDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ minSilenceDurationMs: next });
    }
  },
  setWhisperVadMaxSpeechDurationS: (value: number) => {
    const next = clampVadValue("maxSpeechDurationS", value);
    if (isBrowser) localStorage.setItem("whisperVadMaxSpeechDurationS", String(next));
    useSettingsStore.setState({ whisperVadMaxSpeechDurationS: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ maxSpeechDurationS: next });
    }
  },
  setWhisperVadSpeechPadMs: (value: number) => {
    const next = clampVadValue("speechPadMs", value);
    if (isBrowser) localStorage.setItem("whisperVadSpeechPadMs", String(next));
    useSettingsStore.setState({ whisperVadSpeechPadMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ speechPadMs: next });
    }
  },
  setWhisperVadSamplesOverlap: (value: number) => {
    const next = clampVadValue("samplesOverlap", value);
    if (isBrowser) localStorage.setItem("whisperVadSamplesOverlap", String(next));
    useSettingsStore.setState({ whisperVadSamplesOverlap: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ samplesOverlap: next });
    }
  },
  setNoteFilesEnabled: createBooleanSetter("noteFilesEnabled"),
  setNoteFilesPath: createStringSetter("noteFilesPath"),

  setIsSignedIn: (value: boolean) => {
    if (isBrowser) localStorage.setItem("isSignedIn", String(value));
    set({ isSignedIn: value });
  },

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useLocalWhisper !== undefined) s.setUseLocalWhisper(settings.useLocalWhisper);
    if (settings.uiLanguage !== undefined) s.setUiLanguage(settings.uiLanguage);
    if (settings.whisperModel !== undefined) s.setWhisperModel(settings.whisperModel);
    if (settings.localTranscriptionProvider !== undefined)
      s.setLocalTranscriptionProvider(settings.localTranscriptionProvider);
    if (settings.parakeetModel !== undefined) s.setParakeetModel(settings.parakeetModel);
    if (settings.cohereModel !== undefined) s.setCohereModel(settings.cohereModel);
    if (settings.allowOpenAIFallback !== undefined)
      s.setAllowOpenAIFallback(settings.allowOpenAIFallback);
    if (settings.allowLocalFallback !== undefined)
      s.setAllowLocalFallback(settings.allowLocalFallback);
    if (settings.fallbackWhisperModel !== undefined)
      s.setFallbackWhisperModel(settings.fallbackWhisperModel);
    if (settings.preferredLanguage !== undefined)
      s.setPreferredLanguage(settings.preferredLanguage);
    if (settings.chineseScriptPreference !== undefined)
      s.setChineseScriptPreference(settings.chineseScriptPreference);
    if (settings.cloudTranscriptionProvider !== undefined)
      s.setCloudTranscriptionProvider(settings.cloudTranscriptionProvider);
    if (settings.cloudTranscriptionModel !== undefined)
      s.setCloudTranscriptionModel(settings.cloudTranscriptionModel);
    if (settings.cloudTranscriptionBaseUrl !== undefined)
      s.setCloudTranscriptionBaseUrl(settings.cloudTranscriptionBaseUrl);
    if (settings.cloudTranscriptionMode !== undefined)
      s.setCloudTranscriptionMode(settings.cloudTranscriptionMode);
    if (settings.assemblyAiStreaming !== undefined)
      s.setAssemblyAiStreaming(settings.assemblyAiStreaming);
  },

  // Apply a transcription config to dictation, then mirror its cloud routing to
  // note recording — used when onboarding picks one provider
  // for everything (e.g. Corti for medical providers).
  setCloudTranscriptionForAllScopes: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    s.updateTranscriptionSettings(settings);
    const {
      useLocalWhisper,
      localTranscriptionProvider,
      cloudTranscriptionMode,
      cloudTranscriptionProvider,
      cloudTranscriptionModel,
    } = useSettingsStore.getState();
    // Each Settings tab selects on its InferenceMode field, so set it for every
    // scope — otherwise the UI keeps showing the previous mode (e.g. OpenWhispr
    // Cloud) even though the cloud routing now points at the new provider.
    const mode = deriveTranscriptionMode(
      useLocalWhisper,
      cloudTranscriptionMode,
      cloudTranscriptionProvider
    );
    s.setTranscriptionMode(mode);
    s.setMeetingTranscriptionMode(mode);
    s.setMeetingUseLocalWhisper(useLocalWhisper);
    s.setMeetingLocalTranscriptionProvider(localTranscriptionProvider);
    s.setMeetingCloudTranscriptionMode(cloudTranscriptionMode);
    s.setMeetingCloudTranscriptionProvider(cloudTranscriptionProvider);
    s.setMeetingCloudTranscriptionModel(cloudTranscriptionModel);
    // Seed the per-provider model memory so a later provider switch-and-return
    // in any scope restores the model onboarding chose.
    if (cloudTranscriptionProvider && cloudTranscriptionModel) {
      const memory = { ...useSettingsStore.getState().transcriptionModelByProvider };
      for (const { context } of TRANSCRIPTION_CONTEXT_KEYS) {
        memory[`${context}:${cloudTranscriptionProvider}`] = cloudTranscriptionModel;
      }
      persistTranscriptionModelMemory(memory);
    }
  },

  updateApiKeys: (keys: Partial<ApiKeySettings>) => {
    const s = useSettingsStore.getState();
    if (keys.openaiApiKey !== undefined) s.setOpenaiApiKey(keys.openaiApiKey);
    if (keys.geminiApiKey !== undefined) s.setGeminiApiKey(keys.geminiApiKey);
    if (keys.groqApiKey !== undefined) s.setGroqApiKey(keys.groqApiKey);
    if (keys.xaiApiKey !== undefined) s.setXaiApiKey(keys.xaiApiKey);
    if (keys.mistralApiKey !== undefined) s.setMistralApiKey(keys.mistralApiKey);
    if (keys.cortiClientId !== undefined) s.setCortiClientId(keys.cortiClientId);
    if (keys.cortiClientSecret !== undefined) s.setCortiClientSecret(keys.cortiClientSecret);
    if (keys.cortiApiKey !== undefined) s.setCortiApiKey(keys.cortiApiKey);
    if (keys.tinfoilApiKey !== undefined) s.setTinfoilApiKey(keys.tinfoilApiKey);
    if (keys.deepgramApiKey !== undefined) s.setDeepgramApiKey(keys.deepgramApiKey);
    if (keys.assemblyaiApiKey !== undefined) s.setAssemblyaiApiKey(keys.assemblyaiApiKey);
    if (keys.customTranscriptionApiKey !== undefined)
      s.setCustomTranscriptionApiKey(keys.customTranscriptionApiKey);
  },
}));

// --- Selectors (derived state, not stored) ---

export interface ResolvedMeetingTranscription {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cohereModel: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
}

export const selectResolvedMeetingTranscription = (
  state: SettingsState
): ResolvedMeetingTranscription => ({
  useLocalWhisper: state.meetingUseLocalWhisper,
  whisperModel: state.meetingWhisperModel || state.whisperModel,
  localTranscriptionProvider: state.meetingLocalTranscriptionProvider,
  parakeetModel: state.meetingParakeetModel || state.parakeetModel,
  cohereModel: state.meetingCohereModel || state.cohereModel,
  cloudTranscriptionProvider:
    state.meetingCloudTranscriptionProvider || state.cloudTranscriptionProvider,
  cloudTranscriptionModel: state.meetingCloudTranscriptionModel || state.cloudTranscriptionModel,
  cloudTranscriptionBaseUrl:
    state.meetingCloudTranscriptionBaseUrl || state.cloudTranscriptionBaseUrl || "",
  cloudTranscriptionMode: state.meetingCloudTranscriptionMode || state.cloudTranscriptionMode,
  transcriptionMode: state.meetingTranscriptionMode,
  remoteTranscriptionType: state.meetingRemoteTranscriptionType,
  remoteTranscriptionUrl: state.meetingRemoteTranscriptionUrl || state.remoteTranscriptionUrl,
});

// --- Convenience getters for non-React code ---

interface TranscriptionContextKeys {
  context: TranscriptionPolicyContext;
  mode: keyof SettingsState;
  useLocal: keyof SettingsState;
  cloudMode: keyof SettingsState;
  provider: keyof SettingsState;
  model: keyof SettingsState;
  baseUrl: keyof SettingsState;
}

const TRANSCRIPTION_CONTEXT_KEYS: readonly TranscriptionContextKeys[] = [
  {
    context: "dictation",
    mode: "transcriptionMode",
    useLocal: "useLocalWhisper",
    cloudMode: "cloudTranscriptionMode",
    provider: "cloudTranscriptionProvider",
    model: "cloudTranscriptionModel",
    baseUrl: "cloudTranscriptionBaseUrl",
  },
  {
    context: "meeting",
    mode: "meetingTranscriptionMode",
    useLocal: "meetingUseLocalWhisper",
    cloudMode: "meetingCloudTranscriptionMode",
    provider: "meetingCloudTranscriptionProvider",
    model: "meetingCloudTranscriptionModel",
    baseUrl: "meetingCloudTranscriptionBaseUrl",
  },
];

/**
 * Overlay managed policy choices for rendering and future requests while
 * leaving Zustand/localStorage preferences untouched for policy removal.
 */
export function selectPolicyEffectiveSettings(
  state: SettingsState,
  policyState: PolicyDecisionSnapshot
): SettingsState {
  if (policyState.status === "idle" || policyState.status === "unmanaged") return state;
  if (policyState.status !== "managed" || !policyState.policy) return state;

  const effective = { ...state };
  const writable = effective as unknown as Record<string, unknown>;

  for (const keys of TRANSCRIPTION_CONTEXT_KEYS) {
    const rawSelection = getTranscriptionSelection(state, keys.context);
    const selection = resolveEffectivePolicySelection(
      policyState,
      "transcription",
      rawSelection,
      keys.context === "meeting"
        ? MEETING_TRANSCRIPTION_POLICY_CATALOG
        : TRANSCRIPTION_POLICY_CATALOG
    );
    if (!selection) continue;

    writable[keys.mode] = selection.mode;
    writable[keys.useLocal] = selection.mode === "local";
    writable[keys.cloudMode] = selection.mode === "openwhispr" ? "openwhispr" : "byok";
    if (selection.mode === "providers") {
      const providerChanged = selection.provider !== rawSelection.provider;
      writable[keys.provider] = selection.provider;
      if (
        providerChanged ||
        !transcriptionModelBelongsToProvider(
          selection.provider,
          state[keys.model] as string,
          keys.context
        )
      ) {
        writable[keys.model] = defaultTranscriptionModel(selection.provider, keys.context);
      }

      const canonicalBaseUrl = canonicalTranscriptionBaseUrl(selection.provider);
      if (canonicalBaseUrl) {
        writable[keys.baseUrl] = canonicalBaseUrl;
      } else if (providerChanged) {
        // A fallback to Custom must not reinterpret another provider's endpoint
        // as user authorization to send content there.
        writable[keys.baseUrl] = "";
      }
    } else if (selection.mode === "enterprise") {
      // The managed deployment/endpoint is resolved separately by
      // enterpriseIdentityStore; the provider id here only needs to satisfy
      // the policy gate (isTranscriptionContextAllowed).
      writable[keys.provider] = selection.provider;
    }
  }

  return effective;
}

export function getSettings(): SettingsState {
  return selectPolicyEffectiveSettings(useSettingsStore.getState(), usePolicyStore.getState());
}

// --- Initialization ---

let hasInitialized = false;

export async function initializeSettings(): Promise<void> {
  if (hasInitialized) return;
  hasInitialized = true;

  if (!isBrowser) return;

  const state = useSettingsStore.getState();

  if (window.electronAPI) {
    // Preferences are already in localStorage; do not wait for secret or provider hydration.
    try {
      await window.electronAPI.syncNotificationPreferences?.({
        notificationsEnabled: state.notificationsEnabled,
        notifyMeetingDetection: state.notifyMeetingDetection,
        notifyCalendarReminders: state.notifyCalendarReminders,
        meetingProcessDetection: state.meetingProcessDetection,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync notification preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const [
        openai,
        gemini,
        groq,
        xai,
        mistral,
        cortiClientId,
        cortiClientSecret,
        cortiApiKey,
        tinfoil,
        customTx,
        deepgram,
        assemblyai,
      ] = await Promise.all([
        window.electronAPI.getOpenAIKey?.(),
        window.electronAPI.getGeminiKey?.(),
        window.electronAPI.getGroqKey?.(),
        window.electronAPI.getXaiKey?.(),
        window.electronAPI.getMistralKey?.(),
        window.electronAPI.getCortiClientId?.(),
        window.electronAPI.getCortiClientSecret?.(),
        window.electronAPI.getCortiKey?.(),
        window.electronAPI.getTinfoilKey?.(),
        window.electronAPI.getCustomTranscriptionKey?.(),
        window.electronAPI.getDeepgramKey?.(),
        window.electronAPI.getAssemblyAIKey?.(),
      ]);

      useSettingsStore.setState({
        openaiApiKey: openai || "",
        geminiApiKey: gemini || "",
        groqApiKey: groq || "",
        xaiApiKey: xai || "",
        mistralApiKey: mistral || "",
        cortiClientId: cortiClientId || "",
        cortiClientSecret: cortiClientSecret || "",
        cortiApiKey: cortiApiKey || "",
        tinfoilApiKey: tinfoil || "",
        customTranscriptionApiKey: customTx || "",
        deepgramApiKey: deepgram || "",
        assemblyaiApiKey: assemblyai || "",
      });

      for (const key of STALE_SECRET_LOCALSTORAGE_KEYS) {
        localStorage.removeItem(key);
      }
      // Latch for the one-time semantic reindex that no longer exists (#2143).
      localStorage.removeItem("semanticReindexVersion");
    } catch (err) {
      logger.warn(
        "Failed to hydrate secrets from main process",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync UI language from main process
    try {
      const envLanguage = await window.electronAPI.getUiLanguage?.();
      const resolved = normalizeUiLanguage(envLanguage || state.uiLanguage);
      if (resolved !== state.uiLanguage) {
        if (isBrowser) localStorage.setItem("uiLanguage", resolved);
        useSettingsStore.setState({ uiLanguage: resolved });
      }
      await i18n.changeLanguage(resolved);
    } catch (err) {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      void i18n.changeLanguage(normalizeUiLanguage(state.uiLanguage));
    }

    const migratedLang = isBrowser ? localStorage.getItem("preferredLanguage") : null;
    if (migratedLang && migratedLang !== state.preferredLanguage) {
      useSettingsStore.setState({ preferredLanguage: migratedLang });
    }

    try {
      await window.electronAPI.setAutoUpdatesEnabled?.(
        useSettingsStore.getState().autoUpdatesEnabled
      );
    } catch (err) {
      logger.warn(
        "Failed to sync automatic updates preference on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // The main-process DB is the source of truth for the Apple Calendar connection
    try {
      const status = await window.electronAPI.acalGetConnectionStatus?.();
      if (status) {
        useSettingsStore.getState().setAppleCalendarConnected(status.connected);
      }
    } catch (err) {
      logger.warn(
        "Failed to hydrate Apple Calendar connection status",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.gcalSetPrimaryOnly?.(currentState.gcalPrimaryOnly);
    } catch (err) {
      logger.warn(
        "Failed to sync gcal primary-only on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.mcalSetPrimaryOnly?.(currentState.mcalPrimaryOnly);
    } catch (err) {
      logger.warn(
        "Failed to sync mcal primary-only on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setSpeakerDiarizationEnabled?.(
        currentState.speakerDiarizationEnabled
      );
    } catch (err) {
      logger.warn(
        "Failed to sync speaker diarization preference on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setWhisperVadConfig?.({
        dictationSileroEnabled: currentState.dictationSileroEnabled,
        noteRecordingSileroEnabled: currentState.noteRecordingSileroEnabled,
        meetingSileroEnabled: currentState.meetingSileroEnabled,
        threshold: currentState.whisperVadThreshold,
        minSpeechDurationMs: currentState.whisperVadMinSpeechDurationMs,
        minSilenceDurationMs: currentState.whisperVadMinSilenceDurationMs,
        maxSpeechDurationS: currentState.whisperVadMaxSpeechDurationS,
        speechPadMs: currentState.whisperVadSpeechPadMs,
        samplesOverlap: currentState.whisperVadSamplesOverlap,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync whisper VAD config on startup",
        { error: (err as Error).message },
        "settings"
      );
    }
  }

  // Sync Zustand store when another window writes to localStorage
  window.addEventListener("storage", (event) => {
    if (!event.key || event.storageArea !== localStorage || event.newValue === null) return;

    const { key, newValue } = event;

    const state = useSettingsStore.getState();
    if (!(key in state) || typeof (state as unknown as Record<string, unknown>)[key] === "function")
      return;

    let value: unknown;
    if (BOOLEAN_SETTINGS.has(key)) {
      value = newValue === "true";
    } else if (ARRAY_SETTINGS.has(key)) {
      try {
        const parsed = JSON.parse(newValue);
        value = Array.isArray(parsed) ? parsed : [];
      } catch {
        value = [];
      }
    } else if (NUMERIC_SETTINGS.has(key)) {
      const parsed = Number(newValue);
      value = Number.isNaN(parsed) ? (state as unknown as Record<string, unknown>)[key] : parsed;
    } else {
      value = newValue;
    }

    useSettingsStore.setState({ [key]: value });

    if (key === "gcalAccounts" && Array.isArray(value)) {
      const accounts = value as CalendarAccount[];
      useSettingsStore.setState({
        gcalConnected: accounts.length > 0,
        gcalEmail: accounts[0]?.email ?? "",
      });
    }

    if (key === "mcalAccounts" && Array.isArray(value)) {
      useSettingsStore.setState({ mcalConnected: (value as CalendarAccount[]).length > 0 });
    }

    if (key === "uiLanguage" && typeof value === "string") {
      void i18n.changeLanguage(value);
    }
  });
}
