#!/usr/bin/env node
// Keep the Command Code pricing overlay in sync with upstream — automatically.
//
// Both halves of the overlay are parsed, never typed by hand:
//
//   * the catalog (api.commandcode.ai/provider/v1/models) lists the ids we can
//     be asked to price and the names to match them by;
//   * the pricing page carries a React payload with per-token rates, context
//     tiers, free flags and time-of-day rates. That payload — not the rendered
//     table — is the source MODEL_COSTS is generated from.
//
//   node scripts/sync-pricing.mjs            # rewrite the table + catalog snapshot
//   node scripts/sync-pricing.mjs --check    # report drift, write nothing, exit 1
//
// The page is undocumented territory: a Next.js flight payload, not an API.
// Every step is therefore guarded, so a shape change fails the run loudly
// instead of quietly writing zeros over real prices.

import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const CATALOG_URL = "https://api.commandcode.ai/provider/v1/models"
const PRICING_URL = "https://commandcode.ai/docs/resources/pricing-limits"
const ROOT = new URL("../extensions/commandcode/", import.meta.url)
const TABLE_FILE = new URL("src/pricing-table.generated.ts", ROOT)
const IDS_SNAPSHOT = new URL("fixtures/commandcode-model-ids.json", ROOT)

// Guards: refuse to write when upstream stops looking like the payload we parse.
const MIN_COST_ROWS = 50
const MIN_DISPLAY_ROWS = 50
const MAX_UNEXPLAINED_GAPS = 5

const checkOnly = process.argv.includes("--check")

/**
 * Pricing rows upstream publishes that the provider catalog does not serve.
 *
 * The catalog lists what `POST /provider/v1/chat/completions` accepts; a row
 * outside it is either billed on another surface or retired. Both are fine, but
 * they have to be *recorded here with a reason*, because a third kind — a real
 * model we failed to map — looks exactly the same in the payload. Anything
 * unregistered fails the run instead of being skipped quietly.
 */
const OFF_CATALOG_PRICING = {
  "typesafe/jev": {
    name: "Jev",
    // Upstream prices the decision model as a plain "Jev" row next to one row
    // per release ("Jev 1.14.0"), so this entry owns the whole family instead
    // of failing the run on every version bump.
    match: /^Jev(?: \d+(?:\.\d+)*)?$/,
    reason:
      "decision model, billed on POST /provider/v1/systemone (or headless `cmd -p -m typesafe/jev`); " +
      "never in /model, so it never enters the chat pricing path",
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    reason: "retired: absent from the catalog and from /models as of 2026-10-14",
  },
}

/* ------------------------------------------------------------------ fetch -- */

