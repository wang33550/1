import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ArtifactRef,
  CheckpointState,
  EventRecord,
  JsonObject,
  JsonValue,
  SessionRecord
} from "./types";
import type { TrrConfig } from "./config";
import { TaskRecoveryRuntime } from "./runtime";
import {
  estimateTokensFromText,
  normalizeWhitespace,
  nowIso,
  safeText,
  sha256,
  stableStringify
} from "./utils";

export interface FeedbackBundleOptions {
  sessionId?: string;
  host?: string;
  redact?: boolean;
  eventLimit?: number;
  artifactLimit?: number;
  checkpointLimit?: number;
  label?: string;
  notes?: string;
  trrVersion?: string;
}

export interface FeedbackTimelineEntry {
  seq: number;
  ts: string;
  kind: string;
  summary: string;
  details: JsonObject;
}

export interface FeedbackCheckpointPreview {
  checkpointId: string;
  createdAt: string;
  phase: CheckpointState["phase"];
  nextAction: string;
  eventRange: {
    fromSeq: number;
    toSeq: number;
  };
}

export interface FeedbackResumePacket {
  packetHash: string;
  estimatedTokens: number;
  packet: string;
}

export interface FeedbackExportBundle {
  schemaVersion: "trr-feedback/v1";
  generatedAt: string;
  trrVersion: string;
  redacted: boolean;
  redactionPolicy: TrrConfig["redactionPolicy"];
  session: SessionRecord;
  source: {
    workspaceRoot: string;
    storePath: string;
    eventCount: number;
    artifactCount: number;
    checkpointCount: number;
  };
  environment: {
    platform: string;
    nodeVersion: string;
    shell?: string;
    homeDir: string;
  };
  summary: {
    host?: string;
    provider: string;
    model: string;
    phase?: CheckpointState["phase"];
    nextAction?: string;
    compactionCount: number;
    resumeInjectionCount: number;
    guardWarnCount: number;
    guardBlockCount: number;
    restartCount: number;
    errorCount: number;
    recentSideEffects: string[];
    blockedActions: string[];
  };
  labels: {
    outcome: string;
    notes?: string;
  };
  latestCheckpoint?: CheckpointState;
  checkpointPreviews: FeedbackCheckpointPreview[];
  latestResumeInjection?: {
    ts: string;
    reason?: string;
    packetHash?: string;
    host?: string;
  };
  currentResumePacket?: FeedbackResumePacket;
  artifacts: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    uri?: string;
    sourceEventId: string;
    metadata?: JsonObject;
  }>;
  timeline: FeedbackTimelineEntry[];
}

export interface FeedbackExportResult {
  outputPath: string;
  bundle: FeedbackExportBundle;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maybeWindowsPath(value: string): string | undefined {
  const match = value.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) return undefined;
  return `${match[1]!.toUpperCase()}:\\${match[2]!.replace(/\//g, "\\")}`;
}

