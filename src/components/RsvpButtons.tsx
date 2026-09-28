import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "./icons";
import { cn } from "./lib/utils";
import type { CalendarEvent } from "../types/calendar";

type RsvpResponse = "accepted" | "tentative" | "declined";

// Accept / maybe / decline for a pending Google invite. The calendar sync
// broadcast that follows a successful reply refreshes the owning list.
export default function RsvpButtons({ event }: { event: CalendarEvent }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<RsvpResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const respond = async (response: RsvpResponse) => {
    setPending(response);
    setFailed(false);
    const result = await window.electronAPI?.gcalRespondToEvent?.(event.id, response);
    setPending(null);
    if (!result?.success) setFailed(true);
  };

  const buttons: Array<{ response: RsvpResponse; label: string; className: string }> = [
    {
      response: "accepted",
      label: t("rsvp.accept"),
      className: "text-green-600 border-green-600/40 hover:bg-green-600/10",
    },
    {
      response: "tentative",
      label: t("rsvp.maybe"),
      className: "text-amber-600 border-amber-500/40 hover:bg-amber-500/10",
    },
    {
      response: "declined",
      label: t("rsvp.decline"),
      className: "text-red-600 border-red-600/40 hover:bg-red-600/10",
    },
  ];

  return (
    <div className="flex shrink-0 items-center gap-1" title={failed ? t("rsvp.failed") : undefined}>
      {buttons.map(({ response, label, className }) => (
        <button
          key={response}
          type="button"
          aria-label={label}
          title={label}
          disabled={pending !== null}
          onClick={() => void respond(response)}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold disabled:opacity-50",
            className,
            event.self_response_status === response && "bg-current/10 ring-1 ring-current",
            failed && "border-red-600"
          )}
        >
          {pending === response ? (
            <Loader2 size={12} className="animate-spin" />
          ) : response === "accepted" ? (
            <Check size={12} />
          ) : response === "declined" ? (
            <X size={12} />
          ) : (
            "?"
          )}
        </button>
      ))}
    </div>
  );
}
