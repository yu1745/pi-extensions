/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai"
import * as piAiCompat from "@earendil-works/pi-ai/compat"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { registerCommandCodeAccountManager } from "./src/active-account.ts"
import { loadAccountPool, CommandCodeAccountManager } from "./src/account-manager.ts"
import { verifyAccountExhaustion } from "./src/exhaustion.ts"
import { createRotatingCommandCodeStream } from "./src/rotation.ts"
import { pickCommandCodeApiKey, withResolvedCommandCodeApiKey } from "./src/converters.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCost } from "./src/cost.ts"
import {
  apiForModelId,
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { registerCommandCodeQuota } from "./src/quota-command.ts"
import { openCommandCodeAccounts } from "./src/account-ui.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import { createCommandCodeTransportRouter } from "./src/transport.ts"
import type {
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./src/types.ts"

// Keep the core host-independent. Runtime objects retain the complete Pi model
// and event-stream API; only these adapter boundaries bridge the reduced test types.
type LocalStream = (
  model: ModelLike,
  context: ContextLike,
  options?: StreamOptions,
) => AssistantMessageEventStreamLike
const createStream = () =>
  createAssistantMessageEventStream() as unknown as AssistantMessageEventStreamLike
const nativeStream = streamNativeProvider as unknown as LocalStream

function providerModelCost(id: string) {
  const cost = MODEL_COSTS[id] ?? ZERO_MODEL_COST
  return { ...cost, tiers: cost.tiers ? [...cost.tiers] : undefined }
}


const COMMAND_CODE_API = "commandcode-custom"
const COMPAT_SOURCE_ID = "pi-commandcode-provider"

type CompatStreamFunction = (
  model: Parameters<typeof streamNativeProvider>[0],
  context: Parameters<typeof streamNativeProvider>[1],
  options?: Parameters<typeof streamNativeProvider>[2],
) => AssistantMessageEventStream

/**
 * pi's compat entrypoint exposes `registerApiProvider`; Oh My Pi maps
 * `@earendil-works/pi-ai/compat` onto its own pi-ai, which lacks that export
 * and registers custom APIs itself inside `registerProvider`. Resolve the
 * function at runtime so the extension loads on both hosts.
 */
function compatApiProviderRegistrar(): ((...args: unknown[]) => unknown) | undefined {
  const register = (piAiCompat as { registerApiProvider?: unknown }).registerApiProvider
  return typeof register === "function" ? (register as (...args: unknown[]) => unknown) : undefined
}

function registerCompatApiProvider(stream: CompatStreamFunction): void {
  compatApiProviderRegistrar()?.(
    { api: COMMAND_CODE_API, stream, streamSimple: stream },
    COMPAT_SOURCE_ID,
  )
}

/**
 * The `apiKey` handed to `registerProvider` means different things per host.
 *
 * pi parses `$COMMAND_CODE_API_KEY` as an env template: unresolved means
 * "not configured", so `/login` credentials and `--api-key` take over, and
 * the entry keeps the API-key auth method registered next to OAuth. Without
 * it pi composes an OAuth-only provider and drops stored `api_key`
 * credentials and `--api-key`.
 *
 * Oh My Pi has no template notion: an unresolved value stays a literal config
 * override that shadows its `/login` credential store and is sent verbatim as
 * `Authorization: Bearer $COMMAND_CODE_API_KEY`. There, omit `apiKey` unless
 * a real key is configured; OMP then reads env keys and stored credentials
 * itself.
 *
 * Hosts are told apart by the same `registerApiProvider` probe used for the
 * compat registry: pi exports it, OMP does not.
 */
function providerApiKey(): string | undefined {
  const configured = pickCommandCodeApiKey(getConfiguredApiKey(), undefined)
  if (configured) return configured
  return compatApiProviderRegistrar() ? "$COMMAND_CODE_API_KEY" : undefined
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: LocalStream,
  poolKey?: string,
): ProviderConfig {
  const headers = commandCodeHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: poolKey ?? providerApiKey(),
    api: COMMAND_CODE_API,
    streamSimple: streamCommandCode as unknown as ProviderConfig["streamSimple"],
    headers,
    oauth: {
      name: "Command Code",
      login: async (callbacks) => ({ ...(await login(callbacks)) }),
      refreshToken: async (credentials) => ({ ...(await refreshToken(credentials)) }),
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api: COMMAND_CODE_API,
      baseUrl: baseUrlForModel(apiBase, model.api),
      reasoning: model.reasoning,
      ...(thinkingMetadataForModel(model.id) ?? {}),
      input: [...inputModalitiesForModel(model.id)],
      cost: providerModelCost(model.id),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers,
      compat:
        model.api === "openai-completions"
          ? {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: MODEL_EFFORTS[model.id] !== undefined,
              maxTokensField: "max_tokens",
            }
          : {
              supportsEagerToolInputStreaming: false,
              supportsLongCacheRetention: false,
              supportsCacheControlOnTools: false,
              supportsToolReferences: false,
              ...(model.reasoning ? { forceAdaptiveThinking: true } : {}),
            },
    })),
  }
}

function legacyApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

export default async function (pi: ExtensionAPI) {
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const pool = loadAccountPool({ agentDir: getAgentDir() })
  const accountManager = pool
    ? new CommandCodeAccountManager(pool, {
        statePath: join(getAgentDir(), "commandcode-account-state.json"),
        verify: (account, signal) =>
          verifyAccountExhaustion({
            apiKey: account.apiKey,
            baseUrl: legacyApiBase(apiBase),
            remainingCreditsThreshold: pool.remainingCreditsThreshold,
            extraHeaders: commandCodeHeaders(),
            includeExpiresAt: true,
            signal,
          }),
      })
    : undefined
  const streamGenerate = createStreamCommandCode({
    createStream,
    calculateCost: calculateCommandCodeCost,
    apiBase: legacyApiBase(apiBase),
  })
  const resolveStreamOptions = (options?: StreamOptions): StreamOptions => {
    const resolved: StreamOptions = withResolvedCommandCodeApiKey(options, getConfiguredApiKey())
    // Pi's native SimpleStreamOptions expresses disabled thinking as undefined;
    // forwarding the literal "off" produces an undefined thinking budget / NaN cap.
    return resolved.reasoning === "off" ? { ...resolved, reasoning: undefined } : resolved
  }
  const transport = createCommandCodeTransportRouter({
    createStream,
    streamProvider: (model, context, options) =>
      nativeStream(
        {
          ...model,
          api: apiForModelId(model.id),
          compat:
            (model as ModelLike & { compatConfig?: unknown; compat?: unknown }).compatConfig ??
            (model as ModelLike & { compat?: unknown }).compat,
        } as ModelLike,
        context,
        resolveStreamOptions(options),
      ),
    streamGenerate: (model, context, options) =>
      streamGenerate(model, context, resolveStreamOptions(options)),
  })

  const stream = accountManager
    ? createRotatingCommandCodeStream({
        createStream,
        stream: transport.stream,
        manager: accountManager,
        totalTimeoutMs:
          process.env.COMMANDCODE_TOTAL_TIMEOUT_MS === undefined
            ? undefined
            : Number(process.env.COMMANDCODE_TOTAL_TIMEOUT_MS),
      })
    : transport.stream

  // pi dispatches the main chat through the registered provider, but sibling
  // extensions that call `streamSimple` from `@earendil-works/pi-ai/compat`
  // with a Command Code model resolve `model.api` through the compat
  // api-registry, which knows nothing about extension providers. Register the
  // custom api there so those calls reach the same transport. The registry
  // resolves no credentials for extension providers, so fall back to the
  // configured key when the caller passes none or a placeholder.
  const compatStream: CompatStreamFunction = (model, context, options) =>
    stream(
      model,
      context,
      resolveStreamOptions(options as unknown as StreamOptions),
    ) as unknown as AssistantMessageEventStream
  registerCompatApiProvider(compatStream)

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  const openAccounts = (ctx: ExtensionCommandContext) =>
    openCommandCodeAccounts(ctx, {
      agentDir: getAgentDir(),
      manager: accountManager,
      apiBase: legacyApiBase(apiBase),
      headers: commandCodeHeaders(),
    })
  pi.registerCommand("commandcode-accounts", {
    description: "交互管理 Command Code 多账号：添加、批量导入、替换、删除 Key",
    handler: async (_args, ctx) => {
      await openAccounts(ctx)
    },
  })
  registerCommandCodeQuota(pi, {
    apiBase: legacyApiBase(apiBase),
    headers: commandCodeHeaders(),
    accountManager,
    openAccounts: (ctx) => openAccounts(ctx as ExtensionCommandContext),
  })

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: async (signal) => {
      const loaded = await loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
        signal,
      })
      return loaded
    },
    loadCachedModels: async () =>
      await loadCachedCommandCodeModels(modelsCachePath),
    createProviderConfig: (models) =>
      createProviderConfig(models, apiBase, stream, pool?.accounts[0]?.apiKey),
    getTransport: transport.getTransport,
    // Background discovery must not write over the TUI's input line.
    // Diagnostics remain in /commandcode-status; manual refresh notifies via UI.
    logWarning: () => {},
  })

  const unregisterAccountManager = registerCommandCodeAccountManager(accountManager)
  pi.on("session_shutdown", () => {
    unregisterAccountManager()
    accountManager?.dispose()
    runtime.dispose()
  })

  await runtime.initialize()
}
