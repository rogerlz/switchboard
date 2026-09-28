import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "../icons";
import { useToast } from "../ui/useToast";
import NoteEditor from "./NoteEditor";
import SpacesTree from "./SpacesTree";
import UpcomingMeetings from "../UpcomingMeetings";
import { useUpcomingEvents } from "../../hooks/useUpcomingEvents";
import { ContainerOverview } from "./overview/ContainerOverview";
import AddNotesToFolderDialog from "./AddNotesToFolderDialog";
import type { NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import type { NoteItem } from "../../types/electron";
import logger from "../../utils/logger";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import { isExplicitSpeakerCount, resolveExpectedSpeakerCount } from "../../utils/participants";
import {
  useNotes,
  useSpaces,
  useFolders,
  useActiveNote,
  useActiveNoteId,
  useActiveFolderId,
  useActiveContext,
  initializeNotes,
  initializeNotesTree,
  loadFolders,
  setActiveNoteId,
  setActiveContext,
  revealContainer,
  createFolder,
  getNoteFromStore,
} from "../../stores/noteStore";
import {
  useMeetingRecordingStore,
  useIsMeetingMode,
  useIsNarrowWindow,
  startRecording as storeStartRecording,
  stopRecording as storeStopRecording,
  lockSpeaker,
  setSessionDiarizationEnabled,
  setSessionExpectedCount,
} from "../../stores/meetingRecordingStore";
import { startRecordingForNote, useCreateNote } from "../../hooks/useCreateNote";
import { defaultFolderDisplayName, notesEmptyTitleKey } from "./shared";
import { isMeetingAutoEndEligible } from "../../helpers/meetingRecordingSession";
import { handleMeetingRecordingRequest } from "../../helpers/meetingRecordingRequest";
import {
  applyNoteDraftMutation,
  collectPendingNoteWrites,
  planNoteTransition,
  shouldCancelPendingSavesForDelete,
  type NoteEditorDraft,
  type PendingDocumentSnapshot,
  type PendingNoteWrite,
} from "../../lib/noteEditorPendingSave";

function draftFromNote(note: NoteItem): NoteEditorDraft {
  return {
    noteId: note.id,
    title: note.title,
    content: note.content,
  };
}

interface PendingDocumentSave extends PendingDocumentSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

type PendingSaveReason = "switch" | "overview" | "unmount";

interface PersonalNotesViewProps {
  onOpenSettings?: (section: string) => void;
  onOpenIntegrations?: () => void;
  meetingRecordingRequest?: {
    noteId: number;
    folderId: number;
    event: any;
  } | null;
  onMeetingRecordingRequestHandled?: () => void;
}

export default function PersonalNotesView({
  onOpenSettings,
  onOpenIntegrations,
  meetingRecordingRequest,
  onMeetingRecordingRequestHandled,
}: PersonalNotesViewProps) {
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const { t } = useTranslation();
  const notes = useNotes();
  const activeNoteId = useActiveNoteId();
  const upcoming = useUpcomingEvents();
  const isSidePanelLayout = isMeetingMode || (isNarrowWindow && activeNoteId != null);
  const activeFolderId = useActiveFolderId();
  const [isSaving, setIsSaving] = useState(false);
  const [draft, setDraftState] = useState<NoteEditorDraft | null>(null);
  const draftRef = useRef<NoteEditorDraft | null>(null);
  const [showAddNotesDialog, setShowAddNotesDialog] = useState(false);
  const pendingDocumentRef = useRef<PendingDocumentSave | null>(null);

  const commitDraft = useCallback((next: NoteEditorDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  // Conflict-banner Refresh applies an external cloud copy: a queued
  // debounced save would clobber it with the pre-refresh buffer, so the
  // editor cancels pending saves for that note before the copy is applied.
  const cancelPendingSaves = useCallback((noteId: number) => {
    const document = pendingDocumentRef.current;
    if (document?.noteId === noteId) {
      clearTimeout(document.timer);
      pendingDocumentRef.current = null;
    }
  }, []);

  const takePendingSnapshot = useCallback((): PendingDocumentSnapshot | null => {
    const document = pendingDocumentRef.current;
    if (document) clearTimeout(document.timer);
    pendingDocumentRef.current = null;
    return document;
  }, []);

  const persistPendingWrites = useCallback(
    (writes: PendingNoteWrite[], reason: PendingSaveReason) => {
      for (const write of writes) {
        void window.electronAPI.updateNote(write.noteId, write.updates).catch((err: unknown) => {
          logger.warn(
            `Failed to flush note before ${reason}`,
            { error: (err as Error).message },
            "notes"
          );
        });
      }
    },
    []
  );

  const flushPendingSaves = useCallback(
    (reason: PendingSaveReason) => {
      persistPendingWrites(collectPendingNoteWrites(takePendingSnapshot()), reason);
    },
    [persistPendingWrites, takePendingSnapshot]
  );

  const transitionToNote = useCallback(
    (nextNote: NoteItem | null, reason: Extract<PendingSaveReason, "switch" | "overview">) => {
      const transition = planNoteTransition(nextNote, takePendingSnapshot());
      persistPendingWrites(transition.writes, reason);
      commitDraft(transition.nextDraft);
    },
    [commitDraft, persistPendingWrites, takePendingSnapshot]
  );
  const { toast } = useToast();

  const isTranscribing = useMeetingRecordingStore((s) => s.isRecording);
  const diarizationSessionId = useMeetingRecordingStore((s) => s.diarizationSessionId);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const sessionDiarizationEnabled = useMeetingRecordingStore((s) => s.sessionDiarizationEnabled);
  const sessionExpectedCount = useMeetingRecordingStore((s) => s.sessionExpectedCount);
  const userTouchedStepper = useMeetingRecordingStore((s) => s.userTouchedStepper);

  const spaces = useSpaces();
  const folders = useFolders();
  const activeContext = useActiveContext();
  const overviewSpace = useMemo(
    () => (activeContext ? (spaces.find((s) => s.id === activeContext.spaceId) ?? null) : null),
    [activeContext, spaces]
  );
  const overviewFolder = useMemo(
    () =>
      activeContext?.folderId != null
        ? (folders.find((f) => f.id === activeContext.folderId) ?? null)
        : null,
    [activeContext, folders]
  );

  useEffect(() => {
    initializeNotesTree();
  }, []);

  const activeNote = useActiveNote();

  // Derive folder name and calendar event name for the metadata chips
  const activeFolderName = useMemo(() => {
    if (!activeNote?.folder_id) return null;
    const folder = folders.find((f) => f.id === activeNote.folder_id);
    return folder ? defaultFolderDisplayName(folder, t) : null;
  }, [activeNote?.folder_id, folders, t]);

  // The editor's move-to-folder chip only offers folders in the note's own
  // space; cross-space moves change the audience and need an explicit confirm.
  const editorFolders = useMemo(
    () => (activeNote ? folders.filter((f) => f.space_id === activeNote.space_id) : folders),
    [activeNote, folders]
  );

  const [calendarEventName, setCalendarEventName] = useState<string | null>(null);
  useEffect(() => {
    if (!activeNote?.calendar_event_id) {
      setCalendarEventName(null);
      return;
    }
    window.electronAPI.gcalGetEvent?.(activeNote.calendar_event_id).then((result) => {
      setCalendarEventName(result?.success && result.event?.summary ? result.event.summary : null);
    });
  }, [activeNote?.calendar_event_id]);

  const startRecording = useCallback(() => startRecordingForNote(activeNote ?? null), [activeNote]);

  const stopRecording = useCallback(async () => {
    await storeStopRecording();
  }, []);

  useEffect(() => {
    const currentDraft = draftRef.current;

    if (!activeNote) {
      // Space/folder activation shows its overview by clearing activeNoteId.
      if (currentDraft || pendingDocumentRef.current) {
        transitionToNote(null, "overview");
      }
      return;
    }

    if (!currentDraft || activeNote.id !== currentDraft.noteId) {
      // Captured writes retain the old owner while the complete next draft is
      // installed atomically.
      transitionToNote(activeNote, "switch");
      return;
    }

    if (pendingDocumentRef.current?.noteId !== activeNote.id) {
      // External update — replace the complete draft only when it has no
      // local save pending.
      commitDraft(draftFromNote(activeNote));
    }
  }, [activeNote, commitDraft, transitionToNote]);

  const scheduleDocumentSave = useCallback((snapshot: NoteEditorDraft) => {
    const current = pendingDocumentRef.current;
    if (current) clearTimeout(current.timer);

    const pending: PendingDocumentSave = {
      noteId: snapshot.noteId,
      title: snapshot.title,
      content: snapshot.content,
      timer: setTimeout(async () => {
        if (pendingDocumentRef.current !== pending) return;
        pendingDocumentRef.current = null;
        setIsSaving(true);
        try {
          await window.electronAPI.updateNote(pending.noteId, {
            title: pending.title,
            content: pending.content,
          });
        } catch (err) {
          logger.warn("Failed to save note", { error: (err as Error).message }, "notes");
        } finally {
          setIsSaving(false);
        }
      }, 1000),
    };
    pendingDocumentRef.current = pending;
  }, []);

  const handleTitleChange = useCallback(
    (sourceNoteId: number, title: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "title",
        value: title,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next);
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "content",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next);
    },
    [commitDraft, scheduleDocumentSave]
  );

  useEffect(() => {
    return () => flushPendingSaves("unmount");
  }, [flushPendingSaves]);

  const { createNote, createNoteIn } = useCreateNote();

  const privateSpaceId = useMemo(
    () => spaces.find((s) => s.kind === "private")?.id ?? null,
    [spaces]
  );

  const handleNotesAdded = useCallback(async () => {
    if (activeFolderId) {
      await initializeNotes(null, 50, activeFolderId);
    }
    loadFolders();
  }, [activeFolderId]);

  const handleDelete = useCallback(
    async (id: number) => {
      if (shouldCancelPendingSavesForDelete(draftRef.current?.noteId ?? null, id)) {
        cancelPendingSaves(id);
      }
      await window.electronAPI.deleteNote(id);
    },
    [cancelPendingSaves]
  );

  const handleMoveNote = useCallback(
    async (noteId: number, target: NoteMoveTarget) => {
      await window.electronAPI.updateNote(noteId, {
        folder_id: target.folderId,
        space_id: target.spaceId,
      });
      if (noteId === activeNoteId) {
        setActiveContext(target.spaceId, target.folderId);
        revealContainer(target.spaceId, target.folderId);
      }
    },
    [activeNoteId]
  );

  const handleMoveToFolder = useCallback(
    async (noteId: number, folderId: number) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      await handleMoveNote(noteId, { spaceId: folder.space_id, folderId });
    },
    [folders, handleMoveNote]
  );

  const handleCreateFolderAndMove = useCallback(
    async (noteId: number, folderName: string) => {
      const spaceId = getNoteFromStore(noteId)?.space_id ?? privateSpaceId;
      if (spaceId == null) return;
      const result = await createFolder(folderName, spaceId);
      if (result.success && result.folder) {
        await handleMoveToFolder(noteId, result.folder.id);
      } else if (result.error) {
        toast({
          title: t("notes.folders.couldNotCreate"),
          description: result.error,
          variant: "destructive",
        });
      }
    },
    [privateSpaceId, handleMoveToFolder, toast, t]
  );

  const activeDraft = draft?.noteId === activeNote?.id ? draft : null;
  const editorNote = activeNote
    ? {
        ...activeNote,
        title: activeDraft ? activeDraft.title : activeNote.title,
        content: activeDraft ? activeDraft.content : activeNote.content,
      }
    : null;

  const handleExportNote = useCallback(
    async (format: "md" | "txt") => {
      if (!activeNoteId) return;
      await window.electronAPI.exportNote(activeNoteId, format);
    },
    [activeNoteId]
  );

  const handleExportTranscript = useCallback(
    async (format: "txt" | "srt" | "json" | "md") => {
      if (!activeNoteId) return;
      await window.electronAPI.exportTranscript(activeNoteId, format);
    },
    [activeNoteId]
  );

  useEffect(() => {
    if (!meetingRecordingRequest || activeNoteId !== meetingRecordingRequest.noteId) return;
    const note = activeNote?.id === meetingRecordingRequest.noteId ? activeNote : null;
    const seedSegments = note?.transcript ? parseTranscriptSegments(note.transcript) : [];
    void handleMeetingRecordingRequest({
      args: {
        noteId: meetingRecordingRequest.noteId,
        noteTitle: note?.title ?? null,
        folderId: note?.folder_id ?? meetingRecordingRequest.folderId ?? null,
        seedSegments,
        diarizationEnabled:
          note?.diarization_enabled == null ? null : note.diarization_enabled === 1,
        expectedCount: resolveExpectedSpeakerCount(note),
        expectedCountIsExplicit: isExplicitSpeakerCount(note?.expected_speaker_count),
        // Requests come from meeting detection, so a note that hasn't loaded
        // yet is still a meeting note.
        autoEndEligible: note ? isMeetingAutoEndEligible(note) : true,
      },
      startRecording: storeStartRecording,
      restoreFromMeetingMode: async () => {
        await window.electronAPI?.restoreFromMeetingMode?.();
      },
      onHandled: () => onMeetingRecordingRequestHandled?.(),
    }).catch((error) => {
      logger.warn(
        "Failed to handle automatic meeting recording request",
        { error: (error as Error).message },
        "meeting"
      );
    });
  }, [meetingRecordingRequest, activeNoteId, activeNote, onMeetingRecordingRequestHandled]);

  // Final and periodic transcript persistence live in MeetingRecordingMount /
  // the store — this view can be unmounted when an auto-end stop fires.
  const isActiveNoteRecording = isTranscribing && recordingNoteId === activeNote?.id;

  return (
    <div className="flex h-full">
      <div
        className="shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
        style={{ width: isSidePanelLayout ? 0 : "13rem" }}
      >
        <div className="w-52 shrink-0 border-e border-border dark:border-white/10 flex flex-col h-full">
          <SpacesTree
            onDeleteNote={handleDelete}
            onMoveNote={handleMoveNote}
            onCreateFolderAndMove={handleCreateFolderAndMove}
            onNewNote={createNoteIn}
          />
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {editorNote ? (
          <>
            <NoteEditor
              key={editorNote.id}
              note={editorNote}
              onTitleChange={handleTitleChange}
              onContentChange={handleContentChange}
              isSaving={isSaving}
              isRecording={isActiveNoteRecording}
              isProcessing={false}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
              onExportNote={handleExportNote}
              onExportTranscript={handleExportTranscript}
              diarizationSessionId={diarizationSessionId}
              onLiveSpeakerLock={lockSpeaker}
              sessionDiarizationEnabled={sessionDiarizationEnabled}
              sessionExpectedCount={sessionExpectedCount}
              userTouchedStepper={userTouchedStepper}
              onSetSessionDiarizationEnabled={setSessionDiarizationEnabled}
              onSetSessionExpectedCount={setSessionExpectedCount}
              folderName={activeFolderName}
              calendarEventName={calendarEventName}
              folders={editorFolders}
              onMoveToFolder={handleMoveToFolder}
              onCreateFolderAndMove={handleCreateFolderAndMove}
            />
          </>
        ) : activeContext && overviewSpace ? (
          <ContainerOverview
            key={
              activeContext.folderId != null
                ? `f:${activeContext.folderId}`
                : `s:${activeContext.spaceId}`
            }
            space={overviewSpace}
            folder={overviewFolder}
            onOpenNote={setActiveNoteId}
            onNewNote={createNote}
            onAddExisting={activeFolderId != null ? () => setShowAddNotesDialog(true) : undefined}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center -mt-6">
            <svg
              className="text-foreground dark:text-white mb-5"
              width="72"
              height="64"
              viewBox="0 0 72 64"
              fill="none"
            >
              <rect
                x="22"
                y="2"
                width="32"
                height="42"
                rx="3"
                transform="rotate(6 38 23)"
                fill="currentColor"
                fillOpacity={0.025}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <rect
                x="18"
                y="5"
                width="32"
                height="42"
                rx="3"
                transform="rotate(3 34 26)"
                fill="currentColor"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <rect
                x="14"
                y="8"
                width="32"
                height="42"
                rx="3"
                fill="currentColor"
                fillOpacity={0.05}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <rect
                x="20"
                y="16"
                width="16"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.08}
              />
              <rect
                x="20"
                y="21"
                width="20"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.06}
              />
              <rect
                x="20"
                y="26"
                width="12"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.05}
              />
              <rect
                x="20"
                y="31"
                width="18"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.04}
              />
              <circle
                cx="54"
                cy="50"
                r="5"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <path
                d="M51.5 50L53 51.5L56.5 48"
                stroke="currentColor"
                strokeOpacity={0.12}
                strokeWidth={1.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {notes.length === 0 ? (
              <>
                <h3 className="text-xs font-semibold text-foreground/60 mb-1">
                  {t(notesEmptyTitleKey(activeFolderId != null))}
                </h3>
                <p className="text-xs text-foreground/50 dark:text-foreground/45 text-center max-w-55 mb-4">
                  {t("notes.empty.description")}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={createNote}
                    className="flex items-center gap-1.5 px-4 h-7 rounded-md bg-primary/8 dark:bg-primary/10 border border-primary/12 dark:border-primary/15 text-xs font-medium text-primary/70 hover:bg-primary/12 hover:text-primary hover:border-primary/20 transition-colors"
                  >
                    <Plus size={11} />
                    {t("notes.empty.createNote")}
                  </button>
                  {/* AddNotesToFolderDialog only mounts for folder contexts —
                      space-root empty states offer just "Create note". */}
                  {activeFolderId != null && (
                    <button
                      onClick={() => setShowAddNotesDialog(true)}
                      className="flex items-center gap-1.5 px-4 h-7 rounded-md border border-foreground/8 dark:border-white/10 text-xs text-foreground/45 hover:text-foreground/60 hover:border-foreground/15 hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors"
                    >
                      {t("notes.addToFolder.addExisting")}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h3 className="text-xs font-semibold text-foreground/60 mb-1">
                  {t("notes.empty.selectTitle")}
                </h3>
                <p className="text-xs text-foreground/50 dark:text-foreground/45 text-center max-w-50">
                  {t("notes.empty.selectDescription")}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {!editorNote && (
        <aside className="hidden w-80 shrink-0 overflow-y-auto border-s border-border p-4 lg:block dark:border-white/10">
          <UpcomingMeetings
            events={upcoming.events}
            isLoading={upcoming.isLoading}
            isConnected={upcoming.isConnected}
            onConnectCalendar={onOpenIntegrations ?? (() => {})}
          />
        </aside>
      )}

      {activeFolderId && (
        <AddNotesToFolderDialog
          open={showAddNotesDialog}
          onOpenChange={setShowAddNotesDialog}
          targetFolderId={activeFolderId}
          onNotesAdded={handleNotesAdded}
        />
      )}
    </div>
  );
}