function maybeWslPath(value: string): string | undefined {
  const match = value.match(/^([a-zA-Z]):\\(.+)$/);
  if (!match) return undefined;
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, "/")}`;
}

function buildTextRedactor(
  config: TrrConfig,
  workspaceRoot: string
): (value: string) => string {
  const replacements: Array<[RegExp, string]> = [];

  const normalizedWorkspace = normalizeWhitespace(workspaceRoot);
  if (normalizedWorkspace) {
    replacements.push([new RegExp(escapeRegex(normalizedWorkspace), "gi"), "$WORKSPACE"]);
    const windows = maybeWindowsPath(normalizedWorkspace);
    if (windows) {
      replacements.push([new RegExp(escapeRegex(windows), "gi"), "$WORKSPACE"]);
    }
    const wsl = maybeWslPath(normalizedWorkspace);
    if (wsl) {
      replacements.push([new RegExp(escapeRegex(wsl), "gi"), "$WORKSPACE"]);
    }
  }

  if (config.redactionPolicy.redactHomePaths) {
    const homeCandidates = new Set(
      [os.homedir(), process.env.HOME, process.env.USERPROFILE]
        .map((item) => normalizeWhitespace(item || ""))
        .filter(Boolean)
    );
    for (const candidate of [...homeCandidates]) {
      replacements.push([new RegExp(escapeRegex(candidate), "gi"), "$HOME"]);
      const windows = maybeWindowsPath(candidate);
      if (windows) {
        replacements.push([new RegExp(escapeRegex(windows), "gi"), "%USERPROFILE%"]);
      }
      const wsl = maybeWslPath(candidate);
      if (wsl) {
        replacements.push([new RegExp(escapeRegex(wsl), "gi"), "$HOME_WIN"]);
      }
    }
    replacements.push([/C:\\Users\\[^\\]+/gi, "%USERPROFILE%"]);
    replacements.push([/\/mnt\/[a-z]\/Users\/[^/]+/gi, "$HOME_WIN"]);
  }

  if (config.redactionPolicy.redactCommonSecrets) {
    replacements.push([/sk-[A-Za-z0-9_\-]+/g, "[REDACTED_API_KEY]"]);
    replacements.push([/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_PAT]"]);
    replacements.push([/\bBearer\s+[A-Za-z0-9._\-]+\b/gi, "Bearer [REDACTED]"]);
    replacements.push([/\b[A-Fa-f0-9]{32,64}\b/g, "[REDACTED_HEX]"]);
  }

  return (value: string) => {
    let next = value;
    for (const [pattern, replacement] of replacements) {
      next = next.replace(pattern, replacement);
    }
    return next;
  };
}

function redactBundle(
  bundle: FeedbackExportBundle,
  config: TrrConfig
): FeedbackExportBundle {
  const redact = buildTextRedactor(config, bundle.source.workspaceRoot);
  return redactJsonValue(bundle as unknown as JsonValue, redact) as unknown as FeedbackExportBundle;
}

function redactJsonValue(value: JsonValue, redact: (value: string) => string): JsonValue {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, redact));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactJsonValue(nested, redact)])
    ) as JsonValue;
  }
  return value;
}

function truncateText(value: string, maxLength = 240): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function eventDetails(event: EventRecord): JsonObject {
  const payload = event.payload;
  switch (event.kind) {
    case "user_message":
      return {
        text: truncateText(safeText(payload.text || payload.content))
      };
    case "assistant_message":
      return {
        text: truncateText(safeText(payload.text || payload.content)),
        ...(safeText(payload.nextAction) ? { nextAction: safeText(payload.nextAction) } : {})
      };
    case "plan_update":
      return {
        ...(safeText(payload.nextAction) ? { nextAction: safeText(payload.nextAction) } : {}),
        items: Array.isArray(payload.items)
          ? payload.items
              .slice(0, 6)
              .map((item) =>
                typeof item === "object" && item
                  ? {
                      id: safeText((item as Record<string, unknown>).id),
                      text: safeText((item as Record<string, unknown>).text || (item as Record<string, unknown>).step),
                      status: safeText((item as Record<string, unknown>).status)
                    }
                  : item
              )
          : []
      };
    case "command_exec":
      return {
        command: safeText(payload.command),
        ...(payload.exitCode !== undefined ? { exitCode: Number(payload.exitCode) } : {}),
        summary: truncateText(safeText(payload.summary)),
        sideEffect: payload.sideEffect === true
      };
    case "tool_call":
    case "tool_result":
      return {
        toolName: safeText(payload.toolName),
        summary: truncateText(safeText(payload.summary || payload.outputSummary))
      };
    case "file_read":
      return {
        path: safeText(payload.path),
        ...(payload.startLine !== undefined ? { startLine: Number(payload.startLine) } : {}),
        ...(payload.endLine !== undefined ? { endLine: Number(payload.endLine) } : {}),
        ...(safeText(payload.command) ? { command: safeText(payload.command) } : {})
      };
    case "file_write":
      return {
        path: safeText(payload.path),
        summary: truncateText(safeText(payload.summary)),
        ...(safeText(payload.afterHash) ? { afterHash: safeText(payload.afterHash) } : {})
      };
    case "guard_decision":
      return {
        decision: safeText(payload.decision),
        actionType: safeText(payload.actionType),
        command: safeText(payload.command),
        reason: truncateText(safeText(payload.reason)),
        stale: payload.stale === true
      };
    case "host_event":
      return {
        host: safeText(payload.host),
        ...(safeText(payload.hookEventName) ? { hookEventName: safeText(payload.hookEventName) } : {}),
        ...(safeText(payload.telemetryType) ? { telemetryType: safeText(payload.telemetryType) } : {}),
        ...(payload.modelContextWindow !== undefined
          ? { modelContextWindow: Number(payload.modelContextWindow) }
          : {}),
        ...(payload.inputWindowFraction !== undefined
          ? { inputWindowFraction: Number(payload.inputWindowFraction) }
          : {}),
        ...(safeText(payload.text) ? { text: truncateText(safeText(payload.text)) } : {})
      };
    case "compaction_detected":
      return {
        host: safeText(payload.host),
        reason: truncateText(safeText(payload.reason || payload.pattern))
      };
    case "resume_started":
    case "resume_finished":
      return {
        host: safeText(payload.host),
        reason: safeText(payload.reason)
      };
    case "resume_injected":
      return {
        host: safeText(payload.host),
        reason: safeText(payload.reason),
        packetHash: safeText(payload.packetHash)
      };
    case "workspace_snapshot":
      return {
        workspaceRoot: safeText(payload.workspaceRoot),
        modifiedFiles: Array.isArray(payload.modifiedFiles) ? payload.modifiedFiles.length : 0,
        recentTestResults: Array.isArray(payload.recentTestResults)
          ? payload.recentTestResults.length
          : 0
      };
    case "process_restarted":
      return {
        reason: safeText(payload.reason)
      };
    case "checkpoint_created":
      return {
        checkpointId: safeText(payload.checkpointId),
        fromSeq: Number(payload.fromSeq ?? 0),
        toSeq: Number(payload.toSeq ?? 0)
      };
    case "error":
      return {
        message: truncateText(safeText(payload.message || payload.text))
      };
    default:
      return JSON.parse(stableStringify(payload)) as JsonObject;
  }
}

function eventSummary(event: EventRecord): string {
  const details = eventDetails(event);
  switch (event.kind) {
    case "user_message":
    case "assistant_message":
      return safeText(details.text);
    case "plan_update":
      return safeText(details.nextAction) || "计划更新";
    case "command_exec":
      return safeText(details.summary || details.command);
    case "tool_call":
    case "tool_result":
      return safeText(details.summary || details.toolName);
    case "file_read":
    case "file_write":
      return safeText(details.path);
    case "guard_decision":
      return [safeText(details.decision), safeText(details.command)].filter(Boolean).join(": ");
    case "compaction_detected":
      return safeText(details.reason);
    case "resume_injected":
      return [safeText(details.reason), safeText(details.packetHash)].filter(Boolean).join(" ");
    case "workspace_snapshot":
      return `modified=${safeText(details.modifiedFiles)} tests=${safeText(details.recentTestResults)}`;
    case "checkpoint_created":
      return safeText(details.checkpointId);
    case "error":
      return safeText(details.message);
    default:
      return truncateText(stableStringify(details), 180);
  }
}

function feedbackTimeline(events: EventRecord[], eventLimit: number): FeedbackTimelineEntry[] {
  return events.slice(-eventLimit).map((event) => ({
    seq: event.seq,
    ts: event.ts,
    kind: event.kind,
    summary: eventSummary(event),
    details: eventDetails(event)
  }));
}

function checkpointPreview(checkpoint: CheckpointState): FeedbackCheckpointPreview {
  return {
    checkpointId: checkpoint.checkpointId,
    createdAt: checkpoint.createdAt,
    phase: checkpoint.phase,
    nextAction: checkpoint.nextAction,
    eventRange: {
      fromSeq: checkpoint.eventRange.fromSeq,
      toSeq: checkpoint.eventRange.toSeq
    }
  };
}

function recentArtifacts(artifacts: ArtifactRef[], artifactLimit: number) {
  return artifacts.slice(-artifactLimit).map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    summary: artifact.summary,
    uri: artifact.uri,
    sourceEventId: artifact.sourceEventId,
    metadata: artifact.metadata
  }));
}

function latestResumeInjection(events: EventRecord[]) {
  const latest = [...events].reverse().find((event) => event.kind === "resume_injected");
  if (!latest) return undefined;
  return {
    ts: latest.ts,
    reason: safeText(latest.payload.reason) || undefined,
    packetHash: safeText(latest.payload.packetHash) || undefined,
    host: safeText(latest.payload.host) || undefined
  };
}

function defaultFeedbackPath(workspaceRoot: string, sessionId: string): string {
  const fileName = `${sessionId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  return path.join(workspaceRoot, ".trr", "feedback", fileName);
}

