import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadEvalDataset } from "../src/evals/dataset";
import { runEval } from "../src/evals/runner";

const datasetPath = path.resolve(__dirname, "../benchmarks/recovery-benchmark.json");

describe("recovery benchmark", () => {
  test("runtime outperforms naive compaction on recovery and duplicate protection", () => {
    const dataset = loadEvalDataset(datasetPath);
    const report = runEval(dataset);

    const aggregate = new Map(report.strategies.map((item) => [item.strategy, item]));
    const fullHistory = aggregate.get("full_history");
    const simpleSummary = aggregate.get("simple_summary");
    const runtime = aggregate.get("runtime");

    expect(fullHistory).toBeDefined();
    expect(simpleSummary).toBeDefined();
    expect(runtime).toBeDefined();

    expect(runtime!.nextActionCoverage.ratio).toBe(1);
    expect(runtime!.constraintCoverage.ratio).toBe(1);
    expect(runtime!.artifactCoverage.ratio).toBe(1);
    expect(runtime!.duplicateProtectionCoverage.ratio).toBe(1);
    expect(runtime!.sideEffectBlockCoverage.ratio).toBe(1);

    expect(runtime!.nextActionCoverage.ratio).toBeGreaterThan(simpleSummary!.nextActionCoverage.ratio);
    expect(runtime!.constraintCoverage.ratio).toBeGreaterThan(simpleSummary!.constraintCoverage.ratio);
    expect(runtime!.duplicateProtectionCoverage.ratio).toBeGreaterThan(
      simpleSummary!.duplicateProtectionCoverage.ratio
    );
    expect(runtime!.sideEffectBlockCoverage.ratio).toBeGreaterThan(
      simpleSummary!.sideEffectBlockCoverage.ratio
    );

    expect(runtime!.averageInputTokens).toBeLessThan(fullHistory!.averageInputTokens);
    expect(runtime!.tokenSavingsVsFullHistory).toBeGreaterThan(0);
  });
});
