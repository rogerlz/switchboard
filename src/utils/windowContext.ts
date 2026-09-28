// Window creation tags the control panel with ?panel=true in both development
// and packaged builds; the meeting prompt and tray calendar use other queries.
export const isControlPanelWindow = (): boolean => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("panel") === "true";
};
