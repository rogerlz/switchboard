const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeUiLanguage } = require("../../src/helpers/i18nMain");

describe("normalizeUiLanguage", () => {
  it("resolves every language to English, the only UI language", () => {
    assert.equal(normalizeUiLanguage("en-US"), "en");
    assert.equal(normalizeUiLanguage("pt-BR"), "en");
    assert.equal(normalizeUiLanguage(""), "en");
  });
});
