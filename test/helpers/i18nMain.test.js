const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeUiLanguage } = require("../../src/helpers/i18nMain");

describe("normalizeUiLanguage", () => {
  it("maps region and underscore tags onto the base language", () => {
    assert.equal(normalizeUiLanguage("en-US"), "en");
    assert.equal(normalizeUiLanguage("pt-BR"), "pt");
    assert.equal(normalizeUiLanguage("pt_PT"), "pt");
  });

  it("falls back to English for unsupported languages", () => {
    assert.equal(normalizeUiLanguage("de-DE"), "en");
    assert.equal(normalizeUiLanguage("ko-KR"), "en");
    assert.equal(normalizeUiLanguage(""), "en");
  });
});