async function fetchCatalog() {
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`${CATALOG_URL} responded ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.data)) throw new Error(`${CATALOG_URL} returned no data array`)
  return body.data.map((model) => ({ id: model.id, name: model.name }))
}

async function fetchPricingRows() {
  const res = await fetch(PRICING_URL, { headers: { "user-agent": "pi-commandcode-pricing-sync" } })
  if (!res.ok) throw new Error(`${PRICING_URL} responded ${res.status}`)

  const payload = flightPayloadText(await res.text())
  const arrays = objectArrays(payload)

  // The page ships two arrays: cost rows (per-token rates, tiers, peak/off-peak)
  // and display rows (context windows, rendered labels, free/deal flags).
  const costRows = arrays.find(
    (rows) => rows.length > 0 && rows.every((row) => typeof row.inputCost === "number"),
  )
  const displayRows = arrays.find(
    (rows) => rows.length > 0 && rows.every((row) => Array.isArray(row.tiers)),
  )
  if (!costRows) throw new Error("pricing payload: no array of rows carrying inputCost")
  if (!displayRows) throw new Error("pricing payload: no array of rows carrying tiers")
  if (costRows.length < MIN_COST_ROWS) {
    throw new Error(`pricing payload: only ${costRows.length} cost rows (< ${MIN_COST_ROWS})`)
  }
  if (displayRows.length < MIN_DISPLAY_ROWS) {
    throw new Error(`pricing payload: only ${displayRows.length} display rows (< ${MIN_DISPLAY_ROWS})`)
  }
  return { costRows, displayRows }
}

/* --------------------------------------------------------------- decoding -- */

/**
 * Index of the bracket closing the one at `openIndex`, string-aware.
 * `text[openIndex]` is the opener itself, so the scan starts at depth 1.
 */
function matchingBracket(text, openIndex, open, close) {
  let depth = 1
  let inString = false
  let escaped = false
  for (let i = openIndex + 1; i < text.length; i++) {
    const char = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === open) depth++
    else if (char === close && --depth === 0) return i
  }
  return -1
}

/**
 * Concatenate the strings Next.js pushes into `self.__next_f`; that stream is
 * where the React server payload — pricing data included — actually lives.
 */
function flightPayloadText(html) {
  const marker = "self.__next_f.push("
  let text = ""
  let cursor = 0
  for (;;) {
    const at = html.indexOf(marker, cursor)
    if (at === -1) break
    const start = at + marker.length
    const end = matchingBracket(html, start - 1, "(", ")")
    if (end === -1) break
    cursor = end + 1
    let chunk
    try {
      chunk = JSON.parse(html.slice(start, end))
    } catch {
      continue
    }
    if (!Array.isArray(chunk)) continue
    for (const part of chunk) if (typeof part === "string") text += part
  }
  if (!text) throw new Error("pricing page: no Next.js flight payload found")
  return text
}

/** Every `[{ "id": ... }]` array in the payload, parsed. */
function objectArrays(text) {
  const marker = '[{"id":"'
  const arrays = []
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const end = matchingBracket(text, at, "[", "]")
    if (end === -1) continue
    try {
      const value = JSON.parse(text.slice(at, end + 1))
      if (Array.isArray(value) && value.every((row) => row && typeof row.id === "string")) {
        arrays.push(value)
      }
    } catch {
      // Not a payload array we can use; keep scanning.
    }
    at = end
  }
  return arrays
}

/* -------------------------------------------------------------- transforming -- */

const normalizeName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "")

/** A row id minus any provider prefix, so `minimax/foo` meets upstream's `foo`. */
const normalizeId = (id) => normalizeName(id.slice(id.lastIndexOf("/") + 1))

/**
 * Whether an id names the no-cost variant of a model (`:free`, `-free`).
 * Upstream ships such a twin next to the paid row under the same display name,
 * so two ids can share a name while meaning very different prices.
 */
const isFreeVariantId = (id) => /free$/.test(normalizeId(id))

/**
 * Index pricing rows so a catalog model can be matched to them.
 *
 * A display name is not an identity: upstream lists a paid model and its
 * `:free` twin — two catalog ids — under one name, so "MiniMax M3.1 Flash
 * Preview" alone cannot say which of the two rows prices which of the two ids.
 * Every key therefore keeps all of its claimants, and `resolve` narrows an
 * ambiguous name by id before failing loudly.
 */
function indexRows(rows, label) {
  const byName = new Map()
  const byId = new Map()
  const push = (map, key, row) => map.set(key, [...(map.get(key) ?? []), row])
  for (const row of rows) {
    push(byName, normalizeName(row.name), row)
    push(byId, normalizeId(row.id), row)
  }

  return {
    /**
     * The row pricing `model`, or undefined when upstream lists none.
     *
     * The id wins: a `:free` twin shares its paid sibling's display name, so
     * the name alone would price the free id at the paid rate. Names are the
     * fallback for the many rows where catalog and page disagree on the id
     * (`MiniMaxAI/MiniMax-M3` vs `minimax-m3`).
     */
    resolve(model) {
      const sameId = byId.get(normalizeId(model.id)) ?? []
      if (sameId.length === 1) return sameId[0]
      if (sameId.length > 1) {
        throw new Error(
          `${label}: id "${model.id}" matches ${sameId.length} rows ` +
            `(${sameId.map((row) => row.id).join(", ")})`,
        )
      }
      const named = byName.get(normalizeName(model.name)) ?? []
      // Only rows of the same kind may stand in for each other: falling back
      // from `foo:free` to the paid `foo` row would bill a free model at list
      // price (and vice versa), which is worse than reporting it unpriced.
      const sameKind = named.filter((row) => isFreeVariantId(row.id) === isFreeVariantId(model.id))
      if (sameKind.length === 1) return sameKind[0]
      if (sameKind.length > 1) {
        throw new Error(
          `${label}: "${model.name}" names ${sameKind.length} rows ` +
            `(${sameKind.map((row) => row.id).join(", ")}) and the id "${model.id}" picks none of them`,
        )
      }
      return undefined
    },
  }
}

function positiveNumber(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${what}: expected a non-negative number, got ${JSON.stringify(value)}`)
  }
  return value
}

