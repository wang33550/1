import { AnthropicAdapter } from "./adapters/anthropic";
import { OpenAIAdapter } from "./adapters/openai";
import { buildStrategyContext, type StrategyName } from "./evals/runner";
import type { CoverageMetric, EvalDataset, EvalScenario } from "./evals/types";
import type { ModelAdapter, ProviderName } from "./types";
import { estimateTokensFromText, normalizeWhitespace, nowIso } from "./utils";

export interface LiveReplayScenarioResult {
  strategy: StrategyName;
  scenarioId: string;
  description: string;
  inputTokenEstimate: number;
  outputTokenEstimate: number;
  nextActionCovered: boolean;
  constraintCoverage: CoverageMetric;
  artifactCoverage: CoverageMetric;
  duplicateProtectionCoverage: CoverageMetric;
  sideEffectBlockCoverage: CoverageMetric;
  notes: string[];
  responseText: string;
}

export interface LiveReplayAggregateResult {
  strategy: StrategyName;
  scenarioCount: number;
  nextActionCoverage: CoverageMetric;
  constraintCoverage: CoverageMetric;
  artifactCoverage: CoverageMetric;
  duplicateProtectionCoverage: CoverageMetric;
  sideEffectBlockCoverage: CoverageMetric;
  averageInputTokens: number;
  averageOutputTokens: number;
}

export interface LiveReplayReport {
  datasetName: string;
  generatedAt: string;
  provider: ProviderName | "custom";
  model: string;
  instruction: string;
  strategies: LiveReplayAggregateResult[];
  scenarios: Record<string, LiveReplayScenarioResult[]>;
}

