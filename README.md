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
| `zread_*` | `extensions/zread-mcp/` | ZRead remote MCP (public GitHub exploration) as native pi tools |
| `quota` | `extensions/quota-footer.ts` | Unified usage monitor in the footer: DeepSeek balance, GLM / MiniMax / Codex quota (one widget, switch-dispatched) |
| `smart-compact-force` | `extensions/smart-compact-force/` | Auto-patches pi-smart-compact to allow `allowUnverifiedApply` (force past the verification gate) + `/smart-compact-force` command |
| `openai-codex-fast` | `extensions/openai-codex-fast.ts` | `/fast` toggles `service_tier=priority` on Codex requests |
| `tokenspeed` | `extensions/tokenspeed.ts` | Model output speed (tokens/sec) status line |
| `working-bell` | `extensions/working-bell.ts` | Working bell + title status |
| `inject-resume` | `extensions/inject-resume.ts` | Inject-resume-on-exit (pi side, Linux/bash) |
| `cny-footer` | `extensions/cny-footer.ts` | Footer with session cost in RMB |
| `clear-new-alias` | `extensions/clear-new-alias.ts` | Clears the new-version alias notice |

> **15 extensions, one package.** Previously separate repos (`pi-web-reader-spa`, `pi-bash-live`) are merged here — uninstall the standalone packages before installing this one to avoid duplicate tool registration.>
> The `subagent` extension was **removed** in favor of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (install with `pi install npm:@tintinweb/pi-subagents`).

## API keys

No keys are hardcoded. Z.AI-backed tools (`web-search`, `zai-vision`, `zread-mcp`) resolve the key in this order:

1. env var (`Z_AI_MCP_API_KEY`, `Z_AI_VISION_API_KEY`, `ZREAD_MCP_URL` …)
2. pi's configured auth for the `zai-coding-cn` provider (via `modelRegistry.getProviderAuth` — independent of the session's current provider)
3. error with a hint to run `/login zai-coding-cn`

Provider quota monitor (`quota-footer`) reads keys at runtime from `modelRegistry.getApiKeyForProvider(...)`, never from source. The old `/ds-balance`, `/glm-quota`, `/minimax-quota`, `/openai-codex-quota` commands still work as aliases of `/quota`.

## smart-compact-force

[pi-smart-compact](https://github.com/alpertarhan/pi-smart-compact) is fail-closed by design: its post-synthesis / post-state verification gates throw and block apply whenever the summary cannot be verified losslessly (e.g. `[missing-file, missing-error]` gaps on very long conversations), and no built-in config can skip that.

This extension applies a minimal 6-replacement patch to the installed `pi-smart-compact/dist/index.js` (canonical table in `extensions/smart-compact-force/patches.ts`) on every pi start, adding one opt-in switch:

- `settings.json`: `"smartCompact": { "allowUnverifiedApply": true }`
- or env: `SMART_COMPACT_FORCE_APPLY=1`

When enabled and verification still fails after all repair attempts (deterministic repair → LLM patch → deterministic quality floor), the run proceeds instead of failing: the best summary is kept, provenance is marked `forced`, a warning is shown, and the normal `requireApproval` screen still gates the actual apply. The yield check (target / ≥10% saving) is untouched and still fail-closed.

```sh
/smart-compact-force          # status: is the patch active?
/smart-compact-force apply    # re-apply after an extension update
/smart-compact-force revert   # restore fail-closed behavior
node scripts/smart-compact-force-patch.ts   # same, from the CLI
```

If `apply` reports an anchor mismatch, pi-smart-compact was updated and the table in `patches.ts` needs to be refreshed.

## Development

```sh
npm install          # types + typebox for local typecheck
npx tsc --noEmit ... # typecheck an extension
```

Load a single extension without installing the package:

```sh
pi -e git:github.com/yu1745/pi-extensions
```
