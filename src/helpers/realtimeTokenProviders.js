// Realtime STT token acquisition, one entry per provider. This is the explicit
// allowlist fetchRealtimeToken enforces: an unknown provider throws (fail-closed,
// #1480); meeting prepare/start resolve their provider ids in
// meetingTranscriptionRouting.js. Every provider runs on the user's own key.
// Dependencies are injected so the table is unit-testable without Electron.

const dual = (streams, factory) =>
  streams === 2 ? Promise.all([factory(), factory()]) : factory();
const duplicate = (streams, value) => (streams === 2 ? [value, value] : value);

const requireKey = (apiKey, providerName) => {
  if (!apiKey) {
    throw new Error(`No ${providerName} API key configured. Add your key in Settings.`);
  }
  return apiKey;
};

const REALTIME_TOKEN_PROVIDERS = {
  "assemblyai-realtime": async ({ environmentManager, proxyFetch }, _options, streams) => {
    const apiKey = requireKey(environmentManager.getAssemblyAIKey(), "AssemblyAI");
    return dual(streams, async () => {
      const response = await proxyFetch(
        "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60",
        { headers: { Authorization: apiKey } }
      );
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `AssemblyAI token request failed: ${response.status}`);
      }
      const data = await response.json();
      if (!data.token) throw new Error("No AssemblyAI token received");
      return data.token;
    });
  },

  "deepgram-realtime": async ({ environmentManager }, _options, streams) =>
    duplicate(streams, requireKey(environmentManager.getDeepgramKey(), "Deepgram")),

  // The raw key opens the Live socket directly (BidiGenerateContent?key=) and is
  // not consumed by a handshake, so both streams can share it.
  "gemini-realtime": async ({ environmentManager }, _options, streams) =>
    duplicate(streams, requireKey(environmentManager.getGeminiKey(), "Gemini")),

  "corti-realtime": async ({ mintCortiToken }, options, streams) => {
    // One token covers both meeting streams; it's only used at the WSS handshake.
    const { token } = await mintCortiToken(options);
    return duplicate(streams, token);
  },

  "tinfoil-realtime": async ({ environmentManager }, _options, streams) => {
    const apiKey = environmentManager.getTinfoilKey();
    if (!apiKey) {
      const err = new Error("No Tinfoil API key configured. Add your key in Settings.");
      err.code = "NO_API";
      throw err;
    }
    return duplicate(streams, apiKey);
  },

  "openai-realtime": async ({ environmentManager }, _options, streams) =>
    duplicate(streams, requireKey(environmentManager.getOpenAIKey(), "OpenAI")),
};

async function fetchRealtimeTokenForProvider(provider, deps, options, { streams } = {}) {
  const acquire = REALTIME_TOKEN_PROVIDERS[provider];
  if (!acquire) {
    throw new Error(`Unsupported realtime token provider: ${provider}`);
  }
  return acquire(deps, options, streams);
}

module.exports = {
  REALTIME_TOKEN_PROVIDERS,
  fetchRealtimeTokenForProvider,
};
