#!/usr/bin/env node
// Refresh the Command Code pricing overlay from upstream.
//
// This is deliberately a script, not a test. The Command Code catalog and
// price list change without notice, so asserting "MODEL_COSTS equals the last
// fetch" only produces red builds that have nothing to do with our code. This
// script fetches the live catalog, diffs it against extensions/commandcode/
// fixtures/commandcode-model-ids.json and against MODEL_COSTS, and reports what
// a human (or an agent) needs to update by hand.
//
//   node scripts/sync-pricing.mjs            # report drift, refresh snapshots
//   node scripts/sync-pricing.mjs --check    # report only, never write (CI)
//
// Exit code is always 0: drift is upstream's business, not a build failure.

import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const CATALOG_URL = "https://api.commandcode.ai/provider/v1/models"
const PRICING_URL = "https://commandcode.ai/docs/resources/pricing-limits"
const FIXTURES = new URL("../extensions/commandcode/fixtures/", import.meta.url)
const PRICING_FILE = new URL("../extensions/commandcode/src/pricing.ts", import.meta.url)

const checkOnly = process.argv.includes("--check")

async function loadPricingModule() {
  const { MODEL_COSTS, FREE_MODEL_IDS, PRICING_LAST_VERIFIED } = await import(
    PRICING_FILE.href
  )
  return { MODEL_COSTS, FREE_MODEL_IDS, PRICING_LAST_VERIFIED }
}

async function fetchCatalog() {
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`${CATALOG_URL} responded ${res.status}`)
  const body = await res.json()
  return body.data.map((model) => model.id)
}

async function main() {
  const [{ MODEL_COSTS, FREE_MODEL_IDS, PRICING_LAST_VERIFIED }, liveIds] = await Promise.all([
    loadPricingModule(),
    fetchCatalog(),
  ])

  const snapshotPath = new URL("commandcode-model-ids.json", FIXTURES)
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf-8"))
  const previousIds = snapshot.modelIds
  const liveSet = new Set(liveIds)

  const added = liveIds.filter((id) => !previousIds.includes(id)).sort()
  const removed = previousIds.filter((id) => !liveSet.has(id)).sort()
  const unpriced = liveIds.filter((id) => !(id in MODEL_COSTS)).sort()
  const stale = Object.keys(MODEL_COSTS).filter((id) => !liveSet.has(id)).sort()
  const undeclaredFree = Object.entries(MODEL_COSTS)
    .filter(
      ([, cost]) =>
        cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0,
    )
    .map(([id]) => id)
    .filter((id) => !FREE_MODEL_IDS.has(id))
    .sort()

  console.log(`catalog: ${liveIds.length} models (snapshot ${previousIds.length})`)
  console.log(`MODEL_COSTS: ${Object.keys(MODEL_COSTS).length} entries`)
  console.log(`pricing last verified: ${PRICING_LAST_VERIFIED}\nsource: ${PRICING_URL}\n`)

  report("added upstream (unpriced models warn at runtime)", added)
  report("removed upstream (drop from MODEL_COSTS)", removed)
  report("in catalog but missing from MODEL_COSTS", unpriced)
  report("in MODEL_COSTS but no longer in the catalog", stale)
  report("all-zero cost without a FREE_MODEL_IDS entry", undeclaredFree)

  if (checkOnly) {
    console.log("\n--check: snapshots left untouched.")
    return
  }

  snapshot.source = CATALOG_URL
  snapshot.fetchedAt = new Date().toISOString()
  snapshot.modelIds = [...liveIds].sort()
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`\nwrote ${fileURLToPath(snapshotPath)}`)
  if (added.length || removed.length) {
    console.log(`update the price rows in ${fileURLToPath(PRICING_FILE)} and bump PRICING_LAST_VERIFIED.`)
  }
}

function report(label, items) {
  console.log(items.length ? `${label}:` : `${label}: none`)
  for (const item of items) console.log(`  ${item}`)
  console.log()
}

await main()