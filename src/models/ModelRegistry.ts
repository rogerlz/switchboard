import modelDataRaw from "./modelRegistryData.json";
import { filterMeetingStreamingProviders } from "../helpers/meetingTranscriptionRouting";

interface TranscriptionModelDefinition {
  id: string;
  name: string;
  description: string;
  descriptionKey?: string;
  streaming?: boolean;
}

export interface TranscriptionProviderData {
  id: string;
  name: string;
  models: TranscriptionModelDefinition[];
}

interface WhisperModelInfo {
  name: string;
  description: string;
  descriptionKey?: string;
  size: string;
  sizeMb: number;
  fileName: string;
  downloadUrl: string;
  recommended?: boolean;
}

type WhisperModelsMap = Record<string, WhisperModelInfo>;

interface ParakeetModelInfo {
  name: string;
  description: string;
  descriptionKey?: string;
  size: string;
  sizeMb: number;
  expectedSizeBytes?: number;
  manifestUrl?: string;
  language: string;
  supportedLanguages: string[];
  runtime?: "offline" | "online";
  modelType?: "transducer" | "cohere-transcribe";
  /** Verified sherpa decoder type; skips redundant encoder loading during detection. */
  sherpaModelType?: "nemo_transducer";
  organization?: { id: string; name: string };
  license?: string;
  modelCardUrl?: string;
  recommended?: boolean;
  downloadUrl: string;
  extractDir: string;
}

type ParakeetModelsMap = Record<string, ParakeetModelInfo>;

interface ModelRegistryData {
  parakeetModels: ParakeetModelsMap;
  whisperModels: WhisperModelsMap;
  transcriptionProviders: TranscriptionProviderData[];
}

const modelData: ModelRegistryData = modelDataRaw as ModelRegistryData;

// Streaming providers the meeting pipeline can actually run (see
// meetingTranscriptionRouting.MEETING_STREAMING_PROVIDER_IDS).
export function getMeetingStreamingTranscriptionProviders(): TranscriptionProviderData[] {
  return filterMeetingStreamingProviders(
    modelData.transcriptionProviders
      .map((p) => ({ ...p, models: p.models.filter((m) => m.streaming) }))
      .filter((p) => p.models.length > 0)
  );
}

export const WHISPER_MODEL_INFO = modelData.whisperModels;

// Both providers run on the parakeet/sherpa-onnx stack; only whisper differs.
export function isSherpaLocalProvider(provider: string): boolean {
  return provider === "nvidia" || provider === "cohere";
}

export const PARAKEET_MODEL_INFO = modelData.parakeetModels;
