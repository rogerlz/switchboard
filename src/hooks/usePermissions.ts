import { useState, useCallback, useEffect } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useLocalStorage } from "./useLocalStorage";
import logger from "../utils/logger";

export interface UsePermissionsReturn {
  // State
  micPermissionGranted: boolean;
  micPermissionError: string | null;

  requestMicPermission: () => Promise<void>;
  openMicPrivacySettings: () => Promise<void>;
  openSoundInputSettings: () => Promise<void>;
  setMicPermissionGranted: (granted: boolean) => void;
}

export interface UsePermissionsProps {
  showAlertDialog: (dialog: { title: string; description?: string }) => void;
}

const stopTracks = (stream?: MediaStream) => {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // ignore track cleanup errors
  }
};

const getPlatformSettingsPath = (t: TFunction): string => {
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) return t("hooks.permissions.paths.windowsMicrophone");
    if (ua.includes("linux")) return t("hooks.permissions.paths.linuxSound");
  }
  return t("hooks.permissions.paths.defaultSound");
};

const getPlatformPrivacyPath = (t: TFunction): string => {
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) return t("hooks.permissions.paths.windowsMicrophone");
    if (ua.includes("linux")) return t("hooks.permissions.paths.linuxPrivacy");
  }
  return t("hooks.permissions.paths.defaultPrivacy");
};

const getPlatform = (): "darwin" | "win32" | "linux" => {
  if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
    const platform = window.electronAPI.getPlatform();
    if (platform === "darwin" || platform === "win32" || platform === "linux") {
      return platform;
    }
  }
  // Fallback to user agent detection
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "darwin";
    if (ua.includes("win")) return "win32";
    if (ua.includes("linux")) return "linux";
  }
  return "darwin"; // Default fallback
};

const describeMicError = (error: unknown, t: TFunction): string => {
  if (!error || typeof error !== "object") {
    return t("hooks.permissions.micErrors.accessFailed");
  }

  const err = error as { name?: string; message?: string };
  const name = err.name || "";
  const message = (err.message || "").toLowerCase();
  const settingsPath = getPlatformSettingsPath(t);
  const privacyPath = getPlatformPrivacyPath(t);

  if (name === "NotFoundError") {
    return t("hooks.permissions.micErrors.noMicrophones", { settingsPath });
  }

  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("hooks.permissions.micErrors.permissionDenied", { privacyPath });
  }

  if (name === "NotReadableError" || name === "AbortError") {
    return t("hooks.permissions.micErrors.couldNotStart", { settingsPath });
  }

  if (message.includes("no audio input") || message.includes("not available")) {
    return t("hooks.permissions.micErrors.noActiveInput", { settingsPath });
  }

  return t("hooks.permissions.micErrors.unknown", {
    error: err.message || t("hooks.permissions.micErrors.unknownFallback"),
  });
};

export const usePermissions = (
  showAlertDialog?: UsePermissionsProps["showAlertDialog"]
): UsePermissionsReturn => {
  const { t } = useTranslation();
  const [micPermissionGranted, setMicPermissionGranted] = useLocalStorage(
    "micPermissionGranted",
    false
  );
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);

  const openSystemSettings = useCallback(
    async (
      settingType: "microphone" | "sound",
      apiMethod: () => Promise<{ success: boolean; error?: string } | undefined> | undefined
    ) => {
      const titles = {
        microphone: t("hooks.permissions.settingsTitles.microphone"),
        sound: t("hooks.permissions.settingsTitles.sound"),
      };
      const unableToOpenDescriptions = {
        microphone: t("hooks.permissions.settingsErrors.unableToOpenMicrophone"),
        sound: t("hooks.permissions.settingsErrors.unableToOpenSound"),
      };
      try {
        const result = await apiMethod?.();
        if (result && !result.success && result.error) {
          showAlertDialog?.({ title: titles[settingType], description: result.error });
        }
      } catch (error) {
        logger.error(`Failed to open ${settingType} settings:`, error);
        showAlertDialog?.({
          title: titles[settingType],
          description: unableToOpenDescriptions[settingType],
        });
      }
    },
    [showAlertDialog, t]
  );

  const openMicPrivacySettings = useCallback(
    () => openSystemSettings("microphone", window.electronAPI?.openMicrophoneSettings),
    [openSystemSettings]
  );

  const openSoundInputSettings = useCallback(
    () => openSystemSettings("sound", window.electronAPI?.openSoundInputSettings),
    [openSystemSettings]
  );

  const requestMicPermission = useCallback(async () => {
    if (!navigator?.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      const message = t("hooks.permissions.micUnavailable");
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphoneUnavailable"),
          description: message,
        });
      } else {
        alert(message);
      }
      return;
    }

    setMicPermissionError(null);

    try {
      // macOS hardened runtime requires main-process mic prompt before getUserMedia works
      if (window.electronAPI?.requestMicrophoneAccess) {
        try {
          await window.electronAPI.requestMicrophoneAccess();
        } catch {
          // ignored — getUserMedia below will surface the error
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopTracks(stream);
      setMicPermissionGranted(true);
      setMicPermissionError(null);
    } catch (err) {
      logger.error("Microphone permission denied:", err);
      const message = describeMicError(err, t);
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphonePermissionRequired"),
          description: message,
        });
      } else {
        alert(message);
      }
    }
  }, [showAlertDialog, t, setMicPermissionGranted]);

  // On macOS, re-validate microphone permission on mount to override stale
  // localStorage values (e.g. after TCC reset or app update).
  useEffect(() => {
    if (getPlatform() !== "darwin") return;
    window.electronAPI?.checkMicrophoneAccess?.().then((result) => {
      if (result) setMicPermissionGranted(result.granted);
    });
  }, [setMicPermissionGranted]);

  return {
    micPermissionGranted,
    micPermissionError,
    requestMicPermission,
    openMicPrivacySettings,
    openSoundInputSettings,
    setMicPermissionGranted,
  };
};
