import enTranslation from "./en/translation.json";
import ptTranslation from "./pt/translation.json";

export const TRANSLATIONS_BY_LOCALE = {
  en: enTranslation,
  pt: ptTranslation,
} as const;
