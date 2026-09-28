import orukIcon from "@/assets/icons/providers/oruk.webp";
import openaiIcon from "@/assets/icons/providers/openai.svg";
import geminiIcon from "@/assets/icons/providers/gemini.svg";
import mistralIcon from "@/assets/icons/providers/mistral.svg";
import groqIcon from "@/assets/icons/providers/groq.svg";
// The square brand tile (green field, white mark) rather than the bare eye: the
// eye SVG is 163x108, and ProviderIcon renders a square img, so it came out
// squashed in every row. WebP because NVIDIA ships the tile as raster art.
import nvidiaIcon from "@/assets/icons/providers/nvidia.webp";
import cohereIcon from "@/assets/icons/providers/cohere.svg";
import azureIcon from "@/assets/icons/providers/azure.svg";
import xaiIcon from "@/assets/icons/providers/xai.svg";
import cortiIcon from "@/assets/icons/providers/corti.svg";
import tinfoilIcon from "@/assets/icons/providers/tinfoil.svg";
import deepgramIcon from "@/assets/icons/providers/deepgram.svg";
import assemblyaiIcon from "@/assets/icons/providers/assemblyai.svg";

export const PROVIDER_ICONS: Record<string, string> = {
  oruk: orukIcon,
  openai: openaiIcon,
  whisper: openaiIcon,
  gemini: geminiIcon,
  mistral: mistralIcon,
  groq: groqIcon,
  nvidia: nvidiaIcon,
  cohere: cohereIcon,
  azure: azureIcon,
  xai: xaiIcon,
  corti: cortiIcon,
  tinfoil: tinfoilIcon,
  deepgram: deepgramIcon,
  assemblyai: assemblyaiIcon,
};

export function getProviderIcon(provider: string): string | undefined {
  return PROVIDER_ICONS[provider];
}

export const MONOCHROME_PROVIDERS = [
  "openai",
  "whisper",
  "xai",
  "corti",
  "tinfoil",
  "assemblyai",
] as const;

export function isMonochromeProvider(provider: string): boolean {
  return (MONOCHROME_PROVIDERS as readonly string[]).includes(provider);
}

// OpenRouter-style provider prefixes (the slug before "/") → our internal icon keys.
const REMOTE_PROVIDER_ALIASES: Record<string, string> = {
  google: "gemini",
  mistralai: "mistral",
  "x-ai": "xai",
};

// Resolves the icon for a remote provider prefix (e.g. "openai" from "openai/gpt-4").
// A model family with its own icon wins over the publisher prefix.
export function getRemoteProviderIcon(
  prefix: string,
  modelName?: string
): {
  icon: string | undefined;
  invertInDark: boolean;
} {
  const base = prefix.startsWith("~") ? prefix.slice(1) : prefix;
  const family = modelName?.split(/[-.:@ ]/, 1)[0].toLowerCase();
  const key = family && PROVIDER_ICONS[family] ? family : (REMOTE_PROVIDER_ALIASES[base] ?? base);
  return { icon: PROVIDER_ICONS[key], invertInDark: isMonochromeProvider(key) };
}
