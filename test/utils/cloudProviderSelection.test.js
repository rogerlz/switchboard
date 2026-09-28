const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/cloudProviderSelection.ts");

test("an unavailable provider falls back to the first offered one", async () => {
  const { reconcileCloudProviderSelection } = await load();
  const allowedProviders = [
    { id: "openai", models: [{ id: "whisper-1" }] },
    { id: "mistral", models: [{ id: "voxtral-mini" }] },
  ];

  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "groq",
      selectedModel: "whisper-large-v3",
      allowedProviders,
    }),
    { provider: "openai", model: "whisper-1" }
  );
  assert.equal(
    reconcileCloudProviderSelection({
      selectedProvider: "mistral",
      selectedModel: "voxtral-mini",
      allowedProviders,
    }),
    null
  );

  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "openai",
      selectedModel: "whisper-large-v3",
      allowedProviders,
    }),
    { provider: "openai", model: "whisper-1" }
  );

  assert.equal(
    reconcileCloudProviderSelection({
      selectedProvider: "groq",
      selectedModel: "whisper-large-v3",
      allowedProviders: [],
    }),
    null
  );
});

// The STT picker feeds reconcile the browsed tab (browsedCloudProvider ??
// selectedCloudProvider) while the committed pair stays untouched in the store.
test("a browsed provider resolves for display without leaking the committed model", async () => {
  const { reconcileCloudProviderSelection } = await load();
  const allowedProviders = [
    { id: "openai", models: [{ id: "whisper-1" }] },
    { id: "groq", models: [{ id: "whisper-large-v3" }] },
  ];

  // Browsing an allowed tab: the display lands on the browsed provider with
  // its own default — the committed model (openai's) never leaks into it.
  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "groq",
      selectedModel: "whisper-1",
      allowedProviders,
    }),
    { provider: "groq", model: "whisper-large-v3" }
  );

  // A browsed provider this scope does not offer falls back.
  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "xai",
      selectedModel: "whisper-1",
      allowedProviders,
    }),
    { provider: "openai", model: "whisper-1" }
  );
});
