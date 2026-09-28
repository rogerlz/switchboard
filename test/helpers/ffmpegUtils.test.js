const test = require("node:test");
const assert = require("node:assert/strict");

const { isPcm16Mono16kWav } = require("../../src/helpers/ffmpegUtils");
const { wavHeader } = require("./harness/wavFixtures");

test("isPcm16Mono16kWav accepts only what the local engines decode as-is", () => {
  assert.equal(isPcm16Mono16kWav(wavHeader()), true);
  assert.equal(isPcm16Mono16kWav(wavHeader({ sampleRate: 48000 })), false);
  assert.equal(isPcm16Mono16kWav(wavHeader({ channels: 2 })), false);
  assert.equal(isPcm16Mono16kWav(wavHeader({ audioFormat: 3, bitsPerSample: 32 })), false);
  assert.equal(isPcm16Mono16kWav(Buffer.from("not a wav")), false);
});
