import { useState, useCallback, useEffect, useRef } from "react";
import type { SystemAudioAccessResult } from "../types/electron";
import { DEFAULT_SYSTEM_AUDIO_ACCESS } from "../utils/systemAudioAccess";

export function useSystemAudioPermission() {
  const [access, setAccess] = useState<SystemAudioAccessResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setIsChecking(true);
    try {
      const result = await window.electronAPI?.checkSystemAudioAccess?.();
      setAccess(result ?? DEFAULT_SYSTEM_AUDIO_ACCESS);
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
    const handleFocus = () => check();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [check]);

  const openSettings = useCallback(async () => {
    await window.electronAPI?.openSystemAudioSettings?.();
  }, []);

  const request = useCallback(async (): Promise<boolean> => {
    const currentAccess =
      access ??
      (await window.electronAPI?.checkSystemAudioAccess?.()) ??
      DEFAULT_SYSTEM_AUDIO_ACCESS;

    if (currentAccess.mode !== "native") {
      setAccess(currentAccess);
      return false;
    }

    setIsChecking(true);
    try {
      const result = await window.electronAPI?.requestSystemAudioAccess?.();
      const nextAccess = result ?? currentAccess;
      setAccess(nextAccess);
      return nextAccess.granted;
    } catch {
      return false;
    } finally {
      setIsChecking(false);
    }
  }, [access]);

  return {
    granted: access?.granted ?? false,
    status: access?.status ?? "unknown",
    mode: access?.mode ?? "unsupported",
    strategy: access?.strategy ?? "unsupported",
    isChecking,
    request,
    openSettings,
    check,
  };
}
