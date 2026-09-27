const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationRouting.js");

test("normal dictation without wake word routes to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
    }),
    "cleanup"
  );
});

test("skips reasoning when nothing is reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
    }),
    "skip"
  );
});

test("translation hotkey routes to translation when reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      translationRequested: true,
      translationReachable: true,
    }),
    "translation"
  );
});

test("unreachable translation degrades to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  // A dictation meant for translation is still a useful dictation, so keep the cleanup.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      translationRequested: true,
      translationReachable: false,
    }),
    "cleanup"
  );
});

test("unreachable translation with unreachable cleanup skips reasoning", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      translationRequested: true,
      translationReachable: false,
    }),
    "skip"
  );
});

test("normal dictation never takes the translation route", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      translationRequested: false,
      translationReachable: true,
    }),
    "cleanup"
  );
});

test("translation is unreachable when disabled", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: false,
      translationTargetLanguage: "it",
      translationMode: "openwhispr",
      translationProvider: undefined,
      translationModel: "gpt-5-mini",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    false
  );
});

test("translation is unreachable without a target language", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "   ",
      translationMode: "openwhispr",
      translationProvider: undefined,
      translationModel: "gpt-5-mini",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    false
  );
});

test("translation is reachable in cloud mode without an explicit model", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationMode: "openwhispr",
      translationProvider: undefined,
      translationModel: "",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    true
  );
});

test("translation is reachable in self-hosted mode without an explicit model", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationMode: "self-hosted",
      translationProvider: undefined,
      translationModel: "",
      isCloudTranslation: false,
      isSelfHostedTranslation: true,
    }),
    true
  );
});

test("translation needs a model on model-required providers", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationMode: "providers",
      translationProvider: "openai",
      translationModel: "  ",
      isCloudTranslation: false,
      isSelfHostedTranslation: false,
    }),
    false
  );

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationMode: "providers",
      translationProvider: "openai",
      translationModel: "qwen3:8b",
      isCloudTranslation: false,
      isSelfHostedTranslation: false,
    }),
    true
  );
});

test("translation provider: available managed mode routes to openwhispr", async () => {
  const { resolveTranslationProviderId } = await load();

  assert.equal(
    resolveTranslationProviderId({
      isCloudTranslation: true,
      translationMode: "openwhispr",
      translationProvider: "openai",
    }),
    "openwhispr"
  );
});

test("translation provider: mode wins over stale provider and cloud state", async () => {
  const { resolveTranslationProviderId } = await load();

  for (const [translationMode, translationProvider, expected] of [
    ["providers", " groq ", "groq"],
    ["local", "qwen", "local"],
    ["local", "openai", "local"],
    ["self-hosted", "openai", undefined],
  ]) {
    assert.equal(
      resolveTranslationProviderId({
        isCloudTranslation: translationMode === "local",
        translationMode,
        translationProvider,
      }),
      expected
    );
  }
});

test("translation provider: empty local provider routes to llama.cpp", async () => {
  const { resolveTranslationProviderId } = await load();

  assert.equal(
    resolveTranslationProviderId({
      isCloudTranslation: false,
      translationMode: "local",
      translationProvider: "",
    }),
    "local"
  );
});

test("translation provider: incomplete managed and provider modes fail closed", async () => {
  const { resolveTranslationProviderId } = await load();

  for (const translationMode of ["openwhispr", "providers", "enterprise"]) {
    assert.equal(
      resolveTranslationProviderId({
        isCloudTranslation: false,
        translationMode,
        translationProvider: "  ",
      }),
      undefined
    );
  }
});

test("lifecycle input kind is translation or dictation", async () => {
  const { resolveLifecycleInputKind } = await load();
  assert.equal(resolveLifecycleInputKind({ translationRequested: true }), "translation");
  assert.equal(resolveLifecycleInputKind({}), "dictation");
});
