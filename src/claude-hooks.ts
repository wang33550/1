import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "./types";
import { TaskRecoveryRuntime } from "./runtime";
import { loadConfig, resolveStorePath, resolveWorkspaceRoot } from "./config";
import { commandSummary, parseReadAction, shouldTreatAsSideEffect } from "./shim-common";
import { captureWorkspaceSnapshot } from "./workspace";
import { normalizeWhitespace, safeText, sha256 } from "./utils";

export interface ClaudeHookInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  model?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: JsonObject;
  tool_response?: JsonObject | string;
  trigger?: string;
  compact_summary?: string;
}

export interface ClaudeHookInstallResult {
  settingsPath: string;
  command: string;
  changed: boolean;
}

function claudeSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "settings.local.json");
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

function trrClaudeHookCommand(): string {
  return "trr hook claude";
}

export function installClaudeHooks(workspaceRoot = resolveWorkspaceRoot()): ClaudeHookInstallResult {
  const settingsPath = claudeSettingsPath(workspaceRoot);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const settings: JsonObject = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as JsonObject)
    : {};
  const hooksRoot = ensureObject(settings, "hooks");
  const command = trrClaudeHookCommand();
  let changed = false;

  changed =
    ensureMatcherHook(hooksRoot, "SessionStart", "startup|resume|compact", {
      type: "command",
      command,
      timeout: 10
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
      timeout: 10
    }) || changed;
  changed =
    ensureMatcherHook(hooksRoot, "PostToolUse", "Bash", {
      type: "command",
      command,
      timeout: 10
    }) || changed;
  changed =
    ensureMatcherHook(hooksRoot, "PreCompact", "auto|manual", {
      type: "command",
      command,
      timeout: 10
    }) || changed;
  changed =
    ensureMatcherHook(hooksRoot, "PostCompact", "auto|manual", {
      type: "command",
      command,
      timeout: 10
    }) || changed;

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  return {
    settingsPath,
    command,
    changed
  };
}

