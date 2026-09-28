import React, { Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import appIcon from "./assets/switchboard-art.svg";
import MeetingNotificationOverlay from "./components/MeetingNotificationOverlay.tsx";
import { useControlPanelWindowDrag } from "./hooks/useControlPanelWindowDrag";
import { useTheme } from "./hooks/useTheme";

const ControlPanel = React.lazy(() => import("./components/ControlPanel.tsx"));
const TrayCalendar = React.lazy(() => import("./components/TrayCalendar.tsx"));

export default function AppRouter() {
  useTheme();
  const params = window.location.search;

  if (params.includes("meeting-notification=true")) {
    return <MeetingNotificationOverlay />;
  }

  if (params.includes("tray-calendar=true")) {
    return (
      <Suspense fallback={null}>
        <TrayCalendar />
      </Suspense>
    );
  }

  return <MainApp />;
}

function MainApp() {
  useControlPanelWindowDrag(true);

  // Release the gates main holds (window visibility, meeting prompts) once
  // the renderer has mounted.
  useEffect(() => {
    void window.electronAPI?.controlPanelReady?.();
  }, []);

  return (
    <Suspense fallback={<LoadingFallback />}>
      <ControlPanel />
    </Suspense>
  );
}

function LoadingFallback({ message }) {
  const { t } = useTranslation();
  const fallbackMessage = message || t("common.loading");

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 animate-[scale-in_300ms_ease-out]">
        <img
          src={appIcon}
          alt=""
          aria-hidden="true"
          width={48}
          height={48}
          decoding="async"
          draggable={false}
          className="h-12 w-12 rounded-[11px] drop-shadow-[0_2px_8px_rgba(14,22,49,0.25)]"
        />
        <div className="w-7 h-7 rounded-full border-[2.5px] border-transparent border-t-primary animate-[spinner-rotate_0.8s_cubic-bezier(0.4,0,0.2,1)_infinite] motion-reduce:animate-none motion-reduce:border-t-muted-foreground motion-reduce:opacity-50" />
        {fallbackMessage && (
          <p className="text-[13px] font-medium text-muted-foreground dark:text-foreground/60 tracking-[-0.01em]">
            {fallbackMessage}
          </p>
        )}
      </div>
    </div>
  );
}
