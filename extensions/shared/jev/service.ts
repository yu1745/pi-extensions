import type { EventBus } from "@earendil-works/pi-coding-agent"
import { createJevClient } from "./client.ts"
import {
  JEV_PROVIDER_ID,
  JEV_SERVICE_REQUEST_EVENT,
  JEV_SERVICE_VERSION,
  type JevEvaluateOptions,
  type JevEvaluateRequest,
  type JevEvaluateResponse,
  type JevServiceRequest,
  type JevServiceV1,
} from "./types.ts"

const GLOBAL_KEY = "__yu1745PiJevServiceV1"

interface JevServiceSlot {
  service: JevServiceV1 | undefined
}

export interface JevAuthRegistry {
  getProviderAuth(provider: string): Promise<{ auth?: { apiKey?: string } } | undefined>
}

function slot(): JevServiceSlot {
  const root = globalThis as Record<string, unknown>
  return (root[GLOBAL_KEY] as JevServiceSlot | undefined) ??
    (root[GLOBAL_KEY] = { service: undefined } satisfies JevServiceSlot)
}

export function registerJevService(service: JevServiceV1): () => void {
  const shared = slot()
  shared.service = service
  return () => {
    if (shared.service === service) shared.service = undefined
  }
}

export function resolveJevService(): JevServiceV1 | undefined {
  return slot().service
}

export function discoverJevService(events: EventBus): JevServiceV1 | undefined {
  let service: JevServiceV1 | undefined
  events.emit(JEV_SERVICE_REQUEST_EVENT, {
    accept(candidate: JevServiceV1) {
      if (!service && candidate?.version === JEV_SERVICE_VERSION) service = candidate
    },
  } satisfies JevServiceRequest)
  return service
}

export function publishJevService(events: EventBus, service: JevServiceV1): () => void {
  return events.on(JEV_SERVICE_REQUEST_EVENT, (data) => {
    const request = data as Partial<JevServiceRequest> | undefined
    if (typeof request?.accept === "function") request.accept(service)
  })
}

export function createAuthenticatedJevService(getRegistry: () => JevAuthRegistry | undefined): JevServiceV1 {
  return {
    version: JEV_SERVICE_VERSION,
    async evaluate(request: JevEvaluateRequest, options?: JevEvaluateOptions): Promise<JevEvaluateResponse> {
      const registry = getRegistry()
      if (!registry) throw new Error("Jev service is not attached to an active Pi session")
      const envKey = process.env.TYPESAFE_API_KEY?.trim()
      const auth = envKey ? undefined : await registry.getProviderAuth(JEV_PROVIDER_ID)
      const apiKey = envKey || auth?.auth?.apiKey?.trim()
      if (!apiKey) {
        throw new Error(`TypeSafe API key is not configured. Run /login ${JEV_PROVIDER_ID}.`)
      }
      return createJevClient({ apiKey }).evaluate(request, options)
    },
  }
}
