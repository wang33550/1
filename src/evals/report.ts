import type { TraceCorpusLoadResult } from "./corpus";
import type { CoverageMetric, EvalReport, StrategyAggregateResult, StrategyScenarioResult } from "./types";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCoverage(metric: CoverageMetric): string {
  if (metric.total === 0) return "n/a";
  return `${percent(metric.ratio)} (${metric.hits}/${metric.total})`;
}

function formatAggregateRow(result: StrategyAggregateResult): string {
  return `| ${result.strategy} | ${formatCoverage(result.nextActionCoverage)} | ${formatCoverage(result.constraintCoverage)} | ${formatCoverage(result.artifactCoverage)} | ${formatCoverage(result.duplicateProtectionCoverage)} | ${formatCoverage(result.sideEffectBlockCoverage)} | ${result.averageInputTokens.toFixed(1)} | ${percent(result.tokenSavingsVsFullHistory)} |`;
}

function formatScenarioRows(results: StrategyScenarioResult[]): string[] {
  return results.map(
    (result) =>
      `| ${result.strategy} | ${result.nextActionCovered ? "yes" : "no"} | ${formatCoverage(
        result.constraintCoverage
      )} | ${formatCoverage(result.artifactCoverage)} | ${formatCoverage(
        result.duplicateProtectionCoverage
      )} | ${formatCoverage(result.sideEffectBlockCoverage)} | ${result.inputTokenEstimate} | ${result.notes.join("; ") || "-"} |`
  );
}

export function renderEvalMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Benchmark Results`);
  lines.push(``);
  lines.push(`Dataset: \`${report.datasetName}\``);
  lines.push(`Generated: \`${report.generatedAt}\``);
  lines.push(`Scenarios: \`${report.scenarioCount}\``);
  if (report.datasetDescription) {
    lines.push(`Description: ${report.datasetDescription}`);
  }
  lines.push(``);
  lines.push(`## Aggregate`);
  lines.push(``);
  lines.push(`| Strategy | Next Action | Constraint Coverage | Artifact Coverage | Duplicate Protection | Side-effect Blocks | Avg Tokens | Savings vs Full History |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const result of report.strategies) {
    lines.push(formatAggregateRow(result));
  }

  for (const [scenarioId, results] of Object.entries(report.scenarios)) {
    lines.push(``);
    lines.push(`## Scenario: ${scenarioId}`);
    lines.push(``);
    lines.push(`| Strategy | Next Action | Constraint Coverage | Artifact Coverage | Duplicate Protection | Side-effect Blocks | Input Tokens | Notes |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    lines.push(...formatScenarioRows(results));
  }

  lines.push(``);
  lines.push(`## Interpretation`);
  lines.push(``);
  lines.push(`- \`full_history\` is the high-context oracle for visibility, but it has no execution guard.`);
  lines.push(`- \`simple_summary\` is a naive compaction baseline that preserves objective and recent tail only.`);
  lines.push(`- \`runtime\` is Task Recovery Runtime with checkpoint, frontier hints, artifacts, and repeat guard.`);
  lines.push(`- Duplicate protection and side-effect blocks are runtime-level enforcement metrics, not model-behavior guesses.`);
  return lines.join("\n");
}

function formatDistribution(values: Record<string, number>): string {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `\`${key}\`: ${value}`).join(", ");
}

function formatOptionalFilter(name: string, value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return `- ${name}: ${value}`;
}

export function renderTraceCorpusEvalMarkdown(
  corpus: TraceCorpusLoadResult,
  report: EvalReport
): string {
  const lines: string[] = [];
  lines.push(`# Trace Corpus Evaluation`);
  lines.push(``);
  lines.push(`Corpus: \`${corpus.summary.directory}\``);
  lines.push(`Generated: \`${report.generatedAt}\``);
  lines.push(`Manifest: \`${corpus.summary.manifestFound ? "yes" : "no"}\``);
  lines.push(`Trace Files: \`${corpus.summary.totalTraceFiles}\``);
  lines.push(`Valid Traces: \`${corpus.summary.validTraceFiles}\``);
  lines.push(`With Expected: \`${corpus.summary.tracesWithExpected}\``);
  lines.push(`With Next Action: \`${corpus.summary.tracesWithNextAction}\``);
  lines.push(`Included Scenarios: \`${corpus.summary.includedCount}\``);
  lines.push(`Skipped: \`${corpus.summary.skippedCount}\``);
  lines.push(`Average Included Events: \`${corpus.summary.averageIncludedEventCount.toFixed(1)}\``);
  lines.push(
    `Average Included User Messages: \`${corpus.summary.averageIncludedUserMessageCount.toFixed(1)}\``
  );
  lines.push(``);
  lines.push(`## Filters`);
  lines.push(``);
  const filterLines = [
    formatOptionalFilter("minEvents", corpus.summary.filters.minEvents),
    formatOptionalFilter("minUserMessages", corpus.summary.filters.minUserMessages),
    `- requireExpected: ${corpus.summary.filters.requireExpected ? "yes" : "no"}`,
    `- requireNextAction: ${corpus.summary.filters.requireNextAction ? "yes" : "no"}`,
    formatOptionalFilter("hosts", corpus.summary.filters.hosts?.join(",")),
    formatOptionalFilter("qualities", corpus.summary.filters.qualities?.join(",")),
    formatOptionalFilter("maxScenarios", corpus.summary.filters.maxScenarios)
  ].filter((line): line is string => Boolean(line));
  filterLines.forEach((line) => lines.push(line));
  lines.push(``);
  lines.push(`## Included Mix`);
  lines.push(``);
  lines.push(`- hosts: ${formatDistribution(corpus.summary.includedByHost)}`);
  lines.push(`- qualities: ${formatDistribution(corpus.summary.includedByQuality)}`);
  lines.push(``);
  lines.push(`## Skips`);
  lines.push(``);
  lines.push(`- reasons: ${formatDistribution(corpus.summary.skippedByReason)}`);

  const evalLines = renderEvalMarkdown(report).split("\n");
  const aggregateIndex = evalLines.findIndex((line) => line === "## Aggregate");
  lines.push(``);
  lines.push(`## Recovery Results`);
  lines.push(``);
  lines.push(...(aggregateIndex >= 0 ? evalLines.slice(aggregateIndex) : evalLines));

  return lines.join("\n");
}
