const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadAudioManager(t) {
  const { window } = installBrowserGlobals(t, {
    initialStorage: {},
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: window.localStorage,
    writable: true,
    configurable: true,
  });
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { ...originalNavigator, onLine: true },
    configurable: true,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
    delete globalThis.__analyticsSettings;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-analytics-occurrence-test-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__analyticsSettings;
        export const getEffectiveCleanupModel = () => "cleanup-model";
        export const isCloudCleanupMode = () => false;
        export const isCloudTranslationMode = () => false;
        export const selectResolvedLLMConfig = () => ({ model: "cleanup-model" });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: false,
          model: "",
          displayProvider: "none",
          config: {},
        });
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "prompt";
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    window,
    setSettings: (settings) => {
      globalThis.__analyticsSettings = settings;
    },
    createManager: () =>
      Object.assign(Object.create(AudioManager.prototype), {
        translationRequested: false,
        isDictionaryEcho: () => false,
        getWhisperPrompt: () => null,
        processWithReasoningModel: async () => "cleanup output",
        finalizeChineseScript: async (text) => text,
      }),
  };
}

test("cloud transcription returns the occurrence time sent with analytics", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t);
  const analyticsOccurredAt = "2026-09-02T14:00:00.000Z";
  const audioBlob = {
    type: "audio/webm",
    size: 1024,
    arrayBuffer: async () => new ArrayBuffer(8),
  };
  let requestOptions;

  setSettings({
    preferredLanguage: "auto",
    useCleanupModel: false,
    customDictionary: [],
    snippets: [],
    isSignedIn: true,
    insightsSyncEnabled: true,
    dataRetentionEnabled: true,
  });
  window.electronAPI.cloudTranscribe = async (_audio, options) => {
    requestOptions = options;
    return {
      success: true,
      text: "same event",
      clientTranscriptionId: "event-1",
    };
  };

  const result = await createManager().processWithOpenWhisprCloud(audioBlob, {
    analyticsOccurredAt,
  });

  assert.equal(requestOptions.analyticsOccurredAt, analyticsOccurredAt);
  assert.equal(result.analyticsOccurredAt, analyticsOccurredAt);
});

test("local analytics save uses the propagated occurrence time", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t);
  const analyticsOccurredAt = "2026-09-02T14:00:00.000Z";
  let recordedEvent;

  setSettings({
    dataRetentionEnabled: true,
    audioRetentionDays: 0,
    customDictionary: [],
    snippets: [],
  });
  window.electronAPI.recordAnalyticsEvent = async (event) => {
    recordedEvent = event;
  };
  window.electronAPI.saveTranscription = async () => ({});

  await createManager().saveTranscription("same event", "same event", {
    clientTranscriptionId: "event-1",
    analyticsOccurredAt,
  });

  assert.equal(recordedEvent.occurredAt, analyticsOccurredAt);
});
