# pi-extensions

Monorepo of [pi](https://github.com/earendil-works/pi) extensions, all installed from one git package:

```sh
pi install git:github.com/yu1745/pi-extensions
```

## Extensions

| Extension | Path | What it does |
|---|---|---|
| `antigravity` | `extensions/antigravity/` | Antigravity provider (`/login antigravity`) with OAuth login + automatic token refresh, plus `/antigravity.usage`, `/antigravity.models`, `/antigravity.doctor` |
| `served_model` | `extensions/served-model.ts` | Captures the backend-served model (`response.model`) for `openai-responses` / `openai-codex-responses` / `azure-openai-responses` via a `registerApiProvider` override, stamps it onto `AssistantMessage.responseModel`, and shows a warning line only on genuine substitution (dated snapshots / effort suffixes are ignored) |
| `qoder` | `extensions/qoder-fp/` | Qoder provider with full CLI fingerprint simulation (24 ordered Cosy headers, RSA-1024 + AES-128-CBC signed `Authorization`, custom Base64 body alphabet); `/login qoder` via standard device flow, or `/qoder-import` |
| `web_reader` | `extensions/web-reader/` | Anti-WAF web reader with Playwright + stealth + ARIA extraction + Jev semantic load verification |
| `web_search` | `extensions/web-search/` | Web search tool with five switchable backends (Google Antigravity Grounding, OpenAI Codex Responses, DeepSeek, MiniMax Coding Plan, Z.AI Web Search Prime), selected via `/websearch.backend`; one backend at a time, reloaded on `/reload`. Cross-domain benchmark of all five (32 cases × 8 domains, 160 live calls) in [docs/web-search-backend-benchmark.md](docs/web-search-backend-benchmark.md) |
| `quota` | `extensions/quota-footer.ts` | Unified usage monitor in the footer: DeepSeek balance, GLM / MiniMax / Codex / Command Code / CodeBuddy / River quota (one widget, switch-dispatched). Command Code also shows when its monthly credits expire (`expires in Nd`, warning color in the last 3 days). River reads the Console's prepaid USD balance through a rotating WorkOS session — [session rules and re-seeding](docs/river-console-session.md) |
| `image_view` | `extensions/image-view/` | Draws local images inline in the chat stream: Kitty (`\x1b_G`) → iTerm2 (`\x1b]1337`) → Sixel (`\x1bP`) fallback, picked by terminal capability. Auto-renders Markdown `![alt](/abs/path.png)` in replies; `read` images auto-render only when pi has no native image protocol (avoids double-draw); `/img <path>` (prefix `!` to force refresh) |
| `commandcode` | `extensions/commandcode/` | Command Code DeepSeek-only provider with verified sticky multi-account rotation (default low-balance threshold 0.1); [configuration](extensions/commandcode/README.md) |
| `siliconflow` | `extensions/siliconflow.ts` | SiliconFlow (硅基流动) provider with native dynamic model refresh (`refreshModels` + persisted catalog) |
| `runinfra` | `extensions/runinfra.ts` | RunInfra provider (`RUNINFRA_API_KEY` or `/login runinfra`) with dynamic model discovery, OpenAI chat-completions compatible |
| `openai-codex-fast` | `extensions/openai-codex-fast.ts` | `/fast` and `/ultrafast` toggle Codex `service_tier=priority` / `service_tier=ultrafast` |
| `context-window` | `extensions/context-window.ts` | `/context-window` sets or overrides context window for the current model |
| `append` | `extensions/append.ts` | `/append` queues user messages until the agent run stops (at `agent_end`), avoiding tool-call interruption |
| `tokenspeed` | `extensions/tokenspeed.ts` | Model output speed (tokens/sec) status line |
| `tool-duration` | `extensions/tool-duration.ts` | Times every tool call; `/toolduration` optionally injects the duration banner into tool results so the model can see it (off by default) |
| `compact-threshold` | `extensions/compact-threshold.ts` | `/compact-threshold 70` lowers the auto-compact trigger for the current session only; reset on `/new`, `/resume`, `/fork` |
| `chinese-bang-bash` | `extensions/chinese-bang-bash.ts` | Full-width `！` / `！！` trigger Bash mode: keys colour on press, and submission converts them to `!` / `!!` for the native handler |
| `smart-ctrl-c` | `extensions/smart-ctrl-c.ts` | Ctrl+C behaviour patch for the TUI editor (interrupt, then clear input on second press) |
| `filter-image-reader` | `extensions/filter-image-reader.ts` | When the active model already has vision, steers it to `read` instead of the `image-reader` subagent, and filters that subagent out of the Agent tool description |
| `subagents-cost` | `extensions/subagents-cost.ts` | `/subagents-cost` interactive overlay with per-subagent cost/usage breakdown, aggregated across billing entries, sortable by cost or spawn order |
| `codex-cost` | `extensions/codex-cost.ts` | `/codex-cost` syncs OpenAI Codex quota and the daily cross-device spend ledger |
| `working-bell` | `extensions/working-bell.ts` | Working bell + title status |
| `codex-timer` | `extensions/codex-timer.ts` | Codex-style timers: fixed 20-column slot at the front of the footer, "Ready" before the first response, live "Thinking Ns", final "Thought Ns" retained until the next response, and a `─ Worked for Xm YYs ─` separator after each agent run |
| `inject-resume` | `extensions/inject-resume.ts` | Inject-resume-on-exit (pi side, Linux/bash) |
| `status-footer` | `extensions/status-footer.ts` | Enhanced footer with session cost (USD), turn/step counters, TTFT latency, and multi-cycle split |
| `deepseek-time-pricing` | `extensions/deepseek-time-pricing.ts` | DeepSeek 分时定价：按消息时间戳重算 `usage.cost`，成本统计跟随高峰/空闲价；`/deepseek-pricing` 查看当前档位。provider `deepseek` 匹配 `deepseek-flash`、`deepseek-v4[.x]-flash*` 与 `deepseek-v4[.x]-pro`（CNY 价目，原样写入 `usage.cost`，不经过美元）；provider `commandcode` 匹配 `deepseek/deepseek-v4[.x]-pro` 与 `deepseek/deepseek-v4[.x]-flash`（含 `-vision-exp`，USD 价目直用）；平价模型 `deepseek/deepseek-v4-flash-fast` 不参与分时；`tests/deepseek-time-pricing.test.ts` 覆盖各档位与边界 |
| `clear-new-alias` | `extensions/clear-new-alias.ts` | Clears the new-version alias notice |
| `codebuddy` | `extensions/codebuddy-fp/` | CodeBuddy (Tencent) provider with official-CLI fingerprint simulation and a toggleable disguise level (`/codebuddy-fp on|off`, default off): full mode sends byte-identical round-1 headers/system/tools, off mode sends Pi's own prompt and tools only. OAuth login (`/codebuddy-login`), CLI credential import (`/codebuddy-import`), token auto-refresh, aligned telemetry (config/accounts/report/traces) with zero git-repo leakage |

<details>
<summary><strong>Shadowed</strong> (code in repo, not activated)</summary>

| Extension | Path | What it does |
|---|---|---|
| `web_reader_local` | `shadowed/web-reader-local/` | Local HTML→Markdown reader — no API key needed, Readability-inspired content extraction. See [`shadowed/README.md`](shadowed/README.md) for the re-enable steps. |

</details>

> **27 extensions, one package.** Previously separate repos (`pi-web-reader-spa`) are merged here — uninstall the standalone packages before installing this one to avoid duplicate tool registration.
> pi-smart-compact is provided separately by the fork `git:github.com/yu1745/pi-smart-compact` (upstream + `allowUnverifiedApply`).>
> The `subagent` extension was **removed** in favor of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) (install with `pi install npm:@tintinweb/pi-subagents`).

