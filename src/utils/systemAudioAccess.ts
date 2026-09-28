import type { SystemAudioAccessResult } from "../types/electron";

export const DEFAULT_SYSTEM_AUDIO_ACCESS: SystemAudioAccessResult = {
  granted: false,
  status: "unsupported",
  mode: "unsupported",
  strategy: "unsupported",
};

export const canManageSystemAudioInApp = ({ mode }: Pick<SystemAudioAccessResult, "mode">) =>
  mode === "native";
