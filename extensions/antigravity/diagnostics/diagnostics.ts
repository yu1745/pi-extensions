import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecrets } from "../utils/security.js";

export type DiagnosticsSnapshot = {
  status?: number;
  endpoint?: string;
  error?: string;
  projectId?: string;
  resolvedRuntimeModel?: string;
  /**
   * `modelVersion` from the backend response: the model that actually answered.
   * Distinct from `resolvedRuntimeModel`, which is only the routing label we sent.
   */
  servedModel?: string;
  /** Served id whose rates were applied; `*` suffix means a family fallback matched. */
  pricedByModel?: string;
  /** True when the served id had no entry and the requested model's rates were kept. */
  costBasisUnknown?: boolean;
  responseId?: string;
  availableModels?: string;
  matchedModelDebug?: string;
  latencyMs?: number;
  maskedEmail?: string;
  tokenExpiry?: string;
};

const storage = new AsyncLocalStorage<DiagnosticsSnapshot>();

/** Last completed request snapshot for `/antigravity.doctor`. */
let lastSnapshot: DiagnosticsSnapshot = {};

function currentBag(): DiagnosticsSnapshot {
  return storage.getStore() ?? lastSnapshot;
}

/** Run work with an isolated diagnostics bag; commits it to `lastSnapshot` when done. */
export async function runWithDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  const bag: DiagnosticsSnapshot = {};
  return storage.run(bag, async () => {
    try {
      return await fn();
    } finally {
      lastSnapshot = { ...bag };
    }
  });
}

export function getLastDiagnostics(): Readonly<DiagnosticsSnapshot> {
  return lastSnapshot;
}

/** Read endpoint from the active request bag (or last snapshot outside a request). */
export function getCurrentEndpoint(): string | undefined {
  return currentBag().endpoint;
}

export function getCurrentMatchedModelDebug(): string | undefined {
  return currentBag().matchedModelDebug;
}

export function getCurrentAvailableModels(): string | undefined {
  return currentBag().availableModels;
}

export function setLastStatus(status: number | undefined): void {
  currentBag().status = status;
}
export function setLastEndpoint(endpoint: string | undefined): void {
  currentBag().endpoint = endpoint;
}
export function setLastError(error: string | undefined): void {
  currentBag().error = error === undefined ? undefined : redactSecrets(error).slice(0, 800);
}
export function setLastProjectId(projectId: string | undefined): void {
  currentBag().projectId = projectId;
}
export function setLastResolvedRuntimeModel(model: string | undefined): void {
  currentBag().resolvedRuntimeModel = model;
}
export function setLastServedModel(model: string | undefined): void {
  currentBag().servedModel = model;
}
/** Record which served model supplied the rates for the last priced response. */
export function setLastCostBasis(pricedBy: string | undefined, unknownServedModel: boolean): void {
  currentBag().pricedByModel = pricedBy;
  currentBag().costBasisUnknown = unknownServedModel;
}
export function setLastResponseId(id: string | undefined): void {
  currentBag().responseId = id;
}
export function setLastAvailableModels(models: string | undefined): void {
  currentBag().availableModels = models;
}
export function setLastMatchedModelDebug(debug: string | undefined): void {
  currentBag().matchedModelDebug =
    debug === undefined ? undefined : redactSecrets(debug).slice(0, 1200);
}
export function setLastLatencyMs(ms: number | undefined): void {
  currentBag().latencyMs = ms;
}
export function setLastMaskedEmail(email: string | undefined): void {
  currentBag().maskedEmail = email;
}
export function setLastTokenExpiry(expiry: string | undefined): void {
  currentBag().tokenExpiry = expiry;
}

/** Test helper: reset last snapshot between cases. */
export function resetDiagnosticsForTests(): void {
  lastSnapshot = {};
}