### Codex request tier logging

`openai-codex-fast` keeps the existing process-shared `/fast` / `/ultrafast` mode (in-process subagents inherit it; restart resets it). Each valid object payload passing the Codex `before_provider_request` hook appends a non-context `custom` entry named `openai-codex-fast-request`. Logs do not restore the mode or inject message text.

Schema v1: `version`, `kind: "requested_service_tier"`, local UUID `request_id`, `session_id`, `parent_entry_id` (leaf before append), `provider`, `model` (payload model, otherwise selected model), `mode`, `service_tier` (`default` / `priority` / `ultrafast`; `unknown` for other explicit values), and `service_tier_explicit`. Standard leaves the payload untouched, including an existing explicit tier; absent tier is recorded as the client default. No prompts, credentials, full payloads, or usage/cost changes are recorded.

This is a **request-time client snapshot**, not a server-confirmed or billed tier. Pi 0.85.1 exposes only payload on this hook, not the physical provider/model or a request-to-message ID; filtering retains the existing selected-provider semantics (virtual routing/independent calls are not guaranteed). Later extensions can still alter the payload. A hook entry does not prove successful transmission: Codex HTTP retries and WebSocket fallback reuse the serialized payload without rerunning this hook. New hook invocations get distinct local IDs, not server retry IDs. Persistence follows Pi session settings (no durable file in no-session/in-memory mode).

Although `message_end` supports replacement before persistence, it exposes no matching request token. The plugin deliberately does **not** infer assistant/usage association by ordering, global mode at completion, or response ID; nested/concurrent calls and retries would make that unsafe. Session/leaf fields are navigation hints, not proof of message association.

