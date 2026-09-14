import test from "node:test"
import assert from "node:assert/strict"
import {
  verifyAccountExhaustion,
  verifyCreditsSnapshot,
} from "../extensions/commandcode/src/exhaustion.ts"

const NOW = 1_750_000_000_000
const now = () => NOW
function snapshot(monthlyCredits = 1, purchasedCredits = 0, freeCredits = 0) {
  return {
    credits: { monthlyCredits, purchasedCredits, freeCredits },
    windowLimits: {
      fiveHour: { used: 1, cap: 10, resetAt: NOW + 600_000 },
      weekly: { used: 1, cap: 10, resetAt: NOW + 7_200_000 },
    },
  }
}

test("complete balances use inclusive default and custom thresholds", () => {
  for (const amount of [0, 0.01, 0.1]) {
    const result = verifyCreditsSnapshot(snapshot(amount), { now })
    assert.equal(result.status, "exhausted")
    if (result.status === "exhausted") {
      assert.match(result.reasons[0], /threshold 0.1/)
      assert.equal(result.recheckAt, NOW + 3_600_000)
    }
  }
  assert.equal(verifyCreditsSnapshot(snapshot(0.10001), { now }).status, "available")
  assert.equal(verifyCreditsSnapshot(snapshot(0, 2), { now }).status, "available")
  assert.equal(
    verifyCreditsSnapshot(snapshot(0.5), { remainingCreditsThreshold: 1 }).status,
    "exhausted",
  )
  assert.equal(
    verifyCreditsSnapshot(snapshot(0.01), { remainingCreditsThreshold: 0 }).status,
    "available",
  )
  for (const threshold of [-1, NaN, Infinity, "0", null]) {
    assert.equal(
      verifyCreditsSnapshot(snapshot(), { remainingCreditsThreshold: threshold as number }).status,
      "unknown",
    )
  }
})

test("missing or malformed evidence never supplies zero defaults", () => {
  for (const raw of [
    null,
    [],
    {},
    { credits: {} },
    { credits: { monthlyCredits: 0 } },
    { ...snapshot(), credits: [] },
    { ...snapshot(), windowLimits: [] },
    { ...snapshot(), windowLimits: { ...snapshot().windowLimits, daily: {} } },
  ]) {
    assert.equal(verifyCreditsSnapshot(raw).status, "unknown")
  }
  for (const bad of [-1, NaN, Infinity, "0", null, undefined, false]) {
    assert.equal(
      verifyCreditsSnapshot({ ...snapshot(), credits: { ...snapshot().credits, freeCredits: bad } })
        .status,
      "unknown",
    )
    assert.equal(
      verifyCreditsSnapshot({
        ...snapshot(),
        windowLimits: { ...snapshot().windowLimits, weekly: { used: bad, cap: 1 } },
      }).status,
      "unknown",
    )
  }
  assert.equal(
    verifyCreditsSnapshot(snapshot(Number.MAX_VALUE, Number.MAX_VALUE)).status,
    "unknown",
  )
})

test("window evidence suffices and collects all reasons with latest normalized reset", () => {
  for (const reset of [
    NOW + 7_200_000,
    (NOW + 7_200_000) / 1000,
    new Date(NOW + 7_200_000).toISOString(),
    String((NOW + 7_200_000) / 1000),
  ]) {
    const raw = snapshot()
    raw.windowLimits.fiveHour.used = 10
    raw.windowLimits.weekly.used = 11
    const result = verifyCreditsSnapshot(
      {
        ...raw,
        windowLimits: { ...raw.windowLimits, weekly: { used: 11, cap: 10, resetAt: reset } },
      },
      { now },
    )
    assert.equal(result.status, "exhausted")
    if (result.status !== "exhausted") continue
    assert.equal(result.reasons.length, 2)
    assert.equal(result.knownResetAt, NOW + 7_200_000)
    assert.equal(result.recheckAt, NOW + 7_200_000)
  }
  const raw = snapshot()
  raw.windowLimits.fiveHour.used = 10
  const result = verifyCreditsSnapshot({ windowLimits: raw.windowLimits }, { now })
  assert.equal(result.status, "exhausted")
  if (result.status === "exhausted") assert.equal(result.recheckAt, NOW + 3_600_000)
})

