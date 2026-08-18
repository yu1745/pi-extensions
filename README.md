# pi-extensions

Monorepo of [pi](https://github.com/earendil-works/pi) extensions, all installed from one git package:

```sh
pi install git:github.com/yu1745/pi-extensions
```

## Extensions

| Extension | Path | What it does |
|---|---|---|
| `bash-live` | `extensions/bash-live.ts` | Long-running commands with real-time streaming output |
| `web_reader_spa` | `extensions/web-reader-spa/` | SPA-aware, anti-WAF web reader (Playwright + stealth + ARIA extraction) |
| `web_search` / `web_reader` | `extensions/web-search/` | Z.AI Web Search Prime + Web Reader via MCP (Streamable HTTP) |
| ZAI Vision tools (8) | `extensions/zai-vision/` | UI→code / OCR / error diagnosis / diagram / data-viz / diff-check / image / video analysis via GLM-4.6V |

| `quota` | `extensions/quota-footer.ts` | Unified usage monitor in the footer: DeepSeek balance, GLM / MiniMax / Codex quota (one widget, switch-dispatched) |
| `openai-codex-fast` | `extensions/openai-codex-fast.ts` | `/fast` toggles `service_tier=priority` on Codex requests |
| `tokenspeed` | `extensions/tokenspeed.ts` | Model output speed (tokens/sec) status line |
| `working-bell` | `extensions/working-bell.ts` | Working bell + title status |
| `inject-resume` | `extensions/inject-resume.ts` | Inject-resume-on-exit (pi side, Linux/bash) |
| `cny-footer` | `extensions/cny-footer.ts` | Footer with session cost in RMB |
| `clear-new-alias` | `extensions/clear-new-alias.ts` | Clears the new-version alias notice |

> **14 extensions, one package.** Previously separate repos (`pi-web-reader-spa`, `pi-bash-live`) are merged here — uninstall the standalone packages before installing this one to avoid duplicate tool registration.
>
> pi-smart-compact is provided separately by the fork `git:github.com/yu1745/pi-smart-compact` (upstream + `allowUnverifiedApply`).>
> The `subagent` extension was **removed** in favor of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (install with `pi install npm:@tintinweb/pi-subagents`).

## API keys

No keys are hardcoded. Z.AI-backed tools (`web-search`, `zai-vision`) resolve the key in this order:

1. env var (`Z_AI_MCP_API_KEY`, `Z_AI_VISION_API_KEY` …)
2. pi's configured auth for the `zai-coding-cn` provider (via `modelRegistry.getProviderAuth` — independent of the session's current provider)
3. error with a hint to run `/login zai-coding-cn`

Provider quota monitor (`quota-footer`) reads keys at runtime from `modelRegistry.getApiKeyForProvider(...)`, never from source. The old `/ds-balance`, `/glm-quota`, `/minimax-quota`, `/openai-codex-quota` commands still work as aliases of `/quota`.

## Development

```sh
npm install          # types + typebox for local typecheck
npx tsc --noEmit ... # typecheck an extension
```

Load a single extension without installing the package:

```sh
pi -e git:github.com/yu1745/pi-extensions
```