function ensureSession(runtime: TaskRecoveryRuntime, input: ClaudeHookInput): string {
  const sessionId = normalizeWhitespace(safeText(input.session_id));
  if (!sessionId) {
    throw new Error("Claude hook input is missing session_id");
  }

  const existing = runtime.listSessions().find((session) => session.id === sessionId);
  if (!existing) {
    runtime.createSession({
      id: sessionId,
      provider: "anthropic",
      model: normalizeWhitespace(safeText(input.model)) || "claude",
      host: "claude",
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

function recoveryAdditionalContext(
  runtime: TaskRecoveryRuntime,
  sessionId: string,
  reason: string
): string | undefined {
  runtime.createCheckpoint(sessionId, true);
  const packet = runtime.buildResumePacket(sessionId).packet;
  if (!normalizeWhitespace(packet)) {
    return checkpointHint(runtime, sessionId);
  }
  const packetHash = sha256(packet);
  if (runtime.latestResumePacketHash(sessionId) !== packetHash) {
    runtime.recordEvent({
      sessionId,
      kind: "resume_started",
      payload: { reason, host: "claude" }
    });
    runtime.recordEvent({
      sessionId,
      kind: "resume_injected",
      payload: {
        reason,
        host: "claude",
        packetHash
      }
    });
    runtime.recordEvent({
      sessionId,
      kind: "resume_finished",
      payload: { reason, host: "claude" }
    });
  }
  return `A repeated command suggests replay drift or lost state. Treat the previously matching action as already completed and continue from the recovery packet below.\n${packet}`;
}

function maybeResumeAdditionalContext(runtime: TaskRecoveryRuntime, sessionId: string): string | undefined {
  runtime.createCheckpoint(sessionId, true);
  const packet = runtime.buildResumePacket(sessionId).packet;
  if (!normalizeWhitespace(packet)) {
    return undefined;
  }
  const packetHash = sha256(packet);
  if (runtime.latestResumePacketHash(sessionId) === packetHash) {
    return undefined;
  }
  runtime.recordEvent({
    sessionId,
    kind: "resume_started",
    payload: { reason: "claude_session_start", host: "claude" }
  });
  runtime.recordEvent({
    sessionId,
    kind: "resume_injected",
    payload: {
      reason: "claude_session_start",
      host: "claude",
      packetHash
    }
  });
  runtime.recordEvent({
    sessionId,
    kind: "resume_finished",
    payload: { reason: "claude_session_start", host: "claude" }
  });
  return `Use this recovery packet to continue the current task without redoing completed work.\n${packet}`;
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

export function handleClaudeHook(
  input: ClaudeHookInput,
  workspaceRoot = resolveWorkspaceRoot(input.cwd ? safeText(input.cwd) : process.cwd())
): JsonObject | undefined {
  const config = loadConfig(workspaceRoot);
  const runtime = new TaskRecoveryRuntime({ dbPath: resolveStorePath(config) });
  try {
    const sessionId = ensureSession(runtime, input);
    const hookEventName = normalizeWhitespace(safeText(input.hook_event_name));

    if (hookEventName === "SessionStart") {
      runtime.recordEvent({
        sessionId,
        kind: "host_event",
        payload: {
          hookEventName,
          source: normalizeWhitespace(safeText(input.source)),
          model: normalizeWhitespace(safeText(input.model))
        }
      });
      runtime.recordWorkspaceSnapshot(sessionId, captureWorkspaceSnapshot(workspaceRoot));
      const source = normalizeWhitespace(safeText(input.source));
      if (source === "resume" || source === "compact") {
        const additionalContext = maybeResumeAdditionalContext(runtime, sessionId);
        if (additionalContext) {
          return {
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext
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
            host: "claude"
          }
        });
      }
      return undefined;
    }

    if (hookEventName === "PreCompact") {
      runtime.recordEvent({
        sessionId,
        kind: "compaction_detected",
        payload: {
          host: "claude",
          trigger: normalizeWhitespace(safeText(input.trigger))
        }
      });
      runtime.createCheckpoint(sessionId, true);
      return undefined;
    }

    if (hookEventName === "PostCompact") {
      runtime.recordEvent({
        sessionId,
        kind: "host_event",
        payload: {
          hookEventName,
          trigger: normalizeWhitespace(safeText(input.trigger)),
          compactSummary: normalizeWhitespace(safeText(input.compact_summary))
        }
      });
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
      const commandAction = {
        actionType: "command_exec" as const,
        command,
        cwd: workspaceRoot,
        sideEffect
      };
      const readAction = parseReadAction(command.split(/\s+/, 1)[0] || "", command.split(/\s+/).slice(1));
      if (readAction) {
        const readGuard = runtime.assessAction(sessionId, readAction);
        if (readGuard.decision === "block" || readGuard.decision === "warn") {
          const additionalContext =
            readGuard.decision === "block"
              ? recoveryAdditionalContext(runtime, sessionId, "claude_pretool_repeat_read")
              : checkpointHint(runtime, sessionId);
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: readGuard.decision === "block" ? "deny" : "allow",
              permissionDecisionReason: readGuard.reason || "Repeated read detected",
              ...(additionalContext ? { additionalContext } : {})
            }
          };
        }
      }

      const guard = runtime.assessAction(sessionId, commandAction);
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

      if (guard.decision === "block" || guard.decision === "warn") {
        const additionalContext =
          guard.decision === "block"
            ? recoveryAdditionalContext(runtime, sessionId, "claude_pretool_repeat_command")
            : checkpointHint(runtime, sessionId);
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: guard.decision === "block" ? "deny" : "allow",
            permissionDecisionReason: guard.reason || "Repeated command detected",
            ...(additionalContext ? { additionalContext } : {})
          }
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
      return undefined;
    }

    return undefined;
  } finally {
    runtime.close();
  }
}
