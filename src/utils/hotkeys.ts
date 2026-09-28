// Formats Electron-accelerator-style shortcut strings (e.g. "CommandOrControl+Shift+K")
// as macOS display labels ("Cmd+Shift+K").
const MAC_MODIFIER_LABELS: Record<string, string> = {
  CommandOrControl: "Cmd",
  Command: "Cmd",
  Control: "Ctrl",
  Alt: "Option",
  Super: "Cmd",
  Meta: "Cmd",
};

export function formatHotkeyLabel(hotkey?: string | null): string {
  if (!hotkey?.trim()) return "";
  return hotkey
    .split("+")
    .map((part) => MAC_MODIFIER_LABELS[part] ?? part)
    .join("+");
}
