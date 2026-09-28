import { create } from "zustand";
import { DEFAULT_WORLD_CLOCKS, MAX_WORLD_CLOCKS } from "../helpers/trayCalendarModel";
import logger from "../utils/logger";
import whisperVadConstants from "../constants/whisperVad.json";
import type {
  ChineseScriptPreference,
  LocalTranscriptionProvider,
  InferenceMode,
} from "../types/electron";
import type { CalendarAccount } from "../types/calendar";
import { normalizeChineseScriptPreference } from "../utils/chineseScript";
import modelRegistryData from "../models/modelRegistryData.json";

// Requires localStorage as well as window: the module-scope migrations below
// dereference the bare localStorage global, and test harnesses import this
// store with partial window stubs that don't define it.
const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

function streamingProviderModels(providerId: string): Array<{ id: string }> {
  const models =
    modelRegistryData.transcriptionProviders.find((provider) => provider.id === providerId)
      ?.models ?? [];
  return models.filter((model) => model.streaming);
}

function defaultStreamingModel(providerId: string): string {
  return streamingProviderModels(providerId)[0]?.id ?? "";
}

function readString(key: string, fallback: string): string {
  if (!isBrowser) return fallback;
  return localStorage.getItem(key) ?? fallback;
}

// Meeting keys once defaulted to "" and inherited the removed dictation keys;
// read the legacy key so existing profiles keep their model.
function readMeetingString(key: string, legacyKey: string, fallback: string): string {
  return readString(key, "") || readString(legacyKey, fallback);
}

function readLocalProvider(): LocalTranscriptionProvider {
  const stored = readMeetingString(
    "meetingLocalTranscriptionProvider",
    "localTranscriptionProvider",
    "whisper"
  );
  return stored === "nvidia" || stored === "cohere" ? stored : "whisper";
}

export type WorldClock = { label: string; timeZone: string };

function readWorldClocks(): WorldClock[] {
  if (!isBrowser) return DEFAULT_WORLD_CLOCKS;
  const stored = localStorage.getItem("worldClocks");
  if (stored === null) return DEFAULT_WORLD_CLOCKS;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_WORLD_CLOCKS) : DEFAULT_WORLD_CLOCKS;
  } catch {
    return DEFAULT_WORLD_CLOCKS;
  }
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  if (fallback === true) return stored !== "false";
  return stored === "true";
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

const BOOLEAN_SETTINGS = new Set([
  "preferBuiltInMic",
  "startMinimized",
  "meetingProcessDetection",
  "speakerDiarizationEnabled",
  "meetingSileroEnabled",
  "noteFilesEnabled",
  "notificationsEnabled",
  "notifyMeetingDetection",
  "notifyCalendarReminders",
  "gcalPrimaryOnly",
  "mcalPrimaryOnly",
  "appleCalendarConnected",
]);

const ARRAY_SETTINGS = new Set(["gcalAccounts", "mcalAccounts", "worldClocks"]);

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

type MeetingLayoutMode = "side-panel" | "full-width";
type Theme = "light" | "dark" | "auto";

export interface SettingsState {
  preferredLanguage: string;
  /** When transcription language is Auto, force Chinese output script. See #975. */
  chineseScriptPreference: ChineseScriptPreference;
  meetingHotkeyLayoutMode: MeetingLayoutMode;
  microphoneSelectionMode: MicrophoneSelectionMode;
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  selectedMicDeviceLabel: string;
  theme: Theme;

  openaiApiKey: string;
  cortiClientId: string;
  cortiClientSecret: string;
  cortiEnvironment: string;
  cortiTenant: string;
  tinfoilApiKey: string;
  deepgramApiKey: string;
  assemblyaiApiKey: string;

  startMinimized: boolean;
  gcalAccounts: CalendarAccount[];
  gcalConnected: boolean;
  gcalEmail: string;
  mcalAccounts: CalendarAccount[];
  mcalConnected: boolean;
  notificationsEnabled: boolean;
  notifyMeetingDetection: boolean;
  notifyCalendarReminders: boolean;
  gcalPrimaryOnly: boolean;
  mcalPrimaryOnly: boolean;
  appleCalendarConnected: boolean;
  meetingProcessDetection: boolean;
  speakerDiarizationEnabled: boolean;
  meetingSileroEnabled: boolean;
  whisperVadThreshold: number;
  whisperVadMinSpeechDurationMs: number;
  whisperVadMinSilenceDurationMs: number;
  whisperVadMaxSpeechDurationS: number;
  whisperVadSpeechPadMs: number;
  whisperVadSamplesOverlap: number;
  noteFilesEnabled: boolean;
  noteFilesPath: string;
  worldClocks: WorldClock[];

