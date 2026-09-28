const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Pins reconcileTranscriptionRouting() in settingsStore.ts, where the rationale
// for each rule lives (#2086).
//
// `_providerSettingsMigrated: "1"` must be seeded: migrateProviderSettings() runs
// first and would otherwise re-derive `transcriptionMode` from the very flag
// under test.
const MIGRATED = { _providerSettingsMigrated: "1" };
// The meeting one-shot copy mirrors the dictation keys once and then latches,
// so seed it done except where a case is about that copy.
const COPIES_DONE = { meetingFollowsTranscription: "false" };

test("startup repairs transcription routing that disagrees with the selected mode", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-transcription-mode-reconcile-test-",
  });

  // Migrations run once per module evaluation, so every case re-evaluates the store.
  const writes = [];
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes.push(key);
    setItem(key, value);
  };
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    writes.length = 0;
    vite.moduleGraph.invalidateAll();
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return useSettingsStore.getState();
  };

  await t.test("a Local selection whose flag says cloud routes locally again", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "local",
      useLocalWhisper: "false",
    });
    assert.equal(state.useLocalWhisper, true);
    assert.equal(state.transcriptionMode, "local");
    assert.equal(storage.getItem("useLocalWhisper"), "true");
  });

  for (const mode of ["providers", "self-hosted"]) {
    await t.test(
      `a stale "${mode}" mode over managed-cloud routing goes back to BYOK`,
      async () => {
        const state = await load({
          ...MIGRATED,
          ...COPIES_DONE,
          transcriptionMode: mode,
          useLocalWhisper: "false",
          cloudTranscriptionMode: "openwhispr",
        });
        assert.equal(state.cloudTranscriptionMode, "byok");
        assert.equal(storage.getItem("cloudTranscriptionMode"), "byok");
        assert.equal(state.transcriptionMode, mode);
        assert.equal(state.useLocalWhisper, false, "still cloud, just the user's own");
      }
    );
  }

  await t.test("an OpenWhispr Cloud mode never claims a BYOK credential", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "openwhispr",
      useLocalWhisper: "false",
      cloudTranscriptionMode: "byok",
    });
    assert.equal(state.cloudTranscriptionMode, "byok");
    assert.equal(storage.getItem("cloudTranscriptionMode"), "byok");
  });

  for (const mode of ["openwhispr", "providers", "self-hosted", "enterprise", "nonsense"]) {
    await t.test(`a stale "${mode}" mode never flips a local user to the cloud`, async () => {
      const state = await load({
        ...MIGRATED,
        ...COPIES_DONE,
        transcriptionMode: mode,
        useLocalWhisper: "true",
      });
      assert.equal(state.useLocalWhisper, true);
      assert.equal(storage.getItem("useLocalWhisper"), "true");
    });
  }

  await t.test("the meeting scope is left alone, because it routes on its own mode", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      meetingTranscriptionMode: "local",
      meetingUseLocalWhisper: "false",
    });
    assert.equal(state.meetingTranscriptionMode, "local", "the mode its router reads");
    assert.equal(storage.getItem("meetingUseLocalWhisper"), "false", "left untouched");
    assert.equal(
      writes.includes("meetingUseLocalWhisper"),
      false,
      "no write to a key nothing reads"
    );
  });

  await t.test("the local rule leaves the cloud mode alone", async () => {
    await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "local",
      useLocalWhisper: "false",
      cloudTranscriptionMode: "openwhispr",
    });
    assert.equal(storage.getItem("useLocalWhisper"), "true", "repaired");
    assert.equal(storage.getItem("cloudTranscriptionMode"), "openwhispr", "untouched");
  });

  for (const mode of ["openwhispr", "enterprise", "nonsense"]) {
    await t.test(`a "${mode}" mode never triggers the cloud rule`, async () => {
      await load({
        ...MIGRATED,
        ...COPIES_DONE,
        transcriptionMode: mode,
        useLocalWhisper: "false",
        cloudTranscriptionMode: "openwhispr",
      });
      assert.equal(storage.getItem("cloudTranscriptionMode"), "openwhispr");
    });
  }

  // The only case that lets migrateMeetingFollowFlags run; every other seeds it done.
  await t.test("the meeting one-shot copy still runs, and is still not repaired", async () => {
    await load({
      ...MIGRATED,
      transcriptionMode: "local",
      useLocalWhisper: "false",
    });
    assert.equal(storage.getItem("meetingTranscriptionMode"), "local", "the copy ran");
    assert.equal(storage.getItem("meetingUseLocalWhisper"), "false", "copied desync, left alone");
    assert.equal(storage.getItem("useLocalWhisper"), "true", "dictation still repaired");
  });

  await t.test("an agreeing profile is not rewritten", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "local",
      useLocalWhisper: "true",
      cloudTranscriptionMode: "byok",
    });
    assert.equal(state.useLocalWhisper, true);
    assert.deepEqual(
      writes.filter((key) =>
        /UseLocalWhisper$|^useLocalWhisper$|CloudTranscriptionMode$/.test(key)
      ),
      [],
      "no routing key should be written when the profile already agrees"
    );
  });

  await t.test("a profile with no stored mode is left untouched", async () => {
    const state = await load({ ...MIGRATED, ...COPIES_DONE, useLocalWhisper: "true" });
    assert.equal(state.useLocalWhisper, true);
    assert.equal(storage.getItem("useLocalWhisper"), "true");
  });
});
