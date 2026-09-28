import { useTranslation } from "react-i18next";
import { Plus } from "../icons";

/** The topbar's "New note" button, matched to the search bar it sits beside. */
export default function NewNoteMenu({ onNewNote }: { onNewNote: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onNewNote}
      className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-foreground/4 ps-3 pe-3.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 dark:bg-white/5 dark:hover:bg-white/8"
    >
      <Plus size={14} />
      {t("notes.list.newNote")}
    </button>
  );
}
