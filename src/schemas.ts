import { z } from "zod";

export const EventKindSchema = z.enum([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "file_read",
  "file_write",
  "command_exec",
  "plan_update",
  "decision",
  "checkpoint_created",
  "resume_started",
  "resume_finished",
  "error"
]);

export const ProposedActionSchema = z.object({
  actionType: z.enum(["file_read", "command_exec", "file_write", "network", "tool_call"]),
  command: z.string().optional(),
  cwd: z.string().optional(),
  path: z.string().optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  afterHash: z.string().optional(),
  uri: z.string().optional(),
  toolName: z.string().optional(),
  input: z.record(z.any()).optional(),
  dependsOnPaths: z.array(z.string()).optional(),
  sideEffect: z.boolean().optional(),
  ttlSeconds: z.number().optional(),
  envDigest: z.string().optional()
});

export const PlanItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "done", "blocked"])
});

export const MemoryItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  sourceEventIds: z.array(z.string()),
  pinned: z.boolean().optional()
});

export const WorkItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  evidenceEventIds: z.array(z.string())
});

export const ArtifactRefSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.enum(["file", "patch", "command_output", "test_result", "url", "summary", "plan"]),
  title: z.string(),
  uri: z.string().optional(),
  contentHash: z.string().optional(),
  summary: z.string(),
  sourceEventId: z.string(),
  metadata: z.record(z.any()).optional()
});

export const CheckpointStateSchema = z.object({
  checkpointId: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  eventRange: z.object({
    fromSeq: z.number().int(),
    toSeq: z.number().int()
  }),
  goal: z.string(),
  successCriteria: z.array(z.string()),
  phase: z.enum(["scoping", "implementing", "verifying", "blocked", "done"]),
  constraints: z.array(MemoryItemSchema),
  pinnedMemory: z.array(MemoryItemSchema),
  decisions: z.array(MemoryItemSchema),
  verifiedFacts: z.array(MemoryItemSchema),
  done: z.array(WorkItemSchema),
  openItems: z.array(WorkItemSchema),
  blockers: z.array(z.string()),
  currentPlan: z.array(PlanItemSchema),
  nextAction: z.string(),
  artifacts: z.array(ArtifactRefSchema),
  doNotRepeat: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
  frontierAnchorSeq: z.number().int()
});
