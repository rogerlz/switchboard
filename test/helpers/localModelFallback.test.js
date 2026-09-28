const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/localModelFallback.js");

test("keeps a selection that is already downloaded", async () => {
  const { pickDownloadedLocalModel } = await load();
  const current = { provider: "whisper", whisperModel: "turbo", parakeetModel: "" };
  assert.equal(pickDownloadedLocalModel(current, { whisper: ["turbo"], parakeet: [] }), null);
});

test("a fresh profile on missing Whisper base moves to a downloaded model", async () => {
  const { pickDownloadedLocalModel } = await load();
  const current = { provider: "whisper", whisperModel: "base", parakeetModel: "" };
  assert.deepEqual(
    pickDownloadedLocalModel(current, {
      whisper: ["small", "turbo"],
      parakeet: ["orukeet-v0.1.0"],
    }),
    { provider: "whisper", model: "turbo" }
  );
  assert.deepEqual(
    pickDownloadedLocalModel(current, { whisper: [], parakeet: ["orukeet-v0.1.0"] }),
    { provider: "nvidia", model: "orukeet-v0.1.0" }
  );
});

test("does nothing for Cohere or when no model is downloaded", async () => {
  const { pickDownloadedLocalModel } = await load();
  assert.equal(
    pickDownloadedLocalModel({ provider: "cohere" }, { whisper: ["turbo"], parakeet: [] }),
    null
  );
  assert.equal(
    pickDownloadedLocalModel(
      { provider: "nvidia", whisperModel: "base", parakeetModel: "parakeet-tdt-0.6b-v3" },
      { whisper: [], parakeet: [] }
    ),
    null
  );
});