/** `inputCost`/`outputCost`/`cacheReadCost` (+ optional cache write) of a row or tier. */
function ratesFrom(source, what, fallbackCacheWrite = 0) {
  return {
    input: positiveNumber(source.inputCost, `${what} inputCost`),
    output: positiveNumber(source.outputCost, `${what} outputCost`),
    cacheRead: positiveNumber(source.cacheReadCost, `${what} cacheReadCost`),
    cacheWrite: positiveNumber(source.cacheWriteCost ?? fallbackCacheWrite, `${what} cacheWriteCost`),
  }
}

/**
 * One pricing row -> our cost shape.
 *
 * Upstream tiers carry the *upper* bound of each range (`maxContext`), while
 * pi's `inputTokensAbove` is where a tier starts, so tier i+1's threshold is
 * tier i's bound. The last upstream tier has no bound: it is the "and above"
 * range. The base rates must equal the first tier, which the page repeats, so
 * a divergence there means the shape moved.
 */
function costFromRow(row) {
  const source = `pricing row "${row.id}"`
  const base = ratesFrom(row, source)
  const upstreamTiers = row.contextTiers ?? []
  if (upstreamTiers.length > 0) {
    const first = ratesFrom(upstreamTiers[0], `${source} first tier`)
    for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
      if (Math.abs(first[field] - base[field]) > 1e-9) {
        throw new Error(`${source}: base ${field} ${base[field]} != first tier ${first[field]}`)
      }
    }
  }

  const tiers = []
  for (let i = 1; i < upstreamTiers.length; i++) {
    const threshold = upstreamTiers[i - 1].maxContext
    if (typeof threshold !== "number" || !(threshold > 0)) {
      throw new Error(`${source}: tier ${i} is missing a positive maxContext bound`)
    }
    tiers.push({
      inputTokensAbove: threshold,
      ...ratesFrom(upstreamTiers[i], `${source} tier ${i}`),
    })
  }

  const cost = { ...base }
  if (tiers.length > 0) cost.tiers = tiers
  return cost
}

/** The rate the page renders for a free model: one tier, all zeros. */
function isFreeRow(display) {
  return (
    display?.deal?.free === true ||
    (Array.isArray(display?.tiers) && display.tiers.every((tier) => tier?.rates?.input === 0 && tier?.rates?.output === 0))
  )
}

/** "> 272K" / "≤ 256K" -> 272000 / 256000, for cross-checking tier bounds. */
function thresholdFromLabel(context) {
  const match = /\d+(?:\.\d+)?\s*K/i.exec(context ?? "")
  return match ? Math.round(Number(match[0].replace(/[^\d.]/g, "")) * 1000) : undefined
}

/* --------------------------------------------------------------- rendering -- */

// Keep generated lines readable: a note that no longer fits goes on its own
// line above the row instead of stretching it.
const MAX_LINE = 100

function withNote(line, note) {
  if (!note) return line
  return line.length + note.length + 6 <= MAX_LINE ? `${line}  // ${note}` : `  // ${note}\n${line}`
}

