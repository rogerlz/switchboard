const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ONBOARDING_DEMO_STATUSES,
  isOnboardingInputAllowed,
} = require("../../src/helpers/onboardingInputPolicy");

test("normal global inputs remain available outside onboarding", () => {
  for (const kind of ["dictation", "translation", "meeting"]) {
    assert.equal(isOnboardingInputAllowed(false, null, kind), true);
  }
});

test("onboarding blocks every global input outside a demo", () => {
  for (const kind of ["dictation", "translation", "meeting"]) {
    assert.equal(isOnboardingInputAllowed(true, null, kind), false);
  }
});

test("each onboarding demo allows only its matching recording input", () => {
  assert.equal(isOnboardingInputAllowed(true, "dictation", "dictation"), true);
  assert.equal(isOnboardingInputAllowed(true, "dictation", "translation"), false);
});

test("unknown demo kinds fail closed while onboarding is active", () => {
  assert.equal(isOnboardingInputAllowed(true, "unknown", "dictation"), false);
  assert.equal(isOnboardingInputAllowed(true, "assistant", "assistant"), false);
  assert.equal(isOnboardingInputAllowed(true, undefined, "dictation"), false);
});

test("the demo event allowlist admits dictation statuses only", () => {
  assert.equal(ONBOARDING_DEMO_STATUSES.has("partial"), true);
  assert.equal(ONBOARDING_DEMO_STATUSES.has("success"), true);
  assert.equal(ONBOARDING_DEMO_STATUSES.has("replying"), false);
});
