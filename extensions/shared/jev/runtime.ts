import type { ClassifierContext, ClassifierResult, Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface JevEvaluateOptions { signal?: AbortSignal; timeoutMs?: number }
export interface JevClassifier {
  evaluate(request: ClassifierContext, options?: JevEvaluateOptions): Promise<ClassifierResult>;
}
export type JevContext = {
  modelRegistry: Pick<ExtensionContext['modelRegistry'], 'findOfType' | 'classify'>;
  signal?: AbortSignal;
};

function probability(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error('Invalid Jev probability');
}

function validate(result: ClassifierResult, request: ClassifierContext): void {
  if (result.stopReason === 'aborted') throw new DOMException('Jev request aborted', 'AbortError');
  if (result.stopReason !== 'stop') throw new Error(result.errorMessage || 'Jev classification failed');
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = result.answers?.[id];
    if (!answer || answer.type !== question.type) throw new Error(`Missing or invalid Jev answer: ${id}`);
    if (answer.type === 'bool') probability(answer.probability);
    else {
      probability(answer.confidence);
      if (answer.type === 'choice' && question.type === 'choice') {
        if (!Object.hasOwn(question.criteria, answer.choice)) throw new Error(`Invalid Jev choice: ${id}`);
        const values = answer.probabilities;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid Jev probabilities: ${id}`);
        for (const [label, value] of Object.entries(values)) {
          if (!Object.hasOwn(question.criteria, label)) throw new Error(`Invalid Jev probability label: ${id}`);
          probability(value);
        }
        if (!Object.hasOwn(values, answer.choice)) throw new Error(`Missing Jev choice probability: ${id}`);
      } else if (answer.type === 'score' && question.type === 'score') {
        if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1)
          throw new Error(`Invalid Jev score: ${id}`);
      }
    }
  }
}

/** Pi owns authentication, transport and bool-to-System-One mapping. No global session slot. */
export function createJevClassifier(ctx: JevContext, onUsage?: (usage: Usage) => void): JevClassifier {
  return {
    async evaluate(request, options = {}) {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...[ctx.signal, options.signal].filter((s): s is AbortSignal => !!s)]);
      signal.throwIfAborted();
      const model = ctx.modelRegistry.findOfType('classifier', 'typesafe', 'jev-latest');
      if (!model) throw new Error('Classifier typesafe/jev-latest is unavailable');
      const timer = setTimeout(() => controller.abort(new DOMException('Jev request timed out', 'TimeoutError')), options.timeoutMs ?? 20_000);
      let abort!: () => void;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        const result = await Promise.race([
          ctx.modelRegistry.classify(model, request, { signal, maxRetries: 0 }),
          cancelled,
        ]);
        // Billable usage also survives provider errors and malformed answers. Missing usage is unknown, not zero.
        if (result.usage) onUsage?.(result.usage);
        signal.throwIfAborted();
        validate(result, request);
        return result;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

/** Each tool execution owns one accumulator; SDK usage includes catalog costs (never estimated here). */
export function createJevUsageAccumulator() {
  let usage: Usage | undefined;
  return {
    get usage() { return usage; },
    add(next: Usage) {
      if (!usage) { usage = { ...next, cost: { ...next.cost } }; return; }
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) usage[key] += next[key];
      for (const key of ['cacheWrite1h', 'reasoning'] as const)
        if (usage[key] !== undefined || next[key] !== undefined) usage[key] = (usage[key] ?? 0) + (next[key] ?? 0);
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) usage.cost[key] += next.cost[key];
    },
  };
}