Offline tests: `node --experimental-strip-types --test tests/openai-codex-fast.test.ts`.

## Native TypeSafe Jev classifier (Pi >=1.0)

Jev uses Pi's built-in `typesafe` provider; no separate provider plugin is needed:

```text
/login typesafe
```

Alternatively set `TYPESAFE_API_KEY`. A legacy `typesafe-jev` entry is not looked up by the native `typesafe` provider; save the same key with `/login typesafe` rather than reinstalling the retired plugin. Classifier models do not appear in the chat model picker.

Extensions use `ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest")` and `ctx.modelRegistry.classify(model, { state, questions }, options)`. The thin `extensions/shared/jev/runtime.ts` helper adds cancellation/deadlines (20 seconds by default, shorter caller budgets) and answer validation, not HTTP or credential handling. Every call explicitly sets `maxRetries: 0` to preserve those budgets. Boolean answers use `probability` (0–1); failures are checked via `stopReason`. Native usage is accumulated in `web_reader` tool results, including reported usage on failed decisions; direct TypeSafe models without catalog pricing report tokens without inventing a charge. Missing usage remains unknown. Tokenizer classification in `tokenspeed` runs outside a tool result: its usage is not added to session totals or mixed into chat token-speed measurements.

The live experiment scripts use `tests/jev-runtime-helper.mjs` with native `ModelRuntime`/`ModelRegistry`; running them requires network access and may incur charges. Historical benchmark results predate this migration and are not fresh measurements of the native runtime.

## API keys

No keys are hardcoded. Z.AI-backed tools (`web-search`) resolve the key in this order:

1. env var (`Z_AI_MCP_API_KEY`, `Z_AI_VISION_API_KEY` …)
2. pi's configured auth for the `zai-coding-cn` provider (via `modelRegistry.getProviderAuth` — independent of the session's current provider)
3. error with a hint to run `/login zai-coding-cn`

Provider quota monitor (`quota-footer`) reads keys at runtime from `modelRegistry.getApiKeyForProvider(...)`, never from source. The old `/ds-balance`, `/glm-quota`, `/minimax-quota`, `/openai-codex-quota` commands still work as aliases of `/quota`. For `commandcode` it watches the active account's endpoints (`/alpha/billing/credits` + `/alpha/billing/subscriptions`), honoring `COMMANDCODE_API_BASE` and the bundled provider's sticky account pool. The `$` balance shown for Command Code is monthly + purchased + free credits; the trailing `expires in Nd` comes from the subscription's `currentPeriodEnd` and is only shown while monthly credits remain (purchased credits carry over), turning yellow in the last three days. `/commandcode quota` shows all configured accounts. Remove the standalone `npm:pi-commandcode-provider` registration when enabling the bundled provider to avoid duplicate registration.

River is the one provider whose credential is a **session**, not a key: the `rv_t_…` inference key cannot read a balance (the gateway is gRPC-only), so the footer drives `console.river.ai` instead, minting short-lived WorkOS access tokens from a single-use, rotating refresh chain persisted at `~/.pi/agent/river-session.json` (0600). Because WorkOS retires every refresh token on use, the head is written back atomically before the balance call, the access token is reused for its full 5-minute life, a terminal `invalid_grant` is recorded instead of retried forever, and an hourly keep-alive keeps the session from lapsing from disuse while another provider is selected. `/river-session <cookie>` re-seeds after a sign-out; duration is bounded by WorkOS's per-application session length and inactivity timeout, both set by River and not derivable from the token. Details, failure modes and recovery in [docs/river-console-session.md](docs/river-console-session.md).

## Development

This repo uses **pnpm**. `package-lock.json` was removed in favor of
`pnpm-lock.yaml`.

Antigravity and web search load committed ESM entries from `bundle/` to avoid
transpiling their main TypeScript implementations on every startup. OAuth and
its shared Antigravity helpers remain source-only, loaded through Pi's TypeScript
loader: generated files do not duplicate OAuth client credentials, and login,
provider and search retain one set of transport/identity caches. Pi and npm
dependencies are resolved by the host, not bundled. Source remains in `extensions/`. After changing either extension or its dependencies, run
`pnpm build:extensions` and commit the generated files. `pnpm check:bundles`
checks freshness without modifying files. Git installs need no build step.
If selecting individual extensions in Pi package settings, use
`bundle/antigravity.js` and `bundle/web-search.js` instead of their source paths.

```sh
pnpm install          # types + typebox for local typecheck
pnpm exec tsc --noEmit ... # typecheck an extension
pnpm test             # full test suite
```

Load a single extension without installing the package:

```sh
pi -e git:github.com/yu1745/pi-extensions
```