  meetingTranscriptionMode: InferenceMode;
  meetingWhisperModel: string;
  meetingLocalTranscriptionProvider: LocalTranscriptionProvider;
  meetingParakeetModel: string;
  meetingCohereModel: string;
  meetingCloudTranscriptionProvider: string;
  meetingCloudTranscriptionModel: string;

  /** Last model used per provider (`"meeting:<providerId>"`), so switching providers restores it. */
  transcriptionModelByProvider: Record<string, string>;

  setMeetingTranscriptionMode: (mode: InferenceMode) => void;
  setMeetingWhisperModel: (value: string) => void;
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setMeetingParakeetModel: (value: string) => void;
  setMeetingCohereModel: (value: string) => void;
  setMeetingCloudTranscriptionProvider: (value: string) => void;
  setMeetingCloudTranscriptionModel: (value: string) => void;
  switchCloudTranscriptionProvider: (providerId: string) => void;

  setPreferredLanguage: (value: string) => void;
  setChineseScriptPreference: (value: ChineseScriptPreference) => void;

  setOpenaiApiKey: (key: string) => void;
  setCortiClientId: (key: string) => void;
  setCortiClientSecret: (key: string) => void;
  setCortiEnvironment: (value: string) => void;
  setCortiTenant: (value: string) => void;
  setTinfoilApiKey: (key: string) => void;
  setDeepgramApiKey: (key: string) => void;
  setAssemblyaiApiKey: (key: string) => void;

  setMeetingHotkeyLayoutMode: (mode: MeetingLayoutMode) => void;
  setMicrophoneSelectionMode: (mode: MicrophoneSelectionMode) => void;
  setSelectedMicDevice: (deviceId: string, label: string) => void;

  setTheme: (value: Theme) => void;
  setStartMinimized: (enabled: boolean) => void;
  setGcalAccounts: (accounts: CalendarAccount[]) => void;
  setMcalAccounts: (accounts: CalendarAccount[]) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setNotifyMeetingDetection: (value: boolean) => void;
  setNotifyCalendarReminders: (value: boolean) => void;
  setGcalPrimaryOnly: (value: boolean) => void;
  setMcalPrimaryOnly: (value: boolean) => void;
  setAppleCalendarConnected: (value: boolean) => void;
  setMeetingProcessDetection: (value: boolean) => void;
  setSpeakerDiarizationEnabled: (value: boolean) => void;
  setMeetingSileroEnabled: (value: boolean) => void;
  setWhisperVadThreshold: (value: number) => void;
  setWhisperVadMinSpeechDurationMs: (value: number) => void;
  setWhisperVadMinSilenceDurationMs: (value: number) => void;
  setWhisperVadMaxSpeechDurationS: (value: number) => void;
  setWhisperVadSpeechPadMs: (value: number) => void;
  setWhisperVadSamplesOverlap: (value: number) => void;
  setNoteFilesEnabled: (value: boolean) => void;
  setNoteFilesPath: (value: string) => void;
  setWorldClocks: (clocks: WorldClock[]) => void;
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
  cortiClientId: "saveCortiClientId",
  cortiClientSecret: "saveCortiClientSecret",
  tinfoil: "saveTinfoilKey",
  deepgram: "saveDeepgramKey",
  assemblyai: "saveAssemblyAIKey",
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
  preferredLanguage: readString("preferredLanguage", "auto"),
  chineseScriptPreference: normalizeChineseScriptPreference(
    readString("chineseScriptPreference", "as-transcribed")
  ),
  transcriptionModelByProvider: readModelMemory("transcriptionModelByProvider"),
  cortiEnvironment: readString("cortiEnvironment", "us"),
  cortiTenant: readString("cortiTenant", "base"),

  // Secrets hydrate from main process in initializeSettings, never from localStorage.
  openaiApiKey: "",
  cortiClientId: "",
  cortiClientSecret: "",
  tinfoilApiKey: "",
  deepgramApiKey: "",
  assemblyaiApiKey: "",

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
  startMinimized: readBoolean("startMinimized", false),
  notificationsEnabled: readBoolean("notificationsEnabled", true),
  notifyMeetingDetection: readBoolean("notifyMeetingDetection", true),
  notifyCalendarReminders: readBoolean("notifyCalendarReminders", true),
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
  worldClocks: readWorldClocks(),

