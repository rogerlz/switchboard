import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, ChevronRight, Mic, Video } from "./icons";
import { cn } from "./lib/utils";
import type { CalendarEvent } from "../types/calendar";
import { getMeetingJoinUrl } from "../helpers/meetingJoinUrl";
import {
  buildMonthGrid,
  groupEventsByDay,
  isVisibleEvent,
  startOfDay,
} from "../helpers/trayCalendarModel";

// Menu-bar calendar popover (fork addition), opened from the tray icon.

const HIDE_WEEKENDS_KEY = "trayCalendarHideWeekends";

type TrayCalendarApi = {
  trayCalendarGetEvents?: () => Promise<CalendarEvent[]>;
};

function readHideWeekends(): boolean {
  try {
    return localStorage.getItem(HIDE_WEEKENDS_KEY) !== "false";
  } catch {
    return true;
  }
}

function joinMeeting(event: CalendarEvent) {
  const url = getMeetingJoinUrl(event);
  if (url) window.electronAPI?.openExternal?.(url);
  window.electronAPI?.joinCalendarMeeting?.(event.id);
}

export default function TrayCalendar() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [month, setMonth] = useState(() => startOfDay(new Date()));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [hideWeekends, setHideWeekends] = useState(readHideWeekends);
  const groupRefs = useRef(new Map<string, HTMLDivElement>());

  const refresh = useCallback(async () => {
    const api = window.electronAPI as unknown as TrayCalendarApi | undefined;
    const result = await api?.trayCalendarGetEvents?.();
    setEvents(Array.isArray(result) ? result : []);
    setNow(Date.now());
  }, []);

  // Reopening the popover focuses the window: refetch and jump back to today.
  useEffect(() => {
    const onFocus = () => {
      setSelectedDay(null);
      setMonth(startOfDay(new Date()));
      void refresh();
    };
    onFocus();
    window.addEventListener("focus", onFocus);
    const unsubscribers = [
      window.electronAPI?.onGcalEventsSynced?.(refresh),
      window.electronAPI?.onMcalEventsSynced?.(refresh),
      window.electronAPI?.onAcalEventsSynced?.(refresh),
    ];
    const tick = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => {
      window.removeEventListener("focus", onFocus);
      unsubscribers.forEach((unsubscribe) => unsubscribe?.());
      clearInterval(tick);
    };
  }, [refresh]);

  const toggleWeekends = () => {
    const next = !hideWeekends;
    setHideWeekends(next);
    try {
      localStorage.setItem(HIDE_WEEKENDS_KEY, String(next));
    } catch {
      // Preference just won't persist.
    }
  };

  const today = startOfDay(new Date(now));
  const weeks = useMemo(() => buildMonthGrid(month, hideWeekends), [month, hideWeekends]);
  const eventDays = useMemo(
    () =>
      new Set(
        events.filter(isVisibleEvent).map((e) => startOfDay(new Date(e.start_time)).toDateString())
      ),
    [events]
  );
  // Today onward; an earlier day only once it is clicked.
  const listFrom = (selectedDay && selectedDay < today ? selectedDay : today).getTime();
  const groups = useMemo(
    () => groupEventsByDay(events, new Date(listFrom), hideWeekends),
    [events, listFrom, hideWeekends]
  );

  useEffect(() => {
    if (!selectedDay) return;
    groupRefs.current
      .get(selectedDay.toDateString())
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedDay, groups]);

  const shiftMonth = (delta: number) =>
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const formatTime = (value: string) =>
    new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <div className="px-4 pt-3 pb-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-base font-semibold">
            {month.toLocaleDateString(locale, { month: "long", year: "numeric" })}
          </span>
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <button className="rounded p-1 hover:bg-surface-3" onClick={() => shiftMonth(-1)}>
              <ChevronLeft size={14} />
            </button>
            <button
              className="rounded px-1.5 py-0.5 hover:bg-surface-3"
              onClick={() => {
                setMonth(today);
                setSelectedDay(today);
              }}
            >
              {t("calendar.today")}
            </button>
            <button className="rounded p-1 hover:bg-surface-3" onClick={() => shiftMonth(1)}>
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        <div
          className="grid gap-y-0.5 text-center text-xs"
          style={{ gridTemplateColumns: `repeat(${hideWeekends ? 5 : 7}, minmax(0, 1fr))` }}
        >
          {weeks[0].map((day) => (
            <span key={`h-${day.getDay()}`} className="pb-1 text-muted-foreground">
              {day.toLocaleDateString(locale, { weekday: "short" })}
            </span>
          ))}
          {weeks.flat().map((day) => {
            const key = day.toDateString();
            const isToday = key === today.toDateString();
            const isSelected = key === selectedDay?.toDateString();
            return (
              <button
                key={key}
                onClick={() => setSelectedDay(day)}
                className={cn(
                  "flex flex-col items-center rounded-md py-1 tabular-nums hover:bg-surface-3",
                  day.getMonth() !== month.getMonth() && "text-muted-foreground/50",
                  isSelected && "bg-surface-3",
                  isToday && "bg-primary text-primary-foreground hover:bg-primary"
                )}
              >
                {day.getDate()}
                <span
                  className={cn(
                    "mt-0.5 h-1 w-1 rounded-full",
                    eventDays.has(key) ? "bg-current opacity-60" : "bg-transparent"
                  )}
                />
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
        {groups.length === 0 && (
          <p className="p-4 text-center text-sm text-muted-foreground">
            {t("upcoming.noUpcomingEvents")}
          </p>
        )}
        {groups.map((group) => (
          <div
            key={group.key}
            ref={(el) => {
              if (el) groupRefs.current.set(group.key, el);
              else groupRefs.current.delete(group.key);
            }}
          >
            <div className="sticky top-0 z-10 flex justify-between bg-surface-3 px-4 py-1.5 text-xs font-semibold">
              <span>{group.date.toLocaleDateString(locale, { weekday: "long" })}</span>
              <span className="font-normal text-muted-foreground">
                {group.date.toLocaleDateString(locale, { day: "numeric", month: "short" })}
              </span>
            </div>
            {group.events.map((event: CalendarEvent) => {
              const ended = Date.parse(event.end_time) <= now;
              const tentative = event.self_response_status !== "accepted";
              const hasLink = !!getMeetingJoinUrl(event);
              return (
                <div key={event.id} className="flex items-center gap-3 px-4 py-2">
                  <div className="w-10 shrink-0 text-xs tabular-nums leading-tight">
                    <div className={cn(ended && "text-muted-foreground")}>
                      {formatTime(event.start_time)}
                    </div>
                    <div className="text-muted-foreground">{formatTime(event.end_time)}</div>
                  </div>
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full border border-primary",
                      !tentative && "bg-primary"
                    )}
                  />
                  <span
                    dir="auto"
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      (ended || tentative) && "text-muted-foreground"
                    )}
                    title={event.summary ?? undefined}
                  >
                    {event.summary || t("upcoming.untitledEvent")}
                  </span>
                  {!ended && (
                    <button
                      onClick={() => joinMeeting(event)}
                      title={hasLink ? t("upcoming.joinAndTranscribe") : t("upcoming.takeNotes")}
                      className="flex shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                    >
                      {hasLink ? <Video size={12} /> : <Mic size={12} />}
                      {hasLink && t("workspaces.join.join")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <button
        onClick={toggleWeekends}
        aria-pressed={hideWeekends}
        className="flex items-center gap-2 border-t border-border px-4 py-2 text-start text-xs text-muted-foreground hover:text-foreground"
      >
        <span
          className={cn(
            "flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-current",
            hideWeekends && "border-primary bg-primary text-primary-foreground"
          )}
        >
          {hideWeekends && <Check size={10} />}
        </span>
        {t("trayCalendar.hideWeekends")}
      </button>
    </div>
  );
}
