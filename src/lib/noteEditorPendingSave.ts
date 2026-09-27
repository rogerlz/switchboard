export interface NoteEditorDraft {
  readonly noteId: number;
  readonly title: string;
  readonly content: string;
}

export type NoteDraftMutation = {
  sourceNoteId: number;
  field: "title" | "content";
  value: string;
};

export interface PendingDocumentSnapshot {
  readonly noteId: number;
  readonly title: string;
  readonly content: string;
}

export type PendingNoteUpdates = {
  readonly title?: string;
  readonly content?: string;
};

export interface PendingNoteWrite {
  readonly noteId: number;
  readonly updates: PendingNoteUpdates;
}

interface NoteDraftSource {
  readonly id: number;
  readonly title: string;
  readonly content: string;
}

export interface NoteTransitionPlan {
  readonly writes: PendingNoteWrite[];
  readonly nextDraft: NoteEditorDraft | null;
}

export function shouldCancelPendingSavesForDelete(
  activeNoteId: number | null,
  deletedNoteId: number
): boolean {
  return activeNoteId === deletedNoteId;
}

export function applyNoteDraftMutation(
  draft: NoteEditorDraft | null,
  mutation: NoteDraftMutation
): NoteEditorDraft | null {
  if (!draft || mutation.sourceNoteId !== draft.noteId) return null;
  return { ...draft, [mutation.field]: mutation.value };
}

export function collectPendingNoteWrites(
  document: PendingDocumentSnapshot | null
): PendingNoteWrite[] {
  if (!document) return [];
  return [
    {
      noteId: document.noteId,
      updates: { title: document.title, content: document.content },
    },
  ];
}

export function planNoteTransition(
  nextNote: NoteDraftSource | null,
  document: PendingDocumentSnapshot | null
): NoteTransitionPlan {
  return {
    writes: collectPendingNoteWrites(document),
    nextDraft: nextNote
      ? {
          noteId: nextNote.id,
          title: nextNote.title,
          content: nextNote.content,
        }
      : null,
  };
}
