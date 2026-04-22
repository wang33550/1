#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { loadConfig, type GuardPolicyConfig } from "../config";
import { TaskRecoveryRuntime } from "../runtime";
import {
  commandSummary,
  findRealExecutable,
  parseReadAction,
  shouldTreatAsSideEffect,
  shouldWarnOnCommand
} from "../shim-common";
import { normalizeWhitespace } from "../utils";

function cmdArgument(value: string): string {
  if (!value) return '""';
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function spawnResolvedCommand(
  executable: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    return spawn(executable, args, {
      ...options,
      shell: true
    });
  }
  return spawn(executable, args, options);
}

function recoveryHint(runtime: TaskRecoveryRuntime, sessionId: string): string | undefined {
  const checkpoint = runtime.getLatestCheckpoint(sessionId);
  const nextAction = normalizeWhitespace(checkpoint?.nextAction || "");
  if (!nextAction) return undefined;
  return `TRR recovery hint: this repeated action may indicate context drift. Treat the previous matching result as already completed and continue from saved next action: ${nextAction}`;
}

function recoveryPacket(runtime: TaskRecoveryRuntime, sessionId: string): string | undefined {
  runtime.createCheckpoint(sessionId, true);
  const packet = normalizeWhitespace(runtime.buildResumePacket(sessionId).packet);
  if (!packet) return recoveryHint(runtime, sessionId);
  return [
    "TRR recovery packet: the blocked command was already seen. Do not retry it unless the user explicitly asks.",
    packet
  ].join("\n");
}

async function main(): Promise<void> {
  const commandName = process.argv[2];
  const args = process.argv.slice(3);
  if (!commandName) {
    throw new Error("trr-exec requires a command name");
  }

  const workspaceRoot = process.env.TRR_WORKSPACE_ROOT || process.cwd();
  const sessionId = process.env.TRR_SESSION_ID;
  const storePath = process.env.TRR_STORE_PATH;
  if (!sessionId || !storePath) {
    throw new Error("TRR_SESSION_ID and TRR_STORE_PATH are required");
  }

  const config = loadConfig(workspaceRoot);
  const envGuardPolicy = process.env.TRR_GUARD_POLICY_JSON;
  if (envGuardPolicy) {
    try {
      const parsed = JSON.parse(envGuardPolicy) as Partial<GuardPolicyConfig>;
      config.guardPolicy = {
        ...config.guardPolicy,
        ...parsed
      };
    } catch {
      // Ignore malformed guard policy overrides and fall back to disk config.
    }
  }
  const runtime = new TaskRecoveryRuntime({ dbPath: storePath });
  const commandLine = commandSummary(commandName, args);
  const readAction = parseReadAction(commandName, args);
  const sideEffect = shouldTreatAsSideEffect(commandLine, config.guardPolicy);
  const commandAction = {
    actionType: "command_exec" as const,
    command: commandLine,
    cwd: workspaceRoot,
    sideEffect
  };

  if (readAction) {
    const readGuard = runtime.assessAction(sessionId, readAction);
    const hint = recoveryHint(runtime, sessionId);
    runtime.recordEvent({
      sessionId,
      kind: "guard_decision",
      payload: {
        decision: readGuard.decision,
        command: commandLine,
        actionType: "file_read",
        stale: readGuard.stale,
        ...(readGuard.reason ? { reason: readGuard.reason } : {})
      }
    });
    if (readGuard.decision === "warn") {
      process.stderr.write(
        `[trr] warning: ${readGuard.reason}${hint ? `; ${hint}` : ""}\n`
      );
    } else if (readGuard.decision === "block") {
      const packet = recoveryPacket(runtime, sessionId);
      process.stderr.write(
        `[trr] blocked: ${readGuard.reason}${packet ? `\n${packet}` : hint ? `; ${hint}` : ""}\n`
      );
      runtime.close();
      process.exitCode = 1;
      return;
    }
  }

  const commandGuard = runtime.assessAction(sessionId, commandAction);
  const hint = recoveryHint(runtime, sessionId);
  runtime.recordEvent({
    sessionId,
    kind: "guard_decision",
    payload: {
      decision: commandGuard.decision,
      command: commandLine,
      actionType: "command_exec",
      stale: commandGuard.stale,
      ...(commandGuard.reason ? { reason: commandGuard.reason } : {})
    }
  });

  if (commandGuard.decision === "block") {
    const packet = recoveryPacket(runtime, sessionId);
    process.stderr.write(
      `[trr] blocked: ${commandGuard.reason}${packet ? `\n${packet}` : hint ? `; ${hint}` : ""}\n`
    );
    runtime.close();
    process.exitCode = 1;
    return;
  }
  if (commandGuard.decision === "warn" || shouldWarnOnCommand(commandLine, config.guardPolicy)) {
    process.stderr.write(
      `[trr] warning: ${commandGuard.reason || "matching command already exists; continuing"}${
        hint ? `; ${hint}` : ""
      }\n`
    );
  }

  const shimDir = path.join(workspaceRoot, ".trr", "shims");
  const realExecutable = findRealExecutable(commandName, process.env.PATH || "", shimDir);
  if (!realExecutable) {
    runtime.close();
    throw new Error(`unable to find real executable for ${commandName}`);
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawnResolvedCommand(realExecutable, args, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PATH: (process.env.PATH || "")
          .split(path.delimiter)
          .filter((entry) => normalizeWhitespace(entry) !== normalizeWhitespace(shimDir))
          .join(path.delimiter)
      },
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (readAction) {
    runtime.recordEvent({
      sessionId,
      kind: "file_read",
      payload: {
        ...(readAction.path ? { path: readAction.path } : {}),
        ...(readAction.startLine !== undefined ? { startLine: readAction.startLine } : {}),
        ...(readAction.endLine !== undefined ? { endLine: readAction.endLine } : {}),
        command: commandLine
      }
    });
  }

  runtime.recordEvent({
    sessionId,
    kind: "command_exec",
    payload: {
      command: commandLine,
      cwd: workspaceRoot,
      exitCode,
      sideEffect,
      summary: `${commandLine} exited with ${exitCode}`
    }
  });
  runtime.close();
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
