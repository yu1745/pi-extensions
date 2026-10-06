import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"

/**
 * Manual reasoning-effort policy for models the official CLI marks as
 * reasoning-capable without publishing selectable efforts.
 *
 * `src/commandcode-catalog.ts` is generated from the CLI package and must stay
 * byte-identical to upstream so the daily drift check works. Entries here are
 * merged over the generated catalog at load time and are not touched by
 * `npm run sync:commandcode-catalog`.
 *
 * Add a model only when the effort parameter is known to be accepted by the
 * Command Code endpoint; remove it once the CLI catalog ships its own efforts.
 */
export const MODEL_EFFORT_OVERRIDES: Readonly<
  Record<string, readonly CommandCodeReasoningEffort[]>
> = {
  // Meta Muse Spark: the CLI ships no effort levels, but the endpoint accepts
  // `reasoning_effort` for these models and other hosts expose the same set.
  "meta/muse-spark-1.1": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2-contributor": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3-contributor": ["minimal", "low", "medium", "high", "xhigh"],

  // GLM-5.3 FlashX: same effort set as `z-ai/glm-5.3-flash`. The v1.44.0 CLI
  // catalog predates the FlashX listing entirely, but the Command Code
  // endpoint accepts `reasoning_effort` for it — same family, same parameter.
  // Needs the paired MODEL_REASONING_OVERRIDES entry below: the test suite
  // requires every efforts entry to carry a reasoning flag. Remove both once
  // the CLI catalog ships its own entry.
  "z-ai/glm-5.3-flashx": ["low", "high", "max"],
}

/**
 * Manual reasoning flags for models the generated catalog does not list at
 * all (newer than the synced CLI version). Merged over the catalog's
 * MODEL_REASONING at load time; not touched by the sync script.
 */
export const MODEL_REASONING_OVERRIDES: Readonly<Record<string, true>> = {
  "z-ai/glm-5.3-flashx": true,
}