test("invalid/past resets back off; unknown conditions cannot precede future blockers", () => {
  for (const resetAt of [undefined, null, -1, NaN, "bad", "", "-1", NOW - 1, NOW, {}]) {
    const raw = snapshot()
    const result = verifyCreditsSnapshot(
      { ...raw, windowLimits: { ...raw.windowLimits, fiveHour: { used: 10, cap: 10, resetAt } } },
      { now },
    )
    assert.equal(result.status, "exhausted")
    if (result.status === "exhausted") {
      assert.equal(result.knownResetAt, undefined)
      assert.equal(result.recheckAt, NOW + 3_600_000)
    }
  }
  const raw = snapshot(0)
  raw.windowLimits.weekly.used = 10
  const result = verifyCreditsSnapshot(raw, { now })
  assert.equal(result.status, "exhausted")
  if (result.status === "exhausted") assert.equal(result.recheckAt, NOW + 7_200_000)
})

test("zero caps unknown unless another independent exhaustion proof exists", () => {
  const raw = snapshot()
  raw.windowLimits.fiveHour.cap = 0
  assert.equal(verifyCreditsSnapshot(raw).status, "unknown")
  raw.credits.monthlyCredits = 0
  assert.equal(verifyCreditsSnapshot(raw).status, "exhausted")
})

const json = (value: unknown) => new Response(JSON.stringify(value))
test("network uses only identity and credits, encoded orgId and protected authorization", async () => {
  for (const identity of [{ org: { id: "a&b" } }, { user: { userName: "test" } }]) {
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      paths.push(String(input))
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key")
      return json(paths.length === 1 ? identity : snapshot())
    }
    const result = await verifyAccountExhaustion({
      apiKey: "test-key",
      baseUrl: "https://mock.invalid/",
      fetchImpl,
      extraHeaders: { authorization: "wrong", AUTHORIZATION: "wrong-again" },
      now,
    })
    assert.deepEqual(result, { status: "available", observedAt: NOW })
    assert.deepEqual(paths, [
      "https://mock.invalid/alpha/whoami",
      `https://mock.invalid/alpha/billing/credits${"org" in identity ? "?orgId=a%26b" : ""}`,
    ])
  }
})

test("network, HTTP, JSON and identity failures are safe unknowns", async () => {
  for (const response of [
    () => {
      throw new Error("secret-test-key")
    },
    () => new Response("secret-test-key", { status: 401 }),
    () => new Response("invalid json"),
    () => json({}),
    () => json({ org: { id: 12 } }),
    () => json([]),
  ]) {
    const result = await verifyAccountExhaustion({
      apiKey: "secret-test-key",
      fetchImpl: async () => response(),
    })
    assert.equal(result.status, "unknown")
    assert.ok(!JSON.stringify(result).includes("secret-test-key"))
  }
  let calls = 0
  assert.equal(
    (
      await verifyAccountExhaustion({
        apiKey: "test",
        fetchImpl: async () =>
          ++calls === 1 ? json({ user: { name: "test" } }) : new Response("no", { status: 500 }),
      })
    ).status,
    "unknown",
  )
  assert.equal(calls, 2)
})

test("caller cancellation rejects AbortError before or during requests; timeout is unknown", async () => {
  const pre = new AbortController()
  pre.abort(new Error("private reason"))
  await assert.rejects(
    verifyAccountExhaustion({
      apiKey: "test",
      signal: pre.signal,
      fetchImpl: async () => {
        throw new Error("must not run")
      },
    }),
    { name: "AbortError" },
  )
  for (const stage of [1, 2]) {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      if (++calls === stage) {
        controller.abort()
        return new Promise(() => {})
      }
      return json({ user: { name: "test" } })
    }
    await assert.rejects(
      verifyAccountExhaustion({ apiKey: "test", signal: controller.signal, fetchImpl }),
      { name: "AbortError" },
    )
    assert.equal(calls, stage)
  }
  const result = await verifyAccountExhaustion({
    apiKey: "test",
    timeoutMs: 5,
    fetchImpl: () => new Promise(() => {}),
  })
  assert.equal(result.status, "unknown")
  if (result.status === "unknown") assert.match(result.reason, /timed out/)
})
