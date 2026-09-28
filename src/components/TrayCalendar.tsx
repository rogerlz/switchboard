import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, ChevronRight, ExternalLink, Mic, RefreshCw, Video } from "./icons";
import { cn } from "./lib/utils";
import RsvpButtons from "./RsvpButtons";
import { useSettingsStore } from "../stores/settingsStore";
import type { CalendarEvent } from "../types/calendar";
import { getMeetingJoinUrl } from "../helpers/meetingJoinUrl";
import {
  buildMonthGrid,
  formatWorldClock,
  groupEventsByDay,
  isValidTimeZone,
  isVisibleEvent,
  startOfDay,
  needsRsvp,
} from "../helpers/trayCalendarModel";

// Menu-bar calendar popover (fork addition), opened from the tray icon.

const HIDE_WEEKENDS_KEY = "trayCalendarHideWeekends";

type TrayCalendarApi = {
  trayCalendarGetEvents?: () => Promise<CalendarEvent[]>;
  trayCalendarRefresh?: () => Promise<CalendarEvent[]>;
  trayCalendarOpenApp?: () => Promise<void>;
};

const api = () => window.electronAPI as unknown as TrayCalendarApi | undefined;

function readHideWeekends(): boolean {
  try {
    return localStorage.getItem(HIDE_WEEKENDS_KEY) !== "false";
  } catch {
    return true;
  }
}

// The note opens first so the browser, opened last, ends up in front.
async function joinMeeting(event: CalendarEvent) {
  const url = getMeetingJoinUrl(event);
  await window.electronAPI?.joinCalendarMeeting?.(event.id);
  if (url) await window.electronAPI?.openExternal?.(url);
}

export default function TrayCalendar() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const worldClocks = useSettingsStore((state) => state.worldClocks).filter((clock) =>
    isValidTimeZone(clock.timeZone)
  );
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [month, setMonth] = useState(() => startOfDay(new Date()));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [hideWeekends, setHideWeekends] = useState(readHideWeekends);
  const groupRefs = useRef(new Map<string, HTMLDivElement>());

  const refresh = useCallback(async () => {
    const result = await api()?.trayCalendarGetEvents?.();
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
    const tick = setInterval(() => setNow(Date.now()), 15 * 1000);
    return () => {
      window.removeEventListener("focus", onFocus);
      unsubscribers.forEach((unsubscribe) => unsubscribe?.());
      clearInterval(tick);
    };
  }, [refresh]);

  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      const result = await api()?.trayCalendarRefresh?.();
      if (Array.isArray(result)) setEvents(result);
      setNow(Date.now());
    } finally {
      setRefreshing(false);
    }
  };

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
    new Date(value).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      {worldClocks.length > 0 && (
        <div
          className="grid border-b border-border px-3 py-1.5 text-center"
          style={{ gridTemplateColumns: `repeat(${worldClocks.length}, minmax(0, 1fr))` }}
        >
          {worldClocks.map((clock) => {
            const { time, dayOffset } = formatWorldClock(clock.timeZone, now);
            return (
              <div key={`${clock.label}-${clock.timeZone}`} className="min-w-0">
                <div className="truncate text-[10px] text-muted-foreground">{clock.label}</div>
                <div className="text-[13px] font-semibold tabular-nums">
                  {time}
                  {dayOffset !== 0 && (
                    <sup className="ms-0.5 text-[9px] font-normal text-muted-foreground">
                      {dayOffset > 0 ? `+${dayOffset}` : dayOffset}
                    </sup>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="px-3 pt-2.5 pb-1.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">
            {month.toLocaleDateString(locale, { month: "long", year: "numeric" })}
          </span>
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <button
              className="rounded p-1 outline-none hover:bg-surface-3 focus-visible:bg-surface-3"
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              className="rounded px-1.5 py-0.5 outline-none hover:bg-surface-3 focus-visible:bg-surface-3"
              onClick={() => {
                setMonth(today);
                setSelectedDay(today);
              }}
            >
              {t("calendar.today")}
            </button>
            <button
              className="rounded p-1 outline-none hover:bg-surface-3 focus-visible:bg-surface-3"
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        <div
          className="grid text-center text-[11px]"
          style={{ gridTemplateColumns: `repeat(${hideWeekends ? 5 : 7}, minmax(0, 1fr))` }}
        >
          {weeks[0].map((day) => (
            <span key={`h-${day.getDay()}`} className="pb-0.5 text-muted-foreground">
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
                  "flex flex-col items-center rounded-md py-0.5 tabular-nums hover:bg-surface-3",
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
            <div className="sticky top-0 z-10 flex justify-between bg-surface-3 px-3 py-1 text-[11px] font-semibold">
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
                <div key={event.id} className="flex items-center gap-2.5 px-3 py-1.5">
                  <div className="w-8 shrink-0 text-[11px] tabular-nums leading-tight">
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
                      "min-w-0 flex-1 truncate text-[13px]",
                      (ended || tentative) && "text-muted-foreground"
                    )}
                    title={event.summary ?? undefined}
                  >
                    {event.summary || t("upcoming.untitledEvent")}
                  </span>
                  {!ended && needsRsvp(event) && <RsvpButtons event={event} />}
                  {!ended && !needsRsvp(event) && (
                    <button
                      onClick={() => void joinMeeting(event)}
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

      <div className="flex items-center border-t border-border px-3 py-1.5">
        <button
          onClick={toggleWeekends}
          aria-pressed={hideWeekends}
          className="flex flex-1 items-center gap-2 text-start text-[11px] text-muted-foreground hover:text-foreground"
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
        <button
          onClick={() => void refreshNow()}
          disabled={refreshing}
          aria-label={t("trayCalendar.refresh")}
          title={t("trayCalendar.refresh")}
          className="rounded p-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
        >
          <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
        </button>
        <button
          onClick={() => void api()?.trayCalendarOpenApp?.()}
          aria-label={t("trayCalendar.openApp")}
          title={t("trayCalendar.openApp")}
          className="rounded p-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
        >
          <ExternalLink size={13} />
        </button>
      </div>
    </div>
  );
}