function renderCost(row) {
  const inline = `{ input: ${String(row.cost.input)}, output: ${String(row.cost.output)}, ` +
    `cacheRead: ${String(row.cost.cacheRead)}, cacheWrite: ${String(row.cost.cacheWrite)} }`
  if (!row.cost.tiers) return withNote(`  ${JSON.stringify(row.id)}: ${inline},`, row.note)

  const lines = [
    `  ${JSON.stringify(row.id)}: {`,
    `    input: ${String(row.cost.input)},`,
    `    output: ${String(row.cost.output)},`,
    `    cacheRead: ${String(row.cost.cacheRead)},`,
    `    cacheWrite: ${String(row.cost.cacheWrite)},`,
    "    tiers: [",
  ]
  for (const tier of row.cost.tiers) {
    lines.push(
      `      { inputTokensAbove: ${tier.inputTokensAbove}, input: ${String(tier.input)}, ` +
        `output: ${String(tier.output)}, cacheRead: ${String(tier.cacheRead)}, ` +
        `cacheWrite: ${String(tier.cacheWrite)} },`,
    )
  }
  lines.push("    ],", "  },")
  return withNote(lines.join("\n"), row.note)
}

function renderTable({ verifiedOn, rows, freeIds, unpricedIds }) {
  const header = [
    "// Generated by `pnpm pricing:sync`. Do not edit by hand.",
    "//",
    "// Rates are USD per million tokens, parsed from the pricing page's embedded",
    "// payload and mapped onto the live catalog by model name. `inputTokensAbove`",
    "// is pi's request-wide input tier: the highest threshold exceeded by input +",
    "// cache reads + cache writes prices the whole request.",
    "//",
    "// Scope: the ids the provider catalog serves on the chat/messages endpoints.",
    "// Models billed on other surfaces (the decision API) are deliberately absent;",
    "// see OFF_CATALOG_PRICING in scripts/sync-pricing.mjs.",
    "//",
    `// Source:  ${PRICING_URL}`,
    `// Catalog: ${CATALOG_URL}`,
    `// Verified: ${verifiedOn}`,
    "",
    `export const PRICING_VERIFIED_ON = ${JSON.stringify(verifiedOn)}`,
    "",
    "/** Catalog ids the pricing page serves at no cost. */",
    "export const GENERATED_FREE_MODEL_IDS: readonly string[] = " +
      renderStringArray(freeIds),
    "",
    "/**",
    " * Catalog ids upstream lists without a pricing row. They fall back to $0 at",
    " * runtime and log a warning; the sync reports them so they get priced once",
    " * upstream publishes rates.",
    " */",
    "export const GENERATED_UNPRICED_MODEL_IDS: readonly string[] = " +
      renderStringArray(unpricedIds),
    "",
    "export const GENERATED_MODEL_COSTS = {",
    rows.map(renderCost).join("\n"),
    "} as const",
    "",
  ]
  return header.join("\n")
}

function renderStringArray(values) {
  if (values.length === 0) return "[]"
  return `[\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n]`
}

/* ------------------------------------------------------------------- build -- */

