import fs from "node:fs";
import path from "node:path";

import { loadTraceFile, traceToEvalDataset } from "../traces";
import { normalizeWhitespace } from "../utils";
import type { EvalDataset, EvalScenario } from "./types";

export interface TraceCorpusOptions {
  dir: string;
  name?: string;
  minEvents?: number;
  minUserMessages?: number;
  requireExpected?: boolean;
  requireNextAction?: boolean;
  hosts?: string[];
  qualities?: string[];
  maxScenarios?: number;
}

export interface TraceCorpusEntry {
  id: string;
  filePath: string;
  host?: string;
  quality?: string;
  description: string;
  eventCount: number;
  userMessageCount: number;
  hasExpected: boolean;
  hasNextAction: boolean;
}

export interface TraceCorpusSkip {
  id: string;
  filePath: string;
  host?: string;
  quality?: string;
  reason: string;
}

export interface TraceCorpusSummary {
  directory: string;
  manifestFound: boolean;
  totalTraceFiles: number;
  validTraceFiles: number;
  tracesWithExpected: number;
  tracesWithNextAction: number;
  includedCount: number;
  skippedCount: number;
  includedByHost: Record<string, number>;
  includedByQuality: Record<string, number>;
  skippedByReason: Record<string, number>;
  averageIncludedEventCount: number;
  averageIncludedUserMessageCount: number;
  filters: {
    minEvents?: number;
    minUserMessages?: number;
    requireExpected: boolean;
    requireNextAction: boolean;
    hosts?: string[];
    qualities?: string[];
    maxScenarios?: number;
  };
}

export interface TraceCorpusLoadResult {
  dataset: EvalDataset;
  included: TraceCorpusEntry[];
  skipped: TraceCorpusSkip[];
  summary: TraceCorpusSummary;
}

interface ManifestEntryLike {
  id?: string;
  host?: string;
  quality?: string;
  outputPath?: string;
}

function normalizeList(values: string[] | undefined): string[] | undefined {
  const items = values
    ?.map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  return items && items.length > 0 ? [...new Set(items)] : undefined;
}

function increment(counter: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  counter[key] = (counter[key] ?? 0) + 1;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function manifestIndex(dir: string): { found: boolean; entries: Map<string, ManifestEntryLike> } {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return {
      found: false,
      entries: new Map()
    };
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { entries?: unknown };
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  const index = new Map<string, ManifestEntryLike>();

  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const entry = item as ManifestEntryLike;
    const outputPath = typeof entry.outputPath === "string" ? entry.outputPath : undefined;
    if (!outputPath) continue;
    index.set(path.basename(outputPath.replace(/\\/g, "/")), entry);
  }

  return {
    found: true,
    entries: index
  };
}

function reasonEquals(reason: string, prefix: string): boolean {
  return reason === prefix || reason.startsWith(`${prefix}=`);
}

function fileId(filePath: string): string {
  return path.basename(filePath, ".json");
}

