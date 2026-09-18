import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createProvider } from "@earendil-works/pi-ai"
import {
  createAuthenticatedJevService,
  publishJevService,
  registerJevService,
} from "../shared/jev/service.ts"
import { JEV_PROVIDER_ID } from "../shared/jev/types.ts"

export * from "../shared/jev/client.ts"
export * from "../shared/jev/service.ts"
export * from "../shared/jev/types.ts"

const unsupportedGenerativeApi = {
  stream(): never {
    throw new Error("TypeSafe Jev is a typed evaluation service, not a generative Pi model")
  },
  streamSimple(): never {
    throw new Error("TypeSafe Jev is a typed evaluation service, not a generative Pi model")
  },
}

export default function typesafeJevExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createProvider({
    id: JEV_PROVIDER_ID,
    name: "TypeSafe Jev",
    baseUrl: "https://api.typesafe.ai/v1",
    auth: {
      apiKey: {
        name: "TypeSafe API key",
        async login(interaction) {
          const key = await interaction.prompt({
            type: "secret",
            message: "TypeSafe API key:",
            placeholder: "apikey_…",
          })
          if (!key.trim()) throw new Error("TypeSafe API key cannot be empty")
          return { type: "api_key" as const, key: key.trim() }
        },
        async resolve({ credential }) {
          return credential?.type === "api_key" && credential.key
            ? { auth: { apiKey: credential.key }, source: "stored TypeSafe API key" }
            : undefined
        },
      },
    },
    models: [],
    api: unsupportedGenerativeApi,
  }))

  let currentContext: ExtensionContext | undefined
  const service = createAuthenticatedJevService(() => currentContext?.modelRegistry)
  const unregisterGlobal = registerJevService(service)
  const unsubscribeEvent = publishJevService(pi.events, service)

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx
  })

  pi.on("session_shutdown", () => {
    currentContext = undefined
    unsubscribeEvent()
    unregisterGlobal()
  })
}
