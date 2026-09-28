import React, { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "./ui/BidiInterpolatedText";
import { Badge } from "./ui/badge";
import {
  RefreshCw,
  Download,
  Mic,
  FolderOpen,
  Sun,
  Moon,
  Monitor,
  Key,
  Cpu,
  Network,
  AlertTriangle,
  Loader2,
  Info,
  FileAudio,
} from "./icons";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import SelfHostedPanel from "./SelfHostedPanel";
import {
  ConfirmDialog,
  AlertDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { useSettings } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { useWhisper } from "../hooks/useWhisper";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useClipboard } from "../hooks/useClipboard";
import { useUpdater } from "../hooks/useUpdater";

import { ProviderTabs } from "./ui/ProviderTabs";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { getPlatform } from "../utils/platform";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Toggle } from "./ui/toggle";
import DeveloperSection from "./DeveloperSection";
import { MeetingTranscriptionPanel } from "./settings/MeetingSettings";
import LanguageSelector from "./ui/LanguageSelector";
import { useToast } from "./ui/useToast";
import { useTheme } from "../hooks/useTheme";
import type {
  ChineseScriptPreference,
  GpuDevice,
  LocalTranscriptionProvider,
  InferenceMode,
} from "../types/electron";
import logger from "../utils/logger";
import { SettingsRow, InferenceModeSelector } from "./ui/SettingsSection";
import type { InferenceModeOption } from "./ui/SettingsSection";
import { useSettingsLayout } from "./ui/useSettingsLayout";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { loadFolders, initializeNotesTree } from "../stores/noteStore.js";
import { useSettingsStore } from "../stores/settingsStore";
import { canManageSystemAudioInApp } from "../utils/systemAudioAccess";

export type SettingsSectionType = "general" | "speechToText" | "privacyData" | "system";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
  onNavigateToSection?: (section: SettingsSectionType) => void;
  /** When a legacy section ID was used (e.g. `meetings`), land on the matching sub-tab. */
  initialSubTab?: string;
}

const noop = () => {};

