import type {
  JevAnswer,
  JevChoiceAnswer,
  JevEvaluateOptions,
  JevEvaluateRequest,
  JevEvaluateResponse,
  JevNoulAnswer,
  JevQuestion,
  JevScoreAnswer,
} from "./types.ts"

export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone"
export const JEV_DEFAULT_MODEL = "jev-latest"
export const JEV_DEFAULT_TIMEOUT_MS = 20_000
export const JEV_MAX_REQUEST_BYTES = 200_000
export const JEV_MAX_ATTEMPTS = 3

export class JevError extends Error {
  readonly code: "auth" | "http" | "invalid_request" | "invalid_response" | "aborted" | "network"
  readonly status: number | undefined

  constructor(
    message: string,
    code: "auth" | "http" | "invalid_request" | "invalid_response" | "aborted" | "network",
    status?: number,
  ) {
    super(message)
    this.name = "JevError"
    this.code = code
    this.status = status
  }
}

export interface JevClientOptions {
  apiKey: string
  endpoint?: string
  fetch?: typeof fetch
  defaultTimeoutMs?: number
  maxAttempts?: number
}

function finiteProbability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevError(`Invalid probability in Jev response: ${label}`, "invalid_response")
  }
  return value
}

function probabilityMap(value: unknown, label: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JevError(`Invalid probability map in Jev response: ${label}`, "invalid_response")
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, probability]) => [key, finiteProbability(probability, `${label}.${key}`)]),
  )
}

function validateAnswer(value: unknown, id: string, question: JevQuestion): JevAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JevError(`Missing Jev answer: ${id}`, "invalid_response")
  }
  const answer = value as Record<string, unknown>
  if (answer.type !== question.type) {
    throw new JevError(`Jev answer type does not match question: ${id}`, "invalid_response")
  }
  if (answer.type === "noul") {
    return { type: "noul", noul: finiteProbability(answer.noul, `${id}.noul`) } satisfies JevNoulAnswer
  }
  if (answer.type === "choice") {
    const criteria = question.type === "choice" ? question.criteria : {}
    if (typeof answer.choice !== "string" || !(answer.choice in criteria)) {
      throw new JevError(`Invalid Jev choice answer: ${id}`, "invalid_response")
    }
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: probabilityMap(answer.probabilities, `${id}.probabilities`),
      confidence: finiteProbability(answer.confidence, `${id}.confidence`),
    } satisfies JevChoiceAnswer
  }
  if (answer.type === "score") {
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
      throw new JevError(`Invalid Jev score answer: ${id}`, "invalid_response")
    }
    if (!answer.legend || typeof answer.legend !== "object" || Array.isArray(answer.legend)) {
      throw new JevError(`Invalid Jev score legend: ${id}`, "invalid_response")
    }
    const legend = Object.fromEntries(
      Object.entries(answer.legend).map(([key, text]) => {
        if (typeof text !== "string") throw new JevError(`Invalid Jev legend entry: ${id}.${key}`, "invalid_response")
        return [key, text]
      }),
    )
    return {
      type: "score",
      score: answer.score,
      legend,
      probabilities: probabilityMap(answer.probabilities, `${id}.probabilities`),
      confidence: finiteProbability(answer.confidence, `${id}.confidence`),
    } satisfies JevScoreAnswer
  }
  throw new JevError(`Unknown Jev answer type: ${id}`, "invalid_response")
}

function validateResponse(value: unknown, request: JevEvaluateRequest): JevEvaluateResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JevError("Jev returned a non-object response", "invalid_response")
  }
  const body = value as Record<string, unknown>
  if (typeof body.model !== "string" || !body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) {
    throw new JevError("Jev response is missing model or answers", "invalid_response")
  }
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [
      id,
      validateAnswer((body.answers as Record<string, unknown>)[id], id, question),
    ]),
  )
  const usage = body.usage as Record<string, unknown> | undefined
  const inputTokens = usage?.input_tokens
  const outputTokens = usage?.output_tokens
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) {
    throw new JevError("Jev response has invalid usage", "invalid_response")
  }
  return {
    model: body.model,
    answers,
    usage: { input_tokens: inputTokens as number, output_tokens: outputTokens as number },
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000)
  }
  return Math.min(8_000, 500 * 2 ** attempt)
}

export function createJevClient(options: JevClientOptions) {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new JevError("TypeSafe API key is empty", "auth")
  const fetchImpl = options.fetch ?? fetch
  const endpoint = options.endpoint ?? JEV_API_URL
  const maxAttempts = Math.max(1, options.maxAttempts ?? JEV_MAX_ATTEMPTS)
  const defaultTimeoutMs = options.defaultTimeoutMs ?? JEV_DEFAULT_TIMEOUT_MS

  return {
    async evaluate(request: JevEvaluateRequest, evaluateOptions: JevEvaluateOptions = {}): Promise<JevEvaluateResponse> {
      if (!request.questions || Object.keys(request.questions).length === 0) {
        throw new JevError("At least one Jev question is required", "invalid_request")
      }
      const body = JSON.stringify({ ...request, model: request.model ?? JEV_DEFAULT_MODEL })
      if (Buffer.byteLength(body, "utf8") > JEV_MAX_REQUEST_BYTES) {
        throw new JevError(`Jev request exceeds ${JEV_MAX_REQUEST_BYTES} bytes`, "invalid_request")
      }

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const timeout = AbortSignal.timeout(evaluateOptions.timeoutMs ?? defaultTimeoutMs)
        const signal = evaluateOptions.signal ? AbortSignal.any([evaluateOptions.signal, timeout]) : timeout
        let response: Response
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body,
            signal,
          })
        } catch (error) {
          if (evaluateOptions.signal?.aborted || timeout.aborted) {
            throw new JevError("Jev request aborted or timed out", "aborted")
          }
          if (attempt + 1 < maxAttempts) {
            await abortableDelay(500 * 2 ** attempt, evaluateOptions.signal)
            continue
          }
          throw new JevError(`Jev network error: ${error instanceof Error ? error.message : String(error)}`, "network")
        }

        if (response.ok) {
          let parsed: unknown
          try {
            parsed = await response.json()
          } catch {
            throw new JevError("Jev returned invalid JSON", "invalid_response", response.status)
          }
          return validateResponse(parsed, request)
        }

        const text = (await response.text()).slice(0, 500)
        if ((response.status === 429 || response.status === 529) && attempt + 1 < maxAttempts) {
          await abortableDelay(retryDelay(response, attempt), evaluateOptions.signal)
          continue
        }
        throw new JevError(
          `Jev HTTP ${response.status}${text ? `: ${text}` : ""}`,
          response.status === 401 ? "auth" : "http",
          response.status,
        )
      }
      throw new JevError("Jev request exhausted retries", "network")
    },
  }
}
