export const JEV_PROVIDER_ID = "typesafe-jev"
export const JEV_SERVICE_REQUEST_EVENT = "typesafe-jev:get-service:v1"
export const JEV_SERVICE_VERSION = 1 as const

export type JevJson =
  | null
  | boolean
  | number
  | string
  | JevJson[]
  | { [key: string]: JevJson }

export interface JevNoulQuestion {
  type: "noul"
  instructions: JevJson
  criteria?: { true?: JevJson; false?: JevJson }
}

export interface JevChoiceQuestion {
  type: "choice"
  instructions: JevJson
  criteria: Record<string, JevJson>
}

export interface JevScoreQuestion {
  type: "score"
  instructions: JevJson
  criteria: JevJson[]
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion

export interface JevEvaluateRequest {
  state: JevJson
  questions: Record<string, JevQuestion>
  model?: string
}

export interface JevNoulAnswer {
  type: "noul"
  noul: number
}

export interface JevChoiceAnswer {
  type: "choice"
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export interface JevScoreAnswer {
  type: "score"
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer

export interface JevEvaluateResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

export interface JevEvaluateOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface JevServiceV1 {
  readonly version: typeof JEV_SERVICE_VERSION
  evaluate(request: JevEvaluateRequest, options?: JevEvaluateOptions): Promise<JevEvaluateResponse>
}

export interface JevServiceRequest {
  accept(service: JevServiceV1): void
}
