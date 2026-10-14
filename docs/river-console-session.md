# River Console session — balance, renewal and recovery

How `quota-footer` reads the River (river.ai) prepaid balance, how long that access
survives, and what to do when it does not.

## Why the API key cannot do this

River runs two separate surfaces:

| Surface | Auth | Balance? |
|---|---|---|
| `https://api.river.ai` | `Authorization: Bearer rv_t_…` | **No.** It is a gRPC-only Envoy gateway: every path except `/v1/models` answers `HTTP 200` with `grpc-status: 12`, so there is no REST route to query. |
| `https://console.river.ai` | `Authorization: Bearer <WorkOS access token>` | Yes — `GET /api/billing/account`. |

The inference key and the Console session are independent credentials. **A dead
Console session never affects completions**; only the footer widget degrades.

## The chain

```
~/.pi/agent/river-session.json                    console.river.ai/api/billing/account
  refresh_token  ─┐                                        ▲
  wos_session    ─┤   POST {auth}/user_management/authenticate
                  └──────────────► access_token ───────────┘
                                   (JWT, exp − iat = 300s)
```

- Auth host and client id come from `GET /api/auth/config` (cached per process),
  falling back to `auth.console.river.ai` / the public AuthKit client id.
- `refresh_token` goes in the **body**; the sealed `wos-session` cookie is the
  fallback attempt. Both address the same session.
- The store also caches `access_token` + `access_expires_at`, so the balance is
  polled without advancing the chain until the token is ~1 minute from expiry.

## Renewal rules (WorkOS AuthKit)

Refresh tokens have no lifetime of their own. The session's life is set per
application in River's WorkOS dashboard, and three knobs matter:

| Knob | Behaviour | Effect here |
|---|---|---|
| **Maximum session length** | Absolute. Expiry forces a new sign-in. | Caps how long the integration can live without a re-seed, no matter what we do. |
| **Inactivity timeout** | *"The session ends if a refresh has not occurred in this length of time."* | **Sliding.** Every exchange resets it — including the browser's. |
| **Access token duration** | Measured at 300s for this tenant. | Sets the floor on how often the chain must advance (≤ 1 exchange / 5 min). |

Two more AuthKit behaviours shape the design:

- **Refresh tokens are single-use.** Each exchange retires the head and returns a
  new one, so the head is the only durable state. Losing the newest head means
  losing the session; persisting it therefore happens *before* the balance call,
  atomically (`tmp` + `rename`, mode `0600`).
- **The replay grace period is 30 seconds.** Replaying a just-exchanged head
  inside that window returns the *same* rotated tokens instead of an error, so
  concurrent refreshes converge. Past 30s a replay is a terminal
  `invalid_grant`, and WorkOS may treat it as token theft.

Failure classification follows the official table, so a blip never costs a login:

| Response | Treated as | Store effect |
|---|---|---|
| `200` | success | head rotated, `refreshed_at` stamped |
| `400 invalid_grant` | terminal | head recorded in `head_dead`; the session is **kept** |
| network error / `408` / `429` / `5xx` | transient | nothing written — retried on a later poll |

## Kinds of risk

1. **Replay after the grace period** — a second pi process, a crash between
   exchange and write, or a stale copy of the head. Mitigated by writing
   immediately, retrying once against a re-read store, and never deleting the
   session on a terminal error.
2. **Sharing one session with the browser** — the Console in a browser drives the
   same single-use chain. Whoever exchanges second, more than 30s later, loses.
   The browser recovers by re-authenticating (usually a silent Google round-trip);
   the extension does not. Prefer seeding from a **separate browser profile** the
   Console is not used in, or expect the browser to need one re-login after the
   handover.
3. **Idle expiry** — if no refresh happens for River's inactivity timeout (or the
   maximum session length is reached), the session is over. The hourly keep-alive
   covers "pi open, another provider selected"; nothing can cover "pi not running".
4. **Sign-out / revocation** — signing out of the Console revokes the session for
   every client using it.

## Re-seeding

`/river-session <value>` writes a fresh session atomically and verifies it
immediately. `<value>` is either the sealed cookie (copy `wos-session` from
devtools → Application → Cookies, or paste the whole `wos-session=…; Domain=…`
row — name prefix and attributes are stripped) or a bare WorkOS refresh token.

Without the command, drop the value into any of these and the next poll adopts it
automatically, once the old head is terminally dead:

```bash
RIVER_WOS_SESSION='Fe26.2**…'          # prefix-name and trailing attributes tolerated
RIVER_WORKOS_REFRESH_TOKEN='…'
```

or a `river` entry in pi's own `~/.pi/agent/auth.json`:

```json
{ "river": { "type": "oauth", "refresh": "Fe26.2**…" } }
```

Precedence is deliberate: **the store file wins while it still holds a live head**
(it holds the rotated one, and replaying an env var would look like token theft).
A seed is consulted only to bootstrap an empty store or to take over a dead one,
which is what makes re-seeding work without deleting anything.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `RIVER_WOS_SESSION` / `RIVER_WORKOS_REFRESH_TOKEN` | — | Bootstrap / recovery seed. |
| `RIVER_SESSION_FILE` | `~/.pi/agent/river-session.json` | Store location. |
| `RIVER_CONSOLE_BASE` | `https://console.river.ai` | Console origin. |
| `RIVER_WORKOS_API_HOSTNAME` / `RIVER_WORKOS_CLIENT_ID` | from `/api/auth/config` | Override AuthKit discovery. |
| `RIVER_TEAM_ID` | — | Sends `X-River-Team` for a team-billed balance. |
| `RIVER_KEEPALIVE` | `1` | `0` disables the keep-alive exchange. |
| `RIVER_KEEPALIVE_MS` | `3600000` | Keep-alive interval; set it below the account's inactivity timeout. |

## Footer output

`River █████░░░░░ $24.87` — absolute USD balance, `bar()` against a $50 full-bar
reference (a prepaid pool has no natural cap), red below `low_balance_threshold_usd`
when the account sets one (else $2 / $5), plus `+$N limit` for a credit line and the
raw `status` word when it is not `active`. `River auth error` means the session is
gone: re-seed as above.