export interface LiveReplayOptions {
  provider?: ProviderName;
  model: string;
  adapter?: ModelAdapter;
  strategies?: StrategyName[];
  instruction?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

const DEFAULT_INSTRUCTION = [
  "Recover the task from the provided context compaction input.",
  "Return strict JSON with keys nextAction, constraints, and artifacts.",
  "nextAction must be a string.",
  "constraints and artifacts must be arrays of short strings.",
  "Only include information supported by the provided context."
].join(" ");

function coverageForStrings(expected: string[] | undefined, haystack: string): CoverageMetric {
  const values = expected ?? [];
  const normalizedHaystack = normalizeWhitespace(haystack).toLowerCase();
  const hits = values.filter((item) =>
    normalizedHaystack.includes(normalizeWhitespace(item).toLowerCase())
  ).length;
  return {
    hits,
    total: values.length,
    ratio: values.length === 0 ? 1 : hits / values.length
  };
}

function ratioMetric(hits: number, total: number): CoverageMetric {
  return {
    hits,
    total,
    ratio: total === 0 ? 1 : hits / total
  };
}

function aggregate(
  strategy: StrategyName,
  results: LiveReplayScenarioResult[]
): LiveReplayAggregateResult {
  const scenarioCount = results.length;
  const nextActionHits = results.filter((item) => item.nextActionCovered).length;
  const sumCoverage = (selector: (item: LiveReplayScenarioResult) => CoverageMetric): CoverageMetric => {
    const aggregateHits = results.reduce((sum, item) => sum + selector(item).hits, 0);
    const aggregateTotal = results.reduce((sum, item) => sum + selector(item).total, 0);
    return ratioMetric(aggregateHits, aggregateTotal);
  };

  return {
    strategy,
    scenarioCount,
    nextActionCoverage: ratioMetric(nextActionHits, scenarioCount),
    constraintCoverage: sumCoverage((item) => item.constraintCoverage),
    artifactCoverage: sumCoverage((item) => item.artifactCoverage),
    duplicateProtectionCoverage: sumCoverage((item) => item.duplicateProtectionCoverage),
    sideEffectBlockCoverage: sumCoverage((item) => item.sideEffectBlockCoverage),
    averageInputTokens:
      results.reduce((sum, item) => sum + item.inputTokenEstimate, 0) / Math.max(1, scenarioCount),
    averageOutputTokens:
      results.reduce((sum, item) => sum + item.outputTokenEstimate, 0) / Math.max(1, scenarioCount)
  };
}

function createAdapter(provider: ProviderName): ModelAdapter {
  if (provider === "openai") {
    return new OpenAIAdapter();
  }
  if (provider === "anthropic") {
    return new AnthropicAdapter();
  }
  throw new Error("live replay requires provider openai or anthropic unless a custom adapter is passed");
}

async function replayScenario(
  adapter: ModelAdapter,
  strategy: StrategyName,
  scenario: EvalScenario,
  options: LiveReplayOptions,
  instruction: string
): Promise<LiveReplayScenarioResult> {
  const context = buildStrategyContext(strategy, scenario);
  const result = await adapter.sendTurn({
    model: options.model,
    systemPrompt: instruction,
    runtimePacket: context.visibleContext,
    userInput: "Recover the task state from this context compaction input.",
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature
  });

  const normalizedOutput = normalizeWhitespace(result.text);
  const expectedNextAction = scenario.expected.nextAction;
  const nextActionCovered =
    expectedNextAction === undefined
      ? true
      : normalizedOutput.toLowerCase().includes(normalizeWhitespace(expectedNextAction).toLowerCase());
  const constraintCoverage = coverageForStrings(
    scenario.expected.requiredConstraints,
    result.text
  );
  const artifactCoverage = coverageForStrings(
    scenario.expected.requiredArtifacts,
    result.text
  );
  const notes: string[] = [];
  if (!nextActionCovered && expectedNextAction) {
    notes.push(`missing next action: ${expectedNextAction}`);
  }
  if (constraintCoverage.hits < constraintCoverage.total) {
    notes.push("missing one or more constraints");
  }
  if (artifactCoverage.hits < artifactCoverage.total) {
    notes.push("missing one or more artifacts");
  }

  return {
    strategy,
    scenarioId: scenario.id,
    description: scenario.description,
    inputTokenEstimate: estimateTokensFromText(context.visibleContext),
    outputTokenEstimate: estimateTokensFromText(result.text),
    nextActionCovered,
    constraintCoverage,
    artifactCoverage,
    duplicateProtectionCoverage: context.duplicateProtection,
    sideEffectBlockCoverage: context.sideEffectBlocks,
    notes,
    responseText: result.text
  };
}

export async function runLiveReplay(
  dataset: EvalDataset,
  options: LiveReplayOptions
): Promise<LiveReplayReport> {
  const strategies = options.strategies?.length
    ? options.strategies
    : (["full_history", "simple_summary", "runtime"] satisfies StrategyName[]);
  const adapter = options.adapter ?? createAdapter(options.provider ?? "custom");
  const instruction = options.instruction ?? DEFAULT_INSTRUCTION;
  const scenarioMap: Record<string, LiveReplayScenarioResult[]> = {};
  const perStrategy = new Map<StrategyName, LiveReplayScenarioResult[]>();

  for (const strategy of strategies) {
    perStrategy.set(strategy, []);
  }

  for (const scenario of dataset.scenarios) {
    const scenarioResults: LiveReplayScenarioResult[] = [];
    scenarioMap[scenario.id] = scenarioResults;
    for (const strategy of strategies) {
      const result = await replayScenario(adapter, strategy, scenario, options, instruction);
      scenarioResults.push(result);
      perStrategy.get(strategy)!.push(result);
    }
  }

  return {
    datasetName: dataset.name,
    generatedAt: nowIso(),
    provider: options.provider ?? "custom",
    model: options.model,
    instruction,
    strategies: strategies.map((strategy) => aggregate(strategy, perStrategy.get(strategy)!)),
    scenarios: scenarioMap
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderLiveReplayMarkdown(report: LiveReplayReport): string {
  const lines: string[] = [];
  lines.push(`# Live Replay Results`);
  lines.push(``);
  lines.push(`Dataset: \`${report.datasetName}\``);
  lines.push(`Provider: \`${report.provider}\``);
  lines.push(`Model: \`${report.model}\``);
  lines.push(`Generated: \`${report.generatedAt}\``);
  lines.push(``);
  lines.push(`## Aggregate`);
  lines.push(``);
  lines.push(`| Strategy | Next Action | Constraint Coverage | Artifact Coverage | Duplicate Protection | Side-effect Blocks | Avg Input Tokens | Avg Output Tokens |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const result of report.strategies) {
    lines.push(
      `| ${result.strategy} | ${percent(result.nextActionCoverage.ratio)} | ${percent(
        result.constraintCoverage.ratio
      )} | ${percent(result.artifactCoverage.ratio)} | ${percent(
        result.duplicateProtectionCoverage.ratio
      )} | ${percent(result.sideEffectBlockCoverage.ratio)} | ${result.averageInputTokens.toFixed(
        1
      )} | ${result.averageOutputTokens.toFixed(1)} |`
    );
  }

  for (const [scenarioId, results] of Object.entries(report.scenarios)) {
    lines.push(``);
    lines.push(`## Scenario: ${scenarioId}`);
    lines.push(``);
    lines.push(`| Strategy | Next Action | Constraint Coverage | Artifact Coverage | Duplicate Protection | Side-effect Blocks | Input Tokens | Output Tokens | Notes |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const result of results) {
      lines.push(
        `| ${result.strategy} | ${result.nextActionCovered ? "yes" : "no"} | ${percent(
          result.constraintCoverage.ratio
        )} | ${percent(result.artifactCoverage.ratio)} | ${percent(
          result.duplicateProtectionCoverage.ratio
        )} | ${percent(result.sideEffectBlockCoverage.ratio)} | ${result.inputTokenEstimate} | ${result.outputTokenEstimate} | ${result.notes.join("; ") || "-"} |`
      );
    }
  }

  return lines.join("\n");
}
