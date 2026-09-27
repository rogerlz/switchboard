const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/gpuBannerPolicy.ts");

const offersWith = async (overrides) => {
  const { eligibleGpuOffers } = await load();
  return eligibleGpuOffers({
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    useCleanupModel: false,
    cleanupMode: "openwhispr",
    ...overrides,
  });
};

test("cloud cleanup (openwhispr default) is not eligible for the intelligence GPU offer", async () => {
  const offers = await offersWith({ useCleanupModel: true, cleanupMode: "openwhispr" });

  assert.equal(offers.intelligence, null);
});

test("cloud cleanup modes are never eligible even with cleanup enabled", async () => {
  for (const cleanupMode of ["openwhispr", "providers", "self-hosted", "enterprise"]) {
    const offers = await offersWith({ useCleanupModel: true, cleanupMode });
    assert.equal(offers.intelligence, null, `cleanupMode=${cleanupMode}`);
  }
});

test("local cleanup with the model enabled targets the cleanup tab", async () => {
  const offers = await offersWith({ useCleanupModel: true, cleanupMode: "local" });

  assert.equal(offers.intelligence, "cleanup");
});

test("local cleanup with the model disabled is not eligible", async () => {
  const offers = await offersWith({ useCleanupModel: false, cleanupMode: "local" });

  assert.equal(offers.intelligence, null);
});





test("local whisper transcription is eligible for the transcription GPU offer", async () => {
  const offers = await offersWith({ useLocalWhisper: true });

  assert.equal(offers.transcription, true);
});

test("cloud transcription and non-whisper local providers are not eligible", async () => {
  const cloud = await offersWith({ useLocalWhisper: false });
  assert.equal(cloud.transcription, false);

  const parakeet = await offersWith({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
  });
  assert.equal(parakeet.transcription, false);
});