  meetingTranscriptionMode: (readString("meetingTranscriptionMode", "local") === "providers"
    ? "providers"
    : "local") as InferenceMode,
  meetingWhisperModel: readMeetingString("meetingWhisperModel", "whisperModel", "base"),
  meetingLocalTranscriptionProvider: readLocalProvider(),
  meetingParakeetModel: readMeetingString("meetingParakeetModel", "parakeetModel", ""),
  meetingCohereModel: readMeetingString(
    "meetingCohereModel",
    "cohereModel",
    "cohere-transcribe-03-2026"
  ),
  meetingCloudTranscriptionProvider: readMeetingString(
    "meetingCloudTranscriptionProvider",
    "cloudTranscriptionProvider",
    "openai"
  ),
  meetingCloudTranscriptionModel: readMeetingString(
    "meetingCloudTranscriptionModel",
    "cloudTranscriptionModel",
    ""
  ),

  setMeetingTranscriptionMode: createStringSetter("meetingTranscriptionMode") as (
    mode: InferenceMode
  ) => void,
  setMeetingWhisperModel: createStringSetter("meetingWhisperModel"),
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("meetingLocalTranscriptionProvider", value);
    useSettingsStore.setState({ meetingLocalTranscriptionProvider: value });
  },
  setMeetingParakeetModel: createStringSetter("meetingParakeetModel"),
  setMeetingCohereModel: createStringSetter("meetingCohereModel"),
  setMeetingCloudTranscriptionProvider: createStringSetter("meetingCloudTranscriptionProvider"),
  setMeetingCloudTranscriptionModel: createStringSetter("meetingCloudTranscriptionModel"),
  setPreferredLanguage: createStringSetter("preferredLanguage"),
  setChineseScriptPreference: (value: ChineseScriptPreference) =>
    createStringSetter("chineseScriptPreference")(normalizeChineseScriptPreference(value)),

  // Every provider shares one model slot, so a plain provider write destroys
  // the outgoing provider's model. This setter remembers the outgoing model and
  // restores the incoming provider's last one.
  switchCloudTranscriptionProvider: (providerId) => {
    const s = useSettingsStore.getState();
    const outgoingProvider = s.meetingCloudTranscriptionProvider;
    if (outgoingProvider === providerId) {
      s.setMeetingCloudTranscriptionProvider(providerId);
      return;
    }
    const memory = { ...s.transcriptionModelByProvider };
    if (outgoingProvider && s.meetingCloudTranscriptionModel) {
      memory[`meeting:${outgoingProvider}`] = s.meetingCloudTranscriptionModel;
      persistTranscriptionModelMemory(memory);
    }
    const remembered = memory[`meeting:${providerId}`];
    s.setMeetingCloudTranscriptionProvider(providerId);
    s.setMeetingCloudTranscriptionModel(
      remembered && streamingProviderModels(providerId).some((model) => model.id === remembered)
        ? remembered
        : defaultStreamingModel(providerId)
    );
  },

  setOpenaiApiKey: createSecretSetter("openaiApiKey", "openai"),
  setCortiClientId: createSecretSetter("cortiClientId", "cortiClientId"),
  setCortiClientSecret: createSecretSetter("cortiClientSecret", "cortiClientSecret"),
  setCortiEnvironment: createStringSetter("cortiEnvironment"),
  setCortiTenant: createStringSetter("cortiTenant"),
  setTinfoilApiKey: createSecretSetter("tinfoilApiKey", "tinfoil"),
  setDeepgramApiKey: createSecretSetter("deepgramApiKey", "deepgram"),
  setAssemblyaiApiKey: createSecretSetter("assemblyaiApiKey", "assemblyai"),

  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => {
    if (isBrowser) localStorage.setItem("meetingHotkeyLayoutMode", mode);
    set({ meetingHotkeyLayoutMode: mode });
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
  setWorldClocks: (clocks) => {
    const next = clocks.slice(0, MAX_WORLD_CLOCKS);
    if (isBrowser) localStorage.setItem("worldClocks", JSON.stringify(next));
    set({ worldClocks: next });
  },
}));

export function getSettings(): SettingsState {
  return useSettingsStore.getState();
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
      const [openai, cortiClientId, cortiClientSecret, tinfoil, deepgram, assemblyai] =
        await Promise.all([
          window.electronAPI.getOpenAIKey?.(),
          window.electronAPI.getCortiClientId?.(),
          window.electronAPI.getCortiClientSecret?.(),
          window.electronAPI.getTinfoilKey?.(),
          window.electronAPI.getDeepgramKey?.(),
          window.electronAPI.getAssemblyAIKey?.(),
        ]);

      useSettingsStore.setState({
        openaiApiKey: openai || "",
        cortiClientId: cortiClientId || "",
        cortiClientSecret: cortiClientSecret || "",
        tinfoilApiKey: tinfoil || "",
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

    const migratedLang = isBrowser ? localStorage.getItem("preferredLanguage") : null;
    if (migratedLang && migratedLang !== state.preferredLanguage) {
      useSettingsStore.setState({ preferredLanguage: migratedLang });
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
  });
}
