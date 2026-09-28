// ESM like meetingJoinUrl.js: pure, shared with the renderer.

/**
 * When the selected local meeting model isn't on disk (a fresh profile starts
 * on Whisper "base"), pick one that is: the same engine first, then the other.
 * Returns null when the selection is fine or nothing is downloaded.
 */
export function pickDownloadedLocalModel({ provider, whisperModel, parakeetModel }, downloaded) {
  if (provider === "cohere") return null;
  const whisper = downloaded.whisper ?? [];
  const parakeet = downloaded.parakeet ?? [];
  const selected = provider === "nvidia" ? parakeetModel : whisperModel;
  if ((provider === "nvidia" ? parakeet : whisper).includes(selected)) return null;

  // Whisper's registry runs small → large, so the last one is the most capable.
  const bestWhisper = whisper.at(-1);
  const bestParakeet = parakeet[0];
  const sameEngine = provider === "nvidia" ? bestParakeet : bestWhisper;
  if (sameEngine)
    return { provider: provider === "nvidia" ? "nvidia" : "whisper", model: sameEngine };
  if (bestParakeet) return { provider: "nvidia", model: bestParakeet };
  if (bestWhisper) return { provider: "whisper", model: bestWhisper };
  return null;
}