function buildTable({ catalog, costRows, displayRows }) {
  const pricing = indexRows(costRows, "pricing payload")
  const display = indexRows(displayRows, "pricing page")

  const rows = []
  const freeIds = []
  const unpricedIds = []
  const mismatches = []
  const zeroPriced = []

  for (const model of catalog) {
    const costRow = pricing.resolve(model)
    if (costRow) {
      const cost = costFromRow(costRow)
      const allZero = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(
        (rate) => rate === 0,
      )
      if (allZero) {
        // Free is a claim about the model, so the zero row is recorded as one
        // instead of quietly contradicting GENERATED_FREE_MODEL_IDS.
        freeIds.push(model.id)
        zeroPriced.push(model.id)
      }

      let note
      if (costRow.timeOfDay) {
        const { peak, windows } = costRow.timeOfDay
        const peakRate = peak
          ? ` (peak $${peak.inputCost}/$${peak.outputCost}${windows ? `, ${windows}` : ""})`
          : ""
        note = `off-peak rate; the page bills peak hours higher${peakRate}`
      }
      rows.push({ id: model.id, cost, note })

      // The rendered table repeats the tier bounds as labels; if they stop
      // agreeing with the payload, one of the two moved.
      const page = display.resolve(model)
      const upstreamTiers = costRow.contextTiers ?? []
      if (page && costRow.contextTiers && page.tiers.length === costRow.contextTiers.length) {
        for (let i = 1; i < page.tiers.length; i++) {
          const fromLabel = thresholdFromLabel(page.tiers[i - 1]?.context)
          const fromPayload = upstreamTiers[i - 1]?.maxContext
          if (fromLabel !== undefined && fromLabel !== fromPayload) {
            mismatches.push(
              `${model.id}: label bound ${fromLabel} != payload bound ${fromPayload}`,
            )
          }
        }
      }
      continue
    }

    if (isFreeRow(display.resolve(model))) {
      freeIds.push(model.id)
      rows.push({ id: model.id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
      continue
    }
    unpricedIds.push(model.id)
  }

  // Rows upstream prices that no catalog id claims: the decision API, retired
  // models, or a model we failed to map. Only the last kind is a problem, so
  // every off-catalog row must be registered to be skipped. A row a catalog
  // model resolved to is served by definition, so it can never show up here.
  const claimedRows = new Set(catalog.map((model) => pricing.resolve(model)).filter(Boolean))
  const offCatalog = costRows.filter((row) => !claimedRows.has(row))
  const registered = Object.entries(OFF_CATALOG_PRICING).map(([id, entry]) => ({ id, ...entry }))
  // An entry matches by exact name, or by `match` when it owns a family of rows.
  const findEntry = (name) =>
    registered.find((entry) =>
      entry.match ? entry.match.test(name.trim()) : normalizeName(entry.name) === normalizeName(name),
    )
  const known = []
  const unexplained = []
  const claimed = new Set()
  for (const row of offCatalog) {
    const entry = findEntry(row.name)
    if (!entry) {
      unexplained.push(`${row.id} (${row.name})`)
      continue
    }
    claimed.add(entry.id)
    known.push(`${row.id} — ${entry.reason}`)
  }
  const staleRegistry = registered
    .filter((entry) => !claimed.has(entry.id))
    .map((entry) => `${entry.id} — no longer priced upstream; drop it from OFF_CATALOG_PRICING`)

  rows.sort((left, right) => {
    const a = left.id.toLowerCase()
    const b = right.id.toLowerCase()
    return a < b ? -1 : a > b ? 1 : 0
  })

  return {
    rows,
    freeIds: freeIds.sort(),
    unpricedIds: unpricedIds.sort(),
    offCatalog: known.sort(),
    unexplained: unexplained.sort(),
    staleRegistry: staleRegistry.sort(),
    mismatches,
    zeroPriced: zeroPriced.sort(),
  }
}

/* -------------------------------------------------------------------- main -- */

async function main() {
  const [catalog, { costRows, displayRows }] = await Promise.all([
    fetchCatalog(),
    fetchPricingRows(),
  ])
  const built = buildTable({ catalog, costRows, displayRows })

  const snapshot = await readSnapshot()
  const liveIds = catalog.map((model) => model.id)
  const added = liveIds.filter((id) => !snapshot.modelIds.includes(id)).sort()
  const removed = snapshot.modelIds.filter((id) => !liveIds.includes(id)).sort()

  console.log(`catalog: ${liveIds.length} models (snapshot ${snapshot.modelIds.length})`)
  console.log(`pricing payload: ${costRows.length} cost rows, ${displayRows.length} display rows`)
  console.log(
    `table: ${built.rows.length} rows (${built.freeIds.length} free, ` +
      `${built.unpricedIds.length} unpriced, ${built.offCatalog.length} off-catalog)`,
  )
  console.log()

  report("added upstream", added)
  report("removed upstream", removed)
  report("catalog ids with no pricing row (fall back to $0 at runtime)", built.unpricedIds)
  report("priced upstream, off the chat catalog (registered, not in the table)", built.offCatalog)
  report("priced upstream, off the chat catalog, UNREGISTERED", built.unexplained)
  report("OFF_CATALOG_PRICING entries upstream no longer prices", built.staleRegistry)
  report("tier bounds whose label disagrees with the payload", built.mismatches)
  report("priced at zero upstream, recorded as free", built.zeroPriced)

  if (built.unexplained.length > 0 || built.staleRegistry.length > 0) {
    // Abort before comparing or writing: the table would be built on a guess.
    console.log("pricing table: not touched. Record the reason in OFF_CATALOG_PRICING")
    console.log(`(${fileURLToPath(import.meta.url)}) or price the model, then re-run.`)
    process.exitCode = 1
    return
  }

  if (built.unpricedIds.length > MAX_UNEXPLAINED_GAPS) {
    throw new Error(
      `${built.unpricedIds.length} catalog ids without a pricing row (> ${MAX_UNEXPLAINED_GAPS}); ` +
        "the page or the catalog has changed shape",
    )
  }

  // Today's UTC date: the day we last reconciled the table with upstream.
  const verifiedOn = new Date().toISOString().slice(0, 10)
  const text = renderTable({ verifiedOn, ...built })

  if (checkOnly) {
    const current = await readFile(TABLE_FILE, "utf8").catch(() => "")
    // The verification date is what a sync stamps, not a price: excluding it
    // keeps the check red for real drift instead of every new day.
    if (withoutVerificationDate(current) === withoutVerificationDate(text)) {
      const currentVerified = /PRICING_VERIFIED_ON = "([^"]+)"/.exec(current)?.[1] ?? "unknown"
      console.log(`pricing table is up to date with upstream (verified ${currentVerified}).`)
      return
    }
    const currentVerified = /PRICING_VERIFIED_ON = "([^"]+)"/.exec(current)?.[1] ?? "unknown"
    console.log(`pricing table is stale (verified ${currentVerified}, upstream parsed ${verifiedOn}).`)
    console.log()
    const onDisk = rowSignatures(current)
    const upstream = rowSignatures(text)
    report(
      "rows whose rates changed upstream",
      [...upstream].filter(([id, value]) => onDisk.has(id) && onDisk.get(id) !== value).map(([id]) => id).sort(),
    )
    report("rows upstream added", [...upstream.keys()].filter((id) => !onDisk.has(id)).sort())
    report("rows upstream dropped", [...onDisk.keys()].filter((id) => !upstream.has(id)).sort())
    console.log("run `pnpm pricing:sync` and review the diff.")
    process.exitCode = 1
    return
  }

  await writeFile(TABLE_FILE, text)
  console.log(`wrote ${fileURLToPath(TABLE_FILE)}`)
  await writeSnapshot(liveIds)
  console.log(`wrote ${fileURLToPath(IDS_SNAPSHOT)}`)
  console.log("\nreview `git diff` before committing: rates are upstream's, not ours.")
}

