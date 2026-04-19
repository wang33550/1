import type {
  AppendEventInput,
  ArtifactRef,
  CheckpointState,
  CreateSessionInput,
  EventRecord,
  ProposedAction,
  ResumePacket,
  SessionRecord
} from "./types";
import { RuntimeDatabase } from "./db";
import { DeterministicCheckpointCompiler } from "./checkpoint-compiler";
import { computeFrontier } from "./frontier";
import { RepeatGuard } from "./repeat-guard";
import { ResumeBuilder } from "./resume-builder";
import { detectSafePoint } from "./safe-point";
import { estimateTokensFromText, normalizeWhitespace, safeText, sha256 } from "./utils";

export interface RuntimeOptions {
  dbPath?: string;
  minTailEvents?: number;
}

function maybeArtifact(event: EventRecord): Omit<ArtifactRef, "id"> | undefined {
  if (event.kind === "file_write") {
    const targetPath = normalizeWhitespace(safeText(event.payload.path));
    if (!targetPath) return undefined;
    return {
      sessionId: event.sessionId,
      type: "file",
      title: `File write: ${targetPath}`,
      uri: targetPath,
      contentHash: safeText(event.payload.afterHash) || undefined,
      summary: normalizeWhitespace(
        safeText(event.payload.summary || `Updated file ${targetPath}`)
      ),
      sourceEventId: event.id,
      metadata: {
        path: targetPath
      }
    };
  }

  if (event.kind === "command_exec") {
    const command = normalizeWhitespace(safeText(event.payload.command));
    if (!command) return undefined;
    const exitCode = safeText(event.payload.exitCode || "");
    return {
      sessionId: event.sessionId,
      type: /\b(test|pytest|vitest|jest)\b/i.test(command) ? "test_result" : "command_output",
      title: `Command: ${command}`,
      summary: normalizeWhitespace(
        safeText(event.payload.summary || `Executed ${command} (exit ${exitCode || "unknown"})`)
      ),
      sourceEventId: event.id,
      metadata: {
        command,
        exitCode: event.payload.exitCode ?? null
      }
    };
  }

  if (event.kind === "tool_result") {
    const toolName = normalizeWhitespace(safeText(event.payload.toolName));
    if (!toolName) return undefined;
    return {
      sessionId: event.sessionId,
      type: "summary",
      title: `Tool result: ${toolName}`,
      summary: normalizeWhitespace(safeText(event.payload.summary || event.payload.outputSummary)),
      sourceEventId: event.id,
      metadata: {
        toolName
      }
    };
  }

  if (event.kind === "plan_update") {
    return {
      sessionId: event.sessionId,
      type: "plan",
      title: "Plan snapshot",
      summary: normalizeWhitespace(safeText(event.payload.nextAction || "Plan updated")),
      sourceEventId: event.id,
      metadata: event.payload
    };
  }

  return undefined;
}

function fingerprintableAction(event: EventRecord): ProposedAction | undefined {
  if (event.kind === "file_read") {
    return {
      actionType: "file_read",
      path: safeText(event.payload.path),
      startLine: Number(event.payload.startLine ?? NaN),
      endLine: Number(event.payload.endLine ?? NaN),
      dependsOnPaths: [safeText(event.payload.path)].filter(Boolean)
    };
  }

  if (event.kind === "file_write") {
    return {
      actionType: "file_write",
      path: safeText(event.payload.path),
      afterHash: safeText(event.payload.afterHash),
      dependsOnPaths: [safeText(event.payload.path)].filter(Boolean),
      sideEffect: event.payload.sideEffect === true
    };
  }

  if (event.kind === "command_exec") {
    return {
      actionType: "command_exec",
      command: safeText(event.payload.command),
      cwd: safeText(event.payload.cwd),
      dependsOnPaths: Array.isArray(event.payload.dependsOnPaths)
        ? event.payload.dependsOnPaths.map((value) => safeText(value)).filter(Boolean)
        : [],
      sideEffect: event.payload.sideEffect === true
    };
  }

  if (event.kind === "tool_call") {
    return {
      actionType: "tool_call",
      toolName: safeText(event.payload.toolName),
      input:
        event.payload.input && typeof event.payload.input === "object"
          ? (event.payload.input as ProposedAction["input"])
          : undefined,
      sideEffect: event.payload.sideEffect === true
    };
  }

  return undefined;
}

export class TaskRecoveryRuntime {
  readonly db: RuntimeDatabase;
  readonly compiler: DeterministicCheckpointCompiler;
  readonly repeatGuard: RepeatGuard;
  readonly resumeBuilder: ResumeBuilder;
  readonly minTailEvents: number;

  constructor(options: RuntimeOptions = {}) {
    this.db = new RuntimeDatabase(options.dbPath);
    this.compiler = new DeterministicCheckpointCompiler();
    this.repeatGuard = new RepeatGuard(this.db);
    this.resumeBuilder = new ResumeBuilder();
    this.minTailEvents = options.minTailEvents ?? 6;
  }

