import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskRecoveryRuntime } from "../runtime";
import type { EventRecord, ProposedAction } from "../types";
import { estimateTokensFromText, nowIso, normalizeWhitespace, safeText, stableStringify } from "../utils";
import type {
  CoverageMetric,
  EvalDataset,
  EvalScenario,
  EvalReport,
  StrategyAggregateResult,
  StrategyScenarioResult
} from "./types";

export type StrategyName = "full_history" | "simple_summary" | "runtime";

export interface StrategyBuildResult {
  visibleContext: string;
  duplicateProtection: CoverageMetric;
  sideEffectBlocks: CoverageMetric;
}

interface RuntimeExecution {
  runtime: TaskRecoveryRuntime;
  sessionId: string;
  events: EventRecord[];
  storePath: string;
}

function tempStorePath(name: string): string {
  return path.join(
    os.tmpdir(),
    `trr-eval-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

function summarizeEvent(event: EventRecord): string {
  if (event.kind === "user_message" || event.kind === "assistant_message") {
    return safeText(event.payload.text || event.payload.content);
  }
  if (event.kind === "command_exec") {
    const summary = safeText(event.payload.summary);
    return summary
      ? `${safeText(event.payload.command)} :: exit=${safeText(event.payload.exitCode)} :: ${summary}`
      : `${safeText(event.payload.command)} :: exit=${safeText(event.payload.exitCode)}`;
  }
  if (event.kind === "file_read" || event.kind === "file_write") {
    const summary = safeText(event.payload.summary);
    return summary
      ? `${event.kind} ${safeText(event.payload.path)} :: ${summary}`
      : `${event.kind} ${safeText(event.payload.path)}`;
  }
  if (event.kind === "plan_update") {
    return stableStringify(event.payload.items ?? event.payload);
  }
  return stableStringify(event.payload);
}

function renderEvents(events: EventRecord[]): string {
  return events.map((event) => `[${event.seq}] ${event.kind}: ${summarizeEvent(event)}`).join("\n");
}

function firstUserGoal(events: EventRecord[]): string | undefined {
  return events.find((event) => event.kind === "user_message")?.payload.text as string | undefined;
}

function buildSimpleSummary(events: EventRecord[], minTailEvents: number): string {
  const tail = events.slice(-minTailEvents);
  const archive = events.slice(0, Math.max(0, events.length - minTailEvents));
  const fileWrites = archive.filter((event) => event.kind === "file_write").length;
  const commands = archive.filter((event) => event.kind === "command_exec").length;
  const tools = archive.filter((event) => event.kind === "tool_call" || event.kind === "tool_result").length;

  return [
    `<SIMPLE_SUMMARY>`,
    `Objective: ${safeText(firstUserGoal(events) || "Continue the task.")}`,
    `Compacted older context into a short summary.`,
    `Older work counts: ${fileWrites} file writes, ${commands} commands, ${tools} tool events.`,
    `</SIMPLE_SUMMARY>`,
    ``,
    `<RECENT_TAIL>`,
    renderEvents(tail),
    `</RECENT_TAIL>`
  ].join("\n");
}

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

function assessActions(
  runtime: TaskRecoveryRuntime,
  sessionId: string,
  actions: ProposedAction[] | undefined,
  blockOnly = false
): CoverageMetric {
  const items = actions ?? [];
  let hits = 0;
  for (const action of items) {
    const result = runtime.assessAction(sessionId, action);
    if (blockOnly) {
      if (result.decision === "block") hits += 1;
    } else if (result.decision === "warn" || result.decision === "block") {
      hits += 1;
    }
  }
  return ratioMetric(hits, items.length);
}

function executeScenarioInRuntime(scenario: EvalScenario): RuntimeExecution {
  const storePath = tempStorePath(scenario.id);
  const runtime = new TaskRecoveryRuntime({
    dbPath: storePath,
    minTailEvents: scenario.minTailEvents ?? 2
  });
  const session = runtime.createSession({
    provider: "custom",
    model: "eval-model"
  });
  for (const event of scenario.events) {
    runtime.recordEvent({
      sessionId: session.id,
      kind: event.kind,
      payload: event.payload,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      ts: event.ts,
      id: event.id
    });
  }
  return {
    runtime,
    sessionId: session.id,
    events: runtime.listEvents(session.id),
    storePath
  };
}

export function buildStrategyContext(strategy: StrategyName, scenario: EvalScenario): StrategyBuildResult {
  if (strategy === "simple_summary") {
    const { runtime, events, storePath } = executeScenarioInRuntime(scenario);
    const visibleContext = buildSimpleSummary(events, scenario.minTailEvents ?? 2);
    runtime.close();
    fs.rmSync(storePath, { force: true });
    return {
      visibleContext,
      duplicateProtection: ratioMetric(0, scenario.expected.candidateActions?.length ?? 0),
      sideEffectBlocks: ratioMetric(0, scenario.expected.sideEffectActions?.length ?? 0)
    };
  }

  if (strategy === "full_history") {
    const { runtime, events, storePath } = executeScenarioInRuntime(scenario);
    const visibleContext = [
      `<FULL_HISTORY>`,
      JSON.stringify(
        events.map((event) => ({
          seq: event.seq,
          kind: event.kind,
          payload: event.payload
        })),
        null,
        2
      ),
      `</FULL_HISTORY>`
    ].join("\n");
    runtime.close();
    fs.rmSync(storePath, { force: true });
    return {
      visibleContext,
      duplicateProtection: ratioMetric(0, scenario.expected.candidateActions?.length ?? 0),
      sideEffectBlocks: ratioMetric(0, scenario.expected.sideEffectActions?.length ?? 0)
    };
  }

  const { runtime, sessionId, storePath } = executeScenarioInRuntime(scenario);
  runtime.createCheckpoint(sessionId, true);
  const packet = runtime.buildResumePacket(sessionId);
  const duplicateProtection = assessActions(runtime, sessionId, scenario.expected.candidateActions);
  const sideEffectBlocks = assessActions(
    runtime,
    sessionId,
    scenario.expected.sideEffectActions,
    true
  );
  runtime.close();
  fs.rmSync(storePath, { force: true });
  return {
    visibleContext: packet.packet,
    duplicateProtection,
    sideEffectBlocks
  };
}

function strategyResult(strategy: StrategyName, scenario: EvalScenario): StrategyScenarioResult {
  const result = buildStrategyContext(strategy, scenario);
  const nextActionExpected = scenario.expected.nextAction;
  const nextActionCovered =
    nextActionExpected === undefined
      ? true
      : normalizeWhitespace(result.visibleContext)
          .toLowerCase()
          .includes(normalizeWhitespace(nextActionExpected).toLowerCase());
  const constraintCoverage = coverageForStrings(
    scenario.expected.requiredConstraints,
    result.visibleContext
  );
  const artifactCoverage = coverageForStrings(
    scenario.expected.requiredArtifacts,
    result.visibleContext
  );
  const notes: string[] = [];
  if (!nextActionCovered && nextActionExpected) {
    notes.push(`missing next action: ${nextActionExpected}`);
  }
  if (constraintCoverage.hits < constraintCoverage.total) {
    notes.push("missing one or more constraints");
  }
  if (artifactCoverage.hits < artifactCoverage.total) {
    notes.push("missing one or more artifacts");
  }
  if (
    result.duplicateProtection.hits < result.duplicateProtection.total &&
    result.duplicateProtection.total > 0
  ) {
    notes.push("duplicate actions are not fully protected");
  }
  if (result.sideEffectBlocks.hits < result.sideEffectBlocks.total && result.sideEffectBlocks.total > 0) {
    notes.push("side-effect actions are not fully blocked");
  }

  return {
    strategy,
    scenarioId: scenario.id,
    description: scenario.description,
    inputTokenEstimate: estimateTokensFromText(result.visibleContext),
    nextActionCovered,
    constraintCoverage,
    artifactCoverage,
    duplicateProtectionCoverage: result.duplicateProtection,
    sideEffectBlockCoverage: result.sideEffectBlocks,
    visibleContextPreview: result.visibleContext.slice(0, 500),
    notes
  };
}

function aggregate(strategy: StrategyName, results: StrategyScenarioResult[], fullHistoryAverageTokens: number): StrategyAggregateResult {
  const scenarioCount = results.length;
  const nextActionHits = results.filter((item) => item.nextActionCovered).length;
  const sumCoverage = (selector: (item: StrategyScenarioResult) => CoverageMetric): CoverageMetric => {
    const aggregateHits = results.reduce((sum, item) => sum + selector(item).hits, 0);
    const aggregateTotal = results.reduce((sum, item) => sum + selector(item).total, 0);
    return ratioMetric(aggregateHits, aggregateTotal);
  };
  const averageInputTokens =
    results.reduce((sum, item) => sum + item.inputTokenEstimate, 0) / Math.max(1, scenarioCount);

  return {
    strategy,
    scenarioCount,
    nextActionCoverage: ratioMetric(nextActionHits, scenarioCount),
    constraintCoverage: sumCoverage((item) => item.constraintCoverage),
    artifactCoverage: sumCoverage((item) => item.artifactCoverage),
    duplicateProtectionCoverage: sumCoverage((item) => item.duplicateProtectionCoverage),
    sideEffectBlockCoverage: sumCoverage((item) => item.sideEffectBlockCoverage),
    averageInputTokens,
    tokenSavingsVsFullHistory:
      fullHistoryAverageTokens === 0 ? 0 : 1 - averageInputTokens / fullHistoryAverageTokens
  };
}

export function runEval(dataset: EvalDataset): EvalReport {
  const strategies: StrategyName[] = ["full_history", "simple_summary", "runtime"];
  const scenarioMap: Record<string, StrategyScenarioResult[]> = {};
  const perStrategy = new Map<StrategyName, StrategyScenarioResult[]>();

  for (const strategy of strategies) {
    perStrategy.set(strategy, []);
  }

  for (const scenario of dataset.scenarios) {
    const scenarioResults: StrategyScenarioResult[] = [];
    scenarioMap[scenario.id] = scenarioResults;
    for (const strategy of strategies) {
      const result = strategyResult(strategy, scenario);
      scenarioResults.push(result);
      perStrategy.get(strategy)!.push(result);
    }
  }

  const fullHistoryAverageTokens =
    perStrategy.get("full_history")!.reduce((sum, item) => sum + item.inputTokenEstimate, 0) /
    Math.max(1, perStrategy.get("full_history")!.length);

  return {
    datasetName: dataset.name,
    datasetDescription: dataset.description,
    generatedAt: nowIso(),
    scenarioCount: dataset.scenarios.length,
    strategies: strategies.map((strategy) =>
      aggregate(strategy, perStrategy.get(strategy)!, fullHistoryAverageTokens)
    ),
    scenarios: scenarioMap
  };
}
