const i18next = require("i18next");

const SUPPORTED_UI_LANGUAGES = ["en"];

function normalizeUiLanguage(language) {
  const base = (language || "").trim().replace(/_/g, "-").toLowerCase().split("-")[0];
  return SUPPORTED_UI_LANGUAGES.includes(base) ? base : "en";
}

const i18nMain = i18next.createInstance();

void i18nMain.init({
  initAsync: false,
  resources: Object.fromEntries(
    SUPPORTED_UI_LANGUAGES.map((lang) => [
      lang,
      {
        translation: require(`../locales/${lang}/translation.json`),
        prompts: require(`../locales/${lang}/prompts.json`),
      },
    ])
  ),
  lng: normalizeUiLanguage(process.env.UI_LANGUAGE),
  fallbackLng: "en",
  ns: ["translation", "prompts"],
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnEmptyString: false,
  returnNull: false,
});

function changeLanguage(language) {
  const normalized = normalizeUiLanguage(language);

  if (i18nMain.language !== normalized) {
    void i18nMain.changeLanguage(normalized);
  }

  return normalized;
}

module.exports = {
  i18nMain,
  changeLanguage,
  normalizeUiLanguage,
  SUPPORTED_UI_LANGUAGES,
};