export function loadTraceCorpus(options: TraceCorpusOptions): TraceCorpusLoadResult {
  const requireExpected = options.requireExpected ?? true;
  const requireNextAction = options.requireNextAction ?? true;
  const hostFilter = normalizeList(options.hosts);
  const qualityFilter = normalizeList(options.qualities);
  const files = fs
    .readdirSync(options.dir)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort((left, right) => left.localeCompare(right));
  const manifest = manifestIndex(options.dir);

  const included: TraceCorpusEntry[] = [];
  const skipped: TraceCorpusSkip[] = [];
  const scenarios: EvalScenario[] = [];
  const includedByHost: Record<string, number> = {};
  const includedByQuality: Record<string, number> = {};
  const skippedByReason: Record<string, number> = {};

  let validTraceFiles = 0;
  let tracesWithExpected = 0;
  let tracesWithNextAction = 0;

  for (const fileName of files) {
    const filePath = path.join(options.dir, fileName);
    const manifestEntry = manifest.entries.get(fileName);
    try {
      const trace = loadTraceFile(filePath);
      validTraceFiles += 1;

      const id =
        manifestEntry?.id ||
        trace.source?.traceId ||
        trace.session.id ||
        fileId(filePath);
      const host =
        normalizeWhitespace(manifestEntry?.host || trace.source?.host || "").toLowerCase() ||
        undefined;
      const quality =
        normalizeWhitespace(manifestEntry?.quality || "").toLowerCase() || undefined;
      const eventCount = trace.events.length;
      const userMessageCount = trace.events.filter((event) => event.kind === "user_message").length;
      const hasExpected = Boolean(trace.expected);
      const hasNextAction = Boolean(trace.expected?.nextAction);

      if (hasExpected) tracesWithExpected += 1;
      if (hasNextAction) tracesWithNextAction += 1;

      let reason: string | undefined;
      if (hostFilter && (!host || !hostFilter.includes(host))) {
        reason = `host filtered`;
      } else if (qualityFilter && (!quality || !qualityFilter.includes(quality))) {
        reason = `quality filtered`;
      } else if (options.minEvents !== undefined && eventCount < options.minEvents) {
        reason = `below minEvents=${options.minEvents}`;
      } else if (
        options.minUserMessages !== undefined &&
        userMessageCount < options.minUserMessages
      ) {
        reason = `below minUserMessages=${options.minUserMessages}`;
      } else if (requireExpected && !hasExpected) {
        reason = "missing expected";
      } else if (requireNextAction && !hasNextAction) {
        reason = "missing expected.nextAction";
      } else if (options.maxScenarios !== undefined && scenarios.length >= options.maxScenarios) {
        reason = `above maxScenarios=${options.maxScenarios}`;
      }

      if (reason) {
        skipped.push({
          id,
          filePath,
          host,
          quality,
          reason
        });
        increment(skippedByReason, reason);
        continue;
      }

      const scenario = traceToEvalDataset(trace).scenarios[0];
      if (!scenario) {
        skipped.push({
          id,
          filePath,
          host,
          quality,
          reason: "no scenario produced"
        });
        increment(skippedByReason, "no scenario produced");
        continue;
      }

      scenarios.push({
        ...scenario,
        id
      });

      included.push({
        id,
        filePath,
        host,
        quality,
        description: scenario.description,
        eventCount,
        userMessageCount,
        hasExpected,
        hasNextAction
      });
      increment(includedByHost, host);
      increment(includedByQuality, quality);
    } catch (error) {
      const reason = `invalid trace: ${error instanceof Error ? error.message : String(error)}`;
      skipped.push({
        id: manifestEntry?.id || fileId(filePath),
        filePath,
        host: normalizeWhitespace(manifestEntry?.host || "").toLowerCase() || undefined,
        quality: normalizeWhitespace(manifestEntry?.quality || "").toLowerCase() || undefined,
        reason
      });
      increment(skippedByReason, "invalid trace");
    }
  }

  const filterSummary: TraceCorpusSummary["filters"] = {
    minEvents: options.minEvents,
    minUserMessages: options.minUserMessages,
    requireExpected,
    requireNextAction,
    hosts: hostFilter,
    qualities: qualityFilter,
    maxScenarios: options.maxScenarios
  };

  const summary: TraceCorpusSummary = {
    directory: options.dir,
    manifestFound: manifest.found,
    totalTraceFiles: files.length,
    validTraceFiles,
    tracesWithExpected,
    tracesWithNextAction,
    includedCount: included.length,
    skippedCount: skipped.length,
    includedByHost,
    includedByQuality,
    skippedByReason,
    averageIncludedEventCount: average(included.map((entry) => entry.eventCount)),
    averageIncludedUserMessageCount: average(included.map((entry) => entry.userMessageCount)),
    filters: filterSummary
  };

  const activeFilters: string[] = [];
  if (options.minEvents !== undefined) activeFilters.push(`minEvents=${options.minEvents}`);
  if (options.minUserMessages !== undefined) {
    activeFilters.push(`minUserMessages=${options.minUserMessages}`);
  }
  if (requireExpected) activeFilters.push("requireExpected=true");
  if (requireNextAction) activeFilters.push("requireNextAction=true");
  if (hostFilter && hostFilter.length > 0) activeFilters.push(`hosts=${hostFilter.join(",")}`);
  if (qualityFilter && qualityFilter.length > 0) {
    activeFilters.push(`qualities=${qualityFilter.join(",")}`);
  }
  if (options.maxScenarios !== undefined) {
    activeFilters.push(`maxScenarios=${options.maxScenarios}`);
  }

  const description = [
    `Loaded ${included.length}/${files.length} traces from ${options.dir}.`,
    `Valid traces: ${validTraceFiles}.`,
    `Traces with expected: ${tracesWithExpected}.`,
    `Traces with next action: ${tracesWithNextAction}.`,
    activeFilters.length > 0 ? `Filters: ${activeFilters.join("; ")}.` : undefined
  ]
    .filter(Boolean)
    .join(" ");

  return {
    dataset: {
      name: options.name || `Trace Corpus: ${path.basename(path.resolve(options.dir))}`,
      description,
      scenarios
    },
    included,
    skipped,
    summary
  };
}

export function summarizeSkipped(skipped: TraceCorpusSkip[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of skipped) {
    if (reasonEquals(item.reason, "invalid trace")) {
      increment(counts, "invalid trace");
    } else {
      increment(counts, item.reason);
    }
  }
  return counts;
}
