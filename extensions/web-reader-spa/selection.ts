export const MIN_SCOPE_TEXT = 200;
export const MIN_ARIA_COVERAGE = 0.2;

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
 * A narrow scope is useful only when it retains a meaningful share of the full
 * accessibility tree. Low coverage is a strong signal that a card, review, or
 * first feed item was mistaken for the whole page.
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
