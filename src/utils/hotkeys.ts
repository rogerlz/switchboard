/**
 * Formats Electron-accelerator-style shortcut strings (e.g. "CommandOrControl+Shift+K")
 * as platform-aware display labels.
 */

import { getPlatform, type Platform } from "./platform.ts";

/**
 * Display label for a side-qualified modifier token ("RightOption" →
 * "Right Option", "LeftControl" → "Left Ctrl"), or null when the token carries
 * no side.
 */
function formatSideModifierPart(part: string, platform: Platform): string | null {
  const match = /^(Right|Left)(Option|Alt|Command|Cmd|Control|Ctrl|Shift|Super|Meta|Win)$/.exec(
    part
  );
  if (!match) return null;
  const [, side, key] = match;
  return `${side} ${formatModifierPart(key === "Option" ? "Alt" : key, platform)}`;
}

function formatModifierPart(part: string, platform: Platform): string {
  switch (part) {
    case "CommandOrControl":
      return platform === "darwin" ? "Cmd" : "Ctrl";
    case "Command":
    case "Cmd":
      return "Cmd";
    case "Control":
    case "Ctrl":
      return "Ctrl";
    case "Alt":
      return platform === "darwin" ? "Option" : "Alt";
    case "Option":
      return "Option";
    case "Shift":
      return "Shift";
    case "Super":
    case "Meta":
      return platform === "darwin" ? "Cmd" : platform === "win32" ? "Win" : "Super";
    case "Win":
      return platform === "win32" ? "Win" : "Super";
    case "Fn":
      return "Fn";
    default:
      return part;
  }
}

/**
 * Formats an Electron accelerator string into a user-friendly display label
 * ("Cmd+Shift+K" on macOS, "Ctrl+Shift+K" on Windows).
 */
export function formatHotkeyLabel(hotkey?: string | null): string {
  return formatHotkeyLabelForPlatform(hotkey ?? "", getPlatform());
}

export function formatHotkeyLabelForPlatform(hotkey: string, platform: Platform): string {
  if (!hotkey || hotkey.trim() === "") {
    return "";
  }

  if (hotkey.includes("+")) {
    const parts = hotkey.split("+");
    const formattedParts = parts.map(
      (part) => formatSideModifierPart(part, platform) ?? formatModifierPart(part, platform)
    );
    return formattedParts.join("+");
  }

  return formatSideModifierPart(hotkey, platform) ?? formatModifierPart(hotkey, platform);
}
