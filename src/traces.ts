import fs from "node:fs";

import { z } from "zod";

import { EventKindSchema, ProposedActionSchema } from "./schemas";
import { TaskRecoveryRuntime } from "./runtime";
import type { EvalDataset, EvalScenario } from "./evals/types";

const TraceSourceSchema = z.object({
  host: z.string().optional(),
  traceId: z.string().optional(),
  exportedAt: z.string().optional(),
  exporter: z.string().optional(),
  notes: z.string().optional()
});

const TraceEventSchema = z.object({
  kind: EventKindSchema,
  payload: z.record(z.any()),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  ts: z.string().optional(),
  id: z.string().optional(),
  tokenEstimate: z.number().optional()
});

const TraceExpectationSchema = z.object({
  nextAction: z.string().optional(),
  requiredConstraints: z.array(z.string()).optional(),
  requiredArtifacts: z.array(z.string()).optional(),
  candidateActions: z.array(ProposedActionSchema).optional(),
  sideEffectActions: z.array(ProposedActionSchema).optional()
});

const TraceImportFileSchema = z.object({
  version: z.literal("trr_trace_v1"),
  description: z.string().optional(),
  source: TraceSourceSchema.optional(),
  session: z.object({
    provider: z.enum(["openai", "anthropic", "custom"]).default("custom"),
    model: z.string(),
    workspaceRoot: z.string().optional(),
    id: z.string().optional()
  }),
  minTailEvents: z.number().int().positive().optional(),
  checkpoint: z
    .object({
      create: z.boolean().optional(),
      force: z.boolean().optional()
    })
    .optional(),
  events: z.array(TraceEventSchema).min(1),
  expected: TraceExpectationSchema.optional()
});

export type TraceImportFile = z.infer<typeof TraceImportFileSchema>;

export interface ImportTraceOptions {
  sessionId?: string;
  createCheckpoint?: boolean;
  forceCheckpoint?: boolean;
}

export interface ImportTraceResult {
  sessionId: string;
  importedEvents: number;
  checkpointCreated: boolean;
  checkpointId?: string;
}

export function loadTraceFile(filePath: string): TraceImportFile {
  const raw = fs.readFileSync(filePath, "utf8");
  return TraceImportFileSchema.parse(JSON.parse(raw));
}

export function importTrace(
  runtime: TaskRecoveryRuntime,
  trace: TraceImportFile,
  options: ImportTraceOptions = {}
): ImportTraceResult {
  const session = runtime.createSession({
    provider: trace.session.provider,
    model: trace.session.model,
    workspaceRoot: trace.session.workspaceRoot,
    id: options.sessionId ?? trace.session.id
  });

  for (const event of trace.events) {
    runtime.recordEvent({
      sessionId: session.id,
      kind: event.kind,
      payload: event.payload,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      ts: event.ts,
      id: event.id,
      tokenEstimate: event.tokenEstimate
    });
  }

  const shouldCreateCheckpoint = options.createCheckpoint ?? trace.checkpoint?.create ?? false;
  const checkpoint = shouldCreateCheckpoint
    ? runtime.createCheckpoint(session.id, options.forceCheckpoint ?? trace.checkpoint?.force ?? false)
    : null;

  return {
    sessionId: session.id,
    importedEvents: trace.events.length,
    checkpointCreated: Boolean(checkpoint),
    checkpointId: checkpoint?.checkpointId
  };
}

export function traceToEvalDataset(trace: TraceImportFile): EvalDataset {
  if (!trace.expected) {
    throw new Error("trace file does not include expected recovery assertions");
  }

  const scenario: EvalScenario = {
    id: trace.source?.traceId || trace.session.id || "imported_trace",
    description:
      trace.description ||
      `Imported trace from ${trace.source?.host || "external host"} for ${trace.session.model}`,
    minTailEvents: trace.minTailEvents,
    events: trace.events.map((event) => ({
      kind: event.kind,
      payload: event.payload,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      ts: event.ts,
      id: event.id
    })),
    expected: trace.expected
  };

  return {
    name: trace.description || `Imported Trace Replay: ${scenario.id}`,
    description: trace.source?.notes,
    scenarios: [scenario]
  };
}
