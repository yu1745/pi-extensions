import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  FREE_MODEL_IDS,
  MODEL_COSTS,
  PRICING_LAST_VERIFIED,
  PRICING_SOURCE_URL,
  TEMPORARY_PRICING,
} from "../../extensions/commandcode/src/pricing.ts"

function assertCost(
  modelId: string,
  expected: { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
  const cost = MODEL_COSTS[modelId]
  assert.ok(cost, `${modelId} should have pricing`)
  assert.deepEqual(
    {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
    },
    expected,
    `${modelId} base pricing should match the source`,
  )
}

// These tests cover invariants of the table we own. Whether the table matches
// Command Code's live catalog is upstream data, not code behaviour: that check
// lives in `pnpm pricing:sync`, which refreshes MODEL_COSTS instead of failing
// the suite on every upstream price change.
describe("MODEL_COSTS pricing overlay", () => {
  it("prices every model non-negatively and every free model at zero", () => {
    for (const [modelId, cost] of Object.entries(MODEL_COSTS)) {
      for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        assert.ok(Number.isFinite(cost[field]), `${modelId} ${field} should be finite`)
        assert.ok(cost[field] >= 0, `${modelId} ${field} cost should be non-negative`)
      }

      const allZero = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(
        (value) => value === 0,
      )
      assert.equal(
        allZero,
        FREE_MODEL_IDS.has(modelId),
        `${modelId} free-model status should be explicit in FREE_MODEL_IDS`,
      )
    }
  })

  it("only lists free models that actually have a price entry", () => {
    for (const modelId of FREE_MODEL_IDS) {
      assert.ok(MODEL_COSTS[modelId], `${modelId} is listed as free but has no price entry`)
    }
  })

  it("keeps context-dependent tiers well-formed and ordered", () => {
    for (const [modelId, cost] of Object.entries(MODEL_COSTS)) {
      if (!cost.tiers) continue
      assert.ok(cost.tiers.length > 0, `${modelId} should not declare an empty tier list`)
      let previous = 0
      for (const tier of cost.tiers) {
        assert.ok(
          tier.inputTokensAbove > previous,
          `${modelId} tier thresholds should be strictly increasing`,
        )
        previous = tier.inputTokensAbove
        for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          assert.ok(Number.isFinite(tier[field]), `${modelId} tier ${field} should be finite`)
          assert.ok(tier[field] >= 0, `${modelId} tier ${field} cost should be non-negative`)
        }
      }
    }
  })

  it("keeps the pinned regressions for previously mispriced models", () => {
    assertCost("deepseek/deepseek-v4-pro", {
      input: 0.66,
      output: 1.98,
      cacheRead: 0.022,
      cacheWrite: 0,
    })
    assertCost("deepseek/deepseek-v4-flash", {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
      cacheWrite: 0,
    })
    assertCost("deepseek/deepseek-v4.1-flash", {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
      cacheWrite: 0,
    })
    assertCost("xiaomi/mimo-v2.5-pro", {
      input: 0.435,
      output: 0.87,
      cacheRead: 0.0036,
      cacheWrite: 0,
    })
    assertCost("Qwen/Qwen3.7-Max", {
      input: 2.5,
      output: 7.5,
      cacheRead: 0.5,
      cacheWrite: 3.13,
    })
    assertCost("MiniMaxAI/MiniMax-M2.5", {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.03,
      cacheWrite: 0,
    })
    assertCost("Qwen/Qwen3.8-27B", {
      input: 0.4,
      output: 3,
      cacheRead: 0.04,
      cacheWrite: 0,
    })
    assertCost("Qwen/Qwen3.8-Flash", {
      input: 0.16,
      output: 0.47,
      cacheRead: 0.016,
      cacheWrite: 0,
    })
    assertCost("z-ai/glm-5.3-flash", {
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
      cacheWrite: 0,
    })
    assertCost("tencent/hy4-preview", {
      input: 0.834,
      output: 2.501,
      cacheRead: 0.042,
      cacheWrite: 0,
    })
    assertCost("google/gemini-3.7-flash", {
      input: 1.5,
      output: 7.5,
      cacheRead: 0.15,
      cacheWrite: 0.08334,
    })
    assertCost("claude-fable-5-1", {
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    })
    assertCost("deepseek/deepseek-v4-flash-fast", {
      input: 0.28,
      output: 0.56,
      cacheRead: 0.07,
      cacheWrite: 0,
    })
    assertCost("meta/muse-spark-1.2-contributor", {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.002,
      cacheWrite: 0,
    })
  })

  it("uses the documented base rates for context-dependent models", () => {
    assertCost("Qwen/Qwen3.7-Plus", {
      input: 0.4,
      output: 1.6,
      cacheRead: 0.08,
      cacheWrite: 0.5,
    })
    assertCost("Qwen/Qwen3.7-Flash", {
      input: 0.03,
      output: 0.13,
      cacheRead: 0.006,
      cacheWrite: 0.038,
    })
    assertCost("gpt-5.6-terra", { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 })
    assertCost("gpt-5.6-luna", { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 })
    assert.deepEqual(MODEL_COSTS["xai/grok-4.6"]?.tiers, [
      {
        inputTokensAbove: 200_000,
        input: 4,
        output: 12,
        cacheRead: 1,
        cacheWrite: 0,
      },
    ])
  })

  it("tracks pricing provenance", () => {
    assert.equal(PRICING_SOURCE_URL, "https://commandcode.ai/docs/resources/pricing-limits")
    assert.match(PRICING_LAST_VERIFIED, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(
      PRICING_LAST_VERIFIED <= new Date().toISOString().slice(0, 10),
      "PRICING_LAST_VERIFIED must not be in the future",
    )
  })

  it("fails once temporary pricing needs review", () => {
    const today = new Date().toISOString().slice(0, 10)
    for (const pricing of TEMPORARY_PRICING) {
      assert.match(pricing.expiresOn, /^\d{4}-\d{2}-\d{2}$/)
      assert.ok(pricing.models.length > 0)
      assert.ok(
        pricing.expiresOn >= today,
        `${pricing.description} for ${pricing.models.join(", ")} expired on ${pricing.expiresOn}; refresh MODEL_COSTS`,
      )
      for (const modelId of pricing.models) {
        assert.ok(MODEL_COSTS[modelId], `${modelId} should have a temporary price entry`)
      }
    }
  })
})