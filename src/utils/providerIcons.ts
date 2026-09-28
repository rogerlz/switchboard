import orukIcon from "@/assets/icons/providers/oruk.webp";
import openaiIcon from "@/assets/icons/providers/openai.svg";
// The square brand tile (green field, white mark) rather than the bare eye: the
// eye SVG is 163x108, and ProviderIcon renders a square img, so it came out
// squashed in every row. WebP because NVIDIA ships the tile as raster art.
import nvidiaIcon from "@/assets/icons/providers/nvidia.webp";
import cohereIcon from "@/assets/icons/providers/cohere.svg";
import cortiIcon from "@/assets/icons/providers/corti.svg";
import tinfoilIcon from "@/assets/icons/providers/tinfoil.svg";
import deepgramIcon from "@/assets/icons/providers/deepgram.svg";
import assemblyaiIcon from "@/assets/icons/providers/assemblyai.svg";

const PROVIDER_ICONS: Record<string, string> = {
  oruk: orukIcon,
  openai: openaiIcon,
  whisper: openaiIcon,
  nvidia: nvidiaIcon,
  cohere: cohereIcon,
  corti: cortiIcon,
  tinfoil: tinfoilIcon,
  deepgram: deepgramIcon,
  assemblyai: assemblyaiIcon,
};

export function getProviderIcon(provider: string): string | undefined {
  return PROVIDER_ICONS[provider];
}

const MONOCHROME_PROVIDERS = ["openai", "whisper", "corti", "tinfoil", "assemblyai"] as const;

export function isMonochromeProvider(provider: string): boolean {
  return (MONOCHROME_PROVIDERS as readonly string[]).includes(provider);
}