function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm divide-y divide-border/60 dark:divide-border-subtle/50 ${className}`}
    >
      {children}
    </div>
  );
}

function SettingsPanelRow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { isCompact } = useSettingsLayout();

  return (
    <div className={`${isCompact ? "px-3 py-2.5" : "px-4 py-3"} ${className}`}>{children}</div>
  );
}

function SectionHeader({
  title,
  description,
  note,
}: {
  title: string;
  description?: string;
  note?: string;
}) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
      {note && <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{note}</p>}
    </div>
  );
}

interface GranolaImportPreview {
  total: number;
  newCount: number;
  duplicateCount: number;
  sampleTitles: string[];
  warningCount: number;
}

type GranolaImportState =
  | { phase: "idle" }
  | { phase: "picking" }
  | { phase: "preview"; preview: GranolaImportPreview }
  | { phase: "importing"; preview: GranolaImportPreview }
  | { phase: "done"; imported: number; skipped: number };

function GranolaImportSection({
  showAlertDialog,
}: {
  showAlertDialog: (options: { title: string; description?: string }) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<GranolaImportState>({ phase: "idle" });
  // Guards double-clicks: handlers read stale closure state, so state alone
  // can't prevent a second dialog/run being started in the same frame.
  const requestInFlightRef = useRef(false);

  const errorDescription = (code?: string) => {
    switch (code) {
      case "EMPTY_FILE":
        return t("settings.granolaImport.error.EMPTY_FILE");
      case "HEADERS_UNRECOGNIZED":
        return t("settings.granolaImport.error.HEADERS_UNRECOGNIZED");
      case "NO_DATA_ROWS":
        return t("settings.granolaImport.error.NO_DATA_ROWS");
      case "FILE_TOO_LARGE":
        return t("settings.granolaImport.error.FILE_TOO_LARGE");
      default:
        return t("settings.granolaImport.error.generic");
    }
  };

  const showImportError = (code?: string) => {
    showAlertDialog({
      title: t("settings.granolaImport.error.title"),
      description: errorDescription(code),
    });
  };

  const handleChooseFile = async () => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setState({ phase: "picking" });
    try {
      let result:
        | Awaited<ReturnType<NonNullable<typeof window.electronAPI.granolaImportPickAndPreview>>>
        | undefined;
      try {
        result = await window.electronAPI?.granolaImportPickAndPreview?.();
      } catch {
        setState({ phase: "idle" });
        showImportError();
        return;
      }
      if (!result || result.canceled) {
        setState({ phase: "idle" });
        return;
      }
      if (!result.success) {
        setState({ phase: "idle" });
        showImportError(result.error);
        return;
      }
      setState({
        phase: "preview",
        preview: {
          total: result.total ?? 0,
          newCount: result.newCount ?? 0,
          duplicateCount: result.duplicateCount ?? 0,
          sampleTitles: result.sampleTitles ?? [],
          warningCount: result.rowIssueCount ?? 0,
        },
      });
    } finally {
      requestInFlightRef.current = false;
    }
  };

  const handleConfirm = async () => {
    if (state.phase !== "preview" || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setState({ phase: "importing", preview: state.preview });
    try {
      let result:
        Awaited<ReturnType<NonNullable<typeof window.electronAPI.granolaImportRun>>> | undefined;
      try {
        result = await window.electronAPI?.granolaImportRun?.();
      } catch {
        result = undefined;
      }
      if (!result?.success) {
        setState({ phase: "idle" });
        showImportError(result?.error);
        return;
      }
      const imported = result.imported ?? 0;
      setState({ phase: "done", imported, skipped: result.skipped ?? 0 });
      if (imported > 0) {
        // One refresh for the whole batch.
        void loadFolders();
        void initializeNotesTree();
      }
    } finally {
      requestInFlightRef.current = false;
    }
  };

  const dialogOpen =
    state.phase === "preview" || state.phase === "importing" || state.phase === "done";
  const preview = state.phase === "preview" || state.phase === "importing" ? state.preview : null;

  return (
    <div>
      <SectionHeader
        title={t("settings.granolaImport.title")}
        description={t("settings.granolaImport.howTo")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settings.granolaImport.title")}
            description={t("settings.granolaImport.description")}
          >
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={state.phase === "picking"}
              onClick={handleChooseFile}
            >
              {state.phase === "picking" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                t("settings.granolaImport.chooseFile")
              )}
            </Button>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && state.phase !== "importing") setState({ phase: "idle" });
        }}
      >
        <DialogContent className="sm:max-w-90">
          <DialogHeader>
            <DialogTitle>
              {state.phase === "done"
                ? t("settings.granolaImport.done.title")
                : t("settings.granolaImport.preview.title")}
            </DialogTitle>
            {state.phase === "done" ? (
              <DialogDescription>
                {t("settings.granolaImport.done.summary", {
                  imported: state.imported,
                  skipped: state.skipped,
                })}
              </DialogDescription>
            ) : (
              preview && (
                <DialogDescription>
                  {preview.newCount === 0
                    ? t("settings.granolaImport.preview.nothingNew")
                    : t("settings.granolaImport.preview.summary", {
                        total: preview.total,
                        newCount: preview.newCount,
                        duplicateCount: preview.duplicateCount,
                      })}
                </DialogDescription>
              )
            )}
          </DialogHeader>
          {preview && (
            <div className="space-y-2">
              {preview.sampleTitles.length > 0 && (
                <ul className="text-xs text-muted-foreground space-y-1">
                  {preview.sampleTitles.map((title, index) => (
                    <li key={`${index}-${title}`} className="truncate">
                      {title}
                    </li>
                  ))}
                </ul>
              )}
              {preview.warningCount > 0 && (
                <p className="text-xs text-muted-foreground/80">
                  {t("settings.granolaImport.preview.warnings", {
                    warningCount: preview.warningCount,
                  })}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            {state.phase === "done" ? (
              <Button size="sm" onClick={() => setState({ phase: "idle" })}>
                {t("common.close")}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.phase === "importing"}
                  onClick={() => setState({ phase: "idle" })}
                >
                  {t("common.cancel")}
                </Button>
                <Button size="sm" disabled={state.phase === "importing"} onClick={handleConfirm}>
                  {state.phase === "importing" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    t("settings.granolaImport.preview.confirm", {
                      newCount: preview?.newCount ?? 0,
                    })
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface TranscriptionSectionProps {
  cloudTranscriptionMode: string;
  setCloudTranscriptionMode: (mode: string) => void;
  useLocalWhisper: boolean;
  setUseLocalWhisper: (value: boolean) => void;
  updateTranscriptionSettings: (settings: { useLocalWhisper: boolean }) => void;
  cloudTranscriptionProvider: string;
  setCloudTranscriptionProvider: (provider: string) => void;
  cloudTranscriptionModel: string;
  setCloudTranscriptionModel: (model: string) => void;
  localTranscriptionProvider: string;
  setLocalTranscriptionProvider: (provider: LocalTranscriptionProvider) => void;
  whisperModel: string;
  setWhisperModel: (model: string) => void;
  parakeetModel: string;
  setParakeetModel: (model: string) => void;
  cohereModel: string;
  setCohereModel: (model: string) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl: (url: string) => void;
  transcriptionMode: InferenceMode;
  setTranscriptionMode: (mode: InferenceMode) => void;
  remoteTranscriptionUrl: string;
  setRemoteTranscriptionUrl: (url: string) => void;
  remoteTranscriptionModel: string;
  setRemoteTranscriptionModel: (model: string) => void;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
}

function TranscriptionSection({
  cloudTranscriptionMode,
  setCloudTranscriptionMode,
  useLocalWhisper,
  setUseLocalWhisper,
  updateTranscriptionSettings,
  cloudTranscriptionProvider,
  setCloudTranscriptionProvider,
  cloudTranscriptionModel,
  setCloudTranscriptionModel,
  localTranscriptionProvider,
  setLocalTranscriptionProvider,
  whisperModel,
  setWhisperModel,
  parakeetModel,
  setParakeetModel,
  cohereModel,
  setCohereModel,
  cloudTranscriptionBaseUrl,
  setCloudTranscriptionBaseUrl,
  transcriptionMode,
  setTranscriptionMode,
  remoteTranscriptionUrl,
  setRemoteTranscriptionUrl,
  remoteTranscriptionModel,
  setRemoteTranscriptionModel,
  toast,
}: TranscriptionSectionProps) {
  const { t } = useTranslation();
  const transcriptionModes: InferenceModeOption[] = [
    {
      id: "providers",
      label: t("settingsPage.transcription.modes.providers"),
      description: t("settingsPage.transcription.modes.providersDesc"),
      icon: <Key className="w-4 h-4" />,
    },
    {
      id: "local",
      label: t("settingsPage.transcription.modes.local"),
      description: t("settingsPage.transcription.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("settingsPage.transcription.modes.selfHosted"),
      description: t("settingsPage.transcription.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
  ];
  const effectiveTranscriptionMode = transcriptionMode;
  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (mode === effectiveTranscriptionMode) return;
    setTranscriptionMode(mode);
    setUseLocalWhisper(mode === "local");
    updateTranscriptionSettings({ useLocalWhisper: mode === "local" });
    setCloudTranscriptionMode("byok");

    const toastKey = {
      providers: "switchedProviders",
      local: "switchedLocal",
      "self-hosted": "switchedSelfHosted",
    }[mode];
    toast({
      title: t(`settingsPage.transcription.toasts.${toastKey}.title`),
      description: t(`settingsPage.transcription.toasts.${toastKey}.description`),
      variant: "success",
      duration: 3000,
    });
  };

  const handleLocalModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? localTranscriptionProvider;
      if (provider === "nvidia") {
        setParakeetModel(modelId);
      } else if (provider === "cohere") {
        setCohereModel(modelId);
      } else {
        setWhisperModel(modelId);
      }
    },
    [localTranscriptionProvider, setParakeetModel, setCohereModel, setWhisperModel]
  );

  const renderTranscriptionPicker = (mode?: "cloud" | "local") => (
    <TranscriptionModelPicker
      selectedCloudProvider={cloudTranscriptionProvider}
      onCloudProviderSelect={setCloudTranscriptionProvider}
      selectedCloudModel={cloudTranscriptionModel}
      onCloudModelSelect={setCloudTranscriptionModel}
      selectedLocalModel={
        localTranscriptionProvider === "nvidia"
          ? parakeetModel
          : localTranscriptionProvider === "cohere"
            ? cohereModel
            : whisperModel
      }
      onLocalModelSelect={handleLocalModelSelect}
      selectedLocalProvider={localTranscriptionProvider}
      onLocalProviderSelect={setLocalTranscriptionProvider}
      useLocalWhisper={mode === "local" || (!mode && useLocalWhisper)}
      onModeChange={
        mode
          ? noop
          : (isLocal) => {
              setUseLocalWhisper(isLocal);
              updateTranscriptionSettings({ useLocalWhisper: isLocal });
              if (isLocal) setCloudTranscriptionMode("byok");
            }
      }
      mode={mode}
      cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
      variant="settings"
    />
  );

  return (
    <div className="space-y-4">
      <InferenceModeSelector
        modes={transcriptionModes}
        activeMode={effectiveTranscriptionMode}
        onSelect={handleTranscriptionModeSelect}
      />

      {effectiveTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
      {effectiveTranscriptionMode === "local" && renderTranscriptionPicker("local")}

      {effectiveTranscriptionMode === "self-hosted" && (
        <SelfHostedPanel
          service="transcription"
          url={remoteTranscriptionUrl}
          onUrlChange={setRemoteTranscriptionUrl}
          model={remoteTranscriptionModel}
          onModelChange={setRemoteTranscriptionModel}
        />
      )}

      {/* Local decoding still serves meetings and uploads, so the GPU choice stays reachable. */}
      <GpuDeviceSelector purpose="transcription" />
    </div>
  );
}

type SpeechTab = "dictation" | "noteRecording";

const SPEECH_TABS: SpeechTab[] = ["dictation", "noteRecording"];

function useSubTab<T extends string>(storageKey: string, options: readonly T[], initial?: T) {
  const [tab, setTab] = useLocalStorage<T>(storageKey, initial ?? options[0]);
  useEffect(() => {
    if (initial && initial !== tab) setTab(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const safeTab = options.includes(tab) ? tab : options[0];
  return [safeTab, setTab] as const;
}

function VADLabelWithInfo({ label, description }: { label: string; description: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
      <span>{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground transition-colors"
            aria-label={label}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-w-sm p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div className={active ? undefined : "hidden"}>{children}</div>;
}

function SpeechToTextTabs({
  initialTab,
  renderDictation,
  renderNoteRecording,
}: {
  initialTab?: SpeechTab;
  renderDictation: () => React.ReactNode;
  renderNoteRecording: () => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useSubTab<SpeechTab>("settings.speechToTextTab", SPEECH_TABS, initialTab);

  const subTabs = [
    { id: "dictation", name: t("settingsPage.speechToText.tabs.dictation") },
    { id: "noteRecording", name: t("settingsPage.speechToText.tabs.noteRecording") },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.speechToText.title")}
        description={t("settingsPage.speechToText.description")}
      />
      <ProviderTabs
        providers={subTabs}
        selectedId={tab}
        onSelect={(id) => setTab(id as SpeechTab)}
        renderIcon={(id) =>
          id === "dictation" ? (
            <Mic className="w-3.5 h-3.5" />
          ) : (
            <FileAudio className="w-3.5 h-3.5" />
          )
        }
      />
      <TabPanel active={tab === "dictation"}>{renderDictation()}</TabPanel>
      <TabPanel active={tab === "noteRecording"}>{renderNoteRecording()}</TabPanel>
    </div>
  );
}

function GpuDeviceSelector({ purpose }: { purpose: "transcription" }) {
  const { t } = useTranslation();
  const [gpus, setGpus] = useState<GpuDevice[]>([]);
  const [selectedUuid, setSelectedUuid] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      window.electronAPI?.listGpus?.() ?? Promise.resolve([]),
      window.electronAPI?.getGpuDeviceIndex?.(purpose) ?? Promise.resolve(""),
    ])
      .then(([gpuList, savedUuid]) => {
        setGpus(gpuList);
        setSelectedUuid(savedUuid || gpuList[0]?.uuid || "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [purpose]);

  if (!loaded || gpus.length < 2) return null;

  return (
    <div className="border-t border-border/70 pt-4 mt-4">
      <SectionHeader
        title={t(`settingsPage.${purpose}.gpuDevice.title`)}
        description={t(`settingsPage.${purpose}.gpuDevice.description`)}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <div className="relative w-full">
            <select
              value={selectedUuid}
              onChange={async (e) => {
                const uuid = e.target.value;
                setSelectedUuid(uuid);
                await window.electronAPI?.setGpuDeviceIndex?.(purpose, uuid);
              }}
              className="w-full appearance-none rounded-md border border-border bg-background px-3 pe-10 py-2 text-sm"
            >
              {gpus.map((gpu) => (
                <option key={gpu.uuid} value={gpu.uuid}>
                  GPU {gpu.index}: {gpu.name} ({Math.round(gpu.vramMb / 1024)}GB)
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}

export default function SettingsPage({
  activeSection = "general",
  onNavigateToSection,
  initialSubTab,
}: SettingsPageProps) {
  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    cohereModel,
    uiLanguage,
    preferredLanguage,
    chineseScriptPreference,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    microphoneSelectionMode,
    selectedMicDeviceId,
    selectedMicDeviceLabel,
    setMicrophoneSelectionMode,
    setSelectedMicDevice,
    setUseLocalWhisper,
    setUiLanguage,
    setWhisperModel,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setCohereModel,
    setCloudTranscriptionProvider,
    setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl,
    meetingHotkeyLayoutMode,
    setMeetingHotkeyLayoutMode,
    updateTranscriptionSettings,
    cloudTranscriptionMode,
    setCloudTranscriptionMode,
    transcriptionMode,
    setTranscriptionMode,
    remoteTranscriptionUrl,
    setRemoteTranscriptionUrl,
    remoteTranscriptionModel,
    setRemoteTranscriptionModel,
    notificationsEnabled,
    setNotificationsEnabled,
    notifyMeetingDetection,
    setNotifyMeetingDetection,
    notifyCalendarReminders,
    setNotifyCalendarReminders,
    autoUpdatesEnabled,
    setAutoUpdatesEnabled,
    startMinimized,
    setStartMinimized,
    noteFilesEnabled,
    setNoteFilesEnabled,
    noteFilesPath,
    setNoteFilesPath,
    dictationSileroEnabled,
    setDictationSileroEnabled,
    noteRecordingSileroEnabled,
    setNoteRecordingSileroEnabled,
    meetingSileroEnabled,
    setMeetingSileroEnabled,
    whisperVadThreshold,
    setWhisperVadThreshold,
    whisperVadMinSpeechDurationMs,
    setWhisperVadMinSpeechDurationMs,
    whisperVadMinSilenceDurationMs,
    setWhisperVadMinSilenceDurationMs,
    whisperVadMaxSpeechDurationS,
    setWhisperVadMaxSpeechDurationS,
    whisperVadSpeechPadMs,
    setWhisperVadSpeechPadMs,
    whisperVadSamplesOverlap,
    setWhisperVadSamplesOverlap,
  } = useSettings();

  const meetingProcessDetection = useSettingsStore((state) => state.meetingProcessDetection);

  const { t } = useTranslation();
  const { toast } = useToast();

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isRemovingModels, setIsRemovingModels] = useState(false);
  const [cachePathHint, setCachePathHint] = useState(
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "%USERPROFILE%\\.cache\\openwhispr"
      : "~/.cache/openwhispr"
  );
  useEffect(() => {
    window.electronAPI
      ?.getModelCacheRoot?.()
      .then((root) => {
        if (root) setCachePathHint(root);
      })
      .catch(() => {});
  }, []);

  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress: updateDownloadProgress,
    isChecking: checkingForUpdates,
    isDownloading: downloadingUpdate,
    isInstalling: installInitiated,
    checkForUpdates,
    downloadUpdate,
    installUpdate: installUpdateAction,
    getAppVersion,
  } = useUpdater();

  const isUpdateAvailable =
    !updateStatus.isDevelopment && (updateStatus.updateAvailable || updateStatus.updateDownloaded);

  const { checkWhisperInstallation } = useWhisper();
  const permissionsHook = usePermissions(showAlertDialog);
  const systemAudio = useSystemAudioPermission();
  useClipboard(showAlertDialog);
  // Lazy keep-alive: mount AI sections only after the user has visited them once,
  // then keep them mounted so model-download progress and IPC listeners survive
  // section switches. The setState-during-render pattern flips the flag in the
  // same commit as the section change, so there's no blank frame on first visit.
  const [hasMountedSpeechToText, setHasMountedSpeechToText] = useState(
    activeSection === "speechToText"
  );
  if (activeSection === "speechToText" && !hasMountedSpeechToText) {
    setHasMountedSpeechToText(true);
  }

  const { theme, setTheme } = useTheme();
  const installTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartNeedsApproval, setAutoStartNeedsApproval] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

  const readAutoStartState = useCallback(async () => {
    if (!window.electronAPI?.getAutoStartEnabled) return;
    try {
      const state = await window.electronAPI.getAutoStartEnabled();
      setAutoStartEnabled(state.enabled);
      setAutoStartNeedsApproval(state.requiresApproval);
    } catch (error) {
      logger.error("Failed to get auto-start status", error, "settings");
    }
  }, []);

  useEffect(() => {
    readAutoStartState().finally(() => setAutoStartLoading(false));
  }, [readAutoStartState]);

  useEffect(() => {
    window.electronAPI?.syncNotificationPreferences?.({
      notificationsEnabled,
      notifyMeetingDetection,
      notifyCalendarReminders,
      meetingProcessDetection,
    });
  }, [
    notificationsEnabled,
    notifyMeetingDetection,
    notifyCalendarReminders,
    meetingProcessDetection,
  ]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (!window.electronAPI?.setAutoStartEnabled) return;
    try {
      setAutoStartLoading(true);
      const result = await window.electronAPI.setAutoStartEnabled(enabled);
      // Read the state back rather than assuming: on Windows the OS can have the
      // item disabled out from under us, and on macOS it can need approval first.
      if (result.success) await readAutoStartState();
    } catch (error) {
      logger.error("Failed to set auto-start", error, "settings");
    } finally {
      setAutoStartLoading(false);
    }
  };

  const [noteFilesDefaultPath, setNoteFilesDefaultPath] = useState("");
  const [noteFilesRebuilding, setNoteFilesRebuilding] = useState(false);

  useEffect(() => {
    if (!noteFilesEnabled) return;
    window.electronAPI?.noteFilesGetDefaultPath?.().then((p) => {
      if (p) setNoteFilesDefaultPath(p);
    });
  }, [noteFilesEnabled]);

  const handleNoteFilesToggle = useCallback(
    async (enabled: boolean) => {
      setNoteFilesEnabled(enabled);
      await window.electronAPI?.noteFilesSetEnabled?.(enabled, noteFilesPath || undefined);
    },
    [setNoteFilesEnabled, noteFilesPath]
  );

  const handleNoteFilesChangePath = useCallback(async () => {
    const result = await window.electronAPI?.noteFilesPickFolder?.();
    if (result?.canceled || !result?.path) return;
    setNoteFilesPath(result.path);
    await window.electronAPI?.noteFilesSetPath?.(result.path);
  }, [setNoteFilesPath]);

  const handleNoteFilesRebuild = useCallback(async () => {
    setNoteFilesRebuilding(true);
    try {
      const result = await window.electronAPI?.noteFilesRebuild?.();
      if (result && !result.success) {
        toast({
          title: t("settings.noteFiles.rebuildError.title"),
          description: result.error || t("settings.noteFiles.rebuildError.description"),
          variant: "destructive",
        });
      }
    } finally {
      setNoteFilesRebuilding(false);
    }
  }, [toast, t]);

  useEffect(() => {
    let mounted = true;

    const timer = setTimeout(async () => {
      if (!mounted) return;

      const version = await getAppVersion();
      if (version && mounted) setCurrentVersion(version);

      if (mounted) {
        checkWhisperInstallation();
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [checkWhisperInstallation, getAppVersion]);

  useEffect(() => {
    if (installInitiated) {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
      }
      installTimeoutRef.current = setTimeout(() => {
        showAlertDialog({
          title: t("settingsPage.general.updates.dialogs.almostThere.title"),
          description: t("settingsPage.general.updates.dialogs.almostThere.description"),
        });
      }, 10000);
    } else if (installTimeoutRef.current) {
      clearTimeout(installTimeoutRef.current);
      installTimeoutRef.current = null;
    }

    return () => {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
        installTimeoutRef.current = null;
      }
    };
  }, [installInitiated, showAlertDialog, t]);

  const handleRemoveModels = useCallback(() => {
    if (isRemovingModels) return;

    showConfirmDialog({
      title: t("settingsPage.developer.removeModels.title"),
      description: t("settingsPage.developer.removeModels.description", { path: cachePathHint }),
      confirmText: t("settingsPage.developer.removeModels.confirmText"),
      variant: "destructive",
      onConfirm: async () => {
        setIsRemovingModels(true);
        try {
          const results = await Promise.allSettled([
            window.electronAPI?.deleteAllWhisperModels?.(),
            window.electronAPI?.deleteAllParakeetModels?.(),
          ]);

          const anyFailed = results.some(
            (r) =>
              r.status === "rejected" || (r.status === "fulfilled" && r.value && !r.value.success)
          );

          if (anyFailed) {
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.failedTitle"),
              description: t("settingsPage.developer.removeModels.failedDescription"),
            });
          } else {
            window.dispatchEvent(new Event("openwhispr-models-cleared"));
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.successTitle"),
              description: t("settingsPage.developer.removeModels.successDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("settingsPage.developer.removeModels.failedTitle"),
            description: t("settingsPage.developer.removeModels.failedDescriptionShort"),
          });
        } finally {
          setIsRemovingModels(false);
        }
      },
    });
  }, [isRemovingModels, cachePathHint, showConfirmDialog, showAlertDialog, t]);

  const renderWhisperVadSettings = () => (
    <div>
      <SectionHeader
        title={t("settingsPage.transcription.vad.title")}
        description={t("settingsPage.transcription.vad.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.dictation.title")}
            description={t("settingsPage.transcription.vad.toggles.dictation.description")}
          >
            <Toggle checked={dictationSileroEnabled} onChange={setDictationSileroEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.noteRecording.title")}
            description={t("settingsPage.transcription.vad.toggles.noteRecording.description")}
          >
            <Toggle checked={noteRecordingSileroEnabled} onChange={setNoteRecordingSileroEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.meeting.title")}
            description={t("settingsPage.transcription.vad.toggles.meeting.description")}
          >
            <Toggle checked={meetingSileroEnabled} onChange={setMeetingSileroEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.threshold.label")}
                description={t("settingsPage.transcription.vad.fields.threshold.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="0.01"
                min="0.1"
                max="0.95"
                value={whisperVadThreshold}
                onChange={(e) => setWhisperVadThreshold(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.minSpeechDurationMs.label")}
                description={t("settingsPage.transcription.vad.fields.minSpeechDurationMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="50"
                max="2000"
                value={whisperVadMinSpeechDurationMs}
                onChange={(e) => setWhisperVadMinSpeechDurationMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.minSilenceDurationMs.label")}
                description={t("settingsPage.transcription.vad.fields.minSilenceDurationMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="50"
                max="2000"
                value={whisperVadMinSilenceDurationMs}
                onChange={(e) => setWhisperVadMinSilenceDurationMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.maxSpeechDurationS.label")}
                description={t("settingsPage.transcription.vad.fields.maxSpeechDurationS.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="1"
                min="5"
                max="120"
                value={whisperVadMaxSpeechDurationS}
                onChange={(e) => setWhisperVadMaxSpeechDurationS(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.speechPadMs.label")}
                description={t("settingsPage.transcription.vad.fields.speechPadMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="0"
                max="1000"
                value={whisperVadSpeechPadMs}
                onChange={(e) => setWhisperVadSpeechPadMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.samplesOverlap.label")}
                description={t("settingsPage.transcription.vad.fields.samplesOverlap.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="0.01"
                min="0"
                max="0.95"
                value={whisperVadSamplesOverlap}
                onChange={(e) => setWhisperVadSamplesOverlap(Number(e.target.value))}
              />
            </div>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );

  const renderSectionContent = () => {
    switch (activeSection) {
      case "general":
        return (
          <div className="space-y-6">
            {/* Appearance */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.appearance.title")}
                description={t("settingsPage.general.appearance.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.appearance.theme")}
                    description={t("settingsPage.general.appearance.themeDescription")}
                  >
                    <div className="inline-flex items-center gap-px p-0.5 bg-muted/60 dark:bg-surface-2 rounded-md">
                      {(
                        [
                          {
                            value: "light",
                            icon: Sun,
                            label: t("settingsPage.general.appearance.light"),
                          },
                          {
                            value: "dark",
                            icon: Moon,
                            label: t("settingsPage.general.appearance.dark"),
                          },
                          {
                            value: "auto",
                            icon: Monitor,
                            label: t("settingsPage.general.appearance.auto"),
                          },
                        ] as const
                      ).map((option) => {
                        const Icon = option.icon;
                        const isSelected = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => setTheme(option.value)}
                            className={`
                              flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-xs font-medium
                              transition-colors duration-100
                              ${
                                isSelected
                                  ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              }
                            `}
                          >
                            <Icon className={`w-3 h-3 ${isSelected ? "text-primary" : ""}`} />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Notifications */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.notifications.title")}
                description={t("settingsPage.general.notifications.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.disableAll")}
                    description={t("settingsPage.general.notifications.disableAllDescription")}
                  >
                    <Toggle
                      checked={!notificationsEnabled}
                      onChange={(v) => setNotificationsEnabled(!v)}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.meetingDetection")}
                    description={t(
                      "settingsPage.general.notifications.meetingDetectionDescription"
                    )}
                  >
                    <Toggle
                      checked={notifyMeetingDetection}
                      onChange={setNotifyMeetingDetection}
                      disabled={!notificationsEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.notifications.calendarReminders")}
                    description={t(
                      "settingsPage.general.notifications.calendarRemindersDescription"
                    )}
                  >
                    <Toggle
                      checked={notifyCalendarReminders}
                      onChange={setNotifyCalendarReminders}
                      disabled={!notificationsEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Save Notes as Files */}
            <div>
              <SectionHeader title={t("settings.noteFiles.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.noteFiles.title")}
                    description={t("settings.noteFiles.description")}
                  >
                    <Toggle checked={noteFilesEnabled} onChange={handleNoteFilesToggle} />
                  </SettingsRow>
                </SettingsPanelRow>
                {noteFilesEnabled && (
                  <>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settings.noteFiles.path")}
                        description={
                          <span dir="ltr" className="block break-all">
                            {noteFilesPath || noteFilesDefaultPath || "..."}
                          </span>
                        }
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={handleNoteFilesChangePath}
                        >
                          {t("settings.noteFiles.changePath")}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settings.noteFiles.rebuild")}
                        description={t("settings.noteFiles.rebuildDescription")}
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={noteFilesRebuilding}
                          onClick={handleNoteFilesRebuild}
                        >
                          {noteFilesRebuilding ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            t("settings.noteFiles.rebuild")
                          )}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </>
                )}
              </SettingsPanel>
            </div>

            {/* Import from Granola */}
            <GranolaImportSection showAlertDialog={showAlertDialog} />

            {/* Meeting layout */}
            <div>
              <SettingsPanel>
                <SettingsPanelRow className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground/80">
                    {t("settingsPage.general.meetingHotkey.layoutLabel")}
                  </span>
                  <Select
                    value={meetingHotkeyLayoutMode}
                    onValueChange={(value) =>
                      setMeetingHotkeyLayoutMode(value as "side-panel" | "full-width")
                    }
                  >
                    <SelectTrigger className="h-7 w-36 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        value="full-width"
                        className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                      >
                        {t("settingsPage.general.meetingHotkey.layoutFullWidth")}
                      </SelectItem>
                      <SelectItem
                        value="side-panel"
                        className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                      >
                        {t("settingsPage.general.meetingHotkey.layoutSidePanel")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Language */}
            <div>
              <SectionHeader
                title={t("settings.language.sectionTitle")}
                description={t("settings.language.sectionDescription")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.transcriptionLabel")}
                    description={t("settings.language.transcriptionDescription")}
                  >
                    <LanguageSelector
                      value={preferredLanguage}
                      onChange={(value) =>
                        updateTranscriptionSettings({ preferredLanguage: value })
                      }
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                {preferredLanguage === "auto" && (
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settings.language.chineseScriptLabel")}
                      description={t("settings.language.chineseScriptDescription")}
                    >
                      <Select
                        value={chineseScriptPreference}
                        onValueChange={(value: ChineseScriptPreference) =>
                          updateTranscriptionSettings({ chineseScriptPreference: value })
                        }
                      >
                        <SelectTrigger className="h-7 w-44 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="as-transcribed">
                            {t("settings.language.chineseScriptAsTranscribed")}
                          </SelectItem>
                          <SelectItem value="simplified">
                            {t("settings.language.chineseScriptSimplified")}
                          </SelectItem>
                          <SelectItem value="traditional">
                            {t("settings.language.chineseScriptTraditional")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingsRow>
                  </SettingsPanelRow>
                )}
              </SettingsPanel>
            </div>

            {/* Startup */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.startup.title")}
                description={t("settingsPage.general.startup.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.startup.launchAtLogin")}
                    description={t("settingsPage.general.startup.launchAtLoginDescription")}
                  >
                    <Toggle
                      checked={autoStartEnabled}
                      onChange={(checked: boolean) => handleAutoStartChange(checked)}
                      disabled={autoStartLoading}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                {autoStartNeedsApproval && (
                  <SettingsPanelRow>
                    <Alert
                      variant="warning"
                      className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
                    >
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>
                        {t("settingsPage.general.startup.needsApproval.title")}
                      </AlertTitle>
                      <AlertDescription className="space-y-2">
                        <p>{t("settingsPage.general.startup.needsApproval.description")}</p>
                        <Button
                          onClick={() => void window.electronAPI?.openLoginItemsSettings?.()}
                          variant="outline"
                          size="sm"
                        >
                          {t("settingsPage.general.startup.needsApproval.action")}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  </SettingsPanelRow>
                )}
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.startup.startMinimized")}
                    description={t("settingsPage.general.startup.startMinimizedDescription")}
                  >
                    <Toggle checked={startMinimized} onChange={setStartMinimized} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Microphone */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.microphone.title")}
                description={t("settingsPage.general.microphone.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <MicrophoneSettings
                    microphoneSelectionMode={microphoneSelectionMode}
                    selectedMicDeviceId={selectedMicDeviceId}
                    selectedMicDeviceLabel={selectedMicDeviceLabel}
                    onSelectionModeChange={setMicrophoneSelectionMode}
                    onDeviceSelect={setSelectedMicDevice}
                  />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "speechToText":
        return null;

      case "privacyData":
        return (
          <div className="space-y-6">
            {/* Permissions */}
            <div>
              <SectionHeader
                title={t("settingsPage.permissions.title")}
                description={t("settingsPage.permissions.description")}
              />

              <div className="space-y-3">
                <PermissionCard
                  icon={Mic}
                  title={t("settingsPage.permissions.microphoneTitle")}
                  description={t("settingsPage.permissions.microphoneDescription")}
                  granted={permissionsHook.micPermissionGranted}
                  onRequest={permissionsHook.requestMicPermission}
                  buttonText={t("settingsPage.permissions.grantAccess")}
                />

                {canManageSystemAudioInApp(systemAudio) && (
                  <PermissionCard
                    icon={Monitor}
                    title={t("settingsPage.permissions.systemAudioTitle")}
                    description={t("settingsPage.permissions.systemAudioDescription")}
                    granted={systemAudio.granted}
                    onRequest={systemAudio.request}
                    buttonText={t("settingsPage.permissions.grantAccess")}
                    badge={t("settingsPage.permissions.optional")}
                  />
                )}
              </div>

              {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
                <MicPermissionWarning
                  error={permissionsHook.micPermissionError}
                  onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                  onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
                />
              )}
            </div>
          </div>
        );

      case "system":
        return (
          <div className="space-y-6">
            {/* Software Updates */}
            <div>
              <SectionHeader title={t("settingsPage.general.updates.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.updates.currentVersion")}
                    description={
                      updateStatus.isDevelopment
                        ? t("settingsPage.general.updates.devMode")
                        : !updateStatus.isSupported
                          ? t("settingsPage.general.updates.managedByPackageManager")
                          : isUpdateAvailable
                            ? t("settingsPage.general.updates.newVersionAvailable")
                            : t("settingsPage.general.updates.latestVersion")
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        dir="ltr"
                        className="text-xs tabular-nums text-muted-foreground font-mono"
                      >
                        {currentVersion || t("settingsPage.general.updates.versionPlaceholder")}
                      </span>
                      {updateStatus.isDevelopment ? (
                        <Badge variant="warning">
                          {t("settingsPage.general.updates.badges.dev")}
                        </Badge>
                      ) : isUpdateAvailable ? (
                        <Badge variant="success">
                          {t("settingsPage.general.updates.badges.update")}
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          {t("settingsPage.general.updates.badges.latest")}
                        </Badge>
                      )}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>

                {updateStatus.isSupported && (
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.general.updates.automaticUpdates")}
                      description={t("settingsPage.general.updates.automaticUpdatesDescription")}
                    >
                      <Toggle checked={autoUpdatesEnabled} onChange={setAutoUpdatesEnabled} />
                    </SettingsRow>
                  </SettingsPanelRow>
                )}

                <SettingsPanelRow>
                  <div className="space-y-2.5">
                    <Button
                      onClick={async () => {
                        try {
                          const result = await checkForUpdates();
                          if (result && !result.updateAvailable) {
                            toast({
                              title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
                              description: t(
                                "settingsPage.general.updates.dialogs.noUpdates.description"
                              ),
                            });
                          }
                        } catch {
                          showAlertDialog({
                            title: t("settingsPage.general.updates.dialogs.checkFailed.title"),
                            description: t(
                              "settingsPage.general.updates.dialogs.checkFailed.description"
                            ),
                          });
                        }
                      }}
                      disabled={
                        checkingForUpdates ||
                        updateStatus.isDevelopment ||
                        !updateStatus.isSupported
                      }
                      variant="outline"
                      className="w-full"
                      size="sm"
                    >
                      <RefreshCw
                        size={13}
                        className={`me-1.5 ${checkingForUpdates ? "animate-spin" : ""}`}
                      />
                      {checkingForUpdates
                        ? t("settingsPage.general.updates.checking")
                        : t("settingsPage.general.updates.checkForUpdates")}
                    </Button>

                    {isUpdateAvailable && !updateStatus.updateDownloaded && (
                      <div className="space-y-2">
                        <Button
                          onClick={async () => {
                            try {
                              await downloadUpdate();
                            } catch {
                              showAlertDialog({
                                title: t(
                                  "settingsPage.general.updates.dialogs.downloadFailed.title"
                                ),
                                description: t(
                                  "settingsPage.general.updates.dialogs.downloadFailed.description"
                                ),
                              });
                            }
                          }}
                          disabled={downloadingUpdate}
                          variant="success"
                          className="w-full"
                          size="sm"
                        >
                          <Download
                            size={13}
                            className={`me-1.5 ${downloadingUpdate ? "animate-pulse" : ""}`}
                          />
                          {downloadingUpdate
                            ? t("settingsPage.general.updates.downloading", {
                                progress: Math.round(updateDownloadProgress),
                              })
                            : t("settingsPage.general.updates.downloadUpdate", {
                                version: updateInfo?.version || "",
                              })}
                        </Button>

                        {downloadingUpdate && (
                          <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50">
                            <div
                              className="h-full bg-success transition-[width] duration-200 rounded-full"
                              style={{
                                width: `${Math.min(100, Math.max(0, updateDownloadProgress))}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {updateStatus.updateDownloaded && (
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.general.updates.dialogs.installUpdate.title"),
                            description: t(
                              "settingsPage.general.updates.dialogs.installUpdate.description",
                              { version: updateInfo?.version || "" }
                            ),
                            confirmText: t(
                              "settingsPage.general.updates.dialogs.installUpdate.confirmText"
                            ),
                            onConfirm: async () => {
                              try {
                                await installUpdateAction();
                              } catch {
                                showAlertDialog({
                                  title: t(
                                    "settingsPage.general.updates.dialogs.installFailed.title"
                                  ),
                                  description: t(
                                    "settingsPage.general.updates.dialogs.installFailed.description"
                                  ),
                                });
                              }
                            },
                          });
                        }}
                        disabled={installInitiated}
                        className="w-full"
                        size="sm"
                      >
                        <RefreshCw
                          size={14}
                          className={`me-2 ${installInitiated ? "animate-spin" : ""}`}
                        />
                        {installInitiated
                          ? t("settingsPage.general.updates.restarting")
                          : t("settingsPage.general.updates.installAndRestart")}
                      </Button>
                    )}
                  </div>

                  {updateInfo?.releaseNotes && (
                    <div className="mt-4 pt-4 border-t border-border/70">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        <BidiInterpolatedText
                          text={t("settingsPage.general.updates.whatsNew", {
                            version: BIDI_VALUE_TOKEN,
                          })}
                          value={updateInfo.version}
                        />
                      </p>
                      <div
                        className="text-xs text-muted-foreground [&_ul]:list-disc [&_ul]:ps-4 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:ps-4 [&_ol]:space-y-1 [&_li]:ps-1 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:text-link [&_a]:underline"
                        dangerouslySetInnerHTML={{ __html: updateInfo.releaseNotes }}
                      />
                    </div>
                  )}
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Developer Tools */}
            <div className="border-t border-border/70 pt-6">
              <DeveloperSection />
            </div>

            {/* Data Management */}
            <div className="border-t border-border/70 pt-6">
              <SectionHeader
                title={t("settingsPage.developer.dataManagementTitle")}
                description={t("settingsPage.developer.dataManagementDescription")}
              />

              <div className="space-y-4">
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.modelCache")}
                      description={
                        <span dir="ltr" className="block break-all">
                          {cachePathHint}
                        </span>
                      }
                    >
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.electronAPI?.openWhisperModelsFolder?.()}
                        >
                          <FolderOpen className="me-1.5 h-3.5 w-3.5" />
                          {t("settingsPage.developer.open")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveModels}
                          disabled={isRemovingModels}
                        >
                          {isRemovingModels
                            ? t("settingsPage.developer.removing")
                            : t("settingsPage.developer.clearCache")}
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.resetAppData")}
                      description={t("settingsPage.developer.resetAppDataDescription")}
                    >
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.developer.resetAll.title"),
                            description: t("settingsPage.developer.resetAll.description"),
                            onConfirm: async () => {
                              try {
                                await window.electronAPI?.cleanupApp();
                                showAlertDialog({
                                  title: t("settingsPage.developer.resetAll.successTitle"),
                                  description: t(
                                    "settingsPage.developer.resetAll.successDescription"
                                  ),
                                });
                                setTimeout(() => window.electronAPI?.relaunchApp(), 1000);
                              } catch {
                                showAlertDialog({
                                  title: t("settingsPage.developer.resetAll.failedTitle"),
                                  description: t(
                                    "settingsPage.developer.resetAll.failedDescription"
                                  ),
                                });
                              }
                            },
                            variant: "destructive",
                            confirmText: t("settingsPage.developer.resetAll.confirmText"),
                          });
                        }}
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        {t("common.reset")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Mounted on first visit and kept alive so model-download progress and IPC listeners survive section switches. */}
      {hasMountedSpeechToText && (
        <TabPanel active={activeSection === "speechToText"}>
          <SpeechToTextTabs
            initialTab={
              activeSection === "speechToText"
                ? (initialSubTab as SpeechTab | undefined)
                : undefined
            }
            renderDictation={() => (
              <div className="space-y-6">
                <TranscriptionSection
                  cloudTranscriptionMode={cloudTranscriptionMode}
                  setCloudTranscriptionMode={setCloudTranscriptionMode}
                  useLocalWhisper={useLocalWhisper}
                  setUseLocalWhisper={setUseLocalWhisper}
                  updateTranscriptionSettings={updateTranscriptionSettings}
                  cloudTranscriptionProvider={cloudTranscriptionProvider}
                  setCloudTranscriptionProvider={setCloudTranscriptionProvider}
                  cloudTranscriptionModel={cloudTranscriptionModel}
                  setCloudTranscriptionModel={setCloudTranscriptionModel}
                  localTranscriptionProvider={localTranscriptionProvider}
                  setLocalTranscriptionProvider={setLocalTranscriptionProvider}
                  whisperModel={whisperModel}
                  setWhisperModel={setWhisperModel}
                  parakeetModel={parakeetModel}
                  setParakeetModel={setParakeetModel}
                  cohereModel={cohereModel}
                  setCohereModel={setCohereModel}
                  cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
                  setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
                  transcriptionMode={transcriptionMode}
                  setTranscriptionMode={setTranscriptionMode}
                  remoteTranscriptionUrl={remoteTranscriptionUrl}
                  setRemoteTranscriptionUrl={setRemoteTranscriptionUrl}
                  remoteTranscriptionModel={remoteTranscriptionModel}
                  setRemoteTranscriptionModel={setRemoteTranscriptionModel}
                  toast={toast}
                />
                {transcriptionMode === "local" &&
                  localTranscriptionProvider === "whisper" &&
                  renderWhisperVadSettings()}
              </div>
            )}
            renderNoteRecording={() => (
              <div className="space-y-6">
                <MeetingTranscriptionPanel />
                {transcriptionMode === "local" &&
                  localTranscriptionProvider === "whisper" &&
                  renderWhisperVadSettings()}
              </div>
            )}
          />
        </TabPanel>
      )}
      {renderSectionContent()}
    </>
  );
}
