import type { EventKind, JsonObject, ProposedAction } from "../types";

export interface EvalEventInput {
  kind: EventKind;
  payload: JsonObject;
  spanId?: string;
  parentSpanId?: string;
  ts?: string;
  id?: string;
}

export interface EvalExpectation {
  nextAction?: string;
  requiredConstraints?: string[];
  requiredArtifacts?: string[];
  candidateActions?: ProposedAction[];
  sideEffectActions?: ProposedAction[];
}

export interface EvalScenario {
  id: string;
  description: string;
  minTailEvents?: number;
  events: EvalEventInput[];
  expected: EvalExpectation;
}

export interface EvalDataset {
  name: string;
  description?: string;
  scenarios: EvalScenario[];
}

export interface CoverageMetric {
  hits: number;
  total: number;
  ratio: number;
}

export interface StrategyScenarioResult {
  strategy: string;
  scenarioId: string;
  description: string;
  inputTokenEstimate: number;
  nextActionCovered: boolean;
  constraintCoverage: CoverageMetric;
  artifactCoverage: CoverageMetric;
  duplicateProtectionCoverage: CoverageMetric;
  sideEffectBlockCoverage: CoverageMetric;
  visibleContextPreview: string;
  notes: string[];
}

export interface StrategyAggregateResult {
  strategy: string;
  scenarioCount: number;
  nextActionCoverage: CoverageMetric;
  constraintCoverage: CoverageMetric;
  artifactCoverage: CoverageMetric;
  duplicateProtectionCoverage: CoverageMetric;
  sideEffectBlockCoverage: CoverageMetric;
  averageInputTokens: number;
  tokenSavingsVsFullHistory: number;
}

export interface EvalReport {
  datasetName: string;
  datasetDescription?: string;
  generatedAt: string;
  scenarioCount: number;
  strategies: StrategyAggregateResult[];
  scenarios: Record<string, StrategyScenarioResult[]>;
}
