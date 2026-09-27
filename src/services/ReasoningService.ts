import {
  resolveInferenceProvider,
  getCloudModel,
  getOpenAiApiConfig,
  getProviderDisplayName,
  isEnterpriseProvider,
  type EnterpriseProvider,
} from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy, httpError } from "../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl, ensureV1Suffix } from "../config/constants";
import logger from "../utils/logger";
import { assertValidCleanupOutput } from "../utils/cleanupOutput";
import { getSettings, isCloudCleanupMode } from "../stores/settingsStore";
import { wrapCleanupTranscript } from "../config/prompts";
import { stripThinkingTags } from "../helpers/stripThinking.js";
import {
  getLlmRequestTimeoutSeconds,
  llmRequestTimeoutError,
} from "../helpers/llmRequestTimeout.js";
import { streamText, stepCountIs } from "ai";
import { getAIModel } from "./ai/providers";
import { createEnterpriseChatModel } from "./ai/enterpriseChatModel";
import { getManagedScopeResolution } from "../stores/enterpriseIdentityStore";
import type { InferenceScope } from "../config/inferenceScopes";
import { PROVIDER_REGISTRY, type ProviderContext } from "./ai/inferenceProviders";
import {
  canBorrowCleanupCustomKey,
  resolveConfiguredOpenAIBase,
  resolveSelfHostedOpenAIBase,
} from "./ai/openaiBase";
import {
  applyChatCompletionsParams,
  emptyResponseError,
  fetchWithParamFallback,
  isTruncatedFinishReason,
  truncatedOutputError,
} from "./ai/chatRequestBody";
import { getModelFamilyConstraints } from "./ai/modelFamilyConstraints";
import { detectEndpointDialect } from "./ai/thinkingSuppressionDialects";
import { openCodeSessionHeaders } from "./ai/openCodeSession";
import { createStreamingThinkFilter } from "./ai/streamingThinkFilter";
import { extractApiErrorMessage } from "./ai/apiErrorMessage";
import { clearTinfoilClientCache } from "./ai/tinfoilClient";
import { resolveChatRoute } from "../helpers/chatRouting";
import { assertAgentAllowedByPolicy, assertReasoningAllowedByPolicy } from "./reasoningPolicy";
import type { InferenceMode } from "../types/electron";

export type ToolMetadata = Record<string, unknown> | Array<Record<string, unknown>>;

interface ToolExecutionResult {
  data: string;
  displayText: string;
  metadata?: ToolMetadata;
}

const BYOK_STREAM_PROVIDERS = [
  "openai",
  "groq",
  "gemini",
  "anthropic",
  "tinfoil",
  "custom",
  "openrouter",
  "corti",
] as const;

type ByokStreamProvider = (typeof BYOK_STREAM_PROVIDERS)[number];

