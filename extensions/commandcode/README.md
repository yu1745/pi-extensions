# Command Code DeepSeek provider + sticky account pool

Migrated from [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider), version **0.6.4**, tag commit `adea6585c0ba0a3bae064bec151c8f5df7b739df`. The original MIT license is preserved in `LICENSE`. The copied upstream `src/` matched the installed 0.6.4 package before modifications.

**Only DeepSeek-family models are registered and supported by this migration.** Live and cached catalogs are filtered to `deepseek/...` or `deepseek-*` IDs (including V4 Flash, Flash Fast, experimental vision and Pro when returned by the API). Other model families are not registered or part of live acceptance testing. Generic upstream parsing/catalog files are retained to minimize migration changes.

Both native `/provider/v1` and legacy `/alpha/generate` transports remain supported for DeepSeek, as do model discovery, OAuth, cost calculation and the `commandcode` provider ID.

## Configure

### Interactive account manager (recommended)

Run `/commandcode` or `/commandcode accounts` in Pi's TUI (`/commandcode-accounts` is an alias).

- Opening the manager automatically queries each account's quota (Esc cancels). Rows show remaining balance, five-hour/weekly usage percentages, and current/cooldown status; highlight an account for balance breakdown and reset countdowns.
- **刷新额度** repeats these read-only display queries without rotating accounts or changing cooldown state. Failed queries show unknown, not exhausted; `/commandcode quota refresh` remains the explicit runtime recovery verification command.
- Add one key or paste several comma/newline-separated keys at once; key input is masked.
- Select an account to replace its key or delete it. At least one account must remain.
- Change the low-balance threshold without editing JSON.
- Changes stay in a local draft until **保存并生效**; saving writes atomically with mode `0600` and automatically reloads Pi. Escape/exit lets you discard the draft.
- Keys are not appended to the conversation or model context. No backup credential copies are created.
- Concurrent edits are rejected rather than overwritten. If `COMMAND_CODE_API_KEYS` is set, remove it before editing through the UI because it overrides file configuration.

After installing this UI update, run `/reload` once to register the new command. Other Pi processes need their own reload after configuration changes. Key syntax is checked locally; quota verification remains available through `/commandcode quota refresh`.

### Configuration file / environment compatibility

Without an account pool, the upstream single-account authentication and retry behavior is unchanged. Existing Pi `auth.json` credentials and `COMMAND_CODE_API_KEY` / legacy `COMMANDCODE_API_KEY` continue to work.

For a pool, create `~/.pi/agent/commandcode-accounts.json` (or the equivalent under `PI_CODING_AGENT_DIR`):

```json
{
  "policy": { "remainingCreditsThreshold": 0.1 },
  "accounts": [
    { "id": "primary", "apiKey": "REPLACE_WITH_FIRST_KEY" },
    { "id": "backup", "apiKey": "REPLACE_WITH_SECOND_KEY" }
  ]
}
```

Protect this file with `chmod 600`. Do not commit it. Restart or `/reload` after changing pool configuration.

Source priority (one source only, never implicitly merged):

1. `COMMAND_CODE_API_KEYS` (comma/newline-separated keys).
2. Pi agent directory `commandcode-accounts.json`.
3. `~/.commandcode/accounts.json`.
4. Existing single-account auth when no pool source exists.

An invalid/empty higher-priority source is an error, not a fallback. Environment pools use the default threshold. File pools may customize the threshold to any finite nonnegative number. Old `activeIndex` is accepted only as initial state. Explicit account IDs must be unique safe identifiers; otherwise stable fingerprints are generated.

A configured pool supplies the actual request credentials even if Pi injects a different default key. To pin a single key, disable the pool configuration first. Custom Authorization/x-api-key headers are rejected in pool mode rather than silently querying one account and generating with another.

## Rotation rules

