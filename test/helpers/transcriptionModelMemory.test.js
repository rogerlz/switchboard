const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("per-provider transcription model memory", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      meetingCloudTranscriptionProvider: "deepgram",
      meetingCloudTranscriptionModel: "nova-3",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-memory-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = () => useSettingsStore.getState();

  await t.test("switch-and-return restores the previous model", () => {
    state().switchCloudTranscriptionProvider("openai");
    assert.equal(state().meetingCloudTranscriptionProvider, "openai");
    assert.equal(state().meetingCloudTranscriptionModel, "gpt-4o-mini-transcribe");

    state().switchCloudTranscriptionProvider("deepgram");
    assert.equal(state().meetingCloudTranscriptionProvider, "deepgram");
    assert.equal(state().meetingCloudTranscriptionModel, "nova-3");
  });

  await t.test("reselecting the current provider keeps the current model", () => {
    state().setMeetingCloudTranscriptionModel("nova-2");
    state().switchCloudTranscriptionProvider("deepgram");
    assert.equal(state().meetingCloudTranscriptionModel, "nova-2");
  });

  await t.test("a remembered model that is not a streaming model falls back", () => {
    state().switchCloudTranscriptionProvider("openai");
    state().setMeetingCloudTranscriptionModel("retired-model");
    state().switchCloudTranscriptionProvider("deepgram");
    state().switchCloudTranscriptionProvider("openai");
    assert.equal(state().meetingCloudTranscriptionModel, "gpt-4o-mini-transcribe");
  });

  await t.test("memory persists to localStorage as JSON", () => {
    const persisted = JSON.parse(localStorage.getItem("transcriptionModelByProvider"));
    assert.ok(Object.keys(persisted).every((key) => key.startsWith("meeting:")));
  });
});
