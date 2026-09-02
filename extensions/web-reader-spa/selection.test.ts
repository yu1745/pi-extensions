import assert from "node:assert/strict";
import test from "node:test";
import { chooseScopeCandidate, decideAriaScope } from "./selection.js";

test("chooses the broadest substantive candidate instead of the first selector", () => {
  const selected = chooseScopeCandidate([
    { selector: "main article", index: 0, textLength: 246, priority: 8 },
    { selector: "main", index: 0, textLength: 3478, priority: 1 },
    { selector: "article", index: 3, textLength: 900, priority: 11 },
  ]);
  assert.equal(selected?.selector, "main");
});

test("examines every match and can choose a later, larger element", () => {
  const selected = chooseScopeCandidate([
    { selector: "article", index: 0, textLength: 300, priority: 11 },
    { selector: "article", index: 1, textLength: 1800, priority: 11 },
  ]);
  assert.equal(selected?.index, 1);
});

test("rejects a scope that keeps only a small fraction of the full ARIA tree", () => {
  const candidate = { selector: "article", index: 0, textLength: 700, priority: 11 };
  const decision = decideAriaScope("x".repeat(10_000), "x".repeat(1_000), candidate);
  assert.equal(decision.useScoped, false);
  assert.equal(decision.reason, "low-coverage");
});

test("rejects choosing one article when several substantive articles exist", () => {
  const candidate = {
    selector: "article",
    index: 1,
    textLength: 5000,
    priority: 11,
    substantiveMatches: 2,
  };
  const decision = decideAriaScope("x".repeat(10_000), "x".repeat(6_000), candidate);
  assert.equal(decision.useScoped, false);
  assert.equal(decision.reason, "multiple-substantive-matches");
});

test("accepts a sufficiently complete scope", () => {
  const candidate = { selector: "main", index: 0, textLength: 5000, priority: 1 };
  const decision = decideAriaScope("x".repeat(10_000), "x".repeat(6_000), candidate);
  assert.equal(decision.useScoped, true);
  assert.equal(decision.reason, "scoped");
});

test("falls back to full page when there is no candidate", () => {
  assert.deepEqual(decideAriaScope("full", "", undefined), {
    useScoped: false,
    reason: "no-candidate",
  });
});
