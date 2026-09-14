import type { CommandCodeAccountManager } from "./account-manager.ts"
import { redactCommandCodeErrorText } from "./overflow.ts"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  AssistantMessageLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./types.ts"

/** Deliberately excludes generic "limit" (e.g. context/token limits). */
export function isPotentialQuotaError(message: string, status?: number): boolean {
  return (
    status === 429 ||
    [
      /\b(?:http|status(?:[_\s-]*code)?|api\s+error)\s*[:(]?\s*429\b/i,
      /\brate[_\s-]+limit(?:[_\s-]+(?:error|exceeded|reached))?\b/i,
      /(?:insufficient[_\s-]+(?:credits?|quota)|(?:credits?|quota)[_\s-]+(?:limit[_\s-]+)?(?:exhausted|depleted|exceeded)|(?:monthly|weekly|five[_\s-]?hour|5[_\s-]?hour)[_\s-]+(?:usage[_\s-]+)?limit|usage[_\s-]+limit[_\s-]+(?:exceeded|reached)|(?:out of|not enough)[_\s-]+credits?)/i,
      /\bcredit\s+balance\s+(?:is\s+)?(?:too\s+low|insufficient)\b/i,
    ].some((pattern) => pattern.test(message))
  )
}

interface RotationDependencies {
  createStream: () => AssistantMessageEventStreamLike
  stream: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
  manager: Pick<CommandCodeAccountManager, "accounts" | "getActiveAccount" | "refresh">
  /** Whole logical request, including all attempts and verification. Default ten minutes. */
  totalTimeoutMs?: number
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}

function aborted(): DOMException {
  return new DOMException("Request aborted", "AbortError")
}
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(aborted())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(aborted())
    const onAbort = () => {
      clearTimeout(timer)
      reject(aborted())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
function errorMessage(
  model: ModelLike,
  text: string,
  reason: "error" | "aborted" = "error",
): AssistantMessageLike {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reason,
    errorMessage: text,
    timestamp: Date.now(),
  }
}

/**
 * The inner adapters signal failure through events, not rejected promises.
 * Hold their terminal event until verification; never forward an attempt's error
 * and then try to reuse the ended stream. Both native and generate use this path.
 */
export function createRotatingCommandCodeStream(deps: RotationDependencies) {
  const totalTimeoutMs = deps.totalTimeoutMs ?? 600_000
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0 || totalTimeoutMs > 2_147_483_647)
    throw new Error("Invalid Command Code total request timeout")
  return (
    model: ModelLike,
    context: ContextLike,
    options: StreamOptions = {},
  ): AssistantMessageEventStreamLike => {
    const output = deps.createStream()
    const controller = new AbortController()
    let timedOut = false
    let started = false
    let visible = false
    let lastPartial: AssistantMessageLike | undefined
    let originalFailure: Extract<AssistantMessageEvent, { type: "error" }> | undefined
    const safe = (text: string) => {
      for (const account of deps.manager.accounts)
        text = text.split(account.apiKey).join("[redacted]")
      return redactCommandCodeErrorText(text)
    }
    const onAbort = () => controller.abort()
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, totalTimeoutMs)
    const signal = controller.signal
    const checkAbort = () => {
      if (signal.aborted) throw aborted()
    }
    const sanitizeFailure = (event: Extract<AssistantMessageEvent, { type: "error" }>) => ({
      ...event,
      error: {
        ...event.error,
        errorMessage: safe(event.error.errorMessage ?? "Command Code request failed"),
      },
    })
    const run = async () => {
      const modelHeaders = (model as ModelLike & { headers?: Record<string, string | null> })
        .headers
      if (
        [options.headers, modelHeaders].some(
          (h) =>
            h &&
            Object.keys(h).some((k) =>
              ["authorization", "x-api-key", "api-key"].includes(k.toLowerCase()),
            ),
        )
      ) {
        throw new Error(
          "Custom Authorization/x-api-key headers are not supported with a Command Code account pool; use single-account mode",
        )
      }
      const maxRetries = options.maxRetries ?? 0
      if (!Number.isInteger(maxRetries) || maxRetries < 0)
        throw new Error("Invalid Command Code maxRetries")
      if (
        options.maxRetryDelayMs !== undefined &&
        (!Number.isFinite(options.maxRetryDelayMs) || options.maxRetryDelayMs < 0)
      ) {
        throw new Error("Invalid Command Code maxRetryDelayMs")
      }
      let retries = 0
      const attempted = new Set<string>()
      checkAbort()
      let account = await deps.manager.getActiveAccount(attempted, signal)
      for (;;) {
        checkAbort()
        originalFailure = undefined
        attempted.add(account.id)
        const responseMeta: { status?: number; retryAfter: string | null } = { retryAfter: null }
        let failure: Extract<AssistantMessageEvent, { type: "error" }> | undefined
        let completed = false
        // Prevent any inner SDK retry from hiding a quota error before verification.
        const innerOptions: StreamOptions = {
          ...options,
          apiKey: account.apiKey,
          signal,
          maxRetries: 0,
          fetch: async (input, init) => {
            checkAbort()
            const response = await (options.fetch ?? fetch)(input, init)
            responseMeta.status = response.status
            responseMeta.retryAfter = response.headers.get("retry-after")
            return response
          },
        }
        const source = deps.stream(model, context, innerOptions)
        const iterator = source[Symbol.asyncIterator]()
        try {
          for (;;) {
            const next = await raceSignal(iterator.next(), signal)
            if (next.done) break
            const event = next.value
            if (event.type === "error") {
              failure = sanitizeFailure(event)
              continue
            }
            if (failure)
              throw new Error("Command Code adapter emitted content after its terminal error")
            if (event.type === "done") {
              completed = true
              checkAbort()
              output.push(event)
              return
            }
            if (event.type === "start") {
              if (!started) {
                output.push(event)
                started = true
              }
            } else {
              visible = true
              lastPartial = event.partial
              output.push(event)
            }
          }
        } finally {
          // Don't await a broken adapter's iterator cleanup past the overall deadline.
          const cleanup = iterator.return?.()
          if (cleanup) void Promise.resolve(cleanup).catch(() => undefined)
        }
        checkAbort()
        if (!failure && !completed)
          throw new Error("Command Code stream ended without a terminal event")
        if (!failure) return
        originalFailure = failure
        if (failure.reason === "aborted") {
          output.push(failure)
          return
        }
        const text = failure.error.errorMessage ?? ""
        const { status, retryAfter } = responseMeta
        if (isPotentialQuotaError(text, status)) {
          const verification = await raceSignal(deps.manager.refresh(account, signal), signal)
          checkAbort()
          if (verification.status !== "exhausted" || visible) {
            output.push(failure)
            return
          }
          // refresh commits the actual failed account, never a concurrently changed active id.
          account = await deps.manager.getActiveAccount(attempted, signal)
          continue
        }
        // Shared ordinary retry budget, never reset on account changes. Network errors
        // remain non-retryable; retry server errors, timeouts and legacy stream errors.
        const transient =
          (status !== undefined && status >= 500 && status < 600) ||
          /timed?\s*out|timeout/i.test(text) ||
          status === 200
        if (!visible && transient && retries < maxRetries) {
          const cap = options.maxRetryDelayMs === 0 ? Infinity : (options.maxRetryDelayMs ?? 60_000)
          const seconds =
            retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
              ? Number(retryAfter)
              : NaN
          const requested =
            retryAfter === null
              ? NaN
              : Number.isFinite(seconds)
                ? seconds * 1000
                : Date.parse(retryAfter) - Date.now()
          if (Number.isFinite(requested) && requested > cap) {
            output.push(failure)
            return
          }
          const ms = Number.isFinite(requested)
            ? Math.max(0, requested)
            : Math.min(500 * 2 ** retries, cap)
          retries++
          await (deps.delay ?? wait)(ms, signal)
          continue
        }
        output.push(failure)
        return
      }
    }
    void run()
      .catch((error) => {
        const reason = options.signal?.aborted ? "aborted" : "error"
        const text =
          reason === "aborted"
            ? "Request aborted"
            : timedOut
              ? `Command Code total request timed out after ${totalTimeoutMs}ms`
              : safe(error instanceof Error ? error.message : String(error))
        // Preserve partial output on cancellation and diagnostics if account selection fails.
        const base = lastPartial ?? originalFailure?.error ?? errorMessage(model, text, reason)
        const message =
          originalFailure && reason !== "aborted" && !timedOut
            ? `${originalFailure.error.errorMessage}\n${text}`
            : text
        output.push({
          type: "error",
          reason,
          error: { ...base, stopReason: reason, errorMessage: message },
        })
      })
      .finally(() => {
        controller.abort()
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        output.end()
      })
    return output
  }
}
