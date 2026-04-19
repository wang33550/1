export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {}

export type ProviderName = "openai" | "anthropic" | "custom";

export interface SessionRecord {
  id: string;
  provider: ProviderName;
  model: string;
  workspaceRoot?: string;
  createdAt: string;
}

export type EventKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "file_read"
  | "file_write"
  | "command_exec"
  | "plan_update"
  | "decision"
  | "checkpoint_created"
  | "resume_started"
  | "resume_finished"
  | "error";

export interface EventRecord {
  id: string;
  sessionId: string;
  seq: number;
  ts: string;
  kind: EventKind;
  spanId?: string;
  parentSpanId?: string;
  payload: JsonObject;
  tokenEstimate?: number;
}

export type ArtifactType =
  | "file"
  | "patch"
  | "command_output"
  | "test_result"
  | "url"
  | "summary"
  | "plan";

export interface ArtifactRef {
  id: string;
  sessionId: string;
  type: ArtifactType;
  title: string;
  uri?: string;
  contentHash?: string;
  summary: string;
  sourceEventId: string;
  metadata?: JsonObject;
}

export type RepeatPolicy = "allow" | "only_if_stale" | "never";

export interface ActionFingerprint {
  id: string;
  sessionId: string;
  actionType: "file_read" | "command_exec" | "file_write" | "network" | "tool_call";
  normalizedSignature: string;
  hash: string;
  repeatPolicy: RepeatPolicy;
  sourceEventId: string;
  artifactIds: string[];
  dependsOnPaths: string[];
  envDigest?: string;
  resourceDigests?: Record<string, string>;
  executedAt: string;
}

export interface PlanItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done" | "blocked";
}

export interface MemoryItem {
  id: string;
  text: string;
  sourceEventIds: string[];
  pinned?: boolean;
}

export interface WorkItem {
  id: string;
  text: string;
  evidenceEventIds: string[];
}

export interface CheckpointState {
  checkpointId: string;
  sessionId: string;
  createdAt: string;
  eventRange: { fromSeq: number; toSeq: number };
  goal: string;
  successCriteria: string[];
  phase: "scoping" | "implementing" | "verifying" | "blocked" | "done";
  constraints: MemoryItem[];
  pinnedMemory: MemoryItem[];
  decisions: MemoryItem[];
  verifiedFacts: MemoryItem[];
  done: WorkItem[];
  openItems: WorkItem[];
  blockers: string[];
  currentPlan: PlanItem[];
  nextAction: string;
  artifacts: ArtifactRef[];
  doNotRepeat: string[];
  unresolvedQuestions: string[];
  frontierAnchorSeq: number;
}

export interface CreateSessionInput {
  provider: ProviderName;
  model: string;
  workspaceRoot?: string;
  id?: string;
}

export interface AppendEventInput {
  sessionId: string;
  kind: EventKind;
  payload: JsonObject;
  spanId?: string;
  parentSpanId?: string;
  tokenEstimate?: number;
  id?: string;
  ts?: string;
}

export interface SaveArtifactInput {
  sessionId: string;
  type: ArtifactType;
  title: string;
  uri?: string;
  contentHash?: string;
  summary: string;
  sourceEventId: string;
  metadata?: JsonObject;
  id?: string;
}

export interface SaveCheckpointInput {
  id?: string;
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  state: CheckpointState;
  createdAt?: string;
}

export interface SaveFingerprintInput {
  id?: string;
  sessionId: string;
  actionType: ActionFingerprint["actionType"];
  normalizedSignature: string;
  hash: string;
  repeatPolicy: RepeatPolicy;
  sourceEventId: string;
  artifactIds: string[];
  dependsOnPaths: string[];
  envDigest?: string;
  resourceDigests?: Record<string, string>;
  executedAt?: string;
}

export interface ProposedAction {
  actionType: ActionFingerprint["actionType"];
  command?: string;
  cwd?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  afterHash?: string;
  uri?: string;
  toolName?: string;
  input?: JsonObject;
  dependsOnPaths?: string[];
  sideEffect?: boolean;
  ttlSeconds?: number;
  envDigest?: string;
}

export interface GuardDraft {
  normalizedSignature: string;
  hash: string;
  actionType: ActionFingerprint["actionType"];
  repeatPolicy: RepeatPolicy;
  dependsOnPaths: string[];
  envDigest?: string;
}

export interface GuardResult {
  decision: "allow" | "warn" | "block";
  reason?: string;
  stale: boolean;
  draft: GuardDraft;
  matched?: ActionFingerprint;
}

export interface FrontierResult {
  anchorSeq: number;
  archive: EventRecord[];
  frontier: EventRecord[];
}

export interface SafePointState {
  isSafe: boolean;
  pendingToolSpanIds: string[];
  reason?: string;
}

export interface CheckpointCompileInput {
  session: SessionRecord;
  previous?: CheckpointState;
  events: EventRecord[];
  artifacts: ArtifactRef[];
  frontierAnchorSeq: number;
}

export interface ResumePacket {
  packet: string;
  checkpoint?: CheckpointState;
  frontier: EventRecord[];
}

export interface SendTurnInput {
  model: string;
  systemPrompt?: string;
  runtimePacket: string;
  userInput: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface SendTurnResult {
  text: string;
  raw: unknown;
}

export interface ModelAdapter {
  sendTurn(input: SendTurnInput): Promise<SendTurnResult>;
}
