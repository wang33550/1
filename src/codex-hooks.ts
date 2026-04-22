import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { JsonObject, JsonValue } from "./types";
import { TaskRecoveryRuntime } from "./runtime";
import { loadConfig, resolveStorePath, resolveWorkspaceRoot } from "./config";
import { adapterForHost } from "./host-adapters";
import { commandSummary, parseReadAction, shouldTreatAsSideEffect } from "./shim-common";
import { captureWorkspaceSnapshot } from "./workspace";
import { normalizeWhitespace, safeText, sha256 } from "./utils";

export interface CodexHookInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  model?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: JsonObject;
  tool_response?: JsonValue;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
  turn_id?: string;
}

export interface CodexHookInstallResult {
  codexHome: string;
  configPath: string;
  hooksPath: string;
  command: string;
  changed: boolean;
  featureFlagEnabled: boolean;
}

export interface CodexHookInstallState {
  codexHome: string;
  configPath: string;
  hooksPath: string;
  featureFlagEnabled: boolean;
  installed: boolean;
}

export interface CodexTranscriptTelemetry {
  transcriptPath: string;
  timestamp: string;
  modelContextWindow: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputWindowFraction: number;
  uncachedInputWindowFraction: number;
  quotaUsedPercent?: number;
}

interface CodexTelemetryEvent {
  timestamp?: string;
  inputWindowFraction?: number;
  uncachedInputWindowFraction?: number;
  transcriptPath?: string;
  inputTokens?: number;
  modelContextWindow?: number;
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const CONTEXT_PRESSURE_CHECKPOINT_THRESHOLD = 0.72;
const CONTEXT_DROP_PREVIOUS_THRESHOLD = 0.72;
const CONTEXT_DROP_MULTIPLIER = 0.6;
const CONTEXT_DROP_FLOOR = 0.45;

function codexHookCommand(): string {
  return "trr hook codex";
}

export function codexHomeDir(explicit?: string): string {
  return path.resolve(explicit || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function codexConfigPath(codexHome = codexHomeDir()): string {
  return path.join(codexHome, "config.toml");
}

function codexHooksPath(codexHome = codexHomeDir()): string {
  return path.join(codexHome, "hooks.json");
}

function ensureObject(value: JsonObject, key: string): JsonObject {
  const current = value[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as JsonObject;
  }
  const created: JsonObject = {};
  value[key] = created;
  return created;
}

function ensureArray<T>(parent: JsonObject, key: string): T[] {
  const current = parent[key];
  if (Array.isArray(current)) {
    return current as T[];
  }
  const created: T[] = [];
  parent[key] = created as unknown as JsonObject[keyof JsonObject];
  return created;
}

function ensureMatcherHook(
  hooksRoot: JsonObject,
  eventName: string,
  matcher: string | undefined,
  hook: JsonObject
): boolean {
  const eventEntries = ensureArray<JsonObject>(hooksRoot, eventName);
  const normalizedMatcher = normalizeWhitespace(matcher || "");
  let changed = false;
  let group = eventEntries.find((entry) => normalizeWhitespace(safeText(entry.matcher)) === normalizedMatcher);
  if (!group) {
    group = normalizedMatcher ? { matcher: normalizedMatcher, hooks: [] } : { hooks: [] };
    eventEntries.push(group);
    changed = true;
  }

  const groupHooks = ensureArray<JsonObject>(group, "hooks");
  const command = normalizeWhitespace(safeText(hook.command));
  const exists = groupHooks.some((entry) => normalizeWhitespace(safeText(entry.command)) === command);
  if (!exists) {
    groupHooks.push(hook);
    changed = true;
  }
  return changed;
}

function ensureCodexFeatureFlag(configPath: string): boolean {
  const header = "[features]";
  const flagLine = "codex_hooks = true";

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${header}\n${flagLine}\n`);
    return true;
  }

  const original = fs.readFileSync(configPath, "utf8");
  const lines = original.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => normalizeWhitespace(line) === header);
  let changed = false;

  if (sectionIndex >= 0) {
    let sectionEnd = lines.length;
    for (let index = sectionIndex + 1; index < lines.length; index += 1) {
      if (/^\s*\[.+\]\s*$/.test(lines[index] || "")) {
        sectionEnd = index;
        break;
      }
    }

    let flagIndex = -1;
    for (let index = sectionIndex + 1; index < sectionEnd; index += 1) {
      if (/^\s*codex_hooks\s*=/.test(lines[index] || "")) {
        flagIndex = index;
        break;
      }
    }

    if (flagIndex >= 0) {
      if (normalizeWhitespace(lines[flagIndex] || "") !== flagLine) {
        lines[flagIndex] = flagLine;
        changed = true;
      }
    } else {
      lines.splice(sectionEnd, 0, flagLine);
      changed = true;
    }
  } else {
    if (lines.length > 0 && normalizeWhitespace(lines[lines.length - 1] || "") !== "") {
      lines.push("");
    }
    lines.push(header, flagLine);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(configPath, `${lines.join("\n").replace(/\n+$/, "\n")}`);
  }
  return changed;
}

function codexFeatureFlagEnabled(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => normalizeWhitespace(line) === "[features]");
  if (sectionIndex < 0) return false;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] || "";
    if (/^\s*\[.+\]\s*$/.test(line)) break;
    if (/^\s*codex_hooks\s*=\s*true\s*$/.test(line)) return true;
  }
  return false;
}

export function codexHookInstallState(codexHome = codexHomeDir()): CodexHookInstallState {
  const configPath = codexConfigPath(codexHome);
  const hooksPath = codexHooksPath(codexHome);
  const installed =
    fs.existsSync(hooksPath) &&
    normalizeWhitespace(fs.readFileSync(hooksPath, "utf8")).includes(codexHookCommand());
  return {
    codexHome,
    configPath,
    hooksPath,
    featureFlagEnabled: codexFeatureFlagEnabled(configPath),
    installed
  };
}

export function installCodexHooks(codexHome = codexHomeDir()): CodexHookInstallResult {
  const configPath = codexConfigPath(codexHome);
  const hooksPath = codexHooksPath(codexHome);
  fs.mkdirSync(codexHome, { recursive: true });

  const featureFlagChanged = ensureCodexFeatureFlag(configPath);
  const hooksRootFile: JsonObject = fs.existsSync(hooksPath)
    ? (JSON.parse(fs.readFileSync(hooksPath, "utf8")) as JsonObject)
    : {};
  const hooksRoot = ensureObject(hooksRootFile, "hooks");
  const command = codexHookCommand();
  let changed = featureFlagChanged;

  changed =
    ensureMatcherHook(hooksRoot, "SessionStart", "startup|resume", {
      type: "command",
      command,
      timeout: 10,
      statusMessage: "TRR checking recovery state"
    }) || changed;
  changed =
    ensureMatcherHook(hooksRoot, "UserPromptSubmit", undefined, {
      type: "command",
      command,
      timeout: 10
    }) || changed;
  changed =
    ensureMatcherHook(hooksRoot, "PreToolUse", "Bash", {
      type: "command",
      command,
      timeout: 10,
      statusMessage: "TRR checking repeated commands"
    }) || changed;
  changed =
    ensureMatcherHook(hooksRoot, "PostToolUse", "Bash", {
      type: "command",
      command,
      timeout: 10
    }) || changed;
  changed =
    ensureMatcherHook(hooksRoot, "Stop", undefined, {
      type: "command",
      command,
      timeout: 10,
      statusMessage: "TRR checking recovery drift"
    }) || changed;

  if (changed || !fs.existsSync(hooksPath)) {
    fs.writeFileSync(hooksPath, JSON.stringify(hooksRootFile, null, 2));
  }

  return {
    codexHome,
    configPath,
    hooksPath,
    command,
    changed,
    featureFlagEnabled: true
  };
}

function readFileTail(filePath: string, byteLimit = TRANSCRIPT_TAIL_BYTES): string {
  const stats = fs.statSync(filePath);
  const start = Math.max(0, stats.size - byteLimit);
  const length = stats.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf8");
}

export function readCodexTranscriptTelemetry(transcriptPath?: string | null): CodexTranscriptTelemetry | undefined {
  const normalizedPath = normalizeWhitespace(transcriptPath || "");
  if (!normalizedPath || !fs.existsSync(normalizedPath)) return undefined;

  const tail = readFileTail(normalizedPath);
  const lines = tail.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const row = JSON.parse(lines[index]!) as {
        timestamp?: string;
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
        continue;
      }
      const info = row.payload.info as Record<string, unknown> | null | undefined;
      if (!info || typeof info !== "object") {
        continue;
      }
      const last = info.last_token_usage as Record<string, unknown> | undefined;
      const window = Number(info.model_context_window ?? NaN);
      const inputTokens = Number(last?.input_tokens ?? NaN);
      const cachedInputTokens = Number(last?.cached_input_tokens ?? 0);
      const outputTokens = Number(last?.output_tokens ?? 0);
      const totalTokens = Number(last?.total_tokens ?? NaN);
      if (
        !Number.isFinite(window) ||
        !Number.isFinite(inputTokens) ||
        window <= 0 ||
        inputTokens < 0
      ) {
        continue;
      }
      const quotaUsedPercent = Number(
        ((row.payload.rate_limits as Record<string, unknown> | undefined)?.primary as Record<string, unknown> | undefined)
          ?.used_percent ?? NaN
      );
      return {
        transcriptPath: normalizedPath,
        timestamp: normalizeWhitespace(safeText(row.timestamp)) || "",
        modelContextWindow: window,
        inputTokens,
        cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
        totalTokens: Number.isFinite(totalTokens) ? totalTokens : inputTokens,
        inputWindowFraction: inputTokens / window,
        uncachedInputWindowFraction: Math.max(0, inputTokens - Math.max(0, cachedInputTokens)) / window,
        quotaUsedPercent: Number.isFinite(quotaUsedPercent) ? quotaUsedPercent : undefined
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function ensureSession(runtime: TaskRecoveryRuntime, input: CodexHookInput): string {
  const sessionId = normalizeWhitespace(safeText(input.session_id));
  if (!sessionId) {
    throw new Error("Codex hook input is missing session_id");
  }

  const existing = runtime.listSessions().find((session) => session.id === sessionId);
  if (!existing) {
    runtime.createSession({
      id: sessionId,
      provider: "custom",
      model: normalizeWhitespace(safeText(input.model)) || "codex",
      host: "codex",
      workspaceRoot: normalizeWhitespace(safeText(input.cwd))
    });
  }
  return sessionId;
}

function checkpointHint(runtime: TaskRecoveryRuntime, sessionId: string): string | undefined {
  const checkpoint = runtime.getLatestCheckpoint(sessionId);
  const nextAction = normalizeWhitespace(checkpoint?.nextAction || "");
  if (!nextAction) return undefined;
  return `Continue from saved next action: ${nextAction}`;
}

function buildResumePacketText(
  runtime: TaskRecoveryRuntime,
  sessionId: string,
  reason: string,
  host: "codex"
): { text: string; packetHash: string } | undefined {
  runtime.createCheckpoint(sessionId, true);
  const packet = runtime.buildResumePacket(sessionId).packet;
  if (!normalizeWhitespace(packet)) {
    return undefined;
  }
  const text = `Use this recovery packet to continue the current task without redoing completed work.\n${packet}`;
  const packetHash = sha256(text);
  if (runtime.latestResumePacketHash(sessionId) === packetHash) {
    return undefined;
  }

  runtime.recordEvent({
    sessionId,
    kind: "resume_started",
    payload: { reason, host }
  });
  runtime.recordEvent({
    sessionId,
    kind: "resume_injected",
    payload: {
      reason,
      host,
      packetHash
    }
  });
  runtime.recordEvent({
    sessionId,
    kind: "resume_finished",
    payload: { reason, host }
  });

  return { text, packetHash };
}

function latestTelemetryEvent(runtime: TaskRecoveryRuntime, sessionId: string): CodexTelemetryEvent | undefined {
  const event = [...runtime.listEvents(sessionId)]
    .reverse()
    .find(
      (row) =>
        row.kind === "host_event" &&
        normalizeWhitespace(safeText(row.payload.host)) === "codex" &&
        normalizeWhitespace(safeText(row.payload.telemetryType)) === "token_count"
    );
  if (!event) return undefined;
  return {
    timestamp: normalizeWhitespace(safeText(event.payload.telemetryTimestamp)),
    inputWindowFraction: Number(event.payload.inputWindowFraction ?? NaN),
    uncachedInputWindowFraction: Number(event.payload.uncachedInputWindowFraction ?? NaN),
    transcriptPath: normalizeWhitespace(safeText(event.payload.transcriptPath)),
    inputTokens: Number(event.payload.inputTokens ?? NaN),
    modelContextWindow: Number(event.payload.modelContextWindow ?? NaN)
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function maybeTelemetryCompactionReason(
  previous: CodexTelemetryEvent | undefined,
  current: CodexTranscriptTelemetry | undefined
): string | undefined {
  if (!previous || !current) return undefined;
  if (!previous.timestamp || previous.timestamp === current.timestamp) return undefined;
  if (typeof previous.inputWindowFraction !== "number" || !Number.isFinite(previous.inputWindowFraction)) {
    return undefined;
  }
  const previousFraction = previous.inputWindowFraction;
  if (previousFraction < CONTEXT_DROP_PREVIOUS_THRESHOLD) return undefined;
  if (
    current.inputWindowFraction >
    Math.max(CONTEXT_DROP_FLOOR, previousFraction * CONTEXT_DROP_MULTIPLIER)
  ) {
    return undefined;
  }
  return `Codex transcript input tokens dropped from ${formatPercent(previousFraction)} to ${formatPercent(
    current.inputWindowFraction
  )} of the model context window; hidden compaction or session rebuild is likely.`;
}

function recordTelemetryIfChanged(
  runtime: TaskRecoveryRuntime,
  sessionId: string,
  hookEventName: string,
  telemetry: CodexTranscriptTelemetry | undefined
): void {
  if (!telemetry) return;
  const previous = latestTelemetryEvent(runtime, sessionId);
  if (previous?.timestamp && previous.timestamp === telemetry.timestamp) {
    return;
  }

  runtime.recordEvent({
    sessionId,
    kind: "host_event",
    payload: {
      host: "codex",
      hookEventName,
      telemetryType: "token_count",
      transcriptPath: telemetry.transcriptPath,
      telemetryTimestamp: telemetry.timestamp,
      modelContextWindow: telemetry.modelContextWindow,
      inputTokens: telemetry.inputTokens,
      cachedInputTokens: telemetry.cachedInputTokens,
      outputTokens: telemetry.outputTokens,
      totalTokens: telemetry.totalTokens,
      inputWindowFraction: telemetry.inputWindowFraction,
      uncachedInputWindowFraction: telemetry.uncachedInputWindowFraction,
      ...(telemetry.quotaUsedPercent !== undefined ? { quotaUsedPercent: telemetry.quotaUsedPercent } : {})
    }
  });

  if (telemetry.inputWindowFraction >= CONTEXT_PRESSURE_CHECKPOINT_THRESHOLD) {
    runtime.createCheckpoint(sessionId, true);
  }
}

function toolResponseSummary(toolResponse: unknown): string | undefined {
  if (typeof toolResponse === "string") {
    return normalizeWhitespace(toolResponse).slice(0, 240) || undefined;
  }
  if (toolResponse && typeof toolResponse === "object") {
    const text = normalizeWhitespace(JSON.stringify(toolResponse));
    return text.slice(0, 240) || undefined;
  }
  return undefined;
}

function parseToolExitCode(toolResponse: unknown): number | undefined {
  if (!toolResponse || typeof toolResponse !== "object") return undefined;
  const record = toolResponse as Record<string, unknown>;
  for (const key of ["exitCode", "exit_code", "status", "code"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function recentGuardWarning(runtime: TaskRecoveryRuntime, sessionId: string): string | undefined {
  const recent = runtime.listEvents(sessionId).slice(-8);
  const match = [...recent]
    .reverse()
    .find(
      (event) =>
        event.kind === "guard_decision" &&
        ["warn", "block"].includes(normalizeWhitespace(safeText(event.payload.decision)))
    );
  if (!match) return undefined;
  const command = normalizeWhitespace(safeText(match.payload.command));
  const reason = normalizeWhitespace(safeText(match.payload.reason));
  return reason || (command ? `Recent guarded command: ${command}` : undefined);
}

export function handleCodexHook(
  input: CodexHookInput,
  workspaceRoot = resolveWorkspaceRoot(input.cwd ? safeText(input.cwd) : process.cwd())
): JsonObject | undefined {
  const config = loadConfig(workspaceRoot);
  const runtime = new TaskRecoveryRuntime({ dbPath: resolveStorePath(config) });
  const adapter = adapterForHost("codex", config.hostProfiles.codex);

  try {
    const sessionId = ensureSession(runtime, input);
    const hookEventName = normalizeWhitespace(safeText(input.hook_event_name));
    const previousTelemetry = latestTelemetryEvent(runtime, sessionId);
    const telemetry = readCodexTranscriptTelemetry(input.transcript_path);
    const telemetryCompactionReason = maybeTelemetryCompactionReason(previousTelemetry, telemetry);

    if (telemetryCompactionReason) {
      runtime.recordEvent({
        sessionId,
        kind: "compaction_detected",
        payload: {
          host: "codex",
          reason: telemetryCompactionReason,
          transcriptPath: normalizeWhitespace(safeText(input.transcript_path))
        }
      });
    }

    if (hookEventName === "SessionStart") {
      runtime.recordEvent({
        sessionId,
        kind: "host_event",
        payload: {
          host: "codex",
          hookEventName,
          source: normalizeWhitespace(safeText(input.source)),
          model: normalizeWhitespace(safeText(input.model)),
          transcriptPath: normalizeWhitespace(safeText(input.transcript_path))
        }
      });
      recordTelemetryIfChanged(runtime, sessionId, hookEventName, telemetry);
      runtime.recordWorkspaceSnapshot(sessionId, captureWorkspaceSnapshot(workspaceRoot));

      const source = normalizeWhitespace(safeText(input.source));
      if (source === "resume") {
        const resume = buildResumePacketText(runtime, sessionId, "codex_session_start", "codex");
        if (resume) {
          return {
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: resume.text
            }
          };
        }
      }
      return undefined;
    }

    if (hookEventName === "UserPromptSubmit") {
      const prompt = normalizeWhitespace(safeText(input.prompt));
      if (prompt) {
        runtime.recordEvent({
          sessionId,
          kind: "user_message",
          payload: {
            text: prompt,
            host: "codex"
          }
        });
      }
      recordTelemetryIfChanged(runtime, sessionId, hookEventName, telemetry);
      if (telemetryCompactionReason) {
        const resume = buildResumePacketText(runtime, sessionId, "codex_user_prompt_resume", "codex");
        if (resume) {
          return {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: `${telemetryCompactionReason}\n${resume.text}`
            }
          };
        }
      }
      return undefined;
    }

    if (hookEventName === "PreToolUse") {
      const command = normalizeWhitespace(safeText(input.tool_input?.command));
      if (!command) return undefined;
      runtime.recordEvent({
        sessionId,
        kind: "tool_call",
        payload: {
          toolName: normalizeWhitespace(safeText(input.tool_name)) || "Bash",
          command,
          summary: command,
          sideEffect: shouldTreatAsSideEffect(command, config.guardPolicy)
        }
      });

      const sideEffect = shouldTreatAsSideEffect(command, config.guardPolicy);
      const action = {
        actionType: "command_exec" as const,
        command,
        cwd: workspaceRoot,
        sideEffect
      };
      const commandName = command.split(/\s+/, 1)[0] || "";
      const args = command.split(/\s+/).slice(1);
      const readAction = parseReadAction(commandName, args);
      if (readAction) {
        const readGuard = runtime.assessAction(sessionId, readAction);
        if (readGuard.decision === "warn" || readGuard.decision === "block") {
          const contextMessage =
            readGuard.decision === "block"
              ? buildResumePacketText(runtime, sessionId, "codex_pretool_repeat_read", "codex")?.text
              : checkpointHint(runtime, sessionId);
          runtime.recordEvent({
            sessionId,
            kind: "guard_decision",
            payload: {
              decision: readGuard.decision,
              command,
              actionType: "file_read",
              stale: readGuard.stale,
              ...(readGuard.reason ? { reason: readGuard.reason } : {})
            }
          });
          return {
            systemMessage: [
              readGuard.reason,
              contextMessage ||
                "Treat the repeated read as already satisfied and continue from saved state."
            ]
              .filter(Boolean)
              .join(" ")
          };
        }
      }

      const guard = runtime.assessAction(sessionId, action);
      runtime.recordEvent({
        sessionId,
        kind: "guard_decision",
        payload: {
          decision: guard.decision,
          command,
          actionType: "command_exec",
          stale: guard.stale,
          ...(guard.reason ? { reason: guard.reason } : {})
        }
      });

      if (guard.decision === "block") {
        const hint =
          buildResumePacketText(runtime, sessionId, "codex_pretool_repeat_command", "codex")?.text ||
          checkpointHint(runtime, sessionId);
        return {
          ...(hint ? { systemMessage: hint } : {}),
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: guard.reason || "Repeated dangerous command blocked"
          }
        };
      }

      if (guard.decision === "warn") {
        return {
          systemMessage: [guard.reason, checkpointHint(runtime, sessionId)].filter(Boolean).join(" ")
        };
      }

      return undefined;
    }

    if (hookEventName === "PostToolUse") {
      const command = normalizeWhitespace(safeText(input.tool_input?.command));
      if (!command) return undefined;
      const commandName = command.split(/\s+/, 1)[0] || "";
      const args = command.split(/\s+/).slice(1);
      const readAction = parseReadAction(commandName, args);
      if (readAction) {
        runtime.recordEvent({
          sessionId,
          kind: "file_read",
          payload: {
            ...(readAction.path ? { path: readAction.path } : {}),
            ...(readAction.startLine !== undefined ? { startLine: readAction.startLine } : {}),
            ...(readAction.endLine !== undefined ? { endLine: readAction.endLine } : {}),
            command
          }
        });
      }
      runtime.recordEvent({
        sessionId,
        kind: "command_exec",
        payload: {
          command: commandSummary(commandName, args),
          cwd: workspaceRoot,
          sideEffect: shouldTreatAsSideEffect(command, config.guardPolicy),
          ...(parseToolExitCode(input.tool_response) !== undefined
            ? { exitCode: parseToolExitCode(input.tool_response) }
            : {}),
          summary: toolResponseSummary(input.tool_response) || command
        }
      });
      runtime.maybeCompact(sessionId);
      recordTelemetryIfChanged(runtime, sessionId, hookEventName, telemetry);
      return undefined;
    }

    if (hookEventName === "Stop") {
      recordTelemetryIfChanged(runtime, sessionId, hookEventName, telemetry);
      runtime.createCheckpoint(sessionId, true);
      if (input.stop_hook_active === true) {
        return undefined;
      }

      const assistantMessage = normalizeWhitespace(safeText(input.last_assistant_message));
      const assistantAskedForResume = assistantMessage
        ? adapter.detectNeedResume(assistantMessage).matched
        : false;
      const guardReason = recentGuardWarning(runtime, sessionId);
      const resume = assistantAskedForResume || telemetryCompactionReason
        ? buildResumePacketText(runtime, sessionId, "codex_stop_resume", "codex")
        : undefined;
      if (resume) {
        const reasons = [
          assistantAskedForResume ? "The latest assistant output indicates lost context or asks for recovery." : "",
          telemetryCompactionReason || "",
          guardReason || "",
          resume.text
        ].filter(Boolean);
        return {
          decision: "block",
          reason: reasons.join("\n\n")
        };
      }
      return undefined;
    }

    return undefined;
  } finally {
    runtime.close();
  }
}
