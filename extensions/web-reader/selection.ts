export const MIN_SCOPE_TEXT = 200;
export const MIN_ARIA_COVERAGE = 0.9;

export interface ScopeCandidate {
  selector: string;
  index: number;
  textLength: number;
  priority: number;
  substantiveMatches?: number;
}

export interface ScopeDecision {
  candidate?: ScopeCandidate;
  coverage?: number;
  useScoped: boolean;
  reason:
    | "no-candidate"
    | "scoped"
    | "empty-scoped"
    | "low-coverage"
    | "multiple-substantive-matches"
    | "full-unavailable";
}

/** Prefer the broadest substantive candidate, not the first matching DOM node. */
export function chooseScopeCandidate(candidates: ScopeCandidate[]): ScopeCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.textLength > MIN_SCOPE_TEXT)
    .sort((a, b) => b.textLength - a.textLength || a.priority - b.priority || a.index - b.index)[0];
}

function ariaSize(aria: string): number {
  return aria.replace(/\s+/g, " ").trim().length;
}

/**
 * A narrow scope is accepted only when it keeps nearly all of the full accessibility tree.
 * Narrowing to a container that holds only part of the page loses content (forum replies
 * outside <article>, product details outside <main>), and extra text costs less than missing
 * text. The 90% threshold comes from measurements on the WCXB content-extraction benchmark.
 */
export function decideAriaScope(
  fullAria: string,
  scopedAria: string,
  candidate?: ScopeCandidate,
): ScopeDecision {
  if (!candidate) return { useScoped: false, reason: "no-candidate" };

  const scopedSize = ariaSize(scopedAria);
  if (scopedSize === 0) return { candidate, useScoped: false, reason: "empty-scoped" };

  // Repeated articles usually represent feed items, reviews, cards, or sibling data
  // sections. Selecting any single one is inherently lossy even if it happens to be large.
  if (candidate.selector.includes("article") && (candidate.substantiveMatches ?? 1) > 1) {
    return { candidate, useScoped: false, reason: "multiple-substantive-matches" };
  }

  const fullSize = ariaSize(fullAria);
  if (fullSize === 0) return { candidate, useScoped: true, reason: "full-unavailable" };

  const coverage = scopedSize / fullSize;
  if (coverage < MIN_ARIA_COVERAGE) {
    return { candidate, coverage, useScoped: false, reason: "low-coverage" };
  }
  return { candidate, coverage, useScoped: true, reason: "scoped" };
}
