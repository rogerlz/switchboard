const i18next = require("i18next");

const i18nMain = i18next.createInstance();

void i18nMain.init({
  initAsync: false,
  resources: { en: { translation: require("../locales/en/translation.json") } },
  lng: "en",
  fallbackLng: "en",
  ns: ["translation"],
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnEmptyString: false,
  returnNull: false,
});

module.exports = { i18nMain };
