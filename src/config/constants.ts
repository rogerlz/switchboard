// Split query/hash so path-suffix stripping and later joins operate on the
// path only. Provider docs and Azure/gateway pastes often include ?api-version=
// (or similar) on a full /chat/completions URL (#1309).
function splitUrlDecorators(value: string): { path: string; query: string; hash: string } {
  let path = value;
  let hash = "";
  const hashIndex = path.indexOf("#");
  if (hashIndex >= 0) {
    hash = path.slice(hashIndex);
    path = path.slice(0, hashIndex);
  }
  let query = "";
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) {
    query = path.slice(queryIndex);
    path = path.slice(0, queryIndex);
  }
  return { path, query, hash };
}

function joinUrlDecorators(path: string, query: string, hash: string): string {
  return `${path}${query}${hash}`;
}

// API Configuration helpers
export const normalizeBaseUrl = (value?: string | null): string => {
  if (!value) return "";

  const trimmed = value.trim();
  if (!trimmed) return "";

  const { path: rawPath, query, hash } = splitUrlDecorators(trimmed);
  let normalized = rawPath;

  // Remove common API endpoint suffixes to get the base URL
  const suffixReplacements: Array<[RegExp, string]> = [
    [/\/v1\/chat\/completions$/i, "/v1"],
    [/\/chat\/completions$/i, ""],
    [/\/v1\/responses$/i, "/v1"],
    [/\/responses$/i, ""],
    [/\/v1\/models$/i, "/v1"],
    [/\/models$/i, ""],
    [/\/v1\/audio\/transcriptions$/i, "/v1"],
    [/\/audio\/transcriptions$/i, ""],
    [/\/v1\/audio\/translations$/i, "/v1"],
    [/\/audio\/translations$/i, ""],
  ];

  for (const [pattern, replacement] of suffixReplacements) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement).replace(/\/+$/, "");
    }
  }

  return joinUrlDecorators(normalized.replace(/\/+$/, ""), query, hash);
};

export const buildApiUrl = (base: string, path: string): string => {
  const normalizedBase = normalizeBaseUrl(base) || "https://api.openai.com/v1";
  if (!path) {
    return normalizedBase;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const { path: originAndPath, query, hash } = splitUrlDecorators(normalizedBase);
  return joinUrlDecorators(`${originAndPath}${normalizedPath}`, query, hash);
};

const env = (typeof import.meta !== "undefined" && (import.meta as any).env) || {};

const computeBaseUrl = (candidates: Array<string | undefined>, fallback: string): string => {
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return fallback;
};

const DEFAULT_OPENAI_BASE = computeBaseUrl(
  [env.OPENWHISPR_OPENAI_BASE_URL as string | undefined, env.OPENAI_BASE_URL as string | undefined],
  "https://api.openai.com/v1"
);

const DEFAULT_TRANSCRIPTION_BASE = computeBaseUrl(
  [
    env.OPENWHISPR_TRANSCRIPTION_BASE_URL as string | undefined,
    env.WHISPER_BASE_URL as string | undefined,
  ],
  DEFAULT_OPENAI_BASE
);

export const API_ENDPOINTS = {
  OPENAI_BASE: DEFAULT_OPENAI_BASE,
  TRANSCRIPTION_BASE: DEFAULT_TRANSCRIPTION_BASE,
  TRANSCRIPTION: buildApiUrl(DEFAULT_TRANSCRIPTION_BASE, "/audio/transcriptions"),
} as const;

// List length above which pickers switch to a searchable variant.
export const LIST_SEARCH_THRESHOLD = 12;

// Cache Configuration
export const CACHE_CONFIG = {
  API_KEY_TTL: 3600000, // 1 hour in milliseconds
  MODEL_CACHE_SIZE: 3, // Maximum models to keep in memory
  AVAILABILITY_CHECK_TTL: 30000, // 30s for accessibility, FFmpeg, tool availability checks
  PASTE_DELAY_MS: 50, // Delay before paste simulation to allow clipboard to settle
} as const;