async function readSnapshot() {
  try {
    const snapshot = JSON.parse(await readFile(IDS_SNAPSHOT, "utf8"))
    return { modelIds: Array.isArray(snapshot.modelIds) ? snapshot.modelIds : [] }
  } catch {
    return { modelIds: [] }
  }
}

async function writeSnapshot(modelIds) {
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    source: CATALOG_URL,
    modelIds: [...modelIds].sort(),
  }
  await writeFile(IDS_SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`)
}

/** `id -> rendered row` for a generated table, whitespace-normalized. */
function rowSignatures(text) {
  const rows = new Map()
  for (const match of text.matchAll(/^ {2}"([^"]+)": /gm)) {
    const valueStart = match.index + match[0].length
    const end =
      text[valueStart] === "{"
        ? matchingBracket(text, valueStart, "{", "}") + 1
        : text.indexOf("\n", valueStart)
    rows.set(match[1], text.slice(valueStart, end === -1 ? undefined : end).replace(/\s+/g, " "))
  }
  return rows
}

/** Drop the generated date so `--check` compares prices, not the calendar. */
function withoutVerificationDate(text) {
  return text
    .split("\n")
    .filter((line) => !/^\/\/ Verified: /.test(line) && !/^export const PRICING_VERIFIED_ON/.test(line))
    .join("\n")
}

function report(label, items) {
  console.log(items.length ? `${label}:` : `${label}: none`)
  for (const item of items) console.log(`  ${item}`)
  console.log()
}

await main()