- Keep using the active account. No random distribution, round-robin load balancing, or automatic switch-back.
- On HTTP 429 or a recognizable quota error, query whoami and billing credits before switching.
- A valid exhausted five-hour/weekly window **or complete total balance <= 0.1** confirms unavailability (threshold is configurable; it need not equal zero).
- Total balance includes monthly, purchased and free credits. Missing values are not silently treated as zero by the exhaustion verifier. `cap=0` has unknown semantics.
- A failed/incomplete query is **unknown**, not proof of exhaustion. Unknown or available ends that failure without rotation and preserves the provider error.
- Once text, thinking, or tool-call events were forwarded, the request is never replayed. Verification may mark the account for future requests only.
- HTTP and in-stream errors use one shared state machine above both transport adapters. Attempt terminal errors are held until verification; only one final error/done reaches the caller.
- Normal retry budget is shared across accounts; no inner SDK quota retries hide the first failure. Default normal retries remain zero.
- Pool requests have an overall ten-minute deadline (including verification/retries), adjustable using `COMMANDCODE_TOTAL_TIMEOUT_MS` as a positive millisecond value. Existing per-attempt `timeoutMs` remains separate. User cancellation stops waiting immediately.

## State and recovery

Runtime state lives in `~/.pi/agent/commandcode-account-state.json`, separate from credentials. It stores active identity, fingerprints, confirmed exhaustion and recheck timestamps—not API keys. Writes are atomic and protected by a bounded cross-process lock.

When several windows are exhausted, the latest known reset bounds the next recheck. Missing, past, or otherwise unknown resets use a conservative one-hour recheck policy. Recheck time is **not guaranteed recovery**. Due exhausted accounts must be reverified before reuse. Unknown recovery checks retain the unavailable state; a currently usable active account is never displaced merely because an older account's timer expires.

Concurrent verification is coalesced per account; one cancelled waiter does not cancel another caller's verification. When the last waiter cancels, the shared query is aborted. Network I/O never holds the state lock. File-backed pools are namespaced by configuration path and environment pools by key-set fingerprint, preventing independent pools from deleting each other's state. Read-only snapshots do not rewrite unchanged state.

A provably dead PID's main `.lock` is recoverable. A crash inside the very short synchronous acquisition gate can leave `.lock.gate`; an ambiguous gate deliberately fails closed after two seconds rather than stealing a live lock. If that occurs, stop all Pi processes using this state file and remove the stale gate before retrying. Never delete a live process's lock.

## Commands and footer

- `/commandcode`, `/commandcode accounts` or `/commandcode-accounts`: interactive local account management (TUI only).
- `/commandcode-quota` or `/commandcode quota`: sequential multi-account quota overview, threshold and persisted cooldown reasons; no account selection side effects.
- `/commandcode-quota refresh` or `/commandcode quota refresh`: explicitly reverify accounts, including after a manual top-up. This can clear verified recovery but does not choose a different active account.
- The monorepo quota footer reads the active pool account without causing a rotation; single-account fallback stays unchanged.

## Test and migration

From repository root:

```sh
npm run typecheck:commandcode
npm run test:commandcode
npm test
```

`tests/commandcode-upstream/` contains 14 upstream unit suites with source import paths adjusted, plus the original fixtures/helpers. The command alias registration test allows the new alias. The abort test now waits for the first actual text event instead of racing a fixed timer, and the event collector clears its timeout. Upstream package-layout, CLI/live and GitHub metadata-check scripts are not blindly copied because their standalone package assumptions do not apply here. New tests exercise the real Pi CLI with an empty auth store, mock DeepSeek endpoints and verified rotation; separate minimal live tests use DeepSeek only.

Never register this extension alongside `npm:pi-commandcode-provider`: both register the same provider and commands. Before switching, back up Pi settings, disable the old package registration, and enable this monorepo entry. Verify loading and a minimal request before removing the old installation. To roll back, disable the monorepo entry and restore the old package registration. Keep the old auth credentials untouched.

Real tests must not deliberately spend down credits to trigger exhaustion. Use mocked 429/quota responses for deterministic rotation coverage, and small prompts plus quota reads for live smoke testing. Never print keys, full auth files, or raw authenticated response bodies.
