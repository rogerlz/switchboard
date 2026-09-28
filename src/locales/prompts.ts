import enPrompts from "./en/prompts.json";

export interface PromptBundle {
  cleanupPrompt: string;
  dictionarySuffix: string;
  translatePrompt: string;
}

export const en: PromptBundle = enPrompts;

export const PROMPTS_BY_LOCALE = { en } as const;
