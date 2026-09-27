import enPrompts from "./en/prompts.json";
import ptPrompts from "./pt/prompts.json";

export interface PromptBundle {
  cleanupPrompt: string;
  dictionarySuffix: string;
  translatePrompt: string;
}

export const en: PromptBundle = enPrompts;
export const pt: PromptBundle = ptPrompts;

export const PROMPTS_BY_LOCALE = { en, pt } as const;
