import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { TRANSLATIONS_BY_LOCALE } from "./locales/translations";

export const SUPPORTED_UI_LANGUAGES = ["en"] as const;
export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export function normalizeUiLanguage(language: string | null | undefined): UiLanguage {
  // Keep in sync with src/helpers/i18nMain.js.
  const base = (language || "").trim().replace(/_/g, "-").toLowerCase().split("-")[0];
  return (SUPPORTED_UI_LANGUAGES as readonly string[]).includes(base) ? (base as UiLanguage) : "en";
}

const resources = Object.fromEntries(
  SUPPORTED_UI_LANGUAGES.map((lang) => [lang, { translation: TRANSLATIONS_BY_LOCALE[lang] }])
);

const browserLanguage =
  typeof navigator !== "undefined" ? navigator.language || navigator.languages?.[0] : undefined;

const storageLanguage =
  typeof window !== "undefined" ? window.localStorage?.getItem("uiLanguage") : undefined;

const initialLanguage = normalizeUiLanguage(storageLanguage || browserLanguage || "en");

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: "en",
  ns: ["translation"],
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnEmptyString: true,
  returnNull: false,
});

export default i18n;