function toByokStreamProvider(provider: string): ByokStreamProvider {
  if (!(BYOK_STREAM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unsupported reasoning provider: ${provider}`);
  }
  return provider as ByokStreamProvider;
}

export type AgentStreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | {
      type: "tool_result";
      callId: string;
      toolName: string;
      displayText: string;
      metadata?: ToolMetadata;
    }
  | { type: "done"; finishReason?: string };

function resolveLlmDispatchMode(
  provider: string,
  config: Pick<ReasoningConfig, "lanUrl">
): InferenceMode {
  if (config.lanUrl || provider === "lan") return "self-hosted";
  if (provider === "openwhispr") return "openwhispr";
  if (provider === "local") return "local";
  if (isEnterpriseProvider(provider)) return "enterprise";
  return "providers";
}

function assertAgentSessionAllowedByPolicy(provider: string, mode: InferenceMode): void {
  assertAgentAllowedByPolicy();
  assertReasoningAllowedByPolicy(provider, mode);
}

function logParamFallback(logEvent: string) {
  return (details: { status: number; stripped: string[] }) =>
    logger.logReasoning(logEvent, details);
}

class ReasoningService extends BaseReasoningService {
  private apiKeyCache: SecureCache<string>;
  private static readonly MAX_TOOL_STEPS = 20;
  private cacheCleanupStop: (() => void) | undefined;
  private streamAbortController: AbortController | null = null;
  private activeRequestControllers = new Set<AbortController>();
  private activeCloudStream: { requestId: string; cancel: () => void } | null = null;
  private cloudOperationGeneration = 0;
  private requestCancellationGeneration = 0;

  private readonly providerContext: ProviderContext;

  constructor() {
    super();
    this.apiKeyCache = new SecureCache();
    this.cacheCleanupStop = this.apiKeyCache.startAutoCleanup();
    this.providerContext = {
      getApiKey: (provider: string) =>
        this.getApiKey(provider as Parameters<ReasoningService["getApiKey"]>[0]),
      getSystemPrompt: this.getSystemPrompt.bind(this),
      getCustomDictionary: this.getCustomDictionary.bind(this),
      getPreferredLanguage: this.getPreferredLanguage.bind(this),
      getUiLanguage: this.getUiLanguage.bind(this),
      callChatCompletionsApi: this.callChatCompletionsApi.bind(this),
      calculateMaxTokens: this.calculateMaxTokens.bind(this),
    };

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private hasLanCleanupConfiguration(): boolean {
    const settings = getSettings();
    return settings.cleanupMode === "self-hosted" && !!settings.cleanupRemoteUrl?.trim();
  }

  // Managed enterprise access owns the route. Manual self-hosted and BYOK overrides are
  // dropped so a leftover endpoint or key can never outrank the administrator's provider.
  private resolveManagedScope<T extends ReasoningConfig, P extends string | undefined>(
    model: string,
    provider: P,
    config: T,
    fallbackScope: InferenceScope
  ): { model: string; provider: P; config: T; isManaged: boolean } {
    const inferenceScope = config.inferenceScope || fallbackScope;
    const managed = getManagedScopeResolution(inferenceScope, getSettings().enterpriseSetupMode);
    if (managed.kind === "error") {
      throw Object.assign(new Error(managed.message), {
        code: managed.code,
        messageKey: managed.messageKey,
      });
    }
    if (managed.kind !== "managed") {
      return { model, provider, config: { ...config, inferenceScope }, isManaged: false };
    }
    return {
      model: managed.model,
      provider: managed.provider as P,
      config: {
        ...config,
        inferenceScope,
        provider: managed.provider,
        lanUrl: undefined,
        baseUrl: undefined,
        customApiKey: undefined,
      },
      isManaged: true,
    };
  }

  private async getApiKey(
    provider:
      "openai" | "anthropic" | "gemini" | "groq" | "tinfoil" | "custom" | "openrouter" | "corti"
  ): Promise<string> {
    if (provider === "custom") {
      let customKey = "";
      try {
        customKey = (await window.electronAPI?.getCleanupCustomKey?.()) || "";
      } catch (err) {
        logger.logReasoning("CUSTOM_KEY_IPC_FALLBACK", { error: (err as Error)?.message });
      }
      if (!customKey || !customKey.trim()) {
        customKey = getSettings().cleanupCustomApiKey || "";
      }
      const trimmedKey = customKey.trim();

      logger.logReasoning("CUSTOM_KEY_RETRIEVAL", {
        provider,
        hasKey: !!trimmedKey,
        keyLength: trimmedKey.length,
      });

      return trimmedKey;
    }

    let apiKey = this.apiKeyCache.get(provider);

    logger.logReasoning(`${provider.toUpperCase()}_KEY_RETRIEVAL`, {
      provider,
      fromCache: !!apiKey,
      cacheSize: this.apiKeyCache.size || 0,
    });

    if (!apiKey) {
      try {
        const keyGetters = {
          openai: () => window.electronAPI.getOpenAIKey(),
          anthropic: () => window.electronAPI.getAnthropicKey(),
          gemini: () => window.electronAPI.getGeminiKey(),
          groq: () => window.electronAPI.getGroqKey(),
          openrouter: () => window.electronAPI.getOpenrouterKey(),
          tinfoil: () => window.electronAPI.getTinfoilKey?.(),
          corti: () => window.electronAPI.getCortiKey?.(),
        };
        apiKey = (await keyGetters[provider]()) ?? undefined;

        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCHED`, {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
        });

        if (apiKey) {
          this.apiKeyCache.set(provider, apiKey);
        }
      } catch (error) {
        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCH_ERROR`, {
          provider,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
      }
    }

    if (!apiKey) {
      const displayName = getProviderDisplayName(provider);
      const errorMsg = `${displayName} API key not configured`;
      logger.logReasoning(`${provider.toUpperCase()}_KEY_MISSING`, {
        provider,
        error: errorMsg,
      });
      const error = new Error(errorMsg) as Error & { code: string; provider: string };
      error.code = "API_KEY_MISSING";
      error.provider = displayName;
      throw error;
    }

    return apiKey;
  }

  // Single source for BYOK streaming credentials and endpoint overrides:
  // rejects unknown providers instead of defaulting them to OpenAI, and only
  // lets a custom scope borrow the shared cleanup key for the cleanup endpoint.
  private async resolveByokAccess(
    provider: string,
    config: Pick<ReasoningConfig, "baseUrl" | "customApiKey">
  ): Promise<{ apiKey: string; baseURL?: string }> {
    const providerKey = toByokStreamProvider(provider);
    const overrideKey = providerKey === "custom" ? config.customApiKey?.trim() || "" : "";
    const canFallBackToSharedKey =
      providerKey !== "custom" || canBorrowCleanupCustomKey(config.baseUrl);
    const apiKey = overrideKey || (canFallBackToSharedKey ? await this.getApiKey(providerKey) : "");
    const baseURL =
      providerKey === "openrouter"
        ? API_ENDPOINTS.OPENROUTER_BASE
        : providerKey === "custom"
          ? resolveConfiguredOpenAIBase(providerKey, config.baseUrl)
          : undefined;
    return { apiKey, baseURL };
  }

  private async callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig,
    providerName: string
  ): Promise<string> {
    // No systemPrompt override means the default cleanup path: a deterministic
    // transform, so zero temperature and a delimited transcript.
    const isCleanup = !config.systemPrompt;
    const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName);
    const userPrompt = isCleanup ? wrapCleanupTranscript(text) : text;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const requestBody: any = { model, messages };
    applyChatCompletionsParams(requestBody, {
      model,
      provider: providerName,
      endpoint,
      config,
      maxTokens:
        config.maxTokens ||
        Math.max(
          4096,
          this.calculateMaxTokens(
            text.length,
            TOKEN_LIMITS.MIN_TOKENS,
            TOKEN_LIMITS.MAX_TOKENS,
            TOKEN_LIMITS.TOKEN_MULTIPLIER
          )
        ),
    });

    logger.logReasoning(`${providerName.toUpperCase()}_REQUEST`, {
      endpoint,
      model,
      hasApiKey: !!apiKey,
      requestBody: JSON.stringify(requestBody).substring(0, 200),
    });

    // Minted before the retry loop so every attempt of this call is one conversation.
    const openCodeHeaders = openCodeSessionHeaders(endpoint);

    const requestGeneration = this.requestCancellationGeneration;
    const response = await withRetry(async () => {
      if (requestGeneration !== this.requestCancellationGeneration) {
        throw httpError("Request cancelled", 499);
      }
      const controller = new AbortController();
      this.activeRequestControllers.add(controller);
      const timeoutSeconds = getLlmRequestTimeoutSeconds({ scope: config.inferenceScope });
      const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...openCodeHeaders,
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const res = await fetchWithParamFallback(
          () =>
            fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            }),
          requestBody,
          logParamFallback(`${providerName.toUpperCase()}_PARAM_FALLBACK`)
        );

        if (!res.ok) {
          const errorText = await res.text();
          let errorData: any = { error: res.statusText };

          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { error: errorText || res.statusText };
          }

          const errorMessage = extractApiErrorMessage(
            errorData,
            `${providerName} API error: ${res.status}`
          );

          logger.logReasoning(`${providerName.toUpperCase()}_API_ERROR_DETAIL`, {
            status: res.status,
            statusText: res.statusText,
            error: errorData,
            errorMessage,
            fullResponse: errorText.substring(0, 500),
          });
          throw httpError(errorMessage, res.status);
        }

        const jsonResponse = await res.json();

        logger.logReasoning(`${providerName.toUpperCase()}_RAW_RESPONSE`, {
          hasResponse: !!jsonResponse,
          responseKeys: jsonResponse ? Object.keys(jsonResponse) : [],
          hasChoices: !!jsonResponse?.choices,
          choicesLength: jsonResponse?.choices?.length || 0,
          fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
        });

        return jsonResponse;
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          if (requestGeneration !== this.requestCancellationGeneration) {
            throw httpError("Request cancelled", 499);
          }
          throw llmRequestTimeoutError(timeoutSeconds);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        this.activeRequestControllers.delete(controller);
      }
    }, createApiRetryStrategy());

    if (!response.choices || !response.choices[0]) {
      logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE_ERROR`, {
        model,
        response: JSON.stringify(response).substring(0, 500),
        hasChoices: !!response.choices,
        choicesCount: response.choices?.length || 0,
      });
      throw new Error(`Invalid response structure from ${providerName} API`);
    }

    const choice = response.choices[0];
    if (config.requireCompleteOutput && isTruncatedFinishReason(choice?.finish_reason)) {
      throw truncatedOutputError();
    }
    // Reasoning models leak <think> blocks into non-streamed output; strip them
    // unless the user explicitly enabled thinking (same default as streaming).
    const rawContent = choice.message?.content?.trim() || "";
    const responseText =
      config.disableThinking !== false ? stripThinkingTags(rawContent) : rawContent;

    if (!responseText) {
      logger.logReasoning(`${providerName.toUpperCase()}_EMPTY_RESPONSE`, {
        model,
        finishReason: choice.finish_reason,
        hasMessage: !!choice.message,
        response: JSON.stringify(choice).substring(0, 500),
      });
      throw (
        emptyResponseError(providerName, config, isTruncatedFinishReason(choice.finish_reason)) ??
        new Error(`${providerName} returned empty response`)
      );
    }

    logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE`, {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
    });

    return responseText;
  }

  async processText(
    text: string,
    model: string = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    const managed = this.resolveManagedScope(model, config.provider, config, "dictationCleanup");
    ({ model, config } = managed);
    const trimmedModel = model?.trim?.() || "";
    const settings = getSettings();
    const validateCleanup =
      config.inferenceScope === "dictationCleanup" &&
      !config.systemPrompt &&
      !config.requiresAgent &&
      !settings.customPrompts.cleanup;
    const isImplicitCleanup =
      config.provider === undefined && config.baseUrl === undefined && config.lanUrl === undefined;
    const implicitProvider =
      settings.cleanupMode === "openwhispr"
        ? "openwhispr"
        : settings.cleanupMode === "self-hosted"
          ? "lan"
          : settings.cleanupProvider || undefined;
    const isImplicitCustomCleanup =
      isImplicitCleanup && settings.cleanupMode === "providers" && implicitProvider === "custom";
    const dispatchConfig: ReasoningConfig = isImplicitCleanup
      ? {
          ...config,
          provider: implicitProvider,
          baseUrl: isImplicitCustomCleanup ? settings.cleanupCloudBaseUrl : undefined,
          customApiKey: isImplicitCustomCleanup
            ? (config.customApiKey ?? settings.cleanupCustomApiKey)
            : config.customApiKey,
        }
      : config;
    const isLanCleanup = !!dispatchConfig.lanUrl || dispatchConfig.provider === "lan";
    const providerId = isLanCleanup
      ? "lan"
      : resolveInferenceProvider(dispatchConfig.provider, trimmedModel);
    if (!providerId) {
      throw new Error("No reasoning provider selected");
    }
    if (dispatchConfig.requiresAgent) assertAgentAllowedByPolicy();
    assertReasoningAllowedByPolicy(providerId, resolveLlmDispatchMode(providerId, dispatchConfig));

    if (!trimmedModel && providerId !== "openwhispr" && providerId !== "lan") {
      throw new Error("No reasoning model selected");
    }

    logger.logReasoning("PROVIDER_SELECTION", {
      provider: providerId,
      model: trimmedModel,
      agentName,
      isLanCleanup,
      textLength: text.length,
    });

    const handler = PROVIDER_REGISTRY[providerId];
    if (!handler) {
      throw new Error(`Unsupported reasoning provider: ${providerId}`);
    }

    const startTime = Date.now();
    try {
      const result = await handler.call({
        text,
        model: trimmedModel,
        agentName,
        config: dispatchConfig,
        ctx: this.providerContext,
      });

      if (validateCleanup) assertValidCleanupOutput(text, result);

      logger.logReasoning("PROVIDER_SUCCESS", {
        provider: providerId,
        model: trimmedModel,
        processingTimeMs: Date.now() - startTime,
        resultLength: result.length,
      });

      return result;
    } catch (error) {
      logger.logReasoning("PROVIDER_ERROR", {
        provider: providerId,
        model: trimmedModel,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  cancelActiveStream(): void {
    this.cloudOperationGeneration += 1;
    this.streamAbortController?.abort();
    this.streamAbortController = null;
    const activeCloudStream = this.activeCloudStream;
    this.activeCloudStream = null;
    activeCloudStream?.cancel();
  }

  /**
   * Aborts everything in flight in this renderer: the chat stream plus every
   * single-shot request (cleanup, selection edit, titles) and the cloud-reason
   * IPC jobs. Used by the dictation cancel path, never by chat lifecycle —
   * a note or tab switch must not kill unrelated reasoning work.
   */
  cancelAllRequests(): void {
    this.requestCancellationGeneration += 1;
    for (const controller of this.activeRequestControllers) controller.abort();
    this.activeRequestControllers.clear();
    if (typeof window !== "undefined") {
      window.electronAPI?.cancelCloudReason?.();
      window.electronAPI?.cancelEnterpriseReasoning?.();
    }
    this.cancelActiveStream();
  }

  async isAvailable(): Promise<boolean> {
    try {
      const settings = getSettings();
      // Mirrors processText's precedence: managed access outranks every manual route.
      if (
        getManagedScopeResolution("dictationCleanup", settings.enterpriseSetupMode).kind ===
        "managed"
      ) {
        logger.logReasoning("API_KEY_CHECK", { managedEnterprise: true });
        return true;
      }

      if (isCloudCleanupMode()) {
        logger.logReasoning("API_KEY_CHECK", { cloudCleanupMode: true });
        return true;
      }

      if (this.hasLanCleanupConfiguration()) {
        logger.logReasoning("API_KEY_CHECK", { lanCleanup: true });
        return true;
      }

      if (settings.cleanupProvider === "custom" && settings.cleanupCloudBaseUrl?.trim()) {
        logger.logReasoning("API_KEY_CHECK", {
          customProvider: true,
          hasCustomEndpoint: true,
        });
        return true;
      }

      // Enterprise providers: detect credentials by provider, short-circuit.
      // Runtime auth errors (expired SSO, missing ADC) surface via
      // mapEnterpriseError with actionable remediation copy.
      if (settings.cleanupProvider === "bedrock") {
        const hasBedrockCreds =
          !!settings.bedrockProfile?.trim() ||
          (!!settings.bedrockAccessKeyId?.trim() && !!settings.bedrockSecretAccessKey?.trim());
        logger.logReasoning("API_KEY_CHECK", { bedrock: true, hasBedrockCreds });
        if (hasBedrockCreds) return true;
      }
      if (settings.cleanupProvider === "azure") {
        const hasAzureCreds = !!settings.azureApiKey?.trim() && !!settings.azureEndpoint?.trim();
        logger.logReasoning("API_KEY_CHECK", { azure: true, hasAzureCreds });
        if (hasAzureCreds) return true;
      }
      if (settings.cleanupProvider === "vertex") {
        const hasVertexCreds = !!settings.vertexApiKey?.trim() || !!settings.vertexProject?.trim();
        logger.logReasoning("API_KEY_CHECK", { vertex: true, hasVertexCreds });
        if (hasVertexCreds) return true;
      }

      const openaiKey = await window.electronAPI?.getOpenAIKey?.();
      const anthropicKey = await window.electronAPI?.getAnthropicKey?.();
      const geminiKey = await window.electronAPI?.getGeminiKey?.();
      const groqKey = await window.electronAPI?.getGroqKey?.();
      const openrouterKey = await window.electronAPI?.getOpenrouterKey?.();
      const tinfoilKey = await window.electronAPI?.getTinfoilKey?.();
      const cortiKey = await window.electronAPI?.getCortiKey?.();
      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable?.();

      logger.logReasoning("API_KEY_CHECK", {
        hasOpenAI: !!openaiKey,
        hasAnthropic: !!anthropicKey,
        hasGemini: !!geminiKey,
        hasGroq: !!groqKey,
        hasOpenrouter: !!openrouterKey,
        hasTinfoil: !!tinfoilKey,
        hasCorti: !!cortiKey,
        hasLocal: !!localAvailable,
      });

      return !!(
        openaiKey ||
        anthropicKey ||
        geminiKey ||
        groqKey ||
        openrouterKey ||
        tinfoilKey ||
        cortiKey ||
        localAvailable
      );
    } catch (error) {
      logger.logReasoning("API_KEY_CHECK_ERROR", {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
      });
      return false;
    }
  }

  clearApiKeyCache(
    provider?:
      | "openai"
      | "anthropic"
      | "gemini"
      | "groq"
      | "mistral"
      | "tinfoil"
      | "custom"
      | "openrouter"
      | "corti"
  ): void {
    if (provider) {
      if (provider !== "custom") {
        this.apiKeyCache.delete(provider);
      }
      if (provider === "tinfoil") {
        clearTinfoilClientCache();
      }
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider });
    } else {
      this.apiKeyCache.clear();
      clearTinfoilClientCache();
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider: "all" });
    }
  }

  destroy(): void {
    this.cancelAllRequests();
    if (this.cacheCleanupStop) {
      this.cacheCleanupStop();
    }
  }
}

export default new ReasoningService();
