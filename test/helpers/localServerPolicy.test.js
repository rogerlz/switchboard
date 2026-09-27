const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/localServerPolicy.js");

// Every scope off local: the baseline each test switches one scope away from.
const NOTHING_LOCAL = {
  useCleanupModel: true,
  cleanupMode: "openwhispr",
  cleanupModel: "",
  noteFormattingMode: "openwhispr",
  noteFormattingModel: "",
  useDictationTranslation: false,
  translationMode: "openwhispr",
  translationModel: "",
};

const LOCAL_CLEANUP = {
  ...NOTHING_LOCAL,
  cleanupMode: "local",
  cleanupModel: "qwen3-8b-q4_k_m",
};

test("a local scope pre-warms the model it selected", async () => {
  const { resolveLocalServerNeeds } = await load();

  assert.deepEqual(resolveLocalServerNeeds(LOCAL_CLEANUP), {
    cleanup: "qwen3-8b-q4_k_m",
    models: ["qwen3-8b-q4_k_m"],
  });
});

test("a local selection is recognized by its mode, not its provider id", async () => {
  const { resolveLocalServerNeeds } = await load();

  // Regression guard: scopes store the catalog family id (qwen, gemma, …) as
  // their provider, never the literal "local". Keying off the provider left
  // pre-warming permanently off and stopped the server for active local users.
  const needs = resolveLocalServerNeeds({ ...LOCAL_CLEANUP, cleanupProvider: "qwen" });

  assert.equal(needs.cleanup, "qwen3-8b-q4_k_m");
  assert.deepEqual(needs.models, ["qwen3-8b-q4_k_m"]);
});

test("a switched-off scope needs no server even with a local model selected", async () => {
  const { resolveLocalServerNeeds } = await load();

  assert.deepEqual(resolveLocalServerNeeds({ ...LOCAL_CLEANUP, useCleanupModel: false }), {
    cleanup: "",
    models: [],
  });
});

test("local mode without a downloaded model pre-warms nothing", async () => {
  const { resolveLocalServerNeeds } = await load();

  const needs = resolveLocalServerNeeds({ ...LOCAL_CLEANUP, cleanupModel: "  " });

  assert.equal(needs.cleanup, "");
  assert.deepEqual(needs.models, []);
});

test("the shared server survives one scope leaving while the other stays local", async () => {
  const { resolveLocalServerNeeds } = await load();

  const needs = resolveLocalServerNeeds({
    ...NOTHING_LOCAL,
    cleanupMode: "providers",
    cleanupModel: "gpt-5-mini",
    noteFormattingMode: "local",
    noteFormattingModel: "gemma-4-e4b-it-q4_k_m",
  });

  assert.deepEqual(needs, {
    cleanup: "",
    models: ["gemma-4-e4b-it-q4_k_m"],
  });
});

test("the server has no consumer once no scope runs locally", async () => {
  const { resolveLocalServerNeeds } = await load();

  for (const mode of ["openwhispr", "providers", "self-hosted", "enterprise"]) {
    const needs = resolveLocalServerNeeds({
      ...NOTHING_LOCAL,
      useDictationTranslation: true,
      cleanupMode: mode,
      cleanupModel: "gpt-5-mini",
      noteFormattingMode: mode,
      noteFormattingModel: "gpt-5-mini",
      translationMode: mode,
      translationModel: "gpt-5-mini",
    });

    assert.deepEqual(needs, { cleanup: "", models: [] }, mode);
  }
});

// Before the shared rule, only cleanup counted, so moving cleanup to the cloud
// stopped a server that note formatting or translation was still using.
for (const [scope, overrides] of [
  ["note formatting", { noteFormattingMode: "local", noteFormattingModel: "qwen3-8b-q4_k_m" }],
  [
    "translation",
    {
      useDictationTranslation: true,
      translationMode: "local",
      translationModel: "qwen3-8b-q4_k_m",
    },
  ],
]) {
  test(`a local ${scope} scope still needs the server after cleanup leaves`, async () => {
    const { resolveLocalServerNeeds } = await load();

    const needs = resolveLocalServerNeeds({ ...NOTHING_LOCAL, ...overrides });

    assert.deepEqual(needs.models, ["qwen3-8b-q4_k_m"]);
    // Pre-warm targets stay limited to the startup scope.
    assert.equal(needs.cleanup, "");
  });
}

test("translation switched off needs no server even with a local model selected", async () => {
  const { resolveLocalServerNeeds } = await load();

  const needs = resolveLocalServerNeeds({
    ...NOTHING_LOCAL,
    translationMode: "local",
    translationModel: "qwen3-8b-q4_k_m",
  });

  assert.deepEqual(needs.models, []);
});

test("scopes sharing a model list it once", async () => {
  const { resolveLocalServerNeeds } = await load();

  const needs = resolveLocalServerNeeds({
    ...LOCAL_CLEANUP,
    noteFormattingMode: "local",
    noteFormattingModel: "qwen3-8b-q4_k_m",
    useDictationTranslation: true,
    translationMode: "local",
    translationModel: "gemma-4-e4b-it-q4_k_m",
  });

  assert.deepEqual(needs.models, ["qwen3-8b-q4_k_m", "gemma-4-e4b-it-q4_k_m"]);
});

test("the server keeps running while its loaded model is still needed", async () => {
  const { shouldStopLocalServer } = await load();

  const needs = { models: ["qwen3-8b-q4_k_m", "gemma-4-e4b-it-q4_k_m"] };

  assert.equal(shouldStopLocalServer(needs, "gemma-4-e4b-it-q4_k_m"), false);
});

test("the server stops when no scope needs the model it has loaded", async () => {
  const { shouldStopLocalServer } = await load();

  // The next request for the remaining local model reloads the server anyway,
  // so holding the stale model only keeps its memory in use.
  assert.equal(
    shouldStopLocalServer({ models: ["qwen3-8b-q4_k_m"] }, "gemma-4-e4b-it-q4_k_m"),
    true
  );
});

test("with no model loaded, the server stops only when nothing is needed", async () => {
  const { shouldStopLocalServer } = await load();

  assert.equal(shouldStopLocalServer({ models: [] }, null), true);
  assert.equal(shouldStopLocalServer({ models: ["qwen3-8b-q4_k_m"] }, null), false);
});
