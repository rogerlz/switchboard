const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/noteEditorPendingSave.ts");

function note(id, content) {
  return {
    id,
    title: `Note ${id}`,
    content,
  };
}

test("applies title and content mutations only for the draft owner", async () => {
  const { applyNoteDraftMutation } = await load();
  const original = {
    noteId: 1,
    title: "Original title",
    content: "Original body",
  };

  assert.deepEqual(
    applyNoteDraftMutation(original, {
      sourceNoteId: 1,
      field: "title",
      value: "Edited title",
    }),
    { ...original, title: "Edited title" }
  );
  assert.deepEqual(
    applyNoteDraftMutation(original, {
      sourceNoteId: 1,
      field: "content",
      value: "Edited body",
    }),
    { ...original, content: "Edited body" }
  );
  assert.deepEqual(original, {
    noteId: 1,
    title: "Original title",
    content: "Original body",
  });
});

test("rejects foreign and stale source-note mutations without changing the draft", async () => {
  const { applyNoteDraftMutation } = await load();
  const draftA = {
    noteId: 1,
    title: "A title",
    content: "A body",
  };

  for (const mutation of [
    { sourceNoteId: 2, field: "title", value: "B title" },
    { sourceNoteId: 2, field: "content", value: "B body" },
  ]) {
    assert.equal(applyNoteDraftMutation(draftA, mutation), null);
  }
  assert.equal(
    applyNoteDraftMutation(null, {
      sourceNoteId: 1,
      field: "content",
      value: "No owner",
    }),
    null
  );
  assert.deepEqual(draftA, {
    noteId: 1,
    title: "A title",
    content: "A body",
  });

  const draftB = { ...draftA, noteId: 2 };
  assert.equal(
    applyNoteDraftMutation(draftB, {
      sourceNoteId: 1,
      field: "content",
      value: "Stale A callback",
    }),
    null
  );
});

test("collects document writes under their captured owner", async () => {
  const { collectPendingNoteWrites } = await load();
  const documentA = { noteId: 1, title: "A title", content: "A body" };

  assert.deepEqual(collectPendingNoteWrites(null), []);
  assert.deepEqual(collectPendingNoteWrites(documentA), [
    {
      noteId: 1,
      updates: { title: "A title", content: "A body" },
    },
  ]);
});

test("models B's editor event before the A-to-B parent transition, then returns to A", async () => {
  const { applyNoteDraftMutation, planNoteTransition } = await load();
  const noteA = note(1, "A body");
  const noteB = note(2, "B body");

  let draft = planNoteTransition(noteA, null).nextDraft;
  assert.equal(
    applyNoteDraftMutation(draft, {
      sourceNoteId: 2,
      field: "content",
      value: "B early mount event",
    }),
    null
  );

  const toB = planNoteTransition(noteB, null);
  assert.deepEqual(toB.writes, []);
  assert.deepEqual(toB.nextDraft, {
    noteId: 2,
    title: "Note 2",
    content: "B body",
  });

  draft = toB.nextDraft;
  assert.equal(
    applyNoteDraftMutation(draft, {
      sourceNoteId: 1,
      field: "content",
      value: "A stale callback",
    }),
    null
  );

  const backToA = planNoteTransition(noteA, null);
  assert.deepEqual(backToA.writes, []);
  assert.deepEqual(backToA.nextDraft, {
    noteId: 1,
    title: "Note 1",
    content: "A body",
  });
});

test("edit A then immediately switch to B keeps empty, zero, and raw content owned by A", async () => {
  const { applyNoteDraftMutation, planNoteTransition } = await load();
  const noteA = note(1, "Original A");
  const noteB = note(2, "Original B");

  for (const content of ["", "0", "Edited raw A"]) {
    const draftA = planNoteTransition(noteA, null).nextDraft;
    const editedA = applyNoteDraftMutation(draftA, {
      sourceNoteId: 1,
      field: "content",
      value: content,
    });
    assert.ok(editedA);

    const pendingA = {
      noteId: editedA.noteId,
      title: editedA.title,
      content: editedA.content,
    };
    assert.equal(
      applyNoteDraftMutation(editedA, {
        sourceNoteId: 2,
        field: "content",
        value: "B early mount event",
      }),
      null
    );

    const toB = planNoteTransition(noteB, pendingA);
    assert.deepEqual(toB.writes, [
      {
        noteId: 1,
        updates: { title: "Note 1", content },
      },
    ]);
    assert.equal(toB.nextDraft.noteId, 2);
    assert.equal(pendingA.noteId, 1);
  }
});

test("an overview transition flushes the captured owner and clears the draft", async () => {
  const { planNoteTransition } = await load();

  const transition = planNoteTransition(null, { noteId: 1, title: "A title", content: "A body" });

  assert.deepEqual(transition, {
    writes: [
      {
        noteId: 1,
        updates: { title: "A title", content: "A body" },
      },
    ],
    nextDraft: null,
  });
});

test("deleting inactive B does not cancel A's pending save", async () => {
  const { shouldCancelPendingSavesForDelete } = await load();

  assert.equal(shouldCancelPendingSavesForDelete(17, 23), false);
  assert.equal(shouldCancelPendingSavesForDelete(17, 17), true);
  assert.equal(shouldCancelPendingSavesForDelete(null, 17), false);
});