  close(): void {
    this.db.close();
  }

  createSession(input: CreateSessionInput): SessionRecord {
    return this.db.createSession(input);
  }

  getSession(sessionId: string): SessionRecord {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    return session;
  }

  listSessions(): SessionRecord[] {
    return this.db.listSessions();
  }

  recordEvent(input: AppendEventInput): EventRecord {
    const event = this.db.appendEvent({
      ...input,
      tokenEstimate:
        input.tokenEstimate ??
        estimateTokensFromText(JSON.stringify(input.payload))
    });

    const artifact = maybeArtifact(event);
    let artifactIds: string[] = [];
    if (artifact && artifact.summary) {
      const saved = this.db.saveArtifact(artifact);
      artifactIds = [saved.id];
    }

    const action = fingerprintableAction(event);
    if (action) {
      this.repeatGuard.remember(event.sessionId, event.id, action, artifactIds);
    }
    return event;
  }

  listEvents(sessionId: string, options?: { fromSeq?: number; toSeq?: number; limit?: number }): EventRecord[] {
    return this.db.listEvents(sessionId, options);
  }

  listCheckpoints(sessionId: string): CheckpointState[] {
    return this.db.listCheckpoints(sessionId);
  }

  getLatestCheckpoint(sessionId: string): CheckpointState | undefined {
    return this.db.getLatestCheckpoint(sessionId);
  }

  createCheckpoint(sessionId: string, force = false): CheckpointState | null {
    const session = this.getSession(sessionId);
    const events = this.db.listEvents(sessionId);
    if (events.length === 0) return null;

    const safePoint = detectSafePoint(events);
    if (!safePoint.isSafe && !force) {
      return null;
    }

    const frontier = computeFrontier(events, { minTailEvents: this.minTailEvents });
    const previous = this.db.getLatestCheckpoint(sessionId);
    const fromSeq = (previous?.eventRange.toSeq ?? 0) + 1;
    const lastSeq = events[events.length - 1]!.seq;
    const compilationCutoff = Math.max(1, lastSeq - this.minTailEvents + 1);
    const compilableEvents = events.filter(
      (event) => event.seq >= fromSeq && event.seq < compilationCutoff
    );
    if (compilableEvents.length === 0 && !force) {
      return previous ?? null;
    }

    const artifacts = this.db.listArtifacts(
      sessionId,
      compilableEvents.map((event) => event.id)
    );

    const nextState = this.compiler.compile({
      session,
      previous,
      events: compilableEvents,
      artifacts,
      frontierAnchorSeq: frontier.anchorSeq
    });

    const saved = this.db.saveCheckpoint({
      sessionId,
      fromSeq: compilableEvents[0]?.seq ?? fromSeq,
      toSeq: compilableEvents[compilableEvents.length - 1]?.seq ?? previous?.eventRange.toSeq ?? 0,
      state: nextState
    });

    this.db.appendEvent({
      sessionId,
      kind: "checkpoint_created",
      payload: {
        checkpointId: saved.checkpointId,
        fromSeq: saved.eventRange.fromSeq,
        toSeq: saved.eventRange.toSeq
      }
    });
    return saved;
  }

  buildResumePacket(
    sessionId: string,
    options: {
      excludeLatestUser?: boolean;
    } = {}
  ): ResumePacket {
    const checkpoint = this.db.getLatestCheckpoint(sessionId);
    let frontier = computeFrontier(this.db.listEvents(sessionId), {
      minTailEvents: this.minTailEvents
    }).frontier;

    if (options.excludeLatestUser && frontier.length > 0) {
      const last = frontier[frontier.length - 1];
      if (last?.kind === "user_message") {
        frontier = frontier.slice(0, -1);
      }
    }

    return this.resumeBuilder.build(checkpoint, frontier);
  }

  assessAction(sessionId: string, action: ProposedAction) {
    return this.repeatGuard.assess(sessionId, action);
  }

  maybeCompact(sessionId: string, softTokenThreshold = 2500): CheckpointState | null {
    const events = this.db.listEvents(sessionId);
    const totalEstimate = events.reduce((sum, event) => sum + (event.tokenEstimate ?? 0), 0);
    if (totalEstimate < softTokenThreshold) {
      return null;
    }
    return this.createCheckpoint(sessionId);
  }

  latestUserInput(sessionId: string): string | undefined {
    const events = this.db.listEvents(sessionId);
    const latestUser = [...events].reverse().find((event) => event.kind === "user_message");
    if (!latestUser) return undefined;
    return normalizeWhitespace(safeText(latestUser.payload.text || latestUser.payload.content));
  }

  sessionDigest(sessionId: string): string {
    const checkpoint = this.db.getLatestCheckpoint(sessionId);
    const frontier = this.buildResumePacket(sessionId).frontier;
    return sha256(
      JSON.stringify({
        checkpointId: checkpoint?.checkpointId ?? null,
        frontierIds: frontier.map((event) => event.id)
      })
    );
  }
}