export function resolveFeedbackSession(
  runtime: TaskRecoveryRuntime,
  workspaceRoot: string,
  sessionId?: string,
  host?: string
): SessionRecord {
  if (sessionId) {
    const session = runtime.getSession(sessionId);
    return session;
  }

  const latest = runtime.findLatestSession({ host, workspaceRoot });
  if (!latest) {
    throw new Error("当前工作区没有可导出的会话，请先运行 codex 或 claude");
  }
  return latest;
}

export function buildFeedbackBundle(
  runtime: TaskRecoveryRuntime,
  config: TrrConfig,
  session: SessionRecord,
  options: FeedbackBundleOptions = {}
): FeedbackExportBundle {
  const eventLimit = options.eventLimit ?? 80;
  const artifactLimit = options.artifactLimit ?? 20;
  const checkpointLimit = options.checkpointLimit ?? 5;
  const events = runtime.listEvents(session.id);
  const artifacts = runtime.db.listArtifacts(session.id);
  const checkpoints = runtime.listCheckpoints(session.id);
  const latestCheckpoint = runtime.getLatestCheckpoint(session.id);
  const packet = runtime.buildResumePacket(session.id).packet;
  const counts = {
    compactionCount: events.filter((event) => event.kind === "compaction_detected").length,
    resumeInjectionCount: events.filter((event) => event.kind === "resume_injected").length,
    guardWarnCount: events.filter(
      (event) =>
        event.kind === "guard_decision" &&
        normalizeWhitespace(safeText(event.payload.decision)).toLowerCase() === "warn"
    ).length,
    guardBlockCount: events.filter(
      (event) =>
        event.kind === "guard_decision" &&
        normalizeWhitespace(safeText(event.payload.decision)).toLowerCase() === "block"
    ).length,
    restartCount: events.filter((event) => event.kind === "process_restarted").length,
    errorCount: events.filter((event) => event.kind === "error").length
  };

  const rawBundle: FeedbackExportBundle = {
    schemaVersion: "trr-feedback/v1",
    generatedAt: nowIso(),
    trrVersion: options.trrVersion || "0.1.1",
    redacted: options.redact !== false,
    redactionPolicy: config.redactionPolicy,
    session,
    source: {
      workspaceRoot: session.workspaceRoot || config.workspaceRoot,
      storePath: config.storePath,
      eventCount: events.length,
      artifactCount: artifacts.length,
      checkpointCount: checkpoints.length
    },
    environment: {
      platform: process.platform,
      nodeVersion: process.version,
      shell: process.env.SHELL || process.env.ComSpec,
      homeDir: os.homedir()
    },
    summary: {
      host: session.host,
      provider: session.provider,
      model: session.model,
      phase: latestCheckpoint?.phase,
      nextAction: latestCheckpoint?.nextAction,
      compactionCount: counts.compactionCount,
      resumeInjectionCount: counts.resumeInjectionCount,
      guardWarnCount: counts.guardWarnCount,
      guardBlockCount: counts.guardBlockCount,
      restartCount: counts.restartCount,
      errorCount: counts.errorCount,
      recentSideEffects: latestCheckpoint?.recentSideEffects ?? [],
      blockedActions: latestCheckpoint?.blockedActions ?? []
    },
    labels: {
      outcome: options.label || "unknown",
      ...(options.notes ? { notes: options.notes } : {})
    },
    latestCheckpoint,
    checkpointPreviews: checkpoints.slice(-checkpointLimit).map(checkpointPreview),
    latestResumeInjection: latestResumeInjection(events),
    currentResumePacket: normalizeWhitespace(packet)
      ? {
          packetHash: sha256(packet),
          estimatedTokens: estimateTokensFromText(packet),
          packet
        }
      : undefined,
    artifacts: recentArtifacts(artifacts, artifactLimit),
    timeline: feedbackTimeline(events, eventLimit)
  };

  return rawBundle.redacted ? redactBundle(rawBundle, config) : rawBundle;
}

export function writeFeedbackBundle(
  runtime: TaskRecoveryRuntime,
  config: TrrConfig,
  session: SessionRecord,
  options: FeedbackBundleOptions & { outPath?: string } = {}
): FeedbackExportResult {
  const bundle = buildFeedbackBundle(runtime, config, session, options);
  const outputPath = options.outPath
    ? path.resolve(options.outPath)
    : defaultFeedbackPath(config.workspaceRoot, session.id);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(bundle, null, 2));
  return {
    outputPath,
    bundle
  };
}
