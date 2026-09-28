import modelDataRaw from "./modelRegistryData.json";
import { filterMeetingStreamingProviders } from "../helpers/meetingTranscriptionRouting";

export interface TranscriptionModelDefinition {
  id: string;
  name: string;
  description: string;
  descriptionKey?: string;
  streaming?: boolean;
}

export interface TranscriptionProviderData {
  id: string;
  name: string;
  baseUrl: string;
  models: TranscriptionModelDefinition[];
  /** Allows for a stream/batch split */
  batchModel?: string;
}

export interface WhisperModelInfo {
  name: string;
  description: string;
  descriptionKey?: string;
  size: string;
  sizeMb: number;
  fileName: string;
  downloadUrl: string;
  recommended?: boolean;
}

export interface WhisperModelConfig {
  url: string;
  size: number;
  fileName: string;
}

export type WhisperModelsMap = Record<string, WhisperModelInfo>;

export interface ParakeetModelInfo {
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

export type ParakeetModelsMap = Record<string, ParakeetModelInfo>;

interface ModelRegistryData {
  parakeetModels: ParakeetModelsMap;
  whisperModels: WhisperModelsMap;
  transcriptionProviders: TranscriptionProviderData[];
}

const modelData: ModelRegistryData = modelDataRaw as ModelRegistryData;

export type EnterpriseProvider = "bedrock" | "azure" | "vertex";
export const ENTERPRISE_PROVIDERS: readonly EnterpriseProvider[] = ["bedrock", "azure", "vertex"];
export function isEnterpriseProvider(value: unknown): value is EnterpriseProvider {
  return typeof value === "string" && (ENTERPRISE_PROVIDERS as readonly string[]).includes(value);
}

const ENTERPRISE_PROVIDER_NAMES: Record<EnterpriseProvider, string> = {
  bedrock: "AWS Bedrock",
  azure: "Azure OpenAI",
  vertex: "GCP Vertex AI",
};

export function enterpriseProviderName(provider: EnterpriseProvider): string {
  return ENTERPRISE_PROVIDER_NAMES[provider] ?? provider;
}

export function getTranscriptionProviders(): TranscriptionProviderData[] {
  return modelData.transcriptionProviders;
}

export function getStreamingTranscriptionProviders(): TranscriptionProviderData[] {
  return getTranscriptionProviders()
    .map((p) => ({ ...p, models: p.models.filter((m) => m.streaming) }))
    .filter((p) => p.models.length > 0);
}

// Streaming providers note recording can actually run (see
// meetingTranscriptionRouting.MEETING_STREAMING_PROVIDER_IDS).
export function getMeetingStreamingTranscriptionProviders(): TranscriptionProviderData[] {
  return filterMeetingStreamingProviders(getStreamingTranscriptionProviders());
}

export function getTranscriptionProvider(
  providerId: string
): TranscriptionProviderData | undefined {
  return getTranscriptionProviders().find((p) => p.id === providerId);
}

export function getTranscriptionModels(providerId: string): TranscriptionModelDefinition[] {
  const provider = getTranscriptionProvider(providerId);
  return provider?.models || [];
}

export function getBatchTranscriptionModel(providerId: string): string | undefined {
  return getTranscriptionProvider(providerId)?.batchModel;
}

export function getDefaultTranscriptionModel(providerId: string): string {
  const models = getTranscriptionModels(providerId);
  return models[0]?.id || "gpt-transcribe";
}

export function getWhisperModels(): WhisperModelsMap {
  return modelData.whisperModels;
}

export function getWhisperModelInfo(modelId: string): WhisperModelInfo | undefined {
  return modelData.whisperModels[modelId];
}

export const WHISPER_MODEL_INFO = modelData.whisperModels;

export function getParakeetModels(): ParakeetModelsMap {
  return modelData.parakeetModels;
}

export function getParakeetModelInfo(modelId: string): ParakeetModelInfo | undefined {
  return modelData.parakeetModels[modelId];
}

export function isOnlineParakeetModel(modelId: string): boolean {
  return modelData.parakeetModels[modelId]?.runtime === "online";
}

export function isCohereTranscribeModel(modelId: string): boolean {
  return modelData.parakeetModels[modelId]?.modelType === "cohere-transcribe";
}

// Both providers run on the parakeet/sherpa-onnx stack; only whisper differs.
export function isSherpaLocalProvider(provider: string): boolean {
  return provider === "nvidia" || provider === "cohere";
}

export const PARAKEET_MODEL_INFO = modelData.parakeetModels;

export function getWhisperModelConfig(modelId: string): WhisperModelConfig | null {
  const modelInfo = modelData.whisperModels[modelId];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.sizeMb * 1_000_000,
    fileName: modelInfo.fileName,
  };
}

export function getValidWhisperModelNames(): string[] {
  return Object.keys(modelData.whisperModels);
}
